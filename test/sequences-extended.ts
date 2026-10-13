// Extended random sequences for the Casebook engine, written by an independent defect hunt (Claude Fable 5.1) and
// kept as a test. Everything `test/sequences.ts` does, plus:
// several tests per case and several causes; planned runs with `jobs` obligations and `minActors: 2`; runs closed by
// sign-off and reopened by withdrawing it; the policy switched mid-way; corrections of corrections; the same report
// sent twice; reports accepted and applied later by recovery; an actor forgotten; cases edited so slots pin older
// versions; findings and adopt questions interleaved; and now and then a large report.
//
// Audits (after every command), written against the rows and not the engine's helpers:
// 1-8 as in `test/sequences.ts`.
// 9.  A closed run's sign-off is a decision in force on a signoff question about that run; an open run has none.
// 10. No run is left `outstanding` once every accepted batch is applied.
// 11. Every row of `slot_results` is a result the slot's run may count: on a target the run accepts (or typed into a
//     `self` run), for the slot's case at its pinned version (or the same claim where the obligation allows it),
//     by a method the obligation names and the pinned version admits (a test is admitted by its link).
// 12. Every uncorrected result that audit 11 would admit to a slot of an open run planned before or after it was
//     reported is admitted, and so is one that arrived while the run was closed, once the run is reopened.
// 13. A planned run's `missing` count includes each required job that no pipeline's report which ran something
//     has met on a target the run accepts.
// 14. No run depends on a decision that is not in force, and after a sweep none depends on an expired one.
// 15. No result of an agent is ever counted in a commit's gate.
// Added by the second hunt (Claude Fable 5.1):
// 13'. A required job is met only by a batch holding a decisive result whose own method is `auto` (a pipeline's,
//      or a results file a person passed on): a person's typed pass sent under the job's name is not the job.
// 16. A commit's line, branch and change are those of the first report a gate counts (a pipeline's or a person's),
//     not of an earlier report by an agent. Checked against what the generator sent.
// New actions: a person's typed result into a run sometimes carries a job name and a skipped automated key; an
// agent sometimes reports a commit nobody has reported yet, as trunk or as the change, before the pipeline does.
//
// The tests are in `sequences-extended-loose.test.ts`, `-standard` and `-strict`. This file registers none, so a
// defect hunt can import `sequence` and `stats` from it.
// More seeds: CASEBOOK_SEQUENCE_SEEDS=500 bun test test/sequences-extended-
import { expect, test } from "bun:test";
import { recoverAccepted, sweep } from "../src/server/jobs.ts";
import { type Actor, findProject, makeCtx, stampSeq } from "../src/server/kernel/ctx.ts";
import { acceptReport } from "../src/server/ops/writes.ts";
import { harness } from "./helpers.ts";

const SEEDS = Number(process.env.CASEBOOK_SEQUENCE_SEEDS ?? 40);
const STEPS = Number(process.env.CASEBOOK_SEQUENCE_STEPS ?? 100);
const FIRST = Number(process.env.CASEBOOK_SEQUENCE_FIRST ?? 1);

type Row = Record<string, string | number | null>;
type Problem = { seed: number; step: number; what: string; detail: unknown; last: unknown[] };

const LANE_WEIGHT: Record<string, number> = { fail: 3, error: 3, pass: 2, blocked: 1, skip: 0 };
const decisive = (o: string) => o === "pass" || o === "fail" || o === "error";
// The lane rule, restated here so the audit does not call the function it checks.
const replaces = (held: { attempt: number; outcome: string }, next: { attempt: number; outcome: string }): boolean =>
	next.attempt > held.attempt
		? decisive(next.outcome) || !decisive(held.outcome)
		: next.attempt === held.attempt && (LANE_WEIGHT[next.outcome] ?? 0) >= (LANE_WEIGHT[held.outcome] ?? 0);

/** How the commands of every sequence ended, per operation: a check that the random actions are effective. */
export const stats = new Map<string, number>();

export function sequence(seed: number, preset: string): Problem | null {
	let state = seed * 2654435761 + 1;
	const rand = (n: number): number => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return (state >>> 0) % n;
	};
	const pick = <T>(items: readonly T[]): T => items[rand(items.length)] as T;
	const h = harness({ preset });
	const rows = <T = Row>(sql: string, ...args: (string | number | null)[]): T[] =>
		h.app.db.raw.query(sql).all(...args) as T[];
	const trace: unknown[] = [];
	let people: Actor[] = [h.owner, h.actor("second", "human", ["read", "produce", "answer", "plan"])];
	const pipeline = h.actor("pipeline", "ci", ["read", "record"]);
	let agents: Actor[] = [h.actor("explorer", "agent", ["read", "produce"])];
	const rule = Number(rows<{ id: number }>("SELECT id FROM actors WHERE kind = 'rule'")[0]?.id ?? 0);
	const project = Number(rows<{ id: number }>("SELECT id FROM projects WHERE key = 'scratch'")[0]?.id ?? 0);
	let lastReport: { input: unknown; as: Actor } | null = null;
	const sentLast = (): { input: unknown; as: Actor } | null => lastReport;
	let forgotten = false;
	// 16. Where each commit was first placed by a report a gate counts: `trunk`, `pr:N`, or `typed` (a result typed
	// into a run, which says nothing about where the commit is). Keyed by repository and commit.
	type Placement = { kind: "trunk" | "pr" | "typed"; pr?: number | undefined; branch?: string | undefined };
	const placed = new Map<string, Placement>();
	const placeOf = (as: Actor, input: unknown): void => {
		const sent = input as { target?: { commit?: string; repo?: string; branch?: string; pr?: number }; run?: string };
		// What an agent says about where a commit is holds only until a pipeline or a person reports it.
		if (as.kind === "agent") return;
		if (sent.target?.commit) {
			const key = `${sent.target.repo ?? ""}@${sent.target.commit}`;
			if (placed.has(key)) return;
			const trunk = sent.target.pr === undefined && ["main", "master", "trunk"].includes(sent.target.branch ?? "");
			placed.set(
				key,
				trunk
					? { kind: "trunk", branch: sent.target.branch }
					: sent.target.pr !== undefined
						? { kind: "pr", pr: sent.target.pr, branch: sent.target.branch }
						: { kind: "typed" },
			);
		} else if (sent.run) {
			const run = rows<{ accepts: string }>(
				"SELECT accepts FROM runs WHERE no = ?",
				Number(sent.run.replace(/^R-/, "")),
			)[0];
			const accepts = run ? (JSON.parse(run.accepts) as { commit?: string; repo?: string }) : {};
			if (accepts.commit) {
				const key = `${accepts.repo ?? ""}@${accepts.commit}`;
				if (!placed.has(key)) placed.set(key, { kind: "typed" });
			}
		}
	};
	const command = (op: string, input: unknown, as: Actor = h.owner): unknown => {
		const reply = h.raw(op, input, as);
		trace.push({ op, input, as: as.name, reply: reply.ok ? "ok" : reply.error });
		const key = `${op}: ${reply.ok ? "ok" : `${reply.error.code} ${reply.error.message.slice(0, 70)}`}`;
		stats.set(key, (stats.get(key) ?? 0) + 1);
		if (op === "report" && reply.ok) lastReport = { input, as };
		if (op === "report" && reply.ok) placeOf(as, input);
		return reply.ok ? reply.result : null;
	};
	const answerOpen = (kind: string, as: Actor = h.owner, answer: Record<string, unknown> = { is: "accept" }) => {
		for (const waiting of rows<{ no: number; evidence_hash: string }>(
			"SELECT no, evidence_hash FROM questions WHERE kind = ? AND state = 'open'",
			kind,
		))
			command("decide", { q: `Q-${waiting.no}`, onEvidence: waiting.evidence_hash, answer, reason: "seed" }, as);
	};

	const scopeOf = (target: Row, run: number): string =>
		target.line === "session"
			? `run:${run}`
			: target.change !== null
				? `change:${target.change}`
				: target.repo
					? `line:${target.line}@${target.repo}`
					: `line:${target.line}`;

	const audit = (): { what: string; detail: unknown } | null => {
		const runs = rows("SELECT * FROM runs");
		const targets = new Map(rows("SELECT * FROM targets").map((target) => [Number(target.id), target]));
		const open = rows(
			`SELECT q.no, q.subject, q.evidence, group_concat(r.ref) AS refs FROM questions q
			 LEFT JOIN question_refs r ON r.question = q.id WHERE q.state = 'open' AND q.kind = 'failure' GROUP BY q.id`,
		);
		const excuseOf = (signature: number, scope: string, target: number) =>
			rows(
				"SELECT class, decision FROM excuses WHERE project = ? AND signature = ? AND scope = ? AND target IN (0, ?) ORDER BY (target != 0) DESC, decision DESC LIMIT 1",
				project,
				signature,
				scope,
				target,
			)[0];
		const verdictOf = (tally: Record<string, number>, blocking: number, outstanding: number): string => {
			if (outstanding > 0) return "pending";
			if ((tally.attributed ?? 0) > 0) return "failed";
			if ((tally.unexplained ?? 0) > 0 || (tally.disputed ?? 0) > 0 || blocking > 0) return "blocked";
			if ((tally.missing ?? 0) > 0 || (tally.pass ?? 0) + (tally.excused ?? 0) === 0) return "pending";
			return "passed";
		};

		for (const run of runs) {
			const id = Number(run.id);
			const newest =
				run.scope === null
					? null
					: Math.max(...runs.filter((other) => other.scope === run.scope).map((o) => Number(o.id)));
			const live = run.origin === "planned" ? run.state === "open" : id === newest;
			if (live) {
				const causes =
					run.origin === "change"
						? rows<{ signature: number; target: number }>(
								"SELECT DISTINCT signature, target FROM run_tests WHERE run = ? AND outcome IN ('fail', 'error')",
								id,
							)
						: rows<{ causes: string }>("SELECT causes FROM slots WHERE run = ?", id).flatMap((slot) =>
								(JSON.parse(slot.causes) as [number, number][]).map(([signature, target]) => ({ signature, target })),
							);
				for (const cause of causes) {
					const target = targets.get(cause.target);
					if (!target) return { what: "a cause on an unknown target", detail: cause };
					const scope = scopeOf(target, id);
					if (excuseOf(cause.signature, scope, cause.target)) continue;
					const asked = open.filter((question) => {
						const subject = JSON.parse(String(question.subject)) as { signature: number; scope: string };
						const evidence = JSON.parse(String(question.evidence)) as { targets?: number[] };
						return (
							subject.signature === cause.signature &&
							subject.scope === scope &&
							(evidence.targets ?? []).includes(cause.target) &&
							String(question.refs ?? "")
								.split(",")
								.includes(`R-${run.no}`)
						);
					});
					if (asked.length === 0)
						return { what: "1: a live run shows an unexplained failure nobody is asked about", detail: { run, cause } };
					const blocking = JSON.parse(String(run.blocking)) as string[];
					if (!asked.some((question) => blocking.includes(`Q-${question.no}`)))
						return { what: "1: a run's gate does not name the question about its failure", detail: { run, cause } };
				}
			}

			if (run.origin === "change") {
				const current = rows("SELECT * FROM run_tests WHERE run = ?", id);
				const history = rows<{ id: number; test: number; target: number; job: string; actor: number } & Row>(
					`SELECT r.*, b.job FROM results r JOIN batches b ON b.id = r.batch JOIN targets t ON t.id = r.target
					 WHERE t.what = ? AND t.project = ? AND r.method != 'agent'
					   AND NOT EXISTS (SELECT 1 FROM results newer WHERE newer.corrects = r.id)
					   AND NOT EXISTS (SELECT 1 FROM slot_results s WHERE s.result = r.id AND s.discounted_by IS NOT NULL)
					 ORDER BY r.seq, r.ord`,
					String(run.accepts_what),
					project,
				);
				const held = new Map<string, (typeof history)[number]>();
				for (const next of history) {
					const key = `${next.test}|${next.target}:${next.job}:${next.actor}`;
					const before = held.get(key);
					if (
						!before ||
						replaces(
							{ attempt: Number(before.attempt), outcome: String(before.outcome) },
							{ attempt: Number(next.attempt), outcome: String(next.outcome) },
						)
					)
						held.set(key, next);
				}
				const actual = current.map((row) => `${row.test}|${row.lane}=${row.result}`).sort();
				const expected = [...held].map(([key, row]) => `${key}=${row.id}`).sort();
				if (JSON.stringify(actual) !== JSON.stringify(expected))
					return {
						what: "2: a commit's gate counts something other than its lanes' history",
						detail: { run, actual, expected },
					};
				// 15. No agent result in a commit's gate.
				const agentCounted = rows(
					"SELECT rt.result FROM run_tests rt JOIN results r ON r.id = rt.result WHERE rt.run = ? AND r.method = 'agent'",
					id,
				);
				if (agentCounted.length > 0)
					return { what: "15: an agent's result is counted in a commit's gate", detail: agentCounted };

				const tally = { pass: 0, excused: 0, attributed: 0, unexplained: 0, missing: 0, disputed: 0, skipped: 0 };
				for (const row of current) {
					if (row.outcome === "pass") tally.pass++;
					else if (row.outcome === "skip") tally.skipped++;
					else if (row.outcome === "blocked") tally.missing++;
					else {
						const seenOn = targets.get(Number(row.target));
						if (!seenOn) return { what: "a result on an unknown target", detail: row };
						const excuse = excuseOf(Number(row.signature), scopeOf(seenOn, id), Number(row.target));
						tally[excuse ? (excuse.class === "attributed" ? "attributed" : "excused") : "unexplained"]++;
					}
				}
				const stored = JSON.parse(String(run.tally)) as Record<string, number>;
				for (const key of Object.keys(tally) as (keyof typeof tally)[])
					if (tally[key] !== stored[key])
						return { what: "3: a run's stored tally is not what its results give", detail: { run, tally, stored } };
			}

			const facts = JSON.parse(String(run.tally)) as Record<string, number>;
			if (
				verdictOf(facts, (JSON.parse(String(run.blocking)) as string[]).length, Number(run.outstanding)) !== run.verdict
			)
				return { what: "5: a run's stored verdict is not the verdict of its tally", detail: { run } };

			// 9. Closed runs and their sign-off.
			if (run.state === "closed") {
				const signoff = rows(
					`SELECT d.id FROM decisions d JOIN questions q ON q.id = d.question
					 WHERE d.id = ? AND q.kind = 'signoff' AND q.state = 'decided' AND q.decision = d.id
					   AND json_extract(d.answer, '$.is') = 'approve' AND json_extract(q.subject, '$.run') = ?`,
					Number(run.signoff ?? -1),
					id,
				);
				if (signoff.length === 0) return { what: "9: a closed run has no sign-off decision in force", detail: run };
			} else if (run.signoff !== null) return { what: "9: an open run still cites a sign-off", detail: run };
			// 10. Nothing outstanding once everything accepted is applied.
			if (Number(run.outstanding) !== 0)
				return { what: "10: a run is outstanding with nothing left to apply", detail: run };
		}

		// 6, 11, 12, 13. Slots of open planned runs.
		const results = rows<{ id: number } & Row>(`SELECT r.*, b.job FROM results r JOIN batches b ON b.id = r.batch`);
		const corrected = new Set(
			rows<{ c: number }>("SELECT corrects AS c FROM results WHERE corrects IS NOT NULL").map((r) => r.c),
		);
		const versions = new Map<string, string[]>();
		const methodsAt = (caseId: number, version: number): string[] => {
			const key = `${caseId}@${version}`;
			let found = versions.get(key);
			if (!found) {
				const body = rows<{ body: string }>(
					"SELECT body FROM versions WHERE case_id = ? AND no = ?",
					caseId,
					version,
				)[0];
				found = body ? ((JSON.parse(body.body) as { methods: string[] }).methods ?? []) : [];
				versions.set(key, found);
			}
			return found;
		};
		for (const run of runs.filter((r) => r.origin === "planned" && r.state === "open")) {
			const id = Number(run.id);
			const accepts = JSON.parse(String(run.accepts)) as { commit?: string; repo?: string; env?: string; self?: true };
			const obligations = JSON.parse(String(run.require)) as {
				id: string;
				kind: string;
				methods?: string[];
				minActors?: number;
				basis?: string;
				jobs?: string[];
			}[];
			const accepted = (target: Row, typedInto: number | null): boolean => {
				if (accepts.self) return typedInto === id;
				if (target.commit_sha === null) return false;
				return (
					String(target.commit_sha) === accepts.commit &&
					(accepts.repo === undefined || accepts.repo === target.repo) &&
					(accepts.env === undefined || accepts.env === target.env)
				);
			};
			const admits = (slot: Row, result: Row): string | null => {
				const obligation = obligations.find((o) => o.id === slot.obligation);
				if (obligation?.kind !== "exercise") return null;
				if (result.basis === "unresolved" || Number(result.basis_case) !== Number(slot.case_id)) return null;
				const method = String(result.method);
				if (!obligation.methods?.includes(method)) return null;
				const declared = methodsAt(Number(slot.case_id), Number(slot.version));
				if (method !== "auto" && !declared.includes(method)) return null;
				if (Number(result.basis_version) === Number(slot.version)) {
					if (result.basis === "exact") return "exact";
					return obligation.basis === "exact" ? null : "assumed";
				}
				if (obligation.basis === "same-claim" && result.basis_claim === slot.claim) return "same-claim";
				return null;
			};
			const tally = { pass: 0, excused: 0, attributed: 0, unexplained: 0, missing: 0, disputed: 0, skipped: 0 };
			for (const slot of rows("SELECT * FROM slots WHERE run = ?", id)) {
				const rowsIn = rows<{ result: number; corrected: number; discounted_by: number | null; admitted: string }>(
					"SELECT result, corrected, discounted_by, admitted FROM slot_results WHERE slot = ?",
					Number(slot.id),
				);
				// 11. Soundness of every admission.
				for (const held of rowsIn) {
					const result = results.find((r) => r.id === held.result);
					if (!result) return { what: "11: a slot holds a result that does not exist", detail: { slot, held } };
					const target = targets.get(Number(result.target));
					if (!target || !accepted(target, result.run === null ? null : Number(result.run)))
						return {
							what: "11: a slot holds a result on a target its run does not accept",
							detail: { run, slot, result },
						};
					const how = admits(slot, result);
					if (how === null || how !== held.admitted)
						return {
							what: "11: a slot holds a result the acceptance rule does not admit",
							detail: { run, slot, result, held, how },
						};
					if (held.corrected === 0 && corrected.has(held.result))
						return { what: "11: a slot counts a result its producer has corrected", detail: { run, slot, held } };
				}
				// 12. Completeness: what should be in the slot is.
				const admittedIds = new Set(rowsIn.map((r) => r.result));
				for (const result of results) {
					if (Number(result.basis_case) !== Number(slot.case_id) || corrected.has(result.id)) continue;
					const target = targets.get(Number(result.target));
					if (!target || !accepted(target, result.run === null ? null : Number(result.run))) continue;
					if (admits(slot, result) === null) continue;
					if (!admittedIds.has(result.id)) {
						const signoffs = rows(
							`SELECT q.no, d.id, d.answer, d.seq FROM questions q JOIN decisions d ON d.question = q.id
							 WHERE q.kind = 'signoff' AND json_extract(q.subject, '$.run') = ? ORDER BY d.id`,
							id,
						);
						return {
							what: "12: a result the run may count is not admitted to its slot",
							detail: { run, slot, result, signoffs },
						};
					}
				}
				// 6. The slot's state from the admitted, uncorrected, undiscounted fills.
				const fills = rowsIn
					.filter((r) => r.corrected === 0 && r.discounted_by === null)
					.map((r) => results.find((x) => x.id === r.result))
					.filter((r): r is NonNullable<typeof r> => r !== undefined)
					.sort((a, b) => Number(a.seq) - Number(b.seq) || Number(a.ord) - Number(b.ord));
				const latest = new Map<string, (typeof fills)[number]>();
				for (const fill of fills) {
					const key = `${fill.actor}:${fill.method}:${fill.test}:${fill.target}:${fill.job}`;
					const before = latest.get(key);
					if (
						!before ||
						replaces(
							{ attempt: Number(before.attempt), outcome: String(before.outcome) },
							{ attempt: Number(fill.attempt), outcome: String(fill.outcome) },
						)
					)
						latest.set(key, fill);
				}
				const weight: Record<string, number> = { fail: 3, error: 3, pass: 2, blocked: 1, skip: 0 };
				const perProducer = new Map<string, { actor: number; outcome: string }>();
				for (const fill of latest.values()) {
					const key = `${fill.actor}:${fill.method}`;
					const before = perProducer.get(key);
					const outcome = fill.outcome === "error" ? "fail" : String(fill.outcome);
					if (before && (weight[before.outcome] ?? 0) >= (weight[outcome] ?? 0)) continue;
					perProducer.set(key, { actor: Number(fill.actor), outcome });
				}
				const passed = new Set<number>();
				let fails = 0;
				let skips = 0;
				for (const entry of perProducer.values()) {
					if (entry.outcome === "pass") passed.add(entry.actor);
					else if (entry.outcome === "fail") fails++;
					else skips++;
				}
				const minActors = obligations.find((o) => o.id === slot.obligation)?.minActors ?? 1;
				const expected =
					fails > 0
						? passed.size > 0
							? "disputed"
							: "failing"
						: passed.size >= minActors
							? "satisfied"
							: passed.size === 0 && skips > 0
								? "skipped"
								: "missing";
				if (expected !== String(slot.state))
					return {
						what: "6: a slot's state is not what its admitted results give",
						detail: { run, slot, expected, fills },
					};

				// 6b. The tally.
				const stateNow: string = `${slot.state}`;
				if (stateNow === "satisfied" || stateNow === "waived") tally.pass++;
				else if (stateNow === "missing") tally.missing++;
				else if (stateNow === "skipped") {
					tally.skipped++;
					tally.missing++;
				} else {
					const causes = JSON.parse(String(slot.causes)) as [number, number][];
					const excuses = causes.map(([signature, target]) => {
						const seenOn = targets.get(target);
						return seenOn ? excuseOf(signature, scopeOf(seenOn, id), target) : undefined;
					});
					const unanswered = excuses.filter((excuse) => !excuse).length;
					if (excuses.some((excuse) => excuse?.class === "attributed")) tally.attributed++;
					else if (unanswered > 0 || causes.length === 0) tally[stateNow === "disputed" ? "disputed" : "unexplained"]++;
					else if (stateNow === "disputed") tally.pass++;
					else tally.excused++;
				}
			}
			// 13'. Jobs: a batch meets a job only by a decisive result that is itself automated.
			const jobs = obligations.flatMap((o) => (o.kind === "jobs" ? (o.jobs ?? []) : []));
			if (jobs.length > 0) {
				const reported = new Set<string>();
				for (const batch of rows<{ job: string; target: number }>(
					`SELECT job, target FROM batches b WHERE state = 'processed'
					 AND EXISTS (SELECT 1 FROM results r WHERE r.batch = b.id AND r.method = 'auto'
					             AND r.outcome IN ('pass', 'fail', 'error'))`,
				)) {
					const target = targets.get(batch.target);
					if (target && accepted(target, null)) reported.add(batch.job);
				}
				tally.missing += jobs.filter((job) => !reported.has(job)).length;
			}
			const stored = JSON.parse(String(run.tally)) as Record<string, number>;
			for (const key of Object.keys(tally) as (keyof typeof tally)[])
				if (tally[key] !== stored[key])
					return {
						what: "6b/13: a planned run's stored tally is not what its slots give",
						detail: { run, tally, stored },
					};
		}

		// 7. Nobody is asked about what already has an answer.
		for (const question of open) {
			const subject = JSON.parse(String(question.subject)) as { signature: number; scope: string };
			const evidence = JSON.parse(String(question.evidence)) as { targets?: number[] };
			const listed = evidence.targets ?? [];
			if (listed.length > 0 && listed.every((target) => excuseOf(subject.signature, subject.scope, target)))
				return {
					what: "7: a question is open about a failure that has an answer everywhere it was seen",
					detail: question,
				};
		}

		// 8. A superseded decision is not in force.
		const standing = rows(
			`SELECT old.id, old.answer, newer.id AS by FROM decisions newer JOIN decisions old ON old.id = newer.supersedes
			 JOIN questions q ON q.id = old.question WHERE q.state = 'decided' AND q.decision = old.id
			   AND json_extract(old.answer, '$.is') NOT IN ('expired', 'outdated', 'withdrawn')`,
		);
		if (standing.length > 0)
			return { what: "8: a superseded decision is still its question's answer", detail: standing };

		// 4. Excuses and the decisions they belong to.
		const orphans = rows(
			`SELECT e.signature, e.scope, e.target, e.decision FROM excuses e
			 JOIN decisions d ON d.id = e.decision JOIN questions q ON q.id = d.question
			 WHERE q.state != 'decided' OR q.decision != d.id`,
		);
		if (orphans.length > 0) return { what: "4: an excuse outlived its decision", detail: orphans };
		const bare = rows(
			`SELECT q.no, d.id, d.answer FROM questions q JOIN decisions d ON d.id = q.decision
			 WHERE q.kind = 'failure' AND q.state = 'decided' AND json_extract(d.effects, '$.class') IS NOT NULL
			   AND NOT EXISTS (SELECT 1 FROM excuses e WHERE e.decision = d.id)`,
		);
		if (bare.length > 0) return { what: "4: an answer is in force with nothing to show for it", detail: bare };

		// 14. Dependencies name decisions in force; none expired after a sweep.
		const stale = rows(
			`SELECT dep.run, dep.decision FROM depends_on dep JOIN decisions d ON d.id = dep.decision JOIN questions q ON q.id = d.question
			 WHERE q.state != 'decided' OR q.decision != d.id`,
		);
		if (stale.length > 0) return { what: "14: a run depends on a decision that is not in force", detail: stale };
		const expired = rows(
			"SELECT run, decision, expires_at FROM depends_on WHERE expires_at IS NOT NULL AND expires_at <= ?",
			Number(h.app.now()),
		);
		if (expired.length > 0) return { what: "14: a run rests on an expired decision after the sweep", detail: expired };

		// 16. A commit's place is the first counted report's.
		const changes = new Map(rows("SELECT * FROM changes").map((change) => [Number(change.id), change]));
		for (const target of targets.values()) {
			if (target.commit_sha === null) continue;
			const expected = placed.get(`${target.repo ?? ""}@${target.commit_sha}`);
			if (!expected || expected.kind === "typed") continue;
			const change = target.change !== null ? changes.get(Number(target.change)) : null;
			const wrong =
				expected.kind === "trunk"
					? target.line !== "trunk" || target.change !== null
					: target.line !== "change" || !change || !String(change.key).endsWith(`pr:${expected.pr}`);
			if (wrong)
				return {
					what: "16: a commit is placed where something other than the first counted report put it",
					detail: { target, expected, change },
				};
		}
		return null;
	};

	try {
		command("propose", {
			edits: [
				{ op: "create", body: { title: "One", methods: ["human", "agent"] } },
				{ op: "create", body: { title: "Two", methods: ["human"] } },
				{ op: "create", outline: "Spare" },
			],
		});
		answerOpen("adopt");
		const commits = ["random01", "random02", "random03"];
		const changeCommits = ["change01", "change02"];
		const causes = ["cause a", "cause b", "cause c"];
		const cause = () => ({ failure: { message: pick(causes) } });
		const autoResult = (index: number) => {
			const outcome = pick(["fail", "fail", "pass", "skip", "blocked"] as const);
			return {
				test: { key: `test-${index}` },
				annotation: { case: `C-${(index % 2) + 1}`, version: 1 },
				outcome,
				...(outcome === "fail" ? cause() : {}),
			};
		};
		const correctionFor = (as: Actor, key: string, commit: string, env: string, run: number | null) => {
			const earlier = rows<{ id: number }>(
				`SELECT r.id FROM results r JOIN tests t ON t.id = r.test JOIN targets x ON x.id = r.target
				 WHERE r.actor = ? AND t.key = ? AND x.commit_sha = ? AND x.env = ? AND r.run IS ?`,
				as.id,
				key,
				commit,
				env,
				run,
			);
			return earlier.length > 0 ? pick(earlier).id : null;
		};
		for (let step = 0; step < STEPS; step++) {
			const action = rand(100);
			if (action < 30) {
				// A pipeline or a person reports one to three automated tests on trunk, sometimes correcting, sometimes a fork.
				const as = pick([pipeline, ...people]);
				const target = {
					commit: pick(commits),
					branch: "main",
					env: pick(["prod", "staging"]),
					...(rand(8) === 0 ? { repo: "fork" } : {}),
					...(rand(12) === 0 ? { branch: "release", pr: 9 } : {}),
				};
				const n = 1 + rand(3);
				const results = Array.from({ length: n }, () => autoResult(rand(4)));
				if (rand(5) === 0) {
					const first = results[0] as { test: { key: string }; corrects?: number };
					const id = correctionFor(as, first.test.key, target.commit, target.env, null);
					if (id !== null) first.corrects = id;
				}
				command("report", { target, job: pick(["a", "b"]), attempt: 1 + rand(4), results }, as);
			} else if (action < 36) {
				// A change with a base on trunk.
				const results = Array.from({ length: 1 + rand(2) }, () => autoResult(rand(4)));
				command(
					"report",
					{
						target: {
							commit: pick(changeCommits),
							base: pick(commits),
							pr: 7,
							branch: "feature",
							env: pick(["prod", "staging"]),
						},
						job: pick(["a", "b"]),
						attempt: 1 + rand(3),
						results,
					},
					pipeline,
				);
			} else if (action < 41 && agents.length > 0) {
				// An agent reports on trunk or on the change, by key or by case; sometimes it names a trunk commit as the
				// change or a change commit as trunk, before or after the pipeline has reported it.
				const target = pick([
					{ commit: pick(commits), branch: "main", env: "prod" },
					{ commit: pick(changeCommits), base: pick(commits), pr: 7, branch: "feature", env: "prod" },
					{ commit: pick(changeCommits), branch: "main", env: pick(["prod", "staging"]) },
					{ commit: pick(commits), base: pick(commits), pr: 7, branch: "feature", env: pick(["prod", "staging"]) },
				]);
				const outcome = pick(["fail", "fail", "pass", "skip"]);
				const result =
					rand(2) === 0
						? { ...autoResult(rand(4)) }
						: { test: { case: `C-${1 + rand(2)}` }, outcome, ...(outcome === "fail" ? { note: pick(causes) } : {}) };
				command("report", { target, job: pick(["a", "b"]), attempt: 1 + rand(3), results: [result] }, pick(agents));
			} else if (action < 44 && sentLast() !== null) {
				// The same report again, exactly as it was sent.
				const sent = sentLast();
				if (sent) command("report", sent.input, sent.as);
			} else if (action < 52) {
				// Plan: by commit, by commit and environment, by a change's commit, or by hand; sometimes jobs and two actors.
				const accepts = pick([
					{ commit: pick(commits) },
					{ commit: pick(commits), env: pick(["prod", "staging"]) },
					{ commit: pick(changeCommits) },
					{ self: true },
				]);
				const methods = pick([["human", "auto"], ["human", "auto"], ["agent"], ["human", "auto", "agent"], ["human"]]);
				const require: unknown[] = [
					{
						id: "exercise",
						kind: "exercise",
						methods,
						basis: pick(["exact-or-assumed", "exact", "same-claim"]),
						minActors: rand(4) === 0 ? 2 : 1,
					},
				];
				if (rand(3) === 0) require.push({ id: "jobs", kind: "jobs", jobs: [pick(["a", "b"])] });
				if (rand(5) === 0)
					require.push({ id: "second", kind: "exercise", methods: ["human"], basis: "exact-or-assumed", minActors: 1 });
				const select = rand(3) === 0 ? { cases: [`C-${1 + rand(3)}`] } : {};
				command("plan", { name: `Plan ${step}`, select, accepts, require }, pick(people));
			} else if (action < 60) {
				// A person records a result by hand in an open run, sometimes correcting an earlier one of theirs.
				const planned = rows<{ id: number; no: number }>(
					"SELECT id, no FROM runs WHERE origin = 'planned' AND state = 'open'",
				);
				if (planned.length > 0) {
					const run = pick(planned);
					const as = pick(people);
					const outcome = pick(["fail", "pass", "pass", "skip"]);
					const caseNo = 1 + rand(3);
					const result: Record<string, unknown> = {
						test: { case: `C-${caseNo}` },
						outcome,
						...(outcome === "fail" ? { note: pick(["cause a", "cause c"]) } : {}),
					};
					if (rand(4) === 0) {
						const earlier = rows<{ id: number }>(
							"SELECT r.id FROM results r JOIN tests t ON t.id = r.test WHERE r.actor = ? AND t.key = ? AND r.run = ?",
							as.id,
							`case:${caseNo}`,
							run.id,
						);
						if (earlier.length > 0) result.corrects = pick(earlier).id;
					}
					// Sometimes under a job's name, and sometimes with a skipped automated key alongside.
					const results: Record<string, unknown>[] = [result];
					if (rand(4) === 0) results.push({ test: { key: `test-${rand(4)}` }, outcome: "skip" });
					command(
						"report",
						{ run: `R-${run.no}`, attempt: 1 + rand(2), ...(rand(3) === 0 ? { job: pick(["a", "b"]) } : {}), results },
						as,
					);
				}
			} else if (action < 80) {
				// Answer or withdraw: failures, sign-offs, findings, adopts, maps.
				const questions = rows<{ no: number; kind: string; state: string; evidence_hash: string; evidence: string }>(
					"SELECT no, kind, state, evidence_hash, evidence FROM questions WHERE state IN ('open', 'decided')",
				);
				if (questions.length > 0) {
					const question = pick(questions);
					const as = rand(6) === 0 && agents.length > 0 ? pick(agents) : pick(people);
					if (question.state === "decided" && rand(3) === 0) {
						command("decide", { undo: `Q-${question.no}`, reason: "changed my mind" }, as);
					} else {
						const is =
							question.kind === "signoff"
								? pick(["approve", "approve", "reject"])
								: question.kind === "failure"
									? pick(["infra", "flaky", "defect", "expected", "test", "mistaken", "inherited"])
									: question.kind === "finding"
										? pick(["accept", "reject", "duplicate", "defer"])
										: question.kind === "map"
											? pick(["track", "link"])
											: pick(["accept", "reject"]);
						const answer: Record<string, unknown> = { is };
						if (is === "link") answer.pairs = [[pick(["test-0", "test-1", "test-2", "test-3"]), `C-${1 + rand(3)}`]];
						command(
							"decide",
							{ q: `Q-${question.no}`, onEvidence: question.evidence_hash, answer, reason: "because" },
							as,
						);
					}
				}
			} else if (action < 82) {
				// A closed run is reopened by withdrawing its sign-off.
				const closed = rows<{ no: number }>(
					`SELECT q.no FROM questions q JOIN runs r ON r.signoff = q.decision WHERE r.state = 'closed' AND q.kind = 'signoff'`,
				);
				if (closed.length > 0) command("decide", { undo: `Q-${pick(closed).no}`, reason: "reopen" }, pick(people));
			} else if (action < 84) {
				// The policy is switched; where a person must adopt it, the owner (an admin) does.
				command("propose", {
					edits: [{ op: "policy", preset: pick(["loose", "standard", "strict"]) }],
					reason: "switch",
				});
				answerOpen("adopt");
			} else if (action < 87) {
				// A case is edited, so runs planned before pin the older version.
				const caseNo = 1 + rand(2);
				const head = rows<{ head: number }>("SELECT head FROM cases WHERE no = ?", caseNo)[0]?.head ?? 1;
				command("propose", {
					edits: [
						{
							op: "edit",
							case: `C-${caseNo}`,
							base: head,
							body: { steps: [{ id: `s${step}`, action: `do ${step}`, expected: "ok" }] },
						},
					],
					reason: "edit",
				});
				if (rand(2) === 0) answerOpen("adopt");
			} else if (action < 90) {
				// A review with findings, by a person or an agent.
				const as = rand(2) === 0 && agents.length > 0 ? pick(agents) : pick(people);
				command(
					"claim",
					{
						lens: "review",
						findings: [
							{ on: `C-${1 + rand(3)}`, category: pick(["ambiguous", "defect", "duplicate"]), note: `note ${rand(3)}` },
						],
					},
					as,
				);
			} else if (action < 93) {
				// A report accepted and applied later, as a restart does.
				const app = h.app;
				const projectRow = findProject(app.db, "scratch");
				if (projectRow) {
					const as = pick([pipeline, ...people]);
					const input = {
						target: { commit: pick(commits), branch: "main", env: pick(["prod", "staging"]) },
						job: pick(["a", "b"]),
						attempt: 1 + rand(3),
						results: [autoResult(rand(4))],
					};
					let error: string | null = null;
					try {
						app.db.transaction(() => {
							const ctx = makeCtx(app, projectRow, as, true);
							acceptReport(ctx, input);
							stampSeq(ctx);
						});
					} catch (e) {
						error = e instanceof Error ? e.message : String(e);
					}
					trace.push({ op: "acceptReport", input, as: as.name, error });
					if (error === null) placeOf(as, input);
					const applied = recoverAccepted(app);
					trace.push({ op: "recoverAccepted", applied });
				}
			} else if (action < 95 && !forgotten) {
				// The second person or the agent is forgotten; nothing uses them afterwards.
				const name = pick(["second", "explorer"]);
				command("admin", { do: "actor.forget", name });
				forgotten = true;
				people = people.filter((p) => p.name !== name);
				agents = agents.filter((a) => a.name !== name);
			} else if (action < 96) {
				// A large report: a few hundred tests failing with one cause.
				const results = Array.from({ length: 300 }, (_, i) => ({
					test: { key: `bulk-${i}` },
					outcome: i % 3 === 0 ? "pass" : "fail",
					...(i % 3 === 0 ? {} : { failure: { message: "cause bulk" } }),
				}));
				command(
					"report",
					{ target: { commit: pick(commits), branch: "main", env: "prod" }, job: "bulk", results },
					pipeline,
				);
			} else {
				h.advance(15 * 86_400_000);
				trace.push({ advance: "15 days" });
				sweep(h.app, rule);
			}
			const problem = audit();
			if (problem) return { seed, step, ...problem, last: trace.slice(-15) };
		}
		return null;
	} finally {
		h.close();
	}
}

/** The test of one policy preset. Each preset has a file of its own, so the three run side by side. */
export function extendedSequences(preset: "loose" | "standard" | "strict"): void {
	test(`${SEEDS} extended random sequences under the ${preset} policy keep every invariant`, () => {
		const problems: Problem[] = [];
		for (let seed = FIRST; seed < FIRST + SEEDS && problems.length < 3; seed++) {
			const problem = sequence(seed, preset);
			if (problem) problems.push(problem);
		}
		expect(problems).toEqual([]);
	}, 600_000);
}
