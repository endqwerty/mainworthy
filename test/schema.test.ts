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

let db: ReservedSQL;
let pool: SQL;
let database: Database;
let cleanup: () => Promise<void> = async () => {};

beforeAll(async () => {
	const fixture = await testDatabase({ schema: "empty" });
	cleanup = fixture.close;
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
		(await schemaCatalog(db)).map((row) => `${row.kind} ${row.name}: ${row.definition}`).join("\n"),
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
		await raw.unsafe("UPDATE meta SET value='2' WHERE key='schema_version'");
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
