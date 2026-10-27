import { expect, test } from "bun:test";
import type { Api } from "../src/core/api.ts";
import type { SlotFill, Tally } from "../src/core/runs.ts";
import { aggregateSlot, qualifies, replacesInLane, slotState, verdict } from "../src/core/runs.ts";
import type { Actor } from "../src/server/kernel/ctx.ts";
// Random sequences of the things people, pipelines and agents do, with the engine's invariants checked after
// every step. The examples in `integrity.test.ts` each pin one path; this looks for the paths nobody thought of.
// The idea and the first version are the independent reviewer's (round 6 of the engine review); this one adds
// changes with a base, runs filled by hand, agents and a second policy.
//
// What must hold after every command, whatever came before:
// 1. A failure a live run shows unexplained has an open question that lists its target and names the run, and the
//    run's gate names that question. Live: an open planned run, a change's observed head run in its scope, or
//    the newest commit run on a line.
// 2. Every counted lane points to an uncorrected source result with the same test, target, job and actor.
// 3. A run's stored tally is what its results and the excuses in force give now, for every commit, not only
//    the newest.
// 4. Every excuse belongs to a decision that is its question's current one; a decision in force that excused or
//    attributed a failure still has its excuse.
// 5. Literal transitions below check verdicts, including blocking questions and pending work.
// 6. Every slot fill names an existing case result; a planned run's tally is what its slots give.
//    Literal transitions below check slot aggregation and state.
// 7. Nobody is asked about a failure that has an answer: no question is open for a cause on a target that an
//    excuse in force covers, unless it also lists a target that none covers.
// 8. An answer that another decision supersedes is no longer in force. (The rows the ledger writes itself when
//    an answer ends, `expired` and `outdated`, stay on their question and are what the next answer follows.)
// 9. Every slot fill names its pinned case and an accepted target. Literal cases below check admission.
// 10. An agent's report changes no commit's gate: every commit run reads after it exactly what it read before.
// 11. Every question a run's gate names is open: a question that was answered, dissolved or replaced holds
//     no run, whether or not the run is the newest of its scope.
// 12. A change's head is a commit that a pipeline or a person reported: never one only an agent has, and a
//     commit only an agent reported has no run.
// 13. Nobody settles what the policy keeps from them: under `standard`, a failure that a slot disputes is
//     never answered, re-answered or withdrawn by somebody with a result in that slot or who reported the
//     failure; under `strict`, no failure is by somebody who reported it. Whatever came first.
//
// 14. Every automatic inherited excuse names a currently effective base failure of the same test and cause,
//     in the change's own repository. A person's broad inherited judgment keeps its existing build-only hold.
//
// The tests are in `sequences-loose-1.test.ts`, `-2`, and the same for `standard` and `strict`: each preset's seeds in
// two halves, so that no file is longer than a CI shard should be.
// More seeds: MAINWORTHY_SEQUENCE_SEEDS=500 bun test test/sequences-
import { Database, type ReadDb, type SqlValue, sql } from "../src/server/kernel/db.ts";
import { sweep } from "../src/server/ops/jobs.ts";
import { testDatabase } from "./db.ts";
import { harness } from "./helpers.ts";
import { auditRelations } from "./sequence-audit.ts";

const SEEDS = Number(process.env.MAINWORTHY_SEQUENCE_SEEDS ?? 40);
const STEPS = 80;

export const seedPlan = {
	name: "Seed run",
	select: { cases: ["C-1"] },
	accepts: { self: true },
	require: [{ id: "exercise", kind: "exercise", methods: ["human"], basis: "exact-or-assumed", minActors: 1 }],
} satisfies Api["plan"]["input"];

type AuditExcuse = { class: string; decision: number };

export async function auditExcuses(
	db: ReadDb,
	stored?: {
		broad: (AuditExcuse & { project: number; signature: number; scope: string; target: number })[];
		exact: (AuditExcuse & { result: number })[];
	},
) {
	const key = (project: number, signature: number, scope: string, target: number) =>
		JSON.stringify([project, signature, scope, target]);
	const broad = new Map(
		(
			stored?.broad ??
			(await db.all(
				sql<readonly [], AuditExcuse & { project: number; signature: number; scope: string; target: number }>(
					"SELECT project, signature, scope, target, class, decision FROM excuses",
				),
			))
		).map((row) => [key(row.project, row.signature, row.scope, row.target), row]),
	);
	const exact = new Map(
		(
			stored?.exact ??
			(await db.all(
				sql<readonly [], AuditExcuse & { result: number }>(
					"SELECT result, class, decision FROM result_excuses WHERE slot IS NULL",
				),
			))
		).map((row) => [row.result, row]),
	);
	return (project: number, signature: number, scope: string, target: number, result = 0): AuditExcuse | undefined => {
		// Target specificity wins within broad standing, even against a newer global decision.
		const cause = broad.get(key(project, signature, scope, target)) ?? broad.get(key(project, signature, scope, 0));
		const named = exact.get(result);
		// A tie keeps the broad decision, as in the compound query's left-hand SELECT.
		const held = named && (!cause || named.decision > cause.decision) ? named : cause;
		return held ? { class: held.class, decision: held.decision } : undefined;
	};
}

type Row = Record<string, string | number | null>;
type Problem = { seed: number; step: number; what: string; detail: unknown; last: unknown[] };
export type AuditMeasurement = { step: number; statements: number };

export async function sequence(
	seed: number,
	preset: string,
	onFirstPlan?: (step: number) => void,
	onAudit?: (measurement: AuditMeasurement) => void,
): Promise<Problem | null> {
	let currentStep = -1;
	let state = seed * 2654435761 + 1;
	const rand = (n: number): number => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return (state >>> 0) % n;
	};
	const pick = <T>(items: readonly T[]): T => items[rand(items.length)] as T;
	const h = await harness({ preset });
	const rows = async <T = Row>(query: string, ...args: (string | number)[]): Promise<T[]> => {
		let index = 0;
		return await h.app.database.read(
			async (db) => await db.all(sql<readonly SqlValue[], T>(query.replace(/\?/g, () => `$${++index}`)), args),
		);
	};
	const trace: unknown[] = [];
	const successful = new Map<string, number>();
	const people: Actor[] = [h.owner, await h.actor("second", "human", ["read", "produce", "answer", "plan"])];
	const pipeline = await h.actor("pipeline", "ci", ["read", "record"]);
	const agent = await h.actor("explorer", "agent", ["read", "produce"]);
	const rule = Number((await rows<{ id: number }>("SELECT id FROM actors WHERE kind = 'rule'"))[0]?.id ?? 0);
	const command = async (op: string, input: unknown, as: Actor = h.owner): Promise<unknown> => {
		const reply = await h.raw(op, input, as);
		if (reply.ok) {
			if (op === "plan" && !successful.has("plan")) onFirstPlan?.(currentStep);
			successful.set(op, (successful.get(op) ?? 0) + 1);
		}
		trace.push({ op, input, as: as.name, reply: reply.ok ? "ok" : reply.error });
		return reply.ok ? reply.result : null;
	};

	const scopeOf = (target: Row, run: number): string =>
		target.line === "session"
			? `run:${run}`
			: target.change !== null
				? `change:${target.change}`
				: target.repo
					? `line:${target.line}@${target.repo}`
					: `line:${target.line}`;

	const audit = async (): Promise<{ what: string; detail: unknown } | null> =>
		h.app.database.read(async (db) => {
			const relations = await auditRelations(db, h.app.now());
			const runs = relations.runs;
			const newestInScope = new Map<string, number>();
			for (const run of runs) {
				if (run.scope !== null) {
					const scope = String(run.scope);
					newestInScope.set(scope, Math.max(newestInScope.get(scope) ?? 0, Number(run.id)));
				}
			}
			// A change speaks through its observed head only while that run belongs to this scope.
			for (const change of relations.changes) {
				const scope = `change:${change.id}`;
				const head =
					change.head_sha === null
						? undefined
						: runs.find(
								(run) =>
									run.origin === "change" &&
									run.project === change.project &&
									run.scope === scope &&
									run.accepts_what === `code:${change.repo ?? ""}@${change.head_sha}`,
							);
				if (head) newestInScope.set(scope, Number(head.id));
				else newestInScope.delete(scope);
			}
			const targets = new Map(relations.targets.map((target) => [Number(target.id), target]));
			const open = relations.open.map((question) => ({
				...question,
				subject: JSON.parse(String(question.subject)) as { signature: number; scope: string; slot?: number },
				evidence: JSON.parse(String(question.evidence)) as { targets?: number[]; results?: number[] },
				refs: String(question.refs ?? "").split(","),
			}));
			const excuseSnapshot = await auditExcuses(db, relations.excuses);
			const excuseOf = async (
				project: number,
				signature: number,
				scope: string,
				target: number,
				result = 0,
				slot?: number,
			) =>
				slot !== undefined
					? relations.settlement(slot, result)
					: excuseSnapshot(project, signature, scope, target, result);

			for (const run of runs) {
				const id = Number(run.id);
				// 1. Live runs and their unexplained failures.
				const newest = run.scope === null ? null : newestInScope.get(String(run.scope));
				const live = run.origin === "planned" ? run.state === "open" : id === newest;
				if (live) {
					const causes: { signature: number; target: number; result: number; slot?: number }[] =
						run.origin === "change"
							? relations.lanes(id).filter((row) => row.outcome === "fail" || row.outcome === "error")
							: await flatMapAsync(
									relations.slots(id).filter((slot) => slot.state === "failing" || slot.state === "disputed"),
									async (slot) =>
										relations.failing(slot.id).map((cause) => ({
											...cause,
											...(slot.state === "disputed" ? { slot: slot.id } : {}),
										})),
								);
					for (const cause of causes) {
						const target = targets.get(cause.target);
						if (!target) return { what: "a cause on an unknown target", detail: cause };
						const scope = scopeOf(target, id);
						if (await excuseOf(Number(run.project), cause.signature, scope, cause.target, cause.result, cause.slot))
							continue;
						const asked = open.filter((question) => {
							const subject = question.subject;
							const evidence = question.evidence;
							return (
								subject.signature === cause.signature &&
								subject.scope === scope &&
								subject.slot === cause.slot &&
								(evidence.targets ?? []).includes(cause.target) &&
								question.refs.includes(`R-${run.no}`)
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
					// 2. The commit's lanes point back to their source history.
					const current = relations.lanes(id);
					const history = relations.history(Number(run.project), String(run.accepts_what));
					for (const counted of current) {
						const source = history.find((row) => row.id === counted.result);
						if (
							!source ||
							`${source.test}|${source.target}:${source.job}:${source.actor}` !== `${counted.test}|${counted.lane}`
						)
							return { what: "a counted lane has no matching source result", detail: { run, counted, source } };
					}

					// 3. The stored tally against the results and the excuses in force.
					const tally = { pass: 0, excused: 0, attributed: 0, unexplained: 0, missing: 0, disputed: 0, skipped: 0 };
					for (const row of current) {
						if (row.outcome === "pass") tally.pass++;
						else if (row.outcome === "skip") tally.skipped++;
						else if (row.outcome === "blocked") tally.missing++;
						else {
							const seenOn = targets.get(Number(row.target));
							if (!seenOn) return { what: "a result on an unknown target", detail: row };
							const excuse = await excuseOf(
								Number(run.project),
								Number(row.signature),
								scopeOf(seenOn, id),
								Number(row.target),
								Number(row.result),
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
					const state = relations.question(Number(run.project), Number(named.slice(2)));
					if (state !== "open")
						return { what: "a run's gate names a question that is not open", detail: { run, named, state } };
				}
			}

			// Every slot fill belongs to an existing slot and result of the same case.
			const orphaned = relations.orphaned;
			if (orphaned.length > 0) return { what: "slot fills have no matching case result", detail: orphaned };

			// 6b. A planned run's stored tally against its slots and the excuses in force.
			for (const run of runs) {
				if (run.origin !== "planned" || run.state !== "open") continue;
				const tally = { pass: 0, excused: 0, attributed: 0, unexplained: 0, missing: 0, disputed: 0, skipped: 0 };
				for (const slot of relations.slots(Number(run.id))) {
					if (slot.state === "satisfied" || slot.state === "waived") tally.pass++;
					else if (slot.state === "missing") tally.missing++;
					else if (slot.state === "skipped") {
						tally.skipped++;
						tally.missing++;
					} else {
						const causes = relations.failing(Number(slot.id));
						const excuses = await mapAsync(causes, async ({ signature, target, result }) => {
							const seenOn = targets.get(target);
							return seenOn
								? await excuseOf(
										Number(run.project),
										signature,
										scopeOf(seenOn, Number(run.id)),
										target,
										result,
										slot.state === "disputed" ? Number(slot.id) : undefined,
									)
								: undefined;
						});
						const unanswered = excuses.filter((excuse) => !excuse).length;
						if (slot.state === "disputed" && (unanswered > 0 || causes.length === 0)) tally.disputed++;
						else if (excuses.some((excuse) => excuse?.class === "attributed")) tally.attributed++;
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

			// Accepted fills point to the pinned case and a target accepted by their run.
			for (const fill of relations.acceptedFills) {
				const accepts = JSON.parse(String(fill.accepts)) as { commit?: string; repo?: string; env?: string };
				if (
					fill.case_id !== fill.basis_case ||
					fill.target_project !== fill.run_project ||
					(accepts.repo !== undefined && accepts.repo !== fill.repo) ||
					(accepts.env !== undefined && accepts.env !== fill.env) ||
					(accepts.commit ? !String(fill.commit_sha).startsWith(accepts.commit) : fill.typed !== fill.run_id)
				)
					return { what: "an admitted fill has an unrelated case or target", detail: fill };
			}

			// 7. Nobody is asked about what already has an answer.
			for (const question of open) {
				const subject = question.subject;
				const evidence = question.evidence;
				if (subject.slot !== undefined) {
					if (
						(evidence.results ?? []).length > 0 &&
						(await everyAsync(evidence.results ?? [], async (result) => relations.exact(subject.slot ?? 0, result)))
					)
						return { what: "a settled slot still has an open dispute question", detail: question };
					continue;
				}
				const listed = evidence.targets ?? [];
				const project = Number(runs[0]?.project ?? 0);
				if (
					listed.length > 0 &&
					(await everyAsync(
						listed,
						async (target) => await excuseOf(project, subject.signature, subject.scope, target),
					))
				)
					return {
						what: "a question is open about a failure that has an answer everywhere it was seen",
						detail: question,
					};
			}

			// 12. Heads and runs come from reports a gate counts.
			const counted = new Set(relations.counted.map((row) => row.what));
			for (const change of relations.changes.filter((change) => change.head_sha !== null)) {
				const what = `code:${change.repo ?? ""}@${change.head_sha}`;
				if (!counted.has(what))
					return { what: "a change's head is a commit no pipeline or person reported", detail: change };
			}
			for (const run of runs) {
				if (run.origin === "change" && !counted.has(String(run.accepts_what)))
					return { what: "a commit only an agent reported has a run", detail: run };
			}

			// 8. A superseded decision is not in force.
			const standing = relations.standing;
			if (standing.length > 0)
				return { what: "a superseded decision is still its question's answer", detail: standing };

			// 4. Excuses and the decisions they belong to.
			const orphans = relations.orphans;
			if (orphans.length > 0) return { what: "an excuse outlived its decision", detail: orphans };
			const bare = relations.bare;
			if (bare.length > 0) return { what: "an answer is in force with nothing to show for it", detail: bare };
			const unsupported = relations.unsupported;
			if (unsupported.length > 0)
				return { what: "an inherited failure does not fail on its base now", detail: unsupported };

			return null;
		});

	const commitGates = async (): Promise<Map<number, string>> =>
		new Map(
			(await rows("SELECT id, tally, verdict, blocking, state FROM runs WHERE origin = 'change'")).map((run) => [
				Number(run.id),
				`${run.verdict} ${run.state} ${run.tally} ${run.blocking}`,
			]),
		);
	let gatesBefore: Map<number, string> | null = null;
	let keptFrom: string | null = null;
	let settled: unknown = null;
	// What this test remembers by itself about each question's answer in force: whether the test saw a dispute
	// when that answer was given, and who its parties were. An answer given to a dispute stays kept from them
	// after the runs stop showing it (the disputed result set aside by `mistaken`, the run closed).
	const answeredAsDispute = new Map<number, Set<number>>();
	const seen: { now: { no: number; parties: Set<number> | null } | null } = { now: null };
	// Whether this policy keeps this failure question from this person, read from the rows as they are before the
	// command: who reported a failure with its cause in its scope, and who has a result in a slot that disputes it.
	const keptFromAnswering = async (no: number, as: Actor): Promise<boolean> => {
		if (preset === "loose") return false;
		const question = (await rows<{ subject: string }>("SELECT subject FROM questions WHERE no = ?", no))[0];
		if (!question) return false;
		const subject = JSON.parse(question.subject) as { signature: number; scope: string; slot?: number };
		const targets = new Map((await rows("SELECT * FROM targets")).map((target) => [Number(target.id), target]));
		const reported = (
			await rows<{ target: number; run: number | null }>(
				`SELECT r.target, b.run FROM results r JOIN batches b ON b.id = r.batch
			 WHERE r.signature = ? AND r.actor = ? AND r.outcome IN ('fail', 'error')`,
				subject.signature,
				as.id,
			)
		).some((row) => {
			const target = targets.get(Number(row.target));
			return target !== undefined && scopeOf(target, Number(row.run ?? 0)) === subject.scope;
		});
		const parties = new Set<number>();
		if (subject.slot !== undefined)
			for (const row of await rows<{ actor: number }>(
				"SELECT DISTINCT r.actor FROM slot_results s JOIN results r ON r.id = s.result WHERE s.slot = ? AND s.corrected = 0 AND s.discounted_by IS NULL",
				subject.slot,
			))
				parties.add(Number(row.actor));
		seen.now = { no, parties: subject.slot !== undefined ? parties : null };
		const decided =
			(await rows<{ state: string }>("SELECT state FROM questions WHERE no = ?", no))[0]?.state === "decided";
		const before = decided ? answeredAsDispute.get(no) : undefined;
		return subject.slot === undefined
			? preset === "strict" && reported
			: parties.has(as.id) || before?.has(as.id) === true;
	};

	try {
		await command("propose", {
			edits: [
				{ op: "create", body: { title: "One", methods: ["human", "agent"] } },
				{ op: "create", body: { title: "Two", methods: ["human"] } },
				{ op: "create", outline: "Spare" },
			],
		});
		// Under a policy where a person adopts new cases, the owner does, with the reason it asks for.
		for (const waiting of await rows<{ no: number; evidence_hash: string }>(
			"SELECT no, evidence_hash FROM questions WHERE kind = 'adopt' AND state = 'open' ORDER BY id",
		))
			await command("decide", {
				q: `Q-${waiting.no}`,
				onEvidence: waiting.evidence_hash,
				answer: { is: "accept" },
				reason: "seed",
			});
		expect(await rows("SELECT id FROM cases WHERE head IS NOT NULL")).toHaveLength(3);
		// Keep pre-plan evidence in the exploration, while guaranteeing slots early enough to exercise.
		const planByStep = 1 + (((seed * 2654435761) >>> 0) % (STEPS / 4));
		const commits = ["random01", "random02", "random03"];
		for (let step = 0; step < STEPS; step++) {
			currentStep = step;
			if (step === planByStep && !successful.has("plan")) expect(await command("plan", seedPlan)).not.toBeNull();
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
					const earlier = await rows<{ id: number }>(
						`SELECT r.id FROM results r JOIN tests t ON t.id = r.test JOIN targets x ON x.id = r.target
						 WHERE r.actor = ? AND t.key = ? AND x.commit_sha = ? AND x.env = ? AND r.run IS NULL ORDER BY r.id`,
						as.id,
						`test-${index}`,
						target.commit,
						target.env,
					);
					if (earlier.length > 0) result.corrects = pick(earlier).id;
				}
				await command("report", { target, job: pick(["a", "b"]), attempt: 1 + rand(4), results: [result] }, as);
			} else if (action < 48) {
				// A change with a base on trunk: failures can be inherited.
				const index = rand(2);
				const outcome = pick(["fail", "fail", "pass"]);
				await command(
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
				gatesBefore = await commitGates();
				await command(
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
				await command("plan", {
					name: `Plan ${step}`,
					select: {},
					accepts,
					require: [{ id: "exercise", kind: "exercise", methods, basis: "exact-or-assumed", minActors: 1 }],
				});
			} else if (action < 72) {
				// A person records a result by hand in an open run: two people on one case can dispute.
				const planned = await rows<{ no: number }>(
					"SELECT no FROM runs WHERE origin = 'planned' AND state = 'open' ORDER BY id",
				);
				if (planned.length > 0) {
					const outcome = pick(["fail", "pass", "pass", "skip"]);
					await command(
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
				const questions = await rows<{ no: number; kind: string; state: string; evidence_hash: string }>(
					"SELECT no, kind, state, evidence_hash FROM questions WHERE kind IN ('failure', 'signoff') AND state IN ('open', 'decided') ORDER BY id",
				);
				if (questions.length > 0) {
					const question = pick(questions);
					const as = pick(people);
					keptFrom =
						question.kind === "failure" && (await keptFromAnswering(question.no, as)) ? `Q-${question.no}` : null;
					if (question.state === "decided" && rand(3) === 0)
						settled = await command("decide", { undo: `Q-${question.no}`, reason: "changed my mind" }, as);
					else
						settled = await command(
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
				await sweep(h.app, rule);
			}
			// 13. An answer or a withdrawal by somebody the policy keeps it from did not go through.
			if (keptFrom !== null) {
				const status = (settled as { status?: string }[] | null)?.[0]?.status;
				if (status === "decided" || status === "reopened")
					return {
						seed,
						step,
						what: "somebody settled a failure the policy keeps from them",
						detail: { question: keptFrom, status },
						last: trace.slice(-12),
					};
			}
			// What the answer just given was given to, for the next time somebody touches it.
			const touched = seen.now;
			if (touched !== null) {
				const status = (settled as { status?: string }[] | null)?.[0]?.status;
				if (status === "decided") {
					const kept = new Set([...(answeredAsDispute.get(touched.no) ?? []), ...(touched.parties ?? [])]);
					if (touched.parties !== null) answeredAsDispute.set(touched.no, kept);
					else answeredAsDispute.delete(touched.no);
				} else if (status === "reopened") answeredAsDispute.delete(touched.no);
			}
			seen.now = null;
			keptFrom = null;
			settled = null;
			const beforeAudit = h.app.database.statementCount;
			const problem = await audit();
			onAudit?.({ step, statements: h.app.database.statementCount - beforeAudit });
			if (problem) return { seed, step, ...problem, last: trace.slice(-12) };
			// 10. The commits that had a gate before an agent's report read the same after it.
			if (gatesBefore) {
				const after = await commitGates();
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
		if (
			(successful.get("report") ?? 0) === 0 ||
			(successful.get("plan") ?? 0) === 0 ||
			(await rows("SELECT id FROM slots")).length === 0 ||
			(await rows("SELECT id FROM results")).length === 0 ||
			(await rows("SELECT id FROM runs")).length === 0
		)
			return {
				seed,
				step: STEPS,
				what: "sequence made no reporting progress",
				detail: [...successful],
				last: trace.slice(-12),
			};
		return null;
	} finally {
		await h.close();
	}
}

function literalTransitions(): void {
	test("reported transitions persist the literal lane, slot and gate outcomes", async () => {
		const h = await harness({ preset: "strict" });
		try {
			await h.call("propose", { edits: [{ op: "create", body: { title: "Release", methods: ["human", "agent"] } }] });
			for (const q of (await h.call<{ items: { q: string; evidenceHash: string }[] }>("inbox", { kind: "adopt" }))
				.items)
				await h.call("decide", { q: q.q, onEvidence: q.evidenceHash, answer: { is: "accept" }, reason: "fixture" });
			const target = { commit: "literal01", branch: "main" };
			const planned = await h.call<{ run: string }>("plan", {
				name: "Release",
				select: { cases: ["C-1"] },
				accepts: { commit: target.commit },
				require: [{ id: "exercise", kind: "exercise", methods: ["auto", "human"], basis: "exact", minActors: 2 }],
			});
			const ci = await h.actor("pipeline", "ci", ["read", "record"]);
			const report = async (outcome: string, attempt = 1, job = "unit") =>
				await h.call(
					"report",
					{
						target,
						job,
						attempt,
						results: [
							{
								test: { key: "check" },
								annotation: { case: "C-1", version: 1 },
								outcome,
								...(outcome === "fail" ? { failure: { message: "broken" } } : {}),
							},
						],
					},
					ci,
				);
			const snapshot = async () => ({
				slot: (await h.call<{ items: { state: string }[] }>("find", { in: "slots", run: planned.run })).items[0]?.state,
				gate: (await h.call<{ verdict: string }>("gate", { run: planned.run })).verdict,
			});
			expect(await snapshot()).toEqual({ slot: "missing", gate: "pending" });
			await report("fail");
			expect(await snapshot()).toEqual({ slot: "failing", gate: "blocked" });
			await report("pass");
			expect(await snapshot()).toEqual({ slot: "failing", gate: "blocked" });
			await report("skip", 2);
			expect(await snapshot()).toEqual({ slot: "failing", gate: "blocked" });
			await report("pass", 3);
			expect(await snapshot()).toEqual({ slot: "missing", gate: "pending" });
			expect((await h.call<{ verdict: string }>("gate", { commit: target.commit })).verdict).toBe("passed");
			await report("fail", 1, "e2e");
			expect(await snapshot()).toEqual({ slot: "failing", gate: "blocked" });
			await report("pass", 2, "e2e");
			expect(await snapshot()).toEqual({ slot: "missing", gate: "pending" });
			await h.call("report", { run: planned.run, results: [{ test: { case: "C-1" }, outcome: "pass" }] });
			expect(await snapshot()).toEqual({ slot: "satisfied", gate: "passed" });
			await h.call("report", {
				run: planned.run,
				results: [{ test: { case: "C-1" }, outcome: "fail", failure: { message: "manual" } }],
			});
			expect(await snapshot()).toEqual({ slot: "disputed", gate: "blocked" });
		} finally {
			await h.close();
		}
	});

	test.each([
		["exact", "exact", ["auto"], "C-1", 1, "satisfied", "exact"],
		["assumed refused", "exact", ["auto"], "C-1", undefined, "missing", null],
		["assumed accepted", "exact-or-assumed", ["auto"], "C-1", undefined, "satisfied", "assumed"],
		["method refused", "exact", ["human"], "C-1", 1, "missing", null],
		["other case", "exact", ["auto"], "C-2", 1, "missing", null],
	] as const)("reported slot admission: %s", async (_name, basis, methods, caseRef, version, state, admitted) => {
		const h = await harness({ preset: "strict" });
		try {
			await h.call("propose", {
				edits: [
					{ op: "create", outline: "One" },
					{ op: "create", outline: "Two" },
				],
			});
			for (const q of (await h.call<{ items: { q: string; evidenceHash: string }[] }>("inbox", { kind: "adopt" }))
				.items)
				await h.call("decide", { q: q.q, onEvidence: q.evidenceHash, answer: { is: "accept" }, reason: "fixture" });
			const planned = await h.call<{ run: string }>("plan", {
				name: "Admission",
				select: { cases: ["C-1"] },
				accepts: { commit: "admission01" },
				require: [{ id: "exercise", kind: "exercise", methods, basis, minActors: 1 }],
			});
			const ci = await h.actor("pipeline", "ci", ["read", "record"]);
			await h.call(
				"report",
				{
					target: { commit: "admission01", branch: "main" },
					results: [
						{
							test: { key: "check" },
							outcome: "pass",
							annotation: { case: caseRef, ...(version === undefined ? {} : { version }) },
						},
					],
				},
				ci,
			);
			const slots = await h.call<{ items: { state: string; fills: { admitted: string }[] }[] }>("find", {
				in: "slots",
				run: planned.run,
			});
			expect(
				slots.items.map((slot) => ({ state: slot.state, fills: slot.fills.map((fill) => fill.admitted) })),
			).toEqual([{ state, fills: admitted === null ? [] : [admitted] }]);
		} finally {
			await h.close();
		}
	});

	test("lane transitions keep decisive evidence and same-attempt failures", () => {
		for (const [held, next, expected] of [
			[{ attempt: 1, outcome: "pass" }, { attempt: 2, outcome: "skip" }, false],
			[{ attempt: 1, outcome: "fail" }, { attempt: 2, outcome: "blocked" }, false],
			[{ attempt: 1, outcome: "error" }, { attempt: 2, outcome: "pass" }, true],
			[{ attempt: 1, outcome: "skip" }, { attempt: 2, outcome: "blocked" }, true],
			[{ attempt: 2, outcome: "pass" }, { attempt: 1, outcome: "fail" }, false],
			[{ attempt: 1, outcome: "fail" }, { attempt: 1, outcome: "pass" }, false],
			[{ attempt: 1, outcome: "pass" }, { attempt: 1, outcome: "fail" }, true],
			[{ attempt: 1, outcome: "fail" }, { attempt: 1, outcome: "error" }, true],
			[{ attempt: 1, outcome: "skip" }, { attempt: 1, outcome: "blocked" }, true],
		] as const)
			expect(replacesInLane(held, next)).toBe(expected);
	});

	test("slot transitions fold jobs separately and count distinct passing actors", () => {
		const fills: SlotFill[] = [
			{ id: 1, actor: 1, method: "auto", test: 1, lane: "unit", attempt: 1, seq: 1, ord: 0, outcome: "fail" },
			{ id: 2, actor: 1, method: "auto", test: 1, lane: "e2e", attempt: 1, seq: 2, ord: 0, outcome: "pass" },
			{ id: 3, actor: 1, method: "auto", test: 1, lane: "unit", attempt: 2, seq: 3, ord: 0, outcome: "pass" },
			{ id: 4, actor: 2, method: "human", test: 0, lane: "manual", attempt: 1, seq: 4, ord: 0, outcome: "fail" },
		];
		const first = aggregateSlot(fills.slice(0, 2));
		expect(first).toEqual({
			agg: { "1:auto": { actor: 1, outcome: "fail", result: 1, seq: 1 } },
			failing: [1],
			effective: [1, 2],
		});
		expect(slotState(first.agg, 1)).toBe("failing");
		const retried = aggregateSlot(fills.slice(0, 3));
		expect(retried).toEqual({
			agg: { "1:auto": { actor: 1, outcome: "pass", result: 3, seq: 3 } },
			failing: [],
			effective: [3, 2],
		});
		expect(slotState(retried.agg, 1)).toBe("satisfied");
		expect(slotState(retried.agg, 2)).toBe("missing");
		expect(slotState(aggregateSlot(fills).agg, 1)).toBe("disputed");
		expect(slotState({}, 1)).toBe("missing");
		expect(slotState({ skip: { actor: 1, outcome: "skip", result: 5, seq: 5 } }, 1)).toBe("skipped");
		expect(
			slotState(
				{
					one: { actor: 1, outcome: "pass", result: 1, seq: 1 },
					again: { actor: 1, outcome: "pass", result: 2, seq: 2 },
				},
				2,
			),
		).toBe("missing");
		expect(
			slotState(
				{
					one: { actor: 1, outcome: "pass", result: 1, seq: 1 },
					two: { actor: 2, outcome: "pass", result: 2, seq: 2 },
				},
				2,
			),
		).toBe("satisfied");
	});

	test("verdict transitions give pending work precedence and never pass an empty tally", () => {
		const empty: Tally = { pass: 0, excused: 0, attributed: 0, unexplained: 0, missing: 0, disputed: 0, skipped: 0 };
		for (const [tally, blocking, outstanding, expired, expected] of [
			[{}, 0, 0, false, "pending"],
			[{ pass: 1 }, 0, 0, false, "passed"],
			[{ excused: 1 }, 0, 0, false, "passed"],
			[{ pass: 1, missing: 1 }, 0, 0, false, "pending"],
			[{ pass: 1, attributed: 1 }, 0, 0, false, "failed"],
			[{ pass: 1, unexplained: 1 }, 0, 0, false, "blocked"],
			[{ pass: 1, disputed: 1 }, 0, 0, false, "blocked"],
			[{ pass: 1 }, 1, 0, false, "blocked"],
			[{ attributed: 1 }, 0, 1, false, "pending"],
			[{ attributed: 1 }, 0, 0, true, "pending"],
		] as const)
			expect(verdict({ tally: { ...empty, ...tally }, blocking, outstanding, expired })).toBe(expected);
	});

	test("slot admission pins case, method and basis independently", () => {
		const input: Parameters<typeof qualifies>[0] = {
			result: { method: "human", basis: "exact", basisCase: 1, basisVersion: 2, basisClaim: "claim" },
			slot: { caseId: 1, version: 2, claim: "claim" },
			obligation: { id: "exercise", kind: "exercise", methods: ["human"], basis: "exact", minActors: 1 },
			caseMethods: ["human"],
		};
		expect(qualifies(input)).toBe("exact");
		expect(qualifies({ ...input, result: { ...input.result, basisCase: 2 } })).toBeNull();
		expect(qualifies({ ...input, result: { ...input.result, basis: "unresolved" } })).toBeNull();
		expect(qualifies({ ...input, result: { ...input.result, basis: "assumed" } })).toBeNull();
		expect(
			qualifies({
				...input,
				result: { ...input.result, basis: "assumed" },
				obligation: { ...input.obligation, basis: "exact-or-assumed" },
			}),
		).toBe("assumed");
		expect(qualifies({ ...input, result: { ...input.result, basisVersion: 1 } })).toBeNull();
		expect(
			qualifies({
				...input,
				result: { ...input.result, basisVersion: 1 },
				obligation: { ...input.obligation, basis: "same-claim" },
			}),
		).toBe("same-claim");
		expect(
			qualifies({
				...input,
				result: { ...input.result, basisVersion: 1, basisClaim: "other" },
				obligation: { ...input.obligation, basis: "same-claim" },
			}),
		).toBeNull();
		expect(
			qualifies({ ...input, result: { ...input.result, method: "agent" }, caseMethods: ["human", "agent"] }),
		).toBeNull();
		expect(
			qualifies({
				...input,
				result: { ...input.result, method: "agent" },
				obligation: { ...input.obligation, methods: ["agent"] },
			}),
		).toBeNull();
		expect(
			qualifies({
				...input,
				result: { ...input.result, method: "agent" },
				caseMethods: ["human", "agent"],
				obligation: { ...input.obligation, methods: ["agent"] },
			}),
		).toBe("exact");
	});
}

/** One half of a policy preset's seeds. Each half has a file of its own, so the six run side by side. */
export function sequences(preset: "loose" | "standard" | "strict", half: 1 | 2): void {
	if (preset === "loose" && half === 1) literalTransitions();
	if (preset === "loose" && half === 1)
		test("the audit resolves broad and exact-result standing independently", async () => {
			const fixture = await testDatabase({ schema: "empty" });
			const database = await Database.open({ url: fixture.url });
			try {
				await database.write(
					async (db) =>
						await db.transaction(async () => {
							await db.exec(`CREATE TABLE excuses (project INTEGER, signature INTEGER, scope TEXT, target INTEGER, class TEXT, decision INTEGER);
			CREATE TABLE result_excuses (result INTEGER, slot INTEGER, class TEXT, decision INTEGER);
			INSERT INTO excuses VALUES (1, 2, 'line:main', 0, 'excused', 30), (1, 2, 'line:main', 4, 'attributed', 10);
			INSERT INTO result_excuses VALUES (5, NULL, 'excused', 20), (6, NULL, 'excused', 9),
				(7, NULL, 'excused', 10), (8, 99, 'excused', 40);`);
							const excuseOf = await auditExcuses(db);
							expect(excuseOf(1, 2, "line:main", 4, 5)).toEqual({ class: "excused", decision: 20 });
							expect(excuseOf(1, 2, "line:main", 4, 6)).toEqual({ class: "attributed", decision: 10 });
							expect(excuseOf(1, 2, "line:main", 4, 7)).toEqual({ class: "attributed", decision: 10 });
							expect(excuseOf(1, 2, "line:main", 4, 8)).toEqual({ class: "attributed", decision: 10 });
							expect(excuseOf(1, 2, "line:main", 9, 5)).toEqual({ class: "excused", decision: 30 });
							expect(excuseOf(1, 2, "line:main", 0)).toEqual({ class: "excused", decision: 30 });
							expect(excuseOf(2, 2, "line:main", 4, 5)).toEqual({ class: "excused", decision: 20 });
							expect(excuseOf(1, 3, "line:main", 4)).toBeUndefined();
							expect(excuseOf(1, 2, "line:other", 4)).toBeUndefined();
						}),
				);
			} finally {
				await database.close();
				await fixture.close();
			}
		});

	const middle = Math.ceil(SEEDS / 2);
	for (let seed = half === 1 ? 1 : middle + 1; seed <= (half === 1 ? middle : SEEDS); seed++) {
		test(`random sequence ${seed}/${SEEDS} under the ${preset} policy keeps every invariant`, async () => {
			let firstPlan = -1;
			let auditStatements = 0;
			const problem = await sequence(
				seed,
				preset,
				(step) => {
					firstPlan = step;
				},
				({ statements }) => {
					auditStatements = Math.max(auditStatements, statements);
				},
			);
			expect(problem).toBeNull();
			expect(firstPlan).toBeGreaterThanOrEqual(0);
			expect(auditStatements).toBeLessThanOrEqual(4);
		}, 120_000);
	}
}

async function everyAsync<T>(rows: readonly T[], callback: (value: T) => Promise<unknown>) {
	for (const row of rows) if (!(await callback(row))) return false;
	return true;
}

async function flatMapAsync<T, R>(rows: readonly T[], callback: (value: T) => Promise<R | R[]>) {
	const out: R[] = [];
	for (const row of rows) {
		const found = await callback(row);
		out.push(...(Array.isArray(found) ? found : [found]));
	}
	return out;
}

async function mapAsync<T, R>(rows: readonly T[], callback: (value: T) => Promise<R>) {
	const out: R[] = [];
	for (const row of rows) out.push(await callback(row));
	return out;
}
