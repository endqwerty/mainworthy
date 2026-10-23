// These checks read .changes/ fragments and CHANGELOG.md through their authoring scripts.
import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
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
		expect(() => assemble(changed, entries)).toThrow(/restore CHANGELOG\.md.*add a \.changes\/ fragment/i);
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
			expect(run.stderr.toString()).toMatch(/restore CHANGELOG\.md.*add a \.changes\/ fragment/i);
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
		// The repository's assembled section names fragments this scratch does not have; start from the history alone.
		const end = "<!-- changes:end -->";
		const unassembled = historical.includes(end)
			? `# Changelog\n\n${historical.slice(historical.indexOf(end) + end.length).replace(/^\n+/, "")}`
			: historical;
		writeFileSync(join(scratch, "CHANGELOG.md"), unassembled);
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
		expect(written.endsWith(unassembled.slice("# Changelog\n\n".length))).toBe(true);
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

test("generated lines must match their canonical fragment even when their marker remains", () => {
	const entries = fragments([fragment("security", "A security entry.")]);
	const current = assemble("# Changelog\n\nHistory.\n", entries);
	expect(() => assemble(current.replace("A security entry.", "An edited entry."), entries)).toThrow(
		/canonical|differs|does not match/i,
	);
});

for (const kind of ["edited", "removed", "complete"]) {
	test(`complete checking ${kind === "complete" ? "accepts a complete aggregate" : `refuses ${kind === "edited" ? "an edited" : "a removed"} assembled entry`}`, () => {
		const scratch = make("changelog-complete");
		try {
			mkdirSync(join(scratch, ".changes"));
			const input = fragment("security", "A security entry.");
			writeFileSync(join(scratch, ".changes", input.file), input.text);
			const current = assemble("# Changelog\n\nHistory.\n", fragments([input]));
			const changed =
				kind === "edited"
					? current.replace("A security entry.", "An edited entry.")
					: kind === "removed"
						? current
								.split("\n")
								.filter((line) => !line.includes("<!-- change:security -->"))
								.join("\n")
						: current;
			writeFileSync(join(scratch, "CHANGELOG.md"), changed);
			const run = Bun.spawnSync(
				[process.execPath, join(process.cwd(), "scripts/changelog.ts"), "--check", "--complete"],
				{ cwd: scratch, stdout: "pipe", stderr: "pipe" },
			);
			if (kind === "complete") expect(run.exitCode, run.stderr.toString()).toBe(0);
			else {
				expect(run.exitCode).not.toBe(0);
				expect(run.stderr.toString()).toMatch(
					kind === "edited" ? /canonical|differs|does not match/i : /not fully assembled/i,
				);
				if (kind === "edited")
					expect(run.stderr.toString()).toMatch(/restore CHANGELOG\.md.*add a \.changes\/ fragment/i);
				else expect(run.stderr.toString()).toContain("re-run bun scripts/changelog.ts --write --base=origin/main");
			}
			expect(readFileSync(join(scratch, "CHANGELOG.md"), "utf8")).toBe(changed);
		} finally {
			remove(scratch);
		}
	});
}

const restoreGuidance = /restore CHANGELOG\.md.*add a \.changes\/ fragment/i;

function historyFixture(assembled: boolean) {
	const scratch = make("changelog-history");
	mkdirSync(join(scratch, ".changes"));
	const input = fragment("security", "A security entry.");
	writeFileSync(join(scratch, ".changes", input.file), input.text);
	const entries = fragments([input]);
	const history = "# Changelog\n\n- A preserved historical fact.\n";
	const baseText = assembled ? assemble(history, entries) : history;
	writeFileSync(join(scratch, "CHANGELOG.md"), baseText);
	const git = (...args: string[]) => {
		const run = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
			cwd: scratch,
			stdout: "pipe",
			stderr: "pipe",
		});
		if (run.exitCode !== 0) throw new Error(run.stderr.toString());
		return run.stdout.toString().trim();
	};
	git("init", "-q");
	git("add", "CHANGELOG.md");
	git("commit", "-qm", "base history");
	return { scratch, entries, history, baseText, git, base: git("rev-parse", "HEAD") };
}

for (const kind of ["below", "history edit", "above"]) {
	test(`base-aware checking refuses a hand-written change ${kind}`, () => {
		const fixture = historyFixture(true);
		try {
			const changed =
				kind === "below"
					? fixture.baseText.replace("<!-- changes:end -->\n\n", "<!-- changes:end -->\n\n- A hand-written entry.\n")
					: kind === "above"
						? fixture.baseText.replace("# Changelog\n\n", "# Changelog\n\n- A hand-written entry.\n")
						: fixture.baseText.replace("preserved historical", "rewritten historical");
			writeFileSync(join(fixture.scratch, "CHANGELOG.md"), changed);
			const run = Bun.spawnSync(
				[
					process.execPath,
					join(process.cwd(), "scripts/changelog.ts"),
					"--check",
					"--complete",
					`--base=${fixture.base}`,
				],
				{ cwd: fixture.scratch, stdout: "pipe", stderr: "pipe" },
			);
			expect(run.exitCode).not.toBe(0);
			expect(run.stderr.toString()).toMatch(restoreGuidance);
			expect(readFileSync(join(fixture.scratch, "CHANGELOG.md"), "utf8")).toBe(changed);
		} finally {
			remove(fixture.scratch);
		}
	});
}

test("writing before the first assembly cannot launder a hand-written entry into trusted history", () => {
	const fixture = historyFixture(false);
	try {
		writeFileSync(
			join(fixture.scratch, "CHANGELOG.md"),
			fixture.baseText.replace("# Changelog\n\n", "# Changelog\n\n- A hand-written entry.\n"),
		);
		const run = Bun.spawnSync([process.execPath, join(process.cwd(), "scripts/changelog.ts"), "--write"], {
			cwd: fixture.scratch,
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(run.exitCode, run.stderr.toString()).toBe(0);
		const written = readFileSync(join(fixture.scratch, "CHANGELOG.md"), "utf8");
		expect(() => assemble(written, fixture.entries, { base: fixture.baseText })).toThrow(restoreGuidance);
	} finally {
		remove(fixture.scratch);
	}
});

test("base-aware coordinator assembly keeps historical text unchanged", () => {
	const fixture = historyFixture(false);
	try {
		const run = Bun.spawnSync(
			[process.execPath, join(process.cwd(), "scripts/changelog.ts"), "--write", `--base=${fixture.base}`],
			{ cwd: fixture.scratch, stdout: "pipe", stderr: "pipe" },
		);
		expect(run.exitCode, run.stderr.toString()).toBe(0);
		const written = readFileSync(join(fixture.scratch, "CHANGELOG.md"), "utf8");
		expect(written).toBe(assemble(fixture.baseText, fixture.entries, { base: fixture.baseText }));
	} finally {
		remove(fixture.scratch);
	}
});

for (const scenario of [
	{ event: "push", change: "late fragment" },
	{ event: "pull_request", change: "late fragment" },
	{ event: "push", change: "removed entry" },
	{ event: "push", change: "removed section" },
	{ event: "push", change: "edited entry" },
	{ event: "push", change: "hand-written history" },
]) {
	test(`CI ${scenario.event} handles an older assembly with ${scenario.change}`, () => {
		const fixture = historyFixture(true);
		try {
			const batch = fragment("batch", "A fact included by the assembly PR.");
			writeFileSync(join(fixture.scratch, ".changes", batch.file), batch.text);
			const prepared = assemble(fixture.baseText, [...fixture.entries, ...fragments([batch])]);
			const late = fragment("late", "A fact that landed after the assembly was prepared.");
			writeFileSync(join(fixture.scratch, ".changes", late.file), late.text);
			fixture.git("add", ".changes");
			fixture.git("commit", "-qm", "a late fragment lands on main");
			const base = fixture.git("rev-parse", "HEAD");
			const changed =
				scenario.change === "removed entry"
					? prepared
							.split("\n")
							.filter((line) => !line.includes("<!-- change:security -->"))
							.join("\n")
					: scenario.change === "removed section"
						? fixture.history
						: scenario.change === "edited entry"
							? prepared.replace("A security entry.", "An edited security entry.")
							: scenario.change === "hand-written history"
								? prepared.replace("preserved historical", "rewritten historical")
								: prepared;
			writeFileSync(join(fixture.scratch, "CHANGELOG.md"), changed);
			fixture.git("add", "CHANGELOG.md");
			fixture.git("commit", "-qm", "merge the previously prepared assembly");
			mkdirSync(join(fixture.scratch, "scripts"));
			for (const name of ["changelog.ts", "record-files.ts"])
				copyFileSync(join("scripts", name), join(fixture.scratch, "scripts", name));
			symlinkSync(join(process.cwd(), "node_modules"), join(fixture.scratch, "node_modules"), "dir");
			const workflow = z
				.object({ jobs: z.object({ tests: z.object({ steps: z.array(z.object({ run: z.string().optional() })) }) }) })
				.parse(Bun.YAML.parse(readFileSync(".github/workflows/check.yml", "utf8")));
			const script = workflow.jobs.tests.steps.find((step) => step.run?.includes("scripts/changelog.ts --check"))?.run;
			if (!script) throw new Error("the workflow has no changelog check");
			const run = Bun.spawnSync(["bash", "-eo", "pipefail", "-c", script], {
				cwd: fixture.scratch,
				env: { ...process.env, BASE: base, GITHUB_EVENT_NAME: scenario.event },
				stdout: "pipe",
				stderr: "pipe",
			});
			if (scenario.event === "push" && scenario.change === "late fragment") {
				expect(run.exitCode, run.stderr.toString()).toBe(0);
				expect(run.stdout.toString()).toContain("1 fragment not yet assembled");
			} else {
				expect(run.exitCode).not.toBe(0);
				if (scenario.change === "late fragment") {
					expect(run.stderr.toString()).toContain("re-run bun scripts/changelog.ts --write --base=origin/main");
					expect(run.stderr.toString()).not.toContain("Do not hand-edit");
				} else expect(run.stderr.toString()).toMatch(restoreGuidance);
			}
			expect(readFileSync(join(fixture.scratch, "CHANGELOG.md"), "utf8")).toBe(changed);
		} finally {
			remove(fixture.scratch);
		}
	});
}
