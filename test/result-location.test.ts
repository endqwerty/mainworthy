import { afterEach, beforeEach, expect, test } from "bun:test";
import type { InboxReply, ReportReceipt } from "../src/core/ops.ts";
import { sql } from "../src/server/kernel/db.ts";
import { OPS } from "../src/server/ops/index.ts";
import { invoke } from "../src/server/ops/registry.ts";
import { type Harness, harness } from "./helpers.ts";

let h: Harness;
beforeEach(async () => {
	h = await harness();
});
afterEach(async () => await h.close());

test("failure evidence, test history and runs name only the recorded change for the exact landed commit", async () => {
	const commit = "1234567890abcdef1234567890abcdef12345678";
	const results = [
		{ test: { key: "checkout", name: "Checkout" }, outcome: "fail", failure: { message: "Coupon lost" } },
	];
	const report = async (repo: string, sha: string, extra = {}) =>
		await h.call<ReportReceipt>("report", {
			target: { repo, commit: sha, branch: "main", ...extra },
			results,
		});
	const location = async (scope?: string) =>
		(await h.call<InboxReply>("inbox")).items.find(
			(q) => q.kind === "failure" && q.title === "Coupon lost" && (!scope || q.evidence.scope === scope),
		)?.evidence;
	await report("acme/shop", "feature0001", { branch: "coupon", pr: 653, title: "Keep coupons" });
	expect(await location()).toMatchObject({
		location: { label: "pr:653 Keep coupons", commit: "feature0001", change: "pr:653" },
	});
	const trunk = await report("acme/shop", commit);
	expect(await location()).toMatchObject({ location: { label: "main", commit, change: null } });
	await h.call("change", { change: "pr:653", state: "merged", landing: { commit, branch: "main" } });
	const expected = { label: "main · pr:653 Keep coupons", commit, change: "pr:653" };
	expect(await location()).toMatchObject({ location: expected });
	const tests = await h.call<{ items: { ref: string }[] }>("find", { in: "tests" });
	const detail = (await h.call<{ last: unknown[] }[]>("get", { refs: [tests.items[0]?.ref] }))[0];
	expect(detail?.last[0]).toMatchObject({ location: expected });
	expect(await h.call("get", { refs: [trunk.gate?.run] })).toMatchObject([{ location: expected }]);
	expect(await h.call("find", { in: "results", run: trunk.gate?.run })).toMatchObject({
		items: [{ location: expected }],
	});
	const pipeline = await h.actor("pipeline", "ci", ["read", "record"]);
	for (const [attempt, outcome] of [
		[1, "fail"],
		[2, "pass"],
	] as const) {
		await h.call(
			"report",
			{
				target: { repo: "acme/shop", commit, branch: "main" },
				job: "flips",
				attempt,
				results: [
					{
						test: { key: "flips", name: "Flipping test" },
						outcome,
						...(outcome === "fail" ? { failure: { message: "Intermittent coupon" } } : {}),
					},
				],
			},
			pipeline,
		);
	}
	const flipping = (await h.call<{ items: { ref: string; name: string }[] }>("find", { in: "tests" })).items.find(
		(test) => test.name === "Flipping test",
	);
	expect(await h.call("get", { refs: [flipping?.ref] })).toMatchObject([
		{
			sameCode: { signals: [{ samples: [{ location: expected }] }] },
		},
	]);
	const again = await h.call<ReportReceipt>(
		"report",
		{
			target: { repo: "acme/shop", commit, branch: "main" },
			job: "flips",
			attempt: 3,
			results: [
				{ test: { key: "flips", name: "Flipping test" }, outcome: "fail", failure: { message: "Intermittent coupon" } },
			],
		},
		pipeline,
	);
	// An existing question written before location metadata was added keeps only its original samples.
	await h.app.database.write(
		async (db) =>
			await db.transaction(
				async () =>
					await db.run(
						sql<
							[],
							Record<string, unknown>
						>(`UPDATE questions SET evidence = (evidence::jsonb #- '{tests,0,sameCode,signals,0,samples,0,location}'
		#- '{tests,0,sameCode,signals,0,samples,1,location}')::text WHERE kind = 'failure'`),
					),
			),
	);
	expect(await h.call("get", { refs: [again.questions[0]?.q] })).toMatchObject([
		{
			evidence: { tests: [{ sameCode: { signals: [{ samples: [{ location: expected }, { location: expected }] }] } }] },
		},
	]);
	// Same hash in a different repository is not the landing, and an unrelated trunk commit is not either.
	await report("acme/other", commit);
	expect(await location()).toMatchObject({ location: { label: "main", commit, change: null } });
	await report("acme/shop", "unknown0001");
	expect(await location("line:trunk@acme/shop")).toMatchObject({
		location: { label: "main", commit: "unknown0001", change: null },
	});
	// A recorded head is not a landed change until it is marked merged.
	await report("acme/shop", "closed0001");
	await report("acme/shop", "closed0001", { branch: "closed", pr: 654, title: "Closed change" });
	await h.call("change", { change: "pr:654", state: "closed" });
	expect(await location("line:trunk@acme/shop")).toMatchObject({
		location: { label: "main", commit: "closed0001", change: null },
	});
	// Two recorded landings of one commit are ambiguous: neither is claimed as its unique source.
	await h.call("change", { change: "pr:654", state: "open" });
	await h.call("change", { change: "pr:654", state: "merged", landing: { commit, branch: "main" } });
	const ambiguous = (await h.call<{ last: unknown[] }[]>("get", { refs: [tests.items[0]?.ref] }))[0];
	expect(ambiguous?.last).toContainEqual(
		expect.objectContaining({
			commit,
			location: { label: "main", commit, change: null },
		}),
	);
});

test("a merged head in another project is not the source of a trunk commit here", async () => {
	const commit = "1234567890abcdef1234567890abcdef12345678";
	await h.call("admin", { do: "project.create", key: "other", preset: "loose" });
	const other = async (op: string, input: unknown) => {
		const reply = await invoke(h.app, OPS, { op, project: "other", input, actor: async () => h.owner });
		if (!reply.ok) throw new Error(reply.error.message);
		return reply.result;
	};
	await other("report", {
		target: { repo: "acme/shop", commit: "feature0001", pr: 653, branch: "coupon", title: "Other project" },
		results: [{ test: { key: "checkout" }, outcome: "pass" }],
	});
	await other("change", { change: "pr:653", state: "merged", landing: { commit, branch: "main" } });
	await h.call("report", {
		target: { repo: "acme/shop", commit, branch: "main" },
		results: [{ test: { key: "checkout" }, outcome: "fail", failure: { message: "Coupon lost" } }],
	});
	expect((await h.call<InboxReply>("inbox")).items[0]?.evidence).toMatchObject({
		location: { label: "main", commit, change: null },
	});
	await h.call("report", {
		target: { repo: "acme/shop", commit: "feature0002", pr: 654, branch: "coupon", title: "This project" },
		results: [{ test: { key: "checkout" }, outcome: "pass" }],
	});
	await h.call("change", { change: "pr:654", state: "merged", landing: { commit, branch: "main" } });
	expect((await h.call<InboxReply>("inbox")).items[0]?.evidence).toMatchObject({
		location: { label: "main · pr:654 This project", commit, change: "pr:654" },
	});
});

for (const [title, branch] of [
	["Release to production", "main"],
	["Replayed merge", "feature"],
]) {
	test(`a merged ${title} head without a landing cannot name an existing trunk failure`, async () => {
		const commit = "1234567890abcdef1234567890abcdef12345678";
		await h.call("report", {
			target: { repo: "acme/shop", commit, branch: "main" },
			results: [{ test: { key: "checkout" }, outcome: "fail", failure: { message: "Coupon lost" } }],
		});
		await h.call("report", {
			target: { repo: "acme/shop", commit, branch, pr: 8, title },
			results: [{ test: { key: "checkout" }, outcome: "pass" }],
		});
		const evidence = async () => (await h.call<InboxReply>("inbox", { kind: "failure" })).items[0]?.evidence;
		await h.call("change", { change: "pr:8", state: "merged" });
		expect(await evidence()).toMatchObject({ location: { label: "main", commit, change: null } });
		await h.call("change", { change: "pr:8", state: "merged", landing: { commit, branch: "main" } });
		expect(await evidence()).toMatchObject({ location: { label: `main · pr:8 ${title}`, commit, change: "pr:8" } });
	});
}

test("a recorded landing survives replay, is replaced by a correction and ends on reopening or closing", async () => {
	const commit = "1234567890abcdef1234567890abcdef12345678";
	const corrected = "abcdef1234567890abcdef1234567890abcdef12";
	for (const sha of [commit, corrected])
		await h.call("report", {
			target: { repo: "acme/shop", commit: sha, branch: "main" },
			results: [{ test: { key: "checkout" }, outcome: "pass" }],
		});
	await h.call("report", {
		target: { repo: "acme/shop", commit, pr: 8, branch: "feature", title: "Keep coupons" },
		results: [{ test: { key: "checkout" }, outcome: "pass" }],
	});
	const history = async () =>
		(await h.call<{ last: { commit: string; location: unknown }[] }[]>("get", { refs: ["T-1"] }))[0]?.last;
	const plain = (sha: string) =>
		expect.objectContaining({ commit: sha, location: { label: "main", commit: sha, change: null } });
	const named = (sha: string) =>
		expect.objectContaining({
			commit: sha,
			location: { label: "main · pr:8 Keep coupons", commit: sha, change: "pr:8" },
		});
	await h.call("change", { change: "pr:8", state: "merged" });
	// Even when head and target already match, receiving the landing is a new fact.
	expect(
		await h.call("change", { change: "pr:8", state: "merged", landing: { commit, branch: "main" } }),
	).toMatchObject({
		already: false,
	});
	expect(
		await h.call("change", { change: "pr:8", state: "merged", landing: { commit, branch: "main" } }),
	).toMatchObject({
		already: true,
	});
	await h.call("change", { change: "pr:8", state: "merged" });
	expect(await history()).toContainEqual(named(commit));
	await h.call("change", { change: "pr:8", state: "merged", landing: { commit: corrected, branch: "main" } });
	expect(await history()).toContainEqual(plain(commit));
	expect(await history()).toContainEqual(named(corrected));
	await h.call("change", { change: "pr:8", state: "open" });
	expect(await history()).toContainEqual(plain(corrected));
	await h.call("change", { change: "pr:8", state: "merged" });
	expect(await history()).toContainEqual(plain(corrected));
	await h.call("change", { change: "pr:8", state: "merged", landing: { commit: corrected, branch: "main" } });
	expect(await history()).toContainEqual(named(corrected));
	await h.call("change", { change: "pr:8", state: "closed" });
	expect(await history()).toContainEqual(plain(corrected));
});
