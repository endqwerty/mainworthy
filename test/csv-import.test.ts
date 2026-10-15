import { expect, test } from "bun:test";
import { z } from "zod";
import { withInstance } from "../src/cli/test-support.ts";
import type { Policy } from "../src/core/kinds.ts";
import type { InboxReply, ProposeReply } from "../src/core/ops.ts";
import { type Harness, harness } from "./helpers.ts";

const Preview = z.object({
	create: z.number(),
	refused: z.number(),
	confirmation: z.string().nullable(),
	rows: z.array(z.object({ record: z.number(), alias: z.string().nullable(), errors: z.array(z.string()) })),
	proposal: z.object({ status: z.string(), cases: z.array(z.object({ ref: z.string() })) }).nullable(),
});
const mapping = { id: "ID", title: "Title", steps: "Steps", expected: "Expected", folder: "Section" };
const csv =
	'ID,Title,Steps,Expected,Section\r\nC1234,"Sign in, again","Open\nSubmit","Welcome, robin",Accounts/Login\r\n';

function fields(h: Harness): void {
	const policy = h.call<Policy & { version: number }>("admin", { do: "policy.show", project: "scratch" });
	const proposal = h.call<ProposeReply>("propose", {
		edits: [
			{
				op: "policy",
				base: policy.version,
				settings: {
					...policy.settings,
					fields: {
						priority: { kind: "choice", label: "Priority", required: true, choices: ["High", "Low"] },
					},
				},
			},
		],
	});
	const question = h.call<InboxReply>("inbox", { kind: "adopt" }).items.find((item) => item.q === proposal.question);
	if (!question) throw new Error("missing policy question");
	expect(
		h.call("decide", { q: question.q, onEvidence: question.evidenceHash, answer: { is: "accept" } }),
	).toMatchObject([{ status: "decided" }]);
}

test("CSV preview creates no cases, confirms the mapping, and refuses repeated foreign aliases", () => {
	const h = harness();
	try {
		const preview = Preview.parse(h.call("import-csv", { csv, mapping }));
		expect(preview).toMatchObject({
			create: 1,
			refused: 0,
			proposal: null,
			rows: [{ record: 2, alias: "C1234", errors: [] }],
		});
		expect(preview.confirmation).toMatch(/^[a-f0-9]+$/);
		expect(h.call("find", { what: "cases" })).toMatchObject({ items: [] });
		const imported = Preview.parse(
			h.call("import-csv", { csv, mapping, confirm: preview.confirmation, cmd: "csv-import-1" }),
		);
		expect(imported.proposal).toMatchObject({ status: "adopted", cases: [{ ref: "C-1" }] });
		expect(h.call("get", { refs: ["C1234"] })).toMatchObject([
			{
				ref: "C-1",
				title: "Sign in, again",
				folder: { path: "Accounts/Login" },
				steps: [{ action: "Open\nSubmit", expected: "Welcome, robin" }],
			},
		]);
		expect(
			Preview.parse(h.call("import-csv", { csv, mapping, confirm: preview.confirmation, cmd: "csv-import-1" })),
		).toEqual(imported);
		expect(Preview.parse(h.call("import-csv", { csv, mapping }))).toMatchObject({
			create: 0,
			refused: 1,
			confirmation: null,
			rows: [{ errors: ["case alias C1234 is already in use"] }],
		});
		expect(h.raw("import-csv", { csv, mapping, confirm: preview.confirmation })).toMatchObject({
			ok: false,
			error: { code: "invalid" },
		});
		expect(h.call("find", { what: "cases" })).toMatchObject({ count: 1 });
	} finally {
		h.close();
	}
});

test("CSV rows report missing definitions, invalid values, missing ids and titles, and duplicate ids before any write", () => {
	const h = harness();
	try {
		fields(h);
		const source =
			"ID,Title,Priority,Extra\nC10,Good,High,x\nC11,Bad,Medium,x\nC10,Duplicate,Low,x\n,No id,High,x\nC12,,High,x";
		const mapped = { id: "ID", title: "Title", fields: { priority: "Priority" } };
		const preview = Preview.parse(h.call("import-csv", { csv: source, mapping: mapped }));
		expect(preview).toMatchObject({ create: 0, refused: 5, confirmation: null });
		expect(preview.rows.map((row) => row.errors.join("; "))).toEqual([
			"duplicate case alias C10 in this CSV",
			"priority: choose one of High, Low",
			"duplicate case alias C10 in this CSV",
			"foreign id is required",
			"case title must contain 1 to 300 characters",
		]);
		const missing = Preview.parse(
			h.call("import-csv", {
				csv: "ID,Title,Extra\nC9,New,x",
				mapping: { id: "ID", title: "Title", fields: { absent: "Extra" } },
			}),
		);
		expect(missing.rows[0]?.errors).toEqual([
			"custom field absent has no project definition",
			"priority: Priority is required",
		]);
		expect(h.call("find", { what: "cases" })).toMatchObject({ count: 0 });
	} finally {
		h.close();
	}
});

test("CSV confirmation refuses changed files and definitions, and policy still decides adoption", () => {
	const h = harness();
	try {
		const preview = Preview.parse(h.call("import-csv", { csv, mapping }));
		expect(
			h.raw("import-csv", { csv: csv.replace("Sign in", "Sign out"), mapping, confirm: preview.confirmation }),
		).toMatchObject({ ok: false, error: { code: "conflict" } });
		fields(h);
		expect(h.raw("import-csv", { csv, mapping, confirm: preview.confirmation })).toMatchObject({
			ok: false,
			error: { code: "invalid" },
		});
		expect(h.call("find", { what: "cases" })).toMatchObject({ count: 0 });
	} finally {
		h.close();
	}
	const strict = harness({ preset: "strict" });
	try {
		const preview = Preview.parse(strict.call("import-csv", { csv, mapping }));
		expect(
			Preview.parse(strict.call("import-csv", { csv, mapping, confirm: preview.confirmation })).proposal,
		).toMatchObject({ status: "open", cases: [] });
		expect(strict.call("find", { what: "cases" })).toMatchObject({ count: 0 });
	} finally {
		strict.close();
	}
});

test("CSV maps project fields and execution intent and imports 2,000 cases and every alias", () => {
	const h = harness();
	try {
		fields(h);
		const source =
			"ID,Title,Priority,Execution\n" +
			Array.from(
				{ length: 2000 },
				(_, i) => `OLD${i + 1},Imported ${i + 1},High,${i % 2 ? "automated" : "to-be-automated"}`,
			).join("\n");
		const mapped = { id: "ID", title: "Title", execution: "Execution", fields: { priority: "Priority" } };
		const preview = Preview.parse(h.call("import-csv", { csv: source, mapping: mapped }));
		expect(preview).toMatchObject({ create: 2000, refused: 0 });
		const result = Preview.parse(h.call("import-csv", { csv: source, mapping: mapped, confirm: preview.confirmation }));
		expect(result.proposal?.cases).toHaveLength(2000);
		for (let start = 0; start < 2000; start += 200) {
			const rows = z
				.array(z.object({ ref: z.string(), title: z.string(), methods: z.array(z.string()), automate: z.string() }))
				.parse(h.call("get", { refs: Array.from({ length: 200 }, (_, i) => `OLD${start + i + 1}`) }));
			expect(rows).toHaveLength(200);
			for (const [i, row] of rows.entries()) {
				const n = start + i + 1;
				expect(row).toMatchObject({
					ref: `C-${n}`,
					title: `Imported ${n}`,
					methods: n % 2 ? ["human"] : ["auto"],
					automate: n % 2 ? "wanted" : "none",
				});
			}
		}
		const md = h.call<{ md: string }[]>("get", { refs: ["OLD2000"], as: "md" });
		expect(md[0]?.md).toContain("priority: High");
	} finally {
		h.close();
	}
});

test("CSV import is reachable through the generated CLI and real HTTP reply contract", async () => {
	await withInstance(async ({ cli, client }) => {
		const preview = await cli(["import-csv", "--json", JSON.stringify({ csv, mapping })]);
		expect(preview).toMatchObject({ code: 0, stderr: "" });
		const plan = Preview.parse(JSON.parse(preview.stdout));
		const imported = Preview.parse(await client.call("import-csv", { csv, mapping, confirm: plan.confirmation ?? "" }));
		expect(imported.proposal).toMatchObject({ status: "adopted", cases: [{ ref: "C-1" }] });
	});
});

test("CSV file adapter previews, confirms, and rejects invalid UTF-8", async () => {
	await withInstance(async ({ run, directory, client }) => {
		const file = `${directory}/mapped.csv`;
		await Bun.write(file, csv);
		const args = ["import-csv", file, "--mapping", JSON.stringify(mapping), "--json"];
		const preview = await run(args);
		expect(preview).toMatchObject({ code: 0, stderr: "" });
		const plan = Preview.parse(JSON.parse(preview.stdout));
		const imported = await run([...args, "--confirm", plan.confirmation ?? "", "--cmd", "file-csv-import"]);
		expect(imported).toMatchObject({ code: 0, stderr: "" });
		expect(Preview.parse(JSON.parse(imported.stdout)).proposal).toMatchObject({ status: "adopted" });
		expect(await client.call("get", { refs: ["C1234"] })).toMatchObject([{ title: "Sign in, again" }]);
		await Bun.write(file, new Uint8Array([0xff, 0xfe]));
		expect(await run(args)).toMatchObject({ code: 4, stderr: expect.stringContaining("UTF-8") });
	});
});

test("TestRail preset uses documented headers and section depth, and refuses separate-row exports", () => {
	const h = harness();
	try {
		const source =
			"ID,Title,Section,Section Depth,Priority,Steps (Expected Result)\nC3863,Dialogs,Administration,0,High,\nC3897,Print,Users,1,Low,";
		const preview = h.call<Record<string, unknown>>("import-csv", { csv: source, preset: "testrail" });
		expect(preview).toMatchObject({
			create: 2,
			refused: 0,
			rows: [{ folder: "Administration" }, { folder: "Administration/Users" }],
		});
		const plan = Preview.parse(preview);
		expect(
			Preview.parse(h.call("import-csv", { csv: source, preset: "testrail", confirm: plan.confirmation })).proposal,
		).toMatchObject({ status: "adopted" });
		const separate = Preview.parse(
			h.call("import-csv", { csv: "ID,Title,Steps (Step)\nC55,One,Open\n,,Continue", preset: "testrail" }),
		);
		expect(separate).toMatchObject({ refused: 1, confirmation: null });
		expect(separate.rows[1]?.errors).toContain("foreign id is required");
	} finally {
		h.close();
	}
});

test.each([
	['ID,Title\nC1,"unterminated', "unclosed quoted cell"],
	["ID,ID\nC1,Title", "unique, nonempty column headers"],
	["ID,Title\nC1,Title,Extra", "expected 2 cells, got 3"],
	["ID,Title\n1,Title", "invalid case alias"],
	["ID,Title\nC-1,Title", "invalid case alias"],
])("CSV refuses malformed input %s", (source, message) => {
	const h = harness();
	try {
		const reply = h.raw("import-csv", { csv: source, mapping: { id: "ID", title: "Title" } });
		if (!reply.ok) expect(reply.error.message).toContain(message);
		else expect(Preview.parse(reply.result).rows[0]?.errors.join("; ")).toContain(message);
		expect(h.call("find", { what: "cases" })).toMatchObject({ count: 0 });
	} finally {
		h.close();
	}
});

test("CSV refuses the whole confirmed batch when any record is invalid or an alias was taken after preview", () => {
	const h = harness();
	try {
		const source = "ID,Title\nC201,First\nC202,Second";
		const mapped = { id: "ID", title: "Title" };
		const preview = Preview.parse(h.call("import-csv", { csv: source, mapping: mapped }));
		h.call("propose", { edits: [{ op: "create", aliases: ["C202"], body: { title: "Already created" } }] });
		expect(h.raw("import-csv", { csv: source, mapping: mapped, confirm: preview.confirmation })).toMatchObject({
			ok: false,
			error: { code: "invalid" },
		});
		expect(h.raw("get", { refs: ["C201"] })).toMatchObject({ ok: false, error: { code: "not_found" } });
		expect(h.call("find", { what: "cases" })).toMatchObject({ count: 1 });
		const mixed = Preview.parse(h.call("import-csv", { csv: "ID,Title\nC301,Valid\nC302,", mapping: mapped }));
		expect({ create: mixed.create, refused: mixed.refused, confirmation: mixed.confirmation }).toEqual({
			create: 1,
			refused: 1,
			confirmation: null,
		});
		expect(
			h.raw("import-csv", { csv: "ID,Title\nC301,Valid\nC302,", mapping: mapped, confirm: "000000000000" }),
		).toMatchObject({ ok: false, error: { code: "invalid" } });
		expect(h.call("find", { what: "cases" })).toMatchObject({ count: 1 });
	} finally {
		h.close();
	}
});

test("CSV mapping changes need a new preview, command ids bind the input, and read-only actors cannot import", () => {
	const h = harness();
	try {
		const preview = Preview.parse(h.call("import-csv", { csv, mapping, cmd: "preview-command" }));
		expect(
			h.raw("import-csv", { csv, mapping: { ...mapping, title: "Steps" }, confirm: preview.confirmation }),
		).toMatchObject({ ok: false, error: { code: "conflict" } });
		expect(h.raw("import-csv", { csv, mapping, confirm: preview.confirmation, cmd: "preview-command" })).toMatchObject({
			ok: false,
			error: { code: "conflict" },
		});
		const reader = h.actor("reader", "human", ["read"]);
		expect(h.raw("import-csv", { csv, mapping }, reader)).toMatchObject({ ok: false, error: { code: "forbidden" } });
		expect(h.call("find", { what: "cases" })).toMatchObject({ count: 0 });
	} finally {
		h.close();
	}
});
