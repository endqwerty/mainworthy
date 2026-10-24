import { expect, spyOn, test } from "bun:test";
import { z } from "zod";
import { budget } from "../../scripts/budget.ts";
import { removalFixture } from "../../test/demo-removal-fixture.ts";
import { API_VERSION, API_VERSION_HEADER } from "../core/version.ts";
import { Db, databasePath } from "../server/kernel/db.ts";
import { Client } from "./client.ts";
import { refreshDemo, resetDemoSteps } from "./demo.ts";
import { CliError } from "./errors.ts";
import { seed } from "./seed.ts";
import { withInstance } from "./test-support.ts";

// Three seeds a test at most: a small demo, and time for a machine that is busy with other tests.
const small = { cases: 30, unlinkedFiles: 2, days: 1 };
const SLOW = 20_000;
const Made = z.object({ id: z.number() });
const Tokens = z.array(
	z.object({
		id: z.number(),
		actor: z.string(),
		label: z.string(),
		expiresAt: z.number().nullable(),
		revoked: z.boolean(),
		expired: z.boolean(),
	}),
);
const Actors = z.array(
	z.object({
		name: z.string(),
		grants: z.array(z.object({ project: z.string(), can: z.array(z.string()), roles: z.array(z.string()).optional() })),
	}),
);
const grantsOf = async (client: Client, actor: string) =>
	Actors.parse(await client.call("admin", { do: "actor.list" })).find((row) => row.name === actor)?.grants;
const teamGrants = async (client: Client) =>
	z
		.array(z.object({ name: z.string(), grants: z.array(z.object({ project: z.string(), can: z.array(z.string()) })) }))
		.parse(await client.call("admin", { do: "team.list" }))
		.find((team) => team.name === "testers")?.grants;
const titles = async (client: Client, project: string) =>
	(await client.with({ project }).call("find", { limit: 500 })).items.map((item) => item.title);

for (const unrelated of [20, 20_000])
	test(`a reset uses no whole-database check under the lock with ${unrelated} unrelated results`, async () => {
		await withInstance(async ({ instance }) => {
			const { app, owner } = instance;
			removalFixture(app.db, 2, unrelated);
			const originalQuery = app.db.raw.query.bind(app.db.raw);
			let lockedScans = 0;
			const queries = spyOn(app.db.raw, "query").mockImplementation((...args) => {
				if (args[0] === "PRAGMA foreign_key_check" && app.db.inTransaction) lockedScans++;
				return originalQuery(...args);
			});
			const timings = new Map<string, number>();
			let beforeRemoval = -1;
			const steps = resetDemoSteps(app, owner, "removing", null, (step, ms) => {
				timings.set(step, ms);
				if (step === "discover tables") beforeRemoval = lockedScans;
			});
			try {
				expect(steps.next()).toEqual({ value: undefined, done: false });
				budget("scans under the reset lock before removal", beforeRemoval, 0, "scans");
				expect(app.db.raw.query("SELECT count(*) AS n FROM results WHERE project = 900").get()).toEqual({ n: 0 });
				expect(app.db.raw.query("SELECT count(*) AS n FROM results WHERE project = 901").get()).toEqual({
					n: unrelated,
				});
				expect(steps.next()).toEqual({ value: undefined, done: true });
				expect(app.db.raw.query("SELECT key FROM projects WHERE key = 'removing'").get()).toEqual({ key: "removing" });
				budget("scans under the reset lock", lockedScans, 0, "scans");
				for (const step of ["begin reset transaction", "defer reset foreign keys", "finish reset transaction"])
					expect(timings.get(step)).toBeNumber();
				expect(app.db.raw.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
			} finally {
				steps.return(undefined);
				queries.mockRestore();
			}
		});
	});

for (const fault of ["cross-project", "delete-trigger", "already-dangling"] as const) {
	test(`a reset rolls back on a ${fault} reference`, async () => {
		await withInstance(async ({ instance }) => {
			const { app, owner } = instance;
			removalFixture(app.db, 2);
			if (fault === "cross-project") app.db.exec("UPDATE results SET test = 900 WHERE project = 901");
			if (fault === "delete-trigger")
				app.db.exec(`CREATE TRIGGER bad_deletion AFTER DELETE ON tests WHEN OLD.id = 900 BEGIN
				UPDATE results SET test = OLD.id WHERE project = 901;
			END`);
			if (fault === "already-dangling")
				app.db.exec(
					"PRAGMA foreign_keys = OFF; UPDATE results SET test = 999999 WHERE project = 901; PRAGMA foreign_keys = ON",
				);
			const before = app.db.raw.serialize();
			const steps = resetDemoSteps(app, owner, "removing", null, () => {});
			try {
				expect(() => {
					for (const _ of steps) {
					}
				}).toThrow(/foreign key|FOREIGN KEY/);
				expect(
					app.db.raw.query("SELECT project, count(*) AS n FROM results GROUP BY project ORDER BY project").all(),
				).toEqual([
					{ project: 900, n: 2 },
					{ project: 901, n: 2 },
				]);
				expect(app.db.raw.serialize()).toEqual(before);
				expect(app.db.inTransaction).toBe(false);
				expect(app.db.raw.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
				expect(app.db.raw.query("PRAGMA defer_foreign_keys").get()).toEqual({ defer_foreign_keys: 0 });
			} finally {
				steps.return(undefined);
			}
		});
	});
}

test("a commit after the preflight makes the reset retry before removing anything", async () => {
	await withInstance(async ({ instance }) => {
		const { app, owner } = instance;
		removalFixture(app.db, 2);
		const version = app.db.foreignKeySnapshot();
		// The worker and HTTP server own different connections in production.
		const writer = new Db(databasePath(app.config.dataDir));
		try {
			writer.exec("UPDATE projects SET name = 'Changed while checking' WHERE id = 901");
		} finally {
			writer.close();
		}
		const steps = resetDemoSteps(app, owner, "removing", null, () => {}, version);
		expect(steps.next()).toEqual({ value: "stale", done: true });
		expect(app.db.raw.query("SELECT count(*) AS n FROM results WHERE project=900").get()).toEqual({ n: 2 });
		const retry = resetDemoSteps(app, owner, "removing", null, () => {});
		for (const _ of retry) {
		}
		expect(app.db.raw.query("SELECT count(*) AS n FROM results WHERE project=900").get()).toEqual({ n: 0 });
	});
});

test(
	"a project written to during every preflight is audited under the gate on the third round",
	async () => {
		await withInstance(async ({ instance, client }) => {
			await refreshDemo(instance, "demo", small);
			let checks = 0;
			const seeded = await refreshDemo(instance, "demo", small, {
				// Each round's audit runs while this write commits, so only an audit under the gate can hold.
				preflight: async () => {
					checks++;
					await client.call("admin", { do: "project.create", key: `busy-${checks}` });
				},
			});
			expect(checks).toBe(3);
			expect(seeded.cases).toHaveLength(30);
		});
	},
	SLOW,
);

test(
	"writes proceed during the worker preflight and invalidate its proof",
	async () => {
		await withInstance(async ({ instance, client }) => {
			await refreshDemo(instance, "demo", small);
			let ready!: () => void;
			let release!: () => void;
			const reached = new Promise<void>((resolve) => {
				ready = resolve;
			});
			const resume = new Promise<void>((resolve) => {
				release = resolve;
			});
			let checks = 0;
			const refresh = refreshDemo(instance, "demo", small, {
				preflight: async () => {
					checks++;
					if (checks === 1) {
						ready();
						await resume;
					}
				},
			});
			try {
				await reached;
				const written = await client.call("admin", { do: "project.create", key: "during-preflight" });
				expect(written).toMatchObject({ key: "during-preflight", policy: "loose" });
			} finally {
				release();
				await refresh;
			}
			const seeded = await refresh;
			expect(checks).toBe(2);
			expect(seeded.cases).toHaveLength(30);
			expect(await client.with({ project: "during-preflight" }).call("find", { limit: 1 })).toMatchObject({
				items: [],
			});
		});
	},
	SLOW,
);

test("the final reset check rejects a reference broken by recreation and restores both projects", async () => {
	await withInstance(async ({ instance }) => {
		const { app, owner } = instance;
		removalFixture(app.db, 2);
		app.db.raw.exec(`CREATE TRIGGER bad_recreation AFTER INSERT ON projects WHEN NEW.key = 'removing' BEGIN
			UPDATE results SET corrects = 999999 WHERE project = 901;
		END`);
		const steps = resetDemoSteps(app, owner, "removing", null, () => {});
		try {
			expect(steps.next()).toEqual({ value: undefined, done: false });
			expect(() => steps.next()).toThrow(/FOREIGN KEY constraint failed/);
			expect(
				app.db.raw.query("SELECT project, count(*) AS n FROM results GROUP BY project ORDER BY project").all(),
			).toEqual([
				{ project: 900, n: 2 },
				{ project: 901, n: 2 },
			]);
			expect(app.db.raw.query("SELECT project FROM demo_projects WHERE project = 900").get()).toEqual({ project: 900 });
			expect(app.db.raw.query("PRAGMA foreign_key_check").all()).toEqual([]);
			expect(app.db.raw.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
		} finally {
			steps.return(undefined);
		}
	});
});

test(
	"restoring demo admin grants applies the server's MFA configuration to password sessions",
	async () => {
		await withInstance(
			async ({ instance, client }) => {
				instance.app.config.passwordCost = { memoryCost: 8, timeCost: 1 };
				await refreshDemo(instance, "demo", small);
				const invitation = z.object({ code: z.string() }).parse(
					await client.call("invitation", {
						do: "create",
						name: "demo-admin",
						can: ["read", "admin"],
						project: "demo",
					}),
				);
				const accepted = await fetch(`${instance.url}/api/login`, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						origin: instance.url,
						[API_VERSION_HEADER]: String(API_VERSION),
					},
					body: JSON.stringify({ invitation: invitation.code, password: "correct horse battery staple" }),
				});
				expect(accepted.status).toBe(200);
				await accepted.text();
				const cookie = accepted.headers.get("set-cookie")?.split(";")[0];
				if (!cookie) throw new Error("joining did not open a session");
				const status = async () => {
					const reply = await fetch(`${instance.url}/api/session`, { headers: { cookie } });
					await reply.text();
					return reply.status;
				};
				expect(await status()).toBe(200);
				instance.app.config.requireAdminMfa = true;
				await refreshDemo(instance, "demo", small);
				expect(await grantsOf(client, "demo-admin")).toMatchObject([{ project: "demo", can: ["read", "admin"] }]);
				expect(await status()).toBe(401);
			},
			{
				mode: "server",
				env: {
					MAINWORTHY_TRUSTED_PROXY: "203.0.113.7",
					MAINWORTHY_CLIENT_ADDRESS_HEADER: "x-real-ip",
				},
			},
		);
	},
	SLOW,
);

test(
	"a stop during reset makes no seed token after the reset commits",
	async () => {
		await withInstance(async ({ instance, client }) => {
			await refreshDemo(instance, "demo", small);
			const controller = new AbortController();
			await expect(
				refreshDemo(instance, "demo", small, {
					signal: controller.signal,
					step: async () => controller.abort(new Error("server stopping")),
				}),
			).rejects.toThrow("server stopping");
			const tokens = Tokens.parse(await client.call("admin", { do: "token.list" }));
			const seedTokens = tokens.filter((token) => token.label === "demo seed of demo");
			expect(seedTokens).toHaveLength(1);
			expect(tokens.filter((token) => token.label.startsWith("demo ")).every((token) => token.revoked)).toBe(true);
			expect(await titles(client, "demo")).toEqual([]);
		});
	},
	SLOW,
);

test(
	"a start seeds the demo again: what was written there is gone, its grants stay, no seed token works",
	async () => {
		await withInstance(
			async ({ instance, client }) => {
				const first = await refreshDemo(instance, "demo", small);
				expect(first.cases).toHaveLength(30);
				const demo = client.with({ project: "demo" });
				await demo.call("propose", { edits: [{ op: "create", outline: "Written in the demo by hand" }] });
				expect(await titles(client, "demo")).toContain("Written in the demo by hand");
				// Somebody the owner let into the demo, who can still use it after the start.
				await client.call("admin", {
					do: "token.create",
					actor: "helper",
					kind: "agent",
					can: ["read", "produce"],
					project: "demo",
				});
				// With a role on the demo, which it keeps too.
				await client.call("admin", {
					do: "grant.set",
					actor: "helper",
					project: "demo",
					can: ["read", "produce"],
					roles: ["release-manager"],
				});
				const helperBefore = await grantsOf(client, "helper");
				expect(helperBefore).toHaveLength(1);
				expect(helperBefore?.[0]?.roles).toEqual(["release-manager"]);
				// And a team given the demo: its grant is given back too.
				await client.call("admin", { do: "team.create", name: "testers" });
				await client.call("admin", { do: "team.grant.set", team: "testers", project: "demo", can: ["read", "answer"] });
				const teamBefore = await teamGrants(client);
				expect(teamBefore).toHaveLength(1);
				// The demo's own agent, narrowed by hand: the seed gives it back what the demo needs (DEMO_ACTORS).
				await client.call("admin", { do: "grant.set", actor: "reviewer", project: "demo", can: ["read"] });
				// Tokens somebody made by hand under the labels the seed and the start use: they keep working.
				const byHand: number[] = [];
				for (const [actor, kind, can, label, expires] of [
					["pipeline", "ci", ["read", "record"], "Demo pipeline for demo", undefined],
					["pipeline", "ci", ["read", "record"], "Demo pipeline", "1h"],
					["helper", "agent", ["read", "produce"], "demo seed of demo", undefined],
				] as const)
					byHand.push(
						Made.parse(
							await client.call("admin", {
								do: "token.create",
								actor,
								kind,
								can: [...can],
								project: "demo",
								label,
								...(expires ? { expires } : {}),
							}),
						).id,
					);

				const again = await refreshDemo(instance, "demo", small);
				expect(again.cases).toEqual(first.cases);
				expect(again.questions.toSorted()).toEqual(first.questions.toSorted());
				expect(await titles(client, "demo")).not.toContain("Written in the demo by hand");
				expect(await grantsOf(client, "helper")).toEqual(helperBefore);
				expect(await teamGrants(client)).toEqual(teamBefore);
				expect(await grantsOf(client, "reviewer")).toEqual([
					{ project: "demo", can: expect.arrayContaining(["produce", "answer"]), roles: [] },
				]);
				// The owner's token for each start and every token of the seed's pipeline and agent are revoked, and no
				// token made by hand is, whatever its label.
				const tokens = Tokens.parse(await client.call("admin", { do: "token.list" }));
				expect(tokens.filter((token) => byHand.includes(token.id)).map((token) => token.revoked)).toEqual([
					false,
					false,
					false,
				]);
				const made = tokens.filter((token) => !byHand.includes(token.id) && token.actor !== "helper");
				expect(made.filter((token) => token.label === "demo seed of demo")).toHaveLength(2);
				expect(made.filter((token) => ["pipeline", "reviewer"].includes(token.actor)).length).toBeGreaterThan(2);
				expect(made.filter((token) => token.actor !== "robin").every((token) => token.revoked)).toBe(true);
				expect(made.filter((token) => token.label === "demo seed of demo").every((token) => token.revoked)).toBe(true);
			},
			{ mode: "server" },
		);
	},
	SLOW,
);

test("a project that is not a demo is left as it is: one with work, an empty one, a seed's id sent by hand", async () => {
	await withInstance(async ({ instance, client }) => {
		await client.call("admin", { do: "project.create", key: "work" });
		await client.with({ project: "work" }).call("propose", { edits: [{ op: "create", outline: "Our own case" }] });
		await expect(refreshDemo(instance, "work", small)).rejects.toThrow(
			"MAINWORTHY_DEMO names project work, which is not a demo; it is left as it is",
		);
		expect(await titles(client, "work")).toEqual(["Our own case"]);
		// The project the instance started with, with nothing in it, is not a demo either.
		await expect(refreshDemo(instance, "scratch", small)).rejects.toThrow("which is not a demo");
		// An earlier build's seed id, sent after work was there, does not make a demo of it.
		await client.with({ project: "work" }).call("propose", {
			cmd: "demo-work-folders-v1",
			edits: [{ op: "folder", name: "Checkout" }],
		});
		await expect(refreshDemo(instance, "work", small)).rejects.toThrow("which is not a demo");
		expect(await titles(client, "work")).toEqual(["Our own case"]);
		// Archived work is work: seed refuses the project, so it cannot become a demo.
		const kept = client.with({ project: "kept" });
		await client.call("admin", { do: "project.create", key: "kept" });
		await kept.call("propose", { edits: [{ op: "create", outline: "Archived but ours" }] });
		await kept.call("propose", { edits: [{ op: "state", cases: ["C-1"], to: "archived" }] });
		await expect(seed(client, { project: "kept", ...small })).rejects.toThrow("already holds cases, tests or runs");
		await expect(refreshDemo(instance, "kept", small)).rejects.toThrow("which is not a demo");
		expect((await kept.call("find", { state: "archived" })).items).toHaveLength(1);
	});
});

test("a demo an earlier build seeded carries no mark: it is one when its first write was that seed's", async () => {
	await withInstance(async ({ instance, client }) => {
		await client.call("admin", { do: "project.create", key: "older" });
		await client.with({ project: "older" }).call("propose", {
			cmd: "demo-older-folders-v1",
			edits: [{ op: "folder", name: "Checkout" }],
		});
		await client
			.with({ project: "older" })
			.call("propose", { edits: [{ op: "create", outline: "From the old demo" }] });
		const seeded = await refreshDemo(instance, "older", small);
		expect(seeded.cases).toHaveLength(30);
		expect(await titles(client, "older")).not.toContain("From the old demo");
	});
});

test(
	"a start that cannot finish the seed empties nothing, and grants nobody needs back do not stop it",
	async () => {
		await withInstance(async ({ instance, client }) => {
			await refreshDemo(instance, "demo", small);
			await client.call("admin", { do: "token.create", actor: "helper", kind: "ci", can: ["read"], project: "demo" });
			await client.call("admin", { do: "token.create", actor: "gone", kind: "agent", can: ["read"], project: "demo" });
			await client.call("admin", { do: "actor.forget", name: "gone" });
			const before = await titles(client, "demo");
			// The name the seed's pipeline needs is a person's now: refused before the demo is emptied.
			await client.call("admin", { do: "actor.forget", name: "pipeline" });
			await client.call("admin", { do: "token.create", actor: "pipeline", kind: "human", can: ["read"] });
			await expect(refreshDemo(instance, "demo", small)).rejects.toThrow(
				"actor pipeline exists and is a human, not a ci",
			);
			expect(await titles(client, "demo")).toEqual(before);
			expect(await grantsOf(client, "helper")).toEqual([{ project: "demo", can: ["read"], roles: [] }]);
			// With the name free again, the start finishes; the forgotten actor's grant is not asked back.
			await client.call("admin", { do: "actor.forget", name: "pipeline" });
			await refreshDemo(instance, "demo", small);
			expect(await grantsOf(client, "helper")).toEqual([{ project: "demo", can: ["read"], roles: [] }]);
		});
	},
	SLOW,
);

/** Makes the first request `stops` names fail as a connection that dropped, while `body` runs. */
async function stoppingAt<T>(stops: (op: string, input: unknown) => boolean, body: () => Promise<T>): Promise<T> {
	const call = Client.prototype.call;
	let stopped = false;
	Client.prototype.call = function (this: Client, ...args: Parameters<typeof call>) {
		if (!stopped && stops(args[0], args[1])) {
			stopped = true;
			return Promise.reject(new CliError("connection", "the connection dropped"));
		}
		return call.apply(this, args);
	} as typeof call;
	try {
		return await body();
	} finally {
		Client.prototype.call = call;
	}
}
const commandOf = (input: unknown) => z.object({ cmd: z.string().optional() }).safeParse(input).data?.cmd ?? "";

test(
	"a start stopped after the demo was emptied keeps its grants, and the next start seeds it",
	async () => {
		await withInstance(async ({ instance, client }) => {
			await refreshDemo(instance, "demo", small);
			await client.call("admin", { do: "token.create", actor: "helper", kind: "ci", can: ["read"], project: "demo" });
			await client.call("admin", { do: "team.create", name: "testers" });
			await client.call("admin", { do: "team.grant.set", team: "testers", project: "demo", can: ["read"] });
			const before = { helper: await grantsOf(client, "helper"), team: await teamGrants(client) };
			// The seed's first look at the projects fails, after the demo was emptied (the start's own look is the
			// first): as if the server had stopped there.
			let looks = 0;
			await expect(
				stoppingAt(
					(op, input) => op === "admin" && JSON.stringify(input).includes("project.list") && ++looks === 2,
					() => refreshDemo(instance, "demo", small),
				),
			).rejects.toThrow("the connection dropped");
			const listed = z
				.array(z.object({ key: z.string(), demo: z.boolean() }))
				.parse(await client.call("admin", { do: "project.list" }));
			expect(listed.find((row) => row.key === "demo")).toEqual({ key: "demo", demo: true });
			expect(await titles(client, "demo")).toEqual([]);
			expect({ helper: await grantsOf(client, "helper"), team: await teamGrants(client) }).toEqual(before);
			await refreshDemo(instance, "demo", small);
			expect((await titles(client, "demo")).length).toBeGreaterThan(20);
			expect({ helper: await grantsOf(client, "helper"), team: await teamGrants(client) }).toEqual(before);
		});
	},
	SLOW,
);

test(
	"a seed stopped after its fields were sent defines them when it is sent again",
	async () => {
		await withInstance(async ({ client }) => {
			await expect(
				stoppingAt(
					(op, input) => op === "decide" && commandOf(input).includes("-fields-yes-"),
					() => seed(client, { project: "demo", ...small }),
				),
			).rejects.toThrow("the connection dropped");
			await seed(client, { project: "demo", ...small });
			const policy = z
				.object({ settings: z.object({ fields: z.record(z.string(), z.unknown()).optional() }) })
				.parse(await client.call("admin", { do: "policy.show", project: "demo" }));
			expect(Object.keys(policy.settings.fields ?? {})).toEqual(["priority", "team", "risk"]);
			const proposals = (await client.with({ project: "demo" }).call("inbox", { kind: "adopt" })).items;
			expect(proposals.map((item) => item.evidence.count).sort()).toEqual([1, 30]);
		});
	},
	SLOW,
);

test(
	"health and ordinary reads answer while a refresh waits inside its reset transaction",
	async () => {
		await withInstance(async ({ instance, client }) => {
			await client.call("admin", { do: "project.create", key: "older" });
			await client.with({ project: "older" }).call("propose", {
				cmd: "demo-older-folders-v1",
				edits: [{ op: "folder", name: "Checkout" }],
			});
			await client.with({ project: "older" }).call("propose", {
				edits: [{ op: "create", outline: "The committed demo" }],
			});
			let resume = () => {};
			const paused = new Promise<void>((resolve) => {
				resume = resolve;
			});
			let reached = () => {};
			const atRemoval = new Promise<string>((resolve) => {
				reached = () => resolve("paused");
			});
			const refreshing = refreshDemo(instance, "older", small, {
				step: async (name: string) => {
					if (name !== "removed") return;
					reached();
					await paused;
				},
			});
			try {
				expect(await Promise.race([atRemoval, refreshing.then(() => "finished")])).toBe("paused");
				const health = await fetch(`${instance.url}/healthz`, { signal: AbortSignal.timeout(2_000) });
				expect(health.status).toBe(200);
				expect(await health.json()).toMatchObject({ ok: true });
				expect(await titles(client, "older")).toEqual(["The committed demo"]);
			} finally {
				resume();
				await refreshing;
			}
			expect(await titles(client, "older")).not.toContain("The committed demo");
		});
	},
	SLOW,
);

test(
	"a reset that outlasts the preflight token makes a fresh seed token afterwards",
	async () => {
		await withInstance(
			async ({ instance, client }) => {
				await refreshDemo(instance, "demo", small);
				const clock = instance.app.now;
				try {
					const seeded = await refreshDemo(instance, "demo", small, {
						step: async () => {
							instance.app.now = () => clock() + 16 * 60_000;
						},
					});
					expect(seeded.cases).toHaveLength(30);
					expect((await titles(client, "demo")).length).toBe(28);
					const tokens = Tokens.parse(await client.call("admin", { do: "token.list" }));
					const seedTokens = tokens.filter((token) => token.label === "demo seed of demo");
					expect(seedTokens).toHaveLength(2);
					expect(seedTokens.every((token) => token.revoked)).toBe(true);
					expect(seedTokens.at(-1)?.expired).toBe(false);
					expect(
						tokens.filter((token) => token.label === "demo preflight of demo").every((token) => token.revoked),
					).toBe(true);
				} finally {
					instance.app.now = clock;
				}
			},
			{ mode: "server" },
		);
	},
	SLOW,
);

test(
	"stopping a reset before its commit preserves the old demo and its grants",
	async () => {
		await withInstance(async ({ instance, client }) => {
			await refreshDemo(instance, "demo", small);
			await client.call("admin", { do: "token.create", actor: "helper", kind: "ci", can: ["read"], project: "demo" });
			const before = { titles: await titles(client, "demo"), grants: await grantsOf(client, "helper") };
			await expect(
				refreshDemo(instance, "demo", small, {
					step: async () => {
						throw new Error("reset interrupted");
					},
				}),
			).rejects.toThrow("reset interrupted");
			expect({ titles: await titles(client, "demo"), grants: await grantsOf(client, "helper") }).toEqual(before);
			expect(instance.app.db.raw.query("PRAGMA foreign_key_check").all()).toEqual([]);
			await refreshDemo(instance, "demo", small);
			expect(await grantsOf(client, "helper")).toEqual(before.grants);
		});
	},
	SLOW,
);

test(
	"a repeated demo seed renews one live slot and renewal keeps its start",
	async () => {
		await withInstance(async ({ instance, client }) => {
			const first = await seed(client, { project: "demo", cases: 30, days: 1 });
			const again = await seed(client, { project: "demo", cases: 30, days: 1 });
			expect(again.workSlot).toBe(first.workSlot);
			const demo = client.with({ project: "demo" });
			expect((await demo.call("get", { refs: [first.run] }))[0]).toMatchObject({ inProgress: 1 });
			const before = (await demo.call("find", { in: "slots", run: first.run })).items.find(
				(s) => s.id === first.workSlot,
			);
			const { renewDemoWork } = await import("./demo.ts");
			const now = instance.app.now();
			instance.app.now = () => now + 60_000;
			await renewDemoWork(instance, "demo", first);
			const after = (await demo.call("find", { in: "slots", run: first.run })).items.find(
				(s) => s.id === first.workSlot,
			);
			expect((await demo.call("get", { refs: [first.run] }))[0]).toMatchObject({ inProgress: 1 });
			expect(z.object({ until: z.number() }).parse(after?.work).until).toBeGreaterThan(
				z.object({ until: z.number() }).parse(before?.work).until,
			);
			expect(after?.work).toMatchObject({
				kind: "held",
				since: z.object({ since: z.number() }).parse(before?.work).since,
			});
		});
	},
	SLOW,
);
