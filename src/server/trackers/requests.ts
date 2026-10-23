import { randomUUID } from "node:crypto";
import { mayRun } from "../../core/kinds.ts";
import { printCase } from "../../core/markdown.ts";
import type { CaseBody } from "../../core/model.ts";
import { type TrackerInput, TrackerItem, type TrackerReceipt } from "../../core/tracker.ts";
import { batchById, mustTarget, resultById, testById, testRef } from "../evidence/evidence.ts";
import type { App } from "../kernel/app.ts";
import { type Ctx, projectById } from "../kernel/ctx.ts";
import { json, type ReadDb, sql } from "../kernel/db.ts";
import { forbidden, invalid, notFound } from "../kernel/errors.ts";
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
	next: sql<readonly [], RequestRow>("SELECT * FROM tracker_requests WHERE state = 'queued' ORDER BY at, id LIMIT 1"),
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
	return receipt(request);
}

const active = new WeakMap<App, Promise<number>>();
const stopping = new WeakSet<App>();

export function deliverTrackerRequests(app: App, port?: TrackerPort): Promise<number> {
	const running = active.get(app);
	if (running !== undefined) return running;
	if (stopping.has(app)) return Promise.resolve(0);
	const work = deliver(app, port).finally(() => active.delete(app));
	active.set(app, work);
	return work;
}

export function stopTrackerRequests(app: App): void {
	stopping.add(app);
}

export async function waitTrackerRequests(app: App): Promise<void> {
	await active.get(app)?.catch(() => undefined);
}

async function deliver(app: App, supplied?: TrackerPort): Promise<number> {
	let delivered = 0;
	for (let n = 0; n < 20; n++) {
		const claimed = await app.database.write(async (db) =>
			db.transaction(async () => {
				if (stopping.has(app)) return null;
				const next = await db.get(Q.next);
				if (next) await db.run(Q.claim, { id: next.id, nonce: next.nonce });
				return next ? { row: next, project: (await projectById(db, next.project))?.key } : null;
			}),
		);
		if (!claimed) break;
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
		await app.database.write(async (db) =>
			db.transaction(
				async () =>
					await db.run(Q.finish, {
						id: row.id,
						nonce: row.nonce,
						issue: issue ? JSON.stringify(issue) : null,
						error,
						state: issue ? "complete" : "failed",
					}),
			),
		);
		delivered++;
	}
	return delivered;
}
