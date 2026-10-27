// What a conflict card does once the server has said what became of its merge (issue #81). The browser tests
// in `test/e2e/conflict-merge.test.ts` run the routes; these pin the rule itself, case by case.
import { describe, expect, test } from "bun:test";
import { applyMergeChoice } from "../src/core/merge3.ts";
import type { CaseBody, ConflictAddress } from "../src/core/model.ts";
import type { Draft, DraftConflict } from "../src/web/lib/drafts.ts";
import {
	allRecorded,
	asTyped,
	cardText,
	carried,
	caseHeld,
	draftAfterMerge,
	holdsUnfinishedStep,
	mergeFate,
	mergeMetadata,
	nextMine,
	parsedMergeCard,
	recordable,
	refusedStatus,
} from "../src/web/lib/merges.ts";

const body = (title: string, first: string, second: string): CaseBody => ({
	title,
	pre: "",
	steps: [
		{ id: "s1", action: first, expected: null },
		{ id: "s2", action: second, expected: null },
	],
	methods: ["human"],
	automate: "none",
	fields: {},
});
// Version 1; the person's draft of it; version 2, by a colleague; what the card sent; version 4, which the
// server made of that together with version 3, where the colleague changed the first step.
const v1 = body("Coupon case", "Open the cart", "Apply the coupon");
const mine = body("Coupon case mine", "Open the cart", "Apply the coupon SAVE10");
const v2 = body("Coupon case theirs", "Open the cart", "Apply the coupon");
const sent = body("Merged by hand", "Open the cart", "Apply the coupon SAVE10");
const v4 = body("Merged by hand", "Open the cart, changed", "Apply the coupon SAVE10");
const recorded = { version: 4, body: v4, tags: ["checkout"], covers: [] };

const conflict = (merged: CaseBody): DraftConflict => ({
	q: "Q-3",
	proposal: "P-3",
	ref: "C-1",
	base: v1,
	mine,
	current: v2,
	merged,
	sentMerges: [{ cmd: "merge-cmd-01", body: sent }],
	addresses: [{ kind: "field", name: "title" }],
	draftId: "C-1",
});
const draft = (card: DraftConflict, text: Draft["body"] = mine): Draft => ({
	id: "C-1",
	ref: "C-1",
	base: 1,
	body: text,
	original: v1,
	conflict: card,
	tagChanges: { add: [], remove: [] },
	covers: [],
	originalTags: [],
	originalCovers: [],
	owner: "window",
	sent: null,
	folder: "",
	after: null,
	caret: { field: "title", start: 0, end: 0 },
	dirty: true,
	at: 0,
	cmd: "draft-cmd-01",
	submission: { kind: "none" },
});
const after = (card: DraftConflict, at: typeof recorded | null, text: Draft["body"] = mine) =>
	draftAfterMerge({ draft: draft(card, text), conflict: card, sent, recorded: at });

describe("the draft left after a recorded merge", () => {
	test("none, although the recorded version differs from what was sent", () => {
		expect(after(conflict(sent), recorded)).toBeNull();
		expect(after(conflict(sent), null)).toBeNull();
	});

	test("later card text is carried onto the recorded version, beside what the server merged in", () => {
		const left = after(conflict({ ...sent, title: "Merged by hand, and later" }), recorded);
		expect(left).toMatchObject({
			base: 4,
			original: v4,
			originalTags: ["checkout"],
			body: { ...v4, title: "Merged by hand, and later" },
			sent: null,
		});
		expect(left?.conflict).toBeUndefined();
		expect(left?.cmd).not.toBe("draft-cmd-01");
	});

	test("later card text in a field the version took from somebody else stays on the draft's own base", () => {
		const card = conflict({
			...sent,
			steps: [{ id: "s1", action: "Open the cart, mine", expected: null }, ...sent.steps.slice(1)],
		});
		// Carried onto version 4 it would replace the colleague's step, which the person never saw.
		expect(after(card, recorded)).toMatchObject({ base: 1, original: v1, body: card.merged });
	});

	test("with no version to carry it onto, later card text stays on the draft's own base", () => {
		const card = conflict({ ...sent, title: "Merged by hand, and later" });
		expect(after(card, null)).toMatchObject({ base: 1, original: v1, body: card.merged });
	});

	test("a draft that moved on since the card was made is later text too", () => {
		const typed = (text: CaseBody): CaseBody => ({
			...text,
			steps: text.steps.map((step) => (step.id === "s2" ? { ...step, action: "Typed since" } : step)),
		});
		expect(after(conflict(sent), recorded, typed(mine))).toMatchObject({ base: 4, body: typed(v4) });
		// With nothing to carry it onto, it is added to the card's text, on the base the draft was written on.
		const card = conflict({ ...sent, title: "Merged by hand, and later" });
		expect(after(card, null, typed(mine))).toMatchObject({ base: 1, body: typed(card.merged) });
	});

	test("a step the person has not typed into yet is not later text", () => {
		const typing = { ...mine, steps: [...mine.steps, { id: "s3", action: "", expected: null }] };
		expect(after(conflict(sent), recorded, typing)).toBeNull();
		expect(
			after(conflict(sent), recorded, { ...typing, steps: typing.steps.map((s) => ({ ...s, expected: "" })) }),
		).toBeNull();
	});

	// The same for a card's draft (the review of the change for issue #86, B1): a step the draft holds with no
	// action, under an id the recorded version has a step for, would be carried as that step's removal. The two
	// differ in one field, so the draft is not carried: it stays on its own base, where the step is only text.
	test("a step the draft holds with no action is not carried onto a version that has the step", () => {
		const unfinished = { id: "s3", action: "", expected: "Typed, and not recorded" };
		const theirs = { id: "s3", action: "Recorded by a colleague", expected: null };
		const left = after(
			conflict(sent),
			{ ...recorded, body: { ...v4, steps: [...v4.steps, theirs] } },
			{ ...mine, steps: [...mine.steps, unfinished] },
		);
		expect(left).toMatchObject({ base: 1, original: v1 });
		expect(left?.body.steps).toContainEqual(unfinished);
		expect(left?.body.steps).not.toContainEqual(theirs);
	});

	// The first independent check of this change (V1): such a step cannot be recorded, and it is typed text.
	test("a step with an expectation and no action yet stays, whatever the merge did", () => {
		const unfinished = { id: "s3", action: "", expected: "Typed, and not recorded" };
		const typing = { ...mine, steps: [...mine.steps, unfinished] };
		expect(after(conflict(sent), recorded, typing)).toMatchObject({
			base: 4,
			body: { ...v4, steps: [...v4.steps, unfinished] },
		});
		expect(after(conflict(sent), null, typing)).toMatchObject({
			base: 1,
			body: { ...sent, steps: [...sent.steps, unfinished] },
		});
		const card = conflict({ ...sent, title: "Merged by hand, and later" });
		expect(after(card, recorded, typing)).toMatchObject({
			base: 4,
			body: { ...v4, title: "Merged by hand, and later", steps: [...v4.steps, unfinished] },
		});
	});
});

// Issue #86: leaving the editor asks this of the draft once its version is recorded, and keeps the draft for it.
test("a step is unfinished with an expectation and no action; an empty step and a recordable one are not", () => {
	const withStep = (step: { action: string; expected: string | null }): Draft["body"] => ({
		...mine,
		steps: [...mine.steps, { id: "s3", ...step }],
	});
	expect(holdsUnfinishedStep(withStep({ action: "", expected: "Typed, and not recorded" }))).toBe(true);
	expect(holdsUnfinishedStep(withStep({ action: "  ", expected: "Typed, and not recorded" }))).toBe(true);
	expect(holdsUnfinishedStep(mine)).toBe(false);
	for (const expected of [null, "", "  "]) expect(holdsUnfinishedStep(withStep({ action: "", expected }))).toBe(false);
	expect(holdsUnfinishedStep(withStep({ action: "Typed", expected: "" }))).toBe(false);
});

// The independent review of the change for issue #86 (B1). The person emptied the action of the second step, and
// the step's removal is recorded. The draft still holds what is left of the step, and is then carried onto a
// version in which a colleague has the step again. Nobody removed that step.
describe("a draft carried onto a version the page has read", () => {
	const newId = () => "s9";
	const second = v1.steps.flatMap((step) => (step.id === "s2" ? [{ ...step, expected: "Total shows $90.00" }] : []));
	const first = v1.steps.filter((step) => step.id === "s1");
	// Version 2, without the second step, is what the draft last had recorded. In version 3 the step is back.
	const removed = { ...v1, steps: first };
	const restored = { ...v1, steps: [...first, ...second] };
	const holding = (...more: Draft["body"]["steps"]): Draft["body"] => ({ ...removed, steps: [...first, ...more] });
	const onto = (live: Draft["body"], recorded: CaseBody = restored, last: CaseBody = removed) =>
		carried({ sent: last, live, recorded, newId });

	test("what a draft still holds of a step is not the removal of that step when somebody recorded it again", () => {
		expect(onto(holding({ id: "s2", action: "", expected: "Total shows $90.00" }))).toEqual(restored);
		expect(onto(holding({ id: "s2", action: "  ", expected: null }))).toEqual(restored);
		// The colleague recorded it with other words: those stand as well.
		const reworded = { ...v1, steps: [...first, { id: "s2", action: "Apply the coupon SAVE20", expected: null }] };
		expect(onto(holding({ id: "s2", action: "", expected: "" }), reworded)).toEqual(reworded);
	});

	test("an expected result typed on it is kept, as a step of its own beside the recorded one", () => {
		expect(onto(holding({ id: "s2", action: "", expected: "Typed, and in no version" }))).toEqual({
			...restored,
			steps: [...restored.steps, { id: "s9", action: "", expected: "Typed, and in no version" }],
		});
	});

	test("a step no version has stays as it is, with the colleague's version around it", () => {
		const typing = { id: "s3", action: "", expected: "Typed, and in no version" };
		const empty = { id: "s4", action: "", expected: null };
		expect(onto(holding(typing, empty))).toEqual({ ...restored, steps: [...restored.steps, typing, empty] });
		// Two of them, one of each kind: the recorded step stands and the new one stays.
		expect(onto(holding({ id: "s2", action: "", expected: "Total shows $90.00" }, typing))).toEqual({
			...restored,
			steps: [...restored.steps, typing],
		});
	});

	test("an action emptied after the body went out is the person's removal of the step, and stays one", () => {
		// The draft last had version 3 recorded, with the step. The person empties it; a colleague changes the title.
		const emptied = { ...restored, steps: [...first, { id: "s2", action: "", expected: "Total shows $90.00" }] };
		const later = onto(emptied, { ...restored, title: "Coupon case theirs" }, restored);
		expect(later.title).toBe("Coupon case theirs");
		expect(recordable(later).steps).toEqual(first);
	});

	// Issue #927: saving trims text, on the page and on the server. The editor keeps it as typed, or the next word
	// typed joins the last.
	test("text a save only trimmed is kept as it was typed", () => {
		const step = (action: string, expected: string | null) => ({ ...v1, steps: [{ id: "s1", action, expected }] });
		const typed = { ...step("Apply the discount after ", " Total drops "), pre: "Logged in " };
		const cleaned = { ...step("Apply the discount after", "Total drops"), pre: "Logged in " };
		const stored = { ...cleaned, pre: "Logged in" };
		expect(asTyped({ typed, stored: cleaned })).toEqual(typed);
		expect(asTyped({ typed, stored })).toEqual(typed);
		// A line break the person just typed: the page keeps it, and the server trims it.
		expect(onto(step("Open the cart\n", null), step("Open the cart", null), step("Open the cart\n", null))).toEqual(
			step("Open the cart\n", null),
		);
		// Typed further while the save was on its way: that stays.
		expect(onto(step("Apply the discount after re", null), step("Apply the discount after", null), cleaned)).toEqual(
			step("Apply the discount after re", null),
		);
		// A tag taken out of the text, or a colleague's words, are not the typed text trimmed, and stand.
		expect(asTyped({ typed: step("Open the cart #smoke ", null), stored: step("Open the cart", null) })).toEqual(
			step("Open the cart", null),
		);
		const theirs = step("Apply the coupon", "Total drops");
		expect(asTyped({ typed, stored: { ...theirs, pre: "Logged in" } })).toEqual({
			...step("Apply the coupon", " Total drops "),
			pre: "Logged in ",
		});
	});

	// The independent check of the change for #927. Spacing a save took out is no edit of the person's: a colleague's
	// later words in that field stand (F1). A line break where a space was is the colleague's edit (F2).
	test("spacing kept as typed gives way to a later version's words", () => {
		const step = (action: string) => ({ ...v1, steps: [{ id: "s1", action, expected: null }] });
		expect(onto(step("Local saved action "), step("Remote changed action"), step("Local saved action"))).toEqual(
			step("Remote changed action"),
		);
		expect(onto(step("Open cart"), step("Open\ncart"), step("Open cart"))).toEqual(step("Open\ncart"));
		// Lines indented and ended with spaces are each trimmed on saving, and stay as typed.
		const lines = { ...step("  Open cart  \n  Apply coupon \n"), pre: "  Logged in \n  Cart ready " };
		expect(
			asTyped({ typed: lines, stored: { ...step("Open cart\nApply coupon"), pre: "Logged in \n  Cart ready" } }),
		).toEqual(lines);
		// Preconditions are trimmed only at their ends: a colleague's indentation inside them is an edit (F3).
		const indented = { ...step("Open cart"), pre: "Logged in\n  Cart  ready" };
		expect(
			onto({ ...step("Open cart"), pre: "Logged in\nCart ready" }, indented, {
				...step("Open cart"),
				pre: "Logged in\nCart ready",
			}),
		).toEqual(indented);
		// The same for a step: the page would make it one way, and a colleague made it another.
		expect(onto(step("Open\ncart"), step("Open\n  cart"), step("Open\ncart"))).toEqual(step("Open\n  cart"));
		// With nothing else changed, the spacing stays as typed.
		expect(onto(step("Open cart "), { ...step("Open cart"), title: "Theirs" }, step("Open cart"))).toEqual({
			...step("Open cart "),
			title: "Theirs",
		});
	});

	test("with no action typed since, nothing is left to record that the version does not hold", () => {
		for (const live of [
			holding(),
			holding({ id: "s2", action: "", expected: "Total shows $90.00" }),
			holding({ id: "s2", action: "", expected: "Typed, and in no version" }),
			holding({ id: "s3", action: "", expected: "Typed, and in no version" }, { id: "s2", action: "", expected: null }),
		])
			for (const recorded of [restored, removed, { ...restored, title: "Coupon case theirs" }])
				expect(recordable(onto(live, recorded))).toEqual(recorded);
	});
});

describe("the text of a card that its own merge did not end", () => {
	test("claims what the person typed or chose, and nothing the card took from the version it was shown against", () => {
		// The colleague's version changed the title, which the person changed too, and the first step, which
		// they did not: the card holds the colleague's first step beside the person's title and second step.
		const shown = { ...v2, steps: v2.steps.map((step) => (step.id === "s1" ? { ...step, action: "Changed" } : step)) };
		const merged = {
			...shown,
			title: "Typed in the card",
			steps: [shown.steps[0], mine.steps[1]].flatMap((s) => s ?? []),
		};
		const card = { ...conflict(merged), current: shown };
		// On version 1 the colleague's step would be the person's change, and would come back after an undo.
		expect(cardText({ draft: draft(card), conflict: card })).toEqual({
			...v1,
			title: "Typed in the card",
			steps: [v1.steps[0], mine.steps[1]].flatMap((s) => s ?? []),
		});
	});

	test("a side chosen for the current version is not a claim either", () => {
		const card = conflict({ ...mine, title: v2.title });
		expect(cardText({ draft: draft(card), conflict: card })).toEqual({ ...mine, title: v1.title });
	});

	test("what the draft holds beyond the card stays, and the card's text stands where both changed a field", () => {
		const unfinished = { id: "s3", action: "", expected: "Typed, and not recorded" };
		const card = conflict({ ...sent, title: "Typed in the card" });
		const held = draft(card, { ...mine, title: "Changed under the card", steps: [...mine.steps, unfinished] });
		expect(cardText({ draft: held, conflict: card })).toEqual({
			...sent,
			title: "Typed in the card",
			steps: [...sent.steps, unfinished],
		});
	});

	test("the card and its draft can go only when the head holds all of their text", () => {
		const typed = conflict({ ...sent, title: "Typed in the card" });
		const gone = (card: DraftConflict, head: CaseBody, held = draft(card)) =>
			allRecorded({ draft: held, conflict: card, head });
		expect(gone(typed, typed.merged)).toBe(true);
		expect(gone(typed, { ...typed.merged, pre: "Something else" })).toBe(false);
		// A card nobody typed in: the draft is the person's text.
		expect(gone(conflict(mine), mine)).toBe(true);
		expect(gone(conflict(mine), v2)).toBe(false);
		// A step being typed, or a tag, is recorded nowhere.
		const unfinished = { id: "s3", action: "", expected: "Typed, and not recorded" };
		const typing = { ...mine, steps: [...mine.steps, unfinished] };
		expect(gone(typed, typed.merged, draft(typed, typing))).toBe(false);
		expect(gone(conflict(mine), mine, draft(conflict(mine), typing))).toBe(false);
		expect(
			gone(conflict(mine), mine, { ...draft(conflict(mine)), tagChanges: { add: ["checkout"], remove: [] } }),
		).toBe(false);
		expect(
			gone(conflict(mine), mine, {
				...draft(conflict(mine)),
				originalTags: ["checkout"],
				tagChanges: { add: ["checkout"], remove: ["gone"] },
			}),
		).toBe(true);
		expect(
			gone(conflict(mine), mine, {
				...draft(conflict(mine)),
				originalTags: ["checkout", "gone"],
				tagChanges: { add: ["checkout"], remove: ["gone"] },
			}),
		).toBe(false);
	});

	test("the person's side of the next card is recordable, and keeps a step whose action they emptied", () => {
		const emptied = {
			...sent,
			steps: sent.steps.map((s) => (s.id === "s2" ? { ...s, action: "", expected: "Kept" } : s)),
		};
		expect(nextMine({ merged: emptied, sent })).toEqual({
			...sent,
			steps: sent.steps.map((s) => (s.id === "s2" ? { ...s, expected: "Kept" } : s)),
		});
		const added = { ...sent, steps: [...sent.steps, { id: "s9", action: "", expected: null }] };
		expect(nextMine({ merged: added, sent })).toEqual(sent);
	});
});

describe("what a merge did, read from its reply", () => {
	const reply = (status: string, effects: unknown, needs: string | null = null) => [
		{ q: "Q-3", status, needs, decision: 3, effects, evidence: null },
	];
	const fate = (value: unknown) => mergeFate({ reply: value, ref: "C-1" });

	test("each reply the server gives", () => {
		expect(
			fate(reply("decided", { status: "adopted", cases: [{ ref: "C-1", version: 4, hash: "h" }], proposal: "P-4" })),
		).toEqual({ kind: "adopted", version: 4 });
		expect(fate(reply("decided", { status: "unchanged", cases: [] }))).toEqual({ kind: "unchanged" });
		expect(fate(reply("decided", { status: "open", cases: [], proposal: "P-4", adopt: "Q-4" }))).toEqual({
			kind: "waiting",
			question: "Q-4",
		});
		expect(fate(reply("decided", { status: "conflict", cases: [], proposal: "P-4", adopt: "Q-4" }))).toEqual({
			kind: "moved",
			question: "Q-4",
			proposal: "P-4",
		});
		expect(fate(reply("conflict", null, "the evidence changed"))).toEqual({
			kind: "refused",
			needs: "the evidence changed",
		});
		expect(fate(reply("invalid", null))).toEqual({ kind: "refused", needs: null });
	});

	// Review round 9, R9-4. The status line had the server's sentence alone. What the page knows is that its
	// merge settled nothing and the question is open; the reason is the server's, and is named as the server's.
	test("a refused merge is told in the page's words, with the server's reason given as the server's", () => {
		expect(refusedStatus("one member who is not an agent")).toBe(
			"Your merge was not adopted, and the conflict is still open. The server's reason: one member who is not an agent. Your draft and conflict card are kept.",
		);
		expect(refusedStatus(null)).toBe(
			"Your merge was not adopted, and the conflict is still open. Your draft and conflict card are kept.",
		);
	});

	test("a reply that is not one is an error, never a guess", () => {
		expect(() => fate([])).toThrow();
		expect(() => fate(reply("decided", { rejected: true }))).toThrow();
		expect(() => fate(reply("decided", { status: "adopted" }))).toThrow();
	});
});

// Issue #94. When a card and its draft go, the pane shows the case the page holds, and `e` opens the editor on it.
describe("the case the page holds once it has read a version the server recorded", () => {
	const row = (version: number, title: string): Record<string, unknown>[] => [{ ref: "C-1", version, title }];

	test("the version read replaces the one from before it, and stands where the page held none", () => {
		expect(caseHeld({ held: row(2, "Theirs"), read: row(3, "Merged") })).toEqual(row(3, "Merged"));
		expect(caseHeld({ held: undefined, read: row(3, "Merged") })).toEqual(row(3, "Merged"));
		expect(caseHeld({ held: [], read: row(3, "Merged") })).toEqual(row(3, "Merged"));
	});

	test("the page's own read came back first: that version, or a later one, stays", () => {
		const same = [{ ref: "C-1", version: 3, title: "Merged", open: 1 }];
		expect(caseHeld({ held: same, read: row(3, "Merged") })).toBe(same);
		const later = row(4, "Changed again");
		expect(caseHeld({ held: later, read: row(3, "Merged") })).toBe(later);
	});

	test("rows that are not a case are an error, never a guess", () => {
		expect(() => caseHeld({ held: row(2, "Theirs"), read: [] })).toThrow();
		expect(() => caseHeld({ held: row(2, "Theirs"), read: [{ ref: "C-1" }] })).toThrow();
	});
});

test("shared choices apply every case property without changing the source documents", () => {
	const initial: CaseBody = { ...v1, fields: { keep: "yes", remove: "old", "priority.level": "high" } };
	const source: CaseBody = {
		...v2,
		pre: "Current precondition",
		methods: ["agent"],
		automate: "wanted",
		fields: { keep: "current", "priority.level": "low" },
	};
	const before = structuredClone({ initial, source });
	let merged = initial;
	for (const address of [
		{ kind: "field", name: "title" },
		{ kind: "field", name: "pre" },
		{ kind: "field", name: "methods" },
		{ kind: "field", name: "automate" },
		{ kind: "custom-field", key: "remove" },
		{ kind: "custom-field", key: "priority.level" },
	] satisfies ConflictAddress[])
		merged = applyMergeChoice({ merged, source, address });
	expect(merged).toEqual({
		...v1,
		title: v2.title,
		pre: "Current precondition",
		methods: ["agent"],
		automate: "wanted",
		fields: { keep: "yes", "priority.level": "low" },
	});
	expect({ initial, source }).toEqual(before);
});

test("a recorded body merge rebases explicit link additions and removals onto concurrent server changes", () => {
	const card = conflict(sent);
	const held = {
		...draft(card),
		originalCovers: ["REQ-1", "REQ-2", "REQ-3"],
		covers: ["REQ-1", "REQ-4"],
	};
	const fresh = { ...recorded, covers: ["REQ-1", "REQ-2", "REQ-5"] };
	const left = draftAfterMerge({ draft: held, conflict: card, sent, recorded: fresh });
	expect(left?.covers).toEqual(["REQ-1", "REQ-5", "REQ-4"]);
	expect(left?.originalCovers).toEqual(fresh.covers);
});

test("atomic merge completion retires only its metadata and follows later server reversals", () => {
	const card = conflict(sent);
	const held = {
		...draft(card),
		originalTags: ["old"],
		tagChanges: { add: ["smoke", "later"], remove: ["old"] },
		originalCovers: ["REQ-100"],
		covers: ["REQ-101", "REQ-103"],
	};
	const fresh = { ...recorded, tags: ["old"], covers: ["REQ-100", "REQ-102"] };
	const left = draftAfterMerge({
		draft: held,
		conflict: card,
		sent,
		recorded: fresh,
		acceptedMetadata: {
			tagChanges: { add: ["smoke"], remove: ["old"] },
			covers: { add: ["REQ-101"], remove: ["REQ-100"] },
		},
	});
	expect(left?.tagChanges).toEqual({ add: ["later"], remove: [] });
	expect(left?.originalTags).toEqual(["old"]);
	expect(left?.covers).toEqual(["REQ-100", "REQ-102", "REQ-103"]);
});

test("cancelling tags and links after their atomic submission keeps the inverse for a later save", () => {
	const card = conflict(sent);
	const left = draftAfterMerge({
		draft: draft(card),
		conflict: card,
		sent,
		recorded: { ...recorded, tags: ["smoke"], covers: ["REQ-101"] },
		acceptedMetadata: { tagChanges: { add: ["smoke"], remove: [] }, covers: { add: ["REQ-101"], remove: [] } },
	});
	expect(left?.tagChanges).toEqual({ add: [], remove: ["smoke"] });
	expect(left?.covers).toEqual([]);
	expect(left?.originalCovers).toEqual(["REQ-101"]);
});

test("a winning inline merge snapshot retires only its tags and links, retaining later card tokens", () => {
	const original = conflict({ ...sent, title: "Merged by hand #later @REQ-102" });
	const attempt = { cmd: "winning", body: sent, tags: ["smoke"], covers: ["REQ-101"] };
	const live = parsedMergeCard({ draft: draft(original), conflict: original });
	const metadata = mergeMetadata({ ...live, sent: attempt });
	expect(metadata).toEqual({ tagChanges: { add: ["smoke"], remove: [] }, covers: { add: ["REQ-101"], remove: [] } });
	const left = draftAfterMerge({
		...live,
		sent,
		recorded: { ...recorded, tags: ["smoke"], covers: ["REQ-101"] },
		acceptedMetadata: metadata,
	});
	expect(left?.tagChanges).toEqual({ add: ["later"], remove: ["smoke"] });
	expect(left?.covers).toEqual(["REQ-102"]);
	expect(original.merged.title).toContain("#later");
});

test("inline re-additions cancel original removals while preserving other original deltas", () => {
	const card = {
		...conflict(sent),
		metadata: {
			tagChanges: { add: ["mine"], remove: ["old", "remove"] },
			covers: { add: ["REQ-3"], remove: ["REQ-1", "REQ-2"] },
		},
	};
	expect(
		mergeMetadata({
			conflict: card,
			sent: { cmd: "test", body: sent, tags: ["old", "new"], covers: ["REQ-1", "REQ-4"] },
		}),
	).toEqual({
		tagChanges: { add: ["mine", "old", "new"], remove: ["remove"] },
		covers: { add: ["REQ-3", "REQ-1", "REQ-4"], remove: ["REQ-2"] },
	});
});
