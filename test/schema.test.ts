import { afterAll, beforeAll, expect, test } from "bun:test";
import { type ReservedSQL, SQL } from "bun";
import { schemaCatalog } from "../scripts/port-schema.ts";
import { Database } from "../src/server/kernel/db.ts";
import {
	ARCHIVE_VERSION,
	baselineSchema,
	migrate,
	SCHEMA_VERSION,
	schemaVersion,
} from "../src/server/kernel/migrate.ts";
import { testDatabase } from "./db.ts";
import { BEFORE_EIGHT } from "./migration-undo.ts";

let db: ReservedSQL;
let pool: SQL;
let database: Database;
let cleanup: () => Promise<void> = async () => {};

beforeAll(async () => {
	const fixture = await testDatabase({ schema: "empty" });
	cleanup = async () => {
		await fixture.close();
	};
	database = await Database.open({ url: fixture.url });
	await migrate(database);
	pool = new SQL(fixture.url, { max: 1, bigint: true });
	db = await pool.reserve();
}, 30_000);

afterAll(async () => {
	db?.release();
	await pool?.close();
	await database?.close();
	await cleanup();
});

test("PostgreSQL 18 baseline catalog matches the reviewed snapshot", async () => {
	expect(
		(await db.unsafe<{ version: string }[]>("SELECT current_setting('server_version') AS version"))[0]?.version,
	).toMatch(/^18\./);
	expect(
		(await schemaCatalog(db)).map((row) => `${row.kind} ${row.name}: ${row.definition}`.trimEnd()).join("\n"),
	).toMatchSnapshot();
});

test("reapplying a baseline is a ledger no-op", async () => {
	const before = await db.unsafe("SELECT key,value,xmin::text,ctid::text FROM meta ORDER BY key");
	await migrate(database);
	await migrate(database);
	expect(await db.unsafe("SELECT key,value,xmin::text,ctid::text FROM meta ORDER BY key")).toEqual(before);
	expect(await database.read(schemaVersion)).toBe(SCHEMA_VERSION);
	expect(await db.unsafe<{ key: string; value: string }[]>("SELECT key,value FROM meta ORDER BY key")).toEqual([
		{ key: "archive_version", value: String(ARCHIVE_VERSION) },
		{ key: "baseline_hash", value: baselineSchema().hash },
		{ key: "schema_version", value: String(SCHEMA_VERSION) },
	]);
});

test("concurrent starters apply one baseline under the migration lease", async () => {
	const fixture = await testDatabase({ schema: "empty" });
	const first = await Database.open({ url: fixture.url });
	const second = await Database.open({ url: fixture.url });
	try {
		await Promise.all([migrate(first), migrate(second)]);
		expect(await first.read(schemaVersion)).toBe(SCHEMA_VERSION);
		expect(await second.read(schemaVersion)).toBe(SCHEMA_VERSION);
	} finally {
		await first.close();
		await second.close();
		await fixture.close();
	}
});

test("the fixture builds and clones the baseline template", async () => {
	const fixture = await testDatabase();
	const cloned = await Database.open({ url: fixture.url });
	try {
		expect(await cloned.read(schemaVersion)).toBe(SCHEMA_VERSION);
		expect(
			await cloned.read(
				async (reader) =>
					await reader.allDynamic(
						"SELECT key,value FROM meta WHERE key IN ('baseline_hash','archive_version') ORDER BY key",
					),
			),
		).toEqual([
			{ key: "archive_version", value: String(ARCHIVE_VERSION) },
			{ key: "baseline_hash", value: baselineSchema().hash },
		]);
	} finally {
		await cloned.close();
		await fixture.close();
	}
});

test("failed DDL rolls back the entire baseline; the released lease can retry", async () => {
	const fixture = await testDatabase({ schema: "empty" });
	const target = await Database.open({ url: fixture.url });
	const raw = new SQL(fixture.url, { max: 1 });
	try {
		// Conflict late in the baseline so earlier CREATE statements must roll back.
		await raw.unsafe("CREATE TABLE results(id bigint)");
		await expect(migrate(target)).rejects.toThrow();
		expect(await target.read(schemaVersion)).toBe(0);
		expect(
			await raw.unsafe<{ tablename: string }[]>(
				"SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
			),
		).toEqual([{ tablename: "results" }]);
		await raw.unsafe("DROP TABLE results");
		await migrate(target);
		expect(await target.read(schemaVersion)).toBe(SCHEMA_VERSION);
		await raw.unsafe("UPDATE meta SET value='wrong' WHERE key='baseline_hash'");
		await expect(migrate(target)).rejects.toThrow("baseline does not match");
		await raw.unsafe("UPDATE meta SET value='999' WHERE key='schema_version'");
		await expect(migrate(target)).rejects.toThrow("newer than this build");
	} finally {
		await raw.close();
		await target.close();
		await fixture.close();
	}
});

test("every foreign key can be deferred and starts immediate", async () => {
	const rows = await db.unsafe<{ name: string }[]>(
		"SELECT conname AS name FROM pg_constraint WHERE contype='f' AND (NOT condeferrable OR condeferred)",
	);
	expect(rows).toEqual([]);
});

const seed = `
INSERT INTO orgs(id,name,created_at) VALUES(1,'org',0);
INSERT INTO projects(id,org,key,name,created_at,identity) VALUES(1,1,'project','project',0,'identity');
INSERT INTO actors(id,org,kind,name,created_at) VALUES(1,1,'human','robin',0);
INSERT INTO questions(id,project,no,kind,subject,fingerprint,title,producer,evidence,evidence_hash,basis,
 seen_first,seen_last,ask,blocks,rank,state,opened_at,rev)
 VALUES(1,1,1,'failure','subject','fingerprint','title','human','{}','hash','{}',0,0,'{}','[]',0,'open',0,0);
INSERT INTO decisions(id,project,question,kind,answer,signers,basis,holds,at,seq)
 VALUES(1,1,1,'failure','flaky','[]','{}','{}',0,1),(2,1,1,'failure','flaky','[]','{}','{}',0,2);
INSERT INTO signatures(id,project,hash,text,first_seq) VALUES(1,1,'hash1','first',1),(2,1,'hash2','second',2);
INSERT INTO targets(id,project,what,line,first_seq) VALUES(1,1,'first','trunk',1),(2,1,'second','trunk',2);
INSERT INTO tests(id,project,no,kind,key,name,first_seq,last_seq)
 VALUES(1,1,1,'auto','test1','first',1,1),(2,1,2,'auto','test2','second',2,2);
INSERT INTO batches(id,project,key,target,method,actor,state,counts,at,seq)
 VALUES(1,1,'batch1',1,'auto',1,'processed','{}',0,1),(2,1,'batch2',2,'auto',1,'processed','{}',0,2);
INSERT INTO results(id,project,test,seq,ord,batch,target,method,actor,basis,outcome,signature,at,quarantine_decision)
 VALUES(32,1,1,1,0,1,1,'auto',1,'unresolved','fail',1,0,1),(64,1,2,2,0,2,2,'auto',1,'unresolved','fail',2,0,1);
INSERT INTO runs(id,project,no,name,origin,accepts,require,tally,verdict,created_by,created_at,rev)
 VALUES(1,1,1,'first','planned','{}','{}','{}','failed',1,0,1),(2,1,2,'second','planned','{}','{}','{}','failed',1,0,2);
INSERT INTO run_tests(run,test,result,outcome,signature,attempt,lane,target)
 VALUES(1,1,32,'fail',1,1,'first',1),(2,2,64,'fail',2,1,'second',2);
INSERT INTO merge_receipt_heads(run,project) VALUES(1,1),(2,1);
`;
const correction = (
	corrects: number,
) => `INSERT INTO results(id,project,test,seq,ord,batch,target,method,actor,basis,outcome,corrects,at)
 VALUES(96,1,1,3,0,1,1,'auto',1,'unresolved','pass',${corrects},0)`;
const excuse = "INSERT INTO excuses(project,signature,scope,decision,class) VALUES(1,1,'scope',1,'excused')";
const flip = "INSERT INTO flips(id,project,test,target,first_result,second_result,seq) VALUES(1,1,1,1,32,32,1)";
const resultExcuse = "INSERT INTO result_excuses(id,result,decision,class) VALUES(1,32,1,'excused')";
const quarantine = "INSERT INTO quarantines(project,test,decision,actor,reason,at,seq) VALUES(1,1,1,1,'reason',0,1)";
type TriggerCase = { name: string; table: string; setup?: string; action: string; dirty: [number, number][] };
const triggerCases: TriggerCase[] = [
	{ name: "receipt_batch", table: "batches", action: "UPDATE batches SET job='changed' WHERE id=1", dirty: [[1, 1]] },
	{
		name: "receipt_correction_delete_old",
		table: "results",
		setup: correction(32),
		action: "DELETE FROM results WHERE id=96",
		dirty: [[1, 1]],
	},
	{ name: "receipt_correction_insert_new", table: "results", action: correction(64), dirty: [[2, 2]] },
	{
		name: "receipt_correction_update_new",
		table: "results",
		setup: correction(32),
		action: "UPDATE results SET corrects=64 WHERE id=96",
		dirty: [[2, 2]],
	},
	{
		name: "receipt_correction_update_old",
		table: "results",
		setup: correction(32),
		action: "UPDATE results SET corrects=64 WHERE id=96",
		dirty: [[1, 1]],
	},
	{
		name: "receipt_excuses_delete_old",
		table: "excuses",
		setup: excuse,
		action: "DELETE FROM excuses",
		dirty: [[1, 1]],
	},
	{ name: "receipt_excuses_insert_new", table: "excuses", action: excuse, dirty: [[1, 1]] },
	{
		name: "receipt_excuses_update_new",
		table: "excuses",
		setup: excuse,
		action: "UPDATE excuses SET signature=2",
		dirty: [[2, 2]],
	},
	{
		name: "receipt_excuses_update_old",
		table: "excuses",
		setup: excuse,
		action: "UPDATE excuses SET signature=2",
		dirty: [[1, 1]],
	},
	{ name: "receipt_flips_delete_old", table: "flips", setup: flip, action: "DELETE FROM flips", dirty: [[1, 1]] },
	{ name: "receipt_flips_insert_new", table: "flips", action: flip, dirty: [[1, 1]] },
	{
		name: "receipt_flips_update_new",
		table: "flips",
		setup: flip,
		action: "UPDATE flips SET test=2,target=2",
		dirty: [[2, 2]],
	},
	{
		name: "receipt_flips_update_old",
		table: "flips",
		setup: flip,
		action: "UPDATE flips SET test=2,target=2",
		dirty: [[1, 1]],
	},
	{
		name: "receipt_quarantine_insert",
		table: "quarantines",
		action: quarantine,
		dirty: [
			[1, 1],
			[2, 2],
		],
	},
	{
		name: "receipt_quarantine_presence",
		table: "quarantines",
		setup: quarantine,
		action: "DELETE FROM quarantines",
		dirty: [
			[1, 1],
			[2, 2],
		],
	},
	{ name: "receipt_result", table: "results", action: "UPDATE results SET signature=2 WHERE id=32", dirty: [[1, 1]] },
	{
		name: "receipt_result_excuses_delete_old",
		table: "result_excuses",
		setup: resultExcuse,
		action: "DELETE FROM result_excuses",
		dirty: [[1, 1]],
	},
	{ name: "receipt_result_excuses_insert_new", table: "result_excuses", action: resultExcuse, dirty: [[1, 1]] },
	{
		name: "receipt_result_excuses_update_new",
		table: "result_excuses",
		setup: resultExcuse,
		action: "UPDATE result_excuses SET result=64",
		dirty: [[2, 2]],
	},
	{
		name: "receipt_result_excuses_update_old",
		table: "result_excuses",
		setup: resultExcuse,
		action: "UPDATE result_excuses SET result=64",
		dirty: [[1, 1]],
	},
	{ name: "receipt_run_delete", table: "run_tests", action: "DELETE FROM run_tests WHERE run=1", dirty: [[1, 1]] },
	{
		name: "receipt_run_insert",
		table: "run_tests",
		action: "INSERT INTO run_tests(run,test,result,outcome,attempt,lane,target) VALUES(2,1,32,'fail',1,'first',1)",
		dirty: [[2, 1]],
	},
	{
		name: "receipt_run_update_new",
		table: "run_tests",
		action: "UPDATE run_tests SET run=2,result=64 WHERE run=1",
		dirty: [[2, 2]],
	},
	{
		name: "receipt_run_update_old",
		table: "run_tests",
		action: "UPDATE run_tests SET run=2,result=64 WHERE run=1",
		dirty: [[1, 1]],
	},
	{ name: "receipt_target", table: "targets", action: "UPDATE targets SET env='changed' WHERE id=1", dirty: [[1, 1]] },
	{ name: "receipt_test", table: "tests", action: "UPDATE tests SET name='changed' WHERE id=1", dirty: [[1, 1]] },
];

async function dirty(): Promise<[number, number][]> {
	const rows = await db.unsafe<{ run: bigint; bucket: bigint }[]>(
		"SELECT run,bucket FROM merge_receipt_dirty ORDER BY run,bucket",
	);
	return rows.map((row) => [Number(row.run), Number(row.bucket)]);
}

for (const probe of triggerCases) {
	test(`${probe.name} invalidates precisely its receipt buckets`, async () => {
		await db.unsafe("BEGIN");
		try {
			// Exercise each original trigger alone: another old/new trigger cannot hide its absence.
			for (const table of new Set(triggerCases.map((item) => item.table))) {
				await db.unsafe(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
			}
			await db.unsafe(seed);
			if (probe.setup) await db.unsafe(probe.setup);
			await db.unsafe(`ALTER TABLE ${probe.table} ENABLE TRIGGER ${probe.name}`);
			expect(await dirty()).toEqual([]);
			await db.unsafe(probe.action);
			expect(await dirty()).toEqual(probe.dirty);
		} finally {
			await db.unsafe("ROLLBACK");
		}
	});
}

test("every receipt trigger has a behavioral probe", async () => {
	const rows = await db.unsafe<{ name: string }[]>(
		"SELECT tgname AS name FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE 'receipt_%' ORDER BY tgname",
	);
	expect(rows.map((row) => row.name)).toEqual(triggerCases.map((probe) => probe.name).sort());
});

test("receipt triggers together invalidate old and new buckets and ignore unchanged fields", async () => {
	await db.unsafe("BEGIN");
	try {
		await db.unsafe(seed);
		await db.unsafe(
			"UPDATE run_tests SET result=result; UPDATE tests SET name=name; UPDATE targets SET env=env; UPDATE batches SET job=job",
		);
		expect(await dirty()).toEqual([]);
		await db.unsafe("UPDATE run_tests SET run=2,result=64 WHERE run=1");
		expect(await dirty()).toEqual([
			[1, 1],
			[2, 2],
		]);
	} finally {
		await db.unsafe("ROLLBACK");
	}
});

test("search vectors follow insert, update and delete; prefixes, accents and title ranking survive", async () => {
	await db.unsafe("BEGIN");
	try {
		const find = async (query: string) =>
			(
				await db.unsafe<{ id: bigint }[]>(
					"SELECT id FROM search_docs WHERE tsv @@ to_tsquery('mainworthy_search', $1) ORDER BY ts_rank('{0.1,0.1,0.4,0.8}',tsv,to_tsquery('mainworthy_search',$1)) DESC,id",
					[query],
				)
			).map((row) => Number(row.id));
		await db.unsafe(
			"INSERT INTO search_docs(id,project,title,body,tags) VALUES(1,1,'Login rejects an expired password','Café coupon running the checkout','ranked'),(2,1,'Other','Password password password password','')",
		);
		expect(await find("expired & pass:*")).toEqual([1]);
		expect(await find("cafe")).toEqual([1]);
		expect(await find("the")).toEqual([1]); // no English stop words
		expect(await find("run")).toEqual([]); // no stemming, as with unicode61
		expect(await find("password")).toEqual([1, 2]);
		expect(await find("ranked")).toEqual([1]);
		await db.unsafe("UPDATE search_docs SET title='Payment accepted',body='freshword',tags='' WHERE id=1");
		expect(await find("expired & pass:*")).toEqual([]);
		expect(await find("cafe")).toEqual([]);
		expect(await find("ranked")).toEqual([]);
		expect(await find("fresh:*")).toEqual([1]);
		expect(
			await db.unsafe<{ id: bigint }[]>(
				"SELECT id FROM search_docs WHERE title_tsv @@ to_tsquery('mainworthy_search','payment')",
			),
		).toEqual([{ id: 1n }]);
		await db.unsafe("DELETE FROM search_docs WHERE id=1");
		expect(await find("fresh:*")).toEqual([]);
	} finally {
		await db.unsafe("ROLLBACK");
	}
});

test("search vector budgets retain UTF-8 prefixes and cannot overflow on oversized metadata", async () => {
	const vocabulary = Array.from({ length: 100_000 }, (_, i) => `word${i.toString(36).padStart(6, "0")}`).join(" ");
	await db.unsafe("BEGIN");
	try {
		await db.unsafe("INSERT INTO search_docs(id,project,title,tags,body) VALUES(1,1,$1,$2,$3)", [
			`titlecanary ${vocabulary}`,
			`tagcanary ${vocabulary}`,
			`earlycanary ${"éx ".repeat(30_000)} latecanary`,
		]);
		const [size] = await db.unsafe<{ bytes: number; title_bytes: number }[]>(
			"SELECT pg_column_size(tsv) AS bytes, pg_column_size(title_tsv) AS title_bytes FROM search_docs WHERE id=1",
		);
		expect(size?.bytes).toBeLessThan(3 * 262144);
		expect(size?.title_bytes).toBeLessThanOrEqual(262144);
		for (const word of ["titlecanary", "tagcanary", "earlycanary", "ex"]) {
			expect(
				await db.unsafe<{ id: bigint }[]>(
					"SELECT id FROM search_docs WHERE tsv @@ to_tsquery('mainworthy_search',$1)",
					[word],
				),
			).toEqual([{ id: 1n }]);
		}
		expect(
			await db.unsafe<{ id: bigint }[]>(
				"SELECT id FROM search_docs WHERE tsv @@ to_tsquery('mainworthy_search','latecanary')",
			),
		).toEqual([]);
		expect(
			(await db.unsafe<{ bytes: number }[]>("SELECT octet_length(body) AS bytes FROM search_docs WHERE id=1"))[0]
				?.bytes,
		).toBeGreaterThan(65536);
	} finally {
		await db.unsafe("ROLLBACK");
	}
});

test("the schema port --check accounts for every reviewed hand edit", async () => {
	const child = Bun.spawn([process.execPath, "scripts/port-schema.ts", "--check"], {
		env: { ...process.env },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [rc, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	expect({ rc, stderr }).toEqual({ rc: 0, stderr: "" });
	expect(stdout).toContain("13 justified hand edits only.");
});

test("the migration chain upgrades the immutable baseline without replacing its rows", async () => {
	const fixture = await testDatabase({ schema: "empty" });
	const target = await Database.open({ url: fixture.url });
	try {
		await target.write((db) =>
			db.transaction(async () => {
				await db.exec(baselineSchema().sql);
				await db.exec(
					"INSERT INTO orgs(id,name,created_at) VALUES(1,'existing',0); INSERT INTO actors(id,org,kind,name,created_at) VALUES(1,1,'human','robin',0)",
				);
				await db.run(
					(await import("../src/server/kernel/db.ts")).sql<{ hash: string }>(
						"INSERT INTO meta(key,value) VALUES ('schema_version','1'),('archive_version','43'),('baseline_hash',$hash)",
					),
					{ hash: baselineSchema().hash },
				);
			}),
		);
		await migrate(target);
		expect(await target.read((db) => db.allDynamic("SELECT id, name, auth_version FROM actors"))).toEqual([
			{ id: 1, name: "robin", auth_version: 0 },
		]);
		expect(await target.read(schemaVersion)).toBe(SCHEMA_VERSION);
		await migrate(target);
		expect(await target.read((db) => db.allDynamic("SELECT id, name, auth_version FROM actors"))).toEqual([
			{ id: 1, name: "robin", auth_version: 0 },
		]);
	} finally {
		await target.close();
		await fixture.close();
	}
});

/** Undo migration 8, then 7 when needed, before setting migration 6 indexes as `undo` leaves them. */
async function atSchema(version: 5 | 6 | 7, undo = ""): Promise<{ url: string; raw: SQL; close: () => Promise<void> }> {
	const fixture = await testDatabase();
	const raw = new SQL(fixture.url, { max: 3, bigint: true });
	await raw
		.unsafe(`
${BEFORE_EIGHT}
${version < 7 ? "DROP TABLE report_map_pages; UPDATE meta SET value = '43' WHERE key = 'archive_version';" : ""}
UPDATE meta SET value = '${version}' WHERE key = 'schema_version';
${undo}`)
		.simple();
	return {
		url: fixture.url,
		raw,
		close: async () => {
			await raw.close();
			await fixture.close();
		},
	};
}

const removalIndexes = [
	"search_docs_project",
	"slot_results_run",
	"team_events_project",
	"batches_project_id",
	"cases_project_id",
	"changes_project_id",
	"decisions_project_id",
	"folders_project_id",
	"merge_receipt_nodes_project_id",
	"questions_project_id",
	"requirements_project_id",
	"runs_project_id",
	"slots_run_id",
];

// A start that Cloud Run cut off in the middle of migration 6 leaves some indexes built, one invalid and the rest
// missing; the next start finishes them and only then moves the ledger.
test("the next start finishes an interrupted build of migration 6 and leaves no index invalid", async () => {
	const target = await atSchema(
		5,
		"DROP INDEX runs_project_id; DROP INDEX slots_run_id; UPDATE pg_index SET indisvalid = false WHERE indexrelid = 'cases_project_id'::regclass",
	);
	const database = await Database.open({ url: target.url });
	try {
		await migrate(database);
		expect(await database.read(schemaVersion)).toBe(SCHEMA_VERSION);
		const indexes = await target.raw.unsafe(
			"SELECT i.relname AS name, x.indisvalid AS valid FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid WHERE i.relname = ANY($1::text[]) ORDER BY 1",
			[`{${removalIndexes.join(",")}}`],
		);
		expect(indexes).toEqual([...removalIndexes].sort().map((name) => ({ name, valid: true })));
		const invalid: { n: number }[] = await target.raw.unsafe(
			"SELECT count(*)::int AS n FROM pg_index WHERE NOT indisvalid",
		);
		expect(invalid).toEqual([{ n: 0 }]);
	} finally {
		await database.close();
		await target.close();
	}
}, 60_000);

// Migration 6 used to build its indexes with plain CREATE INDEX in one transaction, so every table it had indexed
// took no writes until the last index and the ledger committed. A transaction of the serving instance that holds a
// late table (`runs`) open keeps the build waiting; a write to an earlier table (`search_docs`) must not wait with it.
test("writes to a table go on while migration 6 builds the indexes after it", async () => {
	const target = await atSchema(5, removalIndexes.map((name) => `DROP INDEX ${name};`).join(" "));
	const database = await Database.open({ url: target.url });
	const holder = await target.raw.reserve();
	const writer = await target.raw.reserve();
	try {
		await holder.unsafe("BEGIN");
		await holder.unsafe("LOCK TABLE runs IN ROW EXCLUSIVE MODE");
		const migrating = migrate(database);
		const waitingSince = performance.now();
		for (;;) {
			const [row] = await target.raw.unsafe(
				"SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
			);
			if (row.n > 0) break;
			if (performance.now() - waitingSince > 20_000) throw new Error("migration 6 never waited for the held table");
			await Bun.sleep(50);
		}
		const write = await (async () => {
			try {
				await writer.unsafe("BEGIN");
				await writer.unsafe("SET LOCAL lock_timeout = '2s'");
				await writer.unsafe("LOCK TABLE search_docs IN ROW EXCLUSIVE MODE");
				await writer.unsafe("COMMIT");
				return "written";
			} catch (error) {
				await writer.unsafe("ROLLBACK");
				return error instanceof Error ? error.message : String(error);
			}
		})();
		await holder.unsafe("COMMIT");
		await migrating;
		expect(write).toBe("written");
		expect(await database.read(schemaVersion)).toBe(SCHEMA_VERSION);
	} finally {
		holder.release();
		writer.release();
		await database.close();
		await target.close();
	}
}, 60_000);

// Two instances starting together: the second asks for the migration lock again and again rather than waiting in one
// statement, whose snapshot the first one's concurrent build would wait for while the second waits for its lock.
test("two instances upgrading to migration 6 at once both start, and build each index once", async () => {
	const target = await atSchema(5, removalIndexes.map((name) => `DROP INDEX ${name};`).join(" "));
	const [first, second] = await Promise.all([Database.open({ url: target.url }), Database.open({ url: target.url })]);
	try {
		await Promise.all([migrate(first), migrate(second)]);
		expect(await first.read(schemaVersion)).toBe(SCHEMA_VERSION);
		const valid: { n: number }[] = await target.raw.unsafe(
			"SELECT count(*)::int AS n FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid WHERE i.relname = ANY($1::text[]) AND x.indisvalid",
			[`{${removalIndexes.join(",")}}`],
		);
		expect(valid).toEqual([{ n: removalIndexes.length }]);
	} finally {
		await first.close();
		await second.close();
		await target.close();
	}
}, 60_000);

// People sign in through the identity provider only. Migration 8 deletes every other kind of credential, the
// sessions that rested on one, and what passkeys and mail kept; an identity at the provider and its session stay.
test.each([6, 7] as const)(
	"migration 8 upgrades schema %i, keeping provider identities and deleting other credentials and their sessions",
	async (version) => {
		const target = await atSchema(version);
		const before = await schemaCatalog(target.raw);
		await target.raw
			.unsafe(`
INSERT INTO orgs(id,name,created_at) VALUES (9001,'migrated',0);
INSERT INTO actors(id,org,kind,name,created_at) VALUES (9001,9001,'human','robin',0),(9002,9001,'human','sam',0);
INSERT INTO credentials(id,actor,kind,handle,data,label,created_at) VALUES
 (9001,9001,'oidc','issuer|sub-robin','{}','Example ID',0),
 (9002,9001,'password',NULL,'hash','password',0),
 (9003,9002,'passkey','credential-id','{}','laptop',0),
 (9004,9002,'totp',NULL,'{}','authenticator',0);
INSERT INTO sessions(id,actor,hash,credential,created_at,last_seen_at,expires_at) VALUES
 (9001,9001,'by-identity',9001,0,0,1),
 (9002,9001,'by-password',9002,0,0,1),
 (9003,9002,'by-passkey',9003,0,0,1);
INSERT INTO passkey_users(actor,handle,created_at) VALUES (9002,'handle',0);
INSERT INTO mail_contacts(actor,email,revision) VALUES (9001,'robin@example.com','r1');
INSERT INTO background_jobs(id,kind,input,accepted_at,effect,max_attempts,next_at) VALUES
 ('mail-1','mail','{}',0,'uncertain',3,0),('other-1','other','{}',0,'repeatable',3,0);
INSERT INTO identity_limits(key,entry,expires_at,version) VALUES
 ('account:robin','{}',1,1),('totp:9002','{}',1,2),('mail-reset:robin','{}',1,3),('address:192.0.2.1','{}',1,4);
`)
			.simple();
		const database = await Database.open({ url: target.url });
		try {
			await migrate(database);
			expect(await database.read(schemaVersion)).toBe(8);
			const rows = async (query: string) => await target.raw.unsafe(query);
			expect(await rows("SELECT id, kind FROM credentials WHERE id >= 9001 ORDER BY id")).toEqual([
				{ id: 9001n, kind: "oidc" },
			]);
			expect(await rows("SELECT id FROM sessions WHERE id >= 9001 ORDER BY id")).toEqual([{ id: 9001n }]);
			expect(await rows("SELECT id FROM background_jobs ORDER BY id")).toEqual([{ id: "other-1" }]);
			expect(await rows("SELECT key FROM identity_limits ORDER BY key")).toEqual([{ key: "address:192.0.2.1" }]);
			expect(await rows("SELECT value FROM meta WHERE key = 'archive_version'")).toEqual([
				{ value: String(ARCHIVE_VERSION) },
			]);
			// The schema it leaves is the one a new database starts with; no other kind of credential can be written.
			const after = await schemaCatalog(target.raw);
			expect(after).not.toEqual(before);
			expect(after).toEqual(await schemaCatalog(db));
			// Started with `execute()` and awaited: Bun 1.4.3's `rejects` hangs on a query that was never started.
			await expect(
				target.raw
					.unsafe(
						"INSERT INTO credentials(actor,kind,data,label,created_at) VALUES (9001,'password','hash','password',0)",
					)
					.execute(),
			).rejects.toThrow("credentials_kind_check");
		} finally {
			await database.close();
			await target.close();
		}
	},
	60_000,
);
