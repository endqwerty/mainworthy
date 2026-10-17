import { expect, test } from "bun:test";
import { ReportsReply } from "../src/core/replies.ts";
import { formatRate } from "../src/core/reports.ts";
import { evidenceReports } from "../src/server/evidence/reports.ts";
import { OPS } from "../src/server/ops/index.ts";
import { invoke } from "../src/server/ops/registry.ts";
import { harness } from "./helpers.ts";

test("reports count raw outcomes by UTC day, automation backlog and same-code flaky tests", () => {
	const h = harness();
	try {
		h.call("propose", { edits: [{ op: "create", outline: "Checkout @WEB-1\n  Pay > Receipt" }] });
		const ci = h.actor("pipeline", "ci", ["read", "record"]);
		const report = (attempt: number, outcome: string) =>
			h.call(
				"report",
				{
					target: { commit: "a".repeat(40), branch: "main" },
					job: "unit",
					attempt,
					results: [
						{
							test: { key: "checkout", name: "Checkout" },
							outcome,
							durationMs: 25,
							...(outcome === "fail" ? { failure: { message: "receipt missing" } } : {}),
						},
					],
				},
				ci,
			);
		report(1, "fail");
		h.advance(86_400_000);
		report(2, "pass");
		const read = ReportsReply.parse(h.call("reports"));
		expect(read.days.map(({ pass, total, passRate }) => ({ pass, total, passRate }))).toEqual([
			{ pass: 0, total: 1, passRate: 0 },
			{ pass: 1, total: 1, passRate: 1 },
		]);
		expect(read.automation.total).toBe(1);
		expect(read.automation.automated).toBe(0);
		expect(read.flaky).toMatchObject([{ key: "checkout", lanes: 1 }]);
		expect(read.reruns).toEqual({ count: 1, durationMs: 25, missingDuration: 0 });
	} finally {
		h.close();
	}
});

test("an empty project reports no evidence rather than a perfect pass rate", () => {
	const h = harness();
	try {
		const read = ReportsReply.parse(h.call("reports"));
		expect(read.days).toEqual([]);
		expect(read.automation.rate).toBeNull();
		expect(read.flaky).toEqual([]);
	} finally {
		h.close();
	}
});

test("current automation counts each active linked case once and coverage excludes archived cases", () => {
	const h = harness({ unlinked: "ask" });
	try {
		h.call("propose", {
			edits: [
				{ op: "create", body: { title: "Linked", automate: "wanted" }, covers: ["WEB-1"] },
				{ op: "create", body: { title: "Backlog", automate: "wanted" }, covers: ["WEB-2"] },
				{ op: "create", body: { title: "Archived", automate: "wanted" }, covers: ["WEB-3"] },
			],
		});
		h.call("report", {
			target: { commit: "b".repeat(40) },
			results: [
				{ test: { key: "one", file: "checkout.ts" }, outcome: "pass" },
				{ test: { key: "two", file: "checkout.ts" }, outcome: "pass" },
			],
		});
		const inbox = h.call<{ items: { q: string; kind: string; evidenceHash: string }[] }>("inbox");
		const map = inbox.items.find((item) => item.kind === "map");
		if (!map) throw new Error("missing mapping question");
		h.call("decide", {
			q: map.q,
			onEvidence: map.evidenceHash,
			answer: {
				is: "link",
				pairs: [
					["T-1", "C-1"],
					["T-2", "C-1"],
				],
			},
		});
		h.call("propose", { edits: [{ op: "state", cases: ["C-3"], to: "archived" }] });
		h.call("report", {
			target: { session: "manual-backlog" },
			results: [{ test: { case: "C-2" }, outcome: "pass" }],
		});
		expect(
			h
				.call<{ items: { ref: string }[] }>("find", { in: "tests" })
				.items.map(({ ref }) => ref)
				.sort(),
		).toEqual(["T-1", "T-2"]);
		const read = ReportsReply.parse(h.call("reports"));
		expect(read.automation).toEqual({
			total: 2,
			automated: 1,
			wanted: 1,
			rate: 0.5,
			backlog: [{ ref: "C-2", title: "Backlog" }],
		});
		expect(read.requirements).toMatchObject({
			total: 3,
			covered: 2,
			items: [
				{ key: "WEB-1", cases: 1 },
				{ key: "WEB-2", cases: 1 },
				{ key: "WEB-3", cases: 0 },
			],
		});
	} finally {
		h.close();
	}
});

test("flaky signals do not mix jobs, environments, commits or producers; corrections replace observations", () => {
	const h = harness();
	try {
		const ci = h.actor("ci-one", "ci", ["record", "read"]);
		const other = h.actor("ci-two", "ci", ["record", "read"]);
		const send = (job: string, commit: string, env: string, outcome: string, actor = ci, corrects?: number) =>
			h.call<{ results: number[] }>(
				"report",
				{
					target: { commit, env },
					job,
					results: [
						{
							test: { key: "same" },
							outcome,
							...(outcome === "fail" ? { failure: { message: "missing" } } : {}),
							...(corrects === undefined ? {} : { corrects }),
						},
					],
				},
				actor,
			);
		const commit = "c".repeat(40);
		send("a", commit, "one", "fail");
		send("b", commit, "one", "pass");
		send("a", commit, "two", "pass");
		send("a", "d".repeat(40), "one", "pass");
		send("a", commit, "one", "pass", other);
		expect(ReportsReply.parse(h.call("reports")).flaky).toEqual([]);
		const correction = send("correction", commit, "one", "fail");
		send("correction", commit, "one", "pass", ci, correction.results[0]);
		const read = ReportsReply.parse(h.call("reports"));
		expect(read.flaky).toEqual([]);
		expect(read.days.map((row) => [row.pass, row.total])).toEqual([[5, 6]]);
		expect(read.reruns).toEqual({ count: 0, durationMs: 0, missingDuration: 0 });
	} finally {
		h.close();
	}
});

test("time windows include today in UTC, count reruns after an older execution and reject invalid ranges", () => {
	const h = harness();
	try {
		const report = (attempt: number, outcome: string) =>
			h.call("report", { target: { commit: "e".repeat(40) }, attempt, results: [{ test: { key: "again" }, outcome }] });
		report(1, "pass");
		h.advance(31 * 86_400_000);
		report(2, "skip");
		const read = ReportsReply.parse(h.call("reports", { days: 1 }));
		expect(read.days.map((row) => [row.pass, row.total, row.passRate])).toEqual([[0, 1, 0]]);
		expect(read.reruns).toEqual({ count: 1, durationMs: 0, missingDuration: 1 });
		for (const days of [0, 367, 1.5]) expect(h.raw("reports", { days }).ok).toBe(false);
		const writer = h.actor("record-only", "ci", ["record"]);
		expect(h.raw("reports", {}, writer)).toMatchObject({ ok: false, error: { code: "forbidden" } });
		h.call("admin", { do: "project.create", key: "other" });
		const separate = invoke(h.app, OPS, {
			op: "report",
			project: "other",
			actor: () => h.owner,
			input: {
				target: { commit: "f".repeat(40) },
				results: [{ test: { key: "foreign" }, outcome: "pass" }],
			},
		});
		expect(separate.ok).toBe(true);
		const foreign = invoke(h.app, OPS, { op: "reports", project: "other", actor: () => h.owner, input: {} });
		if (!foreign.ok) throw new Error(foreign.error.message);
		expect(ReportsReply.parse(foreign.result).days.map((row) => row.total)).toEqual([1]);
		expect(ReportsReply.parse(h.call("reports", { days: 366 })).days.map((row) => row.total)).toEqual([1, 1]);
	} finally {
		h.close();
	}
});

test("report lists are capped while automation and requirement totals cover the whole suite", () => {
	const h = harness();
	try {
		h.call("propose", {
			edits: Array.from({ length: 105 }, (_, i) => ({
				op: "create",
				body: { title: `Wanted ${i}`, automate: "wanted" },
				covers: [`WEB-${i + 1}`],
			})),
		});
		const db = h.app.db;
		const all = db.all.bind(db);
		let caseRows = 0;
		db.all = ((statement, ...args) => {
			const rows = all(statement, ...args);
			if (statement.text.includes("FROM cases")) caseRows += rows.length;
			return rows;
		}) as typeof db.all;
		let read: ReturnType<typeof ReportsReply.parse>;
		try {
			read = ReportsReply.parse(h.call("reports"));
		} finally {
			db.all = all;
		}
		expect(caseRows, "automation totals return counts and the capped backlog, not every case").toBeLessThanOrEqual(50);
		expect(read.automation).toMatchObject({ total: 105, wanted: 105, automated: 0, rate: 0 });
		expect(read.automation.backlog.length).toBe(50);
		expect(read.automation.backlog.at(-1)).toEqual({ ref: "C-50", title: "Wanted 49" });
		expect(read.requirements).toMatchObject({ total: 105, covered: 105 });
		expect(read.requirements.items.length).toBe(100);
		expect(read.requirements.items.slice(0, 3).map((row) => row.key)).toEqual(["WEB-1", "WEB-2", "WEB-3"]);
		expect(read.requirements.items.at(-1)?.key).toBe("WEB-100");
		for (const outcome of ["fail", "pass"] as const)
			h.call("report", {
				target: { commit: "a".repeat(40) },
				attempt: outcome === "fail" ? 1 : 2,
				results: Array.from({ length: 55 }, (_, i) => ({
					test: { key: `flaky-${i}` },
					outcome,
					...(outcome === "fail" ? { failure: { message: "receipt missing" } } : {}),
				})),
			});
		const flaky = ReportsReply.parse(h.call("reports")).flaky;
		expect(flaky.length).toBe(50);
		expect(flaky.map((row) => [row.ref, row.lanes])).toEqual(Array.from({ length: 50 }, (_, i) => [`T-${i + 1}`, 1]));
	} finally {
		h.close();
	}
});

test("reruns follow sequence order when result times differ, including an earlier execution outside the window", () => {
	const h = harness();
	try {
		const send = (attempt: number, durationMs: number) =>
			h.call<{ results: number[] }>("report", {
				target: { commit: "f".repeat(40) },
				job: "unit:browser",
				attempt,
				results: [{ test: { key: "ordered" }, outcome: "pass", durationMs }],
			});
		const first = send(1, 10).results[0];
		h.advance(1_000);
		const second = send(2, 20).results[0];
		h.advance(1_000);
		send(3, 30);
		h.app.db.raw.query("UPDATE results SET at = (SELECT max(at) FROM results) WHERE id = ?").run(first ?? 0);
		expect(ReportsReply.parse(h.call("reports")).reruns).toEqual({ count: 2, durationMs: 50, missingDuration: 0 });
		h.app.db.raw.query("UPDATE results SET at = at + 86400000 WHERE id = ?").run(first ?? 0);
		expect(ReportsReply.parse(h.call("reports")).reruns).toEqual({ count: 2, durationMs: 50, missingDuration: 0 });
		h.app.db.raw.query("UPDATE results SET corrects = ? WHERE id = ?").run(first ?? 0, second ?? 0);
		expect(ReportsReply.parse(h.call("reports")).reruns).toEqual({ count: 1, durationMs: 30, missingDuration: 0 });
	} finally {
		h.close();
	}
});

test("repeated tests in one batch use the first ordinal when subtracting initial execution time", () => {
	const h = harness();
	try {
		h.call("report", {
			target: { commit: "a".repeat(40) },
			results: [
				{ test: { key: "same" }, outcome: "fail", durationMs: 10, failure: { message: "missing" } },
				{ test: { key: "same" }, outcome: "pass", durationMs: 20 },
			],
		});
		const read = ReportsReply.parse(h.call("reports"));
		expect(read.reruns).toEqual({ count: 1, durationMs: 20, missingDuration: 0 });
		expect(read.flaky.map((row) => [row.key, row.lanes])).toEqual([["same", 1]]);
	} finally {
		h.close();
	}
});

// Reference the former row-by-row aggregation, independently of the SQL report queries.
test.each([false, true])(
	"SQL reports match the row aggregation across seeded retries, targets, producers and methods (several jobs: %s)",
	(multipleJobs) => {
		const h = harness();
		try {
			h.call("propose", { edits: [{ op: "create", body: { title: "Manual check" } }] });
			const producers = [
				h.actor("pipeline-a", "ci", ["read", "record"]),
				h.actor("pipeline-b", "ci", ["read", "record"]),
			];
			const agent = h.actor("reviewer", "agent", ["read", "record"]);
			let state = 639;
			const random = () => {
				state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
				return state / 2 ** 32;
			};
			const outcomes = ["pass", "fail", "skip", "blocked", "error"] as const;
			for (let batch = 0; batch < 24; batch++) {
				if (batch % 4 === 0) h.advance(86_400_000);
				const actor = batch % 11 === 0 ? agent : producers[batch % 2];
				h.call(
					"report",
					{
						target: { commit: String(batch % 4).repeat(40), env: `env-${batch % 3}` },
						job: multipleJobs && batch % 5 === 0 ? "unit:browser" : "unit",
						attempt: batch + 1,
						results: Array.from({ length: 24 }, (_, i) => {
							const outcome = outcomes[Math.floor(random() * outcomes.length)];
							return {
								test: { key: `seeded-${i % 12}` },
								outcome,
								...(random() < 0.3 ? {} : { durationMs: Math.floor(random() * 40) }),
								...(outcome === "fail" ? { failure: { message: "receipt missing" } } : {}),
							};
						}),
					},
					actor,
				);
				if (batch % 9 === 0)
					h.call("report", {
						target: { session: `manual-${batch}` },
						results: [{ test: { case: "C-1" }, outcome: "pass", durationMs: 5 }],
					});
			}
			// Exercise corrected first executions, ordinal ties, and times that differ from sequence order.
			h.app.db.raw.exec("UPDATE results SET corrects = id - 1 WHERE id % 41 = 0 AND id > 1");
			h.app.db.raw.exec("UPDATE results SET at = at + 172800000 WHERE id % 19 = 0");
			h.app.db.raw.exec("UPDATE results SET at = at - 86400000 WHERE id % 23 = 0");
			h.advance(2 * 86_400_000);
			type Row = {
				test: number;
				target: number;
				actor: number;
				job: string;
				method: string;
				at: number;
				outcome: string;
				duration_ms: number | null;
				no: number;
				key: string;
				name: string;
			};
			const rows = h.app.db.raw
				.query<Row, []>(`SELECT r.*, b.job, t.no, t.key, t.name
 FROM results r JOIN batches b ON b.id = r.batch JOIN tests t ON t.id = r.test
 WHERE NOT EXISTS (SELECT 1 FROM results c WHERE c.corrects = r.id)
 ORDER BY (WITH RECURSIVE origin(id, corrects, seq, ord) AS (
 SELECT id, corrects, seq, ord FROM results WHERE id = r.id
 UNION ALL SELECT p.id, p.corrects, p.seq, p.ord FROM results p JOIN origin o ON p.id = o.corrects
 ) SELECT printf('%016x%016x', seq, ord) FROM origin WHERE corrects IS NULL)`)
				.all();
			for (const range of [1, 5, 30, 366]) {
				const read = ReportsReply.parse(h.call("reports", { days: range }));
				const days = new Map<string, { pass: number; total: number }>();
				const seen = new Set<string>();
				const lanes = new Map<string, { row: Row; pass: boolean; fail: boolean }>();
				const reruns = { count: 0, durationMs: 0, missingDuration: 0 };
				for (const row of rows) {
					const key = JSON.stringify([row.test, row.target, row.actor, row.job]);
					if (row.at >= read.from && row.at < read.to) {
						const day = new Date(row.at).toISOString().slice(0, 10);
						const counts = days.get(day) ?? { pass: 0, total: 0 };
						counts.total++;
						counts.pass += Number(row.outcome === "pass");
						days.set(day, counts);
						if (row.method === "auto") {
							if (seen.has(key)) {
								reruns.count++;
								reruns.durationMs += row.duration_ms ?? 0;
								reruns.missingDuration += Number(row.duration_ms === null);
							}
							const lane = lanes.get(key) ?? { row, pass: false, fail: false };
							lane.pass ||= row.outcome === "pass";
							lane.fail ||= row.outcome === "fail";
							lanes.set(key, lane);
						}
					}
					if (row.method === "auto") seen.add(key);
				}
				const flaky = new Map<number, { row: Row; lanes: number }>();
				for (const lane of lanes.values())
					if (lane.pass && lane.fail) {
						const counts = flaky.get(lane.row.test) ?? { row: lane.row, lanes: 0 };
						counts.lanes++;
						flaky.set(lane.row.test, counts);
					}
				const expected = {
					days: [...days]
						.sort(([a], [b]) => a.localeCompare(b))
						.map(([day, counts]) => ({ day, ...counts, passRate: counts.pass / counts.total })),
					flaky: [...flaky.values()]
						.sort((a, b) => b.lanes - a.lanes || a.row.no - b.row.no)
						.slice(0, 50)
						.map(({ row, lanes }) => ({ ref: `T-${row.no}`, key: row.key, name: row.name, lanes })),
					reruns,
				};
				expect({ days: read.days, flaky: read.flaky, reruns: read.reruns }).toEqual(expected);
			}
			const read = ReportsReply.parse(h.call("reports", { days: 366 }));
			const db = h.app.db;
			const all = db.all.bind(db);
			let returned = 0;
			db.all = ((statement, ...args) => {
				const rows = all(statement, ...args);
				returned += rows.length;
				return rows;
			}) as typeof db.all;
			try {
				const project = h.app.db.raw.query<{ id: number }, []>("SELECT id FROM projects WHERE key = 'scratch'").get();
				if (!project) throw new Error("missing project");
				expect(evidenceReports(db, { project: project.id, from: read.from, to: read.to })).toEqual({
					days: read.days,
					flaky: read.flaky,
					reruns: read.reruns,
				});
				expect(returned, "SQL returns day and test aggregates, not individual lanes").toBeLessThanOrEqual(
					read.days.length + 50 + 1,
				);
			} finally {
				db.all = all;
			}
		} finally {
			h.close();
		}
	},
);

test("a correction of the first execution after a retry keeps that retry's duration", () => {
	const h = harness();
	try {
		const send = (attempt: number, durationMs: number, corrects?: number) =>
			h.call<{ results: number[] }>("report", {
				target: { commit: "a".repeat(40) },
				job: "unit",
				attempt,
				results: [{ test: { key: "corrected-first" }, outcome: "pass", durationMs, ...(corrects ? { corrects } : {}) }],
			});
		const first = send(1, 10).results[0];
		send(2, 20);
		const correction = send(3, 30, first).results[0];
		expect(ReportsReply.parse(h.call("reports")).reruns).toEqual({ count: 1, durationMs: 20, missingDuration: 0 });
		send(4, 40, correction);
		expect(ReportsReply.parse(h.call("reports")).reruns).toEqual({ count: 1, durationMs: 20, missingDuration: 0 });
	} finally {
		h.close();
	}
});

test("excuses, ending answers, quarantine coverage and incomplete shards preserve observed reports", () => {
	const h = harness({ unlinked: "track" });
	try {
		const send = (commit: string, outcome: "pass" | "fail", shard?: { index: number; of: number }) =>
			h.call("report", {
				target: { commit, branch: "main" },
				job: "unit",
				...(shard ? { shard } : {}),
				results: [
					{
						test: { key: "observed" },
						outcome,
						durationMs: 25,
						...(outcome === "fail" ? { failure: { message: "receipt missing" } } : {}),
					},
				],
			});
		const answer = (is: "infra" | "defect") => {
			const q = h.call<{ items: { q: string; evidenceHash: string }[] }>("inbox", { kind: "failure" }).items[0];
			if (!q) throw new Error("missing failure question");
			h.call("decide", { q: q.q, onEvidence: q.evidenceHash, answer: { is }, reason: "Explain the observed failure" });
			return q.q;
		};
		send("a".repeat(40), "fail");
		answer("infra");
		const before = ReportsReply.parse(h.call("reports"));
		expect(before.days.map(({ pass, total }) => [pass, total])).toEqual([[0, 1]]);
		send("b".repeat(40), "fail");
		const q = answer("defect");
		send("c".repeat(40), "pass");
		expect(h.call<{ state: string }[]>("get", { refs: [q] })[0]?.state).toBe("dissolved");
		const p = h.call<{ question: string }>("propose", {
			edits: [{ op: "quarantine", test: "T-1", base: null, exit: { kind: "passes", count: 1 } }],
			reason: "Observe quarantine without hiding outcomes",
		});
		const adopt = h.call<{ q: string; evidenceHash: string }[]>("get", { refs: [p.question] })[0];
		if (!adopt) throw new Error("missing quarantine proposal");
		h.call("decide", {
			q: adopt.q,
			onEvidence: adopt.evidenceHash,
			answer: { is: "accept" },
			reason: "Keep the intermittent test visible",
		});
		send("d".repeat(40), "fail", { index: 1, of: 2 });
		expect(h.call<{ verdict: string }>("gate", { commit: "d".repeat(40) }).verdict).toBe("pending");
		send("d".repeat(40), "pass", { index: 2, of: 2 });
		send("e".repeat(40), "pass");
		expect(h.call<{ quarantine: { active: boolean } }[]>("get", { refs: ["T-1"] })[0]?.quarantine.active).toBe(false);
		const read = ReportsReply.parse(h.call("reports"));
		expect(read.days.map(({ pass, total }) => [pass, total])).toEqual([[3, 6]]);
		expect(read.flaky).toMatchObject([{ ref: "T-1", lanes: 1 }]);
		expect(read.reruns).toEqual({ count: 1, durationMs: 25, missingDuration: 0 });
		expect(read.automation).toEqual({ total: 0, automated: 0, wanted: 0, rate: null, backlog: [] });
	} finally {
		h.close();
	}
});

test("a rate shows 100.0% only when everything passed, and 0.0% only when nothing did", () => {
	expect(formatRate(1)).toBe("100.0%");
	expect(formatRate(3599 / 3600)).toBe("99.9%");
	expect(formatRate(0.9996)).toBe("99.9%");
	expect(formatRate(0.5)).toBe("50.0%");
	expect(formatRate(1 / 10_000)).toBe("0.1%");
	expect(formatRate(0)).toBe("0.0%");
	expect(formatRate(null)).toBe("No cases");
});

test("two live corrections share one execution while both outcomes remain observed", () => {
	const h = harness();
	try {
		const send = (outcome: "pass" | "fail", durationMs: number, corrects?: number) =>
			h.call<{ results: number[] }>("report", {
				target: { commit: "a".repeat(40) },
				job: "unit",
				results: [
					{
						test: { key: "two-corrections" },
						outcome,
						durationMs,
						...(outcome === "fail" ? { failure: { message: "missing" } } : {}),
						...(corrects ? { corrects } : {}),
					},
				],
			}).results[0];
		const original = send("pass", 10);
		const correction = send("fail", 30, original);
		send("pass", 40, original);
		let read = ReportsReply.parse(h.call("reports"));
		expect(read.days.map(({ pass, total }) => [pass, total])).toEqual([[1, 2]]);
		expect(read.flaky.map(({ key, lanes }) => [key, lanes])).toEqual([["two-corrections", 1]]);
		expect(read.reruns).toEqual({ count: 0, durationMs: 0, missingDuration: 0 });
		const retry = send("pass", 20);
		send("pass", 50, correction);
		read = ReportsReply.parse(h.call("reports"));
		expect(read.days.map(({ pass, total }) => [pass, total])).toEqual([[3, 3]]);
		expect(read.flaky).toEqual([]);
		expect(read.reruns).toEqual({ count: 1, durationMs: 20, missingDuration: 0 });
		send("fail", 60, retry);
		const latest = send("pass", 70, retry);
		read = ReportsReply.parse(h.call("reports"));
		expect(read.days.map(({ pass, total }) => [pass, total])).toEqual([[3, 4]]);
		expect(read.flaky.map(({ key, lanes }) => [key, lanes])).toEqual([["two-corrections", 1]]);
		expect(read.reruns).toEqual({ count: 1, durationMs: 70, missingDuration: 0 });
		h.advance(40 * 86_400_000);
		h.call("report", {
			target: { commit: "a".repeat(40) },
			job: "unit",
			results: [{ test: { key: "two-corrections" }, outcome: "pass", corrects: latest }],
		});
		read = ReportsReply.parse(h.call("reports", { days: 1 }));
		expect(read.days.map(({ pass, total }) => [pass, total])).toEqual([[1, 1]]);
		expect(read.flaky).toEqual([]);
		expect(read.reruns).toEqual({ count: 1, durationMs: 0, missingDuration: 1 });
	} finally {
		h.close();
	}
});
