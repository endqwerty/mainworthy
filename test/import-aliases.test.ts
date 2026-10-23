import { expect, test } from "bun:test";
import { z } from "zod";
import type { InboxReply, ProposeReply, ReportReceipt, ResultIn } from "../src/core/ops.ts";
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

const nameFormats = ["junit", "playwright", "jest", "vitest", "pytest", "trx", "typed"] as const;

function namedResults(format: (typeof nameFormats)[number], names: string[]): ResultIn[] {
	if (format === "typed") return names.map((name) => ({ test: { key: name, name }, outcome: "pass" }));
	let report: string;
	if (format === "junit")
		report = `<testsuite>${names.map((name) => `<testcase name="${name}"/>`).join("")}</testsuite>`;
	else if (format === "trx")
		report = `<TestRun><Results>${names.map((name, i) => `<UnitTestResult testId="${i}" testName="${name}" outcome="Passed"/>`).join("")}</Results></TestRun>`;
	else if (format === "playwright")
		report = JSON.stringify({
			suites: [
				{
					title: "tests.js",
					file: "tests.js",
					specs: names.map((title) => ({
						title,
						file: "tests.js",
						tests: [
							{
								projectName: "chromium",
								expectedStatus: "passed",
								results: [{ status: "passed", duration: 0, retry: 0 }],
							},
						],
					})),
				},
			],
		});
	else if (format === "pytest")
		report = JSON.stringify({
			exitcode: 0,
			tests: names.map((name) => ({
				nodeid: `test.py::test[${name}]`,
				outcome: "passed",
				call: { outcome: "passed", duration: 0 },
			})),
		});
	else
		report = JSON.stringify({
			testResults: [
				{
					name: "tests.js",
					status: "passed",
					assertionResults: names.map((title) => ({ title, ancestorTitles: [], status: "passed" })),
				},
			],
		});
	return parseReport(report, { file: `report.${format}`, format }).results;
}

const nameProbes = [
	["login @smoke", null],
	["login @smoke @C-2", 2],
	["mail user@example.com @C-2", 2],
	["renders @media queries", null],
	["checkout @C1234 then @C-2", 2],
	["checkout @C-2 then @C1234", 1],
	["checkout @C1234 then @unknown", 1],
	["login @C1234.", 1],
	["login @C1234@v1.", 1],
	["login @C1234,", 1],
	["login @C1234:", 1],
	["login @C1234!", 1],
	["login @C1234?", 1],
	["login @c-2", 2],
	["login @c-2@v1", 2],
	["login @c1234", null],
	["checkout @C-1 then @C-2", 2],
	["login @smoke@C-2", null],
	["login @C-2x", null],
	["login @C-2@v1x", null],
	["plain @C-2", 2],
] satisfies [string, number | null][];

test.each(nameFormats.flatMap((format) => nameProbes.map(([name, caseId]) => [format, name, caseId] as const)))(
	"%s name claim: %s",
	async (format, name, caseId) => {
		const h = await harness();
		try {
			await h.call("propose", {
				edits: [
					{ op: "create", body: { title: "Imported" }, aliases: ["C1234"] },
					{ op: "create", body: { title: "Other" } },
				],
			});
			const receipt = await h.call<ReportReceipt>("report", {
				target: { session: name },
				results: namedResults(format, [name]),
			});
			expect({ name, basis: receipt.basis, declined: receipt.declined }).toEqual({
				name,
				basis: {
					exact: caseId !== null && name.includes("@v1") ? 1 : 0,
					assumed: caseId !== null && !name.includes("@v1") ? 1 : 0,
					unresolved: caseId === null ? 1 : 0,
				},
				declined: [],
			});
			expect(h.app.db.raw.query("SELECT basis_case FROM results ORDER BY id DESC LIMIT 1").get()).toEqual({
				basis_case: caseId,
			});
		} finally {
			h.close();
		}
	},
);

test.each([...nameFormats])("%s Apply quartet preserves native refs and ignores tags and emails", async (format) => {
	const h = await harness();
	try {
		await h.call("propose", {
			edits: [
				{ op: "create", body: { title: "One" } },
				{ op: "create", body: { title: "Two" } },
			],
		});
		const receipt = await h.call<ReportReceipt>("report", {
			target: { session: "apply-quartet" },
			results: namedResults(format, ["login @smoke", "login @smoke @C-2", "mail user@example.com @C-2", "plain @C-2"]),
		});
		expect(receipt.basis).toEqual({ exact: 0, assumed: 3, unresolved: 1 });
		expect(receipt.declined).toEqual([]);
	} finally {
		h.close();
	}
});

test.each([...nameFormats])("%s ordinary tags preserve a test's queue-decided link", async (format) => {
	const h = await harness({ preset: "standard", unlinked: "ask" });
	try {
		await h.call("propose", { edits: [{ op: "create", body: { title: "Linked case" } }] });
		const results = namedResults(format, ["login @smoke"]);
		await h.call("report", { target: { session: "before-link" }, results });
		const question = (await h.call<InboxReply>("inbox", { kind: "map" })).items[0];
		if (!question) throw new Error("missing map question");
		const tests = z.object({ tests: z.array(z.object({ t: z.string() })) }).parse(question.evidence).tests;
		const t = tests[0]?.t;
		if (!t) throw new Error("missing test");
		expect(
			(
				await h.call<{ status: string }[]>("decide", {
					q: question.q,
					onEvidence: question.evidenceHash,
					answer: { is: "link", pairs: [[t, "C-1"]] },
				})
			)[0]?.status,
		).toBe("decided");
		const receipt = await h.call<ReportReceipt>("report", { target: { session: "after-link" }, results });
		expect(receipt.basis).toEqual({ exact: 0, assumed: 1, unresolved: 0 });
		expect(receipt.declined).toEqual([]);
		expect(h.app.db.raw.query("SELECT basis_case FROM results ORDER BY id DESC LIMIT 1").get()).toEqual({
			basis_case: 1,
		});
	} finally {
		h.close();
	}
});

test.each(reportCases)(
	"%s %s claims resolve imported aliases and distinguish names from explicit metadata",
	async (format, source) => {
		const h = await harness();
		try {
			const edits = parseCaseImport("ID,Title\nC1234,Imported\n", "testrail");
			await h.call("propose", { edits });
			await h.call("propose", { edits: [{ op: "create", body: { title: "Other case" } }] });
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
			if (source === "property")
				expect(parsed.results.map((result) => result.annotation)).toEqual([
					{ case: "C1234" },
					{ case: "C1234", version: 1 },
					{ case: "Missing123" },
					{ case: "C-1", version: 1 },
				]);
			const receipt = await h.call<ReportReceipt>("report", {
				target: { session: "aliases" },
				results: parsed.results,
			});
			expect(receipt).toMatchObject({
				counts: { total: 4, pass: 4 },
				rejected: [],
				basis: { exact: 2, assumed: 1, unresolved: 1 },
				declined:
					source === "property"
						? [{ index: 2, reason: "the annotation names Missing123, which does not exist: recorded with no case" }]
						: [],
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
	},
);

test.each(["junit", "playwright", "pytest"] as const)(
	"%s metadata keeps native refs uppercase-only",
	async (format) => {
		const h = await harness();
		try {
			await h.call("propose", {
				edits: [
					{ op: "create", body: { title: "One" } },
					{ op: "create", body: { title: "Two" } },
				],
			});
			const report =
				format === "junit"
					? '<testsuite><testcase name="login @C-1"><properties><property name="mainworthy" value="c-2"/></properties></testcase></testsuite>'
					: format === "playwright"
						? JSON.stringify({
								suites: [
									{
										title: "tests.js",
										file: "tests.js",
										specs: [
											{
												title: "login @C-1",
												file: "tests.js",
												tests: [
													{
														projectName: "chromium",
														expectedStatus: "passed",
														annotations: [{ type: "mainworthy", description: "c-2" }],
														results: [{ status: "passed", duration: 0, retry: 0 }],
													},
												],
											},
										],
									},
								],
							})
						: JSON.stringify({
								exitcode: 0,
								tests: [
									{
										nodeid: "test.py::login @C-1",
										outcome: "passed",
										call: { outcome: "passed", duration: 0 },
										user_properties: [{ mainworthy: "c-2" }],
									},
								],
							});
			const receipt = await h.call<ReportReceipt>("report", {
				target: { session: "lowercase-metadata" },
				results: parseReport(report, { file: `report.${format}`, format }).results,
			});
			expect(receipt.basis).toEqual({ exact: 0, assumed: 1, unresolved: 0 });
			expect(receipt.declined).toEqual([]);
			expect(h.app.db.raw.query("SELECT basis_case FROM results").get()).toEqual({ basis_case: 1 });
		} finally {
			h.close();
		}
	},
);

test("typed test names use the same alias claims as parsed reports", async () => {
	const h = await harness();
	try {
		await h.call("propose", { edits: [{ op: "create", body: { title: "Imported" }, aliases: ["Old.Id/123:case"] }] });
		const receipt = await h.call<ReportReceipt>("report", {
			target: { session: "typed-alias" },
			results: [
				{ test: { key: "known", name: "checks @Old.Id/123:case@v1" }, outcome: "pass" },
				{ test: { key: "unknown @Missing123" }, outcome: "pass" },
			],
		});
		expect(receipt.basis).toEqual({ exact: 1, assumed: 0, unresolved: 1 });
		expect(receipt.declined).toEqual([]);
	} finally {
		h.close();
	}
});

test("aliases are witnessed case creation and idempotent with propose", async () => {
	const h = await harness();
	try {
		const input = {
			edits: [{ op: "create", body: { title: "Imported" }, aliases: ["C1234"] }],
			cmd: "import-alias-once",
		};
		const first = await h.call<ProposeReply>("propose", input);
		expect(await h.call<ProposeReply>("propose", input)).toEqual(first);
		expect(await h.call("get", { refs: ["C1234"] })).toMatchObject([{ ref: "C-1", title: "Imported" }]);
		expect(await h.call("history", { ref: "C1234" })).toMatchObject({ versions: [{ version: 1 }] });
		const stored = h.app.db.raw.query<{ aliases: string }, []>("SELECT aliases FROM cases").get();
		expect(stored?.aliases).toBe('["C1234"]');
		expect(first.status).toBe("adopted");
	} finally {
		h.close();
	}
});

test("an alias conflict rolls back the whole proposal, including earlier new cases", async () => {
	const h = await harness();
	try {
		await h.call("propose", { edits: [{ op: "create", body: { title: "Existing" }, aliases: ["C1234"] }] });
		const refused = await h.raw("propose", {
			edits: [
				{ op: "create", body: { title: "Would be new" }, aliases: ["C1235"] },
				{ op: "create", body: { title: "Duplicate" }, aliases: ["C1234"] },
			],
		});
		expect(refused).toMatchObject({ ok: false, error: { code: "conflict" } });
		expect(await h.raw("get", { refs: ["C1235"] })).toMatchObject({ ok: false, error: { code: "not_found" } });
		expect(await h.call("find", {})).toMatchObject({ items: [{ title: "Existing" }] });
		expect(
			await h.raw("propose", {
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

test("pending proposals create no aliases and recheck alias ownership when adopted", async () => {
	const h = await harness({ preset: "strict" });
	try {
		const input = { edits: [{ op: "create", body: { title: "Imported" }, aliases: ["C1234"] }] };
		const first = await h.call<ProposeReply>("propose", input);
		const second = await h.call<ProposeReply>("propose", {
			edits: [{ op: "create", body: { title: "Also pending" }, aliases: ["OLD2"] }, ...input.edits],
		});
		expect(first.status).toBe("open");
		expect(second.status).toBe("open");
		expect(await h.raw("get", { refs: ["C1234"] })).toMatchObject({ ok: false, error: { code: "not_found" } });
		const items = (await h.call<{ items: { q: string; evidenceHash: string }[] }>("inbox")).items;
		const accept = async (q: string | null) => {
			const item = items.find((item) => item.q === q);
			if (!item) throw new Error("missing adoption question");
			return h.call<{ status: string }[]>("decide", {
				q: item.q,
				onEvidence: item.evidenceHash,
				answer: { is: "accept" },
				reason: "Accept imported cases",
			});
		};
		expect((await accept(first.question))[0]?.status).toBe("decided");
		expect((await accept(second.question))[0]?.status).toBe("conflict");
		expect(await h.raw("get", { refs: ["OLD2"] })).toMatchObject({ ok: false, error: { code: "not_found" } });
		expect(await h.call("get", { refs: ["C1234"] })).toMatchObject([{ ref: "C-1", title: "Imported" }]);
		expect((await h.call<{ items: unknown[] }>("find", {})).items).toHaveLength(1);
	} finally {
		h.close();
	}
});

test("the registry rejects reserved aliases and callers without produce capability", async () => {
	const h = await harness();
	try {
		for (const alias of ["C-1", "Q-1", "123", "bad alias"])
			expect(
				await h.raw("propose", { edits: [{ op: "create", body: { title: "Bad" }, aliases: [alias] }] }),
			).toMatchObject({
				ok: false,
				error: { code: "invalid" },
			});
		const reader = h.actor("reader", "human", ["read"]);
		expect(
			await h.raw(
				"propose",
				{ edits: [{ op: "create", body: { title: "No capability" }, aliases: ["OLD1"] }] },
				reader,
			),
		).toMatchObject({ ok: false, error: { code: "forbidden" } });
		expect((await h.call<{ items: unknown[] }>("find", {})).items).toHaveLength(0);
	} finally {
		h.close();
	}
});
