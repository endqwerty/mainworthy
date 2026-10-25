import { createHmac, randomUUID } from "node:crypto";
import { z } from "zod";
import { failureBrief, type HandoffInput, type HandoffReceipt } from "../../core/handoff.ts";
import { mustQuestion, questionRef } from "../decisions/questions.ts";
import { batchById, resultById } from "../evidence/evidence.ts";
import type { App, Config } from "../kernel/app.ts";
import { type Ctx, lockProject, projectById } from "../kernel/ctx.ts";
import { json, type ReadDb, sql } from "../kernel/db.ts";
import { invalid } from "../kernel/errors.ts";
import {
	enqueueJob,
	fenceJob,
	type JobClaim,
	jobById,
	jobId,
	runKindJobs,
	stopKindJobs,
	waitKindJobs,
} from "../kernel/jobs.ts";

/**
 * A hand-off sends one failure question to a coding agent: a JSON post, signed with the configured secret, to the
 * configured endpoint (decision 0126). The row keeps what was sent and how it went. It never keeps the endpoint,
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
		"SELECT * FROM handoffs WHERE question = $question ORDER BY at DESC, queue_order DESC LIMIT 1",
	),
	one: sql<{ id: string; nonce: string }, HandoffRow>("SELECT * FROM handoffs WHERE id=$id AND nonce=$nonce"),
	claim: sql<{ id: string; nonce: string }>(
		"UPDATE handoffs SET state = 'sending' WHERE id = $id AND nonce = $nonce AND state = 'queued'",
	),
	finish: sql<{ id: string; nonce: string; state: string; error: string | null }>(
		"UPDATE handoffs SET state = $state, error = $error WHERE id = $id AND nonce = $nonce AND state = 'sending'",
	),
	interrupted: sql<readonly [], HandoffRow>("SELECT * FROM handoffs WHERE state='sending'"),
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

export async function handoffStatus(ctx: Ctx<ReadDb>, text: string): Promise<HandoffReceipt | null> {
	const question = await mustQuestion(ctx.db, ctx.project.id, text);
	const row = await ctx.db.get(Q.latest, { question: question.id });
	return row ? receipt(row) : null;
}

export async function queueHandoff(ctx: Ctx, input: HandoffInput): Promise<HandoffReceipt> {
	if (ctx.app.config.handoff?.project !== ctx.project.key)
		throw invalid("Handing a failure to an agent is not configured for this project.");
	const question = await mustQuestion(ctx.db, ctx.project.id, input.question);
	if (question.kind !== "failure") throw invalid("Only a failure question can be handed to an agent.");
	const evidence = FailureEvidence.safeParse(json<unknown>(question.evidence));
	if (!evidence.success) throw invalid("This failure question has no failure to hand to an agent.");
	const facts = evidence.data;
	const sample = facts.sample ? await resultById(ctx.db, facts.sample) : null;
	const build = sample ? ((await batchById(ctx.db, sample.batch))?.build_url ?? null) : null;
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
	await ctx.db.run(Q.insert, row);
	await enqueueJob(ctx.db, {
		kind: "handoff",
		key: row.nonce,
		input: { id: row.id, nonce: row.nonce, project: row.project },
		actor: ctx.actor.id,
		acceptedAt: ctx.now,
		effect: "uncertain",
	});
	return receipt(row);
}

const HandoffJob = z.object({ id: z.string(), nonce: z.string(), project: z.number().int() });

export function deliverHandoffs(app: App): Promise<number> {
	return runKindJobs(app, "handoff", (claim, input) => executeHandoff(app, claim, input)).then(async (n) => {
		await recoverHandoffs(app);
		return n;
	});
}
export const stopHandoffs = (app: App): void => stopKindJobs(app, "handoff");
export const waitHandoffs = (app: App): Promise<void> => waitKindJobs(app, "handoff");

/** A live instance's send is never inferred interrupted merely because another instance starts. */
export async function recoverHandoffs(app: App): Promise<void> {
	for (const row of await app.database.read((db) => db.all(Q.interrupted))) {
		const job = await app.database.read((db) => jobById(db, jobId("handoff", row.nonce)));
		if (job?.state !== "uncertain") continue;
		await app.database.write((db) =>
			db.transaction(async () => {
				await lockProject(db, row.project);
				await db.run(Q.finish, {
					id: row.id,
					nonce: row.nonce,
					state: "failed",
					error:
						"The server stopped while sending this. It may have arrived: look for the agent's thread before sending again.",
				});
			}),
		);
	}
}
export async function executeHandoff(app: App, claim: JobClaim, input: unknown): Promise<void> {
	const request = HandoffJob.parse(input);
	const claimed = await app.database.write((db) =>
		db.transaction(async () => {
			await lockProject(db, request.project);
			await fenceJob(db, claim, app.now());
			const row = await db.get(Q.one, { id: request.id, nonce: request.nonce });
			if (!row || row.state !== "queued") return null;
			await db.run(Q.claim, { id: row.id, nonce: row.nonce });
			return { row, project: (await projectById(db, row.project))?.key };
		}),
	);
	if (!claimed) return;
	const error = await send(app.config, claimed.project, claimed.row);
	await app.database.write((db) =>
		db.transaction(async () => {
			await lockProject(db, request.project);
			await fenceJob(db, claim, app.now());
			await db.run(Q.finish, { id: request.id, nonce: request.nonce, state: error ? "failed" : "sent", error });
		}),
	);
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
