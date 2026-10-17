// A whole instance in memory for tests: the same app, registry and invoke() the server uses.
import type { ActorKind, Capability } from "../src/core/kinds.ts";
import { authenticate, bootstrap, createToken } from "../src/server/identity/identity.ts";
import { type App, openApp, SESSION_LIFETIMES } from "../src/server/kernel/app.ts";
import type { Actor } from "../src/server/kernel/ctx.ts";
import { OPS } from "../src/server/ops/index.ts";
import { invoke, type Reply } from "../src/server/ops/registry.ts";

export type Harness = {
	app: App;
	owner: Actor;
	/** Moves the clock forward. */
	advance: (ms: number) => void;
	/** Calls an operation and returns its result, or throws with the error code and message. */
	call: <T = Record<string, unknown>>(op: string, input?: unknown, as?: Actor) => T;
	/** Calls an operation and returns the whole reply, for tests about refusals. */
	raw: (op: string, input?: unknown, as?: Actor) => Reply;
	actor: (name: string, kind: ActorKind, can: Capability[]) => Actor;
	close: () => void;
};

export function harness(
	options: { preset?: string; project?: string; unlinked?: "ask" | "track" | "create" } = {},
): Harness {
	let now = 1_800_000_000_000;
	const app = openApp(
		{
			dataDir: ":memory:",
			host: "127.0.0.1",
			port: 0,
			mode: "local",
			owner: "robin",
			ownerToken: null,
			commit: null,
			...SESSION_LIFETIMES,
			proxy: null,
		},
		{ memory: true, now: () => now },
	);
	const { owner } = bootstrap(app);
	const project = options.project ?? "scratch";
	const raw = (op: string, input: unknown = {}, as: Actor = owner): Reply => {
		now += 1;
		return invoke(app, OPS, { op, project: op === "admin" ? null : project, input, actor: () => as });
	};
	const call = <T>(op: string, input: unknown = {}, as: Actor = owner): T => {
		const reply = raw(op, input, as);
		if (!reply.ok) throw new Error(`${op}: ${reply.error.code}: ${reply.error.message}`);
		return reply.result as T;
	};
	call("admin", {
		do: "project.create",
		key: project,
		preset: options.preset ?? "loose",
		...(options.unlinked ? { unlinked: options.unlinked } : {}),
	});
	return {
		app,
		owner,
		advance: (ms) => {
			now += ms;
		},
		call,
		raw,
		actor(name, kind, can) {
			const { secret } = createToken(app, { actor: name, kind, can, project: 0, label: "test" });
			const actor = authenticate(app, secret, 0);
			if (!actor) throw new Error("token did not authenticate");
			return actor;
		},
		close: () => app.close(),
	};
}

/** A CI report for `n` tests on a commit; `fail` maps a test index to its failure message. */
export function ciReport(input: {
	commit: string;
	branch?: string;
	pr?: number;
	base?: string;
	n: number;
	fail?: Record<number, string>;
	file?: string;
	attempt?: number;
	job?: string;
	shard?: { index: number; of: number };
	/** The test numbers to report, when not 0 to n - 1: a shard or a job holds some of the tests. */
	only?: readonly number[];
}) {
	const numbers = input.only ?? Array.from({ length: input.n }, (_, i) => i);
	const results = numbers.map((i) => {
		const message = input.fail?.[i];
		return {
			test: {
				key: `${input.file ?? "tests/checkout.spec.ts"}::suite::test ${i}`,
				name: `test ${i}`,
				file: input.file ?? "tests/checkout.spec.ts",
			},
			outcome: message ? ("fail" as const) : ("pass" as const),
			durationMs: 10 + i,
			...(message ? { failure: { message } } : {}),
		};
	});
	return {
		target: {
			commit: input.commit,
			repo: "acme/web",
			branch: input.branch ?? "main",
			...(input.pr ? { pr: input.pr } : {}),
			...(input.base ? { base: input.base } : {}),
		},
		job: input.job ?? "e2e",
		attempt: input.attempt ?? 1,
		...(input.shard ? { shard: input.shard } : {}),
		results,
	};
}
