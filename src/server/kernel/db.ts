// The only module that talks to SQLite. Everything above it calls `get`, `all`, `run` and `transaction`.
import { Database, type Statement as PreparedStatement, type SQLQueryBindings } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export type SqlValue = string | number | bigint | boolean | null | Uint8Array;
export type Params = Record<string, SqlValue> | readonly SqlValue[];

/** The one database file of an instance. */
export const databasePath = (dataDir: string): string => join(dataDir, "mainworthy.db");

/** Every SQL text the server can run, collected at module load so a test can prepare each against the schema. */
const DECLARED = new Set<string>();

/**
 * Declares a statement once, with the types of its parameters and its rows. Its object identity keys each Db
 * cache, and `declaredSql()` lets the check prepare every statement the code can run.
 */
export function sql<P extends Params = readonly [], R = never>(text: string): Statement<P, R> {
	DECLARED.add(text);
	return { text } as Statement<P, R>;
}

/** A declared statement. `P` and `R` are phantom: they type the call sites of `get`, `all` and `run`. */
export type Statement<P extends Params, R> = { readonly text: string; readonly __params?: P; readonly __row?: R };

export const declaredSql = (): readonly string[] => [...DECLARED];

export type RunResult = { changes: number; lastId: number };

/**
 * Folds the write-ahead log of a database nobody has open into the database file and removes the log, so the
 * file alone is the whole database and can be renamed. SQLite does this only for the last connection to a
 * file: false means another connection has it open, and nothing was changed.
 */
export function foldLog(path: string): boolean {
	const raw = new Database(path, { strict: true });
	try {
		raw.exec("PRAGMA busy_timeout = 0");
		const row = raw.query<{ journal_mode: string }, []>("PRAGMA journal_mode = DELETE").get();
		return row?.journal_mode === "delete";
	} catch (error) {
		if (error instanceof Error && /database is locked/.test(error.message)) return false;
		throw error;
	} finally {
		raw.close();
	}
}

export class Db {
	readonly raw: Database;
	private depth = 0;
	private statements = new Map<Statement<Params, unknown>, PreparedStatement<unknown, SQLQueryBindings[]>>();
	private committed: (() => void)[] = [];

	/** Schedules a non-throwing effect after the outer commit. Rollback discards it, including a savepoint's effects. */
	afterCommit(fn: () => void): void {
		if (this.depth === 0) fn();
		else this.committed.push(fn);
	}

	/**
	 * `reader: true` opens a connection that refuses writes. In WAL mode it reads a consistent snapshot of what is
	 * committed, however long a write on another connection is taking.
	 */
	constructor(source: string | Buffer, options: { reader?: boolean } = {}) {
		if (typeof source === "string" && source !== ":memory:") mkdirSync(dirname(source), { recursive: true });
		this.raw =
			typeof source === "string"
				? new Database(source, { create: true, strict: true })
				: Database.deserialize(source, { strict: true });
		// WAL keeps readers and the writer out of each other's way; NORMAL syncs at checkpoints, which is the
		// durability SQLite documents as safe against application crashes in WAL mode.
		this.exec(`
			PRAGMA journal_mode = WAL;
			PRAGMA synchronous = NORMAL;
			PRAGMA foreign_keys = ON;
			PRAGMA busy_timeout = 5000;
			PRAGMA cache_size = -65536;
			PRAGMA temp_store = MEMORY;
			PRAGMA mmap_size = 268435456;
			PRAGMA journal_size_limit = 4194304;
		`);
		if (options.reader) this.raw.exec("PRAGMA query_only = ON");
	}

	/**
	 * Leaves checkpoints to another connection (see `checkpoint`). By default SQLite checkpoints inside the commit
	 * that fills the log, which copies pages and syncs the file on the thread that committed: tens of milliseconds
	 * in which a server answers nobody. A high limit stays as a guard should the other connection stop.
	 */
	deferCheckpoints(): void {
		this.raw.exec("PRAGMA wal_autocheckpoint = 20000");
	}

	/**
	 * Copies committed pages from the log into the database file, as far as readers allow, without making anyone
	 * wait. Called from a thread of its own while the writer defers its checkpoints.
	 */
	checkpoint(): void {
		this.raw.exec("PRAGMA wal_checkpoint(PASSIVE)");
	}

	/** True while a write transaction is open on this connection. */
	get inTransaction(): boolean {
		return this.depth > 0;
	}

	/**
	 * Opens a write transaction that the caller ends with `commit` or `rollback`. For a command that must let the
	 * event loop run between its steps (a large report); everything else uses `transaction`.
	 */
	begin(): void {
		if (this.depth > 0) throw new Error("a transaction is already open on this connection");
		this.raw.exec("BEGIN IMMEDIATE");
		this.depth = 1;
	}

	commit(): void {
		this.raw.exec("COMMIT");
		this.depth = 0;
		this.flushCommitted();
	}

	rollback(): void {
		if (this.depth === 0) return;
		this.raw.exec("ROLLBACK");
		this.depth = 0;
		this.committed = [];
	}

	private flushCommitted(): void {
		const callbacks = this.committed;
		this.committed = [];
		for (const callback of callbacks) callback();
	}

	private prepared<P extends Params, R>(statement: Statement<P, R>): PreparedStatement<R, SQLQueryBindings[]> {
		let prepared = this.statements.get(statement);
		if (!prepared) {
			prepared = this.raw.prepare(statement.text);
			this.statements.set(statement, prepared);
		}
		// The declaration's phantom row type is preserved by its identity in this heterogeneous cache.
		return prepared as PreparedStatement<R, SQLQueryBindings[]>;
	}

	get<P extends Params, R>(statement: Statement<P, R>, ...params: P extends readonly [] ? [] : [P]): R | null {
		return this.prepared(statement).get(...bind(params[0]));
	}

	all<P extends Params, R>(statement: Statement<P, R>, ...params: P extends readonly [] ? [] : [P]): R[] {
		return this.prepared(statement).all(...bind(params[0]));
	}

	run<P extends Params>(statement: Statement<P, unknown>, ...params: P extends readonly [] ? [] : [P]): RunResult {
		const result = this.prepared(statement).run(...bind(params[0]));
		return { changes: result.changes, lastId: Number(result.lastInsertRowid) };
	}

	/** Runs text that is built at call time (a variable `IN` list). Not prepared by the declared-statement check. */
	allDynamic<R>(text: string, params: readonly SqlValue[]): R[] {
		return this.raw.query<R, SQLQueryBindings[]>(text).all(...(params as SQLQueryBindings[]));
	}

	/** Executes a SQL batch in order, stopping at the first failure. The caller owns the transaction. */
	exec(text: string): void {
		let remaining = text;
		while (remaining.length > 0) {
			remaining = remaining.replace(/^(?:[ \t\r\n\f;\uFEFF]|--[^\n]*(?:\n|$)|\/\*[\s\S]*?(?:\*\/|$))+/, "");
			if (remaining.length === 0) break;
			const statement = this.raw.prepare(remaining);
			try {
				if (statement.paramsCount !== 0) throw new Error("SQL batches cannot contain unbound parameters");
				// With no parameters, sqlite3_expanded_sql is the original first statement, including trigger bodies.
				const first = statement.toString();
				if (first.length === 0 || !remaining.startsWith(first))
					throw new Error("SQLite returned an unexpected SQL boundary");
				statement.run();
				remaining = remaining.slice(first.length);
			} finally {
				statement.finalize();
			}
		}
	}

	/**
	 * Runs `fn` in one write transaction. It takes the write lock at once (`BEGIN IMMEDIATE`), so commands commit
	 * in the order they begin, which is what makes a sequence number assigned at the start the commit order.
	 * Nested calls join the outer transaction.
	 */
	transaction<T>(fn: () => T): T {
		if (this.depth > 0) return fn();
		this.raw.exec("BEGIN IMMEDIATE");
		this.depth++;
		let out: T;
		try {
			out = fn();
			this.raw.exec("COMMIT");
		} catch (error) {
			this.raw.exec("ROLLBACK");
			this.committed = [];
			throw error;
		} finally {
			this.depth--;
		}
		this.flushCommitted();
		return out;
	}

	/**
	 * Runs `fn` inside the current transaction so that it either happens whole or not at all. When `fn` throws, what
	 * it wrote is undone, the rest of the transaction stands, and the error is rethrown for the caller to turn into
	 * a reply. This is how one refused answer in a batch of decisions leaves the others in place.
	 */
	*savepointSteps<T>(fn: () => Generator<undefined, T, void>): Generator<undefined, T, void> {
		if (this.depth === 0) {
			this.begin();
			try {
				const out = yield* fn();
				this.commit();
				return out;
			} finally {
				this.rollback();
			}
		}
		const name = `sp_${this.depth}`;
		const callbacks = this.committed.length;
		this.raw.exec(`SAVEPOINT ${name}`);
		this.depth++;
		let released = false;
		try {
			const out = yield* fn();
			this.raw.exec(`RELEASE ${name}`);
			released = true;
			return out;
		} finally {
			if (!released) {
				this.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
				this.committed.length = callbacks;
			}
			this.depth--;
		}
	}

	savepoint<T>(fn: () => T): T {
		// biome-ignore lint/correctness/useYield: synchronous callers drain the same savepoint implementation.
		const steps = this.savepointSteps(function* () {
			return fn();
		});
		for (let step = steps.next(); ; step = steps.next()) if (step.done) return step.value;
	}

	/**
	 * Checks a bulk replacement's foreign keys before commit. Only an outer transaction may turn off
	 * per-row enforcement; nested calls preserve their caller's settings. Rollback and cancellation restore it.
	 */
	*checkedBulkSteps<T>(fn: () => Generator<undefined, T, void>): Generator<undefined, T, void> {
		const raw = this.raw;
		const disable =
			!raw.inTransaction && raw.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()?.foreign_keys === 1;
		if (disable) raw.exec("PRAGMA foreign_keys = OFF");
		try {
			return yield* this.savepointSteps(function* () {
				const result = yield* fn();
				const foreign = raw.query<{ table: string; parent: string }, []>("PRAGMA foreign_key_check").get();
				if (foreign)
					throw new Error(`bulk write foreign key violation in ${foreign.table}, referencing ${foreign.parent}`);
				return result;
			});
		} finally {
			if (disable) raw.exec("PRAGMA foreign_keys = ON");
		}
	}

	checkedBulk<T>(fn: () => T): T {
		// biome-ignore lint/correctness/useYield: synchronous callers drain the same checked transaction.
		const steps = this.checkedBulkSteps(function* () {
			return fn();
		});
		for (let step = steps.next(); ; step = steps.next()) if (step.done) return step.value;
	}

	/** Runs `fn` against one consistent snapshot, so a read that spans several statements never sees half a write. */
	snapshot<T>(fn: () => T): T {
		if (this.depth > 0) return fn();
		this.raw.exec("BEGIN");
		this.depth++;
		try {
			return fn();
		} finally {
			this.raw.exec("COMMIT");
			this.depth--;
		}
	}

	close(): void {
		for (const statement of this.statements.values()) statement.finalize();
		this.statements.clear();
		this.raw.close();
	}
}

function bind(params: Params | undefined): SQLQueryBindings[] {
	if (params === undefined) return [];
	if (Array.isArray(params)) return params as SQLQueryBindings[];
	return [params as SQLQueryBindings];
}

/** `?, ?, ?` for an `IN` list of `n` values. */
export const placeholders = (n: number): string => Array.from({ length: n }, () => "?").join(", ");

/** Parses a JSON column. The caller names the type; the shape was validated when the row was written. */
export function json<T>(text: string): T {
	return JSON.parse(text) as T;
}
