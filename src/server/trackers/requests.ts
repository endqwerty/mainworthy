import { randomUUID } from "node:crypto";
import { z } from "zod";
import { mayRun } from "../../core/kinds.ts";
import { printCase } from "../../core/markdown.ts";
import type { CaseBody } from "../../core/model.ts";
import { type TrackerInput, TrackerItem, type TrackerReceipt } from "../../core/tracker.ts";
import { batchById, mustTarget, resultById, testById, testRef } from "../evidence/evidence.ts";
import type { App } from "../kernel/app.ts";
import { type Ctx, lockProject, projectById } from "../kernel/ctx.ts";
import { json, type ReadDb, sql } from "../kernel/db.ts";
import { forbidden, invalid, notFound } from "../kernel/errors.ts";
import { enqueueJob, fenceJob, type JobClaim, runKindJobs, stopKindJobs, waitKindJobs } from "../kernel/jobs.ts";
import { caseById, caseRef, versionOf } from "../suite/suite.ts";
import { configuredTrackers } from "./config.ts";
import { TrackerError, type TrackerPort } from "./port.ts";

type RequestRow = {
	id: string;
	nonce: string;
	project: number;
	result: number;
	repository: string;
	action: "create" | "link";
	item_key: string | null;
	title: string;
	body: string;
	state: TrackerReceipt["state"];
	issue: string | null;
	error: string | null;
	at: number;
};

const Q = {
	insert: sql<RequestRow>(`INSERT INTO tracker_requests
		(id, nonce, project, result, repository, action, item_key, title, body, state, issue, error, at)
		VALUES ($id, $nonce, $project, $result, $repository, $action, $item_key, $title, $body, $state, $issue, $error, $at)`),
	one: sql<{ project: number; id: string }, RequestRow>(
		"SELECT * FROM tracker_requests WHERE project = $project AND id = $id",
	),
	job: sql<{ id: string; nonce: string }, RequestRow>("SELECT * FROM tracker_requests WHERE id=$id AND nonce=$nonce"),
	claim: sql<{ id: string; nonce: string }>(
		"UPDATE tracker_requests SET state = 'sending' WHERE id = $id AND nonce = $nonce AND state = 'queued'",
	),
	finish: sql<{ id: string; nonce: string; issue: string | null; error: string | null; state: string }>(
		`UPDATE tracker_requests SET state = $state, issue = $issue, error = $error
		 WHERE id = $id AND nonce = $nonce AND state = 'sending'`,
	),
};

function receipt(row: RequestRow): TrackerReceipt {
	return {
		id: row.id,
		result: row.result,
		state: row.state,
		issue: row.issue === null ? null : TrackerItem.parse(json<unknown>(row.issue)),
		error: row.error,
	};
}

export async function trackerStatus(db: ReadDb, project: number, id: string): Promise<TrackerReceipt> {
	const row = await db.get(Q.one, { project, id });
	if (!row) throw notFound("tracker request");
	return receipt(row);
}

export async function queueDefect(ctx: Ctx, input: TrackerInput): Promise<TrackerReceipt> {
	const config = configuredTrackers(ctx.app.config, ctx.project.key)[0];
	if (!config) throw invalid("A tracker is not configured for this project.");
	if (input.do === "link" && !config.validKey(input.key))
		throw invalid("The issue key must name an issue in the configured tracker project.");
	const result = await resultById(ctx.db, input.result);
	if (!mayRun(ctx.actor, "read") && result?.actor !== ctx.actor.id)
		throw forbidden("tracker needs the read capability to queue a result this actor did not record");
	if (!result || result.project !== ctx.project.id) throw notFound("result");
	if (result.outcome !== "fail" && result.outcome !== "error")
		throw invalid("A defect needs a failed or errored result.");
	const test = await testById(ctx.db, result.test);
	const target = await mustTarget(ctx.db, result.target);
	const batch = await batchById(ctx.db, result.batch);
	if (!test || !batch) throw notFound("result evidence");
	const row = result.basis_case === null ? null : await caseById(ctx.db, result.basis_case);
	const version = row && result.basis_version !== null ? await versionOf(ctx.db, row.id, result.basis_version) : null;
	const body = version ? json<CaseBody>(version.body) : null;
	const basis = row && version ? `${caseRef(row)}@v${version.no} (${result.basis})` : "unresolved";
	const draft = [
		`Project: ${ctx.project.key}`,
		`Case: ${basis}`,
		`Test: ${testRef(test)} ${test.name}`,
		`Result: ${result.id} (${result.outcome})`,
		`Target: ${target.what}`,
		`Environment: ${target.env || "unspecified"}`,
		`Build: ${batch.build_url ?? "not provided"}`,
		"",
		"## Failure",
		result.message ?? "No failure message was reported.",
		result.detail ?? "",
		...(body
			? ["", "## Recorded case", printCase({ ref: row ? caseRef(row) : null, body, tags: [], covers: [] })]
			: []),
	].join("\n");
	const request: RequestRow = {
		id: input.cmd,
		nonce: randomUUID(),
		project: ctx.project.id,
		result: result.id,
		repository: config.destination,
		action: input.do,
		item_key: input.do === "link" ? input.key : null,
		title: `Failure: ${body?.title ?? test.name}`.slice(0, 240),
		body: draft,
		state: "queued",
		issue: null,
		error: null,
		at: ctx.now,
	};
	await ctx.db.run(Q.insert, request);
	await enqueueJob(ctx.db, {
		kind: "tracker-request",
		key: request.nonce,
		input: { id: request.id, nonce: request.nonce, project: request.project },
		actor: ctx.actor.id,
		acceptedAt: ctx.now,
		effect: request.action === "create" ? "uncertain" : "repeatable",
	});
	return receipt(request);
}

const TrackerJob = z.object({ id: z.string(), nonce: z.string(), project: z.number().int() });
export function deliverTrackerRequests(app: App, port?: TrackerPort): Promise<number> {
	let delivered = 0;
	return runKindJobs(app, "tracker-request", async (claim, input) => {
		if (await executeTrackerRequest(app, claim, input, port)) delivered++;
	}).then(() => delivered);
}
export const stopTrackerRequests = (app: App): void => stopKindJobs(app, "tracker-request");
export const waitTrackerRequests = (app: App): Promise<void> => waitKindJobs(app, "tracker-request");

export async function executeTrackerRequest(
	app: App,
	claim: JobClaim,
	input: unknown,
	supplied?: TrackerPort,
): Promise<boolean> {
	const request = TrackerJob.parse(input);
	const claimed = await app.database.write((db) =>
		db.transaction(async () => {
			await lockProject(db, request.project);
			await fenceJob(db, claim, app.now());
			const row = await db.get(Q.job, { id: request.id, nonce: request.nonce });
			if (!row || row.state !== "queued") return null;
			await db.run(Q.claim, { id: row.id, nonce: row.nonce });
			return { row, project: (await projectById(db, row.project))?.key };
		}),
	);
	if (!claimed) return false;
	const { row, project } = claimed;
	let issue: TrackerItem | null = null;
	let error: string | null = null;
	try {
		const config = project
			? configuredTrackers(app.config, project).find((tracker) => tracker.destination === row.repository)
			: undefined;
		if (!config)
			throw new TrackerError("The configured tracker project or repository changed; the request was not sent.");
		const port = supplied ?? config.port();
		issue =
			row.action === "create"
				? await port.createDefect({ title: row.title, body: row.body })
				: await port.getItem(row.item_key ?? "");
	} catch (caught) {
		error =
			caught instanceof TrackerError
				? caught.message
				: "The tracker request failed; check the tracker before creating another issue.";
	}
	await app.database.write((db) =>
		db.transaction(async () => {
			await lockProject(db, row.project);
			await fenceJob(db, claim, app.now());
			await db.run(Q.finish, {
				id: row.id,
				nonce: row.nonce,
				issue: issue ? JSON.stringify(issue) : null,
				error,
				state: issue ? "complete" : "failed",
			});
		}),
	);
	return true;
}
