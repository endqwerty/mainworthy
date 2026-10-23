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

test("assembly relocates inline and reference links from .changes/ to the root changelog", () => {
	const entry = fragment(
		"links",
		"[guide](../docs/development/README.md) and [decisions][records].\n\n[records]: ../docs/decisions/2026-10-23-changelog-fragments-and-dated-decisions.md",
	);
	const output = assemble("# Changelog\n\nOld history.\n", fragments([entry]));
	expect(output).toContain("[guide](docs/development/README.md)");
	expect(output).toContain("[records]: docs/decisions/2026-10-23-changelog-fragments-and-dated-decisions.md");
	expect(Bun.markdown.html(output)).toContain(
		'href="docs/decisions/2026-10-23-changelog-fragments-and-dated-decisions.md"',
	);
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
