// Who may write, remove and take a draft kept on the device (review round 8: one live window owns a draft). The
// browser tests in `test/e2e/draft-ownership.test.ts` run the routes, and every route there is also stopped by
// the screen's own check before it writes. These pin the rule in `src/web/lib/drafts.ts` itself (issue #79).
import { beforeEach, expect, test } from "bun:test";
import { emptyBody } from "../src/core/model.ts";
import { claimDraft, type Draft, draftKey, readDraft, removeDraft, writeDraft } from "../src/web/lib/drafts.ts";
import { draftOwner } from "../src/web/lib/ids.ts";

// The module reads the page's storage. No window is live here but this one: nothing answers on the channel.
const kept = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
	configurable: true,
	value: {
		get length() {
			return kept.size;
		},
		key: (index: number) => [...kept.keys()][index] ?? null,
		getItem: (key: string) => kept.get(key) ?? null,
		setItem: (key: string, value: string) => void kept.set(key, value),
		removeItem: (key: string) => void kept.delete(key),
	},
});
beforeEach(() => kept.clear());

const project = "scratch";
const body = { ...emptyBody("Coupon case"), steps: [{ id: "s1", action: "Open the cart", expected: null }] };
const request: NonNullable<Draft["sent"]> = {
	input: { cmd: "sent-cmd-01", edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Coupon case" } }] },
	body,
	tags: [],
	covers: [],
};
const draft = (more: Partial<Draft>): Draft => ({
	id: "C-1",
	ref: "C-1",
	base: 1,
	body,
	original: body,
	tags: [],
	covers: [],
	originalTags: [],
	originalCovers: [],
	owner: draftOwner(),
	sent: null,
	folder: "",
	after: null,
	caret: { field: "title", start: 0, end: 0 },
	dirty: true,
	at: 0,
	cmd: "draft-cmd-01",
	submission: { kind: "none" },
	...more,
});
const stored = () => readDraft({ project, id: "C-1" });
/** Another window's draft is in storage, as that window wrote it. */
function another(more: Partial<Draft> = {}): Draft {
	const theirs = draft({ owner: "another-window", ...more });
	kept.set(draftKey({ project, id: "C-1" }), JSON.stringify(theirs));
	return theirs;
}

test("a window writes its own draft, and not over a draft another window owns", () => {
	expect(writeDraft({ project, draft: draft({}) })).toBe(true);
	expect(stored()?.owner).toBe(draftOwner());
	const theirs = another({ body: { ...body, title: "Typed in the other window" } });
	// The window still holds its copy from before the other one took the draft.
	expect(writeDraft({ project, draft: draft({ body: { ...body, title: "Typed here, too late" } }) })).toBe(false);
	expect(stored()).toEqual(theirs);
	// Nor does it store a draft it holds under the other window's name.
	expect(writeDraft({ project, draft: { ...theirs, body: { ...body, title: "Typed here" } } })).toBe(false);
	kept.clear();
	expect(writeDraft({ project, draft: theirs })).toBe(false);
	expect(stored()).toBeNull();
});

test("a window removes its own draft, and leaves a draft another window owns", () => {
	writeDraft({ project, draft: draft({}) });
	removeDraft({ project, id: "C-1" });
	expect(stored()).toBeNull();
	const theirs = another();
	removeDraft({ project, id: "C-1" });
	expect(stored()).toEqual(theirs);
});

test("taking a draft over drops the request its owner sent; a draft whose owner is gone keeps it", () => {
	another({ sent: request });
	// "Take over here": the owner is there and still has the request, and settles it.
	const taken = claimDraft({ project, draft: draft({ owner: "another-window", sent: request }), takeOver: true });
	expect(taken).toMatchObject({ owner: draftOwner(), sent: null });
	expect(taken.cmd).not.toBe("draft-cmd-01");
	expect(stored()).toEqual(taken);
	// Opening a draft nobody is there for: its request may have been recorded, and only asking again can tell.
	another({ sent: request });
	const found = claimDraft({ project, draft: draft({ owner: "another-window", sent: request }) });
	expect(found).toMatchObject({ owner: draftOwner(), sent: request });
	expect(stored()).toEqual(found);
});
