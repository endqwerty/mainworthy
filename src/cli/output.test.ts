import { expect, test } from "bun:test";
import { join } from "node:path";
import { z } from "zod";
import { escapeControls } from "../core/text.ts";
import { printReceipt } from "./commands/report.ts";
import { CliError, printError } from "./errors.ts";
import { line, printJson, printMarkdown, warning } from "./output.ts";
import { inThisProcess, withInstance } from "./test-support.ts";

const payload = "é 雪\n::error::x\u001b]8;;https://example.com\u0007link\u001b]8;;\u0007\u009b31m\u202e";
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal controls must never reach the output bytes.
const controls = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

function safe(text: string): void {
	expect(text).not.toMatch(controls);
	expect(text).not.toMatch(/^\s*::/m);
	expect(text).not.toContain("##[");
}

test("the real CLI previews crafted CSV without terminal controls or annotation lines", async () => {
	await withInstance(async ({ cli, run, client, directory }) => {
		const file = join(directory, "crafted.csv");
		await Bun.write(file, `ID,Title,Folder\nX-1,"${payload}","${payload}"`);
		const argv = ["import-csv", file, "--mapping", JSON.stringify({ id: "ID", title: "Title", folder: "Folder" })];
		const preview = await cli(argv);
		expect(preview).toMatchObject({ code: 0, stderr: "" });
		expect(preview.stdout).toContain("1 cases ready, 0 refused");
		safe(preview.stdout);
		expect(preview.stdout).toContain("é 雪");
		expect(preview.stdout).toContain("\\u001b]8;;https://example.com\\u0007");
		expect(preview.stdout).toContain("\\u009b31m\\u202e");
		const json = await run([...argv, "--json"]);
		expect(json).toMatchObject({ code: 0, stderr: "" });
		safe(json.stdout);
		const original = await client.call("import-csv", {
			csv: await Bun.file(file).text(),
			mapping: { id: "ID", title: "Title", folder: "Folder" },
		});
		expect(JSON.parse(json.stdout)).toEqual(original);
		expect((await client.call("find", {})).items).toHaveLength(0);
	});
}, 15_000);

test("human lines and warnings escape every control and both Actions command syntaxes", async () => {
	const all = `${String.fromCharCode(...Array.from({ length: 160 }, (_, i) => i).filter((i) => i < 32 || i >= 127))}\u2028\u2029\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069`;
	const result = await inThisProcess(
		"terminal sinks",
		async () => {
			line(payload + all);
			line("  ::error::x");
			line("é 雪 ##[error]x");
			warning(payload + all);
			warning("  ::warning::x");
			warning("é 雪 ##[warning]x");
			printError(new CliError("invalid", "é 雪 ##[error]x"));
			return 0;
		},
		{ environment: {}, cwd: process.cwd(), input: "" },
	);
	safe(result.stdout);
	safe(result.stderr);
	expect(result.stdout.split("\n")).toHaveLength(4);
	expect(result.stderr.split("\n")).toHaveLength(5);
	expect(result.stdout).toContain(escapeControls(payload + all));
	expect(result.stderr).toContain(escapeControls(payload + all));
	expect(result.stdout).toContain("é 雪");
	const markdown = await inThisProcess(
		"Markdown output",
		async () => {
			printMarkdown(`## Preconditions\n${payload + all}\n  ::error::x\né 雪 ##[error]x\n`);
			return 0;
		},
		{ environment: {}, cwd: process.cwd(), input: "" },
	);
	safe(markdown.stdout);
	expect(markdown.stdout).toStartWith("## Preconditions\né 雪\n\\u003a:error::x");
	expect(markdown.stdout).toContain("\\u000d");
});

test("pretty and compact CLI JSON preserve nested values and keys while remaining terminal safe", async () => {
	const value = {
		[payload]: [payload, "##[error]x", "::error::x", "\\u001b", "é 雪"],
		"##[error]": { "##[warning]": "\\##[error]" },
	};
	for (const compact of [false, true]) {
		const result = await inThisProcess(
			"JSON output",
			async () => {
				printJson(value, compact);
				return 0;
			},
			{ environment: {}, cwd: process.cwd(), input: "" },
		);
		safe(result.stdout);
		expect(JSON.parse(result.stdout)).toEqual(value);
		expect(result.stdout).toContain("é 雪");
		expect(result.stdout.split("\n").length > 2).toBe(!compact);
	}
});

test("case imports, get Markdown, fmt and generated find keep Unicode readable and controls inert", async () => {
	await withInstance(async ({ run, client, directory }) => {
		const file = join(directory, "cases.csv");
		await Bun.write(file, `id,title,preconditions\nOLD1,"${payload}","${payload}\n##[error]x"`);
		expect(await run(["import", file, "--format", "csv"])).toMatchObject({ code: 0, stderr: "" });
		const original = z
			.array(z.object({ md: z.string() }))
			.parse(await client.call("get", { refs: ["OLD1"], as: "md" }));
		const md = await run(["get", "OLD1", "--md"]);
		expect(md).toMatchObject({ code: 0, stderr: "" });
		safe(md.stdout);
		expect(md.stdout).toContain("é 雪");
		expect(md.stdout).toContain("\n## Preconditions\n");
		const source = join(directory, "case.md");
		await Bun.write(source, original[0]?.md ?? "");
		const formatted = await run(["fmt", source]);
		expect(formatted).toEqual(md);
		for (const argv of [["get", "OLD1", "--md", "--json"], ["fmt", source, "--json"], ["find"]]) {
			const result = await run(argv);
			expect(result).toMatchObject({ code: 0, stderr: "" });
			safe(result.stdout);
			if (argv[0] === "get")
				expect(z.array(z.object({ md: z.string() })).parse(JSON.parse(result.stdout))).toEqual(original);
			if (argv[0] === "fmt") expect(JSON.parse(result.stdout)).toEqual({ md: original[0]?.md });
			if (argv[0] === "find") expect(JSON.parse(result.stdout)).toEqual(await client.call("find", {}));
		}
	});
});

test("receipts escape server and file text in identities, dispositions, reasons and warnings", async () => {
	await withInstance(async ({ client }) => {
		const report = {
			target: { commit: "safe0001" },
			results: [{ test: { key: "one" }, outcome: "fail" as const, message: "failure" }],
		};
		const receipt = await client.call("report", report);
		if (!receipt.gate) throw new Error("A commit report must return its gate");
		const gate = receipt.gate;
		const result = await inThisProcess(
			"receipt",
			async () => {
				printReceipt({
					project: payload,
					url: client.url,
					report: { ...report, target: { session: payload }, job: payload },
					receipt: {
						...receipt,
						questions: [
							{
								q: "Q-1",
								kind: "failure",
								state: "decided",
								title: payload,
								tests: 1,
								how: "already decided",
								by: payload,
								answer: payload,
							},
						],
						rejected: [{ index: 0, reason: payload }],
						declined: [{ index: 0, reason: payload }],
						gate: { ...gate, reason: payload },
					},
				});
				return 0;
			},
			{ environment: {}, cwd: process.cwd(), input: "" },
		);
		safe(result.stdout);
		safe(result.stderr);
		expect(result.stdout).toContain(escapeControls(payload));
		expect(result.stderr).toContain(escapeControls(payload));
	});
});
