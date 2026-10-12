// The operation registry: the one public entry to the server. HTTP routes, the OpenAPI document, the MCP tools,
// the CLI commands and the web client are all generated from OPS, so a capability exists on every surface or on none.
import type { z } from "zod";
import type { Capability } from "../../core/kinds.ts";
import { malformedText } from "../../core/text.ts";
import type { App } from "../kernel/app.ts";
import {
	type Actor,
	type Ctx,
	findCommand,
	findProject,
	makeCtx,
	recordCommand,
	recordInstanceCommand,
	stampSeq,
} from "../kernel/ctx.ts";
import { json } from "../kernel/db.ts";
import { type ErrorCode, OpError } from "../kernel/errors.ts";

type Base<I> = {
	name: string;
	/** One line for a person: CLI help and the API reference. */
	summary: string;
	input: z.ZodType<I>;
	needs: Capability;
	/**
	 * When set, the operation is one of the agent tools, and this is its description, written for a model: what
	 * it is for and when to call it. Every word is loaded into an agent's context, so it is short.
	 */
	mcp: string | null;
};

/**
 * Yielded by an operation's `steps` to end the current transaction and begin the next. A report uses it once:
 * what was accepted is committed (so every reader sees the gate turn pending) before it is applied.
 */
export const COMMIT: unique symbol = Symbol("commit");
/** What `steps` may yield: `COMMIT`, or nothing, which marks a point where other requests may be served. */
export type Pause = typeof COMMIT | undefined;

type ProjectBase<I> = Base<I> & { scope: "project"; effect: "read" | "write" };
/**
 * An operation on one project. A write runs in a transaction stamped with the project's next sequence number.
 * Most operations are one function, `run`. One that can take long gives `steps` instead: a generator that yields
 * between slices of work, so the server can answer reads while it runs. Driven without pausing, it is the same
 * operation; there is no second implementation.
 */
export type ProjectOp<I, O> = ProjectBase<I> &
	({ run: (ctx: Ctx, input: I) => O } | { steps: (ctx: Ctx, input: I) => Generator<Pause, O, void> });
/** An operation on the instance: projects, actors, tokens. */
export type InstanceOp<I, O> = Base<I> & {
	scope: "instance";
	effect: "read" | "write";
	run: (env: InstanceCtx, input: I) => O;
	/** True when the reply to this input holds a secret. It is then never stored, so the command cannot be replayed. */
	secret?: (input: I) => boolean;
};
export type InstanceCtx = { app: App; actor: Actor; now: number };

// biome-ignore lint/suspicious/noExplicitAny: the registry holds operations of every input and output type; each is typed where it is declared.
export type AnyOp = ProjectOp<any, any> | InstanceOp<any, any>;

export const defineOp = <I, O>(op: ProjectOp<I, O>): ProjectOp<I, O> => op;
export const defineInstanceOp = <I, O>(op: InstanceOp<I, O>): InstanceOp<I, O> => op;

export type Reply =
	| { ok: true; result: unknown; seq: number | null }
	| { ok: false; error: { code: ErrorCode; message: string; details?: Record<string, unknown> } };

const reused = () => new OpError("conflict", "this command id was already used for something else");
/** Stored in place of a reply that held a secret. */
const WITHHELD = "(reply not kept: it held a secret)";

const fail = (code: ErrorCode, message: string, details?: Record<string, unknown>): Reply => ({
	ok: false,
	error: details ? { code, message, details } : { code, message },
});

export type Call = {
	op: string;
	/** The project key, for a project operation. */
	project: string | null;
	input: unknown;
	/** Resolves the caller for a project (0 for the instance). Null when the caller is not signed in. */
	actor: (project: number) => Actor | null;
};

/**
 * Runs one operation: validates the input at the boundary, checks the capability, and for a write wraps the work
 * in a transaction that is idempotent on the command id and stamped with one sequence number. After each commit
 * it publishes what changed. Written as a generator so one body serves both drivers below: it yields wherever the
 * operation says other requests may be served.
 */
function* execute(app: App, ops: Readonly<Record<string, AnyOp>>, call: Call): Generator<void, Reply, void> {
	const op = ops[call.op];
	if (!op) return fail("not_found", `no operation named ${call.op}`);
	const parsed = op.input.safeParse(call.input ?? {});
	if (!parsed.success) {
		return fail(
			"invalid",
			parsed.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; "),
			{
				issues: parsed.error.issues.slice(0, 20),
			},
		);
	}
	const input = parsed.data;
	const broken = malformedText(input);
	if (broken) return fail("invalid", `${broken}: the text holds half a character (an unpaired surrogate)`);
	const cmd =
		typeof input === "object" && input !== null && "cmd" in input && typeof input.cmd === "string" ? input.cmd : null;
	const writing = op.effect === "write";
	if (writing && app.db.inTransaction)
		return fail("internal", "a write is in progress; writes go through invokeAsync, which queues them");

	try {
		if (op.scope === "instance") {
			const actor = call.actor(0);
			if (!actor) return fail("unauthenticated", "a token is required");
			if (!actor.can.includes(op.needs)) return fail("forbidden", `${op.name} needs the ${op.needs} capability`);
			const env: InstanceCtx = { app, actor, now: app.now() };
			if (!writing) return { ok: true, result: app.reader.snapshot(() => op.run(env, input)), seq: null };
			const result = app.db.transaction(() => {
				const prior = cmd ? findCommand(app.db, cmd) : null;
				if (prior) {
					if (prior.op !== op.name || prior.actor !== actor.id || prior.project !== 0) throw reused();
					const kept = json<unknown>(prior.outcome);
					if (kept === WITHHELD) {
						throw new OpError(
							"conflict",
							"this command already ran, and its reply held a secret that is not kept; it was not run again",
						);
					}
					return kept;
				}
				const made = op.run(env, input);
				if (cmd) {
					const outcome = op.secret?.(input) ? WITHHELD : made;
					recordInstanceCommand(app.db, { id: cmd, op: op.name, actor: actor.id, at: env.now, outcome });
				}
				return made;
			});
			return { ok: true, result, seq: null };
		}

		if (!call.project) return fail("invalid", `${op.name} needs a project`);
		const found = findProject(app.reader, call.project);
		if (!found) return fail("not_found", `no project named ${call.project}`);
		const actor = call.actor(found.id);
		if (!actor) return fail("unauthenticated", "a token is required");
		if (!actor.can.includes(op.needs))
			return fail("forbidden", `${op.name} needs the ${op.needs} capability on ${found.key}`);

		if (!writing) {
			if (!("run" in op)) throw new Error(`${op.name}: a read is one function`);
			return app.reader.snapshot(() => {
				const project = findProject(app.reader, found.key) ?? found;
				return { ok: true, result: op.run(makeCtx(app, project, actor, false), input), seq: project.seq };
			});
		}

		app.db.begin();
		try {
			if (cmd) {
				const prior = findCommand(app.db, cmd);
				if (prior) {
					// The same id from the same actor for the same operation in the same project, or it is a conflict:
					// a reply recorded for one project is never returned for another.
					if (prior.op !== op.name || prior.actor !== actor.id || prior.project !== found.id) throw reused();
					app.db.commit();
					return { ok: true, result: json<unknown>(prior.outcome), seq: prior.seq };
				}
			}
			// Read the project inside the transaction: its sequence number is what this command builds on.
			const project = findProject(app.db, found.key) ?? found;
			const ctx = makeCtx(app, project, actor, true);
			const publish = () => {
				app.publish({ project: found.key, seq: ctx.seq, op: op.name, actor: actor.name, touched: [...ctx.touched] });
				ctx.touched.clear();
			};
			let result: unknown;
			if ("steps" in op) {
				const steps = op.steps(ctx, input);
				for (let step = steps.next(); ; step = steps.next()) {
					if (step.done) {
						result = step.value;
						break;
					}
					if (step.value === COMMIT) {
						stampSeq(ctx);
						app.db.commit();
						publish();
						app.db.begin();
						ctx.seq += 1;
					}
					yield;
				}
			} else result = op.run(ctx, input);
			if (cmd) recordCommand(ctx, { id: cmd, op: op.name, outcome: result });
			stampSeq(ctx);
			app.db.commit();
			publish();
			return { ok: true, result, seq: ctx.seq };
		} catch (error) {
			app.db.rollback();
			throw error;
		}
	} catch (error) {
		if (error instanceof OpError) return fail(error.code, error.message, error.details);
		const message = error instanceof Error ? error.message : String(error);
		console.error(`[casebook] ${op.name} failed:`, error);
		return fail("internal", message);
	}
}

/**
 * Runs one operation to completion without pausing. For tests, the CLI's in-process use and start-up work. A
 * server uses `invokeAsync`, which runs the same code and lets other requests in between an operation's steps.
 */
export function invoke(app: App, ops: Readonly<Record<string, AnyOp>>, call: Call): Reply {
	const running = execute(app, ops, call);
	for (let step = running.next(); ; step = running.next()) if (step.done) return step.value;
}

const nextTick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * Runs one operation as a server does. A read runs at once on the reader connection. A write waits its turn at
 * the gate (one writer at a time, and nobody blocks the thread to wait), then runs; where the operation pauses,
 * the event loop serves whatever else has arrived. Every surface calls this and nothing else.
 */
export function invokeAsync(app: App, ops: Readonly<Record<string, AnyOp>>, call: Call): Promise<Reply> {
	const op = ops[call.op];
	if (op?.effect === "read" && app.readers) {
		const project = op.scope === "project" && call.project ? findProject(app.reader, call.project) : null;
		if (op.scope === "project" && !project) return Promise.resolve(invoke(app, ops, call));
		const actor = call.actor(project?.id ?? 0);
		// Who may read is decided here, in the thread that knows the caller. A reader thread is only ever handed a
		// call its caller is allowed to make; a refusal is answered inline and never reaches one.
		if (!actor?.can.includes(op.needs)) return Promise.resolve(invoke(app, ops, call));
		return app.readers
			.run({ op: call.op, project: call.project, input: call.input, actor }, () =>
				invoke(app, ops, { ...call, actor: () => actor }),
			)
			.then((reply) => (reply.ok ? reply : fail(reply.error.code, reply.error.message, reply.error.details)));
	}
	if (ops[call.op]?.effect !== "write") return Promise.resolve(invoke(app, ops, call));
	return app.gate.run(async () => {
		const running = execute(app, ops, call);
		for (let step = running.next(); ; step = running.next()) {
			if (step.done) {
				if (op?.scope === "instance" && step.value.ok) app.readers?.refresh();
				return step.value;
			}
			await nextTick();
		}
	});
}
