import { expect, test } from "bun:test";
import type { InboxReply } from "../src/core/ops.ts";
import { sql } from "../src/server/kernel/db.ts";
import { harness } from "./helpers.ts";
import { failingSlotResults, invalidInherited, slotSettlement } from "./inherited-audit.ts";
import { auditRelations } from "./sequence-audit.ts";

test("one audit snapshot preserves scalar slot classifications and raw admissions", async () => {
	const h = await harness();
	try {
		await h.call("propose", { edits: [{ op: "create", outline: "Check\n  Do it > It works" }] });
		await h.call("plan", {
			name: "Snapshot",
			select: { cases: ["C-1"] },
			require: [
				{ id: "exercise", kind: "exercise", methods: ["human", "agent"], basis: "exact-or-assumed", minActors: 1 },
			],
		});
		const other = await h.actor("other", "human", ["read", "record"]);
		const agent = await h.actor("agent", "agent", ["read", "produce"]);
		const judge = await h.actor("judge", "human", ["read", "produce", "answer"]);
		const report = (outcome: string, as = h.owner) =>
			h.call(
				"report",
				{
					run: "R-1",
					results: [{ test: { case: "C-1" }, outcome, note: "Snapshot note" }],
				},
				as,
			);
		const compare = () =>
			h.app.database.read(async (db) => {
				const before = h.app.database.statementCount;
				const snapshot = await auditRelations(db, h.app.now());
				expect(h.app.database.statementCount - before).toBe(1);
				const slots = await db.all(sql<readonly [], { id: number; run: number }>("SELECT id,run FROM slots"));
				const results = await db.all(sql<readonly [], { id: number }>("SELECT id FROM results"));
				for (const slot of slots) {
					expect(snapshot.failing(slot.id).sort((a, b) => a.id - b.id)).toEqual(
						(await failingSlotResults(db, slot.id)).sort((a, b) => a.id - b.id),
					);
					for (const result of results)
						expect(snapshot.settlement(slot.id, result.id)).toEqual(await slotSettlement(db, slot.id, result.id));
					const admitted = await db.all(
						sql<
							{ slot: number },
							{ result: number; corrected: number; discounted_by: number | null; admitted: string }
						>("SELECT result,corrected,discounted_by,admitted FROM slot_results WHERE slot=$slot ORDER BY result"),
						{ slot: slot.id },
					);
					expect([...snapshot.admitted(slot.id)].sort((a, b) => a.result - b.result)).toEqual(
						admitted.map((row) => expect.objectContaining(row)),
					);
				}
				expect(await invalidInherited(db)).toEqual(snapshot.unsupported);
			});
		await report("fail");
		await compare();
		await report("pass", other);
		await compare();
		const dispute = (await h.call<InboxReply>("inbox", { kind: "failure" })).items.find(
			(item) => item.kind === "failure" && JSON.stringify(item.evidence).includes('"disputed"'),
		);
		if (!dispute) throw new Error("no dispute");
		await h.call("decide", { q: dispute.q, onEvidence: dispute.evidenceHash, answer: { is: "flaky" } }, judge);
		const settled = await h.app.database.read((db) =>
			db.all(sql<readonly [], { slot: number }>("SELECT slot FROM result_excuses WHERE slot IS NOT NULL")),
		);
		expect(settled.length).toBeGreaterThan(0);
		await compare();
		const signoff = (await h.call<InboxReply>("inbox", { kind: "signoff", state: "decided" })).items[0];
		if (!signoff) throw new Error("no sign-off");
		await h.call("decide", { undo: signoff.q });
		await report("fail", agent);
		await compare();
		await h.app.database.read(async (db) => {
			const latest = await db.one(sql<readonly [], { id: number }>("SELECT max(id) AS id FROM results"));
			const slot = settled[0]?.slot;
			if (slot === undefined) throw new Error("no settled slot");
			expect(await slotSettlement(db, slot, latest.id)).not.toBeNull();
		});
	} finally {
		await h.close();
	}
});
