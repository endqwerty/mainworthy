// Which questions may be answered together. One answer is for one kind, and nobody selects what they cannot settle.
import { ANSWER_KEYS, type Kind } from "../../core/kinds.ts";
import type { QuestionItem } from "../../core/ops.ts";

export type Row = Pick<QuestionItem, "q" | "kind" | "you" | "answers">;

const one: Record<Kind, string> = {
	adopt: "proposal",
	map: "unlinked",
	failure: "failure",
	finding: "finding",
	signoff: "sign-off",
};
const many: Record<Kind, string> = {
	adopt: "proposals",
	map: "unlinked",
	failure: "failures",
	finding: "findings",
	signoff: "sign-offs",
};

/**
 * Whether the question takes this answer. A reply the page could not read may lack the list; the question then
 * says why it cannot be answered (`questionReadMessage`), and nothing is refused here for it.
 */
export function takes(question: Row, is: string): boolean {
	return !Array.isArray(question.answers) || question.answers.includes(is);
}

/** "3 failures", "1 failure", "2 unlinked". */
export function countOf(count: number, kind: Kind): string {
	return `${count} ${count === 1 ? one[kind] : many[kind]}`;
}

/** The questions by ref, or by how many there are once a list of refs would be too long to read in one line. */
export function named(questions: readonly Row[]): string {
	const first = questions[0];
	return first && questions.length > 3
		? countOf(questions.length, first.kind)
		: questions.map((question) => question.q).join(", ");
}

/** Why this question cannot join the selection, or null when it can. */
export function whyNotSelectable(question: Row, selection: readonly Row[]): string | null {
	if (question.you === "forbidden") return `You cannot settle ${question.q}.`;
	const kind = selection[0]?.kind;
	if (kind && question.kind !== kind)
		return `${question.q} is ${question.kind === "map" ? "unlinked" : `a ${one[question.kind]}`} and the selection is of ${many[kind]}: one answer is for one kind.`;
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
): { refs: string[]; skipped: number } {
	const end = items.findIndex((item) => item.q === target);
	const found = items.findIndex((item) => item.q === anchor);
	const start = found === -1 ? end : found;
	const rows = items.slice(Math.min(start, end), Math.max(start, end) + 1);
	const first = items[end];
	const basis = selection.length || !first ? selection : [first];
	const refs = rows.filter((row) => whyNotSelectable(row, basis) === null).map((row) => row.q);
	return { refs, skipped: rows.length - refs.length };
}

/** Every listed question of this kind that you may answer. */
export function allOfKind(items: readonly Row[], kind: Kind): string[] {
	return items.filter((item) => item.kind === kind && item.you !== "forbidden").map((item) => item.q);
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
