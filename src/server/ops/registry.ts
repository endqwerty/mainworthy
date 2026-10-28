// The operation registry: the one public entry to the server. HTTP routes, the OpenAPI document, the MCP tools,
// the CLI commands and the web client are all generated from OPS, so a capability exists on every surface or on none.

import { createHash } from "node:crypto";
import type { z } from "zod";
import { mayRun, type Need, needs } from "../../core/kinds.ts";
import { malformedText } from "../../core/text.ts";
import { actorById, lockCallActors, lockIdentity, resolveCaller } from "../identity/identity.ts";
import type { App } from "../kernel/app.ts";
import type { CallerReference } from "../kernel/caller.ts";
import {
	type Actor,
	beginCommand,
	type Ctx,
	demoDeployment,
	demoSince,
	findCommand,
	findProject,
	finishCommand,
	lockAllProjects,
	lockCommand,
	lockNamedProject,
	lockProject,
	makeCtx,
	type ProjectRow,
	recordCommand,
	recordInstanceCommand,
	stampSeq,
	UNFINISHED,
} from "../kernel/ctx.ts";
import { Busy, isBusy, json, type ReadDb, type WriteDb } from "../kernel/db.ts";
import { AcceptedRefusal, type ErrorCode, INTERNAL_ERROR, noProject, OpError } from "../kernel/errors.ts";

type Base<I, O> = {
	name: string;
	/** One line for a person: CLI help and the API reference. */
	summary: string;
	input: z.ZodType<I>;
	output: z.ZodType<O>;
	/** Caller-visible projection, applied to fresh and replayed replies after the full result is stored. */
	present?: (actor: Actor, result: O) => O;
	/** What the caller must hold. A list means any one of them, `{ all: [...] }` requires every one; `test/architecture.test.ts` names the operations that give one. */
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
/** Yield nothing to serve other requests, or commit with an optional pending reply for busy application. */
export type Pause<O = unknown> = typeof COMMIT | { commit: typeof COMMIT; pending: O } | undefined;

type ProjectBase<I, O> = Base<I, O> & { scope: "project" };
/** Project reads receive a snapshot; writes receive a reserved connection and transaction locks. */
export type ProjectOp<I, O> = ProjectBase<I, O> &
	(
		| { effect: "read"; run: (ctx: Ctx<ReadDb>, input: I) => O | Promise<O> }
		| ({
				effect: "write";
				read?: { when: (input: I) => boolean; run: (ctx: Ctx<ReadDb>, input: I) => O | Promise<O> };
		  } & (
				| { run: (ctx: Ctx, input: I) => O | Promise<O> }
				| { steps: (ctx: Ctx, input: I) => Generator<Pause<O>, O, void> | AsyncGenerator<Pause<O>, O, void> }
		  ))
	);
/** An operation on the instance: projects, actors, tokens. */
export type InstanceOp<I, O> = Base<I, O> & {
	scope: "instance";
	secret?: (input: I) => boolean;
} & (
		| { effect: "read"; run: (env: InstanceCtx<ReadDb>, input: I) => O | Promise<O> }
		| { effect: "write"; run: (env: InstanceCtx, input: I) => O | Promise<O> }
	);
export type InstanceCtx<D extends ReadDb = WriteDb> = {
	app: App;
	db: D;
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
	 * compares it: a proof of who the caller is counts only in the session it was made in.
	 */
	context: string | null;
};

export type ServiceOp<I, O> = Base<I, O> & {
	scope: "instance";
	effect: "service";
	run: (app: App, input: I) => Promise<O>;
};
export const defineServiceOp = <I, O>(op: ServiceOp<I, O>): ServiceOp<I, O> => op;

/** Trusted in-process callers and authenticated service HTTP requests share this execution path. */
export async function invokeService<I, O>(app: App, op: ServiceOp<I, O>, input: unknown): Promise<Reply> {
	const parsed = op.input.safeParse(input);
	if (!parsed.success) return fail("invalid", "invalid job request");
	try {
		return { ok: true, result: await op.run(app, parsed.data), seq: null };
	} catch (error) {
		return failure(op.name, error);
	}
}

// biome-ignore lint/suspicious/noExplicitAny: the registry holds operations of every input and output type; each is typed where it is declared.
export type AnyOp = ProjectOp<any, any> | InstanceOp<any, any> | ServiceOp<any, any>;

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

const needed = (need: Need): string => needs(need).join(typeof need === "object" && "all" in need ? " and " : " or ");

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
	actor: (project: number) => Promise<Actor | null>;
	/** Admitted requests carry a credential reference resolved within each database scope. */
	reference?: CallerReference;
	/**
	 * The caller's browser session as it stands when it is asked, or null (see `InstanceCtx`). Asked where the
	 * operation runs, after its wait for the write lock, as `actor` is: an id is given to another row after an import.
	 */
	session?: () => number | null | Promise<number | null>;
	/** Where the caller is signed in, as it stands when it is asked, or null (see `InstanceCtx`). */
	context?: () => string | null | Promise<string | null>;
	/**
	 * When the caller says this happened, in milliseconds. Only a write to a demo project takes it (decision
	 * 0100); anywhere else it is refused, not ignored, so nobody believes a real project recorded the time it
	 * was given. It is part of what a command id names: the same request at another time is another request.
	 */
	at?: number;
	/**
	 * Stops a write at its next statement: the write rolls back and `invoke` throws the signal's reason. A statement
	 * already sent, such as one waiting for a lock, runs to its end first.
	 */
	signal?: AbortSignal;
};

/**
 * Why a call that says when it happened is refused before it runs, or null. Asked wherever a call enters. Whether the project is a demo is asked inside the write (`execute`).
 */
function misplacedTime(op: AnyOp | undefined, call: Call): Reply | null {
	if (call.at === undefined || !op) return null;
	if (op.scope !== "project" || op.effect !== "write")
		return fail("invalid", `${op.name} takes no time: only a write to a demo project says when it happened`);
	if (!Number.isSafeInteger(call.at) || call.at < 0)
		return fail("invalid", "the time is a whole number of milliseconds since 1970");
	return null;
}

/** The current caller, or the reply when it no longer stands or lacks this operation's project capability. */
function admitCaller(
	call: Call,
	op: AnyOp,
	actor: Actor | null,
	project: string | null,
): { actor: Actor } | { reply: Reply } {
	if (!actor) return { reply: fail("unauthenticated", "a token is required") };
	if (project !== null && actor.can.length === 0) {
		const { code, message } = noProject(call.project);
		return { reply: fail(code, message) };
	}
	if (!mayRun(actor, op.needs))
		return {
			reply: fail(
				"forbidden",
				op.needs === "self"
					? `${op.name} is for a person or an agent that is signed in, and ${actor.name} is neither`
					: `${op.name} needs the ${needed(op.needs)} capability${project === null ? "" : ` on ${project}`}`,
			),
		};
	return { actor };
}

/**
 * Runs one operation: validates the input at the boundary, checks the capability, and for a write wraps the work
 * in a transaction that is idempotent on the command id and stamped with one sequence number (a report commits
 * twice and takes a number for each transaction). After each commit it publishes what changed. It pauses where
 * the operation says other requests may be served.
 */
async function execute(app: App, db: WriteDb, ops: Readonly<Record<string, AnyOp>>, call: Call): Promise<Reply> {
	await db.begin();
	try {
		if (ops[call.op]?.scope === "instance") await lockIdentity(db);
		const initial = call.reference ? (await resolveCaller(app, db, call.reference, 0))?.actor : await call.actor(0);
		const parsed = ops[call.op]?.input.safeParse(call.input ?? {});
		const input = parsed?.success ? parsed.data : {};
		if (initial) await lockCallActors(db, initial, call.op, input);
		const current = call.reference ? (await resolveCaller(app, db, call.reference, 0))?.actor : await call.actor(0);
		if (current && current.id !== initial?.id) throw new Busy();
		const named: ProjectRow[] = [];
		const lockNamed = async (key: string) => {
			const row = await lockNamedProject(db, key);
			if (row) named.push(row);
		};
		if (ops[call.op]?.scope === "project" && call.project) {
			await lockNamed(call.project);
		}
		if (
			ops[call.op]?.scope === "instance" &&
			typeof input === "object" &&
			input !== null &&
			"project" in input &&
			typeof input.project === "string"
		) {
			await lockNamed(input.project);
		}
		if (call.op === "admin" && typeof input === "object" && input !== null && "do" in input) {
			if (input.do === "actor.forget") await lockAllProjects(db);
			else if (input.do === "project.demo" && "key" in input && typeof input.key === "string") {
				await lockNamed(input.key);
			}
		}
		// A retired demo takes no write from the moment its retirement commits, which happened under the same row lock:
		// its removal drains each table once and does not read it again (#914). Reading its policy is no write. The
		// refusal waits until the caller is admitted, so one with no grant learns nothing a missing project would not
		// tell it.
		const reading = call.op === "admin" && "do" in input && input.do === "policy.show";
		let retired: string | null = null;
		for (const row of named)
			if (!reading && retired === null && (await demoDeployment(db, row.id))?.kind === "retired") retired = row.key;
		if (typeof input === "object" && input !== null && "cmd" in input && typeof input.cmd === "string")
			await lockCommand(db, input.cmd);
		const reply = await executeInSnapshot(app, db, ops, call, retired);
		if (db.inTransaction) {
			if (reply.ok) await db.commit();
			else await db.rollback();
		}
		return reply;
	} finally {
		await db.rollback();
	}
}

async function executeInSnapshot(
	app: App,
	db: ReadDb | WriteDb,
	ops: Readonly<Record<string, AnyOp>>,
	call: Call,
	retired: string | null = null,
): Promise<Reply> {
	const op = ops[call.op];
	if (!op) return fail("not_found", `no operation named ${call.op}`);
	if (op.effect === "service") return fail("forbidden", "this operation is only available to the job service");
	// An operation of the instance has one address. Named under a project it is refused, whichever project and
	// whether or not it exists: answered there, it would look as if it were about that project, and a client
	// written against the wrong address would work until the day the two differ.
	if (op.scope === "instance" && call.project !== null)
		return fail("not_found", `${op.name} is an operation of the instance and of no project: POST /api/${op.name}`);
	const misplaced = misplacedTime(op, call);
	if (misplaced) return misplaced;
	// Who may call is settled before the operation's input is checked: a caller that may not run the operation
	// learns that and nothing about what it sent. (A surface has read the body by then: HTTP wants it to be JSON.)

	const found = op.scope === "project" && call.project ? await findProject(db, call.project) : null;
	const noSuchProject = (): Reply => {
		const { code, message } = noProject(call.project);
		return fail(code, message);
	};
	if (op.scope === "project") {
		if (!call.project) return fail("invalid", `${op.name} needs a project`);
		if (!found) return noSuchProject();
	}
	const caller = call.reference ? await resolveCaller(app, db, call.reference, found?.id ?? 0) : null;
	const admitted = admitCaller(
		call,
		op,
		call.reference ? (caller?.actor ?? null) : await call.actor(found?.id ?? 0),
		found?.key ?? null,
	);
	// A caller that holds no grant on a project is told what it would be told of a project that does not exist,
	// word for word. A refusal that named the capability it lacks would confirm the key to any token, a
	// pipeline's for another project included. One that holds a grant there is told which capability it lacks.
	if ("reply" in admitted) return admitted.reply;
	if (retired !== null) return fail("conflict", `${retired} is a retired demo being removed, and takes no more writes`);
	const { actor } = admitted;
	const present = (result: unknown): unknown => (op.present ? op.present(actor, op.output.parse(result)) : result);

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
	const request = cmd && writing ? digest(call.at === undefined ? input : { input, at: call.at }) : "";

	try {
		if (op.scope === "instance") {
			const env = {
				app,
				db,
				actor,
				now: app.now(),
				session: call.reference ? (caller?.session ?? null) : ((await call.session?.()) ?? null),
				context: call.reference ? (caller?.context ?? null) : ((await call.context?.()) ?? null),
			};
			if (op.effect === "read") return { ok: true, result: present(await op.run(env, input)), seq: null };
			if (!("begin" in db)) throw new Error("a write needs a reserved lease");
			const prior = cmd ? await findCommand(db, cmd) : null;
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
				return { ok: true, result: present(kept), seq: null };
			}
			const result = await op.run({ ...env, db }, input);
			if (cmd) {
				const outcome = op.secret?.(input) ? WITHHELD : result;
				await recordInstanceCommand(db, { id: cmd, op: op.name, actor: actor.id, at: env.now, outcome, request });
			}
			return { ok: true, result: present(result), seq: null };
		}

		if (!found) throw new Error(`${op.name}: a project operation with no project`);

		if (
			typeof input === "object" &&
			input !== null &&
			"projectIdentity" in input &&
			input.projectIdentity !== undefined &&
			input.projectIdentity !== found.identity
		)
			return fail(
				"conflict",
				"This request belongs to an obsolete project. Read the current project before trying again.",
				{ projectIdentity: "obsolete" },
			);

		if (op.effect === "read") {
			return { ok: true, result: present(await op.run(makeCtx(app, db, found, actor, false), input)), seq: found.seq };
		}

		if (!("begin" in db)) throw new Error("a write needs a reserved lease");
		let accepted: Extract<Reply, { ok: true }> | undefined;
		try {
			// True once the command id is bound to this request: by an earlier attempt that committed its first
			// transaction and never finished (the server stopped), or by this one when it commits its own.
			let bound = false;
			if (cmd) {
				const prior = await findCommand(db, cmd);
				if (prior) {
					// The same id from the same actor for the same operation in the same project, or it is a conflict:
					// a reply recorded for one project is never returned for another.
					if (prior.op !== op.name || prior.actor !== actor.id || prior.project !== found.id) throw reused();
					if (prior.request !== request) throw changed();
					if (prior.outcome !== UNFINISHED) {
						await db.commit();
						return projectReplay(op, actor, prior);
					}
					// Begun and never answered: the operation runs again, finds what it already stored (a report finds
					// its batch) and does the rest.
					bound = true;
				}
			}
			// Read the project inside the transaction: its sequence number is what this command builds on.
			const project = (await findProject(db, found.key)) ?? found;
			if (call.at !== undefined) {
				if ((await demoSince(db, project.id)) === null)
					throw new OpError(
						"invalid",
						`${project.key} is not a demo project: what it records takes the server's clock, and no time from a caller`,
					);
				if (call.at > app.now()) throw new OpError("invalid", "the time is in the future");
			}
			const ctx = makeCtx(app, db, project, actor, true, call.at);
			if (call.reference) ctx.reference = call.reference;
			const record = async () => {
				await app.recordChange(db, {
					project: found.key,
					seq: ctx.seq,
					op: op.name,
					actor: ctx.actor.name,
					touched: [...ctx.touched],
				});
				ctx.touched.clear();
			};
			let result: unknown;
			if ("steps" in op) {
				const steps = await op.steps(ctx, input);
				for (let step = await steps.next(); ; step = await steps.next()) {
					if (step.done) {
						result = step.value;
						break;
					}
					if (step.value !== undefined) {
						if (cmd && !bound) {
							await beginCommand(ctx, { id: cmd, op: op.name, request });
							bound = true;
						}
						await stampSeq(ctx);
						await record();
						await db.commit();
						if (typeof step.value === "object")
							accepted = { ok: true, result: present(step.value.pending), seq: ctx.seq };
						await nextTick();
						await db.begin();
						await lockCallActors(db, actor, op.name, input);
						const refreshed = await lockProject(db, found.id);
						if (!refreshed || refreshed.identity !== found.identity)
							throw new OpError("conflict", "the project changed while the report was accepted");
						// Retired between the report's two transactions: its removal may already have drained the tables.
						if ((await demoDeployment(db, refreshed.id))?.kind === "retired")
							throw new OpError("conflict", `${refreshed.key} became a retired demo while the report was accepted`);
						ctx.project = refreshed;
						ctx.actor = await actorById(db, actor.id, refreshed.id);
						ctx.seq = refreshed.seq + 1;
						const completed = cmd ? await findCommand(db, cmd) : null;
						if (completed && completed.outcome !== UNFINISHED) {
							await steps.return(undefined);
							const caller = call.reference
								? ((await resolveCaller(app, db, call.reference, refreshed.id))?.actor ?? null)
								: await call.actor(refreshed.id);
							const admitted = admitCaller(call, op, caller, refreshed.key);
							if ("reply" in admitted) {
								await db.rollback();
								return admitted.reply;
							}
							await db.commit();
							return projectReplay(op, admitted.actor, completed);
						}
					}
					await nextTick();
				}
			} else result = await op.run(ctx, input);
			if (cmd && bound) await finishCommand(ctx, { id: cmd, outcome: result });
			else if (cmd) await recordCommand(ctx, { id: cmd, op: op.name, outcome: result, request });
			await stampSeq(ctx);
			await record();
			await db.commit();
			return { ok: true, result: present(result), seq: ctx.seq };
		} catch (error) {
			if (error instanceof AcceptedRefusal) {
				await db.commit();
				return failure(op.name, error);
			}
			await db.rollback();
			if (accepted && isBusy(error)) return accepted;
			throw error;
		}
	} catch (error) {
		// A failed read statement aborts its snapshot; let the scope roll back before making the reply. A call its
		// caller stopped is no failure of the operation: `invoke` hands the caller its own reason.
		if (op.effect === "read" || call.signal?.aborted) throw error;
		return failure(op.name, error);
	}
}

function failure(op: string, error: unknown): Reply {
	if (isBusy(error)) return fail("busy", "the writer is busy; retry the same request with the same command id");
	if (error instanceof OpError) return fail(error.code, error.message, error.details);
	console.error(`[mainworthy] ${op} failed:`, error);
	return fail("internal", INTERNAL_ERROR);
}

function projectReplay(op: AnyOp, actor: Actor, prior: NonNullable<Awaited<ReturnType<typeof findCommand>>>): Reply {
	const kept = json<unknown>(prior.outcome);
	if (typeof kept === "object" && kept !== null && "refused" in kept && kept.refused === "report")
		return failure(op.name, new AcceptedRefusal());
	return { ok: true, result: op.present ? op.present(actor, op.output.parse(kept)) : kept, seq: prior.seq };
}

const nextTick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export const READ_ATTEMPTS = 3;

/** Every read closes its snapshot before checking current authority in a fresh scope. */
async function read(app: App, ops: Readonly<Record<string, AnyOp>>, call: Call, attempt = 0): Promise<Reply> {
	const op = ops[call.op];
	let identity: string | undefined;
	let reply: Reply;
	try {
		reply = await app.database.read(async (db) => {
			identity = op?.scope === "project" && call.project ? (await findProject(db, call.project))?.identity : undefined;
			return await executeInSnapshot(app, db, ops, call);
		});
	} catch (error) {
		reply = failure(call.op, error);
	}
	if (!op) return reply;
	const rechecked = await app.database.read(async (db) => {
		const project = op.scope === "project" && call.project ? await findProject(db, call.project) : null;
		if (op.scope === "project" && !call.project) return fail("invalid", `${op.name} needs a project`);
		if (op.scope === "project" && !project) {
			const { code, message } = noProject(call.project);
			return fail(code, message);
		}
		const caller = call.reference ? await resolveCaller(app, db, call.reference, project?.id ?? 0) : null;
		const admitted = admitCaller(
			call,
			op,
			call.reference ? (caller?.actor ?? null) : await call.actor(project?.id ?? 0),
			project?.key ?? null,
		);
		if ("reply" in admitted) return admitted.reply;
		if (project?.identity !== identity) return null;
		return reply;
	});
	return (
		rechecked ??
		(attempt + 1 < READ_ATTEMPTS
			? await read(app, ops, call, attempt + 1)
			: fail("conflict", "project changed during all read attempts"))
	);
}

/** Runs writes with actor and project transaction locks, and reads in repeatable snapshots. */
export async function invoke(app: App, ops: Readonly<Record<string, AnyOp>>, call: Call): Promise<Reply> {
	const operation = ops[call.op];
	if (operation?.scope === "project" && operation.effect === "write" && operation.read) {
		const parsed = operation.input.safeParse(call.input ?? {});
		if (parsed.success && operation.read.when(parsed.data))
			return await invoke(app, { ...ops, [call.op]: { ...operation, effect: "read", run: operation.read.run } }, call);
	}
	if (ops[call.op]?.effect === "service")
		return fail("forbidden", "this operation is only available to the job service");
	const misplaced = misplacedTime(ops[call.op], call);
	if (misplaced) return misplaced;
	if (ops[call.op]?.effect !== "write") return await read(app, ops, call);
	try {
		return await app.database.write(
			async (db) => await execute(app, db, ops, call),
			call.signal ? { signal: call.signal } : {},
		);
	} catch (error) {
		if (call.signal?.aborted) throw call.signal.reason;
		return failure(call.op, error);
	}
}
