import { REQUIREMENT_KEY, TAG } from "./model.ts";

export type Outline = {
	title: string | null;
	steps: { action: string; expected: string | null }[];
	tags: string[];
	covers: string[];
};

const expectedDelimiter = / (?:>|=>|->|→) |(?:^|[ \t])(?:expected(?: result)?|expect|then):[ \t]*/i;
const expectedPrefix = /^(?:=>|->|>|→)[ \t]*|^(?:expected(?: result)?|expect|then):[ \t]*/i;
const listMarker = /^(?:[-*+•]|\d+[.)]|\(\d+\)|[a-z]\.|\[[ x]\]|step[ \t]+\d+:)(?:[ \t]+|$)/i;
const heading = /^#{1,6}[ \t]+/;
const separatorCell = /^:?-{3,}:?$/;

/** Splits at the first expected-result delimiter. Without a delimiter, preserves the editor's input exactly. */
export function splitExpected(line: string): { action: string; expected: string | null } {
	const match = expectedDelimiter.exec(line);
	if (!match) return { action: line, expected: null };
	return {
		action: line.slice(0, match.index).trimEnd(),
		expected: line.slice(match.index + match[0].length).trim() || null,
	};
}

type CaptureLine = { text: string; indent: number; marked: boolean };

function captureLine(raw: string): CaptureLine {
	let start = 0;
	let indent = 0;
	while (start < raw.length) {
		const char = raw.charAt(start);
		if (char === " ") indent++;
		else if (char === "\t") indent += 4;
		else break;
		start++;
	}
	let text = raw.slice(start).trimEnd();
	let marked = false;
	let match = listMarker.exec(text);
	while (match) {
		marked = true;
		text = text.slice(match[0].length);
		match = listMarker.exec(text);
	}
	return { text, indent, marked };
}

function tableCells(text: string): string[] | null {
	if (!text.startsWith("|") || !text.endsWith("|")) return null;
	const cells: string[] = [];
	let start = 1;
	let escaped = false;
	for (let i = 1; i < text.length; i++) {
		const char = text.charAt(i);
		if (char === "|" && !escaped) {
			cells.push(text.slice(start, i).trim());
			start = i + 1;
		}
		escaped = char === "\\" && !escaped;
	}
	if (start !== text.length) return null;
	return cells.length >= 2 ? cells : null;
}

function columns({
	cells,
	numbered,
	joiner,
}: {
	cells: string[];
	numbered: boolean;
	joiner: string;
}): Outline["steps"][number] {
	const offset = numbered && /^\d+$/.test(cells[0]?.trim() ?? "") ? 1 : 0;
	return {
		action: cells[offset] ?? "",
		expected: cells.slice(offset + 1).join(joiner) || null,
	};
}

function titleMetadata(text: string): Pick<Outline, "title" | "tags" | "covers"> {
	const tags = new Set<string>();
	const covers = new Set<string>();
	const title = text.replace(
		/(^|[ \t])([#@])([^\s]+)/g,
		(whole: string, space: string, marker: string, token: string) => {
			if (marker === "#" && TAG.test(token)) {
				tags.add(token);
				return space;
			}
			if (marker === "@" && REQUIREMENT_KEY.test(token)) {
				covers.add(token);
				return space;
			}
			return whole;
		},
	);
	return { title: title.trim().replace(/[ \t]+/g, " "), tags: [...tags], covers: [...covers] };
}

/** Captures outlines and pasted two-column text without throwing; only recognized grammar syntax is discarded. */
export function parseOutline(text: string): Outline {
	const lines = text.split(/\r\n|\n|\r/).filter((line) => line.trim().length > 0);
	const result: Outline = { title: null, steps: [], tags: [], covers: [] };
	const first = lines[0];
	if (first === undefined) return result;
	const captured = lines.map(captureLine);
	const firstCapture = captured[0];
	if (firstCapture === undefined) return result;
	const explicitTitle = heading.exec(first.trimStart());
	const implicitTitle =
		firstCapture.indent === 0 &&
		!firstCapture.marked &&
		!first.includes("\t") &&
		tableCells(firstCapture.text) === null &&
		captured.slice(1).every((line) => line.indent > 0 || line.marked);
	let index = 0;
	if (explicitTitle || implicitTitle) {
		Object.assign(result, titleMetadata(explicitTitle ? first.trimStart().slice(explicitTitle[0].length) : first));
		index = 1;
	}
	let previousIndent = 0;
	for (; index < captured.length; index++) {
		const line = captured[index];
		if (!line) continue;
		const cells = tableCells(line.text);
		if (cells) {
			if (cells.every((cell) => separatorCell.test(cell))) continue;
			const next = captured[index + 1];
			const nextCells = next ? tableCells(next.text) : null;
			if (nextCells?.every((cell) => separatorCell.test(cell))) {
				index++;
				continue;
			}
			result.steps.push(columns({ cells, numbered: true, joiner: " | " }));
			previousIndent = line.indent;
			continue;
		}
		if (line.text.includes("\t")) {
			const cells = line.text.split("\t");
			result.steps.push(columns({ cells, numbered: cells.length >= 3, joiner: "\t" }));
			previousIndent = line.indent;
			continue;
		}
		const prefix = expectedPrefix.exec(line.text);
		const previous = result.steps.at(-1);
		if (previous && (prefix || line.indent > previousIndent)) {
			const expected = prefix ? line.text.slice(prefix[0].length) : line.text;
			if (expected.length > 0)
				previous.expected = previous.expected === null ? expected : `${previous.expected}\n${expected}`;
			continue;
		}
		result.steps.push(prefix ? { action: line.text, expected: null } : splitExpected(line.text));
		previousIndent = line.indent;
	}
	return result;
}
