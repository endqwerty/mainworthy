// What a seeded project holds, read back through the operations: the suite, the days before today, and today.
import { expect, test } from "bun:test";
import { z } from "zod";
import { ResultTrail } from "../core/results.ts";
import { Client } from "./client.ts";
import { demoCases } from "./demo/cases.ts";
import { demoAliases } from "./demo/fields.ts";
import { demoHistory } from "./demo/history.ts";
import { seed } from "./seed.ts";
import { withInstance } from "./test-support.ts";

const DAY = 86_400_000;
const Run = z.object({
	ref: z.string(),
	name: z.string(),
	state: z.string(),
	verdict: z.string(),
	slots: z.number(),
	createdAt: z.number(),
});
const Case = z.object({ ref: z.string(), title: z.string() });
const Entry = z.object({
	t: z.string(),
	at: z.number(),
	method: z.string().optional(),
	outcome: z.string().optional(),
});
const Checked = z.object({ counts: z.object({ "unlinked-tests": z.number(), "duplicate-title": z.number() }) });
const Since = z.object({ since: z.number() });
const Project = z.array(z.object({ key: z.string(), policy: z.string() }));

const on = (client: Client, project: string) => new Client({ ...client.options, project });
const dayOf = (at: number) => Math.floor(at / DAY);

test("the demo change selects its checkout tests for impact", async () => {
	await withInstance(async ({ client }) => {
		await seed(client, { project: "impact-demo", cases: 40, days: 0, unlinkedFiles: 0 });
		const demo = on(client, "impact-demo");
		const impact = await demo.call("impact", { change: "pr:482" });
		expect(impact.cases.some((row) => row.why.some((reason) => reason.startsWith("test:tests/checkout/")))).toBe(true);
		expect(impact.counts.cases).toBeGreaterThan(1);
	});
});

/** Every case's title, archived or not (the history archives two), in the order of the alphabet. */
const titlesOf = async (client: Client) =>
	(
		await Promise.all(
			["active", "archived"].map(async (state) =>
				z
					.array(Case)
					.parse((await client.call("find", { state, limit: 500 })).items)
					.map((item) => item.title),
			),
		)
	)
		.flat()
		.sort();

test("a demo archive imports with readable open and settled failure questions", async () => {
	await withInstance(async ({ client }) => {
		await seed(client, { project: "demo", cases: 6 });
		const demo = on(client, "demo");
		const open = await demo.call("inbox", { kind: "failure" });
		const settled = await demo.call("inbox", { kind: "failure", state: "decided" });
		expect(open.items.length).toBeGreaterThan(0);
		expect(settled.items.length).toBeGreaterThan(0);
		const exported = await client.request("/api/export");
		expect(exported.status).toBe(200);
		const archive = await exported.blob();
		await withInstance(async ({ client: restored }) => {
			const imported = await restored.request("/api/import", { method: "POST", body: archive });
			expect(imported.status).toBe(200);
			const importedDemo = on(restored, "demo");
			for (const [state, before] of [
				["open", open],
				["decided", settled],
			] as const) {
				const after = await importedDemo.call("inbox", { kind: "failure", state });
				expect(
					after.items.map(({ q, kind, state, title, evidenceHash }) => ({ q, kind, state, title, evidenceHash })),
				).toEqual(
					before.items.map(({ q, kind, state, title, evidenceHash }) => ({ q, kind, state, title, evidenceHash })),
				);
			}
		});
	});
});

test("a seeded project holds a suite in folders, a fortnight of history and six questions for today", async () => {
	await withInstance(async ({ client }) => {
		const before = Date.now();
		const seeded = await seed(client, { project: "demo", cases: 120 });
		const demo = on(client, "demo");
		const pipeline = z
			.array(z.object({ last: z.array(z.object({ steps: ResultTrail.nullable() })) }))
			.parse(await demo.call("get", { refs: ["T-1"] }))[0]
			?.last.find((result) => result.steps !== null)?.steps;
		const agent = z
			.object({
				items: z.array(z.object({ fills: z.array(z.object({ method: z.string(), steps: ResultTrail.nullable() })) })),
			})
			.parse(await demo.call("find", { in: "slots", run: seeded.agentRun }))
			.items[0]?.fills.find((fill) => fill.method === "agent")?.steps;
		for (const trail of [pipeline, agent]) {
			expect(trail?.length).toBeGreaterThan(0);
			for (const step of trail ?? []) {
				const actions = step.actions ?? [];
				expect(actions.length).toBeGreaterThan(1);
				expect(new Set(actions.map((action) => action.text)).size).toBe(actions.length);
				expect(actions.reduce((total, action) => total + (action.durationMs ?? 0), 0)).toBe(step.durationMs ?? -1);
				expect(actions.every((action) => Number.isInteger(action.durationMs) && (action.durationMs ?? 0) > 0)).toBe(
					true,
				);
				expect(actions.at(-1)?.outcome).toBe(step.outcome);
			}
		}
		expect(pipeline?.[1]?.actions?.map((action) => action.text)).toEqual([
			"Focus Coupon",
			"Type OLD10 into Coupon",
			"Press Apply",
		]);
		expect(pipeline?.at(-1)).toMatchObject({ outcome: "fail", attachment: 1 });
		expect(agent?.at(-1)).toMatchObject({ outcome: "pass", attachment: 0 });
		// The day the project became a demo, which the server keeps: asked again, it is the same moment.
		const { since } = Since.parse(await client.call("admin", { do: "project.demo", key: "demo" }));
		const covered = demoHistory({ seed: 1, cases: demoCases(1, 120), days: 14, since }).find(
			(event) => event.kind === "pipeline" && event.step === "qreport",
		);
		if (covered?.kind !== "pipeline") throw new Error("missing demo quarantine report");
		expect(await demo.call("gate", { commit: covered.target.commit })).toMatchObject({
			verdict: "passed",
			quarantined: 1,
		});
		expect((await demo.call("find", { in: "tests", state: "quarantined" })).count).toBe(0);
		expect(since).toBeGreaterThanOrEqual(before);
		const today = dayOf(since);

		// The suite: 120 cases with titles of their own, in the shop's folders.
		expect(seeded.cases).toHaveLength(120);
		expect(new Set(await titlesOf(demo)).size).toBe(120);
		const folders = z.array(z.object({ path: z.string() })).parse((await demo.call("find", { in: "folders" })).items);
		expect(folders.map((folder) => folder.path)).toEqual(
			expect.arrayContaining(["Checkout", "Checkout/Coupons", "Accounts/Sign-in", "Orders/Returns", "API/Webhooks"]),
		);
		expect(Checked.parse(await demo.call("check", {})).counts).toMatchObject({
			// The one test with no case is today's question; every other test was linked on the first day.
			"unlinked-tests": 1,
			"duplicate-title": 0,
		});

		// Today: the failing test on `main` and on the pull request, the finding, both agent proposals, the test with no case.
		const open = await demo.call("inbox", { limit: 50 });
		expect(open.items.map((item) => item.kind).sort()).toEqual([
			"adopt",
			"adopt",
			"failure",
			"failure",
			"finding",
			"map",
		]);
		const large = open.items.find((item) => item.kind === "adopt" && item.evidence.count === 120);
		expect(large?.evidence.edits).toHaveLength(20);
		const full = await demo.call("get", { refs: [String(large?.evidence.proposal)] });
		expect(full[0]).toMatchObject({ count: 120, cursor: null });
		const inherited = (await demo.call("inbox", { on: "pr:482", kind: "failure" })).items;
		expect(inherited).toHaveLength(1);
		expect(inherited[0]?.evidence).toMatchObject({ hints: ["fails-on-base"] });
		expect(seeded.questions.toSorted()).toEqual(open.items.map((item) => item.q).sort());
		for (const item of open.items) expect(dayOf(item.openedAt)).toBe(today);

		// The days before: the automated test of the first case has a result on each of the fourteen days and today.
		const timeline = z.array(Entry).parse((await demo.call("timeline", { ref: "C-1", limit: 500 })).entries);
		const automated = timeline.filter((entry) => entry.t === "result" && entry.method === "auto");
		const days = new Set(automated.map((entry) => dayOf(entry.at)));
		for (let ago = 1; ago <= 14; ago++) expect([ago, days.has(today - ago)]).toEqual([ago, true]);
		expect(timeline.find((entry) => entry.t === "version")?.at).toBeLessThan((today - 13) * DAY);
		// Nothing is dated after the moment the project became a demo.
		for (const entry of timeline) expect(entry.at).toBeLessThanOrEqual(since);

		// The runs: one every other day, the old ones closed as passed, one failed, one not finished, today's open.
		const runs = z.array(Run).parse((await demo.call("find", { in: "runs", origin: "planned", limit: 100 })).items);
		expect(runs.find((run) => run.ref === seeded.run)).toMatchObject({ name: "Checkout regression", state: "open" });
		// Today's two runs are made in the hours before the seed, which in the first hours of a day are yesterday's.
		const past = runs.filter((run) => run.ref !== seeded.run && run.ref !== seeded.agentRun);
		expect(past.length).toBeGreaterThanOrEqual(7);
		expect(new Set(past.map((run) => dayOf(run.createdAt))).size).toBe(past.length);
		expect(Math.min(...past.map((run) => dayOf(run.createdAt)))).toBe(today - 13);
		const tally = (state: string, verdict: string) =>
			past.filter((run) => run.state === state && run.verdict === verdict).length;
		expect(tally("closed", "passed")).toBe(past.length - 2);
		expect(tally("open", "failed")).toBe(1);
		expect(tally("open", "pending")).toBe(1);

		// What was asked in those days was answered in them: by a person, a day or less after it was asked.
		const decided = await demo.call("inbox", { state: "decided", limit: 500 });
		const answered = decided.items.filter((item) => item.kind === "failure" || item.kind === "finding");
		expect(answered.length).toBeGreaterThan(5);
		for (const item of answered) {
			const answer = item.decision?.supersedes ?? item.decision;
			expect(answer?.by).toEqual(["robin"]);
			expect(answer?.at).toBeGreaterThan(item.openedAt);
			expect((answer?.at ?? 0) - item.openedAt).toBeLessThan(DAY);
			expect(answer?.at).toBeLessThan(before);
		}
		expect(answered.find((item) => item.decision?.rule === "passed")).toMatchObject({
			state: "dissolved",
			decision: { answer: { is: "outdated" }, by: ["policy"], supersedes: { by: ["robin"] } },
		});
		expect(new Set(answered.map((item) => dayOf(item.openedAt))).size).toBeGreaterThan(3);

		// Today's failure carries the trace its test runner wrote.
		const failed = z
			.array(z.object({ t: z.string(), id: z.number().optional(), outcome: z.string().optional() }))
			.parse((await demo.call("timeline", { ref: "C-1", limit: 50 })).entries)
			.find((entry) => entry.t === "result" && entry.outcome === "fail");
		expect(JSON.stringify(await demo.call("attachment", { result: failed?.id ?? 0 }))).toContain('"trace.txt"');
		// The pull requests of those days merged, and an ended change is not asked about; today's is open.
		const changes = z
			.array(z.object({ key: z.string(), state: z.string() }))
			.parse((await demo.call("find", { in: "changes", limit: 100 })).items);
		expect(changes.find((change) => change.key === "pr:482")?.state).toBe("open");
		// Today's other pull request reported two of its three shards, and its gate waits for the third.
		expect(changes.find((change) => change.key === "pr:483")?.state).toBe("open");
		expect(await demo.call("gate", { change: "pr:483" })).toMatchObject({
			verdict: "pending",
			reason: "pending: waiting for shard 3 of 3 of job shop",
		});
		const ended = changes.filter((change) => change.key !== "pr:482" && change.key !== "pr:483");
		expect(ended.length).toBeGreaterThan(5);
		expect(ended.every((change) => change.state === "merged")).toBe(true);
		const receipt = z
			.object({ change: z.object({ mergeReceipt: z.object({ gate: z.object({ verdict: z.string() }) }) }) })
			.parse(await demo.call("impact", { change: "pr:484" }));
		expect(receipt.change.mergeReceipt.gate.verdict).toBe("passed");
		expect((await demo.call("gate", { change: "pr:484" })).verdict).toBe("blocked");
		// The project's own fields, set on its cases; two cases archived; the back office's TestRail ids.
		const policy = z
			.object({ settings: z.object({ fields: z.record(z.string(), z.unknown()) }) })
			.parse(await client.call("admin", { do: "policy.show", project: "demo" }));
		expect(Object.keys(policy.settings.fields)).toEqual(["priority", "team", "risk"]);
		expect(JSON.stringify(await demo.call("get", { refs: ["C-2"], as: "md" }))).toMatch(/priority: P[123]/);
		// A demo this small has no case that a run or an edit leaves alone, so nothing is archived (history.test.ts).
		expect((await demo.call("find", { state: "archived" })).items).toHaveLength(0);
		const suite = demoCases(1, 120);
		const imported = suite.flatMap((item, index) => demoAliases(item, index));
		expect(imported.length).toBeGreaterThan(0);
		const [alias] = imported;
		expect(z.array(z.object({ ref: z.string() })).parse(await demo.call("get", { refs: [alias ?? ""] }))).toHaveLength(
			1,
		);

		expect(Project.parse(await client.call("admin", { do: "project.list" })).find((row) => row.key === "demo")).toEqual(
			{
				key: "demo",
				policy: "standard",
			},
		);
	});
});

test("the same seed writes the same suite, another seed another, and no days leave today alone", async () => {
	await withInstance(async ({ client }) => {
		await seed(client, { project: "one", cases: 60, seed: 42, days: 2 });
		await seed(client, { project: "two", cases: 60, seed: 42, days: 0 });
		await seed(client, { project: "three", cases: 60, seed: 43, days: 0 });
		const one = await titlesOf(on(client, "one"));
		expect(await titlesOf(on(client, "two"))).toEqual(one);
		expect(await titlesOf(on(client, "three"))).not.toEqual(one);

		// With no days there is today's run and no other, and the six questions all the same.
		const today = on(client, "two");
		const runs = z.array(Run).parse((await today.call("find", { in: "runs", origin: "planned", limit: 100 })).items);
		expect(runs.map((run) => run.name)).toEqual(["Agent checkout check", "Checkout regression"]);
		expect((await today.call("inbox", { limit: 50 })).items).toHaveLength(6);
		const inherited = (await today.call("inbox", { on: "pr:482", kind: "failure" })).items;
		expect(inherited).toHaveLength(1);
		expect(inherited[0]?.evidence).toMatchObject({ hints: ["fails-on-base"] });
		expect(Checked.parse(await today.call("check", {})).counts["unlinked-tests"]).toBe(1);
	});
});

test("a seed sent again with another seed or other days is refused, and the project it began in is as it was", async () => {
	await withInstance(async ({ client, run }) => {
		await seed(client, { project: "demo", cases: 30, seed: 5, days: 3 });
		const demo = on(client, "demo");
		const runs = (await demo.call("find", { in: "runs", limit: 100 })).items.length;
		for (const other of [
			["--seed", "6", "--days", "3"],
			["--seed", "5", "--days", "4"],
		]) {
			const refused = await run(["seed", "demo", "--cases", "30", ...other]);
			expect(refused.code).toBe(4);
			expect(refused.stderr).toContain("another seed or other days");
		}
		expect((await demo.call("find", { in: "runs", limit: 100 })).items).toHaveLength(runs);
		expect(await titlesOf(demo)).toHaveLength(30);
		const again = await run(["seed", "demo", "--cases", "30", "--seed", "5", "--days", "3"]);
		expect(again.stderr).toBe("");
		expect(again.code).toBe(0);
		for (const [flag, value, words] of [
			["--days", "91", "from 0 to 90 days"],
			["--days", "-1", "from 0 to 90 days"],
			["--days", "1.5", "from 0 to 90 days"],
			["--seed", "-3", "the seed is a whole number"],
			["--seed", "4294967296", "the seed is a whole number"],
		] as const) {
			const refused = await run(["seed", "other", "--cases", "3", flag, value]);
			expect([flag, value, refused.code]).toEqual([flag, value, 4]);
			expect(refused.stderr).toContain(words);
		}
		expect(Project.parse(await client.call("admin", { do: "project.list" })).map((row) => row.key)).toEqual([
			"scratch",
			"demo",
		]);
	});
});

test("seed fills the project an instance starts with while nothing was written to it, and not after", async () => {
	await withInstance(async ({ client }) => {
		// A policy change is no case, test or run, and it is something written: the project keeps the server's clock.
		const touched = on(client, "scratch");
		const proposed = await touched.call("propose", { edits: [{ op: "policy", preset: "strict" }] });
		const asked = (await touched.call("inbox", { kind: "adopt" })).items.find((item) => item.q === proposed.question);
		if (asked) await touched.call("decide", { q: asked.q, onEvidence: asked.evidenceHash, answer: { is: "accept" } });
		await expect(seed(client, { project: "scratch", cases: 3 })).rejects.toThrow("already holds");
		expect(await titlesOf(touched)).toEqual([]);
	});
	await withInstance(async ({ client }) => {
		const seeded = await seed(client, { project: "scratch", cases: 3, days: 0 });
		expect(seeded.questions).toHaveLength(5);
	});
});

test("the demo's trunk failure names the pull request that landed its exact commit", async () => {
	await withInstance(async ({ client }) => {
		await seed(client, { project: "demo", cases: 3, days: 0 });
		const demo = on(client, "demo");
		const failures = (await demo.call("inbox", { kind: "failure" })).items;
		const trunk = failures.find((item) => item.evidence.branch === "main");
		expect(trunk?.evidence).toMatchObject({
			location: { label: "main · pr:481 Round coupon totals consistently", change: "pr:481" },
		});
		const landed = z.object({ commit: z.string() }).parse(trunk?.evidence.location);
		const change = await demo.call("find", { in: "changes", limit: 100 });
		expect(change.items).toContainEqual(
			expect.objectContaining({
				key: "pr:481",
				state: "merged",
				head: landed.commit,
			}),
		);
	});
});
