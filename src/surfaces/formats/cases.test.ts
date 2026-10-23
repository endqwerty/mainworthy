import { expect, test } from "bun:test";
import { CaseAlias } from "../../core/ops.ts";
import { parseCaseImport } from "./cases.ts";

const cell = (value: string) => `"${value.replaceAll('"', '""')}"`;
const table = (rows: string[][]) => rows.map((row) => row.map(cell).join(",")).join("\r\n");

test("execution-type diagnostics quote only the value and keep the complete guidance", () => {
	const kind = `x\n::error::x\u001b]0;x\u0007\u0085\u202e${"y".repeat(200)}`;
	expect(() =>
		parseCaseImport(
			table([
				["title", "execution_type"],
				["One", kind],
			]),
			"csv",
		),
	).toThrow(
		`CSV record 2: unknown execution type "x\\n::error::x\\u001b]0;x\\u0007\\u0085\\u202e${"y".repeat(200)}"; use manual, automated, to-be-automated or not-applicable`,
	);
});

test("CSV keeps multiline text, doubled quotes, commas, Unicode and source history", () => {
	const history = JSON.stringify([{ at: "2020-01-02", title: "Earlier title" }]);
	const edits = parseCaseImport(
		`\uFEFF${table([
			["id", "title", "preconditions", "steps", "expected", "execution_type", "history"],
			[
				"OLD1",
				'Check "東京", please',
				"Signed in\r\nwith credits",
				"Open\nthen wait",
				'It says "yes"',
				"not-applicable",
				history,
			],
		])}`,
		"csv",
	);
	expect(edits[0]).toMatchObject({
		aliases: ["OLD1"],
		body: {
			title: 'Check "東京", please',
			pre: "Signed in\r\nwith credits",
			automate: "not-applicable",
			steps: [{ action: "Open\nthen wait", expected: 'It says "yes"' }],
		},
	});
	expect(Object.values(edits[0]?.body?.fields ?? {})[0]).toContain(JSON.stringify(history));
});

test("TestRail maps published sample headers, nested sections and separated continuation rows", () => {
	const edits = parseCaseImport(
		table([
			[
				"ID",
				"Title",
				"Type",
				"Section",
				"Section Depth",
				"Steps (Step)",
				"Steps (Expected Result)",
				"Created On",
				"References",
			],
			["C1234", "Sign in", "Automated", "Accounts", "0", "Open", "Shown", "4/24/2023 3:49 PM", "AUTH-1, external link"],
			["", "", "", "", "", "Enter credentials", "Signed in", "", ""],
			["C1235", "Sign out", "Functional", "Sessions", "1", "Leave", "Signed out", "", ""],
		]),
		"testrail",
	);
	expect(edits).toHaveLength(2);
	expect(edits[0]).toMatchObject({
		folder: "Accounts",
		aliases: ["C1234"],
		covers: ["AUTH-1"],
		body: {
			methods: ["auto"],
			steps: [
				{ action: "Open", expected: "Shown" },
				{ action: "Enter credentials", expected: "Signed in" },
			],
		},
	});
	expect(edits[1]).toMatchObject({ folder: "Accounts/Sessions", body: { methods: ["human"] } });
	expect(Object.values(edits[0]?.body?.fields ?? {})).toHaveLength(2);
});

test("Qase v1 uses automation slugs, suite definitions and numbered action/result/data columns", () => {
	const edits = parseCaseImport(
		table([
			[
				"id",
				"title",
				"suite_id",
				"suite_parent_id",
				"suite",
				"suite_without_cases",
				"automation",
				"steps_actions",
				"steps_result",
				"steps_data",
				"tags",
			],
			["", "", "1", "", "Accounts", "1", "", "", "", "", ""],
			["", "", "2", "1", "Sessions", "1", "", "", "", "", ""],
			[
				"7",
				"Sign in",
				"2",
				"1",
				"Sessions",
				"",
				"to-be-automated",
				"1. Open\n2. Submit\n",
				"1. Shown\n2. \n",
				"1. Login page\n2. \n",
				"smoke,Sprint 50",
			],
		]),
		"qase",
		"PAY",
	);
	expect(edits).toHaveLength(1);
	expect(edits[0]).toMatchObject({
		aliases: ["PAY-7"],
		folder: "Accounts/Sessions",
		tags: ["smoke"],
		body: {
			methods: ["human"],
			automate: "wanted",
			steps: [
				{ action: "Open\n\nData: Login page", expected: "Shown" },
				{ action: "Submit", expected: null },
			],
		},
	});
});

test("Qase v2 decodes JSON string steps and keeps child-step paths", () => {
	const edits = parseCaseImport(
		table([
			["v2.id", "title", "automation", "steps_type", "steps_actions", "steps_result"],
			[
				"8",
				"Sign in",
				"automated",
				"classic",
				`1. ${JSON.stringify('Open\n"quoted", page')}\n\t1. ${JSON.stringify("Enter")}`,
				`1. ${JSON.stringify("Ready")}\n\t1. ""`,
			],
			["9", "Gherkin", "is-not-automated", "gherkin", "1. Given a page\n2. When opened", '1. ""\n2. ""'],
		]),
		"qase",
	);
	expect(edits[0]).toMatchObject({
		aliases: ["QASE-8"],
		body: {
			methods: ["auto"],
			steps: [
				{ action: 'Open\n"quoted", page', expected: "Ready" },
				{ action: "[1.1] Enter", expected: null },
			],
		},
	});
	expect(edits[1]?.body?.steps).toHaveLength(2);
});

test.each([
	['title\n"unfinished', "unclosed"],
	['title\n"closed"x', "unexpected"],
	['title\nx"y', "unexpected"],
	["title,title\nx,y", "unique"],
	["id\nX1", "title column"],
	["title\nx,y", "more values"],
	["title\n", "no cases"],
	["id,title\nOLD1,One\nOLD1,Two", "duplicate"],
	["id,title\n123,One", "Invalid string"],
	["title,execution_type\nOne,robot", "unknown execution"],
	["title,expected\nOne,Ready", "no step action"],
])("malformed CSV is rejected before proposing: %j", (text, message) => {
	expect(() => parseCaseImport(text, "csv")).toThrow(message);
});

test("Qase inconsistent suites, broken parents and mismatched steps are rejected", () => {
	expect(() => parseCaseImport("id,title,suite_id,suite_parent_id,suite\n1,One,1,1,Loop", "qase")).toThrow("cycle");
	expect(() => parseCaseImport("id,title,suite_id,suite_parent_id,suite\n1,One,1,2,Child", "qase")).toThrow("missing");
	expect(() =>
		parseCaseImport(
			table([
				["id", "title", "steps_actions", "steps_result"],
				["1", "One", "1. Open", "1. Ready\n2. Extra"],
			]),
			"qase",
		),
	).toThrow("matching");
	expect(() => parseCaseImport("id,title,automation\n1,One,custom-automation", "qase")).toThrow("unknown execution");
});

test.each(["C-1", "c-12", "Q-1", "R-anything", "P-3", "T-2", "123", "bad alias", "", "x".repeat(121)])(
	"aliases cannot shadow native references: %j",
	(alias) => {
		expect(CaseAlias.safeParse(alias).success).toBe(false);
	},
);

test("5001 cases are refused as one import instead of silently splitting writes", () => {
	expect(() =>
		parseCaseImport(`title\n${Array.from({ length: 5001 }, (_, i) => `Case ${i}`).join("\n")}`, "csv"),
	).toThrow("at most 5,000");
});
