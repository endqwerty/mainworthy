import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Db } from "../kernel/db.ts";
import { OpError } from "../kernel/errors.ts";
import { migrate, SCHEMA_VERSION } from "../kernel/migrate.ts";
import { exportArchive, importArchive, linesOf, linesOfStream } from "./transfer.ts";

// Completion checks use real migrated SQLite databases: compare every stored column, query rebuilt FTS,
// compare the target before/after rejected input, and time actual export/import of 50,000 result rows.
type Value = string | number | bigint | null;
type Row = Record<string, Value>;
const opened: Db[] = [];
const time = 1_791_741_600_000;
const body = `{
  "title": "雪だるま ☃ café", "pre": "Précondition 雪", "methods": ["human", "auto"],
  "automate": "wanted", "steps": [
    {"id": "sone", "action": "Inspect nebulouswidget", "expected": "A luminousreply appears"},
    {"id": "stwo", "action": "Leave empty", "expected": null}
  ], "fields": {}
}`;

const fixtures: Record<string, Row[]> = {
	meta: [{ key: "instance-note", value: "  canonical text\n雪 ☃  " }],
	orgs: [{ id: 17, name: "Archive organisation", created_at: time }],
	actors: [
		{ id: 71, org: 17, kind: "human", name: "Zoë 雪", on_behalf_of: null, created_at: time, disabled_at: null },
		{ id: 70, org: 17, kind: "agent", name: "Agent", on_behalf_of: 71, created_at: time, disabled_at: time + 1 },
	],
	grants: [
		{ actor: 71, project: 23, can: '[ "read", "admin" ]' },
		{ actor: 71, project: 0, can: '["read"]' },
	],
	projects: [{ id: 23, org: 17, key: "qa", name: "雪 project", seq: Number.MAX_SAFE_INTEGER, created_at: time }],
	counters: [
		{ project: 23, name: "version", value: 9_223_372_036_854_775_807n },
		{ project: 23, name: "case", value: -9_223_372_036_854_775_808n },
	],
	commands: [
		{ id: "cmd-雪", project: 23, op: "propose", actor: 71, at: time, seq: 1, touched: '[ "C-1" ]', outcome: "{}" },
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
	changes: [
		{
			id: 503,
			project: 23,
			key: "change-one",
			repo: null,
			base_sha: null,
			head_sha: null,
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
	signatures: [{ id: 505, project: 23, hash: "signature-one", class: "assertion", text: "雪 expected", first_seq: 1 }],
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
			duration_ms: 9_223_372_036_854_775_807n,
			signature: 505,
			message: "雪\nfailed",
			detail: "",
			at_step: "s-one",
			steps: '[ { "id": "s-one", "outcome": "fail" } ]',
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
			steps: null,
			note: "é",
			run: null,
			corrects: 201,
			at: time + 1,
		},
	],
	flips: [{ id: 506, project: 23, test: 501, target: 502, first_result: 201, second_result: 200, seq: 2 }],
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
			clauses: "[]",
			settings: '{ "named": "雪" }',
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

function database(): Db {
	const db = new Db(":memory:");
	opened.push(db);
	migrate(db, ":memory:");
	return db;
}

function identifier(name: string): string {
	return `"${name.replaceAll('"', '""')}"`;
}

function insert(db: Db, table: string, row: Row): void {
	const columns = Object.keys(row);
	db.raw
		.query<unknown, Value[]>(
			`INSERT INTO ${identifier(table)} (${columns.map(identifier).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
		)
		.run(...Object.values(row));
}

function source(): Db {
	const db = database();
	db.transaction(() => {
		db.raw.exec("PRAGMA defer_foreign_keys = ON");
		for (const [table, rows] of Object.entries(fixtures)) {
			for (const row of rows) insert(db, table, row);
		}
		insert(db, "tokens", {
			id: 900,
			actor: 71,
			hash: "synthetic-source-credential-hash",
			label: "test",
			created_at: time,
		});
		db.raw
			.query("INSERT INTO search_docs (rowid, title, body, tags, project) VALUES (?, ?, ?, ?, ?)")
			.run(101, "stale title", "obsoleteindexword", "stale", 23);
	});
	return db;
}

function target(): Db {
	const db = database();
	insert(db, "orgs", { id: 1, name: "default", created_at: time });
	insert(db, "actors", { id: 1, org: 1, kind: "human", name: "bootstrap owner", created_at: time });
	insert(db, "actors", { id: 2, org: 1, kind: "rule", name: "bootstrap rule", created_at: time });
	insert(db, "grants", { actor: 1, project: 0, can: '["admin"]' });
	insert(db, "tokens", {
		id: 1,
		actor: 1,
		hash: "synthetic-target-credential-hash",
		label: "bootstrap",
		created_at: time,
	});
	insert(db, "meta", { key: "bootstrap-note", value: "unchanged on refusal" });
	db.raw
		.query("INSERT INTO search_docs (rowid, title, body, tags, project) VALUES (1, '', 'bootstrapindexword', '', 0)")
		.run();
	return db;
}

function archive(db: Db, now = time): string {
	const chunks: string[] = [];
	exportArchive(db, (chunk) => chunks.push(chunk), { now });
	return chunks.join("");
}

function tables(db: Db): string[] {
	return db.raw
		.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
		.all()
		.map((row) => row.name);
}

function exportedTables(db: Db): string[] {
	return tables(db).filter(
		(name) => name !== "tokens" && !name.startsWith("search_docs") && !name.startsWith("sqlite_"),
	);
}

function dump(db: Db): Record<string, string[]> {
	return Object.fromEntries(
		exportedTables(db).map((table) => {
			const columns = db.raw.query<{ name: string; pk: number }, []>(`PRAGMA table_info(${identifier(table)})`).all();
			const primary = columns.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk);
			const fields = columns.flatMap((column) => [`'${column.name.replaceAll("'", "''")}'`, identifier(column.name)]);
			const where = table === "meta" ? "WHERE key != 'schema_version'" : "";
			return [
				table,
				db.raw
					.query<{ row: string }, []>(
						`SELECT json_object(${fields.join(", ")}) AS row FROM ${identifier(table)} ${where} ORDER BY ${primary.map((column) => identifier(column.name)).join(", ")}`,
					)
					.all()
					.map((row) => row.row),
			];
		}),
	);
}

function allRows(db: Db): Record<string, unknown[]> {
	return Object.fromEntries(
		tables(db).map((table) => [table, db.raw.query<unknown, []>(`SELECT * FROM ${identifier(table)}`).all()]),
	);
}

function rehash(text: string): string {
	const lines = [...linesOf(text)];
	lines.pop();
	const preceding = `${lines.join("\n")}\n`;
	const rows = lines.filter((line) => line.startsWith('{"t":')).length;
	return `${preceding}${JSON.stringify({ end: true, rows, sha256: createHash("sha256").update(preceding).digest("hex") })}\n`;
}

function refuse(text: string, message: string | RegExp): void {
	const db = target();
	const before = allRows(db);
	expect(() => importArchive(db, linesOf(text))).toThrow(message);
	expect(allRows(db)).toEqual(before);
	expect(db.raw.inTransaction).toBe(false);
}

afterEach(() => {
	for (const db of opened.splice(0)) db.close();
});

describe("Casebook instance archives", () => {
	test("every included table and column survives replay, including full 64-bit integers", () => {
		const from = source();
		const to = target();
		expect(Object.keys(fixtures).sort()).toEqual(exportedTables(from));
		const text = archive(from);
		const result = importArchive(to, linesOf(text));
		expect(dump(to)).toEqual(dump(from));
		for (const table of exportedTables(from)) expect(result.tables[table]).toBeGreaterThan(0);
		expect(result.rows).toBe(Object.values(result.tables).reduce((sum, count) => sum + count, 0));
		expect(text).toContain('"value":9223372036854775807');
		expect(text).toContain('"value":-9223372036854775808');
		expect(text).toContain('"duration_ms":9223372036854775807');
		expect(to.raw.query("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({
			value: String(SCHEMA_VERSION),
		});
		expect(to.raw.query("SELECT * FROM tokens").all()).toEqual([]);
	});

	test("exports are deterministic apart from exportedAt, with a verifiable footer", () => {
		const db = source();
		const first = archive(db, 100);
		const second = archive(db, 200);
		const normalize = (text: string) =>
			text.replace(/"exportedAt":\d+/, '"exportedAt":0').replace(/"sha256":"[a-f0-9]+"/, '"sha256":""');
		expect(archive(db, 100)).toBe(first);
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

	test("tables follow foreign-key dependencies and rows follow composite primary keys", () => {
		const db = source();
		const text = archive(db);
		const positions = new Map(exportedTables(db).map((name) => [name, text.indexOf(`"t":${JSON.stringify(name)}`)]));
		for (const table of exportedTables(db)) {
			for (const foreign of db.raw
				.query<{ table: string }, []>(`PRAGMA foreign_key_list(${identifier(table)})`)
				.all()) {
				if (foreign.table !== table) expect(positions.get(foreign.table)).toBeLessThan(positions.get(table) ?? -1);
			}
		}
		expect(text.indexOf('"name":"case","value":')).toBeLessThan(text.indexOf('"name":"version","value":'));
		expect(text.indexOf('"actor":71,"project":0,')).toBeLessThan(text.indexOf('"actor":71,"project":23,'));
		expect(text.indexOf('"id":200,"project":23,')).toBeLessThan(text.indexOf('"id":201,"project":23,'));
	});

	test("rebuilds the head version's title, preconditions, steps and tags, including archived cases", () => {
		const db = target();
		importArchive(db, linesOf(archive(source())));
		const query = db.raw.query<{ rowid: number }, [string]>("SELECT rowid FROM search_docs WHERE search_docs MATCH ?");
		for (const term of ["nebulouswidget", "luminousreply", "Précondition", "regression", "café"]) {
			expect(query.all(term)).toEqual([{ rowid: 101 }]);
		}
		for (const term of ["obsoleteindexword", "bootstrapindexword", "Old"]) expect(query.all(term)).toEqual([]);
		expect(db.raw.query("SELECT title, body, tags, project FROM search_docs WHERE rowid = 101").get()).toEqual({
			title: "雪だるま ☃ café",
			body: "Précondition 雪\nInspect nebulouswidget\nA luminousreply appears\nLeave empty",
			tags: "café 雪 regression",
			project: 23,
		});
	});

	test("replays a model-valid case whose step has no expected result", () => {
		const from = source();
		const to = target();
		const validBody = JSON.stringify({
			title: "An unfinished expectation",
			pre: "",
			steps: [{ id: "s1", action: "Inspect unansweredstep", expected: null }],
			methods: ["human"],
			automate: "none",
			fields: {},
		});
		from.raw.query("UPDATE versions SET body = ? WHERE case_id = 101 AND no = 2").run(validBody);
		importArchive(to, linesOf(archive(from)));
		expect(dump(to)).toEqual(dump(from));
		expect(to.raw.query("SELECT body FROM search_docs WHERE rowid = 101").get()).toEqual({
			body: "\nInspect unansweredstep",
		});
		expect(to.raw.query("SELECT rowid FROM search_docs WHERE search_docs MATCH 'unansweredstep'").all()).toEqual([
			{ rowid: 101 },
		]);
	});

	test("discovers added tables, quoted identifiers and added columns without an archive list", () => {
		const from = source();
		const to = target();
		for (const db of [from, to])
			db.raw.exec(`
			ALTER TABLE cases ADD COLUMN extra_text TEXT;
			CREATE TABLE "future 'table" ("odd column" INTEGER PRIMARY KEY, owner INTEGER REFERENCES cases(id), note TEXT) STRICT;
		`);
		from.raw.query("UPDATE cases SET extra_text = ?").run("new\ncolumn 雪");
		insert(from, "future 'table", { "odd column": 9_223_372_036_854_775_807n, owner: 101, note: "" });
		const result = importArchive(to, linesOf(archive(from)));
		expect(result.tables["future 'table"]).toBe(1);
		expect(dump(to)).toEqual(dump(from));
	});

	test("SQLite table and column names that match object prototypes remain lossless", () => {
		const from = source();
		const to = target();
		for (const db of [from, to])
			db.raw.exec(`
			CREATE TABLE future_notes (id INTEGER PRIMARY KEY, "__proto__" TEXT) STRICT;
			CREATE TABLE "__proto__" (id INTEGER PRIMARY KEY, "constructor" TEXT) STRICT;
		`);
		from.raw.query("INSERT INTO future_notes VALUES (1, ?)").run("preserved column");
		from.raw.query('INSERT INTO "__proto__" VALUES (1, ?)').run("preserved table");
		importArchive(to, linesOf(archive(from)));
		expect(dump(to)).toEqual(dump(from));
	});

	test("unknown prototype-named tables and columns are named and refused", () => {
		refuse(rehash(archive(source()).replace('"tables":{', '"tables":{"__proto__":0,')), /unknown.*table.*__proto__/i);
		refuse(rehash(archive(source()).replace('"r":{', '"r":{"__proto__":"unknown",')), /unknown.*column.*__proto__/i);
	});

	test("emits complete lines in approximately 64 KiB chunks within a read transaction", () => {
		const db = source();
		for (let i = 0; i < 2_000; i++) insert(db, "meta", { key: `chunk-${i}`, value: "雪".repeat(40) });
		const chunks: string[] = [];
		exportArchive(
			db,
			(chunk) => {
				expect(db.raw.inTransaction).toBe(true);
				expect(chunk.endsWith("\n")).toBe(true);
				expect(Buffer.byteLength(chunk)).toBeLessThanOrEqual(64 * 1024);
				for (const line of linesOf(chunk)) expect(() => JSON.parse(line)).not.toThrow();
				chunks.push(chunk);
			},
			{ now: time },
		);
		expect(chunks.length).toBeGreaterThan(3);
		expect(db.raw.inTransaction).toBe(false);
		expect(importArchive(target(), linesOf(chunks.join(""))).tables.meta).toBe(2_001);
	});

	test("an oversized row stays one line and a failing writer releases the read transaction", () => {
		const db = source();
		insert(db, "meta", { key: "large-document", value: "雪".repeat(40_000) });
		const chunks: string[] = [];
		exportArchive(db, (chunk) => chunks.push(chunk));
		expect(chunks.some((chunk) => Buffer.byteLength(chunk) > 64 * 1024 && [...linesOf(chunk)].length === 1)).toBe(true);
		expect(() =>
			exportArchive(db, () => {
				throw new Error("writer failed");
			}),
		).toThrow("writer failed");
		expect(db.raw.inTransaction).toBe(false);
		const to = target();
		importArchive(to, linesOf(archive(db)));
		expect(dump(to)).toEqual(dump(db));
	});

	test("invalid UTF-8 in stored TEXT is refused instead of replacing bytes", () => {
		const db = source();
		db.raw.exec("UPDATE meta SET value = CAST(X'61FF62' AS TEXT) WHERE key = 'instance-note'");
		expect(() => exportArchive(db, () => {})).toThrow(/UTF-8/);
		expect(db.raw.inTransaction).toBe(false);
	});

	test("an instance with no rows exports every table with zero counts and can be replayed", () => {
		const from = database();
		const to = target();
		const imported = importArchive(to, linesOf(archive(from)));
		expect(imported.rows).toBe(0);
		expect(Object.keys(imported.tables).sort()).toEqual(exportedTables(from));
		expect(Object.values(imported.tables).every((count) => count === 0)).toBe(true);
		expect(dump(to)).toEqual(dump(from));
	});

	test("a missing footer rolls back every row and bootstrap deletion", () => {
		const lines = [...linesOf(archive(source()))];
		lines.pop();
		refuse(`${lines.join("\n")}\n`, /footer|truncated/);
	});

	test("a truncated footer is refused without changing the target", () => {
		refuse(archive(source()).slice(0, -20), /JSON|footer|archive/);
	});

	test("a flipped byte is refused without changing the target", () => {
		refuse(archive(source()).replace("Archive organisation", "Brchive organisation"), /hash|checksum|SHA/);
	});

	test("a wrong footer row count is refused without changing the target", () => {
		refuse(archive(source()).replace(/"rows":\d+/, '"rows":0'), /row count/);
	});

	test("a wrong per-table count is refused even with a valid checksum", () => {
		refuse(rehash(archive(source()).replace(/"results":2/, '"results":3')), /results.*count|count.*results/);
	});

	test("an unknown row table is named and rolled back", () => {
		refuse(archive(source()).replace('"t":"meta"', '"t":"unknown_table"'), /unknown.*table.*unknown_table/i);
	});

	test("an unknown header table is named and refused", () => {
		refuse(archive(source()).replace('"tables":{', '"tables":{"unknown_table":0,'), /unknown.*table.*unknown_table/i);
	});

	test("an unknown column is named and rolled back", () => {
		refuse(
			archive(source()).replace('"key":"instance-note"', '"unknown_column":"instance-note"'),
			/unknown.*column.*unknown_column/i,
		);
	});

	test("newer formats are refused before changing the target", () => {
		refuse(archive(source()).replace('"format":1', '"format":2'), /format.*2/);
	});

	test("newer and older schemas are refused with a clear message", () => {
		refuse(
			archive(source()).replace(`"schema":${SCHEMA_VERSION}`, `"schema":${SCHEMA_VERSION + 1}`),
			/schema.*newer|newer.*schema/,
		);
		refuse(archive(source()).replace(`"schema":${SCHEMA_VERSION}`, '"schema":0'), /schema.*older|older.*schema/);
	});

	test("a non-empty target throws conflict and stays unchanged", () => {
		const db = target();
		insert(db, "projects", { id: 1, org: 1, key: "existing", name: "Existing", created_at: time });
		const before = allRows(db);
		try {
			importArchive(db, linesOf(archive(source())));
			throw new Error("import should have conflicted");
		} catch (error) {
			expect(error).toBeInstanceOf(OpError);
			if (!(error instanceof OpError)) throw error;
			expect(error.code).toBe("conflict");
		}
		expect(allRows(db)).toEqual(before);
	});

	test("a deferred foreign-key violation rolls back, including when a caller catches it", () => {
		const text = rehash(archive(source()).replace('"org":17', '"org":9999'));
		refuse(text, /foreign key/i);
		const db = target();
		const before = allRows(db);
		db.transaction(() => {
			expect(() => importArchive(db, linesOf(text))).toThrow(/foreign key/i);
		});
		expect(allRows(db)).toEqual(before);
	});

	test("nested import restores the caller's foreign-key deferral setting after success or failure", () => {
		const text = archive(source());
		for (const deferred of [0, 1]) {
			for (const fail of [false, true]) {
				const db = target();
				db.transaction(() => {
					db.raw.exec(`PRAGMA defer_foreign_keys = ${deferred}`);
					if (fail) {
						expect(() =>
							importArchive(db, linesOf(text.replace("Archive organisation", "Brchive organisation"))),
						).toThrow(/checksum/);
					} else {
						importArchive(db, linesOf(text));
					}
					expect(db.raw.query<{ defer_foreign_keys: number }, []>("PRAGMA defer_foreign_keys").get()).toEqual({
						defer_foreign_keys: deferred,
					});
					if (deferred === 0) {
						expect(() => db.raw.query("INSERT INTO grants (actor, can) VALUES (9999, '[]')").run()).toThrow(
							/FOREIGN KEY/,
						);
					}
				});
			}
		}
	});

	test("nested import preserves a caller's already pending deferred constraint", () => {
		const from = source();
		const db = target();
		for (const instance of [from, db])
			instance.raw.exec(`CREATE TABLE future_rows (
			id INTEGER PRIMARY KEY, org INTEGER REFERENCES orgs(id) DEFERRABLE INITIALLY DEFERRED
		) STRICT`);
		const text = archive(from).replace("Archive organisation", "Brchive organisation");
		expect(() =>
			db.transaction(() => {
				db.raw.query("INSERT INTO future_rows VALUES (1, 9999)").run();
				expect(() => importArchive(db, linesOf(text))).toThrow();
				expect(db.raw.query<{ defer_foreign_keys: number }, []>("PRAGMA defer_foreign_keys").get()).toEqual({
					defer_foreign_keys: 0,
				});
			}),
		).toThrow(/FOREIGN KEY/);
		expect(db.raw.query("SELECT * FROM future_rows").all()).toEqual([]);
	});

	test("invalid archived row constraints produce an invalid operation error and roll back", () => {
		const db = target();
		const before = allRows(db);
		const text = rehash(archive(source()).replace('"name":"Archive organisation"', '"name":null'));
		try {
			importArchive(db, linesOf(text));
			throw new Error("import should have refused a NULL organisation name");
		} catch (error) {
			expect(error).toBeInstanceOf(OpError);
			if (!(error instanceof OpError)) throw error;
			expect(error.code).toBe("invalid");
			expect(error.message).toContain("orgs");
		}
		expect(allRows(db)).toEqual(before);
	});

	test("trailing input, empty input and attempts to import excluded data are refused", () => {
		refuse(`${archive(source())}{"end":true}\n`, /after.*footer|trailing/);
		refuse("", /header|empty/);
		refuse(archive(source()).replace('"key":"instance-note"', '"key":"schema_version"'), /schema_version/);
		refuse(archive(source()).replace('"t":"meta"', '"t":"tokens"'), /tokens/);
		refuse(archive(source()).replace('"t":"meta"', '"t":"search_docs"'), /search_docs/);
	});

	test("a missing head version or invalid search body rolls back index rebuilding", () => {
		refuse(rehash(archive(source()).replace('"head":2', '"head":99')), /head.*version|version.*head/);
		refuse(rehash(archive(source()).replace('\\"pre\\": \\"Précondition 雪\\"', '\\"pre\\": null')), /search|body|pre/);
	});

	test("50,000 result rows are exported and imported, with timing and complete data checks", () => {
		const from = source();
		const to = target();
		const row = fixtures.results?.[0];
		if (!row) throw new Error("missing result fixture");
		const columns = Object.keys(row);
		const statement = from.raw.prepare<unknown, Value[]>(
			`INSERT INTO results (${columns.map(identifier).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
		);
		try {
			from.transaction(() => {
				for (let i = 2; i < 50_000; i++)
					statement.run(
						...columns.map((column) => {
							if (column === "id") return 201 + i;
							if (column === "ord") return i;
							return row[column] ?? null;
						}),
					);
			});
		} finally {
			statement.finalize();
		}
		const chunks: string[] = [];
		const start = performance.now();
		const exported = exportArchive(from, (chunk) => chunks.push(chunk), { now: time });
		const exportedAt = performance.now();
		const text = chunks.join("");
		const importStart = performance.now();
		const imported = importArchive(to, linesOf(text));
		const finished = performance.now();
		expect(exported.tables.results).toBe(50_000);
		expect(imported.tables.results).toBe(50_000);
		expect(imported.rows).toBe(exported.rows);
		expect(dump(to)).toEqual(dump(from));
		console.log(
			`50,000 results, one in-memory run: export ${(exportedAt - start).toFixed(1)} ms, import ${(finished - importStart).toFixed(1)} ms, ${Buffer.byteLength(text)} bytes, ${chunks.length} chunks, 0 failures`,
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
