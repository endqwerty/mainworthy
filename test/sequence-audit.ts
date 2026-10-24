import { json, type ReadDb, sql } from "../src/server/kernel/db.ts";
import { type AuditFill, failingAuditFills, inheritedAudit } from "./inherited-audit.ts";

type Row = Record<string, string | number | null>;
type Slot = Row & { id: number; run: number; state: string };
type Lane = Row & { run: number; test: number; result: number; target: number; signature: number; outcome: string };
type History = Row & {
	id: number;
	test: number;
	target: number;
	job: string;
	actor: number;
	audit_what: string;
	audit_project: number;
};
type AuditResult = History & {
	corrects: number | null;
	method: string;
	outcome: string;
	audit_batch_state: string;
	audit_batch_target: number;
	signature: number | null;
	audit_line: string;
	audit_change: number | null;
	audit_repo: string | null;
};
type Settlement = {
	slot: number;
	result: number;
	class: string;
	decision: number;
	signature: number | null;
	scope: string | null;
	run: number;
};

function group<K, T>(rows: readonly T[], key: (row: T) => K): Map<K, T[]> {
	const groups = new Map<K, T[]>();
	for (const row of rows) {
		const id = key(row);
		const held = groups.get(id) ?? [];
		held.push(row);
		groups.set(id, held);
	}
	return groups;
}

type Broad = {
	project: number;
	signature: number;
	scope: string;
	target: number;
	class: "attributed" | "excused";
	decision: number;
};
type Exact = { result: number; class: "attributed" | "excused"; decision: number };
const queries = {
	lanes: `SELECT * FROM run_tests`,
	slots: `SELECT * FROM slots`,
	results: `SELECT r.*,b.job,b.state AS audit_batch_state,b.target AS audit_batch_target,t.what AS audit_what,t.project AS audit_project,t.line AS audit_line,t.change AS audit_change,t.repo AS audit_repo
 FROM results r JOIN batches b ON b.id=r.batch JOIN targets t ON t.id=r.target ORDER BY r.seq,r.ord`,
	questions: `SELECT project,no,state FROM questions`,
	fills: `SELECT s.slot,r.*,b.job FROM slot_results s JOIN results r ON r.id=s.result JOIN batches b ON b.id=r.batch
 WHERE s.corrected=0 AND s.discounted_by IS NULL`,
	admitted: `SELECT slot,result,corrected,discounted_by,admitted FROM slot_results`,
	settlements: `SELECT e.slot,e.result,e.class,e.decision,named.signature,(q.subject::jsonb)->>'scope' AS scope,s.run
 FROM result_excuses e JOIN results named ON named.id=e.result JOIN decisions d ON d.id=e.decision JOIN questions q ON q.id=d.question JOIN slots s ON s.id=e.slot
 WHERE e.slot IS NOT NULL ORDER BY e.decision DESC`,
	runs: `SELECT * FROM runs`,
	changes: `SELECT * FROM changes`,
	targets: `SELECT * FROM targets`,
	open: `SELECT q.no,q.subject,q.evidence,string_agg(r.ref, ',' ORDER BY r.ref) AS refs FROM questions q
 LEFT JOIN question_refs r ON r.question=q.id WHERE q.state='open' AND q.kind='failure' GROUP BY q.id`,
	broad: `SELECT project,signature,scope,target,class,decision FROM excuses`,
	exact: `SELECT result,class,decision FROM result_excuses WHERE slot IS NULL`,
	versions: `SELECT case_id,no,body FROM versions`,
	signoffs: `SELECT d.id,((q.subject::jsonb)->>'run')::bigint AS run FROM decisions d JOIN questions q ON q.id=d.question
 WHERE q.kind='signoff' AND q.state='decided' AND q.decision=d.id AND (d.answer::jsonb)->>'is'='approve' `,
	counted: `SELECT DISTINCT t.what FROM batches b JOIN targets t ON t.id=b.target WHERE b.method != 'agent'`,
	expired: `SELECT run,decision,expires_at FROM depends_on WHERE expires_at IS NOT NULL AND expires_at <= $now`,
	standing: `SELECT old.id, old.answer, newer.id AS by FROM decisions newer JOIN decisions old ON old.id = newer.supersedes
			 JOIN questions q ON q.id = old.question WHERE q.state = 'decided' AND q.decision = old.id
			   AND (old.answer::jsonb)->>'is' NOT IN ('expired', 'outdated', 'withdrawn')`,
	orphans: `SELECT e.signature, e.scope, e.target, e.decision FROM excuses e
			 JOIN decisions d ON d.id = e.decision JOIN questions q ON q.id = d.question
			 WHERE q.state != 'decided' OR q.decision != d.id`,
	bare: `SELECT q.no, d.id, d.answer FROM questions q JOIN decisions d ON d.id = q.decision
			 WHERE q.kind = 'failure' AND q.state = 'decided' AND (d.effects::jsonb)->>'class' IS NOT NULL
			   AND NOT EXISTS (SELECT 1 FROM excuses e WHERE e.decision = d.id)
     AND NOT EXISTS (SELECT 1 FROM result_excuses e WHERE e.decision = d.id)`,
	stale: `SELECT dep.run, dep.decision FROM depends_on dep JOIN decisions d ON d.id = dep.decision JOIN questions q ON q.id = d.question
		 WHERE q.state != 'decided' OR q.decision != d.id`,
	orphaned: `SELECT s.* FROM slot_results s
			LEFT JOIN slots slot ON slot.id = s.slot LEFT JOIN results r ON r.id = s.result
			WHERE slot.id IS NULL OR r.id IS NULL OR r.basis_case != slot.case_id`,
	acceptedFills: `SELECT sr.*, s.case_id, r.basis_case, t.commit_sha, t.repo, t.env, t.project AS target_project, run.project AS run_project, run.accepts, run.id AS run_id,
			b.run AS typed FROM slot_results sr JOIN slots s ON s.id = sr.slot
			JOIN runs run ON run.id = s.run JOIN results r ON r.id = sr.result
			JOIN targets t ON t.id = r.target JOIN batches b ON b.id = r.batch WHERE run.state = 'open'`,
	unsupported: inheritedAudit.text,
};
const snapshot = sql<{ now: number }, { [K in keyof typeof queries]: string }>(
	`SELECT ${Object.entries(queries)
		.map(
			([name, query]) =>
				`coalesce((SELECT json_agg(record${name === "results" ? " ORDER BY record.seq,record.ord" : name === "settlements" ? " ORDER BY record.decision DESC" : ""}) FROM (${query}) record),'[]')::text AS "${name}"`,
		)
		.join(",")}`,
);

/** Independent stored-row relations for one audit. Each relation crosses the connection once, in one statement. */
export async function auditRelations(db: ReadDb, now: number) {
	const data = await db.one(snapshot, { now });
	const lanes = group(json<Lane[]>(data.lanes), (row) => row.run);
	const slots = group(json<Slot[]>(data.slots), (row) => row.run);
	const results = json<AuditResult[]>(data.results);
	const corrected = new Set(results.flatMap((row) => (row.corrects === null ? [] : [row.corrects])));
	const jobs = new Map<number, { job: string; target: number }>();
	for (const row of results)
		if (
			row.audit_batch_state === "processed" &&
			row.method === "auto" &&
			["pass", "fail", "error"].includes(row.outcome) &&
			!corrected.has(row.id)
		)
			jobs.set(Number(row.batch), { job: row.job, target: row.audit_batch_target });
	const questions = new Map(
		json<{ project: number; no: number; state: string }[]>(data.questions).map((row) => [
			`${row.project}:${row.no}`,
			row.state,
		]),
	);
	const fills = new Map<number, AuditFill[]>();
	for (const { slot, ...fill } of json<(AuditFill & { slot: number })[]>(data.fills)) {
		const held = fills.get(slot) ?? [];
		held.push(fill);
		fills.set(slot, held);
	}
	const failures = new Map<number, ReturnType<typeof failingAuditFills>>();
	const admitted = group(
		json<{ slot: number; result: number; corrected: number; discounted_by: number | null; admitted: string }[]>(
			data.admitted,
		),
		(row) => row.slot,
	);
	const discounted = new Set(
		[...admitted.values()]
			.flat()
			.filter((row) => row.discounted_by !== null)
			.map((row) => row.result),
	);
	const history = group(
		results.filter((row) => row.method !== "agent" && !corrected.has(row.id) && !discounted.has(row.id)),
		(row) => JSON.stringify([row.audit_project, row.audit_what]),
	);
	const settlements = group(json<Settlement[]>(data.settlements), (row) => row.slot);
	const exact = new Set([...settlements.values()].flat().map((row) => `${row.slot}:${row.result}`));
	const incoming = new Map(
		results.map((row) => [
			row.id,
			{
				id: row.id,
				signature: row.signature,
				method: row.method,
				line: row.audit_line,
				change: row.audit_change,
				repo: row.audit_repo,
			},
		]),
	);
	const signoffs = new Set(json<{ id: number; run: number }[]>(data.signoffs).map((row) => `${row.run}:${row.id}`));
	return {
		results,
		corrected,
		jobs: [...jobs.values()],
		runs: json<Row[]>(data.runs),
		changes: json<Row[]>(data.changes),
		targets: json<(Row & { id: number })[]>(data.targets),
		open: json<{ no: number; subject: string; evidence: string; refs: string | null }[]>(data.open),
		excuses: { broad: json<Broad[]>(data.broad), exact: json<Exact[]>(data.exact) },
		versions: json<{ case_id: number; no: number; body: string }[]>(data.versions),
		counted: json<{ what: string }[]>(data.counted),
		acceptedFills: json<Row[]>(data.acceptedFills),
		standing: json<Row[]>(data.standing),
		orphans: json<Row[]>(data.orphans),
		bare: json<Row[]>(data.bare),
		stale: json<Row[]>(data.stale),
		expired: json<Row[]>(data.expired),
		orphaned: json<Row[]>(data.orphaned),
		unsupported: json<Row[]>(data.unsupported),
		approves: (run: number, decision: number) => signoffs.has(`${run}:${decision}`),
		lanes: (run: number) => lanes.get(run) ?? [],
		slots: (run: number) => slots.get(run) ?? [],
		history: (project: number, what: string) => history.get(JSON.stringify([project, what])) ?? [],
		question: (project: number, no: number) => questions.get(`${project}:${no}`),
		admitted: (slot: number) => admitted.get(slot) ?? [],
		exact: (slot: number, result: number) => exact.has(`${slot}:${result}`),
		failing: (slot: number) => {
			let held = failures.get(slot);
			if (!held) {
				held = failingAuditFills(fills.get(slot) ?? []);
				failures.set(slot, held);
			}
			return held;
		},
		settlement: (slot: number, result: number) => {
			const observed = incoming.get(result);
			if (!observed) return null;
			const match = settlements.get(slot)?.find((row) => {
				if (row.result === result) return true;
				if (observed.method !== "agent" || observed.signature === null || observed.signature !== row.signature)
					return false;
				const scope =
					observed.line === "session"
						? `run:${row.run}`
						: observed.change !== null
							? `change:${observed.change}`
							: observed.repo
								? `line:${observed.line}@${observed.repo}`
								: `line:${observed.line}`;
				return scope === row.scope;
			});
			return match ? { class: match.class, decision: match.decision } : null;
		},
	};
}
