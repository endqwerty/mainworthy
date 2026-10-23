import { expect, test } from "bun:test";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { withInstance } from "./test-support.ts";

test("native retry reports upload through the executable and retain recovery evidence on CLI reads", async () => {
	await withInstance(async ({ cli, run, directory }) => {
		const root = await realpath(directory);
		for (const [index, format] of ["jest", "vitest", "pytest"].entries()) {
			const fixture = new URL(`../../test/fixtures/reports/${format}-retries.json`, import.meta.url);
			const file = join(directory, `${format}.json`);
			await Bun.write(file, (await Bun.file(fixture).text()).replaceAll("/workspace", root));
			const uploaded = await (index === 0 ? cli : run)([
				"report",
				file,
				"--commit",
				`aabb073${index}`,
				"--job",
				format,
				"--json",
			]);
			expect({ code: uploaded.code, stderr: format === "jest" ? uploaded.stderr : "" }).toEqual({
				code: 0,
				stderr: "",
			});
			expect(JSON.parse(uploaded.stdout).counts).toEqual({ total: 4, pass: 2, fail: 1, skip: 1, error: 0, blocked: 0 });
			if (format === "jest") expect(uploaded.stderr).toBe("");
			else expect(uploaded.stderr).toContain("retry count");
			const read = await run(["get", `T-${index * 4 + 1}`, "--json"]);
			expect(read.code).toBe(0);
			const page = JSON.parse(read.stdout)[0];
			expect(page.flips).toBe(1);
			expect(page.last[0].outcome).toBe("pass");
			expect(page.last[0].tries).toHaveLength(format === "jest" ? 2 : 1);
		}
	});
});

test("native retry diagnostics stay on one stderr line with control-safe identifiers", async () => {
	await withInstance(async ({ cli, run, directory }) => {
		const root = await realpath(directory);
		const title = "\n::error::report title\u001b]0;report title\u0007\u0085";
		for (const [index, format] of ["jest", "vitest", "pytest"].entries()) {
			const fixture = new URL(`../../test/fixtures/reports/${format}-retries.json`, import.meta.url);
			const report = JSON.parse((await Bun.file(fixture).text()).replaceAll("/workspace", root));
			if (format === "pytest") report.tests[0].nodeid = `test_sample.py::${title}`;
			else {
				report.testResults[0].assertionResults[0].title = title;
				if (format === "jest") report.testResults[0].assertionResults[0].retryReasons = [];
			}
			const file = join(directory, `${format}.json`);
			await Bun.write(file, JSON.stringify(report));
			const uploaded = await (index === 0 ? cli : run)(["report", file, "--session", "safe-warning", "--json"]);
			expect(uploaded.code).toBe(0);
			expect(JSON.parse(uploaded.stdout).counts.total).toBe(4);
			expect(uploaded.stderr.split("\n")).toHaveLength(2);
			expect(uploaded.stderr).toContain("\\n::error::report title");
			expect(uploaded.stderr).toContain("\\u001b");
			expect(uploaded.stderr).toContain("\\u0085");
			expect(uploaded.stderr).not.toContain("\u001b");
			expect(uploaded.stderr).not.toContain("\u0085");
			if (format === "jest") {
				report.testResults[0].assertionResults[0].invocations = 1;
				report.testResults[0].assertionResults[0].retryReasons = ["reason"];
				await Bun.write(file, JSON.stringify(report));
				const refused = await run(["report", file, "--session", "safe-error"]);
				expect(refused.code).toBe(4);
				expect(refused.stderr.split("\n")).toHaveLength(2);
				expect(refused.stderr).toContain("\\n::error::report title");
				expect(refused.stderr).not.toContain("\u001b");
			}
		}
	});
});

test("report refusals and parse warnings escape suite names, filenames and attachment paths on stderr", async () => {
	await withInstance(async ({ cli, run, directory }) => {
		const name = "\n::error::suite\u001b]0;suite\u0007\u0085\u202e";
		for (const [index, assertionResults] of [[], [{ title: "one", ancestorTitles: [], status: "passed" }]].entries()) {
			const file = join(directory, "refused.json");
			await Bun.write(file, JSON.stringify({ testResults: [{ name, status: "failed", assertionResults }] }));
			const refused = await (index === 0 ? cli : run)(["report", file, "--session", "safe-error"]);
			expect(refused).toMatchObject({ code: 4, stdout: "" });
			expect(refused.stderr.split("\n")).toHaveLength(2);
			expect(refused.stderr).toContain("\\n::error::suite");
			expect(refused.stderr).toContain("\\u001b");
			expect(refused.stderr).not.toContain("\u001b");
			expect(refused.stderr).not.toContain("\u0085");
			expect(refused.stderr).not.toContain("\u202e");
		}
		const file = join(directory, "warning\n::error::file\u0085.xml");
		await Bun.write(
			file,
			'<testsuite><testcase/><testcase name="two"><properties><property name="attachment" value="missing&#x85;&#x202e;"/></properties></testcase></testsuite>',
		);
		const uploaded = await run(["report", file, "--session", "safe-warning", "--attachments", directory, "--json"]);
		expect(uploaded.code).toBe(0);
		expect(JSON.parse(uploaded.stdout).counts.total).toBe(2);
		expect(uploaded.stderr.split("\n")).toHaveLength(3);
		expect(uploaded.stderr).not.toContain("\n::error::");
		expect(uploaded.stderr).not.toContain("\u0085");
		expect(uploaded.stderr).not.toContain("\u202e");
		const unavailable = await run([
			"report",
			file,
			"--session",
			"unavailable",
			"--attachments",
			join(directory, "missing\u0085\u202e"),
			"--json",
		]);
		expect(unavailable.code).toBe(0);
		expect(unavailable.stderr).toContain("attachment directory is unavailable");
		expect(unavailable.stderr).not.toContain("\u0085");
		expect(unavailable.stderr).not.toContain("\u202e");
	});
});

test("human and JSON report receipts escape reporter-controlled failure titles on stdout", async () => {
	await withInstance(async ({ cli, run, directory }) => {
		const file = join(directory, "failed.json");
		await Bun.write(
			file,
			JSON.stringify({
				testResults: [
					{
						name: "one.js",
						status: "failed",
						assertionResults: [
							{ title: "one", ancestorTitles: [], status: "failed", failureMessages: ["boom\u0085\u202e"] },
						],
					},
				],
			}),
		);
		const uploaded = await cli(["report", file, "--commit", "abc7771"]);
		expect(uploaded.code).toBe(0);
		expect(uploaded.stdout).toContain("boom");
		expect(uploaded.stdout).toContain("\\u0085");
		expect(uploaded.stdout).not.toContain("\u0085");
		expect(uploaded.stdout).not.toContain("\u202e");
		const json = await run(["report", file, "--commit", "abc7772", "--json"]);
		expect(json.code).toBe(0);
		expect(JSON.parse(json.stdout).questions[0].title).toBe("boom\u0085\u202e");
		expect(json.stdout).toContain("\\u0085");
		expect(json.stdout).not.toContain("\u0085");
		expect(json.stdout).not.toContain("\u202e");
	});
});
