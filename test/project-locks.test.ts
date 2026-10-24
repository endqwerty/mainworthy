import { afterEach, expect, test } from "bun:test";
import { z } from "zod";
import { lookupPlans } from "../bench/lock-waits.ts";
import type { ReportInput } from "../src/core/ops.ts";
import { rebuildAssertionIndexes } from "../src/server/evidence/assertions.ts";
import type { Ctx } from "../src/server/kernel/ctx.ts";
import { createProject } from "../src/server/ops/admin.ts";
import { defineInstanceOp, defineOp, invoke } from "../src/server/ops/registry.ts";
import { type Harness, harness } from "./helpers.ts";

let h: Harness;
afterEach(async () => {
	await h?.close();
});
const barrier = () => Promise.withResolvers<void>();

test("lookup plan diagnostics execute each prepared-plan mode without changing evidence", async () => {
	h = await harness();
	const input = ciReport({ commit: "plan-diagnostic", n: 2 });
	const first = input.results[0];
	if (!first) throw new Error("missing diagnostic result");
	first.test.key = "quote'key\\path";
	await h.call("report", input);
	const entries: unknown[] = [];
	await lookupPlans(h.app, h.owner.id, input, (entry) => entries.push(entry));
	expect(entries).toHaveLength(13);
	const plans = z
		.array(
			z.object({
				statistics: z.enum(["observed", "analyzed"]),
				mode: z.enum(["auto", "force_custom_plan", "force_generic_plan"]),
				match: z.boolean(),
				keys: z.number(),
				plan: z.array(z.string()),
			}),
		)
		.parse(entries.slice(1));
	expect(new Set(plans.map((plan) => `${plan.statistics}:${plan.mode}:${plan.match}`)).size).toBe(12);
	expect(plans.every((plan) => plan.keys === 2 && plan.plan.some((line) => line.startsWith("Execution Time:")))).toBe(
		true,
	);
	expect(await h.app.database.read((db) => db.allDynamic("SELECT count(*) AS n FROM results"))).toEqual([{ n: 2 }]);
});

test("different projects overlap inside their write transactions, including the same caller", async () => {
	h = await harness();
	await h.call("admin", { do: "project.create", key: "other" });
	const entered = [barrier(), barrier()] as const;
	const release = barrier();
	const op = defineOp({
		name: "probe",
		summary: "probe",
		scope: "project",
		effect: "write",
		needs: "produce",
		mcp: null,
		input: z.object({ index: z.number() }),
		output: z.number(),
		async run(ctx: Ctx, input: z.infer<typeof probeInput>) {
			entered[input.index === 0 ? 0 : 1].resolve();
			await release.promise;
			return ctx.seq;
		},
	});
	const first = invoke(
		h.app,
		{ probe: op },
		{ op: "probe", project: "scratch", input: { index: 0 }, actor: async () => h.owner },
	);
	await entered[0].promise;
	const second = invoke(
		h.app,
		{ probe: op },
		{ op: "probe", project: "other", input: { index: 1 }, actor: async () => h.owner },
	);
	try {
		await Promise.race([
			entered[1].promise,
			new Promise((_, reject) =>
				setTimeout(() => reject(new Error("second project never entered while the first held its barrier")), 1000),
			),
		]);
	} finally {
		release.resolve();
	}
	const replies = await Promise.all([first, second]);
	expect(replies.map((reply) => (reply.ok ? reply.seq : reply.error.code))).toEqual([2, 2]);
	expect(await h.app.database.read((db) => db.allDynamic("SELECT seq FROM projects ORDER BY id"))).toEqual([
		{ seq: 2 },
		{ seq: 2 },
	]);
});

import { createToken, hashToken, moveProjectGrants, revokeToken } from "../src/server/identity/identity.ts";
import { lockActors, lockProjectAuthority } from "../src/server/identity/locks.ts";
import { lockProject, retireDemo } from "../src/server/kernel/ctx.ts";
import { Busy, Database, isBusy, sql } from "../src/server/kernel/db.ts";
import { OPS } from "../src/server/ops/index.ts";
import { reportOp, reportSteps } from "../src/server/ops/writes.ts";
import { ciReport } from "./helpers.ts";

async function blocked(): Promise<void> {
	const end = performance.now() + 1000;
	while (performance.now() < end) {
		const rows = await h.app.database.read((db) =>
			db.allDynamic<{ n: number }>(
				"SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
			),
		);
		if ((rows[0]?.n ?? 0) > 0) return;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error("the second transaction never waited for a lock");
}
const probeInput = z.object({ cmd: z.string().optional(), index: z.number() });
const probeBase = {
	name: "probe",
	summary: "probe",
	scope: "project",
	effect: "write",
	needs: "record",
	mcp: null,
	input: probeInput,
	output: z.number(),
} as const;

test("project grant changes wait for the project's writer row", async () => {
	h = await harness();
	await h.actor("member", "human", ["read"]);
	const entered = barrier();
	const release = barrier();
	const holding = h.app.database.write((db) =>
		db.transaction(async () => {
			await lockProject(db, 1);
			entered.resolve();
			await release.promise;
		}),
	);
	await entered.promise;
	let finished = false;
	const change = h
		.call("admin", { do: "grant.set", actor: "member", project: "scratch", can: ["read", "record"] })
		.then(() => {
			finished = true;
		});
	try {
		await blocked();
		expect(finished).toBe(false);
	} finally {
		release.resolve();
		await Promise.all([holding, change]);
	}
});

test("moving personal and team grants waits for the source project's writer", async () => {
	h = await harness();
	await h.actor("member", "human", ["read"]);
	await h.call("admin", { do: "grant.set", actor: "member", project: "scratch", can: ["read"] });
	await h.call("admin", { do: "project.create", key: "other" });
	await h.call("admin", { do: "team.create", name: "quality" });
	await h.call("admin", { do: "team.member.add", team: "quality", person: "member" });
	await h.call("admin", { do: "team.grant.set", team: "quality", project: "scratch", can: ["read", "record"] });
	const version = await h.app.database.read((db) =>
		db.one(sql<[], { auth_version: number }>("SELECT auth_version FROM actors WHERE name='member'")),
	);
	const entered = barrier();
	const release = barrier();
	const holding = h.app.database.write((db) =>
		db.transaction(async () => {
			await lockProject(db, 1);
			entered.resolve();
			await release.promise;
		}),
	);
	await entered.promise;
	let moved = false;
	const moving = h.app.database
		.write((db) => db.transaction(() => moveProjectGrants(db, 1, 2)))
		.then(() => {
			moved = true;
		});
	try {
		await blocked();
		expect(moved).toBe(false);
	} finally {
		release.resolve();
		await Promise.all([holding, moving]);
	}
	expect(
		await h.app.database.read((db) =>
			db.allDynamic(
				"SELECT project FROM grants WHERE actor=(SELECT id FROM actors WHERE name='member') ORDER BY project",
			),
		),
	).toEqual([{ project: 0 }, { project: 2 }]);
	expect(await h.app.database.read((db) => db.allDynamic("SELECT project FROM team_grants ORDER BY project"))).toEqual([
		{ project: 2 },
	]);
	expect(
		await h.app.database.read((db) =>
			db.one(sql<[], { auth_version: number }>("SELECT auth_version FROM actors WHERE name='member'")),
		),
	).toEqual({ auth_version: version.auth_version + 2 });
});

for (const path of ["batched adoption", "batched test linking"] as const)
	test(`${path} stays behind the project's writer until it commits`, async () => {
		h = await harness({ unlinked: "ask" });
		let input: unknown;
		if (path === "batched adoption") {
			await h.call("propose", { edits: [1, 2].map((n) => ({ op: "create", body: { title: `Case ${n}` } })) });
			input = { edits: [1, 2].map((n) => ({ op: "edit", case: `C-${n}`, base: 1, body: { pre: "After" } })) };
		} else {
			await h.call("report", ciReport({ commit: "batch-link-lock", n: 201 }));
			const queue = await h.call<{ items: { q: string; evidenceHash: string }[] }>("inbox", { kind: "map" });
			const question = queue.items[0];
			if (!question) throw new Error("missing map question");
			input = { q: question.q, onEvidence: question.evidenceHash, answer: { is: "create" } };
		}
		const entered = barrier();
		const release = barrier();
		const holding = h.app.database.write((db) =>
			db.transaction(async () => {
				await lockProject(db, 1);
				entered.resolve();
				await release.promise;
			}),
		);
		await entered.promise;
		let completed = false;
		const operation = h.call(path === "batched adoption" ? "propose" : "decide", input).then(() => {
			completed = true;
		});
		try {
			await blocked();
			expect(completed).toBe(false);
			if (path === "batched adoption")
				expect(await h.app.database.read((db) => db.allDynamic("SELECT head FROM cases ORDER BY no"))).toEqual([
					{ head: 1 },
					{ head: 1 },
				]);
			else
				expect(
					await h.app.database.read((db) => db.allDynamic("SELECT count(*) AS n FROM tests WHERE case_id IS NOT NULL")),
				).toEqual([{ n: 0 }]);
		} finally {
			release.resolve();
			await Promise.all([holding, operation]);
		}
		if (path === "batched adoption")
			expect(await h.app.database.read((db) => db.allDynamic("SELECT head FROM cases ORDER BY no"))).toEqual([
				{ head: 2 },
				{ head: 2 },
			]);
		else
			expect(
				await h.app.database.read((db) =>
					db.allDynamic(
						"SELECT count(*) AS n FROM tests t JOIN cases c ON c.id=t.case_id JOIN decisions d ON d.id=t.linked_by WHERE c.project=t.project AND c.title=t.name AND d.kind='map'",
					),
				),
			).toEqual([{ n: 201 }]);
	});

test("assertion reconstruction owns its project before its first index mutation", async () => {
	h = await harness();
	let checked = false;
	await h.app.database.write((db) =>
		db.transaction(async () => {
			const run = db.run.bind(db);
			db.run = async (...args) => {
				if (!checked) {
					checked = true;
					const available = await h.app.database.write((other) =>
						other.transaction(async () => {
							try {
								await other.savepoint(() =>
									other.get(
										sql<{ id: number }, { id: number }>("SELECT id FROM projects WHERE id=$id FOR UPDATE NOWAIT"),
										{ id: 1 },
									),
								);
								return true;
							} catch (error) {
								if (isBusy(error)) return false;
								throw error;
							}
						}),
					);
					expect(available).toBe(false);
				}
				return run(...args);
			};
			try {
				await rebuildAssertionIndexes(db, true);
			} finally {
				db.run = run;
			}
		}),
	);
	expect(checked).toBe(true);
});

test("forgetting an actor also locks retired projects whose history it rewrites", async () => {
	h = await harness();
	await h.call("admin", { do: "project.demo", key: "scratch" });
	const member = await h.actor("member", "human", ["read", "produce"]);
	await h.call("propose", { edits: [{ op: "create", body: { title: "Retained history" } }] }, member);
	await h.app.database.write((db) =>
		db.transaction(async () => {
			const project = await lockProject(db, 1);
			if (!project) throw new Error("missing project");
			await retireDemo(db, project);
		}),
	);
	const entered = barrier();
	const release = barrier();
	const holding = h.app.database.write((db) =>
		db.transaction(async () => {
			await lockProject(db, 1);
			entered.resolve();
			await release.promise;
		}),
	);
	await entered.promise;
	let forgotten = false;
	const forgetting = h.call("admin", { do: "actor.forget", name: "member" }).then(() => {
		forgotten = true;
	});
	try {
		await blocked();
		expect(forgotten).toBe(false);
	} finally {
		release.resolve();
		await Promise.all([holding, forgetting]);
	}
	expect(
		await h.app.database.read((db) =>
			db.allDynamic("SELECT disabled_at IS NOT NULL AS disabled FROM actors WHERE id=$1", [member.id]),
		),
	).toEqual([{ disabled: true }]);
});

test("a team's name does not lock an unrelated actor with the same name", async () => {
	h = await harness();
	const unrelated = await h.actor("quality", "human", ["read", "record"]);
	const entered = barrier();
	const release = barrier();
	const holding = h.app.database.write((db) =>
		db.transaction(async () => {
			await lockActors(db, [unrelated.id]);
			entered.resolve();
			await release.promise;
		}),
	);
	await entered.promise;
	try {
		const created = await Promise.race([
			h.raw("admin", { do: "team.create", name: "quality" }),
			new Promise((_, reject) => setTimeout(() => reject(new Error("the team name locked an unrelated actor")), 1000)),
		]);
		expect(created).toMatchObject({ ok: true, result: { team: "quality", changed: true } });
	} finally {
		release.resolve();
		await holding;
	}
});

test("a project reset restarts when a grant holder appears during its project lock wait", async () => {
	h = await harness();
	const member = await h.actor("member", "human", ["read"]);
	const entered = barrier();
	const release = barrier();
	const granting = h.app.database.write((db) =>
		db.transaction(async () => {
			await lockActors(db, [member.id], true);
			await lockProject(db, 1);
			entered.resolve();
			await release.promise;
			await db.run(sql<{ actor: number }>("INSERT INTO grants(actor, project, can) VALUES ($actor, 1, '[\"read\"]')"), {
				actor: member.id,
			});
		}),
	);
	await entered.promise;
	const resetting = h.app.database
		.write((db) => db.transaction(() => lockProjectAuthority(db, 1, h.owner.id)))
		.then(
			() => "allowed",
			(error: unknown) => (error instanceof Busy ? "busy" : Promise.reject(error)),
		);
	try {
		await blocked();
	} finally {
		release.resolve();
		await granting;
	}
	expect(await resetting).toBe("busy");
	await h.app.database.write((db) => db.transaction(() => lockProjectAuthority(db, 1, h.owner.id)));
});

test("same project writers serialize and allocate sequence in commit order", async () => {
	h = await harness();
	const firstEntered = barrier();
	const release = barrier();
	const seen: number[] = [];
	const op = defineOp({
		...probeBase,
		async run(ctx: Ctx, input: z.infer<typeof probeInput>) {
			seen.push(input.index);
			if (input.index === 0) {
				firstEntered.resolve();
				await release.promise;
			}
			return ctx.seq;
		},
	});
	const request = (index: number) =>
		invoke(h.app, { probe: op }, { op: "probe", project: "scratch", input: { index }, actor: async () => h.owner });
	const first = request(0);
	await firstEntered.promise;
	const second = request(1);
	try {
		await blocked();
		expect(seen).toEqual([0]);
	} finally {
		release.resolve();
	}
	const replies = await Promise.all([first, second]);
	expect(seen).toEqual([0, 1]);
	expect(replies.map((reply) => (reply.ok ? reply.seq : reply.error.code))).toEqual([2, 3]);
});

for (const scope of ["project", "instance"] as const)
	test(`a writer waiting on a replaced project restarts its ${scope} operation`, async () => {
		h = await harness();
		await h.call("admin", { do: "project.demo", key: "scratch" });
		const caller = await h.actor("global-pipeline", "ci", ["read", "record"]);
		const removed = barrier();
		const release = barrier();
		let ran = false;
		const op =
			scope === "project"
				? defineOp({
						...probeBase,
						async run(ctx: Ctx) {
							ran = true;
							return ctx.seq;
						},
					})
				: defineInstanceOp({
						...probeBase,
						scope: "instance",
						input: probeInput.extend({ project: z.string() }),
						async run() {
							ran = true;
							return 0;
						},
					});
		const resetting = h.app.database.write((db) =>
			db.transaction(async () => {
				await lockProjectAuthority(db, 1, h.owner.id);
				const project = await lockProject(db, 1);
				if (!project) throw new Error("missing demo");
				await retireDemo(db, project);
				removed.resolve();
				await release.promise;
				await createProject(
					{ app: h.app, db, actor: h.owner, now: h.app.now(), session: null, context: null },
					{ key: "scratch" },
				);
			}),
		);
		await removed.promise;
		const call = {
			op: "probe",
			project: scope === "project" ? "scratch" : null,
			input: { index: 0, cmd: "replaced-project", project: "scratch" },
			actor: async () => caller,
		};
		const writing = invoke(h.app, { probe: op }, call);
		try {
			await blocked();
		} finally {
			release.resolve();
			await resetting;
		}
		expect(await writing).toMatchObject({ ok: false, error: { code: "busy" } });
		expect(ran).toBe(false);
		expect(
			await h.app.database.read((db) => db.allDynamic("SELECT id FROM commands WHERE id='replaced-project'")),
		).toEqual([]);
		expect((await invoke(h.app, { probe: op }, call)).ok).toBe(true);
	});

test("revocation waits for only its actor's admitted writers", async () => {
	h = await harness();
	await h.call("admin", { do: "project.create", key: "other" });
	const token = await createToken(h.app, {
		actor: "pipeline",
		kind: "ci",
		can: ["read", "record"],
		project: 0,
		label: "pipeline",
	});
	const other = await h.actor("other", "ci", ["read", "record"]);
	const entered = barrier();
	const release = barrier();
	const op = defineOp({
		...probeBase,
		async run(ctx: Ctx, input: z.infer<typeof probeInput>) {
			if (input.index === 0) {
				entered.resolve();
				await release.promise;
			}
			return ctx.seq;
		},
	});
	const first = invoke(
		h.app,
		{ probe: op },
		{
			op: "probe",
			project: "scratch",
			input: { index: 0 },
			actor: async () => null,
			reference: { via: "token", hash: hashToken(token.secret) },
		},
	);
	await entered.promise;
	let revoked = false;
	const revocation = h.app.database.write((db) =>
		db.transaction(async () => {
			await revokeToken(h.app, db, token.id);
			revoked = true;
		}),
	);
	try {
		await blocked();
		const independent = await invoke(
			h.app,
			{ probe: op },
			{ op: "probe", project: "other", input: { index: 1 }, actor: async () => other },
		);
		expect(independent.ok).toBe(true);
		expect(revoked).toBe(false);
	} finally {
		release.resolve();
		await first;
		await revocation;
	}
	expect(revoked).toBe(true);
});

test("a bounded wait returns busy and rolls back the command id for a same-id retry", async () => {
	h = await harness();
	const short = await Database.open({ url: h.app.config.databaseUrl, lockWaitMs: 30 });
	const entered = barrier();
	const release = barrier();
	const holder = h.app.database.write((db) =>
		db.transaction(async () => {
			await db.allDynamic("SELECT id FROM projects WHERE key = 'scratch' FOR UPDATE");
			entered.resolve();
			await release.promise;
		}),
	);
	await entered.promise;
	const call = {
		op: "propose",
		project: "scratch",
		input: { cmd: "same-command", edits: [{ op: "create", body: { title: "retried" } }] },
		actor: async () => h.owner,
	};
	try {
		const reply = await invoke({ ...h.app, database: short }, OPS, call);
		expect(reply).toMatchObject({ ok: false, error: { code: "busy" } });
		expect(
			await h.app.database.read((db) => db.allDynamic("SELECT id FROM commands WHERE id = 'same-command'")),
		).toEqual([]);
	} finally {
		release.resolve();
		await holder;
		await short.close();
	}
	expect((await invoke(h.app, OPS, call)).ok).toBe(true);
});

test("a PostgreSQL deadlock becomes busy instead of internal", async () => {
	h = await harness();
	await h.call("admin", { do: "project.create", key: "other" });
	const entered = [barrier(), barrier()] as const;
	const op = defineOp({
		...probeBase,
		async run(ctx: Ctx, input: z.infer<typeof probeInput>) {
			entered[input.index === 0 ? 0 : 1].resolve();
			await Promise.all(entered.map((item) => item.promise));
			await ctx.db.allDynamic("SELECT id FROM projects WHERE key = $1 FOR UPDATE", [
				input.index === 0 ? "other" : "scratch",
			]);
			return ctx.seq;
		},
	});
	const replies = await Promise.all(
		["scratch", "other"].map((project, index) =>
			invoke(h.app, { probe: op }, { op: "probe", project, input: { index }, actor: async () => h.owner }),
		),
	);
	expect(replies.filter((reply) => reply.ok)).toHaveLength(1);
	expect(replies.find((reply) => !reply.ok)).toMatchObject({ ok: false, error: { code: "busy" } });
});

test("command ids are unique across projects while writes overlap", async () => {
	h = await harness();
	await h.call("admin", { do: "project.create", key: "other" });
	const replies = await Promise.all(
		["scratch", "other"].map((project) =>
			invoke(h.app, OPS, {
				op: "propose",
				project,
				input: { cmd: "instance-command-id", edits: [{ op: "create", body: { title: project } }] },
				actor: async () => h.owner,
			}),
		),
	);
	expect(replies.filter((reply) => reply.ok)).toHaveLength(1);
	expect(replies.find((reply) => !reply.ok)).toMatchObject({ ok: false, error: { code: "conflict" } });
});

import { actorByName, removeGrant, signInWithToken } from "../src/server/identity/identity.ts";
import { endSessionById, findSession } from "../src/server/identity/sessions.ts";
import { recoverAccepted } from "../src/server/ops/jobs.ts";
import { COMMIT } from "../src/server/ops/registry.ts";
import { exportArchive } from "../src/server/transfer/transfer.ts";

for (const revoked of ["token", "session", "grant"] as const) {
	test(`a report releases acceptance locks, permits a same-project write, and refuses a revoked ${revoked}`, async () => {
		h = await harness();
		const events: import("../src/server/kernel/app.ts").ChangeEvent[] = [];
		h.app.subscribe((event) => events.push(event));
		const token = await createToken(h.app, {
			actor: "pipeline",
			kind: "ci",
			can: ["read", "record"],
			project: 0,
			label: "pipeline",
		});
		let reference: import("../src/server/kernel/caller.ts").CallerReference = {
			via: "token",
			hash: hashToken(token.secret),
		};
		let sessionId = 0;
		if (revoked === "session") {
			const signed = await signInWithToken(h.app, token.secret, { userAgent: null, address: null });
			if (signed.kind !== "opening") throw new Error("no token sign-in");
			const session = await signed.signedIn;
			if (!session) throw new Error("session refused");
			reference = { via: "cookie", hash: hashToken(session.cookie), activity: 0, idleMs: h.app.config.sessionIdleMs };
			sessionId = (await findSession(h.app, reference.hash))?.id ?? 0;
		}
		const beforeCommit = barrier();
		const commit = barrier();
		const changing = barrier();
		const finishChange = barrier();
		const op = defineOp({
			...reportOp,
			effect: "write",
			async *steps(ctx: Ctx, input: ReportInput) {
				const iterator = reportSteps(ctx, input);
				for (;;) {
					const step = await iterator.next();
					if (step.done) return step.value;
					if (step.value === COMMIT) {
						beforeCommit.resolve();
						await commit.promise;
					}
					yield step.value;
				}
			},
		});
		const pending = invoke(
			h.app,
			{ ...OPS, report: op },
			{
				op: "report",
				project: "scratch",
				input: { ...ciReport({ commit: "a".repeat(40), n: 1 }), cmd: `refuse-${revoked}` },
				reference,
				actor: async () => null,
			},
		);
		await beforeCommit.promise;
		const actor = await h.app.database.read((db) =>
			db.one(sql<{ id: number }, { actor: number }>("SELECT actor FROM tokens WHERE id = $id"), { id: token.id }),
		);
		const change = h.app.database.write((db) =>
			db.transaction(async () => {
				await lockActors(db, [actor.actor], true);
				changing.resolve();
				await finishChange.promise;
				if (revoked === "token") await revokeToken(h.app, db, token.id);
				else if (revoked === "session") await endSessionById(db, sessionId, h.app.now());
				else await removeGrant(h.app, db, { actor: "pipeline", project: 0 });
			}),
		);
		try {
			await blocked();
			commit.resolve();
			await changing.promise;
			const other = await h.raw("propose", { edits: [{ op: "create", body: { title: "between report phases" } }] });
			expect(other.ok).toBe(true);
			expect(other.ok ? other.seq : null).toBe(3);
			const chunks: string[] = [];
			await h.app.database.read((db) =>
				exportArchive(db, (chunk) => {
					chunks.push(chunk);
				}),
			);
			expect(chunks.join("")).not.toContain(reference.hash);
			expect(chunks.join("")).not.toContain(hashToken(token.secret));
		} finally {
			commit.resolve();
			finishChange.resolve();
			await change;
		}
		const reply = await pending;
		expect(reply).toMatchObject({ ok: false, error: { code: "forbidden" } });
		expect(events.map((event) => event.seq)).toEqual([2, 3, 4]);
		expect(events.at(-1)?.touched).toContain("R-1");
		expect(await h.app.database.read((db) => db.allDynamic("SELECT state, staged FROM batches"))).toEqual([
			{ state: "cancelled", staged: null },
		]);
		expect(await h.app.database.read((db) => db.allDynamic("SELECT * FROM batch_admissions"))).toEqual([]);
		expect(
			await h.app.database.read((db) => db.allDynamic<{ outstanding: number }>("SELECT outstanding FROM runs")),
		).toEqual([{ outstanding: 0 }]);
		expect(
			await h.app.database.read((db) =>
				db.allDynamic("SELECT outcome FROM commands WHERE id = $1", [`refuse-${revoked}`]),
			),
		).toEqual([{ outcome: '{"refused":"report"}' }]);
	});
}

for (const revoked of ["token", "session", "grant", "imported", "forgotten"] as const) {
	test(`recovery cancels an accepted report with ${revoked} authority lost`, async () => {
		h = await harness();
		const token = await createToken(h.app, {
			actor: "pipeline",
			kind: "ci",
			can: ["read", "record"],
			project: 0,
			label: "pipeline",
		});
		let reference: import("../src/server/kernel/caller.ts").CallerReference = {
			via: "token",
			hash: hashToken(token.secret),
		};
		let sessionId = 0;
		if (revoked === "session") {
			const signed = await signInWithToken(h.app, token.secret, { userAgent: null, address: null });
			if (signed.kind !== "opening") throw new Error("sign-in refused");
			const session = await signed.signedIn;
			if (!session) throw new Error("no session");
			reference = { via: "cookie", hash: hashToken(session.cookie), activity: 0, idleMs: h.app.config.sessionIdleMs };
			sessionId = (await findSession(h.app, reference.hash))?.id ?? 0;
		}
		const crashed = defineOp({
			...reportOp,
			effect: "write",
			async *steps(ctx: Ctx, input: ReportInput) {
				const iterator = reportSteps(ctx, input);
				for (;;) {
					const step = await iterator.next();
					if (step.done) return step.value;
					yield step.value;
					if (step.value === COMMIT) throw new Error("deliberate interruption after acceptance");
				}
			},
		});
		const reply = await invoke(
			h.app,
			{ ...OPS, report: crashed },
			{
				op: "report",
				project: "scratch",
				input: { ...ciReport({ commit: "b".repeat(40), n: 1 }), cmd: `recover-${revoked}` },
				...(revoked === "forgotten" ? {} : { reference }),
				actor: async (project) =>
					revoked === "forgotten" ? await h.app.database.read((db) => actorByName(db, "pipeline", project)) : null,
			},
		);
		expect(reply).toMatchObject({ ok: false, error: { code: "internal" } });
		if (revoked === "forgotten") await h.call("admin", { do: "actor.forget", name: "pipeline" });
		else
			await h.app.database.write((db) =>
				db.transaction(async () => {
					if (revoked === "token") await revokeToken(h.app, db, token.id);
					else if (revoked === "session") await endSessionById(db, sessionId, h.app.now());
					else if (revoked === "grant") await removeGrant(h.app, db, { actor: "pipeline", project: 0 });
					else await db.exec("DELETE FROM batch_admissions");
				}),
			);
		expect(await recoverAccepted(h.app)).toBe(0);
		expect(await h.app.database.read((db) => db.allDynamic("SELECT state FROM batches"))).toEqual([
			{ state: "cancelled" },
		]);
		expect(await h.app.database.read((db) => db.allDynamic("SELECT outstanding FROM runs"))).toEqual([
			{ outstanding: 0 },
		]);
		expect(await h.app.database.read((db) => db.allDynamic("SELECT * FROM results"))).toEqual([]);
		expect(await h.app.database.read((db) => db.allDynamic("SELECT * FROM batch_admissions"))).toEqual([]);
		expect(
			await h.app.database.read((db) =>
				db.allDynamic("SELECT outcome FROM commands WHERE id = $1", [`recover-${revoked}`]),
			),
		).toEqual([{ outcome: '{"refused":"report"}' }]);
	});
}

test("a team grant waits for its members, and versions every affected member only", async () => {
	h = await harness();
	await h.actor("alice", "human", ["read", "record"]);
	await h.actor("bob", "human", ["read", "record"]);
	await h.actor("unrelated", "human", ["read", "record"]);
	await h.call("admin", { do: "team.create", name: "quality" });
	for (const person of ["alice", "bob"]) await h.call("admin", { do: "team.member.add", team: "quality", person });
	await h.call("admin", { do: "team.grant.set", team: "quality", can: ["read", "record"] });
	const before = await h.app.database.read((db) =>
		db.allDynamic<{ id: number; name: string; auth_version: number }>(
			"SELECT id,name,auth_version FROM actors ORDER BY id",
		),
	);
	const alice = before.find((row) => row.name === "alice");
	if (!alice) throw new Error("missing actor");
	const entered = barrier();
	const release = barrier();
	const writer = h.app.database.write((db) =>
		db.transaction(async () => {
			await lockActors(db, [alice.id]);
			entered.resolve();
			await release.promise;
		}),
	);
	await entered.promise;
	const revoke = h.call("admin", { do: "team.grant.remove", team: "quality" });
	try {
		await blocked();
	} finally {
		release.resolve();
		await writer;
		await revoke;
	}
	const after = await h.app.database.read((db) =>
		db.allDynamic<{ id: number; name: string; auth_version: number }>(
			"SELECT id,name,auth_version FROM actors ORDER BY id",
		),
	);
	expect(
		after.map((row) => ({
			name: row.name,
			change: row.auth_version - (before.find((held) => held.id === row.id)?.auth_version ?? 0),
		})),
	).toEqual(before.map((row) => ({ name: row.name, change: ["alice", "bob"].includes(row.name) ? 1 : 0 })));
});

test("organisation authority changes increment every member in the same transaction", async () => {
	h = await harness();
	await h.actor("member", "human", ["read"]);
	const before = await h.app.database.read((db) =>
		db.allDynamic<{ id: number; auth_version: number }>("SELECT id,auth_version FROM actors ORDER BY id"),
	);
	await h.app.database.write((db) =>
		db.transaction(async () => {
			await lockActors(
				db,
				before.map((row) => row.id),
				true,
			);
			await db.exec("UPDATE orgs SET name = 'renamed'");
		}),
	);
	expect(await h.app.database.read((db) => db.allDynamic("SELECT id,auth_version FROM actors ORDER BY id"))).toEqual(
		before.map((row) => ({ ...row, auth_version: row.auth_version + 1 })),
	);
});

test("busy after report acceptance preserves its command and admission for a same-id retry", async () => {
	h = await harness();
	const short = await Database.open({ url: h.app.config.databaseUrl, lockWaitMs: 30 });
	const entered = barrier();
	const commit = barrier();
	const acquired = barrier();
	const release = barrier();
	const op = defineOp({
		...reportOp,
		effect: "write",
		async *steps(ctx: Ctx, input: ReportInput) {
			const iterator = reportSteps(ctx, input);
			for (;;) {
				const step = await iterator.next();
				if (step.done) return step.value;
				if (step.value === COMMIT) {
					entered.resolve();
					await commit.promise;
				}
				yield step.value;
			}
		},
	});
	const call = {
		op: "report",
		project: "scratch",
		input: { ...ciReport({ commit: "d".repeat(40), n: 1 }), cmd: "accepted-busy-report" },
		actor: async () => h.owner,
	};
	const pending = invoke({ ...h.app, database: short }, { ...OPS, report: op }, call);
	await entered.promise;
	const holder = h.app.database.write((db) =>
		db.transaction(async () => {
			await lockActors(db, [h.owner.id], true);
			acquired.resolve();
			await release.promise;
		}),
	);
	try {
		await blocked();
		commit.resolve();
		await acquired.promise;
		expect(await pending).toMatchObject({ ok: false, error: { code: "busy" } });
		expect(
			await h.app.database.read((db) =>
				db.allDynamic("SELECT outcome FROM commands WHERE id = 'accepted-busy-report'"),
			),
		).toEqual([{ outcome: "" }]);
		expect(await h.app.database.read((db) => db.allDynamic("SELECT state FROM batches"))).toEqual([
			{ state: "accepted" },
		]);
		expect(
			await h.app.database.read((db) => db.allDynamic<{ n: number }>("SELECT count(*) AS n FROM batch_admissions")),
		).toEqual([{ n: 1 }]);
	} finally {
		commit.resolve();
		release.resolve();
		await holder;
		await pending;
		await short.close();
	}
	expect((await invoke(h.app, OPS, call)).ok).toBe(true);
	expect(await h.app.database.read((db) => db.allDynamic("SELECT state FROM batches"))).toEqual([
		{ state: "processed" },
	]);
	expect(await h.app.database.read((db) => db.allDynamic("SELECT * FROM batch_admissions"))).toEqual([]);
});

test("a changed authority version still permits a live report credential with current capability", async () => {
	h = await harness();
	const token = await createToken(h.app, {
		actor: "pipeline",
		kind: "ci",
		can: ["read", "record"],
		project: 0,
		label: "admitting",
	});
	const other = await createToken(h.app, { actor: "pipeline", kind: "ci", can: [], project: 0, label: "another" });
	const crashed = defineOp({
		...reportOp,
		effect: "write",
		async *steps(ctx: Ctx, input: ReportInput) {
			const iterator = reportSteps(ctx, input);
			for (;;) {
				const step = await iterator.next();
				if (step.done) return step.value;
				yield step.value;
				if (step.value === COMMIT) throw new Error("deliberate interruption after acceptance");
			}
		},
	});
	await invoke(
		h.app,
		{ ...OPS, report: crashed },
		{
			op: "report",
			project: "scratch",
			input: ciReport({ commit: "e".repeat(40), n: 1 }),
			reference: { via: "token", hash: hashToken(token.secret) },
			actor: async () => null,
		},
	);
	await h.app.database.write((db) => db.transaction(() => revokeToken(h.app, db, other.id)));
	expect(await recoverAccepted(h.app)).toBe(1);
	expect(await h.app.database.read((db) => db.allDynamic("SELECT state FROM batches"))).toEqual([
		{ state: "processed" },
	]);
	expect(await h.app.database.read((db) => db.allDynamic("SELECT * FROM batch_admissions"))).toEqual([]);
});

test("the HTTP operation envelope returns busy with status 503", async () => {
	h = await harness();
	const short = await Database.open({ url: h.app.config.databaseUrl, lockWaitMs: 30 });
	const { serve } = await import("../src/surfaces/http.ts");
	const listener = serve({ ...h.app, database: short }, h.owner);
	const entered = barrier();
	const release = barrier();
	const held = h.app.database.write((db) =>
		db.transaction(async () => {
			await db.allDynamic("SELECT id FROM projects WHERE key = 'scratch' FOR UPDATE");
			entered.resolve();
			await release.promise;
		}),
	);
	await entered.promise;
	try {
		const response = await fetch(`http://127.0.0.1:${listener.port}/api/p/scratch/propose`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cmd: "http-busy-command", edits: [{ op: "create", body: { title: "later" } }] }),
		});
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({ ok: false, error: { code: "busy" } });
	} finally {
		release.resolve();
		await held;
		await listener.stop(true);
		await short.close();
	}
});

test("a team grant rolls back discovery when a new member committed during its guard wait", async () => {
	h = await harness();
	const member = await h.actor("member", "human", ["read"]);
	await h.call("admin", { do: "team.create", name: "quality" });
	const inserted = barrier();
	const release = barrier();
	const adding = h.app.database.write((db) =>
		db.transaction(async () => {
			await lockActors(db, [member.id], true);
			await db.run(
				sql<{ actor: number }>(
					"INSERT INTO team_members(team,actor) SELECT id,$actor FROM teams WHERE name = 'quality'",
				),
				{ actor: member.id },
			);
			inserted.resolve();
			await release.promise;
		}),
	);
	await inserted.promise;
	const changing = h.raw("admin", { do: "team.grant.set", team: "quality", can: ["read", "record"] });
	try {
		await blocked();
	} finally {
		release.resolve();
		await adding;
	}
	expect(await changing).toMatchObject({ ok: false, error: { code: "busy" } });
	expect(await h.app.database.read((db) => db.allDynamic("SELECT * FROM team_grants"))).toEqual([]);
	expect((await h.raw("admin", { do: "team.grant.set", team: "quality", can: ["read", "record"] })).ok).toBe(true);
});

test("two admins changing each other acquire their complete actor set in the same order", async () => {
	h = await harness();
	const tokens = await Promise.all(
		["admin-a", "admin-b"].map((actor) =>
			createToken(h.app, { actor, kind: "human", can: ["read", "admin"], project: 0, label: "admin" }),
		),
	);
	const replies = await Promise.all(
		tokens.map((token, index) =>
			invoke(h.app, OPS, {
				op: "admin",
				project: null,
				input: { do: "grant.set", actor: tokens[1 - index]?.actor, can: ["read", "admin"] },
				reference: { via: "token", hash: hashToken(token.secret) },
				actor: async () => null,
			}),
		),
	);
	expect(replies.map((reply) => reply.ok)).toEqual([true, true]);
});

test("cancelled automated evidence can be resubmitted with a new credential and command", async () => {
	h = await harness();
	const old = await createToken(h.app, {
		actor: "pipeline",
		kind: "ci",
		can: ["read", "record"],
		project: 0,
		label: "old",
	});
	const input = { ...ciReport({ commit: "c".repeat(40), n: 1 }), shard: { index: 1, of: 2 } };
	const crashed = defineOp({
		...reportOp,
		effect: "write",
		async *steps(ctx: Ctx, input: ReportInput) {
			const iterator = reportSteps(ctx, input);
			for (;;) {
				const step = await iterator.next();
				if (step.done) return step.value;
				yield step.value;
				if (step.value === COMMIT) throw new Error("deliberate interruption after acceptance");
			}
		},
	});
	await invoke(
		h.app,
		{ ...OPS, report: crashed },
		{
			op: "report",
			project: "scratch",
			input: { ...input, cmd: "cancelled-original-command" },
			reference: { via: "token", hash: hashToken(old.secret) },
			actor: async () => null,
		},
	);
	await h.app.database.write((db) => db.transaction(() => revokeToken(h.app, db, old.id)));
	await recoverAccepted(h.app);
	const cancelledGate = await h.call<{ waiting?: unknown }>("gate", { commit: "c".repeat(40) });
	expect(cancelledGate.waiting).toBeUndefined();
	const fresh = await createToken(h.app, { actor: "pipeline", kind: "ci", can: [], project: 0, label: "new" });
	const reply = await invoke(h.app, OPS, {
		op: "report",
		project: "scratch",
		input: { ...input, cmd: "resubmitted-new-command" },
		reference: { via: "token", hash: hashToken(fresh.secret) },
		actor: async () => null,
	});
	expect(reply.ok).toBe(true);
	expect(await h.app.database.read((db) => db.allDynamic("SELECT state FROM batches ORDER BY id"))).toEqual([
		{ state: "cancelled" },
		{ state: "processed" },
	]);
	const gate = await h.call<{ waiting: { missing: number[] }[] }>("gate", { commit: "c".repeat(40) });
	expect(gate.waiting[0]?.missing).toEqual([2]);
});

test("a last-use note cannot write an address onto a token whose id was reused", async () => {
	h = await harness();
	const token = await createToken(h.app, {
		actor: "pipeline",
		kind: "ci",
		can: ["read", "record"],
		project: 0,
		label: "old",
	});
	const { noteUse, flushUses } = await import("../src/server/identity/uses.ts");
	noteUse(h.app, "token", token.id, h.app.now(), "192.0.2.10", hashToken(token.secret));
	await h.app.database.write((db) =>
		db.transaction(() =>
			db.run(sql<{ id: number; hash: string }>("UPDATE tokens SET hash = $hash WHERE id = $id"), {
				id: token.id,
				hash: hashToken("replacement-credential"),
			}),
		),
	);
	await flushUses(h.app);
	expect(
		await h.app.database.read((db) =>
			db.allDynamic("SELECT last_used_addr,last_used_at FROM tokens WHERE id = $1", [token.id]),
		),
	).toEqual([{ last_used_addr: null, last_used_at: null }]);
});

test("a second command applying an accepted batch completes the accepting command atomically", async () => {
	h = await harness();
	const ci = await h.actor("pipeline", "ci", ["read", "record"]);
	const input = ciReport({ commit: "7".repeat(40), n: 1 });
	const accepted = barrier();
	const resume = barrier();
	const write = h.app.database.write.bind(h.app.database);
	let first = true;
	h.app.database.write = (work, options) =>
		write(async (db) => {
			if (first) {
				first = false;
				const begin = db.begin.bind(db);
				let transactions = 0;
				db.begin = async () => {
					if (++transactions === 2) {
						accepted.resolve();
						await resume.promise;
					}
					await begin();
				};
			}
			return work(db);
		}, options);
	const original = invoke(h.app, OPS, {
		op: "report",
		project: "scratch",
		input: { ...input, cmd: "original-accepting-command" },
		actor: async () => ci,
	});
	await accepted.promise;
	let duplicate: import("../src/server/ops/registry.ts").Reply | undefined;
	try {
		duplicate = await invoke(h.app, OPS, {
			op: "report",
			project: "scratch",
			input: { ...input, cmd: "other-applying-command" },
			actor: async () => ci,
		});
		expect(duplicate.ok).toBe(true);
		const rows = await h.app.database.read((db) =>
			db.allDynamic<{ outcome: string }>("SELECT outcome FROM commands WHERE id = 'original-accepting-command'"),
		);
		expect(rows[0]?.outcome).not.toBe("");
	} finally {
		h.app.database.write = write;
		resume.resolve();
		await original;
	}
	expect(await original).toEqual(duplicate);
});
