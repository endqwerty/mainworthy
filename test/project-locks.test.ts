import { afterEach, expect, spyOn, test } from "bun:test";
import { z } from "zod";
import { lookupPlans } from "../bench/lock-waits.ts";
import type { ReportInput } from "../src/core/ops.ts";
import { rebuildAssertionIndexes } from "../src/server/evidence/assertions.ts";
import { lockSignInActor } from "../src/server/identity/locks.ts";
import type { Ctx } from "../src/server/kernel/ctx.ts";
import { createProject } from "../src/server/ops/admin.ts";
import { defineInstanceOp, defineOp, type InstanceOp, invoke, type Reply } from "../src/server/ops/registry.ts";
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
import { lockActors, lockIdentity, lockProjectAuthority } from "../src/server/identity/locks.ts";
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

test("a project reset discovers grant holders after the preceding identity writer commits", async () => {
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
	expect(await resetting).toBe("allowed");
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
	test(`a ${scope} writer checks the project after its first conflicting lock wait`, async () => {
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
		if (scope === "project") {
			expect(await writing).toMatchObject({ ok: false, error: { code: "busy" } });
			expect(ran).toBe(false);
			expect(
				await h.app.database.read((db) => db.allDynamic("SELECT id FROM commands WHERE id='replaced-project'")),
			).toEqual([]);
		} else {
			expect((await writing).ok).toBe(true);
			expect(ran).toBe(true);
		}
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
			reference = { via: "cookie", hash: hashToken(session.cookie), idleMs: h.app.config.sessionIdleMs };
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
					if (step.value !== undefined) {
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
			reference = { via: "cookie", hash: hashToken(session.cookie), idleMs: h.app.config.sessionIdleMs };
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
					if (step.value !== undefined) throw new Error("deliberate interruption after acceptance");
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

for (const cmd of [undefined, "accepted-busy-report"]) {
	test(`busy after report acceptance returns pending and retry/recovery stores one case result ${cmd ? "with" : "without"} cmd`, async () => {
		h = await harness();
		await h.call("propose", { edits: [{ op: "create", body: { title: "Accepted once" } }] });
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
					if (step.value !== undefined) {
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
			input: {
				target: { commit: "d".repeat(40) },
				results: [{ test: { case: "C-1" }, outcome: "pass" }],
				...(cmd ? { cmd } : {}),
			},
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
		let reply: Reply;
		try {
			await blocked();
			commit.resolve();
			await acquired.promise;
			reply = await pending;
			expect(await h.app.database.read((db) => db.allDynamic("SELECT state FROM batches"))).toEqual([
				{ state: "accepted" },
			]);
			expect(await h.app.database.read((db) => db.allDynamic("SELECT count(*) AS n FROM results"))).toEqual([{ n: 0 }]);
			expect(await h.app.database.read((db) => db.allDynamic("SELECT outcome FROM commands"))).toEqual(
				cmd ? [{ outcome: "" }] : [],
			);
		} finally {
			commit.resolve();
			release.resolve();
			await holder;
			await pending;
			await short.close();
		}
		// A caller retries a busy reply unchanged; a successful acceptance needs no resubmission.
		if (!reply.ok && reply.error.code === "busy") expect((await invoke(h.app, OPS, call)).ok).toBe(true);
		if (reply.ok) expect(await h.call("gate", { commit: "d".repeat(40) })).toMatchObject({ verdict: "pending" });
		if (cmd) expect((await invoke(h.app, OPS, call)).ok).toBe(true);
		await recoverAccepted(h.app);
		expect(await recoverAccepted(h.app)).toBe(0);
		expect(await h.app.database.read((db) => db.allDynamic("SELECT count(*) AS n FROM results"))).toEqual([{ n: 1 }]);
		expect(await h.app.database.read((db) => db.allDynamic("SELECT state FROM batches"))).toEqual([
			{ state: "processed" },
		]);
		expect(reply).toMatchObject({
			ok: true,
			result: { batch: expect.any(Number), fresh: true, results: [], gate: { verdict: "pending" } },
		});
		expect(await h.app.database.read((db) => db.allDynamic("SELECT * FROM batch_admissions"))).toEqual([]);
		if (cmd) {
			const retry = await invoke(h.app, OPS, call);
			expect(retry).toMatchObject({ ok: true, result: { results: [expect.any(Number)] } });
			expect(await h.app.database.read((db) => db.allDynamic("SELECT count(*) AS n FROM results"))).toEqual([{ n: 1 }]);
		}
	});
}

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
				if (step.value !== undefined) throw new Error("deliberate interruption after acceptance");
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

test("a team grant discovers members after the preceding identity writer commits", async () => {
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
	expect((await changing).ok).toBe(true);
	expect(await h.app.database.read((db) => db.allDynamic("SELECT can FROM team_grants"))).toEqual([
		{ can: '["read","record"]' },
	]);
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
				if (step.value !== undefined) throw new Error("deliberate interruption after acceptance");
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
	const { noteUse } = await import("../src/server/identity/uses.ts");
	await h.app.database.write((db) =>
		db.transaction(() =>
			db.run(sql<{ id: number; hash: string }>("UPDATE tokens SET hash = $hash WHERE id = $id"), {
				id: token.id,
				hash: hashToken("replacement-credential"),
			}),
		),
	);
	await noteUse(h.app, "token", token.id, h.app.now(), "192.0.2.10", hashToken(token.secret));
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

import { CredentialInput } from "../src/core/people.ts";
import { insertOidc, oidcHandle } from "../src/server/identity/credentials.ts";
import { acceptInvitation, beginOidcSignIn, finishOidcSignIn } from "../src/server/identity/people.ts";
import { openSession } from "../src/server/identity/sessions.ts";
import { sqlState } from "../src/server/kernel/db.ts";
import { provider } from "./oidc-support.ts";

for (const action of ["grant.set", "grant.remove", "team.grant.set", "team.grant.remove"] as const) {
	test(`identity creation finishes before ${action} discovers actors and waits for its project`, async () => {
		h = await harness();
		const team = action.startsWith("team.");
		const states: string[] = [];
		const write = h.app.database.write.bind(h.app.database);
		h.app.database.write = (work, options) =>
			write(async (db) => {
				const all = db.all.bind(db);
				db.all = async (statement, ...params) => {
					try {
						return await all(statement, ...params);
					} catch (error) {
						const state = sqlState(error);
						if (state) states.push(state);
						throw error;
					}
				};
				return work(db);
			}, options);
		const ready = barrier();
		const release = barrier();
		const holding = h.app.database.write((db) =>
			db.transaction(async () => {
				await lockProject(db, 1);
				ready.resolve();
				await release.promise;
			}),
		);
		await ready.promise;
		const input = {
			do: action,
			project: "scratch",
			...(team ? { team: "late-team" } : { actor: "late-actor" }),
			...(action.endsWith(".set") ? { can: ["read"] } : {}),
		};
		const actor = team ? await h.actor("late-actor", "human", []) : null;
		const created = barrier();
		const commitCreation = barrier();
		const creating = h.app.database.write((db) =>
			db.transaction(async () => {
				await lockIdentity(db);
				if (actor) await lockActors(db, [actor.id], true);
				await db.allDynamic("SELECT id FROM orgs ORDER BY id FOR NO KEY UPDATE");
				if (team && actor) {
					const made = await db.one(
						sql<{ at: number }, { id: number }>(
							"INSERT INTO teams (org, name, created_at) VALUES ((SELECT id FROM orgs ORDER BY id LIMIT 1), 'late-team', $at) RETURNING id",
						),
						{ at: h.app.now() },
					);
					await db.run(
						sql<{ team: number; actor: number }>("INSERT INTO team_members (team, actor) VALUES ($team, $actor)"),
						{ team: made.id, actor: actor.id },
					);
				} else {
					await createToken(
						h.app,
						{ actor: "late-actor", kind: "human", can: [], project: 0, label: "late" },
						null,
						db,
					);
				}
				created.resolve();
				await commitCreation.promise;
			}),
		);
		await created.promise;
		const changing = invoke(h.app, OPS, { op: "admin", project: null, input, actor: async () => h.owner });
		let following: Promise<void> | undefined;
		try {
			await blocked();
			commitCreation.resolve();
			await creating;
			const current = await h.app.database.read((db) => actorByName(db, "late-actor", 0));
			if (!current) throw new Error("late actor was not committed");
			following = h.app.database.write((db) =>
				db.transaction(async () => {
					await lockActors(db, [current.id], true);
					await lockProject(db, 1);
				}),
			);
			void following.catch(() => {});
			await blocked();
		} finally {
			commitCreation.resolve();
			release.resolve();
			await creating;
		}
		const reply = await changing;
		const completions = await Promise.allSettled([holding, following]);
		expect(completions.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
		expect(states).toEqual([]);
		expect(reply.ok).toBe(true);
		const table = team ? "team_grants" : "grants";
		expect(await h.app.database.read((db) => db.allDynamic(`SELECT can FROM ${table} WHERE project = 1`))).toEqual(
			action.endsWith(".set") ? [{ can: '["read"]' }] : [],
		);
		const retry = await invoke(h.app, OPS, { op: "admin", project: null, input, actor: async () => h.owner });
		expect(retry.ok).toBe(true);
	});
}

for (const op of ["admin", "invitation"] as const) {
	test(`new actors wait for identity before taking the project for ${op}`, async () => {
		h = await harness();
		const ready = barrier();
		const release = barrier();
		const holding = h.app.database.write((db) =>
			db.transaction(async () => {
				await lockIdentity(db);
				ready.resolve();
				await release.promise;
			}),
		);
		await ready.promise;
		const input =
			op === "admin"
				? { do: "token.create", actor: "new-person", kind: "human", can: ["read"], project: "scratch" }
				: { do: "create", name: "new-person", can: ["read"], project: "scratch" };
		const changing = invoke(h.app, OPS, { op, project: null, input, actor: async () => h.owner });
		try {
			await blocked();
			// This independent project writer must be able to proceed while roster creation waits.
			await h.app.database.write((db) =>
				db.transaction(async () => {
					await db.allDynamic("SELECT id FROM projects WHERE id = 1 FOR UPDATE NOWAIT");
				}),
			);
		} finally {
			release.resolve();
			await holding;
			await changing;
		}
		expect((await changing).ok).toBe(true);
	});
}

/** Pause after discovery, before the real transaction acquires its actor locks. */
function pauseNextBegin() {
	const reached = barrier();
	const release = barrier();
	const write = h.app.database.write.bind(h.app.database);
	let first = true;
	h.app.database.write = (work, options) =>
		write(async (db) => {
			if (first) {
				first = false;
				const begin = db.begin.bind(db);
				db.begin = async () => {
					reached.resolve();
					await release.promise;
					await begin();
				};
			}
			return work(db);
		}, options);
	return {
		reached: reached.promise,
		release: () => release.resolve(),
		restore: () => {
			h.app.database.write = write;
		},
	};
}

test("invitation acceptance retries a lower session actor discovered inside commit", async () => {
	h = await harness();
	const invited = await invoke(h.app, OPS, {
		op: "invitation",
		project: null,
		input: { do: "create", name: "joining" },
		actor: async () => h.owner,
	});
	if (!invited.ok) throw new Error("invitation refused");
	const { code } = z.object({ code: z.string() }).parse(invited.result);
	const token = await createToken(h.app, { actor: h.owner.name, kind: "human", can: [], project: 0, label: "browser" });
	const browser = "session-that-appears-after-discovery";
	const paused = pauseNextBegin();
	const accepting = acceptInvitation(
		h.app,
		{
			code,
			password: "correct horse battery staple",
			passkey: undefined,
			label: undefined,
			replace: h.owner.name,
			browser,
		},
		{ userAgent: null, address: null },
	);
	// Keep rejection observed while the other connection commits the new session.
	const outcome = accepting.then(
		(value) => ({ value, error: null }),
		(error: unknown) => ({ value: null, error }),
	);
	try {
		await paused.reached;
		await h.app.database.write((db) =>
			db.transaction(async () => {
				await openSession(h.app, db, {
					tokenHash: hashToken(token.secret),
					sessionHash: hashToken(browser),
					userAgent: null,
					address: null,
				});
			}),
		);
	} finally {
		paused.release();
		paused.restore();
	}
	const result = await outcome;
	expect(result.error).toBeInstanceOf(Busy);
	expect(await h.app.database.read((db) => db.allDynamic("SELECT used_at FROM invitations"))).toEqual([
		{ used_at: null },
	]);
	expect(await h.app.database.read((db) => db.allDynamic("SELECT id FROM credentials"))).toEqual([]);
	expect(await findSession(h.app, hashToken(browser))).not.toBeNull();
});

test("OIDC sign-in retries an actor first discovered inside commit", async () => {
	h = await harness();
	const idp = await provider({ subject: "late-link" });
	h.app.config.publicUrl = "https://mainworthy.example";
	h.app.config.oidc = idp.config();
	try {
		const begun = await beginOidcSignIn(h.app, { purpose: "sign-in" }, null);
		if (!begun.ok) throw new Error("OIDC ceremony refused");
		const authorized = await fetch(begun.url, { redirect: "manual" });
		const query = new URL(authorized.headers.get("location") ?? "").search;
		const paused = pauseNextBegin();
		const signing = finishOidcSignIn(
			h.app,
			{ query, ceremony: begun.ceremony, browser: null },
			{ userAgent: null, address: null },
		);
		const outcome = signing.then(
			(value) => ({ value, error: null }),
			(error: unknown) => ({ value: null, error }),
		);
		try {
			await paused.reached;
			await h.app.database.write((db) =>
				db.transaction(async () => {
					await insertOidc(db, {
						actor: h.owner.id,
						handle: oidcHandle({ issuer: idp.issuer, subject: "late-link" }),
						label: "provider",
						at: h.app.now(),
					});
				}),
			);
		} finally {
			paused.release();
			paused.restore();
		}
		expect((await outcome).error).toBeInstanceOf(Busy);
		expect(await h.app.database.read((db) => db.allDynamic("SELECT id FROM sessions"))).toEqual([]);
	} finally {
		idp.stop();
	}
});

test("credential locks follow parsed passkey input at their final strength", async () => {
	h = await harness();
	const unrelated = await h.actor("unrelated", "human", []);
	const credential = defineInstanceOp({
		name: "credential",
		summary: "probe credential locks",
		scope: "instance",
		effect: "write",
		needs: "self",
		mcp: null,
		input: CredentialInput,
		output: z.boolean(),
		async run() {
			let callerExclusive = false;
			try {
				await h.app.database.write((db) =>
					db.transaction(async () => {
						await db.allDynamic("SELECT id FROM actors WHERE id = $1 FOR SHARE NOWAIT", [h.owner.id]);
					}),
				);
			} catch (error) {
				if (!isBusy(error)) throw error;
				callerExclusive = true;
			}
			await h.app.database.write((db) =>
				db.transaction(async () => {
					await db.allDynamic("SELECT id FROM actors WHERE id = $1 FOR UPDATE NOWAIT", [unrelated.id]);
				}),
			);
			return callerExclusive;
		},
	});
	const reply = await invoke(
		h.app,
		{ credential },
		{
			op: "credential",
			project: null,
			input: { do: "passkey.add", passkey: {}, label: "key", actor: "unrelated" },
			actor: async () => h.owner,
		},
	);
	expect(reply).toMatchObject({ ok: true, result: true });
});

import { CONTEXT } from "../src/server/identity/contexts.ts";
import { insertPassword, insertTotp } from "../src/server/identity/credentials.ts";
import { hashPassword } from "../src/server/identity/passwords.ts";
import {
	passkeySignInOptions,
	showInvitation,
	signInWithPasskey,
	signInWithPassword,
	signInWithTotp,
} from "../src/server/identity/people.ts";
import { issueTotp, newTotpSecret, secretHash, totpCode } from "../src/server/identity/totp.ts";
import { authenticator } from "./people-support.ts";

for (const method of ["password", "totp"] as const) {
	test(
		method === "password"
			? "password sign-in retries when a name resolves to an unlocked actor inside commit"
			: "TOTP sign-in refuses credentials moved away from its bound actor inside commit",
		async () => {
			h = await harness();
			const person = await h.actor("signer", "human", []);
			const password = "correct horse battery staple";
			const hash = await hashPassword(password, { memoryCost: 1024, timeCost: 1 });
			h.app.config.passwordCost = { memoryCost: 1024, timeCost: 1 };
			const secret = newTotpSecret();
			const factor = await h.app.database.write((db) =>
				db.transaction(async () => {
					await insertPassword(db, { actor: person.id, hash, at: h.app.now() });
					return await insertTotp(db, {
						actor: person.id,
						data: JSON.stringify({ secret, lastStep: -1, recovery: [] }),
						at: h.app.now(),
					});
				}),
			);
			const ceremony = "totp-browser";
			const challenge = await issueTotp(h.app, {
				kind: "sign-in",
				actor: person.id,
				password: hash,
				factor,
				context: CONTEXT.browser(secretHash(ceremony)),
			});
			// Password sign-in must reach its password branch rather than start a second-factor ceremony.
			if (method === "password")
				await h.app.database.write((db) =>
					db.transaction(async () => {
						await db.run(sql<{ id: number }>("DELETE FROM credentials WHERE id = $id"), { id: factor });
					}),
				);
			const paused = pauseNextBegin();
			const pending =
				method === "password"
					? signInWithPassword(h.app, { name: person.name, password }, { userAgent: null, address: null })
					: signInWithTotp(
							h.app,
							{ challenge: challenge.challenge, ceremony, code: totpCode(secret, Math.floor(h.app.now() / 30_000)) },
							{ userAgent: null, address: null },
						);
			const outcome = pending.then(
				(value) => ({ value, error: null }),
				(error: unknown) => ({ value: null, error }),
			);
			try {
				await paused.reached;
				// An instance restore can replace the actor behind a name while preserving credential data.
				await h.app.database.write((db) =>
					db.transaction(async () => {
						await lockActors(db, [h.owner.id, person.id], true);
						await db.run(sql<{ id: number }>("UPDATE actors SET name = 'former-signer' WHERE id = $id"), {
							id: person.id,
						});
						await db.run(sql<{ id: number }>("UPDATE actors SET name = 'signer' WHERE id = $id"), { id: h.owner.id });
						await db.run(sql<{ from: number; to: number }>("UPDATE credentials SET actor = $to WHERE actor = $from"), {
							from: person.id,
							to: h.owner.id,
						});
					}),
				);
			} finally {
				paused.release();
				paused.restore();
			}
			const result = await outcome;
			if (method === "password") expect(result.error).toBeInstanceOf(Busy);
			else {
				expect(result.error).toBeNull();
				expect(result.value).toEqual({ ok: false, why: "changed-meanwhile" });
			}
			expect(await h.app.database.read((db) => db.allDynamic("SELECT id FROM sessions"))).toEqual([]);
		},
	);
}

test("passkey sign-in retries when the credential resolves to an unlocked actor inside commit", async () => {
	h = await harness();
	h.app.config.publicUrl = "https://mainworthy.example";
	const invited = await invoke(h.app, OPS, {
		op: "invitation",
		project: null,
		input: { do: "create", name: "signer" },
		actor: async () => h.owner,
	});
	if (!invited.ok) throw new Error("invitation refused");
	const { code } = z.object({ code: z.string() }).parse(invited.result);
	const shown = await showInvitation(h.app, code, null);
	if (!shown.ok || !shown.shown.passkey) throw new Error("passkey registration unavailable");
	const device = authenticator();
	const accepted = await acceptInvitation(
		h.app,
		{
			code,
			password: undefined,
			passkey: device.register(shown.shown.passkey),
			label: "key",
			replace: null,
			browser: null,
		},
		{ userAgent: null, address: null },
	);
	if (!accepted.ok) throw new Error("passkey invitation refused");
	const person = await h.app.database.read((db) => actorByName(db, "signer", 0));
	if (!person) throw new Error("no signer");
	const begun = await passkeySignInOptions(h.app, null);
	if (!begun || !("options" in begun)) throw new Error("passkey sign-in unavailable");
	const paused = pauseNextBegin();
	const pending = signInWithPasskey(
		h.app,
		{ answer: device.assert(begun.options), ceremony: begun.ceremony },
		{ userAgent: null, address: null },
	);
	const outcome = pending.then(
		(value) => ({ value, error: null }),
		(error: unknown) => ({ value: null, error }),
	);
	try {
		await paused.reached;
		await h.app.database.write((db) =>
			db.transaction(async () => {
				await lockActors(db, [h.owner.id, person.id], true);
				await db.run(sql<{ from: number; to: number }>("UPDATE credentials SET actor = $to WHERE actor = $from"), {
					from: person.id,
					to: h.owner.id,
				});
				await db.run(sql<{ from: number; to: number }>("UPDATE passkey_users SET actor = $to WHERE actor = $from"), {
					from: person.id,
					to: h.owner.id,
				});
			}),
		);
	} finally {
		paused.release();
		paused.restore();
	}
	expect((await outcome).error).toBeInstanceOf(Busy);
	expect(await h.app.database.read((db) => db.allDynamic("SELECT actor FROM sessions"))).toEqual([
		{ actor: person.id },
	]);
});

import { adminOp } from "../src/server/ops/admin.ts";

for (const target of ["actor", "team"] as const) {
	test(`a missing ${target} stays absent between project footprint checks and the operation`, async () => {
		h = await harness();
		const reached = barrier();
		const release = barrier();
		if (adminOp.effect !== "write") throw new Error("admin must be a write");
		const run = adminOp.run;
		const admin = defineInstanceOp({
			...adminOp,
			async run(env: Parameters<typeof run>[0], input: Parameters<typeof run>[1]) {
				reached.resolve();
				await release.promise;
				return await run(env, input);
			},
		});
		const input =
			target === "actor"
				? { do: "grant.set", actor: "late-target", project: "scratch", can: ["read"] }
				: { do: "team.grant.set", team: "late-target", project: "scratch", can: ["read"] };
		const changing = invoke(h.app, { admin }, { op: "admin", project: null, input, actor: async () => h.owner });
		await reached.promise;
		const creating =
			target === "actor"
				? h.actor("late-target", "human", [])
				: h.call("admin", { do: "team.create", name: "late-target" });
		try {
			const waited = await Promise.race([creating.then(() => false), blocked().then(() => true)]);
			expect(waited).toBe(true);
		} finally {
			release.resolve();
			await creating;
			await changing;
		}
		expect(await changing).toMatchObject({ ok: false, error: { code: "not_found" } });
		expect((await invoke(h.app, OPS, { op: "admin", project: null, input, actor: async () => h.owner })).ok).toBe(true);
	});
}

import { forgetActor } from "../src/server/identity/identity.ts";
import { credentialOp, invitationOp } from "../src/server/ops/people.ts";

function observeLockErrors() {
	const states: string[] = [];
	const write = h.app.database.write.bind(h.app.database);
	async function observe<T>(query: () => Promise<T>): Promise<T> {
		try {
			return await query();
		} catch (error) {
			const state = sqlState(error);
			if (state) states.push(state);
			throw error;
		}
	}
	h.app.database.write = (work, options) =>
		write(async (db) => {
			const all = db.all.bind(db);
			const get = db.get.bind(db);
			const one = db.one.bind(db);
			const run = db.run.bind(db);
			db.all = (statement, ...params) => observe(() => all(statement, ...params));
			db.get = (statement, ...params) => observe(() => get(statement, ...params));
			db.one = (statement, ...params) => observe(() => one(statement, ...params));
			db.run = (statement, ...params) => observe(() => run(statement, ...params));
			return work(db);
		}, options);
	return {
		states,
		restore: () => {
			h.app.database.write = write;
		},
	};
}

function pauseIdentityOp<I, O>(
	op: InstanceOp<I, O>,
	reached: ReturnType<typeof barrier>,
	resume: ReturnType<typeof barrier>,
) {
	if (op.effect !== "write") throw new Error("identity operations must write");
	const run = op.run;
	return defineInstanceOp<I, O>({
		...op,
		async run(env: Parameters<typeof run>[0], input: I) {
			reached.resolve();
			await resume.promise;
			return await run(env, input);
		},
	});
}

for (const op of ["admin", "invitation"] as const) {
	test(`a name forgotten during discovery cannot invert org and project locks for ${op}`, async () => {
		h = await harness();
		await h.actor("vanishing", "human", []);
		const errors = observeLockErrors();
		const forgotten = barrier();
		const commitForget = barrier();
		const forgetting = h.app.database.write((db) =>
			db.transaction(async () => {
				await forgetActor(h.app, db, "vanishing");
				forgotten.resolve();
				await commitForget.promise;
			}),
		);
		await forgotten.promise;
		const reached = barrier();
		const resume = barrier();
		const paused =
			op === "admin" ? pauseIdentityOp(adminOp, reached, resume) : pauseIdentityOp(invitationOp, reached, resume);
		const input =
			op === "admin"
				? { do: "token.create", actor: "vanishing", kind: "human", project: "scratch", can: ["read"] }
				: { do: "create", name: "vanishing", project: "scratch", can: ["read"] };
		const changing = invoke(h.app, { [op]: paused }, { op, project: null, input, actor: async () => h.owner });
		let competing: Promise<unknown> | undefined;
		try {
			await blocked();
			commitForget.resolve();
			await forgetting;
			await reached.promise;
			competing = h.app.database.write((db) =>
				db.transaction(async () => {
					await createToken(
						h.app,
						{ actor: "other-new-person", kind: "human", project: 0, can: [], label: "other" },
						null,
						db,
					);
					await lockProject(db, 1);
				}),
			);
			void competing.catch(() => {});
			await blocked();
		} finally {
			commitForget.resolve();
			resume.resolve();
			await forgetting;
		}
		const reply = await changing;
		const settled = await Promise.allSettled([competing]);
		errors.restore();
		expect(errors.states).not.toContain("40P01");
		expect(settled.map((result) => result.status)).toEqual(["fulfilled"]);
		expect(reply.ok).toBe(true);
		expect(await h.app.database.read((db) => actorByName(db, "vanishing", 1))).toMatchObject({ can: ["read"] });
	});
}

for (const kind of ["token", "credential"] as const) {
	test(`an id appearing after discovery cannot acquire a late owner lock for ${kind}`, async () => {
		h = await harness();
		const caller = await h.actor("administrator", "human", ["admin"]);
		const owner = h.owner;
		if (kind === "credential")
			await h.app.database.write((db) =>
				db.transaction(() => insertPassword(db, { actor: owner.id, hash: "unused", at: h.app.now() })),
			);
		const table = kind === "token" ? "tokens" : "credentials";
		const next = await h.app.database.read((db) =>
			db.allDynamic<{ id: number }>(`SELECT coalesce(max(id), 0) + 1 AS id FROM ${table}`),
		);
		const id = next[0]?.id;
		if (!id) throw new Error("missing next fixture id");
		const errors = observeLockErrors();
		const reached = barrier();
		const resume = barrier();
		const paused =
			kind === "token" ? pauseIdentityOp(adminOp, reached, resume) : pauseIdentityOp(credentialOp, reached, resume);
		const op = paused.name;
		const input = { do: kind === "token" ? "token.revoke" : "remove", id };
		const changing = invoke(
			h.app,
			{ [op]: paused },
			{ op, project: null, input, actor: async () => caller, context: async () => CONTEXT.local },
		);
		await reached.promise;
		const competing = (async () => {
			const made =
				kind === "token"
					? await createToken(h.app, { actor: owner.name, kind: "human", can: [], project: 0, label: "late" })
					: await h.app.database.write((db) =>
							db.transaction(() =>
								insertOidc(db, {
									actor: owner.id,
									handle: "https://provider.example#late",
									label: "late",
									at: h.app.now(),
								}),
							),
						);
			if (made.id !== id) throw new Error("the competing operation did not create the predicted fixture id");
			await h.app.database.write((db) =>
				db.transaction(async () => {
					await lockActors(db, [owner.id], true);
					await lockActors(db, [caller.id], true);
				}),
			);
		})();
		void competing.catch(() => {});
		try {
			await blocked();
		} finally {
			resume.resolve();
		}
		const reply = await changing;
		const settled = await Promise.allSettled([competing]);
		errors.restore();
		expect(errors.states).not.toContain("40P01");
		expect(settled.map((result) => result.status)).toEqual(["fulfilled"]);
		if (kind === "token") expect(reply).toMatchObject({ ok: true, result: { revoked: false } });
		else expect(reply).toMatchObject({ ok: false, error: { code: "not_found" } });
		const column = "revoked_at";
		expect(
			await h.app.database.read((db) => db.allDynamic(`SELECT ${column} FROM ${table} WHERE id = $1`, [id])),
		).toEqual([{ [column]: null }]);
	});
}

for (const rollback of [false, true]) {
	test(`every instance writer waits before actor locking and identity ${rollback ? "rollback" : "commit"} permits project writes`, async () => {
		h = await harness();
		const held = barrier();
		const release = barrier();
		const sentinel = new Error("roll back the identity transaction");
		const holding = h.app.database
			.write((db) =>
				db.transaction(async () => {
					await lockIdentity(db);
					held.resolve();
					await release.promise;
					if (rollback) throw sentinel;
				}),
			)
			.catch((error: unknown) => {
				if (error !== sentinel) throw error;
			});
		await held.promise;
		let ran = false;
		const instance = defineInstanceOp({
			name: "future-identity-operation",
			summary: "an instance writer outside the known identity operation names",
			scope: "instance",
			effect: "write",
			needs: "admin",
			mcp: null,
			input: z.object({}),
			output: z.boolean(),
			run() {
				ran = true;
				return true;
			},
		});
		const waiting = invoke(
			h.app,
			{ instance },
			{ op: "instance", project: null, input: {}, actor: async () => h.owner },
		);
		try {
			await blocked();
			expect(ran).toBe(false);
			// A queued identity request must not own its caller's row yet.
			await h.app.database.write((db) =>
				db.transaction(async () => {
					await db.allDynamic("SELECT id FROM actors WHERE id = $1 FOR UPDATE NOWAIT", [h.owner.id]);
				}),
			);
			const project = defineOp({
				...probeBase,
				run(ctx: Ctx) {
					return ctx.seq;
				},
			});
			expect(
				(
					await invoke(
						h.app,
						{ project },
						{ op: "project", project: "scratch", input: { index: 0 }, actor: async () => h.owner },
					)
				).ok,
			).toBe(true);
		} finally {
			release.resolve();
			await holding;
			await waiting;
		}
		expect(await waiting).toMatchObject({ ok: true, result: true });
	});
}

for (const path of ["assignment", "adoption", "placement", "trigger"] as const) {
	test(`project foreign keys do not deadlock a waiting authority change: ${path}`, async () => {
		h = await harness();
		await h.call("propose", { edits: [{ op: "create", body: { title: "Existing case" } }] });
		const target = await h.actor("referenced", path === "assignment" || path === "trigger" ? "human" : "agent", [
			"read",
			"produce",
		]);
		const writer = await h.actor("writer", "human", ["read", "produce", "plan", "answer"]);
		let input: unknown = { name: "Assigned run", select: {}, assign: [target.name] };
		const planning = path === "assignment" || path === "trigger";
		if (!planning) {
			await h.call("propose", { edits: [{ op: "policy", preset: "strict" }] });
			const policy = (await h.call<{ items: { q: string; evidenceHash: string }[] }>("inbox", { kind: "adopt" }))
				.items[0];
			if (!policy) throw new Error("missing policy question");
			await h.call("decide", {
				q: policy.q,
				onEvidence: policy.evidenceHash,
				answer: { is: "accept" },
				reason: "Require review",
			});
			await h.call(
				"propose",
				{
					edits: [
						path === "adoption"
							? { op: "create", body: { title: "Proposed case" } }
							: { op: "place", cases: ["C-1"], tags: { add: ["moved"] } },
					],
				},
				target,
			);
			const question = (await h.call<{ items: { q: string; evidenceHash: string }[] }>("inbox", { kind: "adopt" }))
				.items[0];
			if (!question) throw new Error("missing adoption question");
			input = { q: question.q, onEvidence: question.evidenceHash, answer: { is: "accept" }, reason: "Reviewed" };
		}
		const reached = barrier();
		const resume = barrier();
		const op = planning ? planOp : decideOp;
		const paused = planning
			? defineOp({
					...planOp,
					effect: "write",
					async run(ctx: Ctx, data: Parameters<typeof planRun>[1]) {
						reached.resolve();
						await resume.promise;
						return await planRun(ctx, data);
					},
				})
			: defineOp({
					...decideOp,
					effect: "write",
					async *steps(ctx: Ctx, data: Parameters<typeof decideSteps>[1]) {
						reached.resolve();
						await resume.promise;
						return yield* decideSteps(ctx, data);
					},
				});
		const errors = observeLockErrors();
		const writing = invoke(
			h.app,
			{ [op.name]: paused },
			{ op: op.name, project: "scratch", input, actor: async () => writer },
		);
		await reached.promise;
		const changing =
			path === "trigger"
				? h.app.database.write((db) =>
						db.transaction(async () => {
							await lockIdentity(db);
							await db.run(
								sql<{ actor: number }>(
									'UPDATE grants SET can = \'["read","produce","answer"]\' WHERE actor = $actor AND project = 0',
								),
								{ actor: target.id },
							);
							await lockProject(db, 1);
							return { ok: true };
						}),
					)
				: h.raw("admin", {
						do: "grant.set",
						actor: target.name,
						project: "scratch",
						can: ["read", "produce", "answer"],
					});
		void changing.catch(() => {});
		try {
			await blocked();
		} finally {
			resume.resolve();
		}
		const settled = await Promise.allSettled([writing, changing]);
		errors.restore();
		expect(errors.states).not.toContain("40P01");
		expect(settled.map((result) => result.status === "fulfilled" && result.value.ok)).toEqual([true, true]);
		const stored = await h.app.database.read((db) =>
			db.allDynamic(
				planning
					? "SELECT assignee AS actor FROM slots"
					: path === "adoption"
						? "SELECT author AS actor FROM versions WHERE case_id = (SELECT max(id) FROM cases) ORDER BY no DESC LIMIT 1"
						: "SELECT actor FROM placements ORDER BY id DESC LIMIT 1",
			),
		);
		expect(stored).toEqual([{ actor: target.id }]);
	});
}

import { decideOp, decideSteps, planOp, planRun } from "../src/server/ops/writes.ts";

test("an unrelated sign-in finishes while a grant change waits for a project", async () => {
	h = await harness();
	await h.actor("grant-target", "human", ["read"]);
	const token = await createToken(h.app, { actor: h.owner.name, kind: "human", can: [], project: 0, label: "sign-in" });
	const reached = barrier();
	const resume = barrier();
	const holding = h.app.database.write((db) =>
		db.transaction(async () => {
			await lockProject(db, 1);
			reached.resolve();
			await resume.promise;
		}),
	);
	await reached.promise;
	const changing = h.raw("admin", { do: "grant.set", actor: "grant-target", project: "scratch", can: ["read"] });
	await blocked();
	const signingIn = (async () => {
		const opened = await signInWithToken(h.app, token.secret, { userAgent: null, address: null });
		return opened.kind === "opening" ? await opened.signedIn : null;
	})();
	try {
		const result = await Promise.race([
			signingIn,
			new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000)),
		]);
		expect(result).not.toBeNull();
	} finally {
		resume.resolve();
		await Promise.all([holding, changing, signingIn]);
	}
	expect(await h.app.database.read((db) => db.allDynamic("SELECT actor FROM sessions"))).toEqual([
		{ actor: h.owner.id },
	]);
});

for (const ownSession of [false, true]) {
	test(`session end refuses an id absent at discovery when sign-in creates it for ${ownSession ? "the caller" : "another actor"}`, async () => {
		h = await harness();
		const caller = await h.actor("administrator", "human", ["admin"]);
		const owner = ownSession ? caller : h.owner;
		const token = await createToken(h.app, { actor: owner.name, kind: "human", can: [], project: 0, label: "late" });
		const reached = barrier();
		const resume = barrier();
		const write = h.app.database.write.bind(h.app.database);
		let first = true;
		h.app.database.write = (work, options) =>
			write(async (db) => {
				if (first) {
					first = false;
					const all = db.all.bind(db);
					db.all = async (statement, ...params) => {
						const rows = await all(statement, ...params);
						if (statement.text === "SELECT actor AS id FROM sessions WHERE id = $1") {
							reached.resolve();
							await resume.promise;
						}
						return rows;
					};
				}
				return await work(db);
			}, options);
		const ending = h.raw("session", { do: "end", id: 1 }, caller);
		await reached.promise;
		try {
			const opened = await signInWithToken(h.app, token.secret, { userAgent: null, address: null });
			expect(opened.kind).toBe("opening");
			if (opened.kind === "opening") expect(await opened.signedIn).not.toBeNull();
		} finally {
			resume.resolve();
			h.app.database.write = write;
			await ending;
		}
		expect(await ending).toMatchObject({ ok: false, error: { code: "not_found" } });
		expect(await h.app.database.read((db) => db.allDynamic("SELECT id, actor, ended_at FROM sessions"))).toEqual([
			{ id: 1, actor: owner.id, ended_at: null },
		]);
	});
}

for (const method of ["password", "legacy password", "totp", "passkey", "oidc"] as const) {
	test(`${method} sign-in commits outside an unrelated waiting grant's identity lock`, async () => {
		h = await harness();
		h.app.config.publicUrl = "https://mainworthy.example";
		h.app.config.passwordCost = { memoryCost: 1024, timeCost: 1 };
		const signer = await h.actor("signer", "human", []);
		await h.actor("grant-target", "human", ["read"]);
		const idp = method === "oidc" ? await provider({ subject: "signer" }) : null;
		let signIn: () => Promise<unknown>;
		try {
			if (method === "passkey") {
				const invitation = await invoke(h.app, OPS, {
					op: "invitation",
					project: null,
					input: { do: "create", name: signer.name },
					actor: async () => h.owner,
				});
				if (!invitation.ok) throw new Error("invitation refused");
				const invited = z.object({ code: z.string() }).parse(invitation.result);
				const shown = await showInvitation(h.app, invited.code, null);
				if (!shown.ok || !shown.shown.passkey) throw new Error("registration unavailable");
				const device = authenticator();
				const joined = await acceptInvitation(
					h.app,
					{
						code: invited.code,
						password: undefined,
						passkey: device.register(shown.shown.passkey),
						label: "key",
						replace: null,
						browser: null,
					},
					{ userAgent: null, address: null },
				);
				if (!joined.ok) throw new Error("registration refused");
				const begun = await passkeySignInOptions(h.app, null);
				if (!begun || !("options" in begun)) throw new Error("sign-in unavailable");
				signIn = () =>
					signInWithPasskey(
						h.app,
						{ answer: device.assert(begun.options), ceremony: begun.ceremony },
						{ userAgent: null, address: null },
					);
			} else if (idp) {
				h.app.config.oidc = idp.config();
				await h.app.database.write((db) =>
					db.transaction(() =>
						insertOidc(db, {
							actor: signer.id,
							handle: oidcHandle({ issuer: idp.issuer, subject: "signer" }),
							label: "provider",
							at: h.app.now(),
						}),
					),
				);
				const begun = await beginOidcSignIn(h.app, { purpose: "sign-in" }, null);
				if (!begun.ok) throw new Error("OIDC unavailable");
				const authorized = await fetch(begun.url, { redirect: "manual" });
				const query = new URL(authorized.headers.get("location") ?? "").search;
				signIn = () =>
					finishOidcSignIn(
						h.app,
						{ query, ceremony: begun.ceremony, browser: null },
						{ userAgent: null, address: null },
					);
			} else {
				const password =
					method === "legacy password" ? "Cafe\u0301 correct horse battery staple" : "correct horse battery staple";
				const hash =
					method === "legacy password"
						? await Bun.password.hash(password, { algorithm: "argon2id", ...h.app.config.passwordCost })
						: await hashPassword(password, h.app.config.passwordCost);
				await h.app.database.write((db) =>
					db.transaction(() => insertPassword(db, { actor: signer.id, hash, at: h.app.now() })),
				);
				if (method === "totp") {
					const secret = newTotpSecret();
					const factor = await h.app.database.write((db) =>
						db.transaction(() =>
							insertTotp(db, {
								actor: signer.id,
								data: JSON.stringify({ secret, lastStep: -1, recovery: [] }),
								at: h.app.now(),
							}),
						),
					);
					const ceremony = "sign-in-browser";
					const challenge = await issueTotp(h.app, {
						kind: "sign-in",
						actor: signer.id,
						password: hash,
						factor,
						context: CONTEXT.browser(secretHash(ceremony)),
					});
					signIn = () =>
						signInWithTotp(
							h.app,
							{ challenge: challenge.challenge, code: totpCode(secret, Math.floor(h.app.now() / 30_000)), ceremony },
							{ userAgent: null, address: null },
						);
				} else
					signIn = () => signInWithPassword(h.app, { name: signer.name, password }, { userAgent: null, address: null });
			}
			const reached = barrier();
			const resume = barrier();
			const holding = h.app.database.write((db) =>
				db.transaction(async () => {
					await lockProject(db, 1);
					reached.resolve();
					await resume.promise;
				}),
			);
			await reached.promise;
			const changing = h.raw("admin", { do: "grant.set", actor: "grant-target", project: "scratch", can: ["read"] });
			await blocked();
			const signingIn = signIn();
			try {
				const result = await Promise.race([
					signingIn,
					new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000)),
				]);
				expect(result).toMatchObject({ ok: true, signedIn: { cookie: expect.any(String) } });
			} finally {
				resume.resolve();
				await Promise.all([holding, changing, signingIn]);
			}
			expect(
				await h.app.database.read((db) =>
					db.allDynamic("SELECT count(*) AS n FROM sessions WHERE actor = $1", [signer.id]),
				),
			).toEqual([{ n: method === "passkey" ? 2 : 1 }]);
		} finally {
			idp?.stop();
		}
	});
}

test("busy during report application rolls back partial results and leaves acceptance for recovery", async () => {
	h = await harness();
	await h.call("admin", { do: "project.create", key: "held" });
	const held = await h.app.database.read((db) =>
		db.allDynamic<{ id: number }>("SELECT id FROM projects WHERE key = 'held'"),
	);
	const other = held[0];
	if (!other) throw new Error("missing held project");
	const acquired = barrier();
	const release = barrier();
	const holder = h.app.database.write((db) =>
		db.transaction(async () => {
			await lockProject(db, other.id);
			acquired.resolve();
			await release.promise;
		}),
	);
	await acquired.promise;
	const short = await Database.open({ url: h.app.config.databaseUrl, lockWaitMs: 30 });
	let partial = 0;
	const op = defineOp({
		...reportOp,
		effect: "write",
		async *steps(ctx: Ctx, input: ReportInput) {
			for await (const pause of reportSteps(ctx, input)) {
				if (pause === undefined) {
					partial = (await ctx.db.allDynamic<{ n: number }>("SELECT count(*) AS n FROM results"))[0]?.n ?? 0;
					if (partial > 0) await lockProject(ctx.db, other.id);
				}
				yield pause;
			}
			throw new Error("application must encounter the held lock");
		},
	});
	try {
		const reply = await invoke(
			{ ...h.app, database: short },
			{ ...OPS, report: op },
			{
				op: "report",
				project: "scratch",
				actor: async () => h.owner,
				input: { ...ciReport({ commit: "partial-busy", n: 201 }), cmd: "partial-busy-report" },
			},
		);
		expect(partial).toBeGreaterThan(0);
		expect(reply).toMatchObject({
			ok: true,
			result: { results: [], counts: { total: 0 }, gate: { verdict: "pending" } },
		});
		expect(await h.app.database.read((db) => db.allDynamic("SELECT count(*) AS n FROM results"))).toEqual([{ n: 0 }]);
		expect(await h.app.database.read((db) => db.allDynamic("SELECT outcome FROM commands"))).toEqual([{ outcome: "" }]);
		expect(await h.app.database.read((db) => db.allDynamic("SELECT state, receipt FROM batches"))).toEqual([
			{ state: "accepted", receipt: null },
		]);
	} finally {
		release.resolve();
		await holder;
		await short.close();
	}
	expect(await recoverAccepted(h.app)).toBe(1);
	expect(await recoverAccepted(h.app)).toBe(0);
	expect(await h.app.database.read((db) => db.allDynamic("SELECT count(*) AS n FROM results"))).toEqual([{ n: 201 }]);
	expect(await h.app.database.read((db) => db.allDynamic("SELECT state FROM batches"))).toEqual([
		{ state: "processed" },
	]);
});

test("HTTP returns a successful pending receipt after report acceptance hits a lock timeout", async () => {
	h = await harness();
	await h.call("propose", { edits: [{ op: "create", body: { title: "HTTP accepted" } }] });
	await h.call("admin", { do: "project.create", key: "held" });
	const other = (
		await h.app.database.read((db) => db.allDynamic<{ id: number }>("SELECT id FROM projects WHERE key = 'held'"))
	)[0];
	if (!other || !("steps" in reportOp)) throw new Error("missing report fixture");
	const acquired = barrier();
	const release = barrier();
	const holder = h.app.database.write((db) =>
		db.transaction(async () => {
			await lockProject(db, other.id);
			acquired.resolve();
			await release.promise;
		}),
	);
	await acquired.promise;
	const steps = reportOp.steps;
	const paused = spyOn(reportOp, "steps").mockImplementation(async function* (ctx, input) {
		const iterator = steps(ctx, input);
		const first = await iterator.next();
		if (first.done) return first.value;
		yield first.value;
		await lockProject(ctx.db, other.id);
		return yield* iterator;
	});
	const short = await Database.open({ url: h.app.config.databaseUrl, lockWaitMs: 30 });
	const { serve } = await import("../src/surfaces/http.ts");
	const listener = serve({ ...h.app, database: short }, h.owner);
	try {
		const response = await fetch(`http://127.0.0.1:${listener.port}/api/p/scratch/report`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				target: { commit: "http-accepted-busy" },
				results: [{ test: { case: "C-1" }, outcome: "pass" }],
			}),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			ok: true,
			seq: 3,
			result: {
				batch: expect.any(Number),
				fresh: true,
				counts: { total: 0 },
				results: [],
				gate: { verdict: "pending", reason: "pending: report accepted; waiting for application" },
			},
		});
		expect(await h.app.database.read((db) => db.allDynamic("SELECT state, receipt FROM batches"))).toEqual([
			{ state: "accepted", receipt: null },
		]);
		const { runCli } = await import("../src/cli/dispatch.ts");
		const { inThisProcess } = await import("../src/cli/test-support.ts");
		const cli = await inThisProcess(
			"accepted report CLI",
			() =>
				runCli(
					[
						"report",
						"--url",
						`http://127.0.0.1:${listener.port}`,
						"--project",
						"scratch",
						"--json",
						JSON.stringify({
							target: { session: "CLI accepted busy" },
							results: [{ test: { case: "C-1" }, outcome: "pass" }],
						}),
					],
					null,
					{},
				),
			{ environment: {}, cwd: process.cwd(), input: "" },
		);
		expect(cli.code).toBe(0);
		expect(cli.stderr).toBe("");
		expect(JSON.parse(cli.stdout)).toMatchObject({
			results: [],
			gate: {
				verdict: "pending",
				reason: "pending: report accepted; waiting for application",
			},
		});
	} finally {
		paused.mockRestore();
		release.resolve();
		await holder;
		await listener.stop(true);
		await short.close();
	}
	expect(await recoverAccepted(h.app)).toBe(2);
	expect(await h.app.database.read((db) => db.allDynamic("SELECT count(*) AS n FROM results"))).toEqual([{ n: 2 }]);
});
for (const kind of ["token", "session"] as const) {
	test(`durable ${kind} activity locks its owner before taking credential rows`, async () => {
		h = await harness();
		const token = await createToken(h.app, {
			actor: "activity-person",
			kind: "human",
			can: ["read"],
			project: 0,
			label: "activity",
		});
		let id = token.id;
		let hash = hashToken(token.secret);
		if (kind === "session") {
			const { signInWithToken } = await import("../src/server/identity/identity.ts");
			const opening = await signInWithToken(h.app, token.secret, { userAgent: null, address: null });
			if (opening.kind !== "opening") throw new Error("no session");
			const signed = await opening.signedIn;
			if (!signed) throw new Error("no session");
			hash = hashToken(signed.cookie);
			const session = await h.app.database.read((db) =>
				db.allDynamic<{ id: number }>("SELECT id FROM sessions WHERE hash = $1", [hash]),
			);
			if (!session[0]) throw new Error("missing session");
			id = session[0].id;
		}
		h.advance(60_001);
		const entered = barrier();
		const release = barrier();
		const holding = h.app.database.write((db) =>
			db.transaction(async () => {
				if (kind === "session") await lockIdentity(db);
				else {
					const [person] = await db.allDynamic<{ id: number }>("SELECT id FROM actors WHERE name = 'activity-person'");
					if (!person) throw new Error("missing activity owner");
					await lockSignInActor(db, person.id);
				}
				entered.resolve();
				await release.promise;
			}),
		);
		await entered.promise;
		const { noteUse } = await import("../src/server/identity/uses.ts");
		const activity = noteUse(h.app, kind, id, h.app.now(), "192.0.2.50", hash);
		try {
			await blocked();
			await h.app.database.write((db) =>
				db.transaction(async () => {
					if (kind === "session")
						await db.allDynamic("SELECT id FROM actors WHERE name = 'activity-person' FOR UPDATE NOWAIT");
					await db.allDynamic(
						`SELECT id FROM ${kind === "token" ? "tokens" : "sessions"} WHERE id = $1 FOR UPDATE NOWAIT`,
						[id],
					);
				}),
			);
		} finally {
			release.resolve();
			await Promise.all([holding, activity]);
		}
		const column = kind === "token" ? "last_used_addr" : "last_seen_addr";
		expect(
			await h.app.database.read((db) =>
				db.allDynamic(`SELECT ${column} AS address FROM ${kind === "token" ? "tokens" : "sessions"} WHERE id = $1`, [
					id,
				]),
			),
		).toEqual([{ address: "192.0.2.50" }]);
	});
}
