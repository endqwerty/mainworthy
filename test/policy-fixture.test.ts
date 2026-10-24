import { expect, test } from "bun:test";
import { z } from "zod";
import { canonicalJson } from "../src/core/hash.ts";
import { type Harness, harness } from "./helpers.ts";
import { policyReport, seedPolicyChanges } from "./policy-fixture.ts";

// Only clocks and the random project identity differ. IDs, hashes, revisions, edges and array order must agree.
function normalized(value: unknown): unknown {
	if (typeof value === "string" && /^[[{]/.test(value)) return normalized(JSON.parse(value));
	if (Array.isArray(value)) return value.map(normalized);
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.filter(([key]) => !["at", "created_at", "updated_at", "opened_at", "identity"].includes(key))
				.map(([key, item]) => [key, normalized(item)]),
		);
	}
	return value;
}

async function graph(h: Harness): Promise<Record<string, unknown>> {
	return await h.app.database.read(async (db) => {
		const tables = await db.allDynamic<{ table_name: string }>(
			"SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name",
		);
		const rows: Record<string, unknown> = {};
		for (const { table_name } of tables) {
			const data = await db.allDynamic(`SELECT * FROM "${table_name}"`);
			rows[table_name] = data.map((row) => canonicalJson(normalized(row))).sort();
		}
		return rows;
	});
}

async function adopt(h: Harness, count: number): Promise<unknown[]> {
	const proposal = z
		.object({ status: z.literal("open"), question: z.string() })
		.parse(await h.call("propose", { edits: [{ op: "policy", preset: "loose" }] }));
	const [question] = await h.call<unknown[]>("get", { refs: [proposal.question] });
	const { evidenceHash } = z.object({ evidenceHash: z.string() }).parse(question);
	expect(
		await h.call("decide", {
			q: proposal.question,
			onEvidence: evidenceHash,
			answer: { is: "accept" },
			reason: "Adopt the loose policy",
		}),
	).toMatchObject([{ status: "decided" }]);
	const gates: unknown[] = [];
	for (let pr = 1; pr <= count; pr++) {
		const gate = await h.call("gate", { change: `pr:${pr}` });
		expect(gate).toMatchObject({ verdict: "blocked", tally: { pass: 9, unexplained: 1 } });
		gates.push(normalized(gate));
	}
	return gates;
}

for (const count of [3, 7]) {
	test(`bulk policy fixture matches ${count} real reports before and after policy adoption`, async () => {
		const real = await harness({ project: "policy-latency", preset: "standard", unlinked: "ask" });
		const bulk = await harness({ project: "policy-latency", preset: "standard", unlinked: "ask" });
		try {
			for (let pr = 1; pr <= count; pr++) {
				expect(await real.raw("report", policyReport(pr))).toMatchObject({
					ok: true,
					result: { fresh: true, counts: { total: 10, fail: 1 } },
				});
			}
			await seedPolicyChanges(bulk, count);
			expect(await graph(bulk)).toEqual(await graph(real));
			expect(await adopt(bulk, count)).toEqual(await adopt(real, count));
			expect(await graph(bulk)).toEqual(await graph(real));
		} finally {
			await real.close();
			await bulk.close();
		}
	});
}
