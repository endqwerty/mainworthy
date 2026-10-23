// Which questions may be answered together. One answer is for one kind, and nobody selects what they cannot settle.
import { z } from "zod";
import { ANSWER_KEYS, countOf, DECIDE_MAX, KIND_WORDS, type Kind } from "../../core/kinds.ts";
import type { QuestionItem } from "../../core/replies.ts";

export type Row = Pick<QuestionItem, "q" | "kind" | "you" | "answers" | "evidence">;

const Tests = z.object({ count: z.number() });

/** How many tests an unlinked question is about, or null when its evidence could not be read. */
function testsOf(question: Row): number | null {
	const parsed = Tests.safeParse(question.evidence);
	return parsed.success ? parsed.data.count : null;
}

/**
 * How many, in words, of questions of one kind: "3 failures". Unlinked questions are counted by their tests,
 * "9 unlinked tests": one is about a file's tests, or about every test that came with no file.
 */
export function counted(questions: readonly Row[]): string {
	const first = questions[0];
	if (!first) return "";
	const count =
		first.kind === "map" ? questions.reduce((sum, question) => sum + (testsOf(question) ?? 0), 0) : questions.length;
	return countOf(count, first.kind);
}

/**
 * Whether the question takes this answer. A reply the page could not read may lack the list; the question then
 * says why it cannot be answered (`questionReadMessage`), and nothing is refused here for it.
 */
export function takes(question: Row, is: string): boolean {
	return !Array.isArray(question.answers) || question.answers.includes(is);
}

/** The refs a selection keeps, the first `DECIDE_MAX` in the order given, and how many it leaves out. */
export function capped(refs: readonly string[]): { kept: string[]; left: number } {
	const kept = refs.slice(0, DECIDE_MAX);
	return { kept, left: refs.length - kept.length };
}

/** The questions by ref, or by how many there are once a list of refs would be too long to read in one line. */
export function named(questions: readonly Row[]): string {
	const first = questions[0];
	return first && questions.length > 3 ? counted(questions) : questions.map((question) => question.q).join(", ");
}

/**
 * Whether an answer to the question counts only once its content has been read on screen: a proposal's edits, a
 * finding's suggested edit (`questionReadMessage`). Only the question shown has its content on screen, so such a
 * question is answered alone.
 */
export type Alone = (question: Row) => boolean;
const never: Alone = () => false;

/** Why this question cannot join the selection, or null when it can. */
export function whyNotSelectable(question: Row, selection: readonly Row[], alone: Alone = never): string | null {
	if (question.you === "forbidden") return `You cannot settle ${question.q}.`;
	if (alone(question))
		return `${question.q} is answered on its own: its ${question.kind === "adopt" ? "edits are" : "suggested edit is"} read on screen before an answer counts.`;
	if (question.kind === "map" && testsOf(question) === null)
		return `${question.q} is answered on its own: its tests could not be read.`;
	const kind = selection[0]?.kind;
	if (kind && question.kind !== kind)
		return `${question.q} is ${question.kind === "map" ? "unlinked" : `a ${KIND_WORDS[question.kind].one}`} and the selection is of ${KIND_WORDS[kind].many}: one answer is for one kind.`;
	return null;
}

/**
 * The rows from the anchor to the target, both included, that may join the selection, in list order, and how
 * many between them may not. The selection's kind decides; with none, the target's.
 */
export function rangeOf(
	items: readonly Row[],
	selection: readonly Row[],
	anchor: string | null,
	target: string,
	alone: Alone = never,
): { refs: string[]; skipped: number } {
	const end = items.findIndex((item) => item.q === target);
	const found = items.findIndex((item) => item.q === anchor);
	const start = found === -1 ? end : found;
	const rows = items.slice(Math.min(start, end), Math.max(start, end) + 1);
	const first = items[end];
	const basis = selection.length || !first ? selection : [first];
	const refs = rows.filter((row) => whyNotSelectable(row, basis, alone) === null).map((row) => row.q);
	return { refs, skipped: rows.length - refs.length };
}

/** Every listed question of this kind that you may answer. */
export function allOfKind(items: readonly Row[], kind: Kind, alone: Alone = never): string[] {
	return items.filter((item) => item.kind === kind && whyNotSelectable(item, [], alone) === null).map((item) => item.q);
}

/**
 * The answers of the selection's kind, in key order, each with why it cannot be given to all of them (null when
 * it can). A link asks for a case per test, so it is given to one question at a time.
 */
export function sharedAnswers(selection: readonly Row[]): { key: string; is: string; why: string | null }[] {
	const first = selection[0];
	if (!first) return [];
	return Object.entries(ANSWER_KEYS[first.kind]).map(([key, is]) => ({
		key,
		is,
		why:
			is === "link" && selection.length > 1
				? "Link one question at a time so each test can have its own case."
				: selection.every((question) => takes(question, is))
					? null
					: "Not every selected question takes this answer.",
	}));
}
