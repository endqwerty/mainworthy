import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { type AddressInfo, connect, createServer, type Socket } from "node:net";
import { cluster } from "../../../scripts/pg.ts";
import { drainDatabaseDrops, type TestDatabase, testDatabase } from "../../../test/db.ts";
import { defaultConfig, openApp } from "./app.ts";
import {
	Busy,
	ConnectionLost,
	Database,
	databaseAdmin,
	declaredSql,
	isConstraintViolation,
	isForeignKeyViolation,
	isUniqueViolation,
	MIGRATION_LOCK,
	migrationLock,
	type ReadDb,
	rewriteNamed,
	sql,
	TransactionAborted,
	type WriteDb,
} from "./db.ts";
import { SCHEMA_VERSION } from "./migrate.ts";

let fixture: TestDatabase;
let database: Database;
let adminUrl: string;
const Q = {
	insert: sql<{ id: number; text: string }, { id: number }>(
		"INSERT INTO entries(id, text) VALUES ($id, $text) RETURNING id",
	),
	count: sql<readonly [], { n: number }>("SELECT count(*) AS n FROM entries"),
	select: sql<{ id: number }, { id: number; text: string }>("SELECT id, text FROM entries WHERE id = $id"),
	pid: sql<readonly [], { pid: number }>("SELECT pg_backend_pid() AS pid"),
};
beforeAll(async () => {
	adminUrl = (await cluster()).adminUrl;
	fixture = await testDatabase({ schema: "empty" });
	database = await Database.open({ url: fixture.url, readPool: 1, writePool: 1 });
	await database.write((db) =>
		db.transaction(() =>
			db.exec(`
		CREATE TABLE entries(id bigint PRIMARY KEY, text text NOT NULL);
		CREATE TABLE parents(id bigint PRIMARY KEY);
		CREATE TABLE children(id bigint PRIMARY KEY, parent bigint REFERENCES parents(id) DEFERRABLE INITIALLY IMMEDIATE);
	`),
		),
	);
});
afterAll(async () => {
	await database?.close();
	await fixture?.close();
	await drainDatabaseDrops();
	console.log(
		`kernel fixture clone=${fixture.timings.cloneMs.toFixed(2)}ms drop=${fixture.timings.dropMs?.toFixed(2)}ms`,
	);
});
function barrier() {
	let release = () => {};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}
async function cleanWriter(): Promise<void> {
	let pid = 0;
	await database.write(async (db) => {
		pid = (await db.one(Q.pid)).pid;
		expect(db.inTransaction).toBe(false);
		const [state] = await db.allDynamic<{ locks: number; xid: string | null }>(`
			SELECT (SELECT count(*) FROM pg_locks WHERE pid = pg_backend_pid() AND locktype = 'advisory') AS locks,
			pg_current_xact_id_if_assigned()::text AS xid`);
		expect(state).toEqual({ locks: 0, xid: null });
		await db.transaction(async () => {
			expect(db.inTransaction).toBe(true);
			await db.one(Q.count);
		});
	});
	await databaseAdmin(adminUrl, async (admin) => {
		const rows = await admin.all<{ idle: boolean; unlocked: boolean }>(
			`
			SELECT state = 'idle' AND xact_start IS NULL AS idle,
			NOT EXISTS (SELECT FROM pg_locks WHERE pid = $1::int AND locktype = 'advisory') AS unlocked
			FROM pg_stat_activity WHERE pid = $1::int`,
			[pid],
		);
		expect(rows).toEqual([{ idle: true, unlocked: true }]);
	});
}
async function backendGone(pid: number): Promise<void> {
	await databaseAdmin(adminUrl, async (admin) => {
		const [row] = await admin.all<{ n: number }>("SELECT count(*) AS n FROM pg_stat_activity WHERE pid = $1::int", [
			pid,
		]);
		expect(row?.n).toBe(0);
	});
}

test("named scanner skips literals, casts, identifiers, dollar bodies and nested comments", () => {
	const source = `SELECT '$x', E'escaped\\' $skip', "$identifier", $x::bigint, $x, $tag$ $body $tag$, $$ $body $$ -- $line
	/* $comment /* $nested */ */ WHERE a = $second AND embedded$x = 1`;
	const compiled = rewriteNamed(source);
	expect(compiled.names).toEqual(["x", "second"]);
	expect(compiled.text).toContain("$1::bigint, $1");
	expect(compiled.text).toContain("embedded$x");
	expect(compiled.text).toContain("$tag$ $body $tag$");
	expect(compiled.text).toContain("/* $comment /* $nested */ */");
	expect(() => rewriteNamed("SELECT $x, $1")).toThrow("mix");
	expect(declaredSql().some((statement) => statement.text.includes("WHERE id = $1"))).toBe(true);
});

test("named binding rejects missing and extra keys before sending, and one requires exactly one row", async () => {
	await database.read(async (db) => {
		await expect(db.get(Q.select, { text: "bad" } as unknown as { id: number })).rejects.toThrow(
			"missing SQL parameter id",
		);
		const extra = { id: 1, extra: 2 };
		await expect(db.get(Q.select, extra)).rejects.toThrow("unexpected SQL parameter extra");
		expect(await db.get(Q.select, { id: -1 })).toBeNull();
		await expect(db.one(Q.select, { id: -1 })).rejects.toThrow("exactly one");
		const positional = sql<readonly [number], { n: number }>("SELECT $1::bigint AS n");
		expect(await db.one(positional, [9])).toEqual({ n: 9 });
	});
});

test("normal return releases the lock and scope, run requires a transaction", async () => {
	let expired: WriteDb | undefined;
	await database.write(async (db) => {
		expired = db;
		await expect(db.run(Q.insert, { id: 1, text: "outside" })).rejects.toThrow("open transaction");
		await db.transaction(async () => {
			expect(await db.one(Q.insert, { id: 1, text: "normal" })).toEqual({ id: 1 });
			expect(await db.run(sql("UPDATE entries SET text = 'updated' WHERE id = 1"))).toEqual({ changes: 1 });
		});
	});
	await expect(expired?.one(Q.count)).rejects.toThrow("scope has ended");
	await cleanWriter();
});

test("throw with an open transaction rolls back, and returning one open is refused", async () => {
	await expect(
		database.write(async (db) => {
			await db.begin();
			await db.one(Q.insert, { id: 2, text: "rolled back" });
			throw new Error("open failure");
		}),
	).rejects.toThrow("open failure");
	await expect(
		database.write(async (db) => {
			await db.begin();
		}),
	).rejects.toThrow("open transaction");
	expect(await database.read((db) => db.get(Q.select, { id: 2 }))).toBeNull();
	await cleanWriter();
});

test("throw between two transactions preserves the first commit and unlocks", async () => {
	await expect(
		database.write(async (db) => {
			await db.transaction(() => db.one(Q.insert, { id: 3, text: "accepted" }));
			throw new Error("between transactions");
		}),
	).rejects.toThrow("between transactions");
	expect(await database.read((db) => db.get(Q.select, { id: 3 }))).toEqual({ id: 3, text: "accepted" });
	await cleanWriter();
});

test("false unlock destroys its backend; the pool never inherits the session lock", async () => {
	let pid = 0;
	await expect(
		migrationLock(database, async (db) => {
			pid = (await db.one(Q.pid)).pid;
			await db.allDynamic("SELECT pg_advisory_unlock($1::bigint)", [MIGRATION_LOCK]);
		}),
	).rejects.toThrow("not held at release");
	await backendGone(pid);
	await cleanWriter();
});

test("a failed unlock destroys a backend that still holds the lock", async () => {
	let pid = 0;
	await expect(
		migrationLock(database, async (db) => {
			pid = (await db.one(Q.pid)).pid;
			await db.transaction(() =>
				db.exec(`
			CREATE SCHEMA unlock_failure;
			CREATE FUNCTION unlock_failure.pg_advisory_unlock(bigint) RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'unlock failed deliberately'; END $$;
			SET search_path = unlock_failure, pg_catalog, public;
		`),
			);
		}),
	).rejects.toThrow("unlock failed deliberately");
	await backendGone(pid);
	await cleanWriter();
});

test("backend termination while holding the lock yields ConnectionLost and no reconnect in the operation", async () => {
	let pid = 0;
	let continued = false;
	await expect(
		database.write(async (db) => {
			pid = (await db.one(Q.pid)).pid;
			await db.begin();
			await databaseAdmin(adminUrl, (admin) =>
				admin.all("SELECT pg_terminate_backend($1::int)", [pid]).then(() => undefined),
			);
			await db.one(Q.count);
			continued = true;
		}),
	).rejects.toBeInstanceOf(ConnectionLost);
	expect(continued).toBe(false);
	await backendGone(pid);
	await cleanWriter();
});

test("a swallowed connection error still fails the lease, and failed rollback destroys its backend", async () => {
	let pid = 0;
	await expect(
		database.write(async (db) => {
			pid = (await db.one(Q.pid)).pid;
			await databaseAdmin(adminUrl, (admin) =>
				admin.all("SELECT pg_terminate_backend($1::int)", [pid]).then(() => undefined),
			);
			try {
				await db.one(Q.count);
			} catch {
				/* A caller cannot turn loss of ownership into success. */
			}
		}),
	).rejects.toBeInstanceOf(ConnectionLost);
	await backendGone(pid);
	await expect(
		database.write(async (db) => {
			pid = (await db.one(Q.pid)).pid;
			await db.begin();
			await databaseAdmin(adminUrl, (admin) =>
				admin.all("SELECT pg_terminate_backend($1::int)", [pid]).then(() => undefined),
			);
			throw new Error("callback failed before rollback");
		}),
	).rejects.toBeInstanceOf(ConnectionLost);
	await backendGone(pid);
	await cleanWriter();
});

test("a one-connection writer pool bounds concurrency and cancellation does not skip its holder", async () => {
	const entered = barrier();
	const finish = barrier();
	const order: string[] = [];
	const first = database.write(async (db) => {
		await db.transaction(() => db.one(Q.count));
		order.push("first");
		entered.release();
		await finish.promise;
		await db.transaction(() => db.one(Q.count));
		order.push("first finished");
	});
	await entered.promise;
	const abort = new AbortController();
	const cancelled = database.write(
		() => {
			order.push("cancelled");
		},
		{ signal: abort.signal },
	);
	const second = database.write(() => {
		order.push("second");
	});
	abort.abort(new Error("cancel FIFO wait"));
	await expect(cancelled).rejects.toThrow("cancel FIFO wait");
	expect(order).toEqual(["first"]);
	finish.release();
	await Promise.all([first, second]);
	expect(order).toEqual(["first", "first finished", "second"]);
	await cleanWriter();
});

test("migration writers on different Database instances share the migration lock", async () => {
	const other = await Database.open({ url: fixture.url });
	const entered = barrier();
	const finish = barrier();
	let secondEntered = false;
	try {
		const first = migrationLock(database, async () => {
			entered.release();
			await finish.promise;
		});
		await entered.promise;
		const second = migrationLock(other, () => {
			secondEntered = true;
		});
		await Bun.sleep(20);
		expect(secondEntered).toBe(false);
		finish.release();
		await Promise.all([first, second]);
		expect(secondEntered).toBe(true);
	} finally {
		finish.release();
		await other.close();
	}
});

test("read scopes hold a repeatable snapshot until their second statement", async () => {
	await database.read(async (db) => {
		const before = await db.one(Q.count);
		await database.write((writer) => writer.transaction(() => writer.one(Q.insert, { id: 4, text: "later" })));
		expect(await db.one(Q.count)).toEqual(before);
	});
	expect(await database.read((db) => db.get(Q.select, { id: 4 }))).toEqual({ id: 4, text: "later" });
});

test("savepoints recover aborted statements, report the first failure and discard child effects", async () => {
	const effects: string[] = [];
	await database.write((db) =>
		db.transaction(async () => {
			db.afterCommit(() => {
				effects.push("outer before");
			});
			await expect(
				db.savepoint(async () => {
					db.afterCommit(() => {
						effects.push("discarded");
					});
					try {
						await db.one(Q.insert, { id: 1, text: "duplicate" });
					} catch (error) {
						expect(isUniqueViolation(error)).toBe(true);
					}
					await expect(db.one(Q.count)).rejects.toBeInstanceOf(TransactionAborted);
				}),
			).rejects.toThrow("first failure");
			await db.savepoint(async () => {
				db.afterCommit(() => {
					effects.push("child");
				});
				await db.one(Q.insert, { id: 5, text: "recovered" });
			});
			db.afterCommit(() => {
				effects.push("outer after");
			});
			expect(effects).toEqual([]);
		}),
	);
	expect(effects).toEqual(["outer before", "child", "outer after"]);
	await cleanWriter();
});

test("a kept value lasts the write transaction, through a released savepoint, and goes when one rolls back", async () => {
	const key = Symbol("test");
	let made = 0;
	const make = () => ++made;
	await database.write(async (db) => {
		expect([db.kept(key, make), db.kept(key, make)]).toEqual([1, 2]);
		await db.transaction(async () => {
			expect([db.kept(key, make), db.kept(key, make)]).toEqual([3, 3]);
			await db.savepoint(async () => expect(db.kept(key, make)).toBe(3));
			await expect(
				db.savepoint(async () => {
					db.kept(key, make);
					throw new Error("rolled back");
				}),
			).rejects.toThrow("rolled back");
			expect(db.kept(key, make)).toBe(4);
		});
		await db.transaction(async () => expect(db.kept(key, make)).toBe(5));
	});
	expect(await database.read(async (db) => [(db as WriteDb).kept(key, make), (db as WriteDb).kept(key, make)])).toEqual(
		[6, 7],
	);
});

test("async generator savepoints roll back on iterator return and preserve yields/results", async () => {
	await database.write((db) =>
		db.transaction(async () => {
			const steps = db.savepointSteps(async function* () {
				await db.one(Q.insert, { id: 6, text: "cancelled generator" });
				yield undefined;
				return "complete";
			});
			expect(await steps.next()).toEqual({ done: false, value: undefined });
			await steps.return("stopped");
			expect(await db.get(Q.select, { id: 6 })).toBeNull();
			const success = db.savepointSteps(async function* () {
				yield "slice";
				return 42;
			});
			expect(await success.next()).toEqual({ done: false, value: "slice" });
			expect(await success.next()).toEqual({ done: true, value: 42 });
		}),
	);
});

test("failed COMMIT discards effects, checkedBulk checks deferred foreign keys at its boundary", async () => {
	let fired = false;
	await expect(
		database.write((db) =>
			db.transaction(async () => {
				await db.exec("SET CONSTRAINTS ALL DEFERRED; INSERT INTO children VALUES (10, 999)");
				db.afterCommit(() => {
					fired = true;
				});
			}),
		),
	).rejects.toHaveProperty("errno", "23503");
	expect(fired).toBe(false);
	await database.write((db) =>
		db.transaction(async () => {
			try {
				await db.checkedBulk(() => db.exec("INSERT INTO children VALUES (11, 999)"));
				throw new Error("expected constraint error");
			} catch (error) {
				expect(isConstraintViolation(error)).toBe(true);
				expect(isForeignKeyViolation(error)).toBe(true);
			}
			await db.checkedBulk(async () => {
				await db.exec("INSERT INTO children VALUES (12, 12); INSERT INTO parents VALUES (12)");
			});
			expect(await db.allDynamic("SELECT id FROM children")).toEqual([{ id: 12 }]);
		}),
	);
});

test("afterCommit runs once across two commits and isolates thrown effects", async () => {
	const effects: string[] = [];
	await database.write(async (db) => {
		await db.transaction(async () => {
			db.afterCommit(() => {
				effects.push("one");
			});
			db.afterCommit(() => {
				throw new Error("effect failed");
			});
			db.afterCommit(() => {
				effects.push("two");
			});
		});
		expect(effects).toEqual(["one", "two"]);
		await db.transaction(async () => {
			db.afterCommit(() => {
				effects.push("three");
			});
		});
	});
	expect(effects).toEqual(["one", "two", "three"]);
});

test("arrays encode empty, quotes, comma, backslashes and bigint values without precision loss", async () => {
	const arrays = sql<{ values: readonly string[] }, { value: string }>("SELECT unnest($values::text[]) AS value");
	const nums = sql<{ values: readonly (number | bigint)[] }, { value: number }>(
		"SELECT unnest($values::bigint[]) AS value",
	);
	await database.read(async (db) => {
		expect(await db.all(arrays, { values: [] })).toEqual([]);
		const values = ["", "NULL", 'quote"and,comma', "back\\slash", "{brace}", "a'b"];
		expect(await db.all(arrays, { values })).toEqual(values.map((value) => ({ value })));
		expect(await db.all(nums, { values: [1, 2n, Number.MAX_SAFE_INTEGER] })).toEqual([
			{ value: 1 },
			{ value: 2 },
			{ value: Number.MAX_SAFE_INTEGER },
		]);
		const nullable = sql<{ values: readonly (string | null)[] }, { value: string | null }>(
			"SELECT unnest($values::text[]) AS value",
		);
		expect(await db.all(nullable, { values: ["a", null, "NULL", null] })).toEqual([
			{ value: "a" },
			{ value: null },
			{ value: "NULL" },
			{ value: null },
		]);
		await expect(db.all(nums, { values: [Number.MAX_SAFE_INTEGER + 1] })).rejects.toThrow("safe");
		await expect(db.all(nums, { values: [9007199254740992n] })).rejects.toThrow("safe integer");
		await expect(db.allDynamic("SELECT 9007199254740992::bigint AS enormous")).rejects.toThrow("enormous");
		await expect(db.allDynamic("SELECT $1::bigint", [Number.MAX_SAFE_INTEGER + 1])).rejects.toThrow("safe integer");
	});
});

test("pool exhaustion rejects on AbortSignal and cancelled reservations do not consume a slot", async () => {
	const entered = barrier();
	const finish = barrier();
	let expired: ReadDb | undefined;
	const first = database.read(async (db) => {
		expired = db;
		entered.release();
		await finish.promise;
	});
	await entered.promise;
	const controller = new AbortController();
	const blocked = database.read(
		() => {
			throw new Error("must not acquire");
		},
		{ signal: controller.signal },
	);
	controller.abort(new Error("pool cancelled"));
	await expect(blocked).rejects.toThrow("pool cancelled");
	finish.release();
	await first;
	await expect(expired?.one(Q.count)).rejects.toThrow("scope has ended");
	await database.read((db) => db.one(Q.count));
});

test("catalog reports columns, ordered primary keys and foreign keys", async () => {
	const catalog = await database.read((db) => db.catalog());
	expect(catalog.find((table) => table.name === "entries")?.primary).toEqual(["id"]);
	expect(catalog.find((table) => table.name === "children")?.foreignKeys).toEqual([
		{ columns: ["parent"], parent: "parents", parentColumns: ["id"], deleteAction: "no-action" },
	]);
});

test("migration lock holds one dedicated backend across ledger transactions", async () => {
	const other = await Database.open({ url: fixture.url });
	const entered = barrier();
	const finish = barrier();
	const events: number[] = [];
	try {
		const first = migrationLock(database, async (db) => {
			const pid = (await db.one(Q.pid)).pid;
			await db.transaction(() => db.one(Q.count));
			entered.release();
			await finish.promise;
			expect((await db.one(Q.pid)).pid).toBe(pid);
			events.push(1);
		});
		await entered.promise;
		const second = migrationLock(other, () => {
			events.push(2);
		});
		await Bun.sleep(20);
		expect(events).toEqual([]);
		finish.release();
		await Promise.all([first, second]);
		expect(events).toEqual([1, 2]);
	} finally {
		finish.release();
		await other.close();
	}
});

test("testDatabase clones two isolated databases and drops them off the critical path", async () => {
	const [a, b] = await Promise.all([testDatabase(), testDatabase()]);
	const da = await Database.open({ url: a.url });
	const db = await Database.open({ url: b.url });
	try {
		await da.write((writer) =>
			writer.transaction(() => writer.exec("CREATE TABLE private_row(id bigint); INSERT INTO private_row VALUES (1)")),
		);
		expect(
			await db.read((reader) =>
				reader.allDynamic("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'private_row'"),
			),
		).toEqual([]);
	} finally {
		await Promise.all([da.close(), db.close()]);
		await Promise.all([a.close(), b.close()]);
	}
	await drainDatabaseDrops();
	await databaseAdmin(adminUrl, async (admin) => {
		const names = [new URL(a.url).pathname.slice(1), new URL(b.url).pathname.slice(1)];
		expect(await admin.all("SELECT datname FROM pg_database WHERE datname = ANY($1::text[])", [names])).toEqual([]);
	});
	expect(a.timings.dropMs).toBeNumber();
	expect(b.timings.dropMs).toBeNumber();
	console.log(
		`isolated clones=${a.timings.cloneMs.toFixed(2)},${b.timings.cloneMs.toFixed(2)}ms drops=${a.timings.dropMs?.toFixed(2)},${b.timings.dropMs?.toFixed(2)}ms`,
	);
});

test("openApp migrates its URL asynchronously and owns only Database", async () => {
	const empty = await testDatabase({ schema: "empty" });
	const config = { ...defaultConfig({}), databaseUrl: empty.url };
	const app = await openApp(config, { memory: true, now: () => 123 });
	try {
		expect(app.now()).toBe(123);
		expect("db" in app || "reader" in app || "gate" in app || "readers" in app).toBe(false);
		expect(
			await app.database.read((reader) => reader.allDynamic("SELECT value FROM meta WHERE key = 'schema_version'")),
		).toEqual([{ value: String(SCHEMA_VERSION) }]);
	} finally {
		await app.close();
		await empty.close();
	}
	await expect(openApp({ ...config, databaseUrl: "" })).rejects.toThrow(
		"MAINWORTHY_DATABASE_URL is required; see compose.yaml",
	);
});

test("a queued write returns Busy when acquiring a connection exceeds its bound", async () => {
	const queued = await Database.open({ url: fixture.url, acquireTimeoutMs: 100, writePool: 1 });
	const entered = barrier();
	const finish = barrier();
	const first = queued.write(async () => {
		entered.release();
		await finish.promise;
	});
	await entered.promise;
	let failure: unknown;
	let ran = false;
	const second = queued
		.write(async (db) => {
			await db.one(Q.count);
			ran = true;
		})
		.catch((error) => {
			failure = error;
		});
	try {
		await Bun.sleep(200);
		finish.release();
		await first;
		await second;
		expect(failure).toBeInstanceOf(Busy);
		expect(ran).toBe(false);
		await queued.write(async (db) => {
			await db.one(Q.count);
			ran = true;
		});
		expect(ran).toBe(true);
	} finally {
		finish.release();
		await first;
		await second;
		await queued.close();
	}
});

test("a slow write logs its name, the time it waited for a connection and the time it held one (#1084)", async () => {
	const slow = await Database.open({ url: fixture.url, writePool: 1, slowWriteMs: 50 });
	const warn = spyOn(console, "warn").mockImplementation(() => {});
	const entered = barrier();
	const finish = barrier();
	try {
		const first = slow.write(
			async () => {
				entered.release();
				await finish.promise;
			},
			{ name: "report in first" },
		);
		await entered.promise;
		const second = slow.write(async (db) => await db.one(Q.count), { name: "report in second" });
		await Bun.sleep(100);
		finish.release();
		await Promise.all([first, second]);
		const lines = warn.mock.calls.map((call) => String(call[0]));
		expect(lines).toContainEqual(
			expect.stringMatching(
				/^\[mainworthy\] slow write: report in first took \d+ ms: \d+ ms waiting for a connection, \d+ ms holding it$/,
			),
		);
		const waited = lines.find((line) => line.includes("report in second"));
		expect(waited, lines.join("\n")).toBeDefined();
		expect(Number(waited?.match(/(\d+) ms waiting/)?.[1])).toBeGreaterThanOrEqual(50);
	} finally {
		finish.release();
		warn.mockRestore();
		await slow.close();
	}
});

test("closing cancels an exclusive callback's write waiting for a lock, which does not commit, and returns once the callback has settled", async () => {
	const closing = await Database.open({ url: fixture.url, writePool: 1 });
	const entered = barrier();
	const finish = barrier();
	const holding = database.write((db) =>
		db.transaction(async () => {
			await db.allDynamic("SELECT pg_advisory_xact_lock(4242)");
			entered.release();
			await finish.promise;
		}),
	);
	const order: string[] = [];
	try {
		await entered.promise;
		const work = closing
			.exclusive("db test", (signal) =>
				closing.write(
					(db) =>
						db.transaction(async () => {
							await db.run(Q.insert, { id: 9_142, text: "written before the wait" });
							await db.allDynamic("SELECT pg_advisory_xact_lock(4242)");
						}),
					{ signal },
				),
			)
			.finally(() => order.push("callback settled"));
		for (let waiting = 0; waiting === 0; ) {
			await Bun.sleep(10);
			waiting = await databaseAdmin(adminUrl, async (admin) =>
				Number(
					(
						await admin.all<{ n: number }>(
							"SELECT count(*) AS n FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock'",
							[new URL(fixture.url).pathname.slice(1)],
						)
					)[0]?.n ?? 0,
				),
			);
		}
		// Closing aborts the callback's signal, which cancels the statement waiting for the lock: `close` returns while
		// the other writer still holds it.
		await closing.close().then(() => order.push("closed"));
		await expect(work).rejects.toThrow("database is closed");
		expect(order).toEqual(["callback settled", "closed"]);
		finish.release();
		await holding;
		expect(await database.read((db) => db.get(Q.select, { id: 9_142 }))).toBeNull();
	} finally {
		finish.release();
		await holding;
		await closing.close();
	}
});

/**
 * A proxy for every connection of a database opened through `url`. Once a connection carries a cancel, everything it
 * sends is kept back, as a stalled path would keep it, until `releaseFirst` sends the first query kept back (its
 * protocol messages up to the Sync after its Execute) and its answer has come.
 */
async function holdingCancels() {
	const sockets: Socket[] = [];
	const cancellers: { upstream: Socket; held: Buffer }[] = [];
	let cancels = 0;
	let answers = 0;
	const proxy = createServer((client) => {
		const target = new URL(fixture.url);
		const upstream = connect(Number(target.port), target.hostname);
		sockets.push(client, upstream);
		let canceller: { upstream: Socket; held: Buffer } | undefined;
		client.on("data", (data) => {
			const bytes = Buffer.from(data);
			if (bytes.includes("pg_cancel_backend")) {
				cancels++;
				if (!canceller) {
					canceller = { upstream, held: Buffer.alloc(0) };
					cancellers.push(canceller);
				}
			}
			if (canceller) canceller.held = Buffer.concat([canceller.held, bytes]);
			else upstream.write(bytes);
		});
		upstream.on("data", (data) => {
			if (canceller) answers++;
			client.write(data);
		});
		client.on("error", () => {});
		upstream.on("error", () => {});
	});
	await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
	const url = new URL(fixture.url);
	url.hostname = "127.0.0.1";
	url.port = String((proxy.address() as AddressInfo).port);
	return {
		url: url.toString(),
		/** Sends that carried a cancel's text, bytes kept back now, and answers the cancel connection has had. */
		counts: () => ({ cancels, held: cancellers.reduce((sum, one) => sum + one.held.length, 0), answers }),
		async releaseFirst() {
			const [one] = cancellers;
			if (!one) throw new Error("no cancel was kept back");
			// Each frontend message is a type byte and a length that counts itself. Preparing ends in a Sync ("S") of its
			// own, and the driver sends the Execute ("E") only once that is answered, so the query ends at the Sync after it.
			let executed = false;
			for (let waited = 0; waited < 5_000; waited += 10) {
				let end = 0;
				let ended = false;
				while (end < one.held.length && !ended) {
					const type = String.fromCharCode(one.held[end] ?? 0);
					end += 1 + one.held.readInt32BE(end + 1);
					executed ||= type === "E";
					ended = executed && type === "S";
				}
				const seen = answers;
				one.upstream.write(one.held.subarray(0, end));
				one.held = one.held.subarray(end);
				if (ended) {
					while (answers === seen) await Bun.sleep(10);
					return;
				}
				await Bun.sleep(10);
			}
			throw new Error("the first cancel was never sent whole");
		},
		end() {
			for (const socket of sockets) socket.destroy();
			proxy.close();
		},
	};
}

/** Starts a write that sleeps in its transaction, and hands it over once it has begun the sleep. */
async function sleepingWrite(on: Database, signal: AbortSignal) {
	const entered = barrier();
	const work = on.write(
		(db) =>
			db.transaction(async () => {
				entered.release();
				await db.allDynamic("SELECT pg_sleep(0.2)");
			}),
		{ signal },
	);
	await entered.promise;
	return { work };
}

test("a cancel the network holds up holds up neither the aborted write nor closing, and no other is sent behind it", async () => {
	const proxy = await holdingCancels();
	const stalled = await Database.open({ url: proxy.url, writePool: 1 });
	try {
		for (let write = 0; write < 2; write++) {
			const controller = new AbortController();
			const reason = new Error("stopped by the test");
			const { work } = await sleepingWrite(stalled, controller.signal);
			controller.abort(reason);
			await expect(work).rejects.toBe(reason);
		}
		await stalled.close();
		expect(proxy.counts().cancels).toBe(1);
	} finally {
		proxy.end();
	}
});

test("closing waits for no cancel the network still holds, also after another held one was answered", async () => {
	const proxy = await holdingCancels();
	const stalled = await Database.open({ url: proxy.url, writePool: 2 });
	try {
		// Both abort before either cancel's wait ends, so both are sent; the second goes once the first is answered.
		const controllers = [new AbortController(), new AbortController()];
		const started = await Promise.all(controllers.map((controller) => sleepingWrite(stalled, controller.signal)));
		for (const controller of controllers) controller.abort(new Error("stopped by the test"));
		await Promise.all(started.map(({ work }) => work.catch(() => undefined)));
		expect(proxy.counts().held).toBeGreaterThan(0);
		await proxy.releaseFirst();
		// The first cancel is answered; the second, whether the driver sent it already or sends it now, stays kept back.
		for (let waited = 0; proxy.counts().held === 0; waited += 10) {
			if (waited > 5_000) throw new Error("no second cancel was sent");
			await Bun.sleep(10);
		}
		const closing = stalled.close().then(() => "closed");
		expect(await Promise.race([closing, Bun.sleep(1_000).then(() => "still closing")])).toBe("closed");
	} finally {
		proxy.end();
	}
});

test("a write whose signal aborted between statements does not commit, even when its callback caught the abort", async () => {
	const controller = new AbortController();
	const reason = new Error("stopped by the test");
	const outcome = await database
		.write(
			(db) =>
				db.transaction(async () => {
					await db.run(Q.insert, { id: 9_141, text: "before the abort" });
					controller.abort(reason);
					await db.savepoint((inner) => inner.one(Q.count)).catch(() => undefined);
				}),
			{ signal: controller.signal },
		)
		.then(
			() => "committed",
			(error: unknown) => error,
		);
	expect(outcome).toBe(reason);
	expect(await database.read((db) => db.get(Q.select, { id: 9_141 }))).toBeNull();
});
