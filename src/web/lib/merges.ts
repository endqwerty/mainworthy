// What the server made of a merge a conflict card sent, and the draft that is left once that is known.
import { z } from "zod";
import { mergeBodies } from "../../core/merge3.ts";
import { CaseBody } from "../../core/model.ts";
import { type Draft, DraftBody, type DraftConflict, hasTypedMerge } from "./drafts.ts";
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
 * The text a draft holds. A step is text as soon as it has an action or an expectation: one with an expectation
 * and no action yet cannot be recorded, and is still something the person typed. A step with neither is not.
 */
function heldText(body: Draft["body"]): Draft["body"] {
	return {
		...body,
		steps: body.steps
			.filter((step) => step.action.trim() || step.expected?.trim())
			.map((step) => ({ ...step, expected: step.expected || null })),
	};
}
/** Whether the draft holds text the card was not made of. The editor is closed while a card is open, so this is rare. */
const beyondCard = ({ draft, conflict }: { draft: Draft; conflict: DraftConflict }): boolean =>
	!sameBody(conflict.mine, heldText(draft.body));

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

const CaseStamp = z.object({ ref: z.string(), version: z.number() });

/**
 * The rows the page holds for a case once it has read `read`, a version the server recorded: `read`, unless the
 * page already holds that version or a later one. What it holds may be from before the write. It may also be
 * the page's own read of the case after the write, which can come back first and hold more than `read`.
 */
export function caseHeld<Row extends Record<string, unknown>>({
	held,
	read,
}: {
	held: Row[] | undefined;
	read: Row[];
}): Row[] {
	const recorded = CaseStamp.parse(read[0]);
	const now = CaseStamp.safeParse(held?.[0]);
	return held && now.success && now.data.ref === recorded.ref && now.data.version >= recorded.version ? held : read;
}

/**
 * The text of a card as a draft on the version the draft was written on. The card's merged body also holds what
 * the version it was shown against had changed. Proposed on the draft's own base those fields would count as the
 * person's, and would put a change back that somebody has undone since. Here they are the base's again, so the
 * draft claims only what the person typed or chose, and the server merges the rest or asks. What the draft holds
 * beyond the card (a step being typed) is the person's text too, and stays.
 */
export function cardText({ draft, conflict }: { draft: Draft; conflict: DraftConflict }): Draft["body"] {
	const own = mergeBodies({ base: conflict.current, mine: conflict.merged, theirs: draft.original }).merged;
	// Where both changed one field, the card's text stands: it is what the person last had in front of them.
	return beyondCard({ draft, conflict })
		? mergeBodies({ base: conflict.mine, mine: own, theirs: draft.body }).merged
		: own;
}

/**
 * Whether a card and its draft can go when the card's question was answered by somebody else: nothing the
 * person typed is lost with them. With text typed in the card, `head` must be the card's whole body, and the
 * draft must hold nothing beyond the card. With none, `head` must be the draft's text; a side chosen in the card
 * may then differ from `head`, and is text of a recorded version. Never while the draft changes a tag or a link.
 */
export function allRecorded({
	draft,
	conflict,
	head,
}: {
	draft: Draft;
	conflict: DraftConflict;
	head: CaseBody;
}): boolean {
	const placed =
		JSON.stringify([draft.tags, draft.covers]) !== JSON.stringify([draft.originalTags, draft.originalCovers]);
	if (placed) return false;
	return hasTypedMerge(conflict)
		? !beyondCard({ draft, conflict }) && sameBody(conflict.merged, head)
		: sameBody(heldText(draft.body), head);
}

/**
 * The card's merged body as the person's side of the next card, when nothing of it was adopted. A side must be
 * recordable. A step whose action the person has emptied in the card keeps the action that was sent, so the
 * step and whatever else it holds stay.
 */
export function nextMine({ merged, sent }: { merged: Draft["body"]; sent: CaseBody }): CaseBody {
	return CaseBody.parse({
		...merged,
		steps: merged.steps.flatMap((step) => {
			const action = step.action.trim() ? step.action : sent.steps.find((was) => was.id === step.id)?.action;
			return action ? [{ ...step, action, expected: step.expected || null }] : [];
		}),
	});
}

/**
 * The draft that is left when the server recorded the merge `sent` for this card, or null when the card and the
 * draft hold nothing that merge did not. `draft` comes with tags and links typed inline already taken out of its
 * text (`cleanTitle`), as the card's side was when it was made.
 *
 * Text is later than the merge when the card differs from what was sent, or the draft holds text the card was
 * not made of. It is carried onto `recorded`, the version the server made of the merge, only where the person
 * saw what they change: every field of that version is either theirs, as they sent it, or somebody else's. Later
 * text in a field of the second kind is a conflict the page cannot ask about. Then, and when the merge made no
 * version, the card's text stays on the base the draft was written on (`cardText`), and the server merges it or
 * asks when it is proposed.
 */
export function draftAfterMerge({
	draft,
	conflict,
	sent,
	recorded,
}: {
	draft: Draft;
	conflict: DraftConflict;
	sent: CaseBody;
	recorded: { version: number; body: CaseBody; tags: string[]; covers: string[] } | null;
}): Draft | null {
	const inCard = !sameBody(sent, conflict.merged);
	const inDraft = beyondCard({ draft, conflict });
	if (!inCard && !inDraft) return null;
	const rest = { conflict: undefined, sent: null, cmd: randomId() };
	if (recorded) {
		const card = inCard
			? mergeBodies({ base: sent, mine: conflict.merged, theirs: recorded.body })
			: { merged: recorded.body, conflicts: [] };
		const both = inDraft ? mergeBodies({ base: conflict.mine, mine: draft.body, theirs: card.merged }) : card;
		if (card.conflicts.length === 0 && both.conflicts.length === 0)
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
	return { ...draft, ...rest, body: cardText({ draft, conflict }) };
}
