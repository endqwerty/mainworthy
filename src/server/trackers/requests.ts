import { randomUUID } from "node:crypto";
import { printCase } from "../../core/markdown.ts";
import type { CaseBody } from "../../core/model.ts";
import { type TrackerInput, TrackerItem, type TrackerReceipt } from "../../core/tracker.ts";
import { batchById, mustTarget, resultById, testById, testRef } from "../evidence/evidence.ts";
import type { App } from "../kernel/app.ts";
import { type Ctx, projectById } from "../kernel/ctx.ts";
import { type Db, json, sql } from "../kernel/db.ts";
import { invalid, notFound } from "../kernel/errors.ts";
import { caseById, caseRef, versionOf } from "../suite/suite.ts";
import { githubPort, TrackerError } from "./github.ts";
import type { TrackerPort } from "./port.ts";

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

export function trackerStatus(db: Db, project: number, id: string): TrackerReceipt {
	const row = db.get(Q.one, { project, id });
	if (!row) throw notFound("tracker request");
	return receipt(row);
}

export function queueDefect(ctx: Ctx, input: TrackerInput): TrackerReceipt {
	const config = ctx.app.config.github;
	if (!config || config.project !== ctx.project.key) throw invalid("GitHub Issues is not configured for this project.");
	if (input.do === "link" && !/^[1-9]\d{0,14}$/.test(input.key))
		throw invalid("A GitHub issue key is its positive issue number.");
	const result = resultById(ctx.db, input.result);
	if (!result || result.project !== ctx.project.id) throw notFound("result");
	if (result.outcome !== "fail" && result.outcome !== "error")
		throw invalid("A defect needs a failed or errored result.");
	const test = testById(ctx.db, result.test);
	const target = mustTarget(ctx.db, result.target);
	const batch = batchById(ctx.db, result.batch);
	if (!test || !batch) throw notFound("result evidence");
	const row = result.basis_case === null ? null : caseById(ctx.db, result.basis_case);
	const version = row && result.basis_version !== null ? versionOf(ctx.db, row.id, result.basis_version) : null;
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
		repository: config.repository,
		action: input.do,
		item_key: input.do === "link" ? input.key : null,
		title: `Failure: ${body?.title ?? test.name}`.slice(0, 240),
		body: draft,
		state: "queued",
		issue: null,
		error: null,
		at: ctx.now,
	};
	ctx.db.run(Q.insert, request);
	return receipt(request);
}

const active = new WeakMap<App, Promise<number>>();
const stopping = new WeakSet<App>();

export function deliverTrackerRequests(app: App, port?: TrackerPort): Promise<number> {
	const running = active.get(app);
	if (running) return running;
	if (stopping.has(app)) return Promise.resolve(0);
	const work = deliver(app, port).finally(() => active.delete(app));
	active.set(app, work);
	return work;
}

export async function stopTrackerRequests(app: App): Promise<void> {
	stopping.add(app);
	await active.get(app);
}

async function deliver(app: App, supplied?: TrackerPort): Promise<number> {
	let delivered = 0;
	for (let n = 0; n < 20; n++) {
		const claimed = await app.gate.run(() => {
			if (stopping.has(app)) return null;
			const next = app.db.get(Q.next);
			if (next) app.db.run(Q.claim, { id: next.id, nonce: next.nonce });
			return next ? { row: next, project: projectById(app.db, next.project)?.key } : null;
		});
		if (!claimed) break;
		const { row, project } = claimed;
		let issue: TrackerItem | null = null;
		let error: string | null = null;
		try {
			const config = app.config.github;
			if (!config || config.repository !== row.repository || config.project !== project)
				throw new TrackerError("The configured tracker project or repository changed; the request was not sent.");
			const port = supplied ?? githubPort(config);
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
		await app.gate.run(() =>
			app.db.run(Q.finish, {
				id: row.id,
				nonce: row.nonce,
				issue: issue ? JSON.stringify(issue) : null,
				error,
				state: issue ? "complete" : "failed",
			}),
		);
		delivered++;
	}
	return delivered;
}
