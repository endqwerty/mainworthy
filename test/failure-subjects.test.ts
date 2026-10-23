import { expect, expectTypeOf, test } from "bun:test";
import type { FailureSubject, QuestionRow } from "../src/server/decisions/questions.ts";
import * as questions from "../src/server/decisions/questions.ts";
import { ciReport, harness } from "./helpers.ts";

async function fixture() {
	const h = await harness();
	await h.call("report", ciReport({ commit: "subject01", n: 1, fail: { 0: "same cause" } }));
	const db = h.app.db;
	const row = db.raw
		.query<{ id: number; no: number; project: number; fingerprint: string; subject: string }, []>(
			"SELECT id, no, project, fingerprint, subject FROM questions WHERE kind = 'failure'",
		)
		.get();
	if (!row) throw new Error("missing failure question");
	const about = (await questions.refsOf(db, row.id))[0];
	if (!about) throw new Error("missing question ref");
	const readers = [
		async () => await questions.questionById(db, row.id),
		async () => await questions.mustQuestion(db, row.project, `Q-${row.no}`),
		async () => await questions.latestByFingerprint(db, row.project, row.fingerprint),
		async () => (await questions.liveByFingerprint(db, row.project, row.fingerprint))[0],
		async () => (await questions.questionsOn(db, row.project, about))[0],
		async () => (await questions.everyQuestionOn(db, row.project, about))[0],
		async () => (await questions.openQuestionsOn(db, row.project, about))[0],
		...([undefined, "failure"] as const).map(
			(kind) => () => questions.queuePage(db, { project: row.project, kind, state: "open", after: null, limit: 10 })[0],
		),
		async () =>
			(await questions.questionsChangedSince(db, row.project, { rev: 0, id: 0 }, 10)).find((q) => q.id === row.id),
	];
	return { h, db, row, about, readers };
}

test("failure subjects have exactly the fields of their tagged variant", () => {
	expectTypeOf<Extract<FailureSubject, { kind: "cause" }>>().toEqualTypeOf<{
		kind: "cause";
		signature: number;
		scope: string;
	}>();
	expectTypeOf<Extract<FailureSubject, { kind: "inherited" }>>().toEqualTypeOf<{
		kind: "inherited";
		signature: number;
		scope: string;
	}>();
	expectTypeOf<Extract<FailureSubject, { kind: "slot" }>>().toEqualTypeOf<{
		kind: "slot";
		signature: number;
		scope: string;
		slot: number;
	}>();
	expectTypeOf<Extract<QuestionRow, { kind: "failure" }>["subject"]>().toEqualTypeOf<FailureSubject>();
	expectTypeOf<Extract<FailureSubject, { kind: "cause" }>>().not.toHaveProperty("slot");
	expectTypeOf<Extract<FailureSubject, { kind: "inherited" }>>().not.toHaveProperty("slot");
	expectTypeOf<FailureSubject>().not.toHaveProperty("perResult");
});

test("every question reader parses each legacy failure subject without changing its stored JSON", async () => {
	const { h, db, row, readers } = await fixture();
	try {
		for (const [stored, subject] of [
			['{ "scope": "line:main", "signature": 1 }', { kind: "cause", signature: 1, scope: "line:main" }],
			['{"signature":1,"scope":"change:1","perResult":true}', { kind: "inherited", signature: 1, scope: "change:1" }],
			['{"slot":2,"signature":1,"scope":"run:1"}', { kind: "slot", slot: 2, signature: 1, scope: "run:1" }],
		] as const) {
			db.raw.run("UPDATE questions SET subject = ? WHERE id = ?", [stored, row.id]);
			for (const read of readers) expect((await read())?.subject).toEqual(subject);
			db.raw.run("UPDATE questions SET state = 'decided' WHERE id = ?", [row.id]);
			for (const kind of [undefined, "failure"] as const) {
				expect(
					(await questions.ledgerPage(db, { project: row.project, kind, before: null, limit: 10 })).find(
						(q) => q.id === row.id,
					)?.subject,
				).toEqual(subject);
			}
			db.raw.run("UPDATE questions SET state = 'open' WHERE id = ?", [row.id]);
			expect(db.raw.query("SELECT subject FROM questions WHERE id = ?").get(row.id)).toEqual({ subject: stored });
		}
	} finally {
		h.close();
	}
});

test("question readers reject impossible failure subjects at the storage boundary", async () => {
	const { h, db, row, readers } = await fixture();
	try {
		for (const subject of [
			{ signature: 1, scope: "run:1", slot: 2, perResult: true },
			{ signature: 1, scope: "run:1", slot: 2, perResult: false },
			{ signature: 1, scope: "change:1", perResult: false },
			{ signature: 1, scope: "change:1", perResult: 1 },
			{ signature: 1, scope: "change:1", perResult: null },
			{ signature: 1, scope: "run:1", slot: null },
			{ signature: 1, scope: "run:1", slot: "2" },
			{ scope: "line:main" },
			{ signature: 1 },
			{ signature: "1", scope: "line:main" },
			{ signature: 1, scope: 2 },
			{ signature: 1, scope: "line:main", kind: "cause" },
			{ signature: 1, scope: "line:main", extra: true },
			null,
			[],
		]) {
			db.raw.run("UPDATE questions SET subject = ? WHERE id = ?", [JSON.stringify(subject), row.id]);
			for (const read of readers) expect(read).toThrow();
			db.raw.run("UPDATE questions SET state = 'decided' WHERE id = ?", [row.id]);
			for (const kind of [undefined, "failure"] as const)
				expect(() => questions.ledgerPage(db, { project: row.project, kind, before: null, limit: 10 })).toThrow();
			db.raw.run("UPDATE questions SET state = 'open' WHERE id = ?", [row.id]);
		}
		db.raw.run("UPDATE questions SET subject = '{' WHERE id = ?", [row.id]);
		for (const read of readers) expect(read).toThrow();
	} finally {
		h.close();
	}
});

test("the attributed cause reader uses the same failure subject boundary", async () => {
	const { h, db, row, about } = await fixture();
	try {
		const open = await questions.mustQuestion(db, row.project, `Q-${row.no}`);
		await h.call("decide", { q: `Q-${row.no}`, onEvidence: open.evidence_hash, answer: { is: "defect" } });
		expect((await questions.attributedQuestionsOn(db, row.project, about))[0]?.subject).toEqual({
			kind: "cause",
			...JSON.parse(row.subject),
		});
		db.raw.run("UPDATE questions SET subject = ? WHERE id = ?", [
			JSON.stringify({ signature: "1", scope: "line:main" }),
			row.id,
		]);
		expect(() => questions.attributedQuestionsOn(db, row.project, about)).toThrow();
	} finally {
		h.close();
	}
});

test("cause and inherited writers keep their legacy JSON encodings", async () => {
	const h = await harness();
	try {
		await h.call("report", ciReport({ commit: "base0001", n: 1, fail: { 0: "same cause" } }));
		await h.call(
			"report",
			ciReport({ commit: "change01", branch: "feature", pr: 69, base: "base0001", n: 1, fail: { 0: "same cause" } }),
		);
		expect(h.app.db.raw.query("SELECT subject FROM questions WHERE kind = 'failure' ORDER BY id").all()).toEqual([
			{ subject: '{"signature":1,"scope":"line:trunk@acme/web"}' },
			{ subject: '{"signature":1,"scope":"change:1","perResult":true}' },
		]);
	} finally {
		h.close();
	}
});

test("a slot writer keeps its legacy JSON encoding", async () => {
	const h = await harness();
	try {
		await h.call("propose", { edits: [{ op: "create", outline: "Checkout works" }] });
		const tester = h.actor("tester", "human", ["read", "produce"]);
		const ci = h.actor("ci", "ci", ["read", "record"]);
		const run = await h.call<{ run: string }>("plan", {
			name: "Dispute",
			select: {},
			accepts: { commit: "typed0068" },
		});
		await h.call(
			"report",
			{
				run: run.run,
				results: [{ test: { case: "C-1" }, outcome: "fail", failure: { message: "same cause" } }],
			},
			tester,
		);
		await h.call(
			"report",
			{
				target: { commit: "typed0068", branch: "main" },
				results: [{ test: { key: "checkout" }, outcome: "pass", annotation: { case: "C-1", version: 1 } }],
			},
			ci,
		);
		expect(h.app.db.raw.query("SELECT subject FROM questions WHERE kind = 'failure' ORDER BY id").all()).toEqual([
			{ subject: '{"signature":1,"scope":"change:1"}' },
			{ subject: '{"slot":1,"signature":1,"scope":"change:1"}' },
		]);
	} finally {
		h.close();
	}
});
