import { z } from "zod";
import {
	type AuditInput,
	type AuditRecord,
	type AuditReference,
	compareAuditRecords,
	encodeAudit,
} from "../../core/audit.ts";
import type { ActorKind, Kind } from "../../core/kinds.ts";
import type { TeamEvent } from "../../core/teams.ts";
import type { Ctx } from "../kernel/ctx.ts";
import { json, sql } from "../kernel/db.ts";
import { invalid } from "../kernel/errors.ts";

type Selection = { project: number; to: number };
type Question = {
	id: number;
	no: number;
	kind: Kind;
	fingerprint: string;
	prior: number | null;
	opened_at: number;
	opened_seq: number;
};
type Decision = {
	id: number;
	question: number;
	kind: Kind;
	answer: string;
	signers: string;
	basis: string;
	holds: string;
	effects: string;
	expires_at: number | null;
	on_evidence: string | null;
	supersedes: number | null;
	at: number;
	seq: number;
};
type Answer = {
	id: number;
	question: number;
	actor: number;
	answer: string;
	reason: string | null;
	on_evidence: string;
	counts: number;
	at: number;
	seq: number;
};
type Policy = {
	version: number;
	preset: string;
	clauses: string;
	settings: string;
	actor: number;
	decision: number | null;
	at: number;
	seq: number;
};
type Version = {
	case_id: number;
	case_no: number;
	no: number;
	parent: number | null;
	body: string;
	hash: string;
	claim_hash: string;
	decision: number;
	author: number;
	reason: string | null;
	at: number;
	seq: number;
};
type Result = Omit<Extract<AuditRecord, { type: "result" }>, "type" | "id" | "by"> & { id: number; actor: number };
type ChangeEnd = Omit<Extract<AuditRecord, { type: "change-end" }>, "type" | "id">;
type Team = { id: number; name: string; created_at: number };
type TeamChange = {
	id: number;
	at: number;
	by_actor: number;
	action: TeamEvent["action"];
	person: number | null;
	project: number | null;
	can: string | null;
};
const Q = {
	changeEnds: sql<Selection, ChangeEnd>(
		`SELECT e.change, c.key, c.repo, e.ended AS state, e.at FROM change_ends e
		 JOIN changes c ON c.id = e.change WHERE c.project = $project AND e.at < $to ORDER BY e.change`,
	),
	result: sql<{ project: number; id: number; to: number }, Result>(
		`SELECT r.id, r.at, r.seq, r.test, r.target, r.method, r.actor, r.outcome, r.signature,
		 t.commit_sha AS 'commit', t.repo, t.env, b.job
		 FROM results r JOIN targets t ON t.id = r.target JOIN batches b ON b.id = r.batch
		 WHERE r.project = $project AND r.id = $id AND r.at < $to`,
	),
	teams: sql<{ project: number }, Team>(
		`SELECT t.id, t.name, t.created_at FROM teams t
		 WHERE t.org = (SELECT org FROM projects WHERE id = $project) AND (
		 EXISTS (SELECT 1 FROM team_grants g WHERE g.team = t.id AND g.project IN (0, $project)) OR
		 EXISTS (SELECT 1 FROM team_events e WHERE e.team = t.id AND e.project IN (0, $project))) ORDER BY t.id`,
	),
	teamMembers: sql<{ team: number }, { actor: number }>(
		"SELECT actor FROM team_members WHERE team = $team ORDER BY actor",
	),
	teamGrants: sql<{ team: number; project: number }, { project: number; can: string }>(
		"SELECT project, can FROM team_grants WHERE team = $team AND project IN (0, $project) ORDER BY project",
	),
	teamEvents: sql<{ team: number; project: number; to: number }, TeamChange>(
		`SELECT * FROM team_events WHERE team = $team AND at < $to
		 AND (project IS NULL OR project IN (0, $project)) ORDER BY id`,
	),
	questions: sql<Selection, Question>(
		"SELECT id, no, kind, fingerprint, prior, opened_at, seen_first AS opened_seq FROM questions WHERE project = $project AND opened_at < $to ORDER BY id",
	),
	decisions: sql<Selection, Decision>(
		"SELECT id, question, kind, answer, signers, basis, on_evidence, holds, effects, expires_at, supersedes, at, seq FROM decisions WHERE project = $project AND at < $to ORDER BY id",
	),
	answers: sql<Selection, Answer>(
		"SELECT a.* FROM answers a JOIN questions q ON q.id = a.question WHERE q.project = $project AND a.at < $to ORDER BY a.id",
	),
	policies: sql<Selection, Policy>("SELECT * FROM policies WHERE project = $project AND at < $to ORDER BY version"),
	versions: sql<Selection, Version>(
		"SELECT v.*, c.no AS case_no FROM versions v JOIN cases c ON c.id = v.case_id WHERE c.project = $project AND v.at < $to ORDER BY v.case_id, v.no",
	),
	actor: sql<{ id: number }, { id: number; name: string; kind: ActorKind }>(
		"SELECT id, name, kind FROM actors WHERE id = $id",
	),
};
const Signers = z.array(
	z.strictObject({ by: z.number().int(), clause: z.string(), policy: z.number().int(), reason: z.string().nullable() }),
);
const InheritedEffects = z.object({
	inherited: z.array(z.object({ result: z.number().int(), base: z.array(z.number().int()).min(1) })).default([]),
});

/** Called only inside the registry's read snapshot, with that snapshot's project and authorization. */
export function exportAudit(ctx: Ctx, input: AuditInput) {
	const to = input.to ?? ctx.now + 1;
	if (to > ctx.now + 1 || to <= input.from)
		throw invalid("audit needs from < to <= the server's current time plus one millisecond");
	const selection = { project: ctx.project.id, to };
	const questions = new Map(ctx.db.all(Q.questions, selection).map((row) => [row.id, row]));
	const decisions = new Map(ctx.db.all(Q.decisions, selection).map((row) => [row.id, row]));
	const policies = ctx.db.all(Q.policies, selection);
	const versions = ctx.db.all(Q.versions, selection);
	const records: AuditRecord[] = [];
	const contexts = new Map<string, AuditRecord>();
	const inRange = (at: number) => at >= input.from;
	const included = (id: string): AuditReference => ({ scope: "included", id });
	const reference = (id: string, at: number | undefined): AuditReference => {
		if (at === undefined)
			throw invalid(
				`audit reference ${id} is outside the selected time range or missing; widen --to to include its predecessor`,
			);
		return at < input.from ? { scope: "before-range", id, at } : included(id);
	};
	const actor = (id: number) => {
		const row = ctx.db.get(Q.actor, { id });
		if (!row) throw invalid(`audit actor ${id} is missing`);
		return row;
	};
	const question = (id: number): AuditReference => {
		let next: number | null = id;
		while (next !== null) {
			const key = `question:${next}`;
			if (contexts.has(key)) break;
			const row = questions.get(next);
			if (!row)
				throw invalid(
					`audit question ${next} is outside the selected time range or missing; widen --to to include its opening`,
				);
			contexts.set(key, {
				type: "question",
				id: key,
				ref: `Q-${row.no}`,
				openedAt: row.opened_at,
				openedSeq: row.opened_seq,
				kind: row.kind,
				fingerprint: row.fingerprint,
				prior: row.prior === null ? null : included(`question:${row.prior}`),
			});
			next = row.prior;
		}
		return included(`question:${id}`);
	};
	const evidence = (q: number, hash: string) => {
		const id = `evidence:${q}:${hash}`;
		contexts.set(id, { type: "evidence", id, question: question(q), hash });
		return { state: "recorded", hash, ref: included(id) } satisfies Extract<
			AuditRecord,
			{ type: "answer" }
		>["evidence"];
	};
	const result = (id: number): AuditReference => {
		const key = `result:${id}`;
		if (!contexts.has(key)) {
			const row = ctx.db.get(Q.result, { ...selection, id });
			if (!row) throw invalid(`audit result ${id} is missing or outside the range; widen --to`);
			const { actor: by, ...rest } = row;
			contexts.set(key, { ...rest, type: "result", id: key, by: actor(by) });
		}
		return included(key);
	};
	for (const row of decisions.values()) {
		if (!inRange(row.at)) continue;
		const effects = json<unknown>(row.effects);
		records.push({
			type: "decision",
			id: `decision:${row.id}`,
			at: row.at,
			seq: row.seq,
			question: question(row.question),
			kind: row.kind,
			prior:
				row.supersedes === null ? null : reference(`decision:${row.supersedes}`, decisions.get(row.supersedes)?.at),
			answer: json(row.answer),
			basis: row.basis,
			holds: json(row.holds),
			effects: json(row.effects),
			inherited: InheritedEffects.parse(effects).inherited.map((item) => ({
				result: result(item.result),
				base: item.base.map(result),
			})),
			expiresAt: row.expires_at,
			evidence: row.on_evidence === null ? { state: "not-recorded" } : evidence(row.question, row.on_evidence),
			signers: Signers.parse(json<unknown>(row.signers)).map((signer) => ({ ...signer, by: actor(signer.by) })),
		});
	}
	for (const team of ctx.db.all(Q.teams, { project: selection.project })) {
		const key = `team:${team.id}`;
		contexts.set(key, {
			type: "team",
			id: key,
			name: team.name,
			createdAt: team.created_at,
			members: ctx.db.all(Q.teamMembers, { team: team.id }).map((row) => actor(row.actor)),
			grants: ctx.db
				.all(Q.teamGrants, { team: team.id, project: selection.project })
				.map((row) => ({ project: row.project === 0 ? "*" : ctx.project.key, can: json(row.can) })),
		});
		for (const row of ctx.db.all(Q.teamEvents, { ...selection, team: team.id })) {
			if (!inRange(row.at)) continue;
			records.push({
				type: "team-event",
				id: `team-event:${row.id}`,
				at: row.at,
				team: included(key),
				by: actor(row.by_actor),
				action: row.action,
				person: row.person === null ? null : actor(row.person),
				project: row.project === null ? null : row.project === 0 ? "*" : ctx.project.key,
				can: row.can === null ? null : json(row.can),
			});
		}
	}
	for (const row of ctx.db.all(Q.answers, selection)) {
		if (!inRange(row.at)) continue;
		records.push({
			type: "answer",
			id: `answer:${row.id}`,
			at: row.at,
			seq: row.seq,
			question: question(row.question),
			by: actor(row.actor),
			answer: json(row.answer),
			reason: row.reason,
			counts: row.counts !== 0,
			evidence: evidence(row.question, row.on_evidence),
		});
	}
	const policyIndex = new Map(policies.map((row) => [row.version, row]));
	for (const row of policies) {
		if (!inRange(row.at)) continue;
		records.push({
			type: "policy",
			id: `policy:${row.version}`,
			version: row.version,
			at: row.at,
			seq: row.seq,
			by: actor(row.actor),
			prior: row.version === 1 ? null : reference(`policy:${row.version - 1}`, policyIndex.get(row.version - 1)?.at),
			decision: row.decision === null ? null : reference(`decision:${row.decision}`, decisions.get(row.decision)?.at),
			preset: row.preset,
			clauses: json(row.clauses),
			settings: json(row.settings),
		});
	}
	const versionIndex = new Map(versions.map((row) => [`version:${row.case_id}:${row.no}`, row]));
	for (const row of versions) {
		if (!inRange(row.at)) continue;
		const parent = row.parent === null ? null : `version:${row.case_id}:${row.parent}`;
		records.push({
			type: "case-version",
			id: `version:${row.case_id}:${row.no}`,
			caseId: row.case_id,
			case: `C-${row.case_no}`,
			version: row.no,
			at: row.at,
			seq: row.seq,
			by: actor(row.author),
			reason: row.reason,
			body: json(row.body),
			hash: row.hash,
			claimHash: row.claim_hash,
			parent: parent === null ? null : reference(parent, versionIndex.get(parent)?.at),
			decision: reference(`decision:${row.decision}`, decisions.get(row.decision)?.at),
		});
	}
	for (const row of ctx.db.all(Q.changeEnds, selection)) {
		if (inRange(row.at)) records.push({ type: "change-end", id: `change-end:${row.change}`, ...row });
	}
	return encodeAudit(
		{
			mainworthy: "audit",
			format: 1,
			project: ctx.project.key,
			from: input.from,
			to,
			exportedAt: ctx.now,
			seq: ctx.seq,
			grantChanges: "team-history-only",
			teamState: "at-export",
			evidencePayloads: "not-retained",
			actorNames: "at-export",
		},
		[...contexts.values(), ...records].sort(compareAuditRecords),
	);
}
