import { expect, test } from "bun:test";
import { z } from "zod";
import { CliError, printError } from "./errors.ts";
import { printJson } from "./output.ts";
import { inThisProcess } from "./test-support.ts";

const dangerous = `${String.fromCharCode(...Array.from({ length: 32 }, (_, index) => index))}\u007f\u0085\u009b31m\u2028\u2029\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069`;
// biome-ignore lint/suspicious/noControlCharactersInRegex: check the final diagnostic line for every forbidden control.
const controls = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const schema = z.record(z.string(), z.string()).safeParse({ [dangerous]: 7 });
if (schema.success) throw new Error("Expected a schema error");

test.each([
	["Error", new Error(dangerous)],
	["CliError message and code", new CliError(dangerous, dangerous)],
	["unknown thrown value", dangerous],
	["schema path", schema.error],
])("the error sink escapes all controls in %s", async (_name, error) => {
	const result = await inThisProcess(
		"print error",
		async () => {
			printError(error);
			return 4;
		},
		{ environment: {}, cwd: process.cwd(), input: "" },
	);
	expect(result).toMatchObject({ code: 4, stdout: "" });
	expect(result.stderr.split("\n")).toHaveLength(2);
	expect(result.stderr.slice(0, -1)).not.toMatch(controls);
	expect(result.stderr).toContain("\\u0085");
	expect(result.stderr).toContain("\\u202e");
});

test("the error sink keeps CR/LF folding and leaves existing escapes and punctuation alone", async () => {
	const result = await inThisProcess(
		"fold error",
		async () => {
			printError(new CliError("invalid", 'first\r\n\n::error::x\rend "quoted" \\n \\u001b\t'));
			return 4;
		},
		{ environment: {}, cwd: process.cwd(), input: "" },
	);
	expect(result.stderr).toBe('invalid: first; ::error::x; end "quoted" \\n \\u001b\\u0009\n');
});

test("the JSON printer emits null for an undefined top-level value", async () => {
	const result = await inThisProcess(
		"print undefined",
		async () => {
			printJson(undefined, true);
			return 0;
		},
		{ environment: {}, cwd: process.cwd(), input: "" },
	);
	expect(result).toEqual({ code: 0, stdout: "null\n", stderr: "" });
});
