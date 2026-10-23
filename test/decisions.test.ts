import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { decisions } from "../scripts/decisions.ts";

const dated = (slug = "example", title = "Example") => ({
	file: `2026-10-23-${slug}.md`,
	text: `# ${title}\n\n- Date: 2026-10-23\n- Status: accepted\n- PR: pending\n\nA design decision.\n`,
});

test("the decision index accepts both conventions and sorts by date then stable id", () => {
	const records = decisions([
		dated("z", "Z"),
		{ file: "0002-old.md", text: "# 0002: Old\n\n- Date: 2026-10-22\n- Status: accepted\n" },
		dated("a", "A"),
		{ file: "0001-undated.md", text: "# Historical undated decision\n" },
	]);
	expect(records.map((record) => record.id)).toEqual(["0001", "0002", "2026-10-23-a", "2026-10-23-z"]);
	expect(records[0]?.date).toBeNull();
});

test("decisions reject conflicting ids, mismatched headings, missing metadata and bad links", () => {
	for (const input of [
		{ ...dated(), file: "not-a-decision.md" },
		{ ...dated(), text: dated().text.replace("# Example", "# 2026: Example") },
		{ ...dated(), text: dated().text.replace("Date: 2026-10-23", "Date: 2026-10-24") },
		{ ...dated(), text: dated().text.replace("- Status: accepted\n", "") },
		{ ...dated(), text: dated().text.replace("- Status: accepted", "- Status: wrong") },
		{ ...dated(), text: dated().text.replace("- PR: pending\n", "") },
		{ ...dated(), text: `${dated().text}\n[bad](no-such-decision.md)` },
		{ file: "0001-old.md", text: "# 0002: Wrong number\n" },
	])
		expect(() => decisions([input])).toThrow();
	expect(() => decisions([dated(), dated()])).toThrow(/duplicate/i);
	expect(() =>
		decisions([
			{ file: "0001-a.md", text: "# 0001: A" },
			{ file: "0001-b.md", text: "# 0001: B" },
		]),
	).toThrow(/duplicate/i);
});

test("mistyped dates cannot fall back to historical decision numbers", () => {
	for (const file of ["2026-10-3-a.md", "2026-1-03-a.md", "2026-not-a-date.md", "2026-10-32-a.md"])
		expect(() => decisions([{ file, text: "# A title\n" }])).toThrow(/dated.*filename|filename.*dated|date/i);
});

test("0155 is the last historical numbered record and later records must be dated", () => {
	const file = "0155-placement-undo-comes-from-recorded-effects.md";
	expect(decisions([{ file, text: readFileSync(`docs/decisions/${file}`, "utf8") }])[0]?.id).toBe("0155");
	expect(() => decisions([{ file: "0156-new-record.md", text: "# 0156: New record\n" }])).toThrow(/dated/i);
	expect(() => decisions([dated("new-record", "New record")])).not.toThrow();
});
