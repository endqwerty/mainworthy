import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { opensBrowser, testDeclarations } from "../scripts/browser-tests.ts";

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
