// Runs as requests for evidence: what a run accepts, what it requires, and the pure rules that turn evidence
// into a slot state and a verdict (decision 0008, items 3 and 4). No I/O here: the server folds, this decides.
import { z } from "zod";
import { MethodKind } from "./model.ts";

/**
 * Which targets count toward a run: one commit, or `self`. `self` counts only results typed into the run; it
 * proves nothing about a build. The server settles an abbreviated hash when the run is planned, so a stored
 * `commit` is the whole hash.
 */
export const TargetMatch = z.union([
	z.object({ commit: z.string().min(7), repo: z.string().optional(), env: z.string().optional() }),
	z.object({ self: z.literal(true) }),
]);
export type TargetMatch = z.infer<typeof TargetMatch>;

export const BasisRule = z.enum(["exact", "exact-or-assumed", "same-claim"]);
export type BasisRule = z.infer<typeof BasisRule>;

/** What a run needs before it is complete. Not a requirement in the tracker sense. */
export const Obligation = z.discriminatedUnion("kind", [
	z.object({
		id: z.string(),
		kind: z.literal("exercise"),
		/** Which producers may fill the slot. An agent is admitted only when named here. */
		methods: z.array(MethodKind).min(1),
		minActors: z.union([z.literal(1), z.literal(2)]),
		basis: BasisRule,
	}),
	/**
	 * Named CI jobs must each have an applied report on the run's target: a pipeline's report that ran something,
	 * not an agent's and not one of skips only. A `self` run cannot require a job.
	 */
	z.object({ id: z.string(), kind: z.literal("jobs"), jobs: z.array(z.string()).min(1) }),
]);
export type Obligation = z.infer<typeof Obligation>;
export type ExerciseObligation = Extract<Obligation, { kind: "exercise" }>;

export const Verdict = z.enum(["passed", "failed", "blocked", "pending"]);
export type Verdict = z.infer<typeof Verdict>;

/** The four verdicts are the four exit codes of `casebook gate` (commitment C2). */
export const EXIT_CODE: Record<Verdict, number> = { passed: 0, failed: 1, blocked: 2, pending: 3 };

export const Tally = z.object({
	/** Proven: a counted pass and nothing against it. */
	pass: z.number().int(),
	/** Failing, and a decision says it does not block (flaky, infrastructure, already failing on base). */
	excused: z.number().int(),
	/** Failing, and a decision says the target needs a fix. */
	attributed: z.number().int(),
	/** Failing, and nobody has decided why. */
	unexplained: z.number().int(),
	/** No counted evidence yet: an unfilled slot or a required job that has not reported. */
	missing: z.number().int(),
	/** A counted pass and a counted fail from different actors. */
	disputed: z.number().int(),
	/** The producer chose not to run it. Shown, never counted as proof. */
	skipped: z.number().int(),
});
export type Tally = z.infer<typeof Tally>;

export const emptyTally = (): Tally => ({
	pass: 0,
	excused: 0,
	attributed: 0,
	unexplained: 0,
	missing: 0,
	disputed: 0,
	skipped: 0,
});

/**
 * The gate. Reading it computes nothing beyond these comparisons.
 * - `pending`: evidence is missing, an accepted upload is not yet applied, or a decision it rests on has expired.
 * - `failed`: something is attributed to the target and needs a fix.
 * - `blocked`: a failure nobody has explained, a dispute, or an open question that blocks this run.
 * - `passed`: none of the above, and something was proven. Missing evidence is never green, and neither is a
 *   run with nothing counted at all: a report of skips only, or one whose every result was refused.
 */
export function verdict(input: { tally: Tally; blocking: number; outstanding: number; expired: boolean }): Verdict {
	const { tally } = input;
	if (input.outstanding > 0 || input.expired) return "pending";
	if (tally.attributed > 0) return "failed";
	if (tally.unexplained > 0 || tally.disputed > 0 || input.blocking > 0) return "blocked";
	if (tally.missing > 0 || tally.pass + tally.excused === 0) return "pending";
	return "passed";
}

/** One sentence for a person, and for the last line of `casebook gate`. */
export function explainVerdict(input: {
	tally: Tally;
	blocking: number;
	outstanding: number;
	expired: boolean;
}): string {
	const { tally } = input;
	const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
	if (input.outstanding > 0) return `pending: ${plural(input.outstanding, "report")} accepted and not yet applied`;
	if (input.expired) return "pending: a decision this run rests on has expired";
	if (tally.attributed > 0) return `failed: ${plural(tally.attributed, "failure")} attributed to this target`;
	if (tally.unexplained > 0 || tally.disputed > 0 || input.blocking > 0) {
		const parts = [];
		if (tally.unexplained > 0) parts.push(`${plural(tally.unexplained, "failure")} unexplained`);
		if (tally.disputed > 0) parts.push(`${plural(tally.disputed, "result")} disputed`);
		if (input.blocking > 0) parts.push(`${plural(input.blocking, "question")} open`);
		return `blocked: ${parts.join(", ")}`;
	}
	if (tally.missing > 0) return `pending: ${plural(tally.missing, "result")} missing`;
	if (tally.pass + tally.excused === 0) {
		return tally.skipped > 0
			? `pending: nothing was proven (${plural(tally.skipped, "result")} skipped)`
			: "pending: nothing has been proven yet";
	}
	return tally.pass === 0
		? `passed: ${plural(tally.excused, "failure")} excused by a decision, nothing else ran`
		: `passed: ${plural(tally.pass, "result")} proven`;
}

// ── Slots ──────────────────────────────────────────────────────────────────────────────────────────────────

export const SlotState = z.enum(["missing", "satisfied", "failing", "disputed", "waived", "skipped"]);
export type SlotState = z.infer<typeof SlotState>;

/**
 * Per producer, what its uncorrected results in the slot say. A producer is an actor using a method: a person's
 * own run of a case and the same person's upload of a pipeline's report are different evidence.
 */
export type SlotAgg = Record<
	string,
	{ actor: number; outcome: "pass" | "fail" | "skip" | "blocked"; result: number; seq: number }
>;

/** One uncorrected result admitted to a slot. */
export type SlotFill = {
	id: number;
	actor: number;
	method: MethodKind;
	test: number;
	/** Where and by which job it was reported: the target and the job. Results in different lanes never replace each other. */
	lane: string;
	attempt: number;
	seq: number;
	ord: number;
	outcome: "pass" | "fail" | "skip" | "blocked";
};

const LANE_WEIGHT: Record<string, number> = { fail: 3, error: 3, pass: 2, blocked: 1, skip: 0 };
const decides = (outcome: string): boolean => outcome === "pass" || outcome === "fail" || outcome === "error";

/**
 * The one rule for which result of a lane counts (a lane is one producer's results for one test from one job on
 * one target), read in the order they arrived. A slot is folded by this function; a commit's gate applies the
 * same rule as the condition of one SQL statement on a report, and `test/sequences.ts` checks the two agree.
 * A newer attempt is the producer running it again: it takes the place of the attempt before it, unless it
 * decided nothing (a skip, a blocked result) and the earlier one did. The same attempt reported twice is not a
 * re-run: the worse outcome stands, and a producer that was wrong says so with a correction. An older attempt
 * arriving late replaces nothing.
 */
export function replacesInLane(
	held: { attempt: number; outcome: string },
	next: { attempt: number; outcome: string },
): boolean {
	if (next.attempt > held.attempt) return decides(next.outcome) || !decides(held.outcome);
	return next.attempt === held.attempt && (LANE_WEIGHT[next.outcome] ?? 0) >= (LANE_WEIGHT[held.outcome] ?? 0);
}

/**
 * Folds the results admitted to a slot into one entry per producer, and lists every failure that still counts.
 * A producer may have several tests on one case, each reported by several jobs or in several environments. For
 * each test in each lane its latest decisive result counts: a higher attempt replaces the one before it, an old
 * attempt arriving late replaces nothing, the same attempt reported twice keeps the worse outcome, and a pass
 * in one job or environment never replaces a failure in another. A skip or a blocked result is not decisive: it never replaces a pass or a failure, and counts
 * only when the test has neither. The producer's entry is then the worst of its tests: any failing test makes it
 * a fail, whatever else passed. `failing` holds the result of every test that fails, from every producer, because
 * each may have its own cause and each cause needs its own answer.
 */
export function aggregateSlot(fills: readonly SlotFill[]): { agg: SlotAgg; failing: number[] } {
	const weight = { fail: 3, pass: 2, blocked: 1, skip: 0 } as const;
	const ordered = [...fills].sort((a, b) => a.seq - b.seq || a.ord - b.ord);
	const latest = new Map<string, SlotFill>();
	for (const fill of ordered) {
		const key = `${fill.actor}:${fill.method}:${fill.test}:${fill.lane}`;
		const held = latest.get(key);
		if (!held || replacesInLane(held, fill)) latest.set(key, fill);
	}
	const agg: SlotAgg = {};
	const failing: number[] = [];
	for (const fill of latest.values()) {
		if (fill.outcome === "fail") failing.push(fill.id);
		const key = `${fill.actor}:${fill.method}`;
		const held = agg[key];
		if (held && weight[held.outcome] >= weight[fill.outcome]) continue;
		agg[key] = { actor: fill.actor, outcome: fill.outcome, result: fill.id, seq: fill.seq };
	}
	return { agg, failing };
}

/**
 * A slot's state from every producer's entry. Disagreement between producers is `disputed` and is resolved by a
 * decision, never by the later write; one producer recording again is that producer changing its own answer.
 * `minActors` counts distinct actors with a pass.
 */
export function slotState(agg: SlotAgg, minActors: number): SlotState {
	const passed = new Set<number>();
	let fails = 0;
	let skips = 0;
	for (const entry of Object.values(agg)) {
		if (entry.outcome === "pass") passed.add(entry.actor);
		else if (entry.outcome === "fail") fails++;
		else skips++;
	}
	if (fails > 0) return passed.size > 0 ? "disputed" : "failing";
	if (passed.size >= minActors) return "satisfied";
	if (passed.size === 0 && skips > 0) return "skipped";
	return "missing";
}

export type Admitted = "exact" | "assumed" | "same-claim";

/**
 * The acceptance rule: does this result count toward this slot? Returns the rule that admitted it, or null.
 * 1. Basis: exact at the pinned version; or assumed at that version when the obligation allows it; or another
 *    version with the slot's claim hash when the obligation allows `same-claim`.
 * 2. Method: named by the obligation, and admitted by the case. A person and an agent are admitted when the
 *    case declares them; an automated test is admitted by its link or annotation (the caller adds `auto`), so
 *    whether a test fills the slot is the obligation's choice. An agent's result counts only where a run asked
 *    for it.
 * The target match (the run accepts the result's target) is checked by the caller, which knows the targets.
 */
export function qualifies(input: {
	result: {
		method: MethodKind;
		basis: "exact" | "assumed" | "unresolved";
		basisCase: number | null;
		basisVersion: number | null;
		basisClaim: string | null;
	};
	slot: { caseId: number; version: number; claim: string };
	obligation: ExerciseObligation;
	caseMethods: readonly MethodKind[];
}): Admitted | null {
	const { result, slot, obligation } = input;
	if (result.basis === "unresolved" || result.basisCase !== slot.caseId) return null;
	if (!obligation.methods.includes(result.method) || !input.caseMethods.includes(result.method)) return null;
	if (result.basisVersion === slot.version) {
		if (result.basis === "exact") return "exact";
		return obligation.basis === "exact" ? null : "assumed";
	}
	if (obligation.basis === "same-claim" && result.basisClaim === slot.claim) return "same-claim";
	return null;
}
