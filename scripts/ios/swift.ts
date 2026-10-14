// The Swift that is written from this repository's TypeScript, so that the iOS app has one description of a
// reply and one copy of the queue's words:
//
// - `Wire.swift`: a type for each shape of `contract.ts`.
// - `Vocabulary.swift`: the label and the consequence of every answer, from `src/core/kinds.ts`.
// - `Parity.swift`: what the functions of `src/core` that the app wrote again in Swift return, for a list of
//   inputs. The app's tests hold its own functions to it, so a sentence changed here fails there.
//
// `bun scripts/ios.ts gen` writes the files; `test/ios-contract.test.ts` fails when one is not what this prints.
import { ANSWER_HELP, ANSWER_LABELS, KINDS } from "../../src/core/kinds.ts";
import { stakes, waitingPhrase } from "../../src/core/stakes.ts";
import { SHAPES } from "./contract.ts";
import type { Struct } from "./shape.ts";

const HEADER = (from: string) =>
	`// Written by \`bun scripts/ios.ts gen\` from ${from}. Do not edit it: change that file and run the command again.\n`;

/** A string as Swift writes one. */
export function literal(value: string): string {
	const ESCAPES: Record<string, string> = { "\\": "\\\\", '"': '\\"', "\n": "\\n", "\r": "\\r", "\t": "\\t" };
	const escaped = [...value]
		.map((char) => ESCAPES[char] ?? (char < " " ? `\\u{${char.charCodeAt(0).toString(16)}}` : char))
		.join("");
	return `"${escaped}"`;
}

/** The words Swift keeps for itself. A field named like one is written between backticks. */
const RESERVED = new Set(
	"as associatedtype break case catch class continue default defer do else enum extension fallthrough false for func guard if import in init inout internal is let nil operator private protocol public repeat rethrows return self static struct subscript super switch throw throws true try typealias var where while".split(
		" ",
	),
);
const name = (key: string): string => {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`${key}: not a name Swift can give a field`);
	return RESERVED.has(key) ? `\`${key}\`` : key;
};

/** A comment, wrapped at the width the repository's other files keep. */
function comment(text: string, indent: string): string {
	const lines: string[] = [];
	let line = "";
	for (const word of text.split(/\s+/)) {
		if (line && `${indent}/// ${line} ${word}`.length > 116) {
			lines.push(line);
			line = word;
		} else line = line ? `${line} ${word}` : word;
	}
	if (line) lines.push(line);
	return lines.map((part) => `${indent}/// ${part}\n`).join("");
}

/** Every struct the shapes name, once each, a nested one before the one that holds it. */
export function structsOf(): Struct[] {
	const seen = new Map<string, Struct>();
	for (const shape of SHAPES) {
		for (const struct of shape.structs) {
			const before = seen.get(struct.name);
			if (before && before !== struct) throw new Error(`two shapes of the contract are named ${struct.name}`);
			seen.set(struct.name, struct);
		}
	}
	return [...seen.values()];
}

export function wire(): string {
	const body = structsOf()
		.map((struct) => {
			const fields = struct.fields
				.map(
					(field) => `${field.doc ? comment(field.doc, "\t\t") : ""}\t\tlet ${name(field.key)}: ${field.shape.swift}\n`,
				)
				.join("");
			return `${comment(struct.doc, "\t")}\tstruct ${struct.name}: Decodable, Equatable, Sendable {\n${fields}\t}\n`;
		})
		.join("\n");
	return [
		HEADER("scripts/ios/contract.ts"),
		"/// The server's replies, as far as the app reads them. A field the server sends and the app does not read is",
		"/// not here. Nothing outside this module sees these types: each is turned into one of the app's own where",
		"/// it is decoded.",
		"enum Wire {",
		body.trimEnd(),
		"}",
		"",
	].join("\n");
}

const table = (entries: [string, string][], indent: string): string =>
	entries.map(([key, value]) => `${indent}${literal(key)}: ${value},\n`).join("");

export function vocabulary(): string {
	const labels = table(
		Object.entries(ANSWER_LABELS).map(([answer, label]) => [answer, literal(label)]),
		"\t\t",
	);
	const help = table(
		KINDS.map((kind) => [
			kind,
			`[\n${table(
				Object.entries<string>(ANSWER_HELP[kind]).map(([answer, sentence]) => [answer, literal(sentence)]),
				"\t\t\t",
			)}\t\t]`,
		]),
		"\t\t",
	);
	return [
		HEADER("src/core/kinds.ts"),
		"/// The words of the queue: what each answer is called and what it does, as every other client says them.",
		"enum Vocabulary {",
		"\t/// The name of each answer, by the word the server knows it by.",
		`\tstatic let answerLabels: [String: String] = [\n${labels}\t]`,
		"",
		"\t/// What each answer does, in a sentence, by the kind of question and the answer.",
		`\tstatic let answerHelp: [String: [String: String]] = [\n${help}\t]`,
		"}",
		"",
	].join("\n");
}

/** The inputs each function of `src/core` is run on. Wide enough that every branch of it is taken. */
const BLOCKS: string[][] = [[], ["R-1"], ["R-1", "R-2", "R-3"], ["R-1", "R-2", "R-3", "R-4", "R-5"]];
const FACTS: string[][] = [[], ["policy"], ["conflict"], ["scope:change"]];
const COUNTS: Record<string, number>[] = [
	{},
	{ open: 1, failure: 1 },
	{ open: 3, failure: 1 },
	{ open: 5, failure: 2 },
	{ open: 4, map: 3, adopt: 1 },
	{ open: 1, finding: 1 },
	{ open: 2, failure: 3 },
];

const strings = (values: readonly string[]): string => `[${values.map(literal).join(", ")}]`;

export function parity(): string {
	const stakesCases = KINDS.flatMap((kind) =>
		BLOCKS.flatMap((blocks) =>
			FACTS.map(
				(facts) =>
					`\t\t(${literal(kind)}, ${strings(blocks)}, ${strings(facts)}, ${literal(stakes({ kind, blocks, facts: new Set(facts) }))}),\n`,
			),
		),
	).join("");
	const waitingCases = COUNTS.map((counts) => {
		const entries = Object.entries(counts).map(([key, value]) => `${literal(key)}: ${value}`);
		return `\t\t(${entries.length > 0 ? `[${entries.join(", ")}]` : "[:]"}, ${literal(waitingPhrase(counts))}),\n`;
	}).join("");
	return [
		HEADER("src/core/stakes.ts"),
		"/// What the functions of `src/core/stakes.ts` return. The app has those functions again in Swift, and its tests",
		"/// hold them to these answers.",
		"enum Parity {",
		"\t/// `stakes`: the kind of question, the runs it blocks and its facts, and the sentence.",
		`\tstatic let stakes: [(kind: String, blocks: [String], facts: [String], says: String)] = [\n${stakesCases}\t]`,
		"",
		"\t/// `waitingPhrase`: the open questions by kind, and the sentence.",
		`\tstatic let waiting: [(counts: [String: Int], says: String)] = [\n${waitingCases}\t]`,
		"}",
		"",
	].join("\n");
}

/** Every generated file, by its path in the repository. */
export function generated(): Record<string, string> {
	return {
		"ios/Kit/Sources/MainworthyClient/Generated/Wire.swift": wire(),
		"ios/Kit/Sources/MainworthyClient/Generated/Vocabulary.swift": vocabulary(),
		"ios/Kit/Tests/MainworthyClientTests/Generated/Parity.swift": parity(),
	};
}
