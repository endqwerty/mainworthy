import { expect, test } from "bun:test";
import { z } from "zod";
import { Client } from "./client.ts";
import { refreshDemo } from "./demo.ts";
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
			expect(Object.keys(policy.settings.fields ?? {})).toEqual(["priority", "team"]);
			expect((await client.with({ project: "demo" }).call("inbox", { kind: "adopt" })).items).toHaveLength(1);
		});
	},
	SLOW,
);
