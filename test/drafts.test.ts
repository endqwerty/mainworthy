// Who may write, remove and take a draft kept on the device (review round 8: one live window owns a draft). The
// browser tests in `test/e2e/draft-ownership.test.ts` run the routes, and every route there is also stopped by
// the screen's own check before it writes. These pin the rule in `src/web/lib/drafts.ts` itself (issue #79).
import { beforeEach, expect, test } from "bun:test";
import { emptyBody } from "../src/core/model.ts";
import { dropNameKeyedData, setDevicePerson, suspendDeviceSession } from "../src/web/lib/device.ts";
import {
	claimCopiedDraft,
	discardDraftCopy,
	draftCopyPrefix,
	forgetDraftCopy,
	readDraftCopies,
	writeCopiedDraft,
} from "../src/web/lib/draft-copies.ts";
import {
	addDraftTags,
	claimDraft,
	type Draft,
	draftKey,
	draftTags,
	readDraft,
	remainingTagChanges,
	removeDraft,
	storedDraftOwners,
	writeDraft,
} from "../src/web/lib/drafts.ts";
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
beforeEach(() => {
	suspendDeviceSession();
	setDevicePerson({ actor: "", actorId: 1 });
	for (const copy of readDraftCopies({ project, id: "C-1" })) discardDraftCopy(copy.key);
	kept.clear();
	forgetDraftCopy({ project, draft: draft({}) });
});

const project = "scratch";
const body = { ...emptyBody("Coupon case"), steps: [{ id: "s1", action: "Open the cart", expected: null }] };
const request: NonNullable<Draft["sent"]> = {
	input: { cmd: "sent-cmd-01", edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Coupon case" } }] },
	body,
	tags: [],
	tagChanges: { add: [], remove: [] },
	covers: [],
};
const draft = (more: Partial<Draft>): Draft => ({
	id: "C-1",
	ref: "C-1",
	base: 1,
	body,
	original: body,
	tagChanges: { add: [], remove: [] },
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

test("startup discovers dirty canonical owners across accounts and projects, including pending saves", () => {
	expect(storedDraftOwners()).toEqual([]);
	kept.set(draftKey({ project, id: "C-1" }), JSON.stringify(draft({ owner: "first-owner" })));
	kept.set("mainworthy:#2:draft:other:C-2", JSON.stringify(draft({ owner: "pending-owner", sent: request })));
	kept.set("mainworthy:#2:draft:other:C-3", JSON.stringify(draft({ owner: "clean-owner", dirty: false })));
	kept.set("mainworthy:#2:draft:other:C-4", "not json");
	kept.set("mainworthy:#2:draft:other:C-5", JSON.stringify({ owner: "invalid-owner", dirty: true }));
	kept.set(
		"mainworthy:#2:draft-copy:other:C-6:copy",
		JSON.stringify({ draft: draft({ owner: "copy-owner" }), state: "lost" }),
	);
	kept.set("unrelated", JSON.stringify(draft({ owner: "unrelated-owner" })));
	expect(storedDraftOwners()).toEqual(["first-owner", "pending-owner"]);
});

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

test("taking a draft over keeps the request its owner sent, as does claiming a closed owner's draft", () => {
	another({ sent: request });
	// The new owner must settle the same request, even while the former owner is still waiting for it.
	const taken = claimDraft({ project, draft: draft({ owner: "another-window", sent: request }), takeOver: true });
	expect(taken).toMatchObject({ owner: draftOwner(), sent: request });
	expect(taken.cmd).not.toBe("draft-cmd-01");
	expect(stored()).toEqual(taken);
	// Opening a draft nobody is there for: its request may have been recorded, and only asking again can tell.
	another({ sent: request });
	const found = claimDraft({ project, draft: draft({ owner: "another-window", sent: request }) });
	expect(found).toMatchObject({ owner: draftOwner(), sent: request });
	expect(stored()).toEqual(found);
});

test("a losing window keeps its whole accepted draft separately from the shared draft and from other people", () => {
	const mine = draft({
		body: { ...body, title: "Coupon case A", steps: [{ id: "s1", action: "", expected: "Still being typed" }] },
		tagChanges: { add: ["checkout"], remove: [] },
		covers: ["WEB-290"],
		conflict: {
			q: "Q-1",
			proposal: "P-1",
			ref: "C-1",
			base: body,
			mine: body,
			current: body,
			merged: { ...body, title: "Hand-typed merge" },
			sentMerges: [],
			addresses: [{ kind: "field", name: "title" }],
			draftId: "C-1",
		},
	});
	writeCopiedDraft({ project, draft: mine });
	expect(readDraftCopies({ project, id: mine.id })).toEqual([]);
	const winner = another({ body: { ...body, title: "Coupon case B" } });
	expect(readDraftCopies({ project, id: mine.id }).map((copy) => copy.draft)).toEqual([mine]);
	expect(stored()).toEqual(winner);
	setDevicePerson({ actor: "another-person", actorId: 7 });
	try {
		expect(readDraftCopies({ project, id: mine.id })).toEqual([]);
	} finally {
		setDevicePerson({ actor: "", actorId: 1 });
	}
});

test("typing after takeover and recording keeps the earlier losing copy until it is explicitly discarded", () => {
	const mine = draft({ body: { ...body, title: "Accepted before the race" } });
	writeCopiedDraft({ project, draft: mine });
	another({ body: { ...body, title: "The winner's draft" } });
	const claimed = claimCopiedDraft({ project, draft: mine, takeOver: true });
	const later = { ...claimed, body: { ...claimed.body, title: "Typed after takeover" } };
	writeCopiedDraft({ project, draft: later });
	const [copy] = readDraftCopies({ project, id: mine.id });
	expect(copy?.draft).toEqual(mine);
	removeDraft({ project, id: mine.id });
	forgetDraftCopy({ project, draft: later });
	expect(readDraftCopies({ project, id: mine.id }).map((copy) => copy.draft)).toEqual([mine]);
	if (!copy) throw new Error("Missing preserved draft");
	discardDraftCopy(copy.key);
	expect(readDraftCopies({ project, id: mine.id })).toEqual([]);
});

test("full device storage keeps the losing copy in the tab with its storage state", () => {
	const mine = draft({ body: { ...body, title: "Accepted while storage was full" } });
	const set = localStorage.setItem;
	localStorage.setItem = () => {
		throw new DOMException("Full", "QuotaExceededError");
	};
	try {
		expect(() => writeCopiedDraft({ project, draft: mine })).toThrow("Full");
		another();
		expect(readDraftCopies({ project, id: mine.id }).map(({ draft, stored }) => ({ draft, stored }))).toEqual([
			{ draft: mine, stored: false },
		]);
	} finally {
		localStorage.setItem = set;
		for (const copy of readDraftCopies({ project, id: mine.id })) discardDraftCopy(copy.key);
		forgetDraftCopy({ project, draft: mine });
	}
});

test("a failed shared write removes its writing marker when storing waiting also fails", () => {
	const mine = draft({ body: { ...body, title: "Text kept in the tab after storage fills" } });
	const set = localStorage.setItem;
	let full = false;
	localStorage.setItem = (key, value) => {
		if (key === draftKey({ project, id: mine.id })) full = true;
		if (full) throw new DOMException("Full", "QuotaExceededError");
		set(key, value);
	};
	try {
		expect(() => writeCopiedDraft({ project, draft: mine })).toThrow("Full");
		expect([...kept.keys()].filter((key) => key.includes(":draft-copy:"))).toEqual([]);
		another();
		expect(readDraftCopies({ project, id: mine.id }).map(({ draft, stored }) => ({ draft, stored }))).toEqual([
			{ draft: mine, stored: false },
		]);
	} finally {
		localStorage.setItem = set;
		for (const copy of readDraftCopies({ project, id: mine.id })) discardDraftCopy(copy.key);
		forgetDraftCopy({ project, draft: mine });
	}
});

for (const afterSignIn of [false, true])
	test(`this window recovers an interrupted writing copy ${afterSignIn ? "after signing in again" : "in this session"} without blocking later confirmation`, async () => {
		const interrupted = draft({ body: { ...body, title: "Text from an interrupted write" } });
		const key = `${draftCopyPrefix({ project, id: interrupted.id })}${draftOwner()}:interrupted`;
		kept.set(key, JSON.stringify({ draft: interrupted, state: "writing" }));
		if (afterSignIn) {
			suspendDeviceSession();
			setDevicePerson({ actor: "", actorId: 1 });
		}
		const mine = draft({ body: { ...body, title: "Text typed after returning" } });
		expect(writeCopiedDraft({ project, draft: mine })).toBe(true);
		await new Promise((done) => setTimeout(done, 5));
		let copyWrites = 0;
		const set = localStorage.setItem;
		localStorage.setItem = (key, value) => {
			if (key.includes(":draft-copy:")) copyWrites++;
			set(key, value);
		};
		try {
			for (let index = 0; index < 10; index++)
				expect(writeCopiedDraft({ project, draft: { ...mine, body: { ...body, title: `Later text ${index}` } } })).toBe(
					true,
				);
		} finally {
			localStorage.setItem = set;
		}
		expect(stored()?.body.title).toBe("Later text 9");
		expect(copyWrites).toBe(0);
		expect(readDraftCopies({ project, id: mine.id }).map((copy) => copy.draft.body.title)).toEqual([
			"Text from an interrupted write",
		]);
		expect(readDraftCopies({ project, id: mine.id, recorded: { ...interrupted, base: 2, dirty: false } })).toEqual([]);
		expect(kept.has(key)).toBe(false);
	});

test("another window's interrupted writing marker still protects accepted text until that write finishes", async () => {
	const theirs = draft({ owner: "paused-window", body: { ...body, title: "The other window's text" } });
	const key = `${draftCopyPrefix({ project, id: theirs.id })}${theirs.owner}:paused`;
	kept.set(key, JSON.stringify({ draft: theirs, state: "writing" }));
	const mine = draft({ body: { ...body, title: "Accepted while the other window was paused" } });
	expect(writeCopiedDraft({ project, draft: mine })).toBe(true);
	await new Promise((done) => setTimeout(done, 5));
	another(theirs);
	kept.set(key, JSON.stringify({ draft: theirs, state: "waiting" }));
	expect(readDraftCopies({ project, id: mine.id }).map((copy) => copy.draft.body.title)).toEqual([mine.body.title]);
	expect(stored()?.body.title).toBe("The other window's text");
});

test("the first storage turn confirms ownership and later keys do not write copies", async () => {
	const mine = draft({ body: { ...body, title: "First accepted text" } });
	expect(writeCopiedDraft({ project, draft: mine })).toBe(true);
	expect([...kept.keys()].filter((key) => key.includes(":draft-copy:")).length).toBe(1);
	await new Promise((done) => setTimeout(done, 5));
	expect([...kept.keys()].filter((key) => key.includes(":draft-copy:")).length).toBe(0);
	const next = { ...mine, body: { ...body, title: "Later accepted text" } };
	expect(writeCopiedDraft({ project, draft: next })).toBe(true);
	expect(stored()?.body.title).toBe("Later accepted text");
	expect([...kept.keys()].filter((key) => key.includes(":draft-copy:")).length).toBe(0);
	another({ body: { ...body, title: "Ordinary takeover and later edit" } });
	expect(readDraftCopies({ project, id: mine.id })).toEqual([]);
});

for (const withMerge of [false, true])
	test(`a deliberate handoff before confirmation carries ${withMerge ? "typed merge" : "draft"} text without a leftover`, () => {
		const mine = draft({
			body: { ...body, title: "Accepted and carried to the next window" },
			...(withMerge
				? {
						conflict: {
							q: "Q-1",
							proposal: "P-1",
							ref: "C-1",
							base: body,
							mine: body,
							current: body,
							merged: { ...body, title: "Accepted typed merge" },
							sentMerges: [],
							addresses: [{ kind: "field", name: "title" }],
							draftId: "C-1",
						},
					}
				: {}),
		});
		writeCopiedDraft({ project, draft: mine });
		another({ ...mine, owner: "another-window" });
		const taken = claimCopiedDraft({ project, draft: mine, takeOver: true });
		writeCopiedDraft({ project, draft: { ...taken, body: { ...body, title: "Later edits after the handoff" } } });
		expect(stored()?.body.title).toBe("Later edits after the handoff");
		expect(readDraftCopies({ project, id: mine.id })).toEqual([]);
	});

test("a losing copy that matches a later recorded version is removed", () => {
	const mine = draft({ body: { ...body, title: "Accepted before a competing first write" } });
	writeCopiedDraft({ project, draft: mine });
	another({ body: { ...body, title: "Competing first write" } });
	expect(readDraftCopies({ project, id: mine.id }).map((copy) => copy.draft.body.title)).toEqual([mine.body.title]);
	expect(readDraftCopies({ project, id: mine.id, recorded: { ...mine, base: 2, dirty: false } })).toEqual([]);
	expect([...kept.keys()].filter((key) => key.includes(":draft-copy:")).length).toBe(0);
});

test("copies stay under the person's device prefix so clearing that prefix removes them", () => {
	setDevicePerson({ actor: "person/one", actorId: 5 });
	const mine = draft({ body: { ...body, title: "This person's accepted text" } });
	writeCopiedDraft({ project, draft: mine });
	another({ body: { ...body, title: "The competing first write" } });
	const [copy] = readDraftCopies({ project, id: mine.id });
	expect(copy?.draft.body.title).toBe("This person's accepted text");
	expect(copy?.key.startsWith("mainworthy:#5:")).toBe(true);
	for (const key of kept.keys()) if (key.startsWith("mainworthy:#5:")) kept.delete(key);
	expect(readDraftCopies({ project, id: mine.id })).toEqual([]);
	setDevicePerson({ actor: "", actorId: 1 });
});

test("clearing a person's keys and signing in again cannot reuse the old ownership confirmation", async () => {
	setDevicePerson({ actor: "returning-person", actorId: 6 });
	const first = draft({ body: { ...body, title: "Before sign-out" } });
	writeCopiedDraft({ project, draft: first });
	await new Promise((done) => setTimeout(done, 5));
	expect([...kept.keys()].filter((key) => key.includes(":draft-copy:")).length).toBe(0);
	suspendDeviceSession();
	kept.clear();
	setDevicePerson({ actor: "returning-person", actorId: 6 });
	try {
		const next = draft({ body: { ...body, title: "Accepted after signing in again" } });
		writeCopiedDraft({ project, draft: next });
		another({ body: { ...body, title: "A competing first write" } });
		expect(readDraftCopies({ project, id: next.id }).map((copy) => copy.draft.body.title)).toEqual([next.body.title]);
	} finally {
		suspendDeviceSession();
		kept.clear();
		setDevicePerson({ actor: "", actorId: 1 });
	}
});

test("two people with one name and different ids never see each other's device data", () => {
	setDevicePerson({ actor: "robin", actorId: 3 });
	const first = draft({ body: { ...body, title: "Typed by the first robin" } });
	expect(writeDraft({ project, draft: first })).toBe(true);
	expect(stored()?.body.title).toBe("Typed by the first robin");
	suspendDeviceSession();
	setDevicePerson({ actor: "robin", actorId: 4 });
	expect(stored()).toBeNull();
	expect(writeDraft({ project, draft: draft({ body: { ...body, title: "Typed by the second robin" } }) })).toBe(true);
	expect([...kept.keys()].sort()).toEqual([
		"mainworthy:#3:active:scratch",
		"mainworthy:#3:draft:scratch:C-1",
		"mainworthy:#3:steps:scratch:C-1",
		"mainworthy:#4:active:scratch",
		"mainworthy:#4:draft:scratch:C-1",
		"mainworthy:#4:steps:scratch:C-1",
		"mainworthy:session-person",
	]);
	suspendDeviceSession();
	setDevicePerson({ actor: "robin", actorId: 3 });
	expect(stored()?.body.title).toBe("Typed by the first robin");
});

test("data kept under a sign-in name is dropped at start, and nothing else is", () => {
	const entries = {
		"mainworthy:robin:draft:scratch:C-1": "A name-keyed draft",
		"mainworthy:robin%20two:run-note:scratch:R-1:s1:": "A name-keyed note",
		"mainworthy::home:scratch": "A home kept under the empty name",
		"mainworthy:#3:draft:scratch:C-1": "Kept for actor 3",
		"mainworthy:theme": "dark",
		"mainworthy:sidebar": "collapsed",
		"mainworthy:session-person": "3",
		"mainworthy:device-clear": "1,2,3,4",
		"another-app:robin:draft:x": "Not ours",
		"mainworthy:route:somewhere:else": "A key of the app's own, not a person's",
	};
	for (const [key, value] of Object.entries(entries)) kept.set(key, value);
	dropNameKeyedData(localStorage);
	expect(Object.fromEntries(kept)).toEqual({
		"mainworthy:#3:draft:scratch:C-1": "Kept for actor 3",
		"mainworthy:theme": "dark",
		"mainworthy:sidebar": "collapsed",
		"mainworthy:session-person": "3",
		"mainworthy:device-clear": "1,2,3,4",
		"another-app:robin:draft:x": "Not ours",
		"mainworthy:route:somewhere:else": "A key of the app's own, not a person's",
	});
});

for (const placement of [undefined, { tags: ["alpha", "kept"] }]) {
	test(`stored full-set drafts recover only their own tag changes, placement ${placement ? "present" : "absent"}`, () => {
		const legacy = {
			...draft({ originalTags: ["gone", "kept"] }),
			tagChanges: undefined,
			tags: ["alpha", "kept"],
			placement,
		};
		kept.set(draftKey({ project, id: "C-1" }), JSON.stringify(legacy));
		const found = stored();
		if (!found) throw new Error("Stored draft was not recovered");
		expect(found.tagChanges).toEqual({ add: ["alpha"], remove: ["gone"] });
		expect(Object.hasOwn(found, "tags")).toBe(false);
		expect(Object.hasOwn(found, "placement")).toBe(false);
		expect(draftTags({ ...found, originalTags: ["kept", "beta"] })).toEqual(["kept", "beta", "alpha"]);
		expect(writeDraft({ project, draft: found })).toBe(true);
		expect(JSON.parse(kept.get(draftKey({ project, id: "C-1" })) ?? "null")).toEqual(found);
	});
}

test("adding a draft tag owns neither a projected pending tag nor a cancelled removal", () => {
	const edited = addDraftTags(draft({ originalTags: ["alpha", "gone"], tagChanges: { add: [], remove: ["gone"] } }), [
		"beta",
		"gone",
	]);
	expect(edited.tagChanges).toEqual({ add: ["beta"], remove: [] });
	expect(draftTags({ ...edited, originalTags: ["alpha", "gone"] })).toEqual(["alpha", "gone", "beta"]);
	expect(draftTags({ ...edited, originalTags: ["gone"] })).toEqual(["gone", "beta"]);
});

test("retiring an accepted save keeps later tag edits and reversals without claiming remote tags", () => {
	const tagChanges = remainingTagChanges({
		sent: { add: ["alpha", "reversed"], remove: ["gone", "restored"] },
		current: { add: ["alpha", "beta"], remove: ["gone", "later"] },
	});
	expect(tagChanges).toEqual({ add: ["beta", "restored"], remove: ["later", "reversed"] });
	expect(draftTags({ originalTags: ["alpha", "reversed", "gamma", "later"], tagChanges })).toEqual([
		"alpha",
		"gamma",
		"beta",
		"restored",
	]);
});
