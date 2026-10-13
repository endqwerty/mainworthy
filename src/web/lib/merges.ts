// What the server made of a merge a conflict card sent, and the draft that is left once that is known.
import { z } from "zod";
import { mergeBodies } from "../../core/merge3.ts";
import { CaseBody } from "../../core/model.ts";
import { type Draft, DraftBody, type DraftConflict } from "./drafts.ts";
import { randomId } from "./ids.ts";

export function sameBody(left: CaseBody, right: CaseBody): boolean {
	return JSON.stringify(DraftBody.parse(left)) === JSON.stringify(DraftBody.parse(right));
}

/** A body as it can be recorded: a step still without an action is left out, and an empty expectation is none. */
export function recordable(body: z.infer<typeof DraftBody>): CaseBody {
	return CaseBody.parse({
		...body,
		steps: body.steps
			.filter((step) => step.action.trim())
			.map((step) => ({ ...step, expected: step.expected || null })),
	});
}

/**
 * What a `decide` with a merge answer did. `refused`: it settled nothing (the evidence had changed, or the
 * question was already answered). `adopted`: the merge, combined with whatever was recorded after the conflict
 * was shown, is `version`. `unchanged`: the head already held it. `waiting`: it is a proposal a person must
 * accept. `moved`: the case had changed in a field of the merge again, nothing was adopted, and `question` asks.
 */
export type MergeFate =
	| { kind: "refused"; needs: string | null }
	| { kind: "adopted"; version: number }
	| { kind: "unchanged" }
	| { kind: "waiting"; question: string }
	| { kind: "moved"; question: string; proposal: string };

const Outcome = z.object({ status: z.string(), needs: z.string().nullable(), effects: z.unknown() });
const Effects = z.discriminatedUnion("status", [
	z.object({ status: z.literal("adopted"), cases: z.array(z.object({ ref: z.string(), version: z.number() })) }),
	z.object({ status: z.literal("unchanged") }),
	z.object({ status: z.literal("open"), adopt: z.string() }),
	z.object({ status: z.literal("conflict"), adopt: z.string(), proposal: z.string() }),
]);

/**
 * Reads the fate of a merge of case `ref` from the reply to its `decide`. The reply is the request's own, or,
 * when that was lost, the one the `command` operation returns: both are what the server recorded.
 */
export function mergeFate({ reply, ref }: { reply: unknown; ref: string }): MergeFate {
	const [outcome] = z.tuple([Outcome]).parse(reply);
	if (outcome.status !== "decided") return { kind: "refused", needs: outcome.needs };
	const effects = Effects.parse(outcome.effects);
	switch (effects.status) {
		case "adopted": {
			const stamp = effects.cases.find((item) => item.ref === ref);
			return stamp ? { kind: "adopted", version: stamp.version } : { kind: "unchanged" };
		}
		case "unchanged":
			return { kind: "unchanged" };
		case "open":
			return { kind: "waiting", question: effects.adopt };
		case "conflict":
			return { kind: "moved", question: effects.adopt, proposal: effects.proposal };
		default: {
			const _exhaustive: never = effects;
			return _exhaustive;
		}
	}
}

/**
 * The text of a card as a draft on the version the draft was written on. The card's merged body also holds what
 * the version it was shown against had changed. Proposed on the draft's own base those fields would count as the
 * person's, and would put a change back that somebody has undone since. Here they are the base's again, so the
 * draft claims only what the person typed or chose, and the server merges the rest or asks.
 */
export function cardText({ draft, conflict }: { draft: Draft; conflict: DraftConflict }): Draft["body"] {
	return mergeBodies({ base: conflict.current, mine: conflict.merged, theirs: draft.original }).merged;
}

/**
 * The draft that is left when the server recorded the merge `sent` for this card, or null when the card and the
 * draft hold nothing that merge did not. `body` is the draft's body as it would be sent.
 *
 * Text is later than the merge when the card differs from what was sent, or the draft from what the card was
 * made of. It is carried onto `recorded`, the version the server made of the merge, only where the person saw
 * what they change: every field of that version is either theirs, as they sent it, or somebody else's. Later
 * text in a field of the second kind is a conflict the page cannot ask about. Then, and when the merge made no
 * version, the card's text stays on the base the draft was written on (`cardText`), and the server merges it or
 * asks when it is proposed.
 */
export function draftAfterMerge({
	draft,
	conflict,
	body,
	sent,
	recorded,
}: {
	draft: Draft;
	conflict: DraftConflict;
	body: CaseBody;
	sent: CaseBody;
	recorded: { version: number; body: CaseBody; tags: string[]; covers: string[] } | null;
}): Draft | null {
	const inCard = !sameBody(sent, conflict.merged);
	const inDraft = !sameBody(conflict.mine, body);
	if (!inCard && !inDraft) return null;
	const rest = { conflict: undefined, sent: null, cmd: randomId() };
	const draftText = { base: conflict.mine, mine: draft.body };
	if (recorded) {
		const card = inCard
			? mergeBodies({ base: sent, mine: conflict.merged, theirs: recorded.body })
			: { merged: recorded.body, conflicts: [] };
		const both = inDraft ? mergeBodies({ ...draftText, theirs: card.merged }) : card;
		if (card.conflicts.length + both.conflicts.length === 0)
			return {
				...draft,
				...rest,
				body: both.merged,
				base: recorded.version,
				original: recorded.body,
				originalTags: recorded.tags,
				originalCovers: recorded.covers,
			};
	}
	const own = cardText({ draft, conflict });
	return { ...draft, ...rest, body: inDraft ? mergeBodies({ ...draftText, theirs: own }).merged : own };
}
