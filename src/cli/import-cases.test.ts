import { expect, test } from "bun:test";
import { join } from "node:path";
import { z } from "zod";
import { Policy } from "../core/kinds.ts";
import { parseCase } from "../core/markdown.ts";
import { ReportReceipt } from "../core/ops.ts";
import { withInstance } from "./test-support.ts";

const Case = z.object({ ref: z.string(), title: z.string(), methods: z.array(z.string()), automate: z.string() });

test("CSV imports 2,000 cases through propose and every foreign alias resolves over HTTP", async () => {
	await withInstance(async ({ cli, client, directory }) => {
		const file = join(directory, "cases.csv");
		await Bun.write(
			file,
			"id,title,execution_type\n" +
				Array.from(
					{ length: 2000 },
					(_, i) => `OLD${i + 1},Imported ${i + 1},${i % 2 ? "automated" : "to-be-automated"}`,
				).join("\n"),
		);
		const imported = await cli(["import", file, "--format", "csv", "--json"]);
		expect(imported.stderr).toBe("");
		expect(imported.code).toBe(0);
		for (let start = 0; start < 2000; start += 200) {
			const refs = Array.from({ length: 200 }, (_, i) => `OLD${start + i + 1}`);
			const cases = z.array(Case).parse(await client.call("get", { refs }));
			for (const [i, row] of cases.entries()) {
				const n = start + i;
				expect(row.title).toBe(`Imported ${n + 1}`);
				expect(row.methods).toEqual(n % 2 ? ["auto"] : ["human"]);
				expect(row.automate).toBe(n % 2 ? "none" : "wanted");
			}
		}
	});
}, 20_000);

test("vendor CSV imports keep aliases, folders, source metadata and proposal history", async () => {
	await withInstance(async ({ run, client, directory }) => {
		const policy = Policy.parse(await client.call("admin", { do: "policy.show", project: "scratch" }));
		const proposed = z.object({ question: z.string() }).parse(
			await client.call("propose", {
				edits: [
					{
						op: "policy",
						settings: { ...policy.settings, fields: { risk: { kind: "text", label: "Risk", required: false } } },
					},
				],
			}),
		);
		const inbox = z
			.object({ items: z.array(z.object({ q: z.string(), evidenceHash: z.string() })) })
			.parse(await client.call("inbox", { kind: "adopt" }));
		const question = inbox.items.find((row) => row.q === proposed.question);
		if (!question) throw new Error("The field definitions proposal needs its adoption question");
		expect(
			await client.call("decide", {
				q: question.q,
				onEvidence: question.evidenceHash,
				answer: { is: "accept" },
			}),
		).toMatchObject([{ status: "decided" }]);
		expect(Policy.parse(await client.call("admin", { do: "policy.show", project: "scratch" })).settings.fields).toEqual(
			{ risk: { kind: "text", label: "Risk", required: false } },
		);
		const testrail = join(directory, "testrail.csv");
		await Bun.write(
			testrail,
			"ID,Title,Type,Section,Section Depth,Steps (Step),Steps (Expected Result),Updated On\nC1234,Sign in,Automated,Accounts,0,Open,Ready,2020-01-02",
		);
		const imported = await run(["import", testrail, "--format", "testrail"]);
		expect(imported).toMatchObject({ code: 0, stderr: "" });
		expect(imported.stdout).toContain("1 cases: adopted P-");
		expect(await client.call("get", { refs: ["C1234"] })).toMatchObject([
			{
				title: "Sign in",
				methods: ["auto"],
				folder: { path: "Accounts" },
				steps: [{ action: "Open", expected: "Ready" }],
			},
		]);
		const md = z
			.array(z.object({ md: z.string() }))
			.parse(await client.call("get", { refs: ["C1234"], as: "md" }))[0]?.md;
		expect(md).toContain("import.testrail.row.2");
		expect(md).toContain("2020-01-02");
		const parsed = parseCase(md ?? "");
		if (!parsed.ok) throw new Error("The imported case must remain readable as canonical Markdown");
		expect(parsed.doc.body.fields["import.testrail.row.2"]).toContain('"Updated On":"2020-01-02"');
		expect(await client.call("history", { ref: "C1234" })).toMatchObject({
			versions: [{ version: 1, reason: "Import testrail CSV" }],
		});
		const reportFile = join(directory, "results.xml");
		await Bun.write(
			reportFile,
			'<testsuite><testcase name="signs in @C1234"/><testcase name="property"><properties><property name="mainworthy" value="C1234@v1"/></properties></testcase><testcase name="unknown @Missing123"/><testcase name="explicit unknown @C-1"><properties><property name="mainworthy" value="Missing123"/></properties></testcase></testsuite>',
		);
		const reported = await run(["report", reportFile, "--session", "imported-aliases", "--json"]);
		expect(reported).toMatchObject({ code: 0, stderr: "" });
		expect(ReportReceipt.parse(JSON.parse(reported.stdout))).toMatchObject({
			counts: { total: 4, pass: 4 },
			basis: { exact: 1, assumed: 1, unresolved: 2 },
			declined: [{ index: 3, reason: "the annotation names Missing123, which does not exist: recorded with no case" }],
		});
		const qase = join(directory, "qase.csv");
		await Bun.write(
			qase,
			"id,title,automation,steps_actions,steps_result\n7,Leave,to-be-automated,1. Sign out,1. Goodbye",
		);
		expect(await run(["import", qase, "--format", "qase", "--case-prefix", "PAY"])).toMatchObject({ code: 0 });
		expect(await client.call("get", { refs: ["PAY-7"] })).toMatchObject([
			{ title: "Leave", methods: ["human"], automate: "wanted", steps: [{ action: "Sign out", expected: "Goodbye" }] },
		]);
		await client.call("admin", { do: "project.create", key: "other", preset: "loose" });
		expect(await run(["import", testrail, "--format", "testrail", "--project", "other"])).toMatchObject({ code: 0 });
	});
});

test("bad CSV, encoding, options and existing aliases leave the project unchanged", async () => {
	await withInstance(async ({ run, client, instance, directory }) => {
		const file = join(directory, "cases.csv");
		for (const text of ['id,title\nOLD1,Valid\nOLD2,"unfinished', "id,title\nOLD1,First\nOLD1,Duplicate"]) {
			await Bun.write(file, text);
			const result = await run(["import", file, "--format", "csv"]);
			expect(result.code).toBe(4);
			expect(result.stderr).toContain("invalid:");
		}
		await Bun.write(file, new Uint8Array([0xff, 0xfe]));
		expect(await run(["import", file, "--format", "csv"])).toMatchObject({ code: 4 });
		for (const flags of [
			["--format", "unknown"],
			["--case-prefix", "PAY"],
			["--format", "csv", "--case-prefix", "PAY"],
		])
			expect(await run(["import", file, ...flags])).toMatchObject({ code: 4 });
		expect(z.object({ items: z.array(z.unknown()) }).parse(await client.call("find", {})).items).toHaveLength(0);
		expect(instance.app.db.raw.query<{ n: number }, []>("SELECT count(*) AS n FROM proposals").get()?.n).toBe(0);
		await Bun.write(file, "id,title\nOLD1,First");
		expect(await run(["import", file, "--format", "csv"])).toMatchObject({ code: 0 });
		await Bun.write(file, "id,title\nOLD2,New\nOLD1,Duplicate");
		const duplicate = await run(["import", file, "--format", "csv"]);
		expect(duplicate.code).toBe(4);
		expect(duplicate.stderr).toContain("conflict");
		expect(z.object({ items: z.array(z.unknown()) }).parse(await client.call("find", {})).items).toHaveLength(1);
	});
});

test("case import prints a pending proposal and exits 2 when policy requires review", async () => {
	await withInstance(async ({ run, client, directory }) => {
		await client.call("admin", { do: "project.create", key: "review", preset: "strict" });
		const file = join(directory, "cases.csv");
		await Bun.write(file, "id,title\nOLD1,Pending");
		const result = await run(["import", file, "--format", "csv", "--project", "review"]);
		expect(result).toMatchObject({ code: 2, stderr: "" });
		expect(result.stdout).toContain("1 cases: open P-");
		expect(result.stdout).toContain("Q-");
	});
});

test("archive export and import retain imported aliases and source metadata", async () => {
	await withInstance(async ({ run, directory }) => {
		const csv = join(directory, "cases.csv");
		const archive = join(directory, "archive.ndjson");
		await Bun.write(csv, "id,title,history\nOLD1,Imported,Earlier title");
		expect(await run(["import", csv, "--format", "csv"])).toMatchObject({ code: 0 });
		expect(await run(["export", "--out", archive])).toMatchObject({ code: 0 });
		await withInstance(async ({ run: restore, client }) => {
			expect(await restore(["import", archive])).toMatchObject({ code: 0 });
			expect(await client.call("get", { refs: ["OLD1"] })).toMatchObject([{ title: "Imported" }]);
			const rows = z.array(z.object({ md: z.string() })).parse(await client.call("get", { refs: ["OLD1"], as: "md" }));
			expect(rows[0]?.md).toContain("Earlier title");
		});
	});
});
