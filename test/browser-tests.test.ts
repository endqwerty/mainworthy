import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { codeOnly, opensBrowser, testDeclarations } from "../scripts/browser-tests.ts";

// What a file reads to open Chromium: its own source, or a helper beside it other than the shared `support.ts`,
// which also starts servers for the browserless tests.
const BROWSER = /\b(?:openPage|launchBrowser)\b|from "playwright(?:-core)?"/;
const usesBrowser = (file: string): boolean => {
	const source = readFileSync(file, "utf8");
	if (BROWSER.test(source)) return true;
	return [...source.matchAll(/from "\.\/([\w-]+)\.ts"/g)].some(
		([, helper]) => helper !== "support" && BROWSER.test(readFileSync(join("test/e2e", `${helper}.ts`), "utf8")),
	);
};

test("the browser test files are the ones that open a browser", () => {
	const files = readdirSync("test/e2e")
		.filter((name) => name.endsWith(".test.ts"))
		.map((name) => `test/e2e/${name}`);
	expect(files.length).toBeGreaterThan(50);
	for (const file of files) expect([file, opensBrowser(file)]).toEqual([file, usesBrowser(file)]);
	expect(opensBrowser("test/check.test.ts")).toBe(true);
	expect(opensBrowser("test/results.test.ts")).toBe(false);
	expect(opensBrowser("test/e2e/support.ts")).toBe(false);
});

test("test declarations are counted as the browser tests write them", () => {
	const source = [
		'import { test } from "bun:test";',
		"const check = test.skipIf(!browserAvailable);",
		"const also = browserAvailable ? test : test.skip;",
		'test("plain", async () => {});',
		"test.skipIf(!browserAvailable)(",
		'\t"a title on the next line",',
		"\tasync () => {},",
		");",
		'check("through an alias", async () => {});',
		"for (const viewer of viewers) also(`for ${viewer}`, async () => {});",
		"(browserAvailable ? test : test.skip)('inline', async () => {});",
		'// test("a comment") is not a test',
		"/* check('nor is this') */",
		'test.skip("a skipped one is not counted", () => {});',
		'describe("a group", () => {});',
	].join("\n");
	expect(testDeclarations(source)).toBe(5);
	expect(testDeclarations("")).toBe(0);
});

test("text inside strings, templates, regular expressions and comments declares nothing", () => {
	// A route glob opens no comment (test/e2e/execution.test.ts), and a test written into a fixture is not a test
	// of this file (test/check.test.ts).
	const source = [
		'await page.route("**/api/p/*/report", (route) => route.abort());',
		'test("after the glob", async () => {});',
		"const fixture = `",
		'test("inside a fixture", () => {});',
		'${tests.map((t) => `test(${JSON.stringify(t)}, () => {});`).join("\\n")}',
		"`;",
		'const pattern = /test\\("x"\\)/g; // a pattern, not a test',
		'const ratio = total / count / 2; test("after a division", () => {});',
		"const quote = '\\'test(\"no\")';",
	].join("\n");
	expect(testDeclarations(source)).toBe(2);
	expect(codeOnly('a("x\\"y") + `b${c("z")}d`')).toBe('a("") + ``{c("")');
});

test("a test added beside a route glob is counted", () => {
	const file = readFileSync("test/e2e/execution.test.ts", "utf8");
	const at = file.indexOf("(browserAvailable ? test : test.skip)(", file.indexOf("**/api/p/*/report"));
	expect(at).toBeGreaterThan(0);
	const added = `${file.slice(0, at)}test.skipIf(!browserAvailable)("a new journey", async () => {});\n${file.slice(at)}`;
	expect(testDeclarations(added)).toBe(testDeclarations(file) + 1);
});

test("a regular expression that opens a template's substitution is not a division", () => {
	// The shape src/cli/invite.test.ts uses. Read as a division, the apostrophe began a string, the `${` was never
	// closed, and the `}` after it read the rest of the file as a template.
	const source = [
		'test("a title preserves its apostrophe", () => {',
		'\tconst title = "owner\'s project";',
		"\texpect(title).toBe(`${/owner's project/.exec(title)?.[0]}`);",
		"});",
		'test("it\'s counted", async () => {});',
		'test("so is this", async () => {});',
	].join("\n");
	expect(testDeclarations(source)).toBe(3);
});
