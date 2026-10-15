import { aggregateSlot, type SlotFill } from "../src/core/runs.ts";
import type { Db } from "../src/server/kernel/db.ts";

/** A slot's recorded classification also covers later agent results of that cause and scope. */
export function slotSettlement(db: Db, slot: number, result: number) {
	return db.raw
		.query<{ class: string; decision: number }, [number, number]>(
			`SELECT e.class, e.decision FROM result_excuses e
   JOIN results named ON named.id = e.result JOIN results incoming ON incoming.id = ?
   JOIN decisions d ON d.id = e.decision JOIN questions q ON q.id = d.question
   JOIN slots s ON s.id = e.slot JOIN targets t ON t.id = incoming.target
   WHERE e.slot = ? AND (e.result = incoming.id OR (
    incoming.method = 'agent' AND named.signature = incoming.signature AND
    json_extract(q.subject, '$.scope') = CASE
     WHEN t.line = 'session' THEN 'run:' || s.run
     WHEN t.change IS NOT NULL THEN 'change:' || t.change
     WHEN t.repo IS NOT NULL AND t.repo != '' THEN 'line:' || t.line || '@' || t.repo
     ELSE 'line:' || t.line END
   )) ORDER BY e.decision DESC LIMIT 1`,
		)
		.get(result, slot);
}

export function failingSlotResults(db: Db, slot: number) {
	const rows = db.raw
		.query<
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
			},
			[number]
		>(
			`SELECT r.*, b.job FROM slot_results s JOIN results r ON r.id = s.result JOIN batches b ON b.id = r.batch
   WHERE s.slot = ? AND s.corrected = 0 AND s.discounted_by IS NULL`,
		)
		.all(slot);
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
export function invalidInherited(db: Db): unknown[] {
	return db.raw
		.query(`SELECT e.result, e.decision FROM result_excuses e JOIN decisions d ON d.id = e.decision
  JOIN questions q ON q.id = d.question JOIN results r ON r.id = e.result JOIN targets t ON t.id = r.target
  LEFT JOIN changes c ON c.id = t.change
  WHERE e.slot IS NULL AND json_extract(d.answer, '$.is') = 'inherited' AND (
   q.state != 'decided' OR q.decision != d.id OR r.method = 'agent' OR c.base_sha IS NULL OR
   NOT EXISTS (
    SELECT 1 FROM run_tests rt JOIN runs b ON b.id = rt.run
    JOIN targets bt ON bt.id = rt.target
    JOIN results br ON br.id = rt.result JOIN batches bb ON bb.id = br.batch
    JOIN batches rb ON rb.id = r.batch
    JOIN json_each(d.effects, '$.inherited') item ON json_extract(item.value, '$.result') = r.id
    JOIN json_each(item.value, '$.base') support ON support.value = rt.result
    WHERE b.project = r.project AND bt.commit_sha = c.base_sha AND bt.repo IS c.repo
      AND bt.env = t.env AND br.method = r.method AND bb.job = rb.job
      AND rt.test = r.test AND rt.signature = r.signature AND rt.outcome IN ('fail', 'error')
   )
  )`)
		.all();
}
