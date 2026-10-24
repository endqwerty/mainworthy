import { expect, expectTypeOf, test } from "bun:test";
import type { FailureSubject, QuestionRow } from "../src/server/decisions/questions.ts";
import * as questions from "../src/server/decisions/questions.ts";
import { type SqlValue, sql } from "../src/server/kernel/db.ts";
import { ciReport, harness } from "./helpers.ts";

async function fixture() {
	const h = await harness();
	await h.call("report", ciReport({ commit: "subject01", n: 1, fail: { 0: "same cause" } }));
	const db = h.app.database;
	const row = await db.read(
		async (db) =>
			await db.get(
				sql<[], { id: number; no: number; project: number; fingerprint: string; subject: string }>(
					"SELECT id, no, project, fingerprint, subject FROM questions WHERE kind = 'failure'",
				),
			),
	);
	if (!row) throw new Error("missing failure question");
	const about = (await db.read(async (lease) => await questions.refsOf(lease, row.id)))[0];
	if (!about) throw new Error("missing question ref");
	const readers = [
		async () => await db.read(async (lease) => await questions.questionById(lease, row.id)),
		async () => await db.read(async (lease) => await questions.mustQuestion(lease, row.project, `Q-${row.no}`)),
		async () =>
			await db.read(async (lease) => await questions.latestByFingerprint(lease, row.project, row.fingerprint)),
		async () =>
			(await db.read(async (lease) => await questions.liveByFingerprint(lease, row.project, row.fingerprint)))[0],
		async () => (await db.read(async (lease) => await questions.questionsOn(lease, row.project, about)))[0],
		async () => (await db.read(async (lease) => await questions.everyQuestionOn(lease, row.project, about)))[0],
		async () => (await db.read(async (lease) => await questions.openQuestionsOn(lease, row.project, about)))[0],
		...([undefined, "failure"] as const).map(
			(kind) => async () =>
				(
					await db.read(
						async (lease) =>
							await questions.queuePage(lease, { project: row.project, kind, state: "open", after: null, limit: 10 }),
					)
				)[0],
		),
		async () =>
			(
				await db.read(async (lease) => await questions.questionsChangedSince(lease, row.project, { rev: 0, id: 0 }, 10))
			).find((q) => q.id === row.id),
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
			await db.write(
				async (db) =>
					await db.transaction(
						async () =>
							await db.run(
								sql<readonly SqlValue[], Record<string, unknown>>("UPDATE questions SET subject = $1 WHERE id = $2"),
								[stored, row.id],
							),
					),
			);
			for (const read of readers) expect((await read())?.subject).toEqual(subject);
			await db.write(
				async (db) =>
					await db.transaction(
						async () =>
							await db.run(
								sql<readonly SqlValue[], Record<string, unknown>>(
									"UPDATE questions SET state = 'decided' WHERE id = $1",
								),
								[row.id],
							),
					),
			);
			for (const kind of [undefined, "failure"] as const) {
				expect(
					(
						await db.read(
							async (lease) =>
								await questions.ledgerPage(lease, { project: row.project, kind, before: null, limit: 10 }),
						)
					).find((q) => q.id === row.id)?.subject,
				).toEqual(subject);
			}
			await db.write(
				async (db) =>
					await db.transaction(
						async () =>
							await db.run(
								sql<readonly SqlValue[], Record<string, unknown>>("UPDATE questions SET state = 'open' WHERE id = $1"),
								[row.id],
							),
					),
			);
			expect(
				await db.read(
					async (db) =>
						await db.get(
							sql<readonly SqlValue[], Record<string, unknown>>("SELECT subject FROM questions WHERE id = $1"),
							[row.id],
						),
				),
			).toEqual({ subject: stored });
		}
	} finally {
		await h.close();
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
			await db.write(
				async (db) =>
					await db.transaction(
						async () =>
							await db.run(
								sql<readonly SqlValue[], Record<string, unknown>>("UPDATE questions SET subject = $1 WHERE id = $2"),
								[JSON.stringify(subject), row.id],
							),
					),
			);
			for (const read of readers) await expect(read()).rejects.toThrow();
			await db.write(
				async (db) =>
					await db.transaction(
						async () =>
							await db.run(
								sql<readonly SqlValue[], Record<string, unknown>>(
									"UPDATE questions SET state = 'decided' WHERE id = $1",
								),
								[row.id],
							),
					),
			);
			for (const kind of [undefined, "failure"] as const)
				await expect(
					db.read(
						async (lease) => await questions.ledgerPage(lease, { project: row.project, kind, before: null, limit: 10 }),
					),
				).rejects.toThrow();
			await db.write(
				async (db) =>
					await db.transaction(
						async () =>
							await db.run(
								sql<readonly SqlValue[], Record<string, unknown>>("UPDATE questions SET state = 'open' WHERE id = $1"),
								[row.id],
							),
					),
			);
		}
		await db.write(
			async (db) =>
				await db.transaction(
					async () =>
						await db.run(
							sql<readonly SqlValue[], Record<string, unknown>>("UPDATE questions SET subject = '{' WHERE id = $1"),
							[row.id],
						),
				),
		);
		for (const read of readers) await expect(read()).rejects.toThrow();
	} finally {
		await h.close();
	}
});

test("the attributed cause reader uses the same failure subject boundary", async () => {
	const { h, db, row, about } = await fixture();
	try {
		const open = await db.read(async (lease) => await questions.mustQuestion(lease, row.project, `Q-${row.no}`));
		await h.call("decide", { q: `Q-${row.no}`, onEvidence: open.evidence_hash, answer: { is: "defect" } });
		expect(
			(await db.read(async (lease) => await questions.attributedQuestionsOn(lease, row.project, about)))[0]?.subject,
		).toEqual({
			kind: "cause",
			...JSON.parse(row.subject),
		});
		await db.write(
			async (db) =>
				await db.transaction(
					async () =>
						await db.run(
							sql<readonly SqlValue[], Record<string, unknown>>("UPDATE questions SET subject = $1 WHERE id = $2"),
							[JSON.stringify({ signature: "1", scope: "line:main" }), row.id],
						),
				),
		);
		await expect(
			db.read(async (lease) => await questions.attributedQuestionsOn(lease, row.project, about)),
		).rejects.toThrow();
	} finally {
		await h.close();
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
		expect(
			await h.app.database.read(
				async (db) =>
					await db.all(
						sql<[], Record<string, unknown>>("SELECT subject FROM questions WHERE kind = 'failure' ORDER BY id"),
					),
			),
		).toEqual([
			{ subject: '{"signature":1,"scope":"line:trunk@acme/web"}' },
			{ subject: '{"signature":1,"scope":"change:1","perResult":true}' },
		]);
	} finally {
		await h.close();
	}
});

test("a slot writer keeps its legacy JSON encoding", async () => {
	const h = await harness();
	try {
		await h.call("propose", { edits: [{ op: "create", outline: "Checkout works" }] });
		const tester = await h.actor("tester", "human", ["read", "produce"]);
		const ci = await h.actor("ci", "ci", ["read", "record"]);
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
		expect(
			await h.app.database.read(
				async (db) =>
					await db.all(
						sql<[], Record<string, unknown>>("SELECT subject FROM questions WHERE kind = 'failure' ORDER BY id"),
					),
			),
		).toEqual([
			{ subject: '{"signature":1,"scope":"change:1"}' },
			{ subject: '{"slot":1,"signature":1,"scope":"change:1"}' },
		]);
	} finally {
		await h.close();
	}
});
