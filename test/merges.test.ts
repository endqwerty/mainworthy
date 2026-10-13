// What a conflict card does once the server has said what became of its merge (issue #81). The browser tests
// in `test/e2e/conflict-merge.test.ts` run the routes; these pin the rule itself, case by case.
import { describe, expect, test } from "bun:test";
import type { CaseBody } from "../src/core/model.ts";
import type { Draft, DraftConflict } from "../src/web/lib/drafts.ts";
import { allRecorded, cardText, draftAfterMerge, mergeFate, nextMine } from "../src/web/lib/merges.ts";

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
	paths: ["title"],
	draftId: "C-1",
});
const draft = (card: DraftConflict, text: Draft["body"] = mine): Draft => ({
	id: "C-1",
	ref: "C-1",
	base: 1,
	body: text,
	original: v1,
	conflict: card,
	tags: [],
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
		expect(gone(conflict(mine), mine, { ...draft(conflict(mine)), tags: ["checkout"] })).toBe(false);
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

	test("a reply that is not one is an error, never a guess", () => {
		expect(() => fate([])).toThrow();
		expect(() => fate(reply("decided", { rejected: true }))).toThrow();
		expect(() => fate(reply("decided", { status: "adopted" }))).toThrow();
	});
});
