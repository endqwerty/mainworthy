import { aggregateSlot, type SlotFill } from "../src/core/runs.ts";
import type { ReadDb } from "../src/server/kernel/db.ts";
import { type SqlValue, sql } from "../src/server/kernel/db.ts";

export type AuditFill = {
	id: number;
	actor: number;
	method: SlotFill["method"];
	test: number;
	target: number;
	job: string;
	attempt: number;
	seq: number;
	ord: number;
	outcome: string;
	signature: number;
};

/** A slot's recorded classification also covers later agent results of that cause and scope. */
export async function slotSettlement(db: ReadDb, slot: number, result: number) {
	return await db.get(
		sql<readonly SqlValue[], { class: string; decision: number }>(`SELECT e.class, e.decision FROM result_excuses e
   JOIN results named ON named.id = e.result JOIN results incoming ON incoming.id = $1
   JOIN decisions d ON d.id = e.decision JOIN questions q ON q.id = d.question
   JOIN slots s ON s.id = e.slot JOIN targets t ON t.id = incoming.target
   WHERE e.slot = $2 AND (e.result = incoming.id OR (
    incoming.method = 'agent' AND named.signature = incoming.signature AND
    (q.subject::jsonb)->>'scope' = CASE
     WHEN t.line = 'session' THEN 'run:' || s.run
     WHEN t.change IS NOT NULL THEN 'change:' || t.change
     WHEN t.repo IS NOT NULL AND t.repo != '' THEN 'line:' || t.line || '@' || t.repo
     ELSE 'line:' || t.line END
   )) ORDER BY e.decision DESC LIMIT 1`),
		[result, slot],
	);
}

export async function failingSlotResults(db: ReadDb, slot: number) {
	const rows = await db.all(
		sql<
			readonly SqlValue[],
			{
				id: number;
				actor: number;
				method: SlotFill["method"];
				test: number;
				target: number;
				job: string;
				attempt: number;
				seq: number;
				ord: number;
				outcome: string;
				signature: number;
			}
		>(`SELECT r.*, b.job FROM slot_results s JOIN results r ON r.id = s.result JOIN batches b ON b.id = r.batch
   WHERE s.slot = $1 AND s.corrected = 0 AND s.discounted_by IS NULL`),
		[slot],
	);
	return failingAuditFills(rows);
}

export function failingAuditFills(rows: readonly AuditFill[]) {
	const failing = new Set(
		aggregateSlot(
			rows.map((row) => ({
				...row,
				lane: `${row.target}:${row.job}`,
				outcome:
					row.outcome === "pass"
						? "pass"
						: row.outcome === "fail" || row.outcome === "error"
							? "fail"
							: row.outcome === "skip"
								? "skip"
								: "blocked",
			})),
		).failing,
	);
	return rows.filter((row) => failing.has(row.id)).map((row) => ({ ...row, result: row.id }));
}

/** Independent audit of every inherited rule's support against the stored effective base lanes. */
export const inheritedAudit = sql<
	readonly [],
	Record<string, unknown>
>(`SELECT e.result, e.decision FROM result_excuses e JOIN decisions d ON d.id = e.decision
  JOIN questions q ON q.id = d.question JOIN results r ON r.id = e.result JOIN targets t ON t.id = r.target
  LEFT JOIN changes c ON c.id = t.change
  WHERE e.slot IS NULL AND (d.answer::jsonb)->>'is' = 'inherited' AND (
   q.state != 'decided' OR q.decision != d.id OR r.method = 'agent' OR c.base_sha IS NULL OR
   NOT EXISTS (
    SELECT 1 FROM run_tests rt JOIN runs b ON b.id = rt.run
    JOIN targets bt ON bt.id = rt.target
    JOIN results br ON br.id = rt.result JOIN batches bb ON bb.id = br.batch
    JOIN batches rb ON rb.id = r.batch
    JOIN jsonb_array_elements((d.effects::jsonb)->'inherited') item ON (item.value->>'result')::bigint = r.id
    JOIN jsonb_array_elements_text(item.value->'base') support ON support.value::bigint = rt.result
    WHERE b.project = r.project AND bt.commit_sha = c.base_sha AND bt.repo IS NOT DISTINCT FROM c.repo
      AND bt.env = t.env AND br.method = r.method AND bb.job = rb.job
      AND rt.test = r.test AND rt.signature = r.signature AND rt.outcome IN ('fail', 'error')
   )
  )`);
export async function invalidInherited(db: ReadDb): Promise<unknown[]> {
	return await db.all(inheritedAudit);
}
