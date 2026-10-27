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

// What may come before a `/` that starts a regular expression rather than divides.
const BEFORE_REGEX =
	/(?:^|[(,=:[!&|?{};+\-*%<>~^]|\b(?:return|typeof|case|do|else|in|of|void|yield|await|delete|throw|new))\s*$/;

/**
 * The source with every comment removed and every string, template and regular expression emptied, so that text
 * inside them (a glob such as "**\/api", a test written into a fixture) reads as nothing. A string keeps its quotes,
 * which is how a test's title is recognised. `${...}` inside a template is code and is kept.
 */
export function codeOnly(source: string): string {
	let out = "";
	let i = 0;
	const braces: number[] = []; // for each open `${`, the depth of `{` inside it
	while (i < source.length) {
		const c = source[i] ?? "";
		const next = source[i + 1];
		if (c === "/" && next === "/") {
			while (i < source.length && source[i] !== "\n") i++;
		} else if (c === "/" && next === "*") {
			const end = source.indexOf("*/", i + 2);
			i = end === -1 ? source.length : end + 2;
		} else if (c === '"' || c === "'") {
			i++;
			while (i < source.length && source[i] !== c && source[i] !== "\n") i += source[i] === "\\" ? 2 : 1;
			i++;
			out += `${c}${c}`;
		} else if (c === "`" || (c === "}" && braces.length > 0 && braces.at(-1) === 0)) {
			// A template, or the rest of one after a `${...}`: read to its end or to the next `${`.
			if (c === "}") braces.pop();
			else out += "``";
			i++;
			while (i < source.length && source[i] !== "`" && !(source[i] === "$" && source[i + 1] === "{"))
				i += source[i] === "\\" ? 2 : 1;
			if (source[i] === "$") {
				// `${` starts an expression, where a `/` begins a regular expression.
				braces.push(0);
				out += "{";
				i += 2;
			} else i++;
		} else if (c === "/" && BEFORE_REGEX.test(out)) {
			i++;
			let inClass = false;
			while (i < source.length && source[i] !== "\n" && (inClass || source[i] !== "/")) {
				if (source[i] === "[") inClass = true;
				else if (source[i] === "]") inClass = false;
				i += source[i] === "\\" ? 2 : 1;
			}
			i++;
			while (/[a-z]/i.test(source[i] ?? "")) i++;
			out += "/x/";
		} else {
			if (braces.length > 0 && c === "{") braces[braces.length - 1] = (braces.at(-1) ?? 0) + 1;
			if (braces.length > 0 && c === "}") braces[braces.length - 1] = (braces.at(-1) ?? 0) - 1;
			out += c;
			i++;
		}
	}
	return out;
}

/** How many tests a source declares, through `test` and the names it is given (`const check = test.skipIf(...)`). */
export function testDeclarations(source: string): number {
	const code = codeOnly(source);
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
