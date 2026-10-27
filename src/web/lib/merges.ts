// What the server made of a merge a conflict card sent, and the draft that is left once that is known.
import { z } from "zod";
import { mergeBodies } from "../../core/merge3.ts";
import { CaseBody, type Step } from "../../core/model.ts";
import { parseBodyInline } from "../../core/outline.ts";
import {
	nullableText as schemaNullableText,
	number as schemaNumber,
	text as schemaText,
	unknownValue as schemaUnknownValue,
} from "../../core/schema.ts";
import {
	type Draft,
	DraftBody,
	type DraftConflict,
	hasTypedMerge,
	remainingTagChanges,
	type TagChanges,
} from "./drafts.ts";
import { randomId } from "./ids.ts";

function withAdditions(original: TagChanges, additions: string[]): TagChanges {
	return {
		add: [...new Set([...original.add, ...additions])],
		remove: original.remove.filter((item) => !additions.includes(item)),
	};
}

export function applyCoverChanges(original: string[], changes: TagChanges): string[] {
	return [...new Set([...original.filter((link) => !changes.remove.includes(link)), ...changes.add])];
}

/** Normalize a copy: the durable raw card keeps inline additions recoverable until its attempt settles. */
export function parsedMergeCard({ draft, conflict }: { draft: Draft; conflict: DraftConflict }): {
	draft: Draft;
	conflict: DraftConflict;
} {
	const parsed = parseBodyInline(conflict.merged, [conflict.current, conflict.base]);
	return {
		draft: {
			...draft,
			tagChanges: withAdditions(draft.tagChanges, parsed.tags),
			covers: [...new Set([...draft.covers, ...parsed.covers])],
		},
		conflict: { ...conflict, merged: parsed.body },
	};
}

/** Original proposal deltas with only this attempt's inline additions overlaid. */
export function mergeMetadata({
	conflict,
	sent,
}: {
	conflict: DraftConflict;
	sent: DraftConflict["sentMerges"][number];
}): NonNullable<DraftConflict["metadata"]> {
	const original = conflict.metadata ?? { tagChanges: { add: [], remove: [] }, covers: { add: [], remove: [] } };
	const tags = sent.tags ?? [];
	const covers = sent.covers ?? [];
	return {
		tagChanges: withAdditions(original.tagChanges, tags),
		covers: withAdditions(original.covers, covers),
	};
}

export function sameBody(left: CaseBody, right: CaseBody): boolean {
	return JSON.stringify(DraftBody.parse(left)) === JSON.stringify(DraftBody.parse(right));
}

/** A body as it can be recorded: a step still without an action is left out, and an empty expectation is none. */
export function recordable(body: z.infer<typeof DraftBody>): CaseBody {
	return CaseBody.parse({
		...body,
		steps: body.steps
			.filter((step) => step.use || step.action.trim())
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
			.filter((step) => step.use || step.action.trim() || step.expected?.trim())
			.map((step) => ({ ...step, expected: step.expected || null })),
	};
}
/**
 * Whether a body holds text that no version can take yet: a step with an expectation and still no action. The
 * draft that holds one stays on the device when everything else in it is recorded (issue #86).
 */
export function holdsUnfinishedStep(body: Draft["body"]): boolean {
	return heldText(body).steps.some((step) => !step.use && !step.action.trim());
}
/**
 * A draft's text carried onto `recorded`, a version the page has read: what was typed since `sent` (the body the
 * draft last had recorded, or sent to be) merged with that version. A step of the draft that has no action and
 * is not in `sent` is no change to any version. It is text still being typed, or what is left of a step whose
 * removal is recorded already. `recorded` can hold a step under the same id: a colleague restored the step, or
 * made one under an id this device picked too. Merged as it is, the draft's step would be that step with its
 * action taken out, and the next proposal would remove a step that nobody removed (the review of the change for
 * issue #86, B1). So the recorded step stands. An expected result the draft's step holds and the recorded one
 * does not is kept as a step of its own, under a new id from `newId`; a step with nothing of its own goes. A
 * step emptied after `sent` went out is in `sent`: that is the person's removal of it, and is left to the merge.
 * Spacing a save takes out is no one's edit. The merge's base is `sent` as the draft has it typed (`asTyped`), and
 * `recorded` is that base where it is only the server's trimming of `sent`. So the draft's spacing stays where
 * nobody changed the words, and gives way to anyone's other change, spacing included (the independent checks of
 * the change for issue #927, F1 to F3).
 */
export function carried({
	sent,
	live,
	recorded,
	newId,
}: {
	sent: CaseBody;
	live: Draft["body"];
	recorded: CaseBody;
	newId: (taken: ReadonlySet<string>) => string;
}): Draft["body"] {
	const sentIds = new Set(sent.steps.map((step) => step.id));
	const standing = new Map(recorded.steps.map((step) => [step.id, step]));
	const taken = new Set([...sent.steps, ...live.steps, ...recorded.steps].map((step) => step.id));
	const steps = live.steps.flatMap((step) => {
		const theirs = standing.get(step.id);
		if (step.use || step.action.trim() || sentIds.has(step.id) || !theirs) return [step];
		if (!step.expected?.trim() || step.expected === theirs.expected) return [];
		const id = newId(taken);
		taken.add(id);
		return [{ ...step, id }];
	});
	const mine = { ...live, steps };
	const base = asTyped({ typed: mine, stored: sent });
	const theirs = overlay({ stored: recorded, against: sent, given: base, rule: serverSaved });
	return mergeBodies({ base, mine, theirs }).merged;
}
type Rule = Record<"title" | "pre" | "step", (text: string) => string>;
/** What the server leaves of each text (`cleanBody`). */
const serverSaved: Rule = {
	title: (text) => text.replace(/\s+/g, " ").trim(),
	pre: (text) => text.trim(),
	step: (text) => text.trim(),
};
/**
 * What saving leaves of each text, on the page and then the server. The page trims each line of a step and joins
 * its spaces, and makes a title one line (`cleanTitle`). Preconditions only the server trims, so spacing inside
 * them is the text's own (F3).
 */
const saved: Rule = {
	...serverSaved,
	step: (text) =>
		text
			.split(/\r\n|\n|\r/)
			.map((line) => line.trim().replace(/[ \t]+/g, " "))
			.join("\n")
			.trim(),
};
/** `stored`, with each text that `rule` makes the same as `against`'s given as `given` has it. Steps match by id. */
function overlay<T extends Draft["body"]>({
	stored,
	against,
	given,
	rule,
}: {
	stored: T;
	against: Draft["body"];
	given: Draft["body"];
	rule: Rule;
}): T {
	const same = (field: keyof Rule, text: string | null, as: string | null | undefined): boolean =>
		as !== undefined && rule[field](text ?? "") === rule[field](as ?? "");
	const steps = new Map(against.steps.map((step) => [step.id, step]));
	const givenSteps = new Map(given.steps.map((step) => [step.id, step]));
	return {
		...stored,
		title: same("title", stored.title, against.title) ? given.title : stored.title,
		pre: same("pre", stored.pre, against.pre) ? given.pre : stored.pre,
		steps: stored.steps.map((step) => {
			const own = steps.get(step.id);
			const as = givenSteps.get(step.id);
			if (step.use || !own || own.use || !as || as.use) return step;
			return {
				...step,
				action: same("step", step.action, own.action) ? as.action : step.action,
				expected: same("step", step.expected, own.expected) ? as.expected : step.expected,
			};
		}),
	};
}
/**
 * `stored`, with each text that saving would make the same as `typed`'s given back as typed. The editor keeps what
 * was typed, or a word typed after a trailing space or line break would join the last (issue #927). Text the save
 * changed in another way, such as a tag taken out of it, or a line break where a space was, is as stored.
 */
export function asTyped<T extends Draft["body"]>({ typed, stored }: { typed: Draft["body"]; stored: T }): T {
	return overlay({ stored, against: typed, given: typed, rule: saved });
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

const Outcome = z.object({ status: schemaText, needs: schemaNullableText, effects: schemaUnknownValue });
const Effects = z.discriminatedUnion("status", [
	z.object({ status: z.literal("adopted"), cases: z.array(z.object({ ref: schemaText, version: schemaNumber })) }),
	z.object({ status: z.literal("unchanged") }),
	z.object({ status: z.literal("open"), adopt: schemaText }),
	z.object({ status: z.literal("conflict"), adopt: schemaText, proposal: schemaText }),
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
 * What the card says of a merge the server refused while the card's question is still open. That much the page
 * knows: the reply was not a decision, and the question, read after it, was open. Why the server refused is the
 * server's to say, in `needs`, so it is given as the server's words and not as the page's (review round 9, R9-4).
 */
export function refusedStatus(needs: string | null): string {
	const reason = needs ? ` The server's reason: ${needs}.` : "";
	return `Your merge was not adopted, and the conflict is still open.${reason} Your draft and conflict card are kept.`;
}

const CaseStamp = z.object({ ref: schemaText, version: schemaNumber });

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
		draft.tagChanges.add.some((tag) => !draft.originalTags.includes(tag)) ||
		draft.tagChanges.remove.some((tag) => draft.originalTags.includes(tag)) ||
		JSON.stringify(draft.covers) !== JSON.stringify(draft.originalCovers);
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
		steps: merged.steps.flatMap((step): Step[] => {
			if (step.use) return [step];
			const action = step.action.trim() ? step.action : sent.steps.find((was) => was.id === step.id)?.action;
			return action ? [{ ...step, action, expected: step.expected || null }] : [];
		}),
	});
}

/** Apply only the draft's explicit link additions and removals to the newly recorded links. */
export function carriedCovers({
	original,
	mine,
	recorded,
}: {
	original: readonly string[];
	mine: readonly string[];
	recorded: readonly string[];
}): string[] {
	return [
		...new Set([
			...recorded.filter((link) => !original.includes(link) || mine.includes(link)),
			...mine.filter((link) => !original.includes(link)),
		]),
	];
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
	acceptedMetadata,
}: {
	draft: Draft;
	conflict: DraftConflict;
	sent: CaseBody;
	recorded: { version: number; body: CaseBody; tags: string[]; covers: string[] } | null;
	acceptedMetadata?: DraftConflict["metadata"];
}): Draft | null {
	const tagChanges = acceptedMetadata
		? remainingTagChanges({ sent: acceptedMetadata.tagChanges, current: draft.tagChanges })
		: draft.tagChanges;
	const originalCovers = acceptedMetadata
		? applyCoverChanges(draft.originalCovers, acceptedMetadata.covers)
		: draft.originalCovers;
	const inCard = !sameBody(sent, conflict.merged);
	const inDraft = beyondCard({ draft, conflict });
	const metadata =
		tagChanges.add.length > 0 ||
		tagChanges.remove.length > 0 ||
		JSON.stringify(draft.covers) !== JSON.stringify(originalCovers);
	if (!inCard && !inDraft && !metadata) return null;
	const rest = { conflict: undefined, sent: null, cmd: randomId(), tagChanges, originalCovers };
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
				covers: carriedCovers({ original: originalCovers, mine: draft.covers, recorded: recorded.covers }),
				originalCovers: recorded.covers,
			};
	}
	return { ...draft, ...rest, body: !inCard && !inDraft ? sent : cardText({ draft, conflict }) };
}
