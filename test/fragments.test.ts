import { afterEach, beforeEach, expect, test } from "bun:test";
import { applyDiff, diffBodies, isEmptyDiff } from "../src/core/diff.ts";
import { claimHash, versionHash } from "../src/core/hash.ts";
import { parseCase } from "../src/core/markdown.ts";
import { mergeBodies } from "../src/core/merge3.ts";
import { emptyBody, Step } from "../src/core/model.ts";
import type { PlanReply, ProposeReply } from "../src/core/ops.ts";
import { REPLIES } from "../src/core/replies.ts";
import { Database, type SqlValue, sql } from "../src/server/kernel/db.ts";
import { OPS } from "../src/server/ops/index.ts";
import { invoke } from "../src/server/ops/registry.ts";
import { structuralProblems } from "../src/server/suite/read.ts";
import { bodyOf, expandSteps, fragmentUsers, mustCase } from "../src/server/suite/suite.ts";
import { exportArchive, importArchive, linesOf } from "../src/server/transfer/transfer.ts";
import { DraftBody } from "../src/web/lib/drafts.ts";
import { holdsUnfinishedStep, recordable } from "../src/web/lib/merges.ts";
import { testDatabase } from "./db.ts";
import { type Harness, harness } from "./helpers.ts";

let h: Harness;
beforeEach(async () => {
	h = await harness();
});
afterEach(() => h.close());
const createFragment = async () =>
	await h.call("propose", {
		edits: [
			{
				op: "create",
				kind: "fragment",
				body: { title: "Sign in", steps: [{ id: "ab", action: "Enter a password", expected: "Signed in" }] },
			},
		],
	});
const createUser = async (title = "Checkout") =>
	await h.call("propose", {
		edits: [
			{
				op: "create",
				body: {
					title,
					fields: { risk: "high" },
					steps: [
						{ id: "cd", use: { fragment: "C-1", version: 1 } },
						{ id: "ef", action: "Pay", expected: "Receipt" },
					],
				},
			},
		],
	});
const view = async (ref = "C-2", version?: number) =>
	(await h.call<Record<string, unknown>[]>("get", { refs: [ref], version }))[0];
const updateFragment = async () =>
	await h.call("propose", {
		edits: [
			{
				op: "edit",
				case: "C-1",
				base: 1,
				body: { steps: [{ id: "ab", action: "Use a passkey", expected: "Signed in" }] },
			},
		],
	});

async function seedSearchPins(): Promise<void> {
	await h.call("propose", {
		edits: [
			{
				op: "create",
				kind: "fragment",
				folder: "Fragments",
				body: {
					title: "Shared sign in",
					pre: "fragmentprecondition",
					steps: [{ id: "ab", action: "Enter zephyrpassword", expected: "luminousreply" }],
				},
			},
		],
	});
	await h.call("propose", {
		edits: [
			{
				op: "create",
				folder: "Consumers",
				body: { title: "Pinned only", steps: [{ id: "cd", use: { fragment: "C-1", version: 1 } }] },
			},
			{
				op: "create",
				folder: "Consumers",
				body: { title: "Inline sibling", steps: [{ id: "ef", action: "Enter zephyrpassword", expected: null }] },
			},
		],
	});
	await updateFragment();
}

test("search finds pinned actions and expectations at the pinned version and follows pin and tag edits", async () => {
	await seedSearchPins();
	expect(await h.call("find", { text: "zephyrpassword", folder: "Consumers" })).toMatchObject({
		count: 2,
		items: expect.arrayContaining([expect.objectContaining({ ref: "C-2", title: "Pinned only" })]),
	});
	expect(await h.call("find", { text: "luminousreply", folder: "Consumers" })).toMatchObject({
		count: 1,
		items: [{ ref: "C-2" }],
	});
	expect(await h.call("find", { text: "passkey", folder: "Consumers" })).toMatchObject({ count: 0 });
	expect(await h.call("find", { text: "fragmentprecondition", folder: "Consumers" })).toMatchObject({ count: 0 });
	await h.call("propose", { edits: [{ op: "place", cases: ["C-2"], tags: { add: ["regression"] } }] });
	expect(await h.call("find", { text: "zephyrpassword", folder: "Consumers", tags: ["regression"] })).toMatchObject({
		count: 1,
		items: [{ ref: "C-2" }],
	});
	await h.call("propose", {
		edits: [{ op: "fragment", fragment: "C-1", from: 1, to: 2, cases: [{ case: "C-2", base: 1 }] }],
	});
	expect(await h.call("find", { text: "passkey", folder: "Consumers" })).toMatchObject({
		count: 1,
		items: [{ ref: "C-2", version: 2 }],
	});
	expect(await h.call("find", { text: "zephyrpassword", folder: "Consumers" })).toMatchObject({
		count: 1,
		items: [{ ref: "C-3" }],
	});
});

test("a run selected by text includes the pinned-only case beside the inline sibling", async () => {
	await seedSearchPins();
	expect(
		await h.call<PlanReply>("plan", {
			name: "Password checks",
			select: { text: "zephyrpassword", folders: ["Consumers"] },
		}),
	).toEqual({ run: "R-1", slots: 2, already: 0 });
	expect(await h.call("find", { in: "slots", run: "R-1" })).toMatchObject({
		items: [{ case: "C-2" }, { case: "C-3" }],
	});
	expect(
		await h.call<PlanReply>("plan", { name: "Pinned only", select: { text: "luminousreply", folders: ["Consumers"] } }),
	).toEqual({ run: "R-2", slots: 1, already: 0 });
	expect(await h.call("find", { in: "slots", run: "R-2" })).toMatchObject({ items: [{ case: "C-2" }] });
});

test.each(["instance", "project"])("%s archive replay rebuilds pinned search for find and plan", async (scope) => {
	await seedSearchPins();
	const chunks: string[] = [];
	await h.app.database.read(
		async (db) =>
			await exportArchive(
				db,
				(chunk) => {
					chunks.push(chunk);
				},
				scope === "project" ? { project: "scratch" } : {},
			),
	);
	const fixture = await testDatabase();
	const database = await Database.open({ url: fixture.url });
	try {
		await database.write(
			async (db) => await db.transaction(async () => await importArchive(db, linesOf(chunks.join("")))),
		);
		const app = { ...h.app, database };
		expect(
			await invoke(app, OPS, {
				op: "find",
				project: "scratch",
				input: { text: "zephyrpassword", folder: "Consumers" },
				actor: async () => h.owner,
			}),
		).toMatchObject({ ok: true, result: { count: 2 } });
		expect(
			await invoke(app, OPS, {
				op: "find",
				project: "scratch",
				input: { text: "luminousreply", folder: "Consumers" },
				actor: async () => h.owner,
			}),
		).toMatchObject({ ok: true, result: { count: 1, items: [{ ref: "C-2" }] } });
		expect(
			await invoke(app, OPS, {
				op: "plan",
				project: "scratch",
				input: { name: "Restored password checks", select: { text: "zephyrpassword", folders: ["Consumers"] } },
				actor: async () => h.owner,
			}),
		).toMatchObject({ ok: true, result: { slots: 2 } });
	} finally {
		await database.close();
		await fixture.close();
	}
});

test("a case expands its pinned fragment, retaining the editable pin and source marker", async () => {
	await createFragment();
	await createUser();
	expect(await view("C-1")).toMatchObject({ kind: "fragment" });
	expect(REPLIES.get.safeParse([await view()])).toMatchObject({ success: true });
	expect(await view()).toMatchObject({
		steps: [
			{
				id: "cd.ab",
				action: "Enter a password",
				expected: "Signed in",
				source: { fragment: "C-1", version: 1, step: "ab", use: "cd" },
			},
			{ id: "ef", action: "Pay" },
		],
		sourceSteps: [
			{ id: "cd", use: { fragment: "C-1", version: 1 } },
			{ id: "ef", action: "Pay" },
		],
	});
	await updateFragment();
	expect(await view()).toMatchObject({ version: 1, steps: [{ action: "Enter a password" }, {}] });
});

test("source steps are returned only for a case version with fragment pins", async () => {
	await createFragment();
	await h.call("propose", {
		edits: [{ op: "create", body: { title: "Plain case", steps: [{ id: "ef", action: "Pay", expected: "Receipt" }] } }],
	});
	for (const ref of ["C-1", "C-2"]) {
		for (const fields of [undefined, ["steps"]]) {
			const reply = await h.call<Record<string, unknown>[]>("get", { refs: [ref], fields });
			expect(REPLIES.get.safeParse(reply).success).toBe(true);
			expect(reply[0]).toMatchObject({
				ref,
				hasFragments: false,
				steps: [{ action: ref === "C-1" ? "Enter a password" : "Pay" }],
			});
			expect(reply[0]).not.toHaveProperty("sourceSteps");
		}
	}
	await h.call("propose", {
		edits: [
			{ op: "edit", case: "C-2", base: 1, body: { steps: [{ id: "cd", use: { fragment: "C-1", version: 1 } }] } },
		],
	});
	const pinned = await h.call("get", { refs: ["C-2"] });
	expect(REPLIES.get.safeParse(pinned).success).toBe(true);
	expect(pinned).toMatchObject([
		{
			ref: "C-2",
			hasFragments: true,
			sourceSteps: [{ id: "cd", use: { fragment: "C-1", version: 1 } }],
			steps: [{ action: "Enter a password" }],
		},
	]);
	const historical = await view("C-2", 1);
	expect(historical).toMatchObject({ version: 1, hasFragments: false, steps: [{ action: "Pay" }] });
	expect(historical).not.toHaveProperty("sourceSteps");
});

test("custom fields are returned by default and fragment users only when selected", async () => {
	await createFragment();
	await createUser();
	for (const ref of ["C-1", "C-2"]) {
		for (const fields of [undefined, ["title"]]) {
			const [read] = await h.call<Record<string, unknown>[]>("get", { refs: [ref], fields });
			expect(read).toMatchObject({ ref, title: ref === "C-1" ? "Sign in" : "Checkout", version: 1 });
			if (fields === undefined) expect(read).toHaveProperty("fields", ref === "C-2" ? { risk: "high" } : {});
			else expect(read).not.toHaveProperty("fields");
			expect(read).not.toHaveProperty("users");
		}
	}
	expect(await h.call("get", { refs: ["C-2"], fields: ["fields"] })).toMatchObject([
		{ ref: "C-2", fields: { risk: "high" } },
	]);
	expect(await h.call("get", { refs: ["C-1"], fields: ["users", "fields"] })).toMatchObject([
		{ ref: "C-1", fields: {}, users: [{ case: "C-2", base: 1, versions: [1] }] },
	]);
});

test("archived fragments retain existing users but refuse new pins", async () => {
	await createFragment();
	await createUser();
	expect(await h.call("propose", { edits: [{ op: "state", cases: ["C-1"], to: "archived" }] })).toMatchObject({
		status: "adopted",
	});
	expect(await view("C-1")).toMatchObject({ state: "archived" });
	expect(await view()).toMatchObject({ steps: [{ action: "Enter a password" }, {}] });
	expect(
		await h.call("propose", { edits: [{ op: "edit", case: "C-2", base: 1, body: { title: "Edited" } }] }),
	).toMatchObject({
		status: "adopted",
	});
	expect(await h.call("propose", { edits: [{ op: "restore", case: "C-2", to: 1 }] })).toMatchObject({
		status: "adopted",
	});
	expect(await view()).toMatchObject({ version: 3, title: "Checkout", steps: [{ action: "Enter a password" }, {}] });
	const before = await h.app.database.read(
		async (db) => await db.all(sql<readonly SqlValue[], Record<string, unknown>>("SELECT * FROM versions"), []),
	);
	for (const edit of [
		{ op: "create", body: { title: "New user", steps: [{ id: "gh", use: { fragment: "C-1", version: 1 } }] } },
		{
			op: "edit",
			case: "C-2",
			base: 3,
			body: {
				steps: [
					{ id: "cd", use: { fragment: "C-1", version: 1 } },
					{ id: "gh", use: { fragment: "C-1", version: 1 } },
				],
			},
		},
	]) {
		expect(await h.raw("propose", { edits: [edit] })).toMatchObject({
			ok: false,
			error: { code: "invalid", message: expect.stringContaining("C-1 is archived") },
		});
	}
	expect(
		await h.app.database.read(
			async (db) => await db.all(sql<readonly SqlValue[], Record<string, unknown>>("SELECT * FROM versions"), []),
		),
	).toEqual(before);
	expect(await h.call("propose", { edits: [{ op: "state", cases: ["C-1"], to: "active" }] })).toMatchObject({
		status: "adopted",
	});
	expect(await createUser("New user")).toMatchObject({ status: "adopted" });
});

test("a fragment archived while a new pin waits for acceptance refuses that adoption", async () => {
	await h.close();
	h = await harness({ preset: "standard" });
	await createFragment();
	const writer = await h.actor("writer", "agent", ["read", "produce"]);
	const pending = await h.call<ProposeReply>(
		"propose",
		{
			edits: [
				{ op: "create", body: { title: "Waiting", steps: [{ id: "cd", use: { fragment: "C-1", version: 1 } }] } },
			],
		},
		writer,
	);
	expect(pending).toMatchObject({ status: "open", question: "Q-2" });
	await h.call("propose", { edits: [{ op: "state", cases: ["C-1"], to: "archived" }] });
	const question = (await h.call<{ evidenceHash: string }[]>("get", { refs: [pending.question] }))[0];
	expect(
		await h.raw("decide", { q: pending.question, onEvidence: question?.evidenceHash, answer: { is: "accept" } }),
	).toMatchObject({
		ok: true,
		result: [{ status: "invalid", needs: expect.stringContaining("C-1 is archived") }],
	});
	expect(await h.raw("get", { refs: ["C-2"] })).toMatchObject({ ok: false, error: { code: "not_found" } });
});

test("an explicit creation kind must match its Markdown kind", async () => {
	for (const kind of ["case", "fragment"]) {
		const other = kind === "case" ? "fragment" : "case";
		expect(
			await h.raw("propose", {
				edits: [{ op: "create", kind, md: `---\nkind: ${other}\ntitle: Mismatch\n---\n## Steps\n` }],
			}),
		).toMatchObject({
			ok: false,
			error: { code: "invalid", message: expect.stringContaining("kind") },
		});
		expect(await h.call("find", { in: "cases" })).toMatchObject({ items: [] });
	}
	expect(
		await h.call("propose", {
			edits: [{ op: "create", kind: "fragment", md: "---\nkind: fragment\ntitle: Matching\n---\n## Steps\n" }],
		}),
	).toMatchObject({ status: "adopted" });
	expect(await view("C-1")).toMatchObject({ kind: "fragment", title: "Matching" });
});

test("one batch moves selected users through one attributable decision and leaves others pinned", async () => {
	await createFragment();
	await createUser();
	await createUser("Returns");
	await createUser("Stay pinned");
	await updateFragment();
	const reply = await h.call<ProposeReply>("propose", {
		edits: [
			{
				op: "fragment",
				fragment: "C-1",
				from: 1,
				to: 2,
				cases: [
					{ case: "C-2", base: 1 },
					{ case: "C-3", base: 1 },
				],
			},
		],
		reason: "Adopt passkeys",
	});
	expect(reply).toMatchObject({
		status: "adopted",
		cases: [
			{ ref: "C-2", version: 2 },
			{ ref: "C-3", version: 2 },
		],
	});
	expect(await view()).toMatchObject({ steps: [{ action: "Use a passkey", source: { version: 2 } }, {}] });
	expect(await view("C-4")).toMatchObject({ version: 1, steps: [{ action: "Enter a password" }, {}] });
	expect(await view("C-2", 1)).toMatchObject({ steps: [{ action: "Enter a password" }, {}] });
	const rows = await h.app.database.read(
		async (db) =>
			await db.all(
				sql<readonly SqlValue[], { decision: number; proposal: number; author: number; reason: string }>(
					"SELECT decision, proposal, author, reason FROM versions WHERE no = 2 AND case_id IN (2, 3) ORDER BY case_id",
				),
				[],
			),
	);
	expect(rows).toHaveLength(2);
	expect(rows[0]).toEqual(rows[1]);
	expect(rows[0]).toMatchObject({ author: h.owner.id, reason: "Adopt passkeys" });
});

test("Markdown round trips preserve fragment kind and pinned references through edits", async () => {
	await createFragment();
	await createUser();
	const md = (await h.call<{ md: string }[]>("get", { refs: ["C-2"], as: "md" }))[0]?.md ?? "";
	expect(md).toContain("- !use C-1@v1 ^cd");
	const parsed = parseCase(md);
	expect(parsed).toMatchObject({
		ok: true,
		doc: { body: { steps: [{ id: "cd", use: { fragment: "C-1", version: 1 } }, {}] } },
	});
	await h.call("propose", {
		edits: [{ op: "edit", case: "C-2", base: 1, md: md.replace("title: Checkout", "title: Edited") }],
	});
	expect(await view()).toMatchObject({ title: "Edited", steps: [{ action: "Enter a password" }, {}] });
	const fragmentMd = (await h.call<{ md: string }[]>("get", { refs: ["C-1"], as: "md" }))[0]?.md ?? "";
	expect(parseCase(fragmentMd)).toMatchObject({ ok: true, doc: { kind: "fragment" } });
});

test("missing targets, missing versions and every form of fragment nesting are refused without writes", async () => {
	await createFragment();
	await createUser();
	for (const step of [
		{ id: "zz", use: { fragment: "C-99", version: 1 } },
		{ id: "zz", use: { fragment: "C-1", version: 99 } },
		{ id: "zz", use: { fragment: "C-2", version: 1 } },
	]) {
		expect(
			await h.raw("propose", { edits: [{ op: "edit", case: "C-2", base: 1, body: { steps: [step] } }] }),
		).toMatchObject({
			ok: false,
		});
	}
	for (const fragment of ["C-1", "C-2"]) {
		expect(
			await h.raw("propose", {
				edits: [{ op: "edit", case: "C-1", base: 1, body: { steps: [{ id: "zz", use: { fragment, version: 1 } }] } }],
			}),
		).toMatchObject({ ok: false, error: { code: "invalid" } });
	}
	expect(await view()).toMatchObject({ version: 1, title: "Checkout" });
});

test("a stale selected base refuses the entire batch", async () => {
	await createFragment();
	await createUser();
	await createUser("Returns");
	await updateFragment();
	await h.call("propose", { edits: [{ op: "edit", case: "C-3", base: 1, body: { title: "Changed" } }] });
	expect(
		await h.raw("propose", {
			edits: [
				{
					op: "fragment",
					fragment: "C-1",
					from: 1,
					to: 2,
					cases: [
						{ case: "C-2", base: 1 },
						{ case: "C-3", base: 1 },
					],
				},
			],
		}),
	).toMatchObject({ ok: false, error: { code: "conflict" } });
	expect(await view()).toMatchObject({ version: 1, steps: [{ action: "Enter a password" }, {}] });
});

test.each(["instance", "project"])(
	"pins survive %s archive replay with history, hashes and current usage intact",
	async (scope) => {
		await createFragment();
		await createUser();
		await updateFragment();
		await h.call("propose", {
			edits: [{ op: "fragment", fragment: "C-1", from: 1, to: 2, cases: [{ case: "C-2", base: 1 }] }],
		});
		const before = await view();
		const chunks: string[] = [];
		await h.app.database.read(
			async (db) =>
				await exportArchive(
					db,
					(chunk) => {
						chunks.push(chunk);
					},
					scope === "project" ? { project: "scratch" } : {},
				),
		);
		const fixture = await testDatabase();
		const database = await Database.open({ url: fixture.url });
		try {
			await database.write(
				async (db) => await db.transaction(async () => await importArchive(db, linesOf(chunks.join("")))),
			);
			await database.read(async (db) => {
				const fragment = await mustCase(db, 1, "C-1");
				const consumer = await mustCase(db, 1, "C-2");
				expect(fragment.kind).toBe("fragment");
				expect(before).toMatchObject({ hash: consumer.head_hash });
				expect((await expandSteps(db, 1, await bodyOf(db, consumer.id, 1)))[0]).toMatchObject({
					action: "Enter a password",
					source: { version: 1 },
				});
				expect((await expandSteps(db, 1, await bodyOf(db, consumer.id, 2)))[0]).toMatchObject({
					action: "Use a passkey",
					source: { version: 2 },
				});
				expect(await fragmentUsers(db, 1, "C-1")).toEqual([{ case: "C-2", base: 2, versions: [2] }]);
			});
		} finally {
			await database.close();
			await fixture.close();
		}
	},
);

test("pin updates participate in hashing, history diffs, stale merges and draft saving", () => {
	const original = { ...emptyBody("User"), steps: [Step.parse({ id: "cd", use: { fragment: "C-1", version: 1 } })] };
	const next = { ...original, steps: [Step.parse({ id: "cd", use: { fragment: "C-1", version: 2 } })] };
	expect(versionHash(next)).not.toBe(versionHash(original));
	expect(claimHash(next)).not.toBe(claimHash(original));
	const diff = diffBodies(original, next);
	expect(isEmptyDiff(diff)).toBe(false);
	expect(applyDiff({ body: original, diff })).toEqual(next);
	expect(mergeBodies({ base: original, mine: next, theirs: { ...original, title: "Renamed" } })).toEqual({
		conflicts: [],
		merged: { ...next, title: "Renamed" },
	});
	const third = { ...original, steps: [Step.parse({ id: "cd", use: { fragment: "C-1", version: 3 } })] };
	expect(mergeBodies({ base: original, mine: next, theirs: third }).conflicts).toEqual([
		{ address: { kind: "step", id: "cd" }, base: original.steps[0], mine: next.steps[0], theirs: third.steps[0] },
	]);
	expect(recordable(original)).toEqual(original);
	expect(holdsUnfinishedStep(original)).toBe(false);
});

test("two uses of the same fragment have distinct result anchors, and plans select cases", async () => {
	await createFragment();
	await h.call("propose", {
		edits: [
			{
				op: "create",
				body: {
					title: "Twice",
					steps: [
						{ id: "cd", use: { fragment: "C-1", version: 1 } },
						{ id: "ef", use: { fragment: "C-1", version: 1 } },
					],
				},
			},
		],
	});
	expect(await view()).toMatchObject({ steps: [{ id: "cd.ab" }, { id: "ef.ab" }] });
	expect(await h.call("plan", { name: "Cases", select: {} })).toMatchObject({ slots: 1 });
	expect(await h.raw("plan", { name: "Fragment", select: { cases: ["C-1"] } })).toMatchObject({
		ok: false,
		error: { code: "invalid" },
	});
});

test("run selection previews share planned membership and paging, while Suite listings keep fragments", async () => {
	await createFragment();
	await createUser();
	await createUser("Checkout again");
	await createUser("Checkout retired");
	await h.call("propose", {
		edits: [
			{ op: "place", cases: ["C-1", "C-2", "C-3", "C-4"], folder: "checkout/pay", tags: { add: ["smoke"] } },
			{ op: "place", cases: ["C-1"], tags: { add: ["shared"] } },
			{ op: "state", cases: ["C-4"], to: "archived" },
		],
	});
	expect(await h.call("find", { in: "cases" })).toMatchObject({ count: 3 });
	for (const select of [{}, { folders: ["checkout"] }, { tags: ["#smoke"] }, { text: "Checkout" }]) {
		const preview = await h.call<{ count: number; items: { ref: string }[]; cursor: string | null }>("find", {
			in: "cases",
			select,
			limit: 1,
		});
		expect(preview).toMatchObject({ count: 2, items: [{ ref: "C-2" }], cursor: "1" });
		expect(await h.call("find", { in: "cases", select, limit: 1, cursor: preview.cursor })).toMatchObject({
			count: 2,
			items: [{ ref: "C-3" }],
			cursor: null,
		});
		const planned = await h.call<{ run: string; slots: number }>("plan", { name: "Previewed checkout", select });
		expect(planned.slots).toBe(2);
		expect(await h.call("find", { in: "slots", run: planned.run })).toMatchObject({
			count: 2,
			items: [{ case: "C-2" }, { case: "C-3" }],
		});
	}
	expect(await h.call("find", { in: "cases", select: { tags: ["shared"] } })).toMatchObject({
		count: 0,
		items: [],
		cursor: null,
	});
	expect(await h.raw("plan", { name: "Only shared steps", select: { tags: ["shared"] } })).toMatchObject({
		ok: false,
		error: { code: "invalid", message: "the selection matches no active case" },
	});
	expect(await h.raw("find", { in: "cases", select: { cases: ["C-1"] } })).toMatchObject({
		ok: false,
		error: { code: "invalid", message: "fragments are shared steps; select their cases to run" },
	});
});

test("a batch waiting for review refuses a case changed after the proposal was sealed", async () => {
	await createFragment();
	await createUser();
	await createUser("Returns");
	await updateFragment();
	const policy = await h.call<ProposeReply>("propose", { edits: [{ op: "policy", preset: "strict" }] });
	if (policy.question) {
		const question = (await h.call<{ evidenceHash: string }[]>("get", { refs: [policy.question] }))[0];
		await h.call("decide", { q: policy.question, onEvidence: question?.evidenceHash, answer: { is: "accept" } });
	}
	const writer = await h.actor("writer", "agent", ["read", "produce"]);
	const batch = await h.call<ProposeReply>(
		"propose",
		{
			edits: [
				{
					op: "fragment",
					fragment: "C-1",
					from: 1,
					to: 2,
					cases: [
						{ case: "C-2", base: 1 },
						{ case: "C-3", base: 1 },
					],
				},
			],
		},
		writer,
	);
	expect(batch.status).toBe("open");
	// An earlier consumer edit can be accepted before this batch.
	const other = await h.call<ProposeReply>(
		"propose",
		{ edits: [{ op: "edit", case: "C-3", base: 1, body: { title: "Changed" } }] },
		writer,
	);
	const decide = async (q: string | null) => {
		const question = (await h.call<{ evidenceHash: string }[]>("get", { refs: [q] }))[0];
		return h.raw("decide", {
			q,
			onEvidence: question?.evidenceHash,
			answer: { is: "accept" },
			reason: "Accept the selected case changes",
		});
	};
	expect(await decide(other.question)).toMatchObject({ ok: true });
	// Read before it is answered, the batch says that accepting it is refused now, and why.
	type Read = { edits: { case: string; refused: string | null }[] };
	const [read] = await h.call<Read[]>("get", { refs: [batch.proposal] });
	expect(read?.edits.map((edit) => [edit.case, edit.refused])).toEqual([
		["C-2", null],
		["C-3", "C-3 changed; redo the fragment batch"],
	]);
	const result = await decide(batch.question);
	expect(result).toMatchObject({ ok: true, result: [{ status: "conflict" }] });
	expect(await view()).toMatchObject({ version: 1, steps: [{ action: "Enter a password" }, {}] });
	expect(await view("C-3")).toMatchObject({
		version: 2,
		title: "Changed",
		steps: [{ action: "Enter a password" }, {}],
	});
});

test("expected results in pinned fragments count for structural checks", async () => {
	await createFragment();
	await h.call("propose", {
		edits: [
			{
				op: "create",
				body: { title: "Only shared steps", steps: [{ id: "cd", use: { fragment: "C-1", version: 1 } }] },
			},
		],
	});
	expect(
		(await h.app.database.read(async (db) => await structuralProblems(db, 1))).find(
			(problem) => problem.rule === "no-expected",
		),
	).toMatchObject({ total: 0 });
	await h.call("propose", {
		edits: [
			{ op: "edit", case: "C-1", base: 1, body: { steps: [{ id: "ab", action: "No outcome", expected: null }] } },
		],
	});
	// The consumer still has the expectation from fragment version 1.
	expect(
		(await h.app.database.read(async (db) => await structuralProblems(db, 1))).find(
			(problem) => problem.rule === "no-expected",
		),
	).toMatchObject({
		total: 1,
		rows: [{ ref: "C-1" }],
	});
});

test("drafts keep an empty expectation while a person starts typing it", () => {
	const body = { ...emptyBody("Draft"), steps: [{ id: "ab", action: "Open", expected: "" }] };
	expect(DraftBody.safeParse(body)).toMatchObject({
		success: true,
		data: { steps: [{ id: "ab", action: "Open", expected: "" }] },
	});
});
