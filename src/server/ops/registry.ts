// The operation registry: the one public entry to the server. HTTP routes, the OpenAPI document, the MCP tools,
// the CLI commands and the web client are all generated from OPS, so a capability exists on every surface or on none.

import { createHash } from "node:crypto";
import type { z } from "zod";
import { mayRun, type Need, needs } from "../../core/kinds.ts";
import { malformedText } from "../../core/text.ts";
import { resolveCaller } from "../identity/identity.ts";
import type { App } from "../kernel/app.ts";
import type { CallerReference } from "../kernel/caller.ts";
import {
	type Actor,
	beginCommand,
	type Ctx,
	findCommand,
	findProject,
	finishCommand,
	makeCtx,
	recordCommand,
	recordInstanceCommand,
	stampSeq,
	UNFINISHED,
} from "../kernel/ctx.ts";
import { json } from "../kernel/db.ts";
import { type ErrorCode, INTERNAL_ERROR, noProject, OpError } from "../kernel/errors.ts";

type Base<I, O> = {
	name: string;
	/** One line for a person: CLI help and the API reference. */
	summary: string;
	input: z.ZodType<I>;
	output: z.ZodType<O>;
	/** What the caller must hold. A list means any one of them; `test/architecture.test.ts` names the operations that give one. */
	needs: Need;
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

type ProjectBase<I, O> = Base<I, O> & { scope: "project"; effect: "read" | "write" };
/**
 * An operation on one project. A write runs in a transaction stamped with the project's next sequence number.
 * Most operations are one function, `run`. One that can take long gives `steps` instead: a generator that yields
 * between slices of work, so the server can answer reads while it runs. Driven without pausing, it is the same
 * operation; there is no second implementation.
 */
export type ProjectOp<I, O> = ProjectBase<I, O> &
	({ run: (ctx: Ctx, input: I) => O } | { steps: (ctx: Ctx, input: I) => Generator<Pause, O, void> });
/** An operation on the instance: projects, actors, tokens. */
export type InstanceOp<I, O> = Base<I, O> & {
	scope: "instance";
	effect: "read" | "write";
	run: (env: InstanceCtx, input: I) => O;
	/** True when the reply to this input holds a secret. It is then never stored, so the command cannot be replayed. */
	secret?: (input: I) => boolean;
};
export type InstanceCtx = {
	app: App;
	actor: Actor;
	now: number;
	/**
	 * The id of the browser session the request came by, or null when it came by a token, from the owner of
	 * this machine, or from no request at all. It is how an operation knows which of the caller's sessions is
	 * the current one. The cookie itself never reaches an operation.
	 */
	session: number | null;
	/**
	 * Where the caller is signed in, as an opaque text that is the same for every request of one browser
	 * session and differs for every other (`Session.context` in the identity module), or null for a token and
	 * for no request at all. An operation that begins something another request finishes keeps it, and
	 * compares it: a passkey registration is finished where it was begun.
	 */
	context: string | null;
};

// biome-ignore lint/suspicious/noExplicitAny: the registry holds operations of every input and output type; each is typed where it is declared.
export type AnyOp = ProjectOp<any, any> | InstanceOp<any, any>;

export const defineOp = <I, O>(op: ProjectOp<I, O>): ProjectOp<I, O> => op;
export const defineInstanceOp = <I, O>(op: InstanceOp<I, O>): InstanceOp<I, O> => op;

export type Reply =
	| { ok: true; result: unknown; seq: number | null }
	| { ok: false; error: { code: ErrorCode; message: string; details?: Record<string, unknown> } };

const reused = () => new OpError("conflict", "this command id was already used for something else");
/**
 * A command id names one request. Sent again unchanged it is a retry and gets the first reply; sent again with
 * other content it is refused. Answering it with the first reply would tell a client that kept an id while its
 * user typed on that the longer text was saved.
 */
const changed = () =>
	new OpError("conflict", "this command id was already used for another request; send new content under a new id");
/**
 * The digest of a request: the same for two serialisations of one request. The keys of every object are put in
 * order first (a client may write a record's keys in any order); the order of a list is part of what was asked.
 */
const ordered = (_key: string, value: unknown): unknown => {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(value).sort()) out[key] = (value as Record<string, unknown>)[key];
	return out;
};
const digest = (input: unknown): string => createHash("sha256").update(JSON.stringify(input, ordered)).digest("hex");
/** Stored in place of a reply that held a secret. */
const WITHHELD = "(reply not kept: it held a secret)";

const needed = (need: Need): string => needs(need).join(" or ");

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
	/** Admitted requests carry this instead of sending resolved authority to a reader. */
	reference?: CallerReference;
	/**
	 * The caller's browser session as it stands when it is asked, or null (see `InstanceCtx`). Asked where the
	 * operation runs, after its wait at the gate, as `actor` is: an id is given to another row after an import.
	 */
	session?: () => number | null;
	/** Where the caller is signed in, as it stands when it is asked, or null (see `InstanceCtx`). */
	context?: () => string | null;
};

/**
 * Runs one operation: validates the input at the boundary, checks the capability, and for a write wraps the work
 * in a transaction that is idempotent on the command id and stamped with one sequence number (a report commits
 * twice and takes a number for each transaction). After each commit it publishes what changed. Written as a generator so one body serves both drivers below: it yields wherever the
 * operation says other requests may be served.
 */
function* execute(app: App, ops: Readonly<Record<string, AnyOp>>, call: Call): Generator<void, Reply, void> {
	if (ops[call.op]?.effect !== "write") return yield* executeInSnapshot(app, ops, call);
	if (app.db.inTransaction)
		return fail("internal", "a write is in progress; writes go through invokeAsync, which queues them");
	app.db.begin();
	try {
		const reply = yield* executeInSnapshot(app, ops, call);
		if (app.db.inTransaction) {
			if (reply.ok) app.db.commit();
			else app.db.rollback();
		}
		return reply;
	} finally {
		app.db.rollback();
	}
}

function* executeInSnapshot(app: App, ops: Readonly<Record<string, AnyOp>>, call: Call): Generator<void, Reply, void> {
	const op = ops[call.op];
	if (!op) return fail("not_found", `no operation named ${call.op}`);
	// An operation of the instance has one address. Named under a project it is refused, whichever project and
	// whether or not it exists: answered there, it would look as if it were about that project, and a client
	// written against the wrong address would work until the day the two differ.
	if (op.scope === "instance" && call.project !== null)
		return fail("not_found", `${op.name} is an operation of the instance and of no project: POST /api/${op.name}`);
	// Who may call is settled before the operation's input is checked: a caller that may not run the operation
	// learns that and nothing about what it sent. (A surface has read the body by then: HTTP wants it to be JSON.)
	const db = op.effect === "write" ? app.db : app.reader;
	const found = op.scope === "project" && call.project ? findProject(db, call.project) : null;
	const noSuchProject = (): Reply => {
		const { code, message } = noProject(call.project);
		return fail(code, message);
	};
	if (op.scope === "project") {
		if (!call.project) return fail("invalid", `${op.name} needs a project`);
		if (!found) return noSuchProject();
	}
	const caller = call.reference ? resolveCaller(app, db, call.reference, found?.id ?? 0) : null;
	const actor = call.reference ? caller?.actor : call.actor(found?.id ?? 0);
	if (!actor) return fail("unauthenticated", "a token is required");
	// A caller that holds no grant on a project is told what it would be told of a project that does not exist,
	// word for word. A refusal that named the capability it lacks would confirm the key to any token, a
	// pipeline's for another project included. One that holds a grant there is told which capability it lacks.
	if (found && actor.can.length === 0) return noSuchProject();
	if (!mayRun(actor, op.needs))
		return fail(
			"forbidden",
			op.needs === "self"
				? `${op.name} is for a person or an agent that is signed in, and ${actor.name} is neither`
				: `${op.name} needs the ${needed(op.needs)} capability${found ? ` on ${found.key}` : ""}`,
		);

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
	const request = cmd && writing ? digest(input) : "";

	try {
		if (op.scope === "instance") {
			const env: InstanceCtx = {
				app,
				actor,
				now: app.now(),
				session: call.reference ? (caller?.session ?? null) : (call.session?.() ?? null),
				context: call.reference ? (caller?.context ?? null) : (call.context?.() ?? null),
			};
			if (!writing) return { ok: true, result: op.run(env, input), seq: null };
			const result = app.db.transaction(() => {
				const prior = cmd ? findCommand(app.db, cmd) : null;
				if (prior) {
					if (prior.op !== op.name || prior.actor !== actor.id || prior.project !== 0) throw reused();
					if (prior.request !== request) throw changed();
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
					recordInstanceCommand(app.db, { id: cmd, op: op.name, actor: actor.id, at: env.now, outcome, request });
				}
				return made;
			});
			return { ok: true, result, seq: null };
		}

		if (!found) throw new Error(`${op.name}: a project operation with no project`);

		if (!writing) {
			if (!("run" in op)) throw new Error(`${op.name}: a read is one function`);
			return { ok: true, result: op.run(makeCtx(app, found, actor, false), input), seq: found.seq };
		}

		try {
			// True once the command id is bound to this request: by an earlier attempt that committed its first
			// transaction and never finished (the server stopped), or by this one when it commits its own.
			let bound = false;
			if (cmd) {
				const prior = findCommand(app.db, cmd);
				if (prior) {
					// The same id from the same actor for the same operation in the same project, or it is a conflict:
					// a reply recorded for one project is never returned for another.
					if (prior.op !== op.name || prior.actor !== actor.id || prior.project !== found.id) throw reused();
					if (prior.request !== request) throw changed();
					if (prior.outcome !== UNFINISHED) {
						app.db.commit();
						return { ok: true, result: json<unknown>(prior.outcome), seq: prior.seq };
					}
					// Begun and never answered: the operation runs again, finds what it already stored (a report finds
					// its batch) and does the rest.
					bound = true;
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
						if (cmd && !bound) {
							beginCommand(ctx, { id: cmd, op: op.name, request });
							bound = true;
						}
						stampSeq(ctx);
						app.db.commit();
						publish();
						app.db.begin();
						ctx.seq += 1;
					}
					yield;
				}
			} else result = op.run(ctx, input);
			if (cmd && bound) finishCommand(ctx, { id: cmd, outcome: result });
			else if (cmd) recordCommand(ctx, { id: cmd, op: op.name, outcome: result, request });
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
		// Anything else is a failure nobody wrote a sentence for: a constraint of the database, a missing file.
		// Its text can name a table, a path or a statement, so it goes to the log and the caller gets one fixed
		// sentence, the same one the HTTP surface gives for a failure of its own.
		console.error(`[mainworthy] ${op.name} failed:`, error);
		return fail("internal", INTERNAL_ERROR);
	}
}

/**
 * Runs one operation to completion without pausing. For tests, the CLI's in-process use and start-up work. A
 * server uses `invokeAsync`, which runs the same code and lets other requests in between an operation's steps.
 */
export function invoke(app: App, ops: Readonly<Record<string, AnyOp>>, call: Call): Reply {
	const run = (): Reply => {
		const running = execute(app, ops, call);
		for (let step = running.next(); ; step = running.next()) if (step.done) return step.value;
	};
	return ops[call.op]?.effect === "read" ? app.reader.snapshot(run) : run();
}

const nextTick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * Runs one operation as a server does. A read goes to a reader thread, which has its own read-only connection
 * (with no reader threads it runs at once on the one reader connection). A write waits its turn at
 * the gate (one writer at a time, and nobody blocks the thread to wait), then runs; where the operation pauses,
 * the event loop serves whatever else has arrived. Every surface calls this and nothing else.
 */
export function invokeAsync(app: App, ops: Readonly<Record<string, AnyOp>>, call: Call): Promise<Reply> {
	const op = ops[call.op];
	if (op?.effect === "read" && app.readers && call.reference) {
		const project = op.scope === "project" && call.project ? findProject(app.reader, call.project) : null;
		if (op.scope === "project" && !project) return Promise.resolve(invoke(app, ops, call));
		const actor = call.actor(project?.id ?? 0);
		// Who may read is decided here, in the thread that knows the caller, and asked again when the reader has
		// answered. A reader thread is only ever handed a call its caller is allowed to make; a refusal is answered
		// inline and never reaches one.
		if (!actor || !mayRun(actor, op.needs)) return Promise.resolve(invoke(app, ops, call));
		return app.readers
			.run(
				{
					op: call.op,
					project: call.project,
					input: call.input,
					caller: call.reference,
					clockOffset: app.now() - Date.now(),
				},
				() => invoke(app, ops, call),
			)
			.then((reply) => {
				// Also refuse a credential that ended while the reader was answering. The read itself resolved the
				// caller and grants in its own snapshot; an inline replay does the same.
				if (!call.actor(project?.id ?? 0)) return fail("unauthenticated", "a token is required");
				return reply.ok ? reply : fail(reply.error.code, reply.error.message, reply.error.details);
			});
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
