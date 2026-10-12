// The project's policy: a versioned clause table. Owns the table `policies`.
// Reading is open to every module; the only writer is the effect of an `adopt` decision (see suite/adopt).
import { type Clause, type Facts, firstMatch, type Kind, Policy } from "../../core/kinds.ts";
import { missingCatchAll, PRESETS, type PresetName } from "../../core/presets.ts";
import type { Ctx } from "../kernel/ctx.ts";
import { type Db, json, sql } from "../kernel/db.ts";
import { invalid } from "../kernel/errors.ts";
import { decisionOf, type Witness } from "../kernel/witness.ts";

type PolicyRow = { project: number; version: number; preset: string; clauses: string; settings: string };

const Q = {
	current: sql<{ project: number }, PolicyRow>(
		"SELECT project, version, preset, clauses, settings FROM policies WHERE project = $project ORDER BY version DESC LIMIT 1",
	),
	insert: sql<{
		project: number;
		version: number;
		preset: string;
		clauses: string;
		settings: string;
		actor: number;
		decision: number | null;
		at: number;
		seq: number;
	}>(
		`INSERT INTO policies (project, version, preset, clauses, settings, actor, decision, at, seq)
		 VALUES ($project, $version, $preset, $clauses, $settings, $actor, $decision, $at, $seq)`,
	),
};

export type CurrentPolicy = Policy & { version: number };

export function currentPolicy(db: Db, project: number): CurrentPolicy {
	const row = db.get(Q.current, { project });
	if (!row) throw new Error(`project ${project} has no policy`);
	return { version: row.version, preset: row.preset, clauses: json(row.clauses), settings: json(row.settings) };
}

/** The clause that owns a question. A policy is checked for totality when written, so this always finds one. */
export function clauseFor(policy: Policy, facts: Facts): Clause {
	const clause = firstMatch(policy.clauses, facts);
	if (!clause) throw new Error(`policy ${policy.preset} has no clause for a ${facts.kind} question`);
	return clause;
}

export const isPreset = (name: string): name is PresetName => name in PRESETS;

/** Builds the policy an edit asks for and refuses one that would leave a kind of question unowned. */
export function resolvePolicy(
	current: Policy,
	change: { preset?: string | undefined; clauses?: Clause[] | undefined; settings?: Policy["settings"] | undefined },
): Policy {
	let next: Policy = current;
	if (change.preset !== undefined) {
		if (!isPreset(change.preset))
			throw invalid(`unknown preset ${change.preset}; one of ${Object.keys(PRESETS).join(", ")}`);
		next = PRESETS[change.preset];
	}
	if (change.clauses !== undefined) next = { ...next, preset: change.preset ?? "custom", clauses: change.clauses };
	if (change.settings !== undefined) next = { ...next, settings: change.settings };
	const parsed = Policy.safeParse(next);
	if (!parsed.success) throw invalid("policy is not valid", { issues: parsed.error.issues });
	const missing: Kind[] = missingCatchAll(parsed.data.clauses);
	if (missing.length > 0) {
		throw invalid(`every kind must end with a clause that always matches; missing for: ${missing.join(", ")}`);
	}
	return parsed.data;
}

/** The first policy of a new project. Not a decision: there is no earlier standing to change. */
export function seedPolicy(ctx: Ctx, preset: PresetName): void {
	const policy = PRESETS[preset];
	ctx.db.run(Q.insert, {
		project: ctx.project.id,
		version: 1,
		preset: policy.preset,
		clauses: JSON.stringify(policy.clauses),
		settings: JSON.stringify(policy.settings),
		actor: ctx.actor.id,
		decision: null,
		at: ctx.now,
		seq: ctx.seq,
	});
}

/** Puts a policy in force. Standing: callable only with the witness of the decision that adopted it. */
export function writePolicy(ctx: Ctx, witness: Witness, policy: Policy): number {
	const version = currentPolicy(ctx.db, ctx.project.id).version + 1;
	ctx.db.run(Q.insert, {
		project: ctx.project.id,
		version,
		preset: policy.preset,
		clauses: JSON.stringify(policy.clauses),
		settings: JSON.stringify(policy.settings),
		actor: witness.signers[0] ?? ctx.actor.id,
		decision: decisionOf(witness, "adopt"),
		at: ctx.now,
		seq: ctx.seq,
	});
	return version;
}
