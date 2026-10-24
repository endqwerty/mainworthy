import { expect, test } from "bun:test";
import { sameCodeEvidence, sameCodeEvidenceByTests } from "../src/server/evidence/flaky.ts";
import { ciReport, harness } from "./helpers.ts";

const settings = { enabled: true, windowDays: 14, minFlips: 2 };

test("same-code evidence batches tests without sharing signature counts or samples", async () => {
	const h = await harness();
	try {
		for (let i = 1; i <= 4; i++) {
			await h.call("report", ciReport({ commit: `batch-sample-${i}`, n: 3, attempt: 1 }));
			await h.call(
				"report",
				ciReport({
					commit: `batch-sample-${i}`,
					n: 3,
					attempt: 2,
					fail: { 0: "shared assertion", 1: "shared assertion", 2: "separate assertion" },
				}),
			);
		}
		const input = { project: 1, now: h.app.now(), settings };
		const expected = await h.app.database.read(
			async (db) =>
				new Map([
					[1, await sameCodeEvidence(db, { ...input, test: 1 })],
					[2, await sameCodeEvidence(db, { ...input, test: 2 })],
					[3, await sameCodeEvidence(db, { ...input, test: 3 })],
					[999, await sameCodeEvidence(db, { ...input, test: 999 })],
				]),
		);
		const actual = await h.app.database.read(async (db) => {
			const before = h.app.database.statementCount;
			const result = await sameCodeEvidenceByTests(db, { ...input, tests: [1, 2, 3, 999, 1] });
			expect(h.app.database.statementCount - before).toBeLessThanOrEqual(3);
			return result;
		});
		expect(actual).toEqual(expected);
		for (const id of [1, 2, 3]) {
			expect(actual.get(id)?.signals).toHaveLength(1);
			expect(actual.get(id)?.signals[0]).toMatchObject({ flips: 4, suggested: true });
			expect(actual.get(id)?.signals[0]?.samples.map(({ commit }) => commit)).toEqual(
				[4, 3, 2].map((i) => `batch-sample-${i}`),
			);
		}
		expect(actual.get(999)?.signals).toEqual([]);
		await h.app.database.read(async (db) => {
			let before = h.app.database.statementCount;
			expect(await sameCodeEvidenceByTests(db, { ...input, tests: [] })).toEqual(new Map());
			expect(h.app.database.statementCount - before).toBe(0);
			before = h.app.database.statementCount;
			expect([
				...(
					await sameCodeEvidenceByTests(db, { ...input, tests: [1, 2], settings: { ...settings, enabled: false } })
				).values(),
			]).toEqual([1, 2].map(() => ({ ...settings, enabled: false, signals: [] })));
			expect(h.app.database.statementCount - before).toBe(0);
			for (const changed of [{ project: 999 }, { now: input.now + 15 * 86_400_000 }]) {
				const result = await sameCodeEvidenceByTests(db, { ...input, ...changed, tests: [1, 2, 3] });
				expect([...result.values()].every(({ signals }) => signals.length === 0)).toBe(true);
			}
		});
		await h.call("report", ciReport({ commit: "fresh-sample", n: 1, attempt: 1 }));
		await h.call("report", ciReport({ commit: "fresh-sample", n: 1, attempt: 2, fail: { 0: "shared assertion" } }));
		const fresh = await h.app.database.read((db) =>
			sameCodeEvidenceByTests(db, { ...input, now: h.app.now(), tests: [1, 2] }),
		);
		expect(fresh.get(1)?.signals[0]).toMatchObject({ flips: 5 });
		expect(fresh.get(1)?.signals[0]?.samples[0]?.commit).toBe("fresh-sample");
		expect(fresh.get(2)).toEqual(actual.get(2));
	} finally {
		await h.close();
	}
});
