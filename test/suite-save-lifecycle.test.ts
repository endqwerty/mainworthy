import { describe, expect, test } from "bun:test";
import type { Api } from "../src/core/api.ts";
import { emptyBody } from "../src/core/model.ts";
import type { Draft } from "../src/web/lib/drafts.ts";
import { nextSaveEffect, type SaveState, saveTransition } from "../src/web/suite/save-lifecycle.ts";

import { SaveCommands } from "../src/web/suite/save-state.ts";

const input = { cmd: "create-once", edits: [] } satisfies Api["propose"]["input"];
const reply = {
	status: "adopted",
	proposal: null,
	question: null,
	needs: null,
	cases: [{ ref: "C1", version: 1, hash: "hash" }],
	placements: [],
	conflicts: [],
} satisfies Api["propose"]["reply"];

describe("Suite command lifecycle", () => {
	test("a failed read after create retries read-back without creating again", () => {
		let state: SaveState = { kind: "unsent" };
		state = saveTransition(state, { kind: "sent", input });
		state = saveTransition(state, { kind: "succeeded", cmd: input.cmd, reply });
		state = saveTransition(state, { kind: "read-failed" });
		expect(nextSaveEffect(state)).toEqual({ kind: "read-back", reply });
		// Even a failure classified as refusal cannot erase a known successful write.
		state = saveTransition(state, { kind: "refused" });
		expect(nextSaveEffect(state)).toEqual({ kind: "read-back", reply });
		expect(saveTransition(state, { kind: "adopted", ref: "C1", version: 1 })).toEqual({
			kind: "adopted",
			cmd: input.cmd,
			ref: "C1",
			version: 1,
		});
	});
	test("an unknown command is recovered by its original input; a refusal permits a new save", () => {
		const state = saveTransition({ kind: "unsent" }, { kind: "sent", input });
		expect(nextSaveEffect(state)).toEqual({ kind: "recover", input });
		expect(saveTransition(state, { kind: "read-failed" })).toEqual(state);
		expect(nextSaveEffect(saveTransition(state, { kind: "refused" }))).toEqual({ kind: "send" });
	});
});

test("Suite coordinator retains a successful create until adoption", () => {
	const commands = new SaveCommands();
	commands.sent("draft:1", input);
	expect(commands.reply("draft:1")).toBeNull();
	commands.succeeded("draft:1", reply, input.cmd);
	expect(commands.reply("draft:1")).toEqual(reply);
	// A retry cannot replace a success with another outgoing create.
	commands.sent("draft:1", { ...input, cmd: "another-create" });
	expect(commands.reply("draft:1")).toEqual(reply);
	commands.adopt("draft:1", "C1", 1);
	expect(commands.adoptedRef("draft:1")).toBe("C1");
	expect(commands.reply("draft:1")).toBeNull();
});

test("reopening an edited case starts a fresh lifecycle after adopting its previous version", () => {
	const body = emptyBody("Later edit");
	const draft: Draft = {
		id: "C1",
		ref: "C1",
		base: 1,
		body,
		original: body,
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
		cmd: "next-edit",
		submission: { kind: "none" },
	};
	const commands = new SaveCommands();
	commands.sent(draft.id, input);
	commands.succeeded(draft.id, reply, input.cmd);
	commands.adopt(draft.id, draft.ref ?? "", 1);
	commands.restore(draft);
	expect(commands.adoptedRef(draft.id)).toBeUndefined();
	commands.sent(draft.id, { ...input, cmd: draft.cmd });
	const second = { ...reply, cases: [{ ref: "C1", version: 2, hash: "second" }] };
	commands.succeeded(draft.id, second, draft.cmd);
	expect(commands.reply(draft.id)).toEqual(second);
	// Discarding the draft and opening another one must not reuse an old read-back.
	commands.restore(draft);
	expect(commands.reply(draft.id)).toBeNull();
});

test("restoring another tab's command for the same case discards the earlier reply", () => {
	const commands = new SaveCommands();
	const body = emptyBody("First edit");
	const first: Draft = {
		id: "C-1",
		ref: "C-1",
		base: 1,
		body,
		original: body,
		tagChanges: { add: [], remove: [] },
		covers: [],
		originalTags: [],
		originalCovers: [],
		owner: "tab-a",
		sent: { input, body, tags: [], covers: [], tagChanges: { add: [], remove: [] } },
		folder: "",
		after: null,
		caret: { field: "title", start: 0, end: 0 },
		dirty: true,
		at: 0,
		cmd: input.cmd,
		submission: { kind: "none" },
	};
	commands.restore(first);
	commands.succeeded(first.id, reply, input.cmd);
	commands.restore(first);
	expect(commands.reply(first.id)).toEqual(reply);
	const secondInput = { ...input, cmd: "tab-b-edit" };
	const second = {
		...first,
		cmd: secondInput.cmd,
		sent: { input: secondInput, body, tags: [], covers: [], tagChanges: { add: [], remove: [] } },
	};
	commands.restore(second);
	expect(commands.reply(second.id)).toBeNull();
	const secondReply = { ...reply, cases: [{ ref: "C-1", version: 3, hash: "third" }] };
	commands.succeeded(second.id, secondReply, secondInput.cmd);
	expect(commands.reply(second.id)).toEqual(secondReply);
});
