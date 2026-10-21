import { createHmac, randomUUID } from "node:crypto";
import { z } from "zod";
import { failureBrief, type HandoffInput, type HandoffReceipt } from "../../core/handoff.ts";
import { mustQuestion, questionRef } from "../decisions/questions.ts";
import { batchById, resultById } from "../evidence/evidence.ts";
import type { App, Config } from "../kernel/app.ts";
import { type Ctx, projectById } from "../kernel/ctx.ts";
import { json, sql } from "../kernel/db.ts";
import { invalid } from "../kernel/errors.ts";

/**
 * A hand-off sends one failure question to a coding agent: a JSON post, signed with the configured secret, to the
 * configured endpoint (decision 0125). The row keeps what was sent and how it went. It never keeps the endpoint,
 * whose address is itself a credential for a T3 Code webhook.
 */
type HandoffRow = {
	id: string;
	nonce: string;
	project: number;
	question: number;
	body: string;
	state: HandoffReceipt["state"];
	error: string | null;
	at: number;
};

const Q = {
	insert: sql<HandoffRow>(`INSERT INTO handoffs (id, nonce, project, question, body, state, error, at)
		VALUES ($id, $nonce, $project, $question, $body, $state, $error, $at)`),
	latest: sql<{ question: number }, HandoffRow>(
		"SELECT * FROM handoffs WHERE question = $question ORDER BY at DESC, rowid DESC LIMIT 1",
	),
	next: sql<readonly [], HandoffRow>("SELECT * FROM handoffs WHERE state = 'queued' ORDER BY at, id LIMIT 1"),
	claim: sql<{ id: string; nonce: string }>(
		"UPDATE handoffs SET state = 'sending' WHERE id = $id AND nonce = $nonce AND state = 'queued'",
	),
	finish: sql<{ id: string; nonce: string; state: string; error: string | null }>(
		"UPDATE handoffs SET state = $state, error = $error WHERE id = $id AND nonce = $nonce AND state = 'sending'",
	),
	interrupted: sql<{ error: string }>("UPDATE handoffs SET state = 'failed', error = $error WHERE state = 'sending'"),
};

/** The failure evidence a hand-off reads; `decisions.ts` writes it when it raises a failure question. */
const FailureEvidence = z.object({
	message: z.string().nullable().optional(),
	sample: z.number().nullable().optional(),
	tests: z.array(z.object({ t: z.string(), name: z.string() })),
	count: z.number(),
	target: z.string(),
	branch: z.string().nullable().optional(),
	scope: z.string(),
});

/** What the endpoint receives. A T3 Code webhook task reads it as `{{body.brief}}`, `{{body.url}}` and so on. */
export type HandoffPayload = {
	id: string;
	project: string;
	question: string;
	title: string;
	url: string | null;
	brief: string;
	message: string | null;
	tests: { t: string; name: string }[];
	target: string;
	branch: string | null;
	build: string | null;
};

const receipt = (row: HandoffRow): HandoffReceipt => ({
	id: row.id,
	question: json<HandoffPayload>(row.body).question,
	state: row.state,
	error: row.error,
	at: row.at,
});

export function handoffStatus(ctx: Ctx, text: string): HandoffReceipt | null {
	const question = mustQuestion(ctx.db, ctx.project.id, text);
	const row = ctx.db.get(Q.latest, { question: question.id });
	return row ? receipt(row) : null;
}

export function queueHandoff(ctx: Ctx, input: HandoffInput): HandoffReceipt {
	if (ctx.app.config.handoff?.project !== ctx.project.key)
		throw invalid("Handing a failure to an agent is not configured for this project.");
	const question = mustQuestion(ctx.db, ctx.project.id, input.question);
	if (question.kind !== "failure") throw invalid("Only a failure question can be handed to an agent.");
	const evidence = FailureEvidence.safeParse(json<unknown>(question.evidence));
	if (!evidence.success) throw invalid("This failure question has no failure to hand to an agent.");
	const facts = evidence.data;
	const sample = facts.sample ? resultById(ctx.db, facts.sample) : null;
	const build = sample ? (batchById(ctx.db, sample.batch)?.build_url ?? null) : null;
	const ref = questionRef(question);
	const publicUrl = ctx.app.config.publicUrl?.replace(/\/$/, "");
	const url = publicUrl ? `${publicUrl}/p/${encodeURIComponent(ctx.project.key)}/queue/${question.no}` : null;
	const payload: HandoffPayload = {
		id: input.cmd,
		project: ctx.project.key,
		question: ref,
		title: question.title,
		url,
		brief: failureBrief({
			project: ctx.project.key,
			question: ref,
			title: question.title,
			url,
			message: facts.message ?? null,
			tests: facts.tests,
			count: facts.count,
			target: facts.target,
			branch: facts.branch ?? null,
			scope: facts.scope,
			build,
			detail: sample?.detail ?? null,
		}),
		message: facts.message ?? null,
		tests: facts.tests.map(({ t, name }) => ({ t, name })),
		target: facts.target,
		branch: facts.branch ?? null,
		build,
	};
	const row: HandoffRow = {
		id: input.cmd,
		nonce: randomUUID(),
		project: ctx.project.id,
		question: question.id,
		body: JSON.stringify(payload),
		state: "queued",
		error: null,
		at: ctx.now,
	};
	ctx.db.run(Q.insert, row);
	const app = ctx.app;
	ctx.db.afterCommit(() => void deliverHandoffs(app).catch(() => undefined));
	return receipt(row);
}

const active = new WeakMap<App, Promise<number>>();
const stopping = new WeakSet<App>();

/** Sends what is queued, one at a time. A second call while one runs joins it. */
export function deliverHandoffs(app: App): Promise<number> {
	const running = active.get(app);
	if (running) return running;
	if (stopping.has(app)) return Promise.resolve(0);
	const work = deliver(app).finally(() => active.delete(app));
	active.set(app, work);
	return work;
}

export function stopHandoffs(app: App): void {
	stopping.add(app);
}

export async function waitHandoffs(app: App): Promise<void> {
	await active.get(app)?.catch(() => undefined);
}

/**
 * At start, a hand-off the last process was sending is failed, not sent again: it may have arrived, and a second
 * would start a second agent on the same failure.
 */
export function recoverHandoffs(app: App): void {
	app.db.run(Q.interrupted, {
		error:
			"The server stopped while sending this. It may have arrived: look for the agent's thread before sending again.",
	});
}

async function deliver(app: App): Promise<number> {
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
		const error = await send(app.config, project, row);
		await app.gate.run(() =>
			app.db.run(Q.finish, { id: row.id, nonce: row.nonce, state: error ? "failed" : "sent", error }),
		);
		delivered++;
	}
	return delivered;
}

/** Posts one hand-off and answers why it failed, or null when the endpoint took it. */
async function send(config: Config, project: string | undefined, row: HandoffRow): Promise<string | null> {
	const handoff = config.handoff;
	if (!handoff || project === undefined || handoff.project !== project)
		return "Handing failures to an agent is no longer configured for this project; it was not sent.";
	const signature = createHmac("sha256", handoff.secret).update(row.body).digest("hex");
	try {
		const response = await fetch(handoff.url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Mainworthy-Delivery": row.id,
				"X-Mainworthy-Signature": `sha256=${signature}`,
			},
			body: row.body,
			signal: AbortSignal.timeout(15_000),
			redirect: "error",
		});
		await response.body?.cancel();
		return response.ok
			? null
			: `The agent's endpoint answered HTTP ${response.status}. It may have started anyway: look for the agent's work before sending again.`;
	} catch {
		// A refused connection, a timeout and a refused redirect look alike here, and in the last two the endpoint
		// has the post. So none of them says the agent did not start.
		return "The agent's endpoint gave no answer the server could read. It may have started anyway: look for the agent's work before sending again.";
	}
}
