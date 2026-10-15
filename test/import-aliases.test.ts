import { expect, test } from "bun:test";
import type { ProposeReply, ReportReceipt } from "../src/core/ops.ts";
import { parseCaseImport } from "../src/surfaces/formats/cases.ts";
import { parseReport, type ReportFormat } from "../src/surfaces/formats/report.ts";
import { harness } from "./helpers.ts";

const reportCases = [
	["junit", "name"],
	["junit", "property"],
	["playwright", "name"],
	["playwright", "property"],
	["jest", "name"],
	["vitest", "name"],
	["pytest", "name"],
	["pytest", "property"],
	["trx", "name"],
] satisfies [ReportFormat, "name" | "property"][];

test.each(reportCases)("%s %s claims resolve imported aliases and keep unknown aliases unlinked", (format, source) => {
	const h = harness();
	try {
		const edits = parseCaseImport("ID,Title\nC1234,Imported\n", "testrail");
		h.call("propose", { edits });
		h.call("propose", { edits: [{ op: "create", body: { title: "Other case" } }] });
		const claims = ["C1234", "C1234@v1", "Missing123", "C-1@v1"];
		const names = claims.map((claim, i) => `test ${i} @${source === "property" ? "C-2" : claim}`);
		let report: string;
		if (format === "junit") {
			report = `<testsuite>${claims.map((claim, i) => `<testcase name="${names[i]}">${source === "property" ? `<properties><property name="mainworthy" value="C-2"/><property name="mainworthy" value="${claim}"/><property name="mainworthy" value="bad alias"/></properties>` : ""}</testcase>`).join("")}</testsuite>`;
		} else if (format === "trx") {
			report = `<TestRun><Results>${names.map((name, i) => `<UnitTestResult testId="${i}" testName="${name}" outcome="Passed"/>`).join("")}</Results></TestRun>`;
		} else if (format === "playwright") {
			report = JSON.stringify({
				suites: [
					{
						title: "tests.js",
						file: "tests.js",
						specs: names.map((title, i) => ({
							title,
							file: "tests.js",
							tests: [
								{
									projectName: "chromium",
									expectedStatus: "passed",
									annotations:
										source === "property"
											? [
													{ type: "mainworthy", description: "C-2" },
													{ type: "mainworthy", description: claims[i] },
													{ type: "mainworthy", description: "bad alias" },
													{ type: "skip" },
												]
											: [],
									results: [{ status: "passed", duration: 0, retry: 0 }],
								},
							],
						})),
					},
				],
			});
		} else if (format === "pytest") {
			report = JSON.stringify({
				exitcode: 0,
				tests: names.map((name, i) => ({
					nodeid: `test.py::test_alias[${name}]`,
					outcome: "passed",
					call: { outcome: "passed", duration: 0 },
					...(source === "property"
						? {
								user_properties: [
									{ mainworthy: "C-2" },
									{ mainworthy: claims[i] },
									{ mainworthy: "bad alias" },
									{ unrelated: 42 },
								],
							}
						: {}),
				})),
			});
		} else {
			report = JSON.stringify({
				testResults: [
					{
						name: "tests.js",
						status: "passed",
						assertionResults: names.map((title) => ({ title, ancestorTitles: [], status: "passed" })),
					},
				],
			});
		}
		const parsed = parseReport(report, { file: `report.${format}`, format });
		expect(parsed.results.map((result) => result.annotation)).toEqual([
			{ case: "C1234" },
			{ case: "C1234", version: 1 },
			{ case: "Missing123" },
			{ case: "C-1", version: 1 },
		]);
		const receipt = h.call<ReportReceipt>("report", { target: { session: "aliases" }, results: parsed.results });
		expect(receipt).toMatchObject({
			counts: { total: 4, pass: 4 },
			rejected: [],
			basis: { exact: 2, assumed: 1, unresolved: 1 },
			declined: [{ index: 2, reason: "the annotation names Missing123, which does not exist: recorded with no case" }],
		});
		expect(h.app.db.raw.query("SELECT basis, basis_case, basis_version FROM results ORDER BY id").all()).toEqual([
			{ basis: "assumed", basis_case: 1, basis_version: 1 },
			{ basis: "exact", basis_case: 1, basis_version: 1 },
			{ basis: "unresolved", basis_case: null, basis_version: null },
			{ basis: "exact", basis_case: 1, basis_version: 1 },
		]);
	} finally {
		h.close();
	}
});

test("typed test names use the same alias claims as parsed reports", () => {
	const h = harness();
	try {
		h.call("propose", { edits: [{ op: "create", body: { title: "Imported" }, aliases: ["Old.Id/123:case"] }] });
		const receipt = h.call<ReportReceipt>("report", {
			target: { session: "typed-alias" },
			results: [
				{ test: { key: "known", name: "checks @Old.Id/123:case@v1" }, outcome: "pass" },
				{ test: { key: "unknown @Missing123" }, outcome: "pass" },
			],
		});
		expect(receipt.basis).toEqual({ exact: 1, assumed: 0, unresolved: 1 });
		expect(receipt.declined).toEqual([
			{ index: 1, reason: "the annotation names Missing123, which does not exist: recorded with no case" },
		]);
	} finally {
		h.close();
	}
});

test("aliases are witnessed case creation and idempotent with propose", () => {
	const h = harness();
	try {
		const input = {
			edits: [{ op: "create", body: { title: "Imported" }, aliases: ["C1234"] }],
			cmd: "import-alias-once",
		};
		const first = h.call<ProposeReply>("propose", input);
		expect(h.call<ProposeReply>("propose", input)).toEqual(first);
		expect(h.call("get", { refs: ["C1234"] })).toMatchObject([{ ref: "C-1", title: "Imported" }]);
		expect(h.call("history", { ref: "C1234" })).toMatchObject({ versions: [{ version: 1 }] });
		const stored = h.app.db.raw.query<{ aliases: string }, []>("SELECT aliases FROM cases").get();
		expect(stored?.aliases).toBe('["C1234"]');
		expect(first.status).toBe("adopted");
	} finally {
		h.close();
	}
});

test("an alias conflict rolls back the whole proposal, including earlier new cases", () => {
	const h = harness();
	try {
		h.call("propose", { edits: [{ op: "create", body: { title: "Existing" }, aliases: ["C1234"] }] });
		const refused = h.raw("propose", {
			edits: [
				{ op: "create", body: { title: "Would be new" }, aliases: ["C1235"] },
				{ op: "create", body: { title: "Duplicate" }, aliases: ["C1234"] },
			],
		});
		expect(refused).toMatchObject({ ok: false, error: { code: "conflict" } });
		expect(h.raw("get", { refs: ["C1235"] })).toMatchObject({ ok: false, error: { code: "not_found" } });
		expect(h.call("find", {})).toMatchObject({ items: [{ title: "Existing" }] });
		expect(
			h.raw("propose", {
				edits: [
					{ op: "create", body: { title: "One" }, aliases: ["SAME"] },
					{ op: "create", body: { title: "Two" }, aliases: ["SAME"] },
				],
			}),
		).toMatchObject({ ok: false, error: { code: "conflict" } });
	} finally {
		h.close();
	}
});

test("pending proposals create no aliases and recheck alias ownership when adopted", () => {
	const h = harness({ preset: "strict" });
	try {
		const input = { edits: [{ op: "create", body: { title: "Imported" }, aliases: ["C1234"] }] };
		const first = h.call<ProposeReply>("propose", input);
		const second = h.call<ProposeReply>("propose", {
			edits: [{ op: "create", body: { title: "Also pending" }, aliases: ["OLD2"] }, ...input.edits],
		});
		expect(first.status).toBe("open");
		expect(second.status).toBe("open");
		expect(h.raw("get", { refs: ["C1234"] })).toMatchObject({ ok: false, error: { code: "not_found" } });
		const items = h.call<{ items: { q: string; evidenceHash: string }[] }>("inbox").items;
		const accept = (q: string | null) => {
			const item = items.find((item) => item.q === q);
			if (!item) throw new Error("missing adoption question");
			return h.call<{ status: string }[]>("decide", {
				q: item.q,
				onEvidence: item.evidenceHash,
				answer: { is: "accept" },
				reason: "Accept imported cases",
			});
		};
		expect(accept(first.question)[0]?.status).toBe("decided");
		expect(accept(second.question)[0]?.status).toBe("conflict");
		expect(h.raw("get", { refs: ["OLD2"] })).toMatchObject({ ok: false, error: { code: "not_found" } });
		expect(h.call("get", { refs: ["C1234"] })).toMatchObject([{ ref: "C-1", title: "Imported" }]);
		expect(h.call<{ items: unknown[] }>("find", {}).items).toHaveLength(1);
	} finally {
		h.close();
	}
});

test("the registry rejects reserved aliases and callers without produce capability", () => {
	const h = harness();
	try {
		for (const alias of ["C-1", "Q-1", "123", "bad alias"])
			expect(h.raw("propose", { edits: [{ op: "create", body: { title: "Bad" }, aliases: [alias] }] })).toMatchObject({
				ok: false,
				error: { code: "invalid" },
			});
		const reader = h.actor("reader", "human", ["read"]);
		expect(
			h.raw("propose", { edits: [{ op: "create", body: { title: "No capability" }, aliases: ["OLD1"] }] }, reader),
		).toMatchObject({ ok: false, error: { code: "forbidden" } });
		expect(h.call<{ items: unknown[] }>("find", {}).items).toHaveLength(0);
	} finally {
		h.close();
	}
});
