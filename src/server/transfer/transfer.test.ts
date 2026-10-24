import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { writerDatabase } from "../../../test/pg-scopes.ts";
import { seed } from "../../cli/seed.ts";
import { withInstance } from "../../cli/test-support.ts";

async function harness(...args: Parameters<typeof import("../../../test/helpers.ts")["harness"]>) {
	return (await import("../../../test/helpers.ts")).harness(...args);
}

import { PRESETS } from "../../core/presets.ts";
import { signatureHash } from "../../core/signature.ts";
import { type BlobStore, memoryBlobs } from "../kernel/blobs.ts";
import type { ReadDb, WriteDb } from "../kernel/db.ts";
import { OpError } from "../kernel/errors.ts";
import { ARCHIVE_VERSION, SCHEMA_VERSION } from "../kernel/migrate.ts";
import {
	exportArchive as exportWithBlobs,
	importArchive as importWithBlobs,
	linesOf,
	linesOfStream,
	removeBootstrap,
	removeProject,
	removeProjectSlice,
	UNEXPORTED,
} from "./transfer.ts";

// Completion checks use real migrated SQLite databases: compare every stored column, query rebuilt FTS,
// compare the target before/after rejected input, and time actual export/import of 50,000 result rows.
type Value = string | number | bigint | null;
type Row = Record<string, Value>;
const stores = new WeakMap<ReadDb, BlobStore>();
const attachmentBytes = Buffer.from("archive attachment");
function storage(db: ReadDb): BlobStore {
	let store = stores.get(db);
	if (!store) {
		store = memoryBlobs();
		stores.set(db, store);
	}
	return store;
}
function exportArchive(db: ReadDb, write: (chunk: string) => void, options: { now?: number; project?: string } = {}) {
	return exportWithBlobs(db, write, { ...options, blobs: storage(db) });
}
async function importArchive(db: WriteDb, lines: Iterable<string>) {
	return await importWithBlobs(db, lines, { blobs: storage(db) });
}

const time = 1_791_741_600_000;
const body = `{
  "title": "雪だるま ☃ café", "pre": "Précondition 雪", "methods": ["human", "auto"],
  "automate": "wanted", "steps": [
    {"id": "sone", "action": "Inspect nebulouswidget", "expected": "A luminousreply appears"},
    {"id": "stwo", "action": "Leave empty", "expected": null}
  ], "fields": {}
}`;

const fixtures: Record<string, Row[]> = {
	quarantines: [
		{
			project: 23,
			test: 501,
			decision: 401,
			actor: 71,
			reason: "Intermittent checkout",
			exit_rule: '{"kind":"passes","count":3}',
			at: time,
			seq: 1,
		},
	],
	attachments: [
		{
			id: 901,
			result: 201,
			name: "proof.txt",
			hash: createHash("sha256").update(attachmentBytes).digest("hex"),
			size: attachmentBytes.length,
			type: "application/octet-stream",
			at: "sone",
		},
	],
	meta: [{ key: "instance-note", value: "  canonical text\n雪 ☃  " }],
	orgs: [{ id: 17, name: "Archive organisation", created_at: time }],
	actors: [
		{ id: 71, org: 17, kind: "human", name: "Zoë 雪", on_behalf_of: null, created_at: time, disabled_at: null },
		{ id: 70, org: 17, kind: "agent", name: "Agent", on_behalf_of: 71, created_at: time, disabled_at: time + 1 },
	],
	mail_contacts: [{ actor: 71, email: "zoe@example.com", verified_at: time, revision: "contact-revision" }],
	grants: [
		{ actor: 71, project: 23, can: '[ "read", "admin" ]', roles: '["approver","auditor"]' },
		{ actor: 71, project: 0, can: '["read"]' },
	],
	teams: [{ id: 91, org: 17, name: "Quality 雪", created_at: time }],
	team_members: [{ team: 91, actor: 71 }],
	team_grants: [{ team: 91, project: 23, can: '[ "read", "produce" ]' }],
	team_events: [
		{
			id: 92,
			team: 91,
			by_actor: 71,
			at: time,
			action: "grant.set",
			person: null,
			project: 23,
			can: '[ "read", "produce" ]',
		},
	],
	projects: [
		{
			identity: "identity-qa",
			id: 23,
			org: 17,
			key: "qa",
			name: "雪 project",
			seq: Number.MAX_SAFE_INTEGER,
			created_at: time,
		},
	],
	counters: [
		{ project: 23, name: "version", value: 9_223_372_036_854_775_807n },
		{ project: 23, name: "case", value: -9_223_372_036_854_775_808n },
	],
	commands: [
		{
			id: "cmd-雪",
			project: 23,
			op: "propose",
			actor: 71,
			at: time,
			seq: 1,
			touched: '[ "C-1" ]',
			outcome: "{}",
			request: "0f1e2d",
		},
	],
	folders: [
		{ id: 43, project: 23, parent: null, name: "", rank: "a0", state: "active", rev: 1 },
		{ id: 42, project: 23, parent: 43, name: "Nested 雪", rank: "a1", state: "archived", rev: 2 },
	],
	cases: [
		{
			id: 101,
			project: 23,
			no: 1,
			head: 2,
			head_hash: "head-hash",
			claim_hash: "claim-hash",
			title: "雪だるま ☃ café",
			methods: '[ "human", "auto" ]',
			automate: "wanted",
			step_count: 2,
			folder: 42,
			rank: "a0",
			tags: '[ "café", "雪", "regression" ]',
			state: "archived",
			aliases: '[ "C1234" ]',
			created_by: 71,
			created_at: time,
			updated_by: 70,
			updated_at: time + 1,
			rev: 2,
		},
	],
	case_tags: [{ project: 23, tag: "雪", case_id: 101 }],
	case_aliases: [{ project: 23, alias: "C1234", case_id: 101 }],
	versions: [
		{
			case_id: 101,
			no: 2,
			parent: 1,
			body,
			hash: "head-hash",
			claim_hash: "claim-hash",
			proposal: 301,
			decision: 401,
			author: 70,
			reason: "",
			at: time + 1,
			seq: 2,
		},
		{
			case_id: 101,
			no: 1,
			parent: null,
			body: '{"title":"Old title","pre":"","steps":[],"methods":["human"],"automate":"none","fields":{}}',
			hash: "old-hash",
			claim_hash: "old-claim",
			proposal: 301,
			decision: 401,
			author: 71,
			reason: null,
			at: time,
			seq: 1,
		},
	],
	placements: [
		{
			id: 303,
			case_id: 101,
			before: '{ "folder": 43 }',
			after: '{ "folder": 42 }',
			proposal: 301,
			decision: 401,
			actor: 70,
			at: time,
			seq: 2,
		},
	],
	proposals: [
		{ id: 301, project: 23, no: 1, author: 71, reason: null, edits: "[]", resolved: "[]", cause: "", at: time, seq: 1 },
	],
	requirements: [{ id: 302, project: 23, key: "REQ-雪", title: "", source: null, state: "active", rev: 1 }],
	covers: [{ requirement: 302, case_id: 101, decision: 401 }],
	tests: [
		{
			id: 501,
			project: 23,
			no: 1,
			kind: "auto",
			key: "test.ts::suite::雪",
			name: "",
			file: null,
			case_id: 101,
			first_seq: 1,
			last_seq: 2,
		},
	],
	targets: [
		{
			id: 502,
			project: 23,
			what: "session:雪",
			env: "",
			repo: null,
			commit_sha: null,
			branch: null,
			line: "session",
			change: null,
			first_seq: 1,
		},
	],
	artifacts: [
		{
			id: 510,
			project: 23,
			digest: `sha256:${"a".repeat(64)}`,
			code: JSON.stringify([{ repo: "acme/web", commit: "1".repeat(40) }]),
			actor: 71,
			at: time,
			seq: 1,
		},
	],
	builds: [{ id: 511, project: 23, label: "release-雪", artifact: 510, seq: 1 }],
	deployments: [{ id: 512, project: 23, build: 511, env: "staging", actor: 71, at: time + 1, seq: 2 }],
	changes: [
		{
			id: 503,
			project: 23,
			key: "change-one",
			repo: null,
			base_sha: null,
			head_sha: null,
			head_observed_seq: 2,
			branch: "",
			title: "",
			url: null,
			files: '[ "test.ts" ]',
			rev: 1,
		},
	],
	batches: [
		{
			id: 504,
			project: 23,
			key: "upload-one",
			nothing_required: 1,
			target: 502,
			job: "",
			attempt: 1,
			method: "auto",
			actor: 71,
			run: 601,
			build_url: null,
			state: "accepted",
			counts: '{ "pass": 1 }',
			staged: "[]",
			receipt: null,
			at: time,
			seq: 1,
		},
	],
	signatures: [
		{
			id: 505,
			project: 23,
			hash: signatureHash({ class: "assertion", text: "雪 expected" }),
			class: "assertion",
			text: "雪 expected",
			first_seq: 1,
		},
	],
	results: [
		{
			id: 201,
			project: 23,
			test: 501,
			seq: 1,
			ord: 0,
			batch: 504,
			target: 502,
			method: "auto",
			actor: 71,
			basis: "exact",
			basis_case: 101,
			basis_version: 2,
			basis_claim: "claim-hash",
			outcome: "fail",
			attempt: 1,
			duration_ms: 2_592_000_000,
			signature: 505,
			message: "雪\nfailed",
			detail: "",
			at_step: "s-one",
			trail: '[ { "step": "s-one", "outcome": "fail" } ]',
			note: null,
			run: 601,
			corrects: null,
			at: time,
		},
		{
			id: 200,
			project: 23,
			test: 501,
			seq: 2,
			ord: 1,
			batch: 504,
			target: 502,
			method: "human",
			actor: 70,
			basis: "assumed",
			basis_case: 101,
			basis_version: 2,
			basis_claim: "claim-hash",
			outcome: "pass",
			attempt: 2,
			duration_ms: null,
			signature: null,
			message: "",
			detail: null,
			at_step: null,
			trail: null,
			note: "é",
			run: null,
			corrects: 201,
			at: time + 1,
		},
	],
	result_tries: [
		{
			id: 513,
			project: 23,
			result: 200,
			try: 1,
			outcome: "fail",
			duration_ms: 3,
			signature: 505,
			message: "雪 expected",
			detail: null,
		},
	],
	flips: [
		{
			id: 506,
			project: 23,
			test: 501,
			target: 502,
			first_result: 201,
			second_result: 200,
			first_try: null,
			second_try: 513,
			seq: 2,
		},
	],
	findings: [
		{
			id: 507,
			project: 23,
			actor: 70,
			lens: "security",
			locus: "step:s-one",
			case_id: 101,
			category: "gap",
			note: "雪",
			repro: "",
			suggest: null,
			basis: '{ "version": 2 }',
			question: 402,
			at: time,
			seq: 1,
		},
	],
	reviews: [
		{
			id: 508,
			project: 23,
			reviewer: 70,
			lens: "security",
			case_id: 101,
			version: 2,
			basis: '{ "version": 2 }',
			about: null,
			at: time,
			seq: 1,
		},
	],
	result_excuses: [{ result: 201, decision: 401, class: "excused", expires_at: null }],
	excuses: [{ project: 23, signature: 505, scope: "line:trunk", decision: 401, class: "excused" }],
	questions: [
		{
			id: 402,
			project: 23,
			no: 1,
			kind: "adopt",
			subject: "P-1",
			fingerprint: "fingerprint-one",
			epoch: 0,
			prior: null,
			title: "雪 decision",
			producer: "agent",
			evidence: "{}",
			evidence_hash: "evidence-hash",
			basis: "basis-hash",
			seen_count: 1,
			seen_first: time,
			seen_last: time,
			carried: 0,
			ask: '[ "accept" ]',
			blocks: "[]",
			owner: 71,
			rank: 0,
			state: "decided",
			decision: 401,
			opened_at: time,
			rev: 2,
		},
	],
	question_refs: [{ project: 23, ref: "C-1", question: 402 }],
	answers: [
		{
			id: 403,
			question: 402,
			actor: 71,
			answer: "accept",
			reason: null,
			on_evidence: "evidence-hash",
			counts: 1,
			at: time,
			seq: 2,
		},
	],
	decisions: [
		{
			id: 401,
			project: 23,
			question: 402,
			kind: "adopt",
			answer: "accept",
			signers: '[ "Zoë 雪" ]',
			basis: "{}",
			holds: "{}",
			expires_at: null,
			supersedes: null,
			effects: '{ "adopt": 301 }',
			at: time,
			seq: 2,
		},
	],
	policies: [
		{
			project: 23,
			version: 1,
			preset: "standard",
			clauses: JSON.stringify(PRESETS.standard.clauses),
			settings: JSON.stringify({ ...PRESETS.standard.settings, named: "雪" }),
			actor: 71,
			decision: null,
			at: time,
			seq: 1,
		},
	],
	runs: [
		{
			id: 601,
			project: 23,
			no: 1,
			name: "雪 run",
			origin: "planned",
			accepts: "{}",
			accepts_what: null,
			require: "[]",
			change: 503,
			state: "closed",
			signoff: 401,
			accepted_seq: 2,
			applied_seq: 1,
			outstanding: 1,
			next_expiry: null,
			quarantined: 0,
			tally: "{}",
			blocking: "[]",
			verdict: "pending",
			created_by: 71,
			created_at: time,
			rev: 2,
		},
	],
	run_tests: [
		{
			run: 601,
			test: 501,
			result: 200,
			outcome: "pass",
			signature: null,
			attempt: 2,
			flipped: 1,
			lane: "502:e2e:2",
			target: 502,
		},
	],
	slots: [
		{
			id: 602,
			run: 601,
			case_id: 101,
			version: 2,
			claim: "claim-hash",
			obligation: "exercise",
			assignee: null,
			rank: 0,
			agg: '{ "71": { "passes": 1 } }',
			state: "waived",
			signature: 505,
			waiver: 401,
			rev: 2,
		},
	],
	slot_results: [{ slot: 602, result: 201, run: 601, admitted: "exact", corrected: 1 }],
	depends_on: [{ run: 601, decision: 401, expires_at: null }],
};

const opened: (WriteDb & AsyncDisposable)[] = [];
async function database(): Promise<WriteDb> {
	const db = await writerDatabase();
	opened.push(db);
	return db;
}
afterEach(async () => {
	for (const db of opened.splice(0)) await db[Symbol.asyncDispose]();
});

function identifier(name: string): string {
	return `"${name.replaceAll('"', '""')}"`;
}

async function insert(db: WriteDb, table: string, row: Row): Promise<void> {
	const columns = Object.keys(row);
	await db.transaction(() =>
		db.runDynamic(
			`INSERT INTO ${identifier(table)} (${columns.map(identifier).join(", ")}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(", ")})`,
			Object.values(row),
		),
	);
}

async function source(): Promise<WriteDb> {
	const db = await database();
	storage(db).put(attachmentBytes);
	await db.transaction(async () => {
		await db.transaction(() => db.exec("SET CONSTRAINTS ALL DEFERRED"));
		for (const [table, rows] of Object.entries(fixtures)) {
			for (const row of rows) await insert(db, table, row);
		}
		await insert(db, "tokens", {
			id: 900,
			actor: 71,
			hash: "synthetic-source-credential-hash",
			label: "test",
			created_at: time,
		});
		await db.transaction(() =>
			db.runDynamic("INSERT INTO search_docs (id, title, body, tags, project) VALUES ($1, $2, $3, $4, $5)", [
				101,
				"stale title",
				"obsoleteindexword",
				"stale",
				23,
			]),
		);
	});
	return db;
}

async function target(): Promise<WriteDb> {
	const db = await database();
	await insert(db, "orgs", { id: 1, name: "default", created_at: time });
	await insert(db, "actors", { id: 1, org: 1, kind: "human", name: "bootstrap owner", created_at: time });
	await insert(db, "actors", { id: 2, org: 1, kind: "rule", name: "bootstrap rule", created_at: time });
	await insert(db, "grants", { actor: 1, project: 0, can: '["admin"]' });
	await insert(db, "tokens", {
		id: 1,
		actor: 1,
		hash: "synthetic-target-credential-hash",
		label: "bootstrap",
		created_at: time,
	});
	await insert(db, "meta", { key: "bootstrap-note", value: "unchanged on refusal" });
	await db.transaction(() =>
		db.runDynamic(
			"INSERT INTO search_docs (id, title, body, tags, project) VALUES (1, '', 'bootstrapindexword', '', 0)",
			[],
		),
	);
	return db;
}

async function archive(db: ReadDb, now = time): Promise<string> {
	const chunks: string[] = [];
	await exportArchive(db, (chunk) => chunks.push(chunk), { now });
	return chunks.join("");
}

async function tables(db: ReadDb): Promise<string[]> {
	return (await db.catalog()).map((table) => table.name).sort();
}
async function exportedTables(db: ReadDb): Promise<string[]> {
	return (await tables(db)).filter((name) => !UNEXPORTED.includes(name) && name !== "search_docs");
}
async function dump(db: ReadDb): Promise<Record<string, string[]>> {
	const result: Record<string, string[]> = {};
	for (const table of await db.catalog()) {
		if (UNEXPORTED.includes(table.name) || table.name === "search_docs") continue;
		const columns = table.columns.filter(
			(column) => column.generated !== "stored" && !(table.name === "actors" && column.name === "auth_version"),
		);
		const fields = columns.flatMap((column) => [`'${column.name.replaceAll("'", "''")}'`, identifier(column.name)]);
		const filter =
			table.name === "meta" ? "WHERE key NOT IN ('schema_version', 'baseline_hash', 'archive_version')" : "";
		result[table.name] = (
			await db.allDynamic<{ row: string }>(
				`SELECT json_build_object(${fields.join(", ")})::text AS row FROM ${identifier(table.name)} ${filter} ORDER BY ${table.primary.map(identifier).join(", ")}`,
			)
		).map((row) => JSON.stringify(JSON.parse(row.row)));
	}
	return result;
}
async function allRows(db: ReadDb): Promise<Record<string, unknown[]>> {
	const result: Record<string, unknown[]> = {};
	for (const table of await db.catalog())
		result[table.name] = await db.allDynamic(
			`SELECT row_to_json(t)::text AS row FROM ${identifier(table.name)} t ORDER BY ${table.primary.map(identifier).join(", ")}`,
		);
	return result;
}

function rehash(text: string): string {
	const lines = [...linesOf(text)];
	lines.pop();
	const preceding = `${lines.join("\n")}\n`;
	const rows = lines.filter((line) => line.startsWith('{"t":')).length;
	return `${preceding}${JSON.stringify({ end: true, rows, sha256: createHash("sha256").update(preceding).digest("hex") })}\n`;
}

async function refuse(text: string, message: string | RegExp): Promise<void> {
	const db = await target();
	const before = await allRows(db);
	await expect(importArchive(db, linesOf(text))).rejects.toThrow(message);
	expect(await allRows(db)).toEqual(before);
	expect(db.inTransaction).toBe(false);
}

test("archives wait for retired demo cleanup instead of restoring retired data without its mark", async () => {
	await withInstance(async ({ instance }) => {
		const { refreshDemo, drainRetiredDemos } = await import("../../cli/demo.ts");
		const { app } = instance;
		app.config.commit = "a".repeat(40);
		await refreshDemo(instance, "demo", { cases: 12, days: 0, unlinkedFiles: 0 });
		app.config.commit = "b".repeat(40);
		await refreshDemo(instance, "demo", { cases: 12, days: 0, unlinkedFiles: 0 });

		let bytes = 0;
		await expect(
			instance.app.database.read((db) =>
				exportWithBlobs(
					db,
					(chunk) => {
						bytes += chunk.length;
					},
					{ blobs: app.blobs },
				),
			),
		).rejects.toThrow("retired demo cleanup");
		expect(bytes).toBe(0);
		expect(
			(await app.database.read((db) => exportWithBlobs(db, () => {}, { project: "demo", blobs: app.blobs }))).rows,
		).toBeGreaterThan(0);
		await drainRetiredDemos(instance);
		expect((await app.database.read((db) => exportWithBlobs(db, () => {}, { blobs: app.blobs }))).rows).toBeGreaterThan(
			0,
		);
	});
}, 30_000);

describe("Mainworthy instance archives", () => {
	test("an archive preserves legacy corrections that branch from the same result", async () => {
		const from = await source();
		await insert(from, "results", { ...fixtures.results?.[1], id: 202, outcome: "blocked" });
		const to = await target();
		await importArchive(to, linesOf(await archive(from)));
		expect(
			await to.allDynamic<Record<string, unknown>>("SELECT id, corrects, outcome FROM results ORDER BY id", []),
		).toEqual([
			{ id: 200, corrects: 201, outcome: "pass" },
			{ id: 201, corrects: null, outcome: "fail" },
			{ id: 202, corrects: 201, outcome: "blocked" },
		]);
	});

	test("a project archive keeps every head, decision and verdict and excludes other projects", async () => {
		const from = await source();
		const selectedSettings = JSON.stringify({
			...PRESETS.standard.settings,
			named: "雪",
			fields: { risk: { kind: "choice", label: "Risk", required: true, choices: ["low", "high"] } },
		});
		await from.transaction(() =>
			from.runDynamic("UPDATE policies SET settings = $1 WHERE project = 23", [selectedSettings]),
		);
		const expected = await dump(from);
		await from.transaction(() =>
			from.exec(`
			INSERT INTO orgs VALUES (18, 'Unrelated organisation', 1);
			INSERT INTO actors VALUES (80, 18, 'human', 'Unrelated person', NULL, 1, NULL);
			INSERT INTO projects VALUES (24, 18, 'other', 'Unrelated project', 1, 1, 'identity-other');
			INSERT INTO folders VALUES (44, 24, NULL, 'Private folder', 'a0', 'active', 1);
			INSERT INTO grants (actor, project, can) VALUES (80, 24, '["admin"]');
			INSERT INTO mail_contacts VALUES (80, 'unrelated@example.com', NULL, 'other-revision');
			INSERT INTO actors VALUES (81, 17, 'human', 'Other project only', NULL, 1, NULL);
			INSERT INTO grants (actor, project, can) VALUES (81, 24, '["read"]');
		`),
		);
		const otherSettings = JSON.stringify({
			...PRESETS.standard.settings,
			fields: { other_only: { kind: "text", label: "Private field", required: false } },
		});
		await insert(from, "policies", { ...fixtures.policies?.[0], project: 24, settings: otherSettings, actor: 80 });
		const chunks: string[] = [];
		await exportArchive(from, (chunk) => chunks.push(chunk), { now: time, project: "qa" });
		const text = chunks.join("");
		expect(text).not.toContain("unrelated@example.com");
		expect(text).toContain("zoe@example.com");
		expect(text).not.toContain("Unrelated");
		expect(text).not.toContain("Private folder");
		expect(text).not.toContain("Other project only");
		expect(text).not.toContain("instance-note");
		for (const table of UNEXPORTED) expect(text).not.toContain(`"t":"${table}"`);
		const to = await target();
		await importArchive(to, linesOf(text));
		const actual = await dump(to);
		for (const [table, rows] of Object.entries(expected)) {
			expect(actual[table]).toEqual(table === "meta" ? [] : rows);
		}
		expect(await to.allDynamic<Record<string, unknown>>("SELECT head_hash, claim_hash FROM cases", [])).toEqual(
			await from.allDynamic<Record<string, unknown>>("SELECT head_hash, claim_hash FROM cases", []),
		);
		expect(await to.allDynamic<Record<string, unknown>>("SELECT verdict FROM runs", [])).toEqual(
			await from.allDynamic<Record<string, unknown>>("SELECT verdict FROM runs", []),
		);

		// Inverting the selection must also exclude children that hold no project column of their own.
		const otherChunks: string[] = [];
		const otherCounts = await exportArchive(from, (chunk) => otherChunks.push(chunk), { project: "other" });
		for (const table of [
			"attachments",
			"answers",
			"versions",
			"placements",
			"covers",
			"run_tests",
			"slots",
			"slot_results",
			"depends_on",
			"result_excuses",
		]) {
			expect(otherCounts.tables[table]).toBe(0);
		}
		const other = await target();
		await importArchive(other, linesOf(otherChunks.join("")));
		expect(
			await other.allDynamic<Record<string, unknown>>(
				"SELECT email, verified_at FROM mail_contacts ORDER BY actor",
				[],
			),
		).toEqual([
			{ email: "zoe@example.com", verified_at: time },
			{ email: "unrelated@example.com", verified_at: null },
		]);
		expect(await other.allDynamic<Record<string, unknown>>("SELECT key FROM projects", [])).toEqual([{ key: "other" }]);
		expect(await other.allDynamic<Record<string, unknown>>("SELECT name FROM actors ORDER BY id", [])).toEqual([
			{ name: "Zoë 雪" },
			{ name: "Unrelated person" },
			{ name: "Other project only" },
		]);
		expect(await other.allDynamic<Record<string, unknown>>("SELECT id FROM cases", [])).toEqual([]);
		expect(await other.allDynamic<Record<string, unknown>>("SELECT settings FROM policies", [])).toEqual([
			{ settings: otherSettings },
		]);
	});

	test("project identity includes signer-only actors and the people and organisations behind them", async () => {
		const from = await source();
		await from.transaction(() =>
			from.exec(`
			INSERT INTO orgs VALUES (18, 'Delegated organisation', 1);
			INSERT INTO actors VALUES (81, 18, 'human', 'Delegating person', NULL, 1, NULL);
			INSERT INTO actors VALUES (82, 18, 'agent', 'Signer only', 81, 1, NULL);
			UPDATE decisions SET signers = '[{"by":82}]';
		`),
		);
		const chunks: string[] = [];
		await exportArchive(from, (chunk) => chunks.push(chunk), { project: "qa" });
		const to = await target();
		await importArchive(to, linesOf(chunks.join("")));
		expect(await to.allDynamic<Record<string, unknown>>("SELECT id FROM actors ORDER BY id", [])).toEqual([
			{ id: 70 },
			{ id: 71 },
			{ id: 81 },
			{ id: 82 },
		]);
		expect(await to.allDynamic<Record<string, unknown>>("SELECT id FROM orgs ORDER BY id", [])).toEqual([
			{ id: 17 },
			{ id: 18 },
		]);
	});

	test("a project export refuses a new table with no ownership rule before writing", async () => {
		const from = await source();
		await from.transaction(() => from.exec("CREATE TABLE unscoped_private (id bigint PRIMARY KEY, note TEXT)"));
		const chunks: string[] = [];
		await expect(exportArchive(from, (chunk) => chunks.push(chunk), { project: "qa" })).rejects.toThrow(
			/no ownership rule/,
		);
		expect(chunks).toEqual([]);
	});

	test("an untouched project keeps the rule actor for the first policy decision after restore", async () => {
		const from = await harness();
		const to = await harness();
		try {
			const chunks: string[] = [];
			await from.app.database.read((db) => exportArchive(db, (chunk) => chunks.push(chunk), { project: "scratch" }));
			await to.app.database.write((db) =>
				db.transaction(async () => {
					// The harness recorded project.create; the server's untouched bootstrap records no command.
					await db.transaction(() => db.exec("DELETE FROM commands"));
					await removeBootstrap(db);
					await importArchive(db, linesOf(chunks.join("")));
				}),
			);
			expect(await to.raw("propose", { edits: [{ op: "create", outline: "First case after restore" }] })).toMatchObject(
				{
					ok: true,
				},
			);
			expect(await to.app.database.read((db) => db.allDynamic("SELECT kind, name FROM actors ORDER BY id"))).toEqual(
				await from.app.database.read((db) => db.allDynamic("SELECT kind, name FROM actors ORDER BY id")),
			);
		} finally {
			await from.close();
			await to.close();
		}
	});

	test("slot settlements travel with their slot and do not settle another slot after restore", async () => {
		const from = await harness();
		const to = await harness();
		try {
			await from.call("propose", {
				edits: [
					{ op: "create", outline: "One" },
					{ op: "create", outline: "Keep open" },
				],
			});
			const target = { commit: "archiveslot", branch: "main" };
			const one = await from.call<{ run: string }>("plan", {
				name: "One",
				select: {},
				accepts: { commit: target.commit },
			});
			const two = await from.call<{ run: string }>("plan", {
				name: "Two",
				select: {},
				accepts: { commit: target.commit },
			});
			const passer = await from.actor("passer", "human", ["read", "produce"]);
			const result = (outcome: string) => ({
				test: { key: "one" },
				annotation: { case: "C-1" },
				outcome,
				...(outcome === "fail" ? { failure: { message: "same cause" } } : {}),
			});
			await from.call("report", { target, results: [result("fail")] });
			await from.call("report", { target, results: [result("pass")] }, passer);
			const questions = (
				await from.call<{ items: { q: string; evidenceHash: string; evidence: { run?: string } }[] }>("inbox", {
					kind: "failure",
				})
			).items;
			const chosen = questions.find((question) => question.evidence.run === one.run);
			if (!chosen) throw new Error("missing slot dispute");
			await from.call("decide", { q: chosen.q, onEvidence: chosen.evidenceHash, answer: { is: "flaky" } });
			const chunks: string[] = [];
			await from.app.database.read((db) => exportArchive(db, (chunk) => chunks.push(chunk), { project: "scratch" }));
			await to.app.database.write((db) =>
				db.transaction(async () => {
					await db.transaction(() => db.exec("DELETE FROM commands"));
					await removeBootstrap(db);
					await importArchive(db, linesOf(chunks.join("")));
				}),
			);
			expect(await to.call("gate", { run: one.run })).toMatchObject({ tally: { pass: 1, disputed: 0 } });
			expect(await to.call("gate", { run: two.run })).toMatchObject({ verdict: "blocked", tally: { disputed: 1 } });
		} finally {
			await from.close();
			await to.close();
		}
	});

	test("removing a project deletes every row it owns and leaves people and another project as they were", async () => {
		const db = await source();
		await db.transaction(() =>
			db.exec(`
			INSERT INTO projects VALUES (24, 17, 'other', 'Another project', 1, 1, 'identity-other');
			INSERT INTO folders VALUES (44, 24, NULL, 'Kept folder', 'a0', 'active', 1);
			INSERT INTO grants (actor, project, can) VALUES (70, 24, '["read"]');
			INSERT INTO slot_leases VALUES (602, 71, 1, 30001);
			INSERT INTO change_ends (change, ended, at) VALUES (503, 'merged', 1);
   INSERT INTO merge_receipt_payloads (id,project,hash,body) VALUES (1,23,'payload','{}');
   INSERT INTO merge_receipt_nodes (id,project,hash,level,count) VALUES (1,23,'node',0,1);
 INSERT INTO merge_receipt_snapshots (id,project,hash,result_root,count,evidence_count) VALUES (1,23,'snapshot',1,1,1);
 INSERT INTO merge_receipt_heads (run,project,root) VALUES (601,23,1);
 INSERT INTO merge_receipt_dirty (run,bucket) VALUES (601,1);
   INSERT INTO merge_receipt_members (node,slot,payload) VALUES (1,0,1);
   INSERT INTO merge_receipts (id,project,change,actor,at,seq,evidence,snapshot) VALUES (1,23,503,71,1,1,1,'{}');
   UPDATE change_ends SET receipt=1 WHERE change=503;
			INSERT INTO demo_projects (project,since) VALUES (23, 1);
			INSERT INTO tracker_polls VALUES (401, 'poll-1', 1, 0, NULL);
			INSERT INTO tracker_requests (id, nonce, project, result, repository, action, item_key, title, body, state, at)
				VALUES ('request-1', 'nonce-1', 23, 200, 'demo/shop', 'create', 'key-1', 'Title', 'Body', 'queued', 1);
			INSERT INTO handoffs (id, nonce, project, question, body, state, at)
				VALUES ('handoff-1', 'nonce-1', 23, 402, '{}', 'sent', 1);
		`),
		);
		await insert(db, "policies", { ...fixtures.policies?.[0], project: 24, actor: 71 });
		const other = async (): Promise<string> => {
			const chunks: string[] = [];
			await exportArchive(db, (chunk) => chunks.push(chunk), { now: time, project: "other" });
			return chunks.join("");
		};
		const kept = ["meta", "orgs", "actors", "tokens", "mail_contacts", "teams", "team_members"];
		const keptState = async () =>
			Promise.all(
				kept.map(async (table) => {
					const rows = await db.allDynamic<Record<string, unknown>>(`SELECT * FROM ${table}`, []);
					return rows
						.map((row) => {
							const copy = { ...row };
							if (table === "actors") delete copy.auth_version;
							return copy;
						})
						.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
				}),
			);
		const before = {
			other: await other(),
			kept: await keptState(),
		};
		const removed = await removeProject(db, "qa");
		// Every table the fixture fills for the project lost its rows, the ones an archive leaves out included, and
		// the count says so. The other project holds no rows of the tables that find their project through a parent.
		for (const table of [
			...(await exportedTables(db)),
			"merge_receipt_dirty",
			"merge_receipt_heads",
			"merge_receipt_members",
			"merge_receipt_nodes",
			"merge_receipt_payloads",
			"merge_receipt_snapshots",
			"merge_receipts",
			"slot_leases",
			"change_ends",
			"tracker_requests",
			"tracker_polls",
			"handoffs",
			"demo_projects",
			"search_docs",
		]) {
			if (["meta", "orgs", "actors", "mail_contacts", "teams", "team_members"].includes(table)) continue;
			expect({ table, removed: removed.tables[table] ?? 0 }).toEqual({
				table,
				removed: table === "grants" ? 1 : (fixtures[table]?.length ?? 1),
			});
			const columns = (await db.catalog()).find((item) => item.name === table)?.columns ?? [];
			const where =
				table === "projects" ? "WHERE id = 23" : columns.some((c) => c.name === "project") ? "WHERE project = 23" : "";
			expect({
				table,
				left:
					(
						await db.allDynamic<Record<string, unknown>>(`SELECT count(*) AS n FROM ${identifier(table)} ${where}`, [])
					)[0] ?? null,
			}).toEqual({
				table,
				left: { n: 0 },
			});
		}
		expect(removed.rows).toBe(Object.values(removed.tables).reduce((sum, count) => sum + count, 0));
		expect(await db.allDynamic<Record<string, unknown>>("SELECT key FROM projects", [])).toEqual([{ key: "other" }]);
		expect(
			await db.allDynamic<Record<string, unknown>>("SELECT actor, project FROM grants ORDER BY actor, project", []),
		).toEqual([
			{ actor: 70, project: 24 },
			{ actor: 71, project: 0 },
		]);
		expect(await other()).toBe(before.other);
		expect(await keptState()).toEqual(before.kept);
		expect(db.inTransaction).toBe(false);
	});

	test("project removal slices commit intact foreign keys, retain the mark, and resume after committed slices", async () => {
		const db = await source();
		await db.transaction(() =>
			db.exec(`
			INSERT INTO projects (id,org,key,name,created_at,identity) VALUES (24,17,'other','Kept',1,'other');
			INSERT INTO folders VALUES (44,24,NULL,'Kept folder','a0','active',1);
			INSERT INTO demo_projects (project,since) VALUES (23,1);
			INSERT INTO slot_leases VALUES (602,71,1,30001);
			INSERT INTO tracker_polls VALUES (401,'poll',1,0,NULL);
			INSERT INTO change_ends (change,ended,at) VALUES (503,'merged',1);
			INSERT INTO merge_receipt_payloads (id,project,hash,body) VALUES (1,23,'payload','{}');
			INSERT INTO merge_receipt_nodes (id,project,hash,level,count) VALUES (1,23,'node',0,1);
			INSERT INTO merge_receipt_members (node,slot,payload) VALUES (1,0,1);
			INSERT INTO merge_receipt_heads (run,project,root) VALUES (601,23,1);
			INSERT INTO merge_receipt_dirty (run,bucket) VALUES (601,1);
		`),
		);
		const retained = await db.allDynamic("SELECT * FROM folders WHERE project=24");
		let slices = 0;
		for (;;) {
			const result = await removeProjectSlice(db, "qa", 4);
			expect(db.inTransaction).toBe(false);
			expect(await db.allDynamic("SELECT * FROM folders WHERE project=24")).toEqual(retained);
			expect(result.rows).toBeLessThanOrEqual(4);
			slices++;
			if (result.done) break;
			expect(result.rows).toBeGreaterThan(0);
			expect(await db.allDynamic("SELECT project FROM demo_projects")).toEqual([{ project: 23 }]);
			expect(slices).toBeLessThan(200);
		}
		expect(slices).toBeGreaterThan(3);
		expect(await db.allDynamic("SELECT key FROM projects")).toEqual([{ key: "other" }]);
		expect(await db.allDynamic("SELECT * FROM demo_projects")).toEqual([]);
		expect(await db.allDynamic("SELECT id FROM search_docs WHERE project=23")).toEqual([]);
		expect(await removeProjectSlice(db, "qa")).toEqual({ done: true, table: null, rows: 0 });
	});

	test("project removal slices drain an HTTP-seeded demo while another project stays readable", async () => {
		await withInstance(async ({ client, instance }) => {
			await seed(client, { project: "demo", cases: 30, days: 1 });
			const read = instance.app.database.read.bind(instance.app.database);
			const kept = (await read((db) => db.allDynamic("SELECT * FROM projects WHERE key='scratch'")))[0];
			const people = () =>
				read(async (db) =>
					(await db.allDynamic<Record<string, unknown>>("SELECT * FROM actors ORDER BY id")).map(
						({ auth_version: _version, ...actor }) => actor,
					),
				);
			const beforePeople = await people();
			let rows = 0;
			for (let i = 0; i < 500; i++) {
				const result = await instance.app.database.write((db) => removeProjectSlice(db, "demo", 16));
				rows += result.rows;
				expect(result.rows).toBeLessThanOrEqual(16);
				expect((await read((db) => db.allDynamic("SELECT * FROM projects WHERE key='scratch'")))[0]).toEqual(kept);
				expect(await people()).toEqual(beforePeople);
				if (result.done) {
					expect(rows).toBeGreaterThan(100);
					expect((await client.call("find", { limit: 1 })).items).toEqual([]);
					return;
				}
				await Bun.sleep(0);
			}
			throw new Error("seeded demo removal did not finish");
		});
	}, 30_000);

	test("project removal slices delete cross-table cycles with composite foreign keys", async () => {
		const db = await target();
		await db.transaction(() =>
			db.exec(`
			INSERT INTO projects (id,org,key,name,created_at,identity) VALUES (23,1,'qa','Remove',1,'qa');
			CREATE TABLE slice_a (project INTEGER REFERENCES projects(id) DEFERRABLE INITIALLY IMMEDIATE, id INTEGER, b INTEGER NOT NULL,
				PRIMARY KEY(project,id));
			CREATE TABLE slice_b (project INTEGER REFERENCES projects(id) DEFERRABLE INITIALLY IMMEDIATE, id INTEGER, a INTEGER NOT NULL,
				PRIMARY KEY(project,id), FOREIGN KEY(project,a) REFERENCES slice_a(project,id) DEFERRABLE INITIALLY IMMEDIATE);
			ALTER TABLE slice_a ADD FOREIGN KEY(project,b) REFERENCES slice_b(project,id) DEFERRABLE INITIALLY IMMEDIATE;
		`),
		);
		await db.transaction(async () => {
			await db.exec("SET CONSTRAINTS ALL DEFERRED");
			await db.exec("INSERT INTO slice_a VALUES (23,1,2); INSERT INTO slice_b VALUES (23,2,1)");
		});
		const result = await removeProjectSlice(db, "qa", 2);
		expect(result).toMatchObject({ done: false, rows: 2 });
		expect(await db.allDynamic("SELECT * FROM slice_a")).toEqual([]);
		expect(await db.allDynamic("SELECT * FROM slice_b")).toEqual([]);
		expect((await removeProjectSlice(db, "qa", 2)).done).toBe(true);
	});

	test("project removal slices handle self references and bounded cycles without cascading outside the slice", async () => {
		const db = await target();
		await db.transaction(() =>
			db.exec(`
			INSERT INTO projects (id,org,key,name,created_at,identity) VALUES (23,1,'qa','Remove',1,'qa');
			CREATE TABLE slice_nodes (id INTEGER PRIMARY KEY, project INTEGER NOT NULL REFERENCES projects(id) DEFERRABLE INITIALLY IMMEDIATE,
				parent INTEGER REFERENCES slice_nodes(id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE);
			CREATE INDEX slice_nodes_parent ON slice_nodes(parent);
			CREATE INDEX slice_nodes_project ON slice_nodes(project);
			INSERT INTO slice_nodes VALUES (1,23,NULL),(2,23,1),(3,23,2),(4,23,1),(5,23,1),(6,23,1);
		`),
		);
		await db.transaction(async () => {
			await db.exec("SET CONSTRAINTS ALL DEFERRED");
			await db.exec("INSERT INTO slice_nodes VALUES (7,23,8),(8,23,7)");
		});
		for (let i = 0; i < 30; i++) {
			const before = (await db.allDynamic<{ n: number }>("SELECT count(*) AS n FROM slice_nodes"))[0]?.n ?? 0;
			const result = await removeProjectSlice(db, "qa", 2);
			const after = (await db.allDynamic<{ n: number }>("SELECT count(*) AS n FROM slice_nodes"))[0]?.n ?? 0;
			expect(before - after).toBeLessThanOrEqual(2);
			expect(result.rows).toBeLessThanOrEqual(2);
			if (result.done) return;
		}
		throw new Error("slice removal did not finish");
	});

	test("project removal slices roll back incoming retained references, oversized cycles, and unknown ownership", async () => {
		for (const retained of [false, true]) {
			const db = await target();
			await db.transaction(() =>
				db.exec(`
				INSERT INTO projects (id,org,key,name,created_at,identity) VALUES (23,1,'qa','Remove',1,'remove'),(24,1,'other','Keep',1,'keep');
				CREATE TABLE slice_nodes (id INTEGER PRIMARY KEY, project INTEGER NOT NULL REFERENCES projects(id) DEFERRABLE INITIALLY IMMEDIATE,
					parent INTEGER REFERENCES slice_nodes(id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE);
				CREATE INDEX slice_nodes_parent ON slice_nodes(parent);
			`),
			);
			await db.transaction(async () => {
				await db.exec("SET CONSTRAINTS ALL DEFERRED");
				await db.exec(
					retained
						? "INSERT INTO slice_nodes VALUES (1,23,NULL),(2,24,1)"
						: "INSERT INTO slice_nodes VALUES (1,23,2),(2,23,3),(3,23,1)",
				);
			});
			const before = await allRows(db);
			await expect(removeProjectSlice(db, "qa", 2)).rejects.toThrow(
				retained ? /another project|retained/ : /limit|bounded/,
			);
			expect(await allRows(db)).toEqual(before);
		}
		const db = await source();
		await db.transaction(() => db.exec("CREATE TABLE unscoped_private (id INTEGER PRIMARY KEY)"));
		const before = await allRows(db);
		await expect(removeProjectSlice(db, "qa")).rejects.toThrow(/ownership/);
		expect(await allRows(db)).toEqual(before);
	});

	test("project removal slices join the caller transaction and never audit unrelated foreign keys", async () => {
		const db = await source();
		const before = await db.allDynamic("SELECT * FROM projects");
		await expect(
			db.transaction(async () => {
				await removeProjectSlice(db, "qa");
				throw new Error("rollback the caller's removal slice");
			}),
		).rejects.toThrow("rollback the caller's removal slice");
		expect(await db.allDynamic("SELECT * FROM projects")).toEqual(before);
		await db.transaction(() =>
			db.exec(`CREATE TABLE unrelated_broken (id INTEGER PRIMARY KEY, project INTEGER);
		INSERT INTO unrelated_broken VALUES (1,9999);
		ALTER TABLE unrelated_broken ADD FOREIGN KEY(project) REFERENCES projects(id) NOT VALID;`),
		);
		for (let i = 0; i < 200; i++) {
			if ((await removeProjectSlice(db, "qa")).done) {
				expect(await db.allDynamic("SELECT * FROM unrelated_broken")).toEqual([{ id: 1, project: 9999 }]);
				return;
			}
		}
		throw new Error("slice removal did not finish");
	});

	test("removing a project that is not there, or with a table nobody owns, changes nothing", async () => {
		const db = await source();
		const before = await allRows(db);
		await expect(removeProject(db, "missing' OR 1=1 --")).rejects.toThrow(/project.*not found/i);
		await db.transaction(() => db.exec("CREATE TABLE unscoped_private (id bigint PRIMARY KEY, note TEXT)"));
		await expect(removeProject(db, "qa")).rejects.toThrow(
			/removing a project has no ownership rule for table unscoped_private/,
		);
		expect({ ...(await allRows(db)), unscoped_private: undefined }).toEqual({ ...before, unscoped_private: undefined });
		expect(db.inTransaction).toBe(false);
	});

	test("an unknown project refuses export before the writer receives a byte", async () => {
		const chunks: string[] = [];
		await expect(
			exportArchive(await source(), (chunk) => chunks.push(chunk), { project: "missing' OR 1=1 --" }),
		).rejects.toThrow(/project.*not found/i);
		expect(chunks).toEqual([]);
	});
	test("every included table and column survives replay, including full 64-bit integers", async () => {
		const from = await source();
		const to = await target();
		expect(Object.keys(fixtures).sort()).toEqual(await exportedTables(from));
		const text = await archive(from);
		const result = await importArchive(to, linesOf(text));
		expect(await dump(to)).toEqual(await dump(from));
		for (const table of await exportedTables(from)) expect(result.tables[table]).toBeGreaterThan(0);
		expect(result.rows).toBe(Object.values(result.tables).reduce((sum, count) => sum + count, 0));
		expect(text).toContain('"value":9223372036854775807');
		expect(text).toContain('"value":-9223372036854775808');
		expect(text).toContain('"duration_ms":2592000000');
		expect(
			(await to.allDynamic<Record<string, unknown>>("SELECT value FROM meta WHERE key = 'schema_version'", []))[0] ??
				null,
		).toEqual({
			value: String(SCHEMA_VERSION),
		});
		expect(await to.allDynamic<Record<string, unknown>>("SELECT * FROM tokens", [])).toEqual([]);
	});

	test.each([
		["results", 201],
		["result_tries", 513],
	] as const)("an archive refuses out-of-range %s durations without changing the target", async (table, id) => {
		const from = await source();
		for (const duration of [-1, 2_592_000_001, 9_223_372_036_854_775_807n]) {
			await from.transaction(() =>
				from.runDynamic(`UPDATE ${table} SET duration_ms = $1 WHERE id = $2`, [duration, id]),
			);
			const text = await archive(from);
			await refuse(text, new RegExp(`${table}\\.duration_ms.*row ${id}.*line \\d+.*0.*2592000000`));
		}
	});

	test("invalid failure subjects name the archive row and line and roll back every table", async () => {
		const from = await source();
		for (const subject of [
			'{"signature":1,"scope":"line:main","perResult":false}',
			'{"signature":"1","scope":"line:main"}',
			'{"signature":1,"scope":"run:1","slot":2,"perResult":true}',
			'{"signature":1,"scope":"line:main","extra":true}',
			'{"signature":1}',
			"null",
			"[]",
			"{",
		]) {
			await from.transaction(() =>
				from.runDynamic("UPDATE questions SET kind = 'failure', subject = $1 WHERE id = 402", [subject]),
			);
			const text = await archive(from);
			const line = [...linesOf(text)].findIndex((line) => line.startsWith('{"t":"questions",')) + 1;
			await refuse(
				text,
				`invalid archive questions.subject for row 402 on line ${line}: expected a valid failure subject`,
			);
		}
	});

	test("every written failure subject shape imports without changing its stored JSON", async () => {
		const from = await source();
		for (const subject of [
			'{ "scope": "line:main", "signature": 505 }',
			'{"signature":505,"scope":"change:1","perResult":true}',
			'{"slot":1,"signature":505,"scope":"run:301"}',
		]) {
			await from.transaction(() =>
				from.runDynamic("UPDATE questions SET kind = 'failure', subject = $1 WHERE id = 402", [subject]),
			);
			const to = await target();
			await importArchive(to, linesOf(await archive(from)));
			expect(await dump(to)).toEqual(await dump(from));
		}
	});

	test("result and runner-try durations keep the exact limit, zero and unknown time", async () => {
		const from = await source();
		for (const duration of [2_592_000_000, 0, null]) {
			await from.transaction(() => from.runDynamic("UPDATE results SET duration_ms = $1 WHERE id = 201", [duration]));
			await from.transaction(() =>
				from.runDynamic("UPDATE result_tries SET duration_ms = $1 WHERE id = 513", [duration]),
			);
			const to = await target();
			await importArchive(to, linesOf(await archive(from)));
			for (const table of ["results", "result_tries"]) {
				expect(
					await to.allDynamic<Record<string, unknown>>(
						`SELECT DISTINCT duration_ms FROM ${table} WHERE id IN (201, 513)`,
						[],
					),
				).toEqual([{ duration_ms: duration }]);
			}
		}
	});

	test.each([
		{ staged: null, path: "results" },
		{ staged: JSON.stringify([{ test: { key: "one" }, outcome: "wrong" }]), path: "0\\.outcome" },
		{ staged: JSON.stringify([{ test: { key: "x".repeat(1001) }, outcome: "pass" }]), path: "0\\.test\\.key" },
	])("pending result errors name $path on one line without blaming durations", async ({ staged, path }) => {
		const from = await source();
		await from.transaction(() => from.runDynamic("UPDATE batches SET staged = $1 WHERE id = 504", [staged]));
		await refuse(
			await archive(from),
			new RegExp(
				`^invalid archive batches\\.staged for row 504 on line \\d+: pending results fail result input: ${path}: [^\\r\\n]+$`,
			),
		);
	});

	test("an archive keeps the moved scope but leaves its audit trail behind", async () => {
		const from = await source();
		await from.transaction(() =>
			from.runDynamic(
				"UPDATE targets SET what = 'code:example/app@abc12345', commit_sha = 'abc12345', branch = 'main', line = 'trunk' WHERE id = 502",
				[],
			),
		);
		await from.transaction(() =>
			from.runDynamic("UPDATE runs SET scope = 'line:trunk@example/app' WHERE id = 601", []),
		);
		await insert(from, "scope_moves", {
			id: 510,
			project: 23,
			what: "code:example/app@abc12345",
			before_scope: "change:503",
			after_scope: "line:trunk@example/app",
			actor: 71,
			at: time,
			seq: 2,
		});
		const text = await archive(from);
		expect(text).not.toContain('"t":"scope_moves"');
		const to = await target();
		await importArchive(to, linesOf(text));
		expect(
			(
				await to.allDynamic<Record<string, unknown>>("SELECT line, branch, change FROM targets WHERE id = 502", [])
			)[0] ?? null,
		).toEqual({
			line: "trunk",
			branch: "main",
			change: null,
		});
		expect(
			(await to.allDynamic<Record<string, unknown>>("SELECT scope FROM runs WHERE id = 601", []))[0] ?? null,
		).toEqual({ scope: "line:trunk@example/app" });
		expect(
			(await from.allDynamic<Record<string, unknown>>("SELECT count(*) AS n FROM scope_moves", []))[0] ?? null,
		).toEqual({ n: 1 });
		expect(await to.allDynamic<Record<string, unknown>>("SELECT * FROM scope_moves", [])).toEqual([]);
	});

	test("an archive exported under the former name replays the same rows", async () => {
		const from = await source();
		const to = await target();
		const former = rehash((await archive(from)).replace('{"mainworthy":"archive"', '{"casebook":"archive"'));
		expect(former.startsWith('{"casebook":"archive"')).toBe(true);
		await importArchive(to, linesOf(former));
		expect(await dump(to)).toEqual(await dump(from));
	});

	test("a header that names both the former and the current name, or neither, is refused", async () => {
		const text = await archive(await source());
		await refuse(
			rehash(text.replace('{"mainworthy":"archive"', '{"casebook":"archive","mainworthy":"archive"')),
			/header/,
		);
		await refuse(rehash(text.replace('{"mainworthy":"archive"', '{"other":"archive"')), /header/);
	});

	test("exports are deterministic apart from exportedAt, with a verifiable footer", async () => {
		const db = await source();
		const first = await archive(db, 100);
		const second = await archive(db, 200);
		const normalize = (text: string) =>
			text.replace(/"exportedAt":\d+/, '"exportedAt":0').replace(/"sha256":"[a-f0-9]+"/, '"sha256":""');
		expect(await archive(db, 100)).toBe(first);
		// The footer digest necessarily changes when the timestamp in its hashed header changes.
		expect(normalize(second)).toBe(normalize(first));
		const lines = [...linesOf(first)];
		const footer = lines.pop();
		const hash = createHash("sha256")
			.update(`${lines.join("\n")}\n`)
			.digest("hex");
		expect(footer).toContain(`"sha256":"${hash}"`);
		expect(first).not.toContain('"t":"tokens"');
		expect(first).not.toContain("synthetic-source-credential-hash");
		expect(first).not.toContain('"t":"search_docs');
		expect(first).not.toContain('"key":"schema_version"');
	});

	test("tables follow foreign-key dependencies and rows follow composite primary keys", async () => {
		const db = await source();
		const text = await archive(db);
		const positions = new Map(
			(await exportedTables(db)).map((name) => [name, text.indexOf(`"t":${JSON.stringify(name)}`)]),
		);
		for (const table of await exportedTables(db)) {
			for (const key of (await db.catalog()).find((item) => item.name === table)?.foreignKeys ?? []) {
				if (key.parent !== table) expect(positions.get(key.parent)).toBeLessThan(positions.get(table) ?? -1);
			}
		}
		expect(text.indexOf('"name":"case","value":')).toBeLessThan(text.indexOf('"name":"version","value":'));
		expect(text.indexOf('"actor":71,"project":0,')).toBeLessThan(text.indexOf('"actor":71,"project":23,'));
		expect(text.indexOf('"id":200,"project":23,')).toBeLessThan(text.indexOf('"id":201,"project":23,'));
	});

	test("rebuilds the head version's title, preconditions, steps and tags, including archived cases", async () => {
		const db = await target();
		await importArchive(db, linesOf(await archive(await source())));
		for (const term of ["nebulouswidget", "luminousreply", "Précondition", "regression"])
			expect(
				await db.allDynamic("SELECT id FROM search_docs WHERE tsv @@ plainto_tsquery('mainworthy_search', $1)", [term]),
			).toEqual([{ id: 101 }]);
		expect(await db.allDynamic("SELECT title, body, tags, project FROM search_docs WHERE id = 101")).toEqual([
			{
				title: "雪だるま ☃ café",
				body: "Précondition 雪\nInspect nebulouswidget\nA luminousreply appears\nLeave empty",
				tags: "café 雪 regression",
				project: 23,
			},
		]);
	});

	test("replays a model-valid case whose step has no expected result", async () => {
		const from = await source();
		const to = await target();
		const validBody = JSON.stringify({
			title: "An unfinished expectation",
			pre: "",
			steps: [{ id: "s1", action: "Inspect unansweredstep", expected: null }],
			methods: ["human"],
			automate: "none",
			fields: {},
		});
		await from.transaction(() =>
			from.runDynamic("UPDATE versions SET body = $1 WHERE case_id = 101 AND no = 2", [validBody]),
		);
		await importArchive(to, linesOf(await archive(from)));
		expect(await dump(to)).toEqual(await dump(from));
		expect(
			(await to.allDynamic<Record<string, unknown>>("SELECT body FROM search_docs WHERE id = 101", []))[0] ?? null,
		).toEqual({
			body: "\nInspect unansweredstep",
		});
		expect(
			await to.allDynamic<Record<string, unknown>>(
				"SELECT id FROM search_docs WHERE tsv @@ plainto_tsquery('mainworthy_search', 'unansweredstep')",
				[],
			),
		).toEqual([{ id: 101 }]);
	});

	test("discovers added tables, quoted identifiers and added columns without an archive list", async () => {
		const from = await source();
		const to = await target();
		for (const db of [from, to])
			await db.transaction(() =>
				db.exec(`
			ALTER TABLE cases ADD COLUMN extra_text TEXT;
			CREATE TABLE "future 'table" ("odd column" bigint PRIMARY KEY, owner bigint REFERENCES cases(id), note TEXT);
		`),
			);
		await from.transaction(() => from.runDynamic("UPDATE cases SET extra_text = $1", ["new\ncolumn 雪"]));
		await insert(from, "future 'table", { "odd column": 9_223_372_036_854_775_807n, owner: 101, note: "" });
		const result = await importArchive(to, linesOf(await archive(from)));
		expect(result.tables["future 'table"]).toBe(1);
		expect(await dump(to)).toEqual(await dump(from));
	});

	test("an older archive fills added nullable columns with NULL, even with defaults", async () => {
		const from = await source();
		const to = await target();
		await to.transaction(() =>
			to.exec(
				"ALTER TABLE cases ADD COLUMN later_note TEXT DEFAULT 'new'; ALTER TABLE cases ADD COLUMN later_count INTEGER",
			),
		);
		await importArchive(to, linesOf(await archive(from)));
		expect(
			(
				await to.allDynamic<Record<string, unknown>>("SELECT later_note, later_count FROM cases WHERE id = 101", [])
			)[0] ?? null,
		).toEqual({
			later_note: null,
			later_count: null,
		});
		expect(
			(await to.allDynamic<Record<string, unknown>>("SELECT title FROM cases WHERE id = 101", []))[0] ?? null,
		).toEqual(
			(await from.allDynamic<Record<string, unknown>>("SELECT title FROM cases WHERE id = 101", []))[0] ?? null,
		);
	});

	test("an archive from before head observations leaves the observation unset", async () => {
		const to = await target();
		const old = rehash((await archive(await source())).replace(',"head_observed_seq":2', ""));
		expect(old).not.toContain('"head_observed_seq"');
		await importArchive(to, linesOf(old));
		expect(
			(
				await to.allDynamic<Record<string, unknown>>("SELECT key, head_observed_seq FROM changes WHERE id = 503", [])
			)[0] ?? null,
		).toEqual({
			key: "change-one",
			head_observed_seq: null,
		});
	});

	test("an archive without decision evidence imports legacy hashes as NULL", async () => {
		const from = await source();
		await from.transaction(() => from.exec("ALTER TABLE decisions DROP COLUMN on_evidence"));
		const old = await archive(from);
		expect(old).toContain(`"schema":${ARCHIVE_VERSION},`);
		const decision = [...linesOf(old)].map((line) => JSON.parse(line)).find((row) => row.t === "decisions");
		expect(decision.r).not.toHaveProperty("on_evidence");
		const to = await target();
		await importArchive(to, linesOf(old));
		expect(await to.allDynamic<Record<string, unknown>>("SELECT DISTINCT on_evidence FROM decisions", [])).toEqual([
			{ on_evidence: null },
		]);
	});

	test("a missing required column is refused rather than using a default", async () => {
		const to = await target();
		await to.transaction(() => to.exec("ALTER TABLE cases ADD COLUMN required_note TEXT NOT NULL DEFAULT 'new'"));
		const before = await allRows(to);
		await expect(importArchive(to, linesOf(await archive(await source())))).rejects.toThrow(
			"missing column cases.required_note",
		);
		expect(await allRows(to)).toEqual(before);
	});

	test("a missing primary key is refused rather than assigned a new identity", async () => {
		await refuse(rehash((await archive(await source())).replace('"id":101,', "")), /missing column cases.id/);
	});

	test("table and column names that match object prototypes remain lossless", async () => {
		const from = await source();
		const to = await target();
		for (const db of [from, to])
			await db.transaction(() =>
				db.exec(`
			CREATE TABLE future_notes (id bigint PRIMARY KEY, "__proto__" TEXT);
			CREATE TABLE "__proto__" (id bigint PRIMARY KEY, "constructor" TEXT);
		`),
			);
		await from.transaction(() => from.runDynamic("INSERT INTO future_notes VALUES (1, $1)", ["preserved column"]));
		await from.transaction(() => from.runDynamic('INSERT INTO "__proto__" VALUES (1, $1)', ["preserved table"]));
		await importArchive(to, linesOf(await archive(from)));
		expect(await dump(to)).toEqual(await dump(from));
	});

	test("unknown prototype-named tables and columns are named and refused", async () => {
		const text = await archive(await source());
		await refuse(rehash(text.replace('"tables":{', '"tables":{"__proto__":0,')), /unknown.*table.*__proto__/i);
		await refuse(rehash(text.replace('"r":{', '"r":{"__proto__":"unknown",')), /unknown.*column.*__proto__/i);
	});

	test("emits complete lines in approximately 64 KiB chunks within a read transaction", async () => {
		const db = await source();
		await db.transaction(() =>
			db.runDynamic(
				"INSERT INTO meta (key, value) SELECT 'chunk-' || i::text, repeat('雪', 40) FROM generate_series(0, 1999) i",
			),
		);
		const chunks: string[] = [];
		await exportArchive(
			db,
			(chunk) => {
				expect(chunk.endsWith("\n")).toBe(true);
				expect(Buffer.byteLength(chunk)).toBeLessThanOrEqual(64 * 1024);
				for (const line of linesOf(chunk)) expect(() => JSON.parse(line)).not.toThrow();
				chunks.push(chunk);
			},
			{ now: time },
		);
		expect(chunks.length).toBeGreaterThan(3);
		expect(db.inTransaction).toBe(false);
		expect((await importArchive(await target(), linesOf(chunks.join("")))).tables.meta).toBe(2_001);
	});

	test("an oversized row stays one line and a failing writer releases the read transaction", async () => {
		const db = await source();
		await insert(db, "meta", { key: "large-document", value: "雪".repeat(40_000) });
		const chunks: string[] = [];
		await exportArchive(db, (chunk) => chunks.push(chunk));
		expect(chunks.some((chunk) => Buffer.byteLength(chunk) > 64 * 1024 && [...linesOf(chunk)].length === 1)).toBe(true);
		await expect(
			exportArchive(db, () => {
				throw new Error("writer failed");
			}),
		).rejects.toThrow("writer failed");
		expect(db.inTransaction).toBe(false);
		const to = await target();
		await importArchive(to, linesOf(await archive(db)));
		expect(await dump(to)).toEqual(await dump(db));
	});

	test("an instance with no rows exports every table with zero counts and can be replayed", async () => {
		const from = await database();
		const to = await target();
		const imported = await importArchive(to, linesOf(await archive(from)));
		expect(imported.rows).toBe(0);
		expect(Object.keys(imported.tables).sort()).toEqual(await exportedTables(from));
		expect(Object.values(imported.tables).every((count) => count === 0)).toBe(true);
		expect(await dump(to)).toEqual(await dump(from));
	});

	test("import advances identity sequences beyond every restored explicit id", async () => {
		const db = await target();
		await importArchive(db, linesOf(await archive(await source())));
		await db.transaction(async () => {
			const [org] = await db.allDynamic<{ id: number }>(
				"INSERT INTO orgs (name, created_at) VALUES ('After import', 1) RETURNING id",
			);
			const [actor] = await db.allDynamic<{ id: number }>(
				"INSERT INTO actors (org, kind, name, created_at) VALUES (17, 'human', 'after-import', 1) RETURNING id",
			);
			const [project] = await db.allDynamic<{ id: number }>(
				"INSERT INTO projects (org, key, identity, name, created_at) VALUES (17, 'after-import', 'after-import', 'After import', 1) RETURNING id",
			);
			expect(org?.id).toBeGreaterThan(17);
			expect(actor?.id).toBeGreaterThan(71);
			expect(project?.id).toBeGreaterThan(23);
		});
	});

	test("rolling back an imported archive also restores discarded credential identity allocation", async () => {
		const db = await target();
		const text = await archive(await source());
		await db.transaction(async () => {
			await db.exec("ALTER TABLE tokens ALTER COLUMN id RESTART WITH 1000");
		});
		await expect(
			db.transaction(async () => {
				await importArchive(db, linesOf(text));
				throw new Error("the caller rolled back its import");
			}),
		).rejects.toThrow("the caller rolled back its import");
		const rows = await db.transaction(
			async () =>
				await db.allDynamic<{ id: number }>(
					"INSERT INTO tokens (actor,hash,label,created_at) VALUES (1,'after-rollback','after rollback',1) RETURNING id",
					[],
				),
		);
		expect(rows).toEqual([{ id: 1000 }]);
	});

	test("malformed numeric archive values are invalid operations and restore the target", async () => {
		const db = await target();
		const before = await allRows(db);
		const text = rehash((await archive(await source())).replace('"org":17', '"org":"seventeen"'));
		await expect(importArchive(db, linesOf(text))).rejects.toMatchObject({ code: "invalid" });
		expect(await allRows(db)).toEqual(before);
	});

	test("a missing footer rolls back every row and bootstrap deletion", async () => {
		const lines = [...linesOf(await archive(await source()))];
		lines.pop();
		await refuse(`${lines.join("\n")}\n`, /footer|truncated/);
	});

	test("a truncated footer is refused without changing the target", async () => {
		await refuse((await archive(await source())).slice(0, -20), /JSON|footer|archive/);
	});

	test("a flipped byte is refused without changing the target", async () => {
		await refuse(
			(await archive(await source())).replace("Archive organisation", "Brchive organisation"),
			/hash|checksum|SHA/,
		);
	});

	test("a wrong footer row count is refused without changing the target", async () => {
		await refuse((await archive(await source())).replace(/"rows":\d+/, '"rows":0'), /row count/);
	});

	test("a wrong per-table count is refused even with a valid checksum", async () => {
		await refuse(
			rehash((await archive(await source())).replace(/"results":2/, '"results":3')),
			/results.*count|count.*results/,
		);
	});

	test("an unknown row table is named and rolled back", async () => {
		await refuse(
			(await archive(await source())).replace('"t":"meta"', '"t":"unknown_table"'),
			/unknown.*table.*unknown_table/i,
		);
	});

	test("an unknown header table is named and refused", async () => {
		await refuse(
			(await archive(await source())).replace('"tables":{', '"tables":{"unknown_table":0,'),
			/unknown.*table.*unknown_table/i,
		);
	});

	test("an unknown column is named and rolled back", async () => {
		await refuse(
			(await archive(await source())).replace('"key":"instance-note"', '"unknown_column":"instance-note"'),
			/unknown.*column.*unknown_column/i,
		);
	});

	test("newer formats are refused before changing the target", async () => {
		await refuse((await archive(await source())).replace('"format":1', '"format":2'), /format.*2/);
	});

	test("newer and older schemas are refused with a clear message", async () => {
		const text = await archive(await source());
		// The header names the archive version: the last migration that changed what an archive holds, which is
		// behind the schema version whenever a later migration only added a table an archive leaves out.
		expect(text).toContain(`"schema":${ARCHIVE_VERSION},`);
		expect(ARCHIVE_VERSION).toBe(43);
		await refuse(
			text.replace(`"schema":${ARCHIVE_VERSION}`, `"schema":${ARCHIVE_VERSION + 1}`),
			/schema.*newer|newer.*schema/,
		);
		await refuse(text.replace(`"schema":${ARCHIVE_VERSION}`, '"schema":0'), /schema.*older|older.*schema/);
	});

	test("sessions never travel, and an import empties them before the tokens they refer to", async () => {
		const from = await source();
		const seen = { created_at: time, last_seen_at: time, expires_at: time };
		await insert(from, "sessions", { id: 1, actor: 71, token: 900, hash: "c".repeat(64), ...seen });
		const text = await archive(from);
		expect(text).not.toContain('"t":"sessions"');
		expect(text).not.toContain("c".repeat(64));
		await refuse(text.replace('"t":"meta"', '"t":"sessions"'), /sessions/);
		// The target's own session refers to the target's own token: both go, the session first.
		const to = await target();
		await insert(to, "sessions", { id: 1, actor: 1, token: 1, hash: "d".repeat(64), ...seen });
		await importArchive(to, linesOf(text));
		expect(await to.allDynamic<Record<string, unknown>>("SELECT * FROM sessions", [])).toEqual([]);
		expect(await to.allDynamic<Record<string, unknown>>("SELECT * FROM tokens", [])).toEqual([]);
	});

	test("a password, a passkey, its handle and an invitation never travel, and an import empties them in an order the foreign keys allow", async () => {
		const people = async (db: WriteDb, actor: number, mark: string): Promise<void> => {
			await insert(db, "credentials", {
				id: 1,
				actor,
				kind: "password",
				data: `$argon2id$${mark}`,
				label: "password",
				created_at: time,
			});
			await insert(db, "credentials", {
				id: 2,
				actor,
				kind: "passkey",
				handle: `credential-${mark}`,
				data: `{"key":"key-${mark}"}`,
				label: "laptop",
				created_at: time,
			});
			await insert(db, "passkey_users", { actor, handle: `handle-${mark}`, created_at: time });
			await insert(db, "invitations", {
				id: 1,
				actor,
				hash: mark.repeat(64),
				purpose: "join",
				created_by: actor,
				created_at: time,
				expires_at: time,
			});
			// A session that rests on the passkey: it has to go before the credential it refers to.
			await insert(db, "sessions", {
				id: 1,
				actor,
				credential: 2,
				hash: mark.repeat(63),
				created_at: time,
				last_seen_at: time,
				expires_at: time,
			});
		};
		const from = await source();
		await people(from, 71, "e");
		const text = await archive(from);
		for (const table of ["credentials", "passkey_users", "invitations"]) {
			expect(text).not.toContain(`"t":"${table}"`);
			await refuse(text.replace('"t":"meta"', `"t":"${table}"`), new RegExp(table));
		}
		for (const held of ["$argon2id$e", "credential-e", "key-e", "handle-e", "e".repeat(63)])
			expect(text).not.toContain(held);
		const to = await target();
		await people(to, 1, "f");
		await importArchive(to, linesOf(text));
		for (const table of UNEXPORTED.filter(
			(table) => !["assertion_index", "assertion_roots", "assertion_seen", "assertion_spreads"].includes(table),
		))
			expect(await to.allDynamic<Record<string, unknown>>(`SELECT * FROM ${table}`, [])).toEqual([]);
		expect([...UNEXPORTED].sort()).toEqual([
			"assertion_index",
			"assertion_roots",
			"assertion_seen",
			"assertion_spreads",
			"batch_admissions",
			"change_ends",
			"commit_status_delivery",
			"commit_statuses",
			"credentials",
			"demo_projects",
			"handoffs",
			"invitations",
			"merge_receipt_dirty",
			"merge_receipt_heads",
			"merge_receipt_members",
			"merge_receipt_nodes",
			"merge_receipt_payloads",
			"merge_receipt_snapshots",
			"merge_receipts",
			"passkey_users",
			"scope_moves",
			"sessions",
			"slot_leases",
			"tokens",
			"tracker_polls",
			"tracker_requests",
		]);
	});

	test("a non-empty target throws conflict and stays unchanged", async () => {
		const db = await target();
		await insert(db, "projects", { id: 1, org: 1, key: "existing", name: "Existing", created_at: time });
		const before = await allRows(db);
		try {
			await importArchive(db, linesOf(await archive(await source())));
			throw new Error("import should have conflicted");
		} catch (error) {
			expect(error).toBeInstanceOf(OpError);
			if (!(error instanceof OpError)) throw error;
			expect(error.code).toBe("conflict");
		}
		expect(await allRows(db)).toEqual(before);
	});

	test("a deferred foreign-key violation rolls back, including when a caller catches it", async () => {
		const text = rehash((await archive(await source())).replace('"org":17', '"org":9999'));
		await refuse(text, /foreign key/i);
		const db = await target();
		const before = await allRows(db);
		await db.transaction(async () => {
			await expect(importArchive(db, linesOf(text))).rejects.toThrow(/foreign key/i);
		});
		expect(await allRows(db)).toEqual(before);
	});

	test("invalid archived row constraints produce an invalid operation error and roll back", async () => {
		const db = await target();
		const before = await allRows(db);
		const text = rehash((await archive(await source())).replace('"name":"Archive organisation"', '"name":null'));
		try {
			await importArchive(db, linesOf(text));
			throw new Error("import should have refused a NULL organisation name");
		} catch (error) {
			expect(error).toBeInstanceOf(OpError);
			if (!(error instanceof OpError)) throw error;
			expect(error.code).toBe("invalid");
			expect(error.message).toContain("orgs");
		}
		expect(await allRows(db)).toEqual(before);
	});

	test("trailing input, empty input and attempts to import excluded data are refused", async () => {
		const text = await archive(await source());
		await refuse(`${text}{"end":true}\n`, /after.*footer|trailing/);
		await refuse("", /header|empty/);
		await refuse(text.replace('"key":"instance-note"', '"key":"schema_version"'), /schema_version/);
		await refuse(text.replace('"t":"meta"', '"t":"tokens"'), /tokens/);
		await refuse(text.replace('"t":"meta"', '"t":"search_docs"'), /search_docs/);
	});

	test("a missing head version or invalid search body rolls back index rebuilding", async () => {
		const text = await archive(await source());
		await refuse(rehash(text.replace('"head":2', '"head":99')), /head.*version|version.*head/);
		await refuse(rehash(text.replace('\\"pre\\": \\"Précondition 雪\\"', '\\"pre\\": null')), /search|body|pre/);
	});

	test("50,000 result rows are exported and imported, with timing and complete data checks", async () => {
		const from = await source();
		const to = await target();
		const row = fixtures.results?.[0];
		if (!row) throw new Error("missing result fixture");
		await from.transaction(() =>
			from.runDynamic(
				`INSERT INTO results (id, project, test, seq, ord, batch, target, method, actor, basis, outcome, at)
   SELECT 201 + n, 23, 501, 1, n, 504, 502, 'auto', 71, 'unresolved', 'pass', $1 FROM generate_series(2, 49999) n`,
				[time],
			),
		);
		const chunks: string[] = [];
		const start = performance.now();
		const exported = await exportArchive(from, (chunk) => chunks.push(chunk), { now: time });
		const exportedAt = performance.now();
		const text = chunks.join("");
		const importStart = performance.now();
		const imported = await importArchive(to, linesOf(text));
		const finished = performance.now();
		expect(exported.tables.results).toBe(50_000);
		expect(imported.tables.results).toBe(50_000);
		expect(imported.rows).toBe(exported.rows);
		expect(await dump(to)).toEqual(await dump(from));
		console.log(
			`50,000 results, one PostgreSQL run: export ${(exportedAt - start).toFixed(1)} ms, import ${(finished - importStart).toFixed(1)} ms, ${Buffer.byteLength(text)} bytes, ${chunks.length} chunks, 0 failures`,
		);
	}, 30_000);
});

describe("archive line helpers", () => {
	test("splits lazily, keeps blank lines and carriage returns, and omits only the final separator", () => {
		expect([...linesOf("")]).toEqual([]);
		expect([...linesOf("one\ntwo\n")]).toEqual(["one", "two"]);
		expect([...linesOf("one\n\ntwo")]).toEqual(["one", "", "two"]);
		expect([...linesOf("one\r\ntwo\r\n")]).toEqual(["one\r", "two\r"]);
	});

	test("decodes split UTF-8 code points and line boundaries without discarding bytes", async () => {
		const text = "雪 ☃ café\n\nlast\r\nunterminated";
		const bytes = new TextEncoder().encode(text);
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
				controller.close();
			},
		});
		const lines: string[] = [];
		for await (const line of linesOfStream(stream)) lines.push(line);
		expect(lines).toEqual([...linesOf(text)]);
		expect(stream.locked).toBe(false);
	});

	test("invalid UTF-8 is refused and releases the stream lock", async () => {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(Uint8Array.of(0xc3, 0x28));
				controller.close();
			},
		});
		const read = async () => {
			for await (const _line of linesOfStream(stream)) {
				/* consume */
			}
		};
		await expect(read()).rejects.toThrow();
		expect(stream.locked).toBe(false);
	});
});

test("archive import leaves a landed change open without naming its landing on trunk", async () => {
	const from = await harness();
	const to = await harness();
	try {
		const commit = "1234567890abcdef1234567890abcdef12345678";
		await from.call("report", {
			target: { repo: "acme/shop", commit: "feature0001", branch: "feature", pr: 8, title: "Keep coupons" },
			results: [{ test: { key: "checkout" }, outcome: "pass" }],
		});
		await from.call("change", { change: "pr:8", state: "merged", landing: { commit, branch: "main" } });
		await from.call("report", {
			target: { repo: "acme/shop", commit, branch: "main" },
			results: [{ test: { key: "checkout" }, outcome: "pass" }],
		});
		const history = async (h: typeof from) =>
			(await h.call<{ last: unknown[] }[]>("get", { refs: ["T-1"] }))[0]?.last[0];
		expect(await history(from)).toMatchObject({
			location: { label: "main · pr:8 Keep coupons", commit, change: "pr:8" },
		});
		const chunks: string[] = [];
		await from.app.database.read((db) => exportArchive(db, (chunk) => chunks.push(chunk), { project: "scratch" }));
		const archive = chunks.join("");
		expect(archive).not.toContain('"t":"change_ends"');
		await to.app.database.write((db) =>
			db.transaction(async () => {
				await db.transaction(() => db.exec("DELETE FROM commands"));
				await removeBootstrap(db);
				await importArchive(db, linesOf(archive));
			}),
		);
		expect(await history(to)).toMatchObject({ location: { label: "main", commit, change: null } });
		expect(await to.call("find", { in: "changes" })).toMatchObject({ items: [{ key: "pr:8", state: "open" }] });
	} finally {
		await from.close();
		await to.close();
	}
});
