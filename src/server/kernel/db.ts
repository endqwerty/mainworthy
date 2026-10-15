// The only module that talks to SQLite. Everything above it calls `get`, `all`, `run` and `transaction`.
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type SqlValue = string | number | bigint | boolean | null | Uint8Array;
export type Params = Record<string, SqlValue> | readonly SqlValue[];

/** Every SQL text the server can run, collected at module load so a test can prepare each against the schema. */
const DECLARED = new Set<string>();

/**
 * Declares a statement once, with the types of its parameters and its rows. The text is the cache key for the
 * prepared statement, and `declaredSql()` lets the check prepare every statement the code can run.
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

	/**
	 * `reader: true` opens a connection that refuses writes. In WAL mode it reads a consistent snapshot of what is
	 * committed, however long a write on another connection is taking.
	 */
	constructor(path: string, options: { reader?: boolean } = {}) {
		if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
		this.raw = new Database(path, { create: true, strict: true });
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
	}

	rollback(): void {
		if (this.depth === 0) return;
		this.raw.exec("ROLLBACK");
		this.depth = 0;
	}

	get<P extends Params, R>(statement: Statement<P, R>, ...params: P extends readonly [] ? [] : [P]): R | null {
		return this.raw.query<R, SQLQueryBindings[]>(statement.text).get(...bind(params[0]));
	}

	all<P extends Params, R>(statement: Statement<P, R>, ...params: P extends readonly [] ? [] : [P]): R[] {
		return this.raw.query<R, SQLQueryBindings[]>(statement.text).all(...bind(params[0]));
	}

	run<P extends Params>(statement: Statement<P, unknown>, ...params: P extends readonly [] ? [] : [P]): RunResult {
		const result = this.raw.query(statement.text).run(...bind(params[0]));
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
		try {
			const out = fn();
			this.raw.exec("COMMIT");
			return out;
		} catch (error) {
			this.raw.exec("ROLLBACK");
			throw error;
		} finally {
			this.depth--;
		}
	}

	/**
	 * Runs `fn` inside the current transaction so that it either happens whole or not at all. When `fn` throws, what
	 * it wrote is undone, the rest of the transaction stands, and the error is rethrown for the caller to turn into
	 * a reply. This is how one refused answer in a batch of decisions leaves the others in place.
	 */
	savepoint<T>(fn: () => T): T {
		if (this.depth === 0) return this.transaction(fn);
		const name = `sp_${this.depth}`;
		this.raw.exec(`SAVEPOINT ${name}`);
		this.depth++;
		try {
			const out = fn();
			this.raw.exec(`RELEASE ${name}`);
			return out;
		} catch (error) {
			this.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
			throw error;
		} finally {
			this.depth--;
		}
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
