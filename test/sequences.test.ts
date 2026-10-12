// Random sequences of the things people, pipelines and agents do, with the engine's invariants checked after
// every step. The examples in `integrity.test.ts` each pin one path; this looks for the paths nobody thought of.
// The idea and the first version are the independent reviewer's (round 6 of the engine review); this one adds
// changes with a base, runs filled by hand, agents and a second policy.
//
// What must hold after every command, whatever came before:
// 1. A failure a live run shows unexplained has an open question that lists its target and names the run, and the
//    run's gate names that question. Live: an open planned run, or the run of the newest commit of a scope.
// 2. What a commit's gate counts for a lane is the fold of that lane's history (uncorrected results, none judged
//    a mistake) by the one lane rule.
// 3. A run's stored tally is what its results and the excuses in force give now, for every commit, not only
//    the newest.
// 4. Every excuse belongs to a decision that is its question's current one; a decision in force that excused or
//    attributed a failure still has its excuse.
// 5. A run's stored verdict is the verdict of its stored tally and blocking questions.
// 6. A slot's stored state is what the results admitted to it give by the same fold; a planned run's tally is
//    what its slots give.
// 7. Nobody is asked about a failure that has an answer: no question is open for a cause on a target that an
//    excuse in force covers, unless it also lists a target that none covers.
// 8. An answer that another decision supersedes is no longer in force. (The rows the ledger writes itself when
//    an answer ends, `expired` and `outdated`, stay on their question and are what the next answer follows.)
// 9. An open planned run has admitted every result it accepts and nothing else: every uncorrected result on a
//    target the run accepts (any number of them), for a case it has a slot for, by a method the slot admits.
// 10. An agent's report changes no commit's gate: every commit run reads after it exactly what it read before.
// 11. Every question a run's gate names is open: a question that was answered, dissolved or replaced holds
//     no run, whether or not the run is the newest of its scope.
// 12. A change's head is a commit that a pipeline or a person reported: never one only an agent has, and a
//     commit only an agent reported has no run.
//
// More seeds: CASEBOOK_SEQUENCE_SEEDS=500 bun test test/sequences.test.ts
import { expect, test } from "bun:test";
import {
	aggregateSlot,
	type ExerciseObligation,
	type Obligation,
	qualifies,
	replacesInLane,
	type SlotFill,
	slotState,
	type Tally,
	verdict,
} from "../src/core/runs.ts";
import { sweep } from "../src/server/jobs.ts";
import type { Actor } from "../src/server/kernel/ctx.ts";
import { harness } from "./helpers.ts";

const SEEDS = Number(process.env.CASEBOOK_SEQUENCE_SEEDS ?? 40);
const STEPS = 80;

type Row = Record<string, string | number | null>;
type Problem = { seed: number; step: number; what: string; detail: unknown; last: unknown[] };

function sequence(seed: number, preset: string): Problem | null {
	let state = seed * 2654435761 + 1;
	const rand = (n: number): number => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return (state >>> 0) % n;
	};
	const pick = <T>(items: readonly T[]): T => items[rand(items.length)] as T;
	const h = harness({ preset });
	const rows = <T = Row>(sql: string, ...args: (string | number)[]): T[] => h.app.db.raw.query(sql).all(...args) as T[];
	const trace: unknown[] = [];
	const people: Actor[] = [h.owner, h.actor("second", "human", ["read", "produce", "answer", "plan"])];
	const pipeline = h.actor("pipeline", "ci", ["read", "produce"]);
	const agent = h.actor("explorer", "agent", ["read", "produce"]);
	const rule = Number(rows<{ id: number }>("SELECT id FROM actors WHERE kind = 'rule'")[0]?.id ?? 0);
	const command = (op: string, input: unknown, as: Actor = h.owner): void => {
		const reply = h.raw(op, input, as);
		trace.push({ op, input, as: as.name, reply: reply.ok ? "ok" : reply.error });
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
		const excuseOf = (project: number, signature: number, scope: string, target: number) =>
			rows(
				"SELECT class FROM excuses WHERE project = ? AND signature = ? AND scope = ? AND target IN (0, ?) ORDER BY decision DESC LIMIT 1",
				project,
				signature,
				scope,
				target,
			)[0];

		for (const run of runs) {
			const id = Number(run.id);
			// 1. Live runs and their unexplained failures.
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
					if (excuseOf(Number(run.project), cause.signature, scope, cause.target)) continue;
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
						return { what: "a live run shows an unexplained failure nobody is asked about", detail: { run, cause } };
					const blocking = JSON.parse(String(run.blocking)) as string[];
					if (!asked.some((question) => blocking.includes(`Q-${question.no}`)))
						return { what: "a run's gate does not name the question about its failure", detail: { run, cause } };
				}
			}

			if (run.origin === "change") {
				// 2. The commit's lanes against their history.
				const current = rows("SELECT * FROM run_tests WHERE run = ?", id);
				const history = rows<{ id: number; test: number; target: number; job: string; actor: number } & Row>(
					`SELECT r.*, b.job FROM results r JOIN batches b ON b.id = r.batch JOIN targets t ON t.id = r.target
					 WHERE t.what = ? AND t.project = ? AND r.method != 'agent'
					   AND NOT EXISTS (SELECT 1 FROM results newer WHERE newer.corrects = r.id)
					   AND NOT EXISTS (SELECT 1 FROM slot_results s WHERE s.result = r.id AND s.discounted_by IS NOT NULL)
					 ORDER BY r.seq, r.ord`,
					String(run.accepts_what),
					Number(run.project),
				);
				const held = new Map<string, (typeof history)[number]>();
				for (const next of history) {
					const key = `${next.test}|${next.target}:${next.job}:${next.actor}`;
					const before = held.get(key);
					const fits =
						!before ||
						replacesInLane(
							{ attempt: Number(before.attempt), outcome: String(before.outcome) },
							{ attempt: Number(next.attempt), outcome: String(next.outcome) },
						);
					if (fits) held.set(key, next);
				}
				const actual = current.map((row) => `${row.test}|${row.lane}=${row.result}`).sort();
				const expected = [...held].map(([key, row]) => `${key}=${row.id}`).sort();
				if (JSON.stringify(actual) !== JSON.stringify(expected))
					return {
						what: "a commit's gate counts something other than its lanes' history",
						detail: { run, actual, expected },
					};

				// 3. The stored tally against the results and the excuses in force.
				const tally = { pass: 0, excused: 0, attributed: 0, unexplained: 0, missing: 0, disputed: 0, skipped: 0 };
				for (const row of current) {
					if (row.outcome === "pass") tally.pass++;
					else if (row.outcome === "skip") tally.skipped++;
					else if (row.outcome === "blocked") tally.missing++;
					else {
						const seenOn = targets.get(Number(row.target));
						if (!seenOn) return { what: "a result on an unknown target", detail: row };
						const excuse = excuseOf(
							Number(run.project),
							Number(row.signature),
							scopeOf(seenOn, id),
							Number(row.target),
						);
						tally[excuse ? (excuse.class === "attributed" ? "attributed" : "excused") : "unexplained"]++;
					}
				}
				const stored = JSON.parse(String(run.tally)) as Tally;
				for (const key of Object.keys(tally) as (keyof typeof tally)[])
					if (tally[key] !== stored[key])
						return { what: "a run's stored tally is not what its results give", detail: { run, tally, stored } };
			}

			// 11. The questions the gate names are open ones.
			for (const named of JSON.parse(String(run.blocking)) as string[]) {
				const state = rows<{ state: string }>(
					"SELECT state FROM questions WHERE project = ? AND no = ?",
					Number(run.project),
					Number(named.slice(2)),
				)[0]?.state;
				if (state !== "open")
					return { what: "a run's gate names a question that is not open", detail: { run, named, state } };
			}

			// 5. The stored verdict against the stored facts.
			const facts = {
				tally: JSON.parse(String(run.tally)) as Tally,
				blocking: (JSON.parse(String(run.blocking)) as string[]).length,
				outstanding: Number(run.outstanding),
				expired: false,
			};
			if (verdict(facts) !== run.verdict)
				return { what: "a run's stored verdict is not the verdict of its tally", detail: { run } };
		}

		// 6. Slots against the results admitted to them.
		for (const slot of rows("SELECT s.*, r.require FROM slots s JOIN runs r ON r.id = s.run WHERE r.state = 'open'")) {
			const admitted = rows(
				`SELECT r.id, r.actor, r.method, r.test, r.target, r.attempt, r.seq, r.ord, r.outcome, r.signature, b.job
				 FROM slot_results s JOIN results r ON r.id = s.result JOIN batches b ON b.id = r.batch
				 WHERE s.slot = ? AND s.corrected = 0 AND s.discounted_by IS NULL`,
				Number(slot.id),
			);
			const fills = admitted.map(
				(fill): SlotFill => ({
					id: Number(fill.id),
					actor: Number(fill.actor),
					method: fill.method as SlotFill["method"],
					test: Number(fill.test),
					lane: `${fill.target}:${fill.job}`,
					attempt: Number(fill.attempt),
					seq: Number(fill.seq),
					ord: Number(fill.ord),
					outcome:
						fill.outcome === "pass"
							? "pass"
							: fill.outcome === "fail" || fill.outcome === "error"
								? "fail"
								: fill.outcome === "skip"
									? "skip"
									: "blocked",
				}),
			);
			const obligations = JSON.parse(String(slot.require)) as { id: string; minActors?: number }[];
			const minActors = obligations.find((o) => o.id === slot.obligation)?.minActors ?? 1;
			const folded = aggregateSlot(fills);
			const expected = slotState(folded.agg, minActors);
			if (expected !== slot.state)
				return { what: "a slot's state is not what its admitted results give", detail: { slot, expected, fills } };
		}

		// 6b. A planned run's stored tally against its slots and the excuses in force.
		for (const run of runs) {
			if (run.origin !== "planned" || run.state !== "open") continue;
			const tally = { pass: 0, excused: 0, attributed: 0, unexplained: 0, missing: 0, disputed: 0, skipped: 0 };
			for (const slot of rows("SELECT * FROM slots WHERE run = ?", Number(run.id))) {
				if (slot.state === "satisfied" || slot.state === "waived") tally.pass++;
				else if (slot.state === "missing") tally.missing++;
				else if (slot.state === "skipped") {
					tally.skipped++;
					tally.missing++;
				} else {
					const causes = JSON.parse(String(slot.causes)) as [number, number][];
					const excuses = causes.map(([signature, target]) => {
						const seenOn = targets.get(target);
						return seenOn
							? excuseOf(Number(run.project), signature, scopeOf(seenOn, Number(run.id)), target)
							: undefined;
					});
					const unanswered = excuses.filter((excuse) => !excuse).length;
					if (excuses.some((excuse) => excuse?.class === "attributed")) tally.attributed++;
					else if (unanswered > 0 || causes.length === 0)
						tally[slot.state === "disputed" ? "disputed" : "unexplained"]++;
					else if (slot.state === "disputed") tally.pass++;
					else tally.excused++;
				}
			}
			const stored = JSON.parse(String(run.tally)) as Tally;
			for (const key of Object.keys(tally) as (keyof typeof tally)[])
				if (tally[key] !== stored[key])
					return { what: "a planned run's stored tally is not what its slots give", detail: { run, tally, stored } };
		}

		// 9. What an open planned run has admitted against everything it accepts.
		for (const run of runs) {
			if (run.origin !== "planned" || run.state !== "open") continue;
			const accepts = JSON.parse(String(run.accepts)) as { commit?: string; repo?: string; env?: string };
			const commit = accepts.commit;
			const accepted =
				commit === undefined
					? null
					: new Set(
							[...targets.values()]
								.filter(
									(target) =>
										target.project === run.project &&
										typeof target.commit_sha === "string" &&
										(target.commit_sha === commit || target.commit_sha.startsWith(commit)) &&
										(accepts.repo === undefined || accepts.repo === target.repo) &&
										(accepts.env === undefined || accepts.env === target.env),
								)
								.map((target) => Number(target.id)),
						);
			const exercises = (JSON.parse(String(run.require)) as Obligation[]).filter(
				(o): o is ExerciseObligation => o.kind === "exercise",
			);
			for (const slot of rows("SELECT * FROM slots WHERE run = ?", Number(run.id))) {
				const obligation = exercises.find((o) => o.id === slot.obligation);
				if (!obligation) continue;
				const pinned = rows<{ body: string }>(
					"SELECT body FROM versions WHERE case_id = ? AND no = ?",
					Number(slot.case_id),
					Number(slot.version),
				)[0];
				const declared = pinned ? (JSON.parse(pinned.body) as { methods: SlotFill["method"][] }).methods : [];
				const have = new Set(
					rows<{ result: number }>("SELECT result FROM slot_results WHERE slot = ?", Number(slot.id)).map((row) =>
						Number(row.result),
					),
				);
				const candidates = rows(
					`SELECT r.*, b.run AS typed, EXISTS (SELECT 1 FROM results later WHERE later.corrects = r.id) AS withdrawn
					 FROM results r JOIN batches b ON b.id = r.batch WHERE r.basis_case = ?`,
					Number(slot.case_id),
				).filter((result) =>
					accepted ? accepted.has(Number(result.target)) : Number(result.typed) === Number(run.id),
				);
				const wanted = new Set<number>();
				for (const result of candidates) {
					const method = result.method as SlotFill["method"];
					const admitted = qualifies({
						result: {
							method,
							basis: result.basis as "exact" | "assumed" | "unresolved",
							basisCase: Number(result.basis_case),
							basisVersion: result.basis_version === null ? null : Number(result.basis_version),
							basisClaim: result.basis_claim === null ? null : String(result.basis_claim),
						},
						slot: { caseId: Number(slot.case_id), version: Number(slot.version), claim: String(slot.claim) },
						obligation,
						caseMethods: method === "auto" ? [...declared, "auto"] : declared,
					});
					if (!admitted) continue;
					wanted.add(Number(result.id));
					if (!result.withdrawn && !have.has(Number(result.id)))
						return { what: "an open run has not admitted a result it accepts", detail: { run, slot, result } };
				}
				for (const result of have)
					if (!wanted.has(result))
						return { what: "a run admitted a result it does not accept", detail: { run, slot, result } };
			}
		}

		// 7. Nobody is asked about what already has an answer.
		for (const question of open) {
			const subject = JSON.parse(String(question.subject)) as { signature: number; scope: string };
			const evidence = JSON.parse(String(question.evidence)) as { targets?: number[] };
			const listed = evidence.targets ?? [];
			const project = Number(runs[0]?.project ?? 0);
			if (listed.length > 0 && listed.every((target) => excuseOf(project, subject.signature, subject.scope, target)))
				return {
					what: "a question is open about a failure that has an answer everywhere it was seen",
					detail: question,
				};
		}

		// 12. Heads and runs come from reports a gate counts.
		const counted = new Set(
			rows<{ what: string }>(
				"SELECT DISTINCT t.what FROM batches b JOIN targets t ON t.id = b.target WHERE b.method != 'agent'",
			).map((row) => row.what),
		);
		for (const change of rows("SELECT key, repo, head_sha FROM changes WHERE head_sha IS NOT NULL")) {
			const what = `code:${change.repo ?? ""}@${change.head_sha}`;
			if (!counted.has(what))
				return { what: "a change's head is a commit no pipeline or person reported", detail: change };
		}
		for (const run of runs) {
			if (run.origin === "change" && !counted.has(String(run.accepts_what)))
				return { what: "a commit only an agent reported has a run", detail: run };
		}

		// 8. A superseded decision is not in force.
		const standing = rows(
			`SELECT old.id, old.answer, newer.id AS by FROM decisions newer JOIN decisions old ON old.id = newer.supersedes
			 JOIN questions q ON q.id = old.question WHERE q.state = 'decided' AND q.decision = old.id
			   AND json_extract(old.answer, '$.is') NOT IN ('expired', 'outdated', 'withdrawn')`,
		);
		if (standing.length > 0) return { what: "a superseded decision is still its question's answer", detail: standing };

		// 4. Excuses and the decisions they belong to.
		const orphans = rows(
			`SELECT e.signature, e.scope, e.target, e.decision FROM excuses e
			 JOIN decisions d ON d.id = e.decision JOIN questions q ON q.id = d.question
			 WHERE q.state != 'decided' OR q.decision != d.id`,
		);
		if (orphans.length > 0) return { what: "an excuse outlived its decision", detail: orphans };
		const bare = rows(
			`SELECT q.no, d.id, d.answer FROM questions q JOIN decisions d ON d.id = q.decision
			 WHERE q.kind = 'failure' AND q.state = 'decided' AND json_extract(d.effects, '$.class') IS NOT NULL
			   AND NOT EXISTS (SELECT 1 FROM excuses e WHERE e.decision = d.id)`,
		);
		if (bare.length > 0) return { what: "an answer is in force with nothing to show for it", detail: bare };
		return null;
	};

	const commitGates = (): Map<number, string> =>
		new Map(
			rows("SELECT id, tally, verdict, blocking, state FROM runs WHERE origin = 'change'").map((run) => [
				Number(run.id),
				`${run.verdict} ${run.state} ${run.tally} ${run.blocking}`,
			]),
		);
	let gatesBefore: Map<number, string> | null = null;

	try {
		command("propose", {
			edits: [
				{ op: "create", body: { title: "One", methods: ["human", "agent"] } },
				{ op: "create", body: { title: "Two", methods: ["human"] } },
				{ op: "create", outline: "Spare" },
			],
		});
		// Under a policy where a person adopts new cases, the owner does, with the reason it asks for.
		for (const waiting of rows<{ no: number; evidence_hash: string }>(
			"SELECT no, evidence_hash FROM questions WHERE kind = 'adopt' AND state = 'open'",
		))
			command("decide", {
				q: `Q-${waiting.no}`,
				onEvidence: waiting.evidence_hash,
				answer: { is: "accept" },
				reason: "seed",
			});
		const commits = ["random01", "random02", "random03"];
		for (let step = 0; step < STEPS; step++) {
			const action = rand(100);
			const cause = () => ({ failure: { message: pick(["cause a", "cause b"]) } });
			if (action < 38) {
				// A pipeline or a person reports one automated test on trunk, sometimes correcting an earlier result.
				const index = rand(2);
				const as = pick([pipeline, ...people]);
				// Now and then the same commit in a second repository (a fork): its own gate, its own answers.
				const target = {
					commit: pick(commits),
					branch: "main",
					env: pick(["prod", "staging"]),
					...(rand(8) === 0 ? { repo: "fork" } : {}),
					// And now and then the same commit as the head of a pull request: one commit, two lines.
					...(rand(12) === 0 ? { branch: "release", pr: 9 } : {}),
				};
				const outcome = pick(["fail", "fail", "pass", "skip", "blocked"]);
				const result: Record<string, unknown> = {
					test: { key: `test-${index}` },
					annotation: { case: `C-${index + 1}`, version: 1 },
					outcome,
					...(outcome === "fail" ? cause() : {}),
				};
				if (rand(5) === 0) {
					const earlier = rows<{ id: number }>(
						`SELECT r.id FROM results r JOIN tests t ON t.id = r.test JOIN targets x ON x.id = r.target
						 WHERE r.actor = ? AND t.key = ? AND x.commit_sha = ? AND x.env = ? AND r.run IS NULL`,
						as.id,
						`test-${index}`,
						target.commit,
						target.env,
					);
					if (earlier.length > 0) result.corrects = pick(earlier).id;
				}
				command("report", { target, job: pick(["a", "b"]), attempt: 1 + rand(4), results: [result] }, as);
			} else if (action < 48) {
				// A change with a base on trunk: failures can be inherited.
				const index = rand(2);
				const outcome = pick(["fail", "fail", "pass"]);
				command(
					"report",
					{
						target: {
							commit: pick(["change01", "change02"]),
							base: pick(commits),
							pr: 7,
							branch: "feature",
							env: pick(["prod", "staging"]),
						},
						attempt: 1 + rand(3),
						results: [
							{
								test: { key: `test-${index}` },
								annotation: { case: `C-${index + 1}`, version: 1 },
								outcome,
								...(outcome === "fail" ? cause() : {}),
							},
						],
					},
					pipeline,
				);
			} else if (action < 54) {
				// An agent reports, on trunk or on the change, from one of two jobs, sometimes a skip: it never moves a
				// commit's gate, fills a slot only where asked, and its failures are asked about.
				const index = rand(2);
				const outcome = pick(["fail", "fail", "pass", "skip"]);
				const target = pick([
					{ commit: pick(commits), branch: "main", env: "prod" },
					{ commit: pick(["change01", "change02"]), base: pick(commits), pr: 7, branch: "feature", env: "prod" },
				]);
				gatesBefore = commitGates();
				command(
					"report",
					{
						target,
						job: pick(["a", "b"]),
						attempt: 1 + rand(3),
						results: [
							{
								test: { key: `test-${index}` },
								annotation: { case: `C-${index + 1}`, version: 1 },
								outcome,
								...(outcome === "fail" ? cause() : {}),
							},
						],
					},
					agent,
				);
			} else if (action < 64) {
				// By a commit on trunk, by a commit of the change (where inherited answers live), or by hand.
				const accepts = pick([
					{ commit: pick(commits) },
					{ commit: pick(commits), env: pick(["prod", "staging"]) },
					{ commit: pick(["change01", "change02"]) },
					{ self: true },
				]);
				const methods = pick([["human", "auto"], ["human", "auto"], ["agent"], ["human", "auto", "agent"]]);
				command("plan", {
					name: `Plan ${step}`,
					select: {},
					accepts,
					require: [{ id: "exercise", kind: "exercise", methods, basis: "exact-or-assumed", minActors: 1 }],
				});
			} else if (action < 72) {
				// A person records a result by hand in an open run: two people on one case can dispute.
				const planned = rows<{ no: number }>("SELECT no FROM runs WHERE origin = 'planned' AND state = 'open'");
				if (planned.length > 0) {
					const outcome = pick(["fail", "pass", "pass", "skip"]);
					command(
						"report",
						{
							run: `R-${pick(planned).no}`,
							attempt: 1 + rand(2),
							results: [
								{
									test: { case: `C-${1 + rand(2)}` },
									outcome,
									...(outcome === "fail" ? { note: pick(["cause a", "cause c"]) } : {}),
								},
							],
						},
						pick(people),
					);
				}
			} else if (action < 94) {
				const questions = rows<{ no: number; kind: string; state: string; evidence_hash: string }>(
					"SELECT no, kind, state, evidence_hash FROM questions WHERE kind IN ('failure', 'signoff') AND state IN ('open', 'decided')",
				);
				if (questions.length > 0) {
					const question = pick(questions);
					const as = pick(people);
					if (question.state === "decided" && rand(3) === 0)
						command("decide", { undo: `Q-${question.no}`, reason: "changed my mind" }, as);
					else
						command(
							"decide",
							{
								q: `Q-${question.no}`,
								onEvidence: question.evidence_hash,
								answer: {
									is:
										question.kind === "signoff"
											? pick(["approve", "approve", "reject"])
											: pick(["infra", "flaky", "defect", "expected", "test", "mistaken", "inherited"]),
								},
								reason: "because",
							},
							as,
						);
				}
			} else {
				h.advance(15 * 86_400_000);
				trace.push({ advance: "15 days" });
				sweep(h.app, rule);
			}
			const problem = audit();
			if (problem) return { seed, step, ...problem, last: trace.slice(-12) };
			// 10. The commits that had a gate before an agent's report read the same after it.
			if (gatesBefore) {
				const after = commitGates();
				for (const [run, gate] of gatesBefore)
					if (after.get(run) !== gate)
						return {
							seed,
							step,
							what: "an agent's report changed a commit's gate",
							detail: { run, before: gate, after: after.get(run) },
							last: trace.slice(-12),
						};
				gatesBefore = null;
			}
		}
		return null;
	} finally {
		h.close();
	}
}

for (const preset of ["loose", "standard", "strict"]) {
	test(`${SEEDS} random sequences under the ${preset} policy keep every invariant`, () => {
		const problems: Problem[] = [];
		for (let seed = 1; seed <= SEEDS && problems.length < 3; seed++) {
			const problem = sequence(seed, preset);
			if (problem) problems.push(problem);
		}
		expect(problems).toEqual([]);
	}, 120_000);
}
