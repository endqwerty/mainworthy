// These checks read .changes/ fragments and CHANGELOG.md through their authoring scripts.
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assemble, fragments } from "../scripts/changelog.ts";
import { make, remove } from "../scripts/work/scratch.ts";

const fragment = (id: string, text = "A user-visible change.", date = "2026-10-23") => ({
	file: `${id}-example.md`,
	text: `---\nid: ${id}\ncategory: Fixed\ndate: ${date}\nissue: https://github.com/endqwerty/mainworthy/issues/1\n---\n\n${text}\n`,
});

test("assembly includes each fragment once, sorts deterministically and preserves historical entries on every run", () => {
	const history = "# Changelog\n\n- 2026-10-22: **Fixed:** An unrelated entry.\n- 2026-10-21: Older history.\n";
	const inputs = [
		fragment("b", "Second fact."),
		fragment("a", "First fact."),
		fragment("old", "Older fact.", "2026-10-21"),
	];
	const output = assemble(history, fragments(inputs));
	expect(output).toBe(assemble(history, fragments([...inputs].reverse())));
	expect(output.endsWith(history.slice("# Changelog\n\n".length))).toBe(true);
	for (const fact of ["First fact.", "Second fact.", "Older fact."]) expect(output.split(fact)).toHaveLength(2);
	expect(output.indexOf("First fact.")).toBeLessThan(output.indexOf("Second fact."));
	expect(output.indexOf("Second fact.")).toBeLessThan(output.indexOf("Older fact."));
	expect(assemble(output, fragments(inputs))).toBe(output);
});

test("fragment metadata, ids, references and Markdown links are checked before assembly", () => {
	for (const input of [
		{ ...fragment("a"), file: "bad name.md" },
		{ ...fragment("a"), text: fragment("a").text.replace("Fixed", "Unknown") },
		{ ...fragment("a"), text: fragment("a").text.replace("2026-10-23", "2026-02-30") },
		{ ...fragment("a"), text: fragment("a").text.replace("category: Fixed", "category: Fixed\ncategory: Added") },
		{
			...fragment("a"),
			text: fragment("a").text.replace("issue: https://github.com/endqwerty/mainworthy/issues/1\n", ""),
		},
		fragment("a", "[bad](javascript:alert)"),
		fragment("a", "[missing](../no-such-file.md)"),
		fragment("a", "[missing heading](../docs/development/README.md#no-such-heading)"),
		fragment("a", "[outside](../../AGENTS.md)"),
		fragment("a", "[missing reference][nowhere]"),
		{ ...fragment("a"), text: fragment("a").text.replace("/issues/1", "/pull/nope") },
		fragment("a", ""),
	])
		expect(() => fragments([input])).toThrow();
	expect(() => fragments([fragment("1"), { ...fragment("1"), file: "1-other.md" }])).toThrow(/duplicate/i);
	expect(() => fragments([fragment("a", "[guide](../docs/development/README.md)")])).not.toThrow();
});

test("assembly rejects broken section markers instead of overwriting history", () => {
	for (const history of [
		"# Changelog\n\n<!-- changes:start -->\nA partial write.",
		"# Changelog\n\nHistorical entry.\n<!-- changes:end -->\n",
	])
		expect(() => assemble(history, fragments([fragment("a")]))).toThrow();
	expect(assemble("# Changelog\n\nHistorical entry.\n", [])).toBe("# Changelog\n\nHistorical entry.\n");
});

test("fragments refuse reference definitions that would collide across entries", () => {
	expect(() => fragments([fragment("refs", "A [guide][x].\n\n[x]: ../docs/development/README.md")])).toThrow(
		/reference definitions/i,
	);
});

test("multiline and escaped reference labels are refused too", () => {
	for (const body of [
		"A [guide][long label].\n\n[long\n label]: ../docs/development/README.md",
		"A [guide][escaped\\]label].\n\n[escaped\\]label]: ../docs/development/README.md",
	])
		expect(() => fragments([fragment("references", body)])).toThrow(/reference definitions/i);
});

test("fragment headings follow CommonMark and issue-number text remains valid", () => {
	for (const body of ["An entry.\n\n   ## Indented heading", "Heading\n===", "Heading\n---"])
		expect(() => fragments([fragment("heading", body)])).toThrow(/heading/i);
	expect(() => fragments([fragment("issue", "#123 is fixed.")])).not.toThrow();
});

test("soft-wrapped paragraphs assemble onto one owned line and blocks are refused", () => {
	const entries = fragments([fragment("wrapped", "First sentence.\nSecond sentence.")]);
	const output = assemble("# Changelog\n\nHistory.\n", entries);
	expect(output).toContain("First sentence. Second sentence.");
	expect(assemble(output, entries)).toBe(output);
	expect(() => fragments([fragment("paragraphs", "One paragraph.\n\nAnother paragraph.")])).toThrow(/paragraph/i);
});

test("assembly relocates real inline links while preserving code spans", () => {
	const entry = fragment(
		"links",
		"Read [guide](../docs/development/README.md); literal `[example](../docs/development/README.md)` and `` `[nested](../docs/development/README.md)` `` stay as typed.",
	);
	const output = assemble("# Changelog\n\nOld history.\n", fragments([entry]));
	expect(output).toContain("[guide](docs/development/README.md)");
	expect(output).toContain("`[example](../docs/development/README.md)`");
	expect(output).toContain("`` `[nested](../docs/development/README.md)` ``");
});

test("fragment CRLF line endings receive an explicit refusal", () => {
	expect(() =>
		fragments([{ ...fragment("windows"), text: fragment("windows").text.replaceAll("\n", "\r\n") }]),
	).toThrow(/CRLF line endings/i);
});

test("empty-path anchors receive an explicit refusal", () => {
	expect(() => fragments([fragment("anchor", "[x](#top)")])).toThrow(/missing (?:file|heading).*#top/i);
});

test("assembly refuses unowned generated lines and unknown fragment ids", () => {
	const entries = fragments([fragment("a")]);
	const output = assemble("# Changelog\n\nHistory.\n", entries);
	for (const changed of [
		output.replace("<!-- changes:end -->", "HAND-ADDED\n<!-- changes:end -->"),
		output.replace("change:a", "change:unknown"),
	])
		expect(() => assemble(changed, entries)).toThrow(/move.*\.changes\/.*fragment/i);
});

for (const option of ["--check", "--write"]) {
	test(`${option} refuses handwritten generated content and preserves the file`, () => {
		const scratch = make("changelog-unowned");
		try {
			mkdirSync(join(scratch, ".changes"));
			const input = fragment("owned");
			writeFileSync(join(scratch, ".changes", input.file), input.text);
			const changed = assemble("# Changelog\n\nHistory.\n", fragments([input])).replace(
				"<!-- changes:end -->",
				"HAND-ADDED\n<!-- changes:end -->",
			);
			writeFileSync(join(scratch, "CHANGELOG.md"), changed);
			const run = Bun.spawnSync([process.execPath, join(process.cwd(), "scripts/changelog.ts"), option], {
				cwd: scratch,
				stdout: "pipe",
				stderr: "pipe",
			});
			expect(run.exitCode).not.toBe(0);
			expect(run.stderr.toString()).toMatch(/move.*\.changes\/.*fragment/i);
			expect(readFileSync(join(scratch, "CHANGELOG.md"), "utf8")).toBe(changed);
		} finally {
			remove(scratch);
		}
	});
}

test("discovery refuses every non-fragment directory entry", () => {
	const scratch = make("changelog-files");
	try {
		mkdirSync(join(scratch, ".changes"));
		for (const name of ["u-x.MD", "notes.txt", ".changelog-stale.tmp"])
			writeFileSync(join(scratch, ".changes", name), "ignored before this fix");
		writeFileSync(join(scratch, "CHANGELOG.md"), "# Changelog\n\nHistory.\n");
		const run = Bun.spawnSync([process.execPath, join(process.cwd(), "scripts/changelog.ts"), "--check"], {
			cwd: scratch,
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(run.exitCode).not.toBe(0);
		for (const name of ["u-x.MD", "notes.txt", ".changelog-stale.tmp"]) expect(run.stderr.toString()).toContain(name);
	} finally {
		remove(scratch);
	}
});

test("every repository fragment appears exactly once and the real command validates them", () => {
	const entries = fragments();
	const historical = readFileSync("CHANGELOG.md", "utf8");
	const output = assemble(historical, entries);
	for (const entry of entries) expect(output.split(`<!-- change:${entry.id} -->`)).toHaveLength(2);
	expect(assemble(output, entries)).toBe(output);
	const scratch = make("changelog-test");
	try {
		mkdirSync(join(scratch, ".changes"));
		writeFileSync(join(scratch, "CHANGELOG.md"), historical);
		const input = fragment("cli", "A CLI-assembled fact.");
		writeFileSync(join(scratch, ".changes", input.file), input.text);
		const command = Bun.spawnSync([process.execPath, join(process.cwd(), "scripts/changelog.ts"), "--write"], {
			cwd: scratch,
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(command.exitCode, command.stderr.toString()).toBe(0);
		const written = readFileSync(join(scratch, "CHANGELOG.md"), "utf8");
		expect(written).toContain("A CLI-assembled fact.");
		expect(written.endsWith(historical.slice("# Changelog\n\n".length))).toBe(true);
	} finally {
		remove(scratch);
	}
});

test("--check reports pending fragments as information without writing the aggregate", () => {
	const scratch = make("changelog-pending");
	try {
		mkdirSync(join(scratch, ".changes"));
		const first = fragment("first");
		const second = fragment("second");
		for (const input of [first, second]) writeFileSync(join(scratch, ".changes", input.file), input.text);
		const current = assemble("# Changelog\n\nHistory.\n", fragments([first]));
		writeFileSync(join(scratch, "CHANGELOG.md"), current);
		const run = Bun.spawnSync([process.execPath, join(process.cwd(), "scripts/changelog.ts"), "--check"], {
			cwd: scratch,
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(run.exitCode, run.stderr.toString()).toBe(0);
		expect(run.stdout.toString()).toContain("1 fragment not yet assembled");
		expect(readFileSync(join(scratch, "CHANGELOG.md"), "utf8")).toBe(current);
	} finally {
		remove(scratch);
	}
});
