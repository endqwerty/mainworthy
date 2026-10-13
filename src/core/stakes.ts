// What leaving a question unanswered costs, in a sentence, and which open questions can wait.
// The queue prints it under a question's title, so nobody has to work out whether a row needs them today.
import type { Kind } from "./kinds.ts";

/**
 * Whether an open question of this kind is urgent. Only an unexplained failure is: it blocks every run that
 * counts it under any policy (a clause's `blocks` says which runs list the question, not what the verdict is).
 * Every other kind leaves things as they are until somebody answers.
 */
export const urgent = (kind: Kind): boolean => kind === "failure";

/** The open questions that are failures to explain and those that can wait, from the queue's counts by kind. */
export function waiting(counts: Readonly<Record<string, number>>): { failures: number; canWait: number } {
	const failures = counts.failure ?? 0;
	return { failures, canWait: Math.max(0, (counts.open ?? 0) - failures) };
}

/** The queue's count in words: "1 failure to explain · 104 can wait". */
export function waitingPhrase(counts: Readonly<Record<string, number>>): string {
	const { failures, canWait } = waiting(counts);
	if (failures === 0 && canWait === 0) return "nothing needs an answer";
	const parts: string[] = [];
	if (failures > 0) parts.push(`${failures} ${failures === 1 ? "failure" : "failures"} to explain`);
	if (canWait > 0) parts.push(`${canWait} can wait`);
	return parts.join(" · ");
}

/** Run refs in a sentence: the first three, and how many more. */
const named = (refs: readonly string[]): string =>
	refs.length <= 3 ? refs.join(", ") : `${refs.slice(0, 3).join(", ")} and ${refs.length - 3} more`;

/**
 * What happens while this question stays open. `blocks` are the runs it names; `facts` are the question's
 * (`conflict`, `policy`).
 *
 * A failure's sentence says the one thing that holds of every open failure question: while nobody has explained
 * the failure, no gate that counts it passes. ("The unexplained failure" is the occurrence the question asks
 * about: an earlier occurrence of the same cause that somebody answered for another target is excused there.) It does not say which gates those are, or how the block can end
 * without an answer. A question cannot tell: the runs it names are the ones it was listed under as its results
 * arrived, an older commit's among them, and a failing result stops counting when it is replaced, whatever the
 * outcome that replaces it. The guide describes those; a sentence that tried to was wrong in some case each time.
 */
export function stakes(question: { kind: Kind; blocks: readonly string[]; facts: ReadonlySet<string> }): string {
	const { kind, blocks, facts } = question;
	switch (kind) {
		case "failure": {
			const held = "While this is open, no gate that counts the unexplained failure passes.";
			return blocks.length > 0 ? `Listed as blocking ${named(blocks)}. ${held}` : held;
		}
		case "map":
			return "Blocks nothing. Left alone, these tests still run and still gate the build, and no case gets credit for them.";
		case "adopt":
			if (facts.has("policy")) return "Blocks nothing. Left alone, the policy stays as it is.";
			if (facts.has("conflict"))
				return "Blocks nothing. Left alone, the case stays as it is: the edit was made on an older version and waits for its author.";
			return "Blocks nothing. Left alone, the case stays as it is and the edit waits.";
		case "finding":
			return "Blocks nothing. Left alone, the finding stays on record with no answer.";
		case "signoff":
			return "Blocks nothing. Left alone, the run stays open.";
		default: {
			const _exhaustive: never = kind;
			return _exhaustive;
		}
	}
}
