// Which test files open a browser, and how many tests a file declares. One place, read by `pr-body` (AGENTS.md: a
// test sits at the cheapest layer that reaches it). It imports nothing, because the `description` job installs no
// dependencies. `test/browser-tests.test.ts` holds the list to what each file opens.

/** Files in `test/e2e/` that start servers or processes but open no browser. */
export const BROWSERLESS_E2E: ReadonlySet<string> = new Set(["test/e2e/lifetime.test.ts", "test/e2e/ports.test.ts"]);
/** Files outside `test/e2e/` that open a browser. */
const BROWSER_ELSEWHERE: ReadonlySet<string> = new Set(["test/check.test.ts"]);

export function opensBrowser(file: string): boolean {
	if (BROWSER_ELSEWHERE.has(file)) return true;
	return /^test\/e2e\/.+\.test\.tsx?$/.test(file) && !BROWSERLESS_E2E.has(file);
}

// `test`, optionally `.only`, `.serial` or `.concurrent`, optionally a condition such as `.skipIf(!browserAvailable)`,
// then the call that names the test. `test.skip` and `test.todo` declare nothing that runs.
const CONDITION = String.raw`\.(?:skipIf|if|todoIf)\((?:[^()]|\([^()]*\))*\)`;
const TEST = String.raw`\btest(?:\.(?:only|serial|concurrent))?(?:${CONDITION})?`;
const INLINE = String.raw`\(\s*\w+\s*\?\s*test\s*:\s*test\.skip\s*\)`;
const TITLE = String.raw`\(\s*["'\`]`;

/** How many tests a source declares, through `test` and the names it is given (`const check = test.skipIf(...)`). */
export function testDeclarations(source: string): number {
	const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
	const aliases = [
		...code.matchAll(
			new RegExp(String.raw`\b(?:const|let)\s+(\w+)\s*=\s*(?:${TEST}|\w+\s*\?\s*test\s*:\s*test\.skip)\s*;?\s*$`, "gm"),
		),
	]
		.map((match) => match[1])
		.filter((name): name is string => name !== undefined);
	const declarers = [TEST, INLINE, ...aliases.map((name) => String.raw`\b${name}`)];
	return declarers.reduce((sum, declarer) => sum + [...code.matchAll(new RegExp(declarer + TITLE, "g"))].length, 0);
}
