// Driver connections never leave this module. A scope owns one backend until its callback ends.
import { type ReservedSQL, SQL } from "bun";

export type SqlValue = string | number | bigint | boolean | null | Uint8Array | readonly (string | number | bigint)[];
export type Params = Readonly<Record<string, SqlValue>> | readonly SqlValue[];
export type Args<P extends Params> = P extends readonly [] ? [] : [params: P];
export type Statement<P extends Params, R> = {
	readonly text: string;
	readonly names: readonly string[] | null;
	readonly slots: number;
	readonly __params?: P;
	readonly __row?: R;
};
const declarations: { text: string; names: readonly string[] | null }[] = [];

/** PostgreSQL lexical parameter scan, including nested block comments and tagged dollar quotes. */
export function rewriteNamed(source: string): { text: string; names: readonly string[] | null; slots: number } {
	const names: string[] = [];
	let text = "";
	let positional = 0;
	for (let i = 0; i < source.length; ) {
		const start = i;
		const c = source[i];
		if (c === "'" || c === '"') {
			const escaped = c === "'" && /[eE]/.test(source[i - 1] ?? "") && !/[\w$]/.test(source[i - 2] ?? "");
			i++;
			while (i < source.length) {
				if (escaped && source[i] === "\\") i += 2;
				else if (source[i] === c) {
					i++;
					if (source[i] !== c) break;
					i++;
				} else i++;
			}
		} else if (source.startsWith("--", i)) {
			const end = source.indexOf("\n", i);
			i = end < 0 ? source.length : end + 1;
		} else if (source.startsWith("/*", i)) {
			i += 2;
			let depth = 1;
			while (i < source.length && depth > 0) {
				if (source.startsWith("/*", i)) {
					depth++;
					i += 2;
				} else if (source.startsWith("*/", i)) {
					depth--;
					i += 2;
				} else i++;
			}
		} else if (c === "$" && !/[\w$]/.test(source[i - 1] ?? "")) {
			const tail = source.slice(i);
			const tag = /^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/.exec(tail)?.[0];
			if (tag) {
				const end = source.indexOf(tag, i + tag.length);
				i = end < 0 ? source.length : end + tag.length;
			} else {
				const name = /^\$([A-Za-z_][A-Za-z_0-9]*)/.exec(tail)?.[1];
				const slot = /^\$(\d+)/.exec(tail)?.[1];
				if (name) {
					let index = names.indexOf(name);
					if (index < 0) {
						index = names.length;
						names.push(name);
					}
					text += `$${index + 1}`;
					i += name.length + 1;
					continue;
				}
				if (slot) {
					if (Number(slot) < 1) throw new Error("SQL positional parameters start at $1");
					positional = Math.max(positional, Number(slot));
					i += slot.length + 1;
				} else i++;
			}
		} else i++;
		text += source.slice(start, i);
	}
	if (names.length && positional) throw new Error("SQL cannot mix named and positional parameters");
	return { text, names: positional ? null : names, slots: positional || names.length };
}

export function sql<P extends Params = readonly [], R = never>(text: string): Statement<P, R> {
	const statement = Object.freeze(rewriteNamed(text));
	declarations.push(statement);
	return statement;
}
export const declaredSql = (): readonly { text: string; names: readonly string[] | null }[] => [...declarations];
export type RunResult = { changes: number };
export type Column = { name: string; type: string; nullable: boolean; generated: "none" | "identity" | "stored" };
export type ForeignKey = {
	columns: readonly string[];
	parent: string;
	parentColumns: readonly string[];
	deleteAction: "no-action" | "restrict" | "cascade" | "set-null" | "set-default";
};
export type Table = {
	name: string;
	columns: readonly Column[];
	primary: readonly string[];
	foreignKeys: readonly ForeignKey[];
};

export interface ReadDb {
	get<P extends Params, R>(statement: Statement<P, R>, ...args: Args<P>): Promise<R | null>;
	one<P extends Params, R>(statement: Statement<P, R>, ...args: Args<P>): Promise<R>;
	all<P extends Params, R>(statement: Statement<P, R>, ...args: Args<P>): Promise<R[]>;
	allDynamic<R>(text: string, params?: readonly SqlValue[]): Promise<R[]>;
	catalog(): Promise<readonly Table[]>;
}
export interface WriteDb extends ReadDb {
	run<P extends Params>(statement: Statement<P, unknown>, ...args: Args<P>): Promise<RunResult>;
	runDynamic(text: string, params?: readonly SqlValue[]): Promise<RunResult>;
	exec(text: string): Promise<void>;
	transaction<T>(fn: (db: WriteDb) => T | Promise<T>): Promise<T>;
	savepoint<T>(fn: (db: WriteDb) => T | Promise<T>): Promise<T>;
	savepointSteps<T, Y = undefined>(fn: (db: WriteDb) => AsyncGenerator<Y, T, void>): AsyncGenerator<Y, T, void>;
	deferred<T>(fn: (db: WriteDb) => T | Promise<T>): Promise<T>;
	checkedBulk<T>(fn: (db: WriteDb) => T | Promise<T>): Promise<T>;
	checkedBulkSteps<T, Y = undefined>(fn: (db: WriteDb) => AsyncGenerator<Y, T, void>): AsyncGenerator<Y, T, void>;
	begin(): Promise<void>;
	commit(): Promise<void>;
	rollback(): Promise<void>;
	readonly inTransaction: boolean;
	afterCommit(effect: () => void | Promise<void>): void;
}

export const WRITE_LOCK = 0x4d57524954450001n;
export const MIGRATION_LOCK = 0x4d574d4947520001n;
export function sqlState(error: unknown): string | null {
	if (typeof error !== "object" || error === null) return null;
	const state: unknown = Reflect.get(error, "errno");
	return typeof state === "string" && /^[0-9A-Z]{5}$/.test(state) ? state : null;
}
export const isUniqueViolation = (error: unknown): boolean => sqlState(error) === "23505";
export const isForeignKeyViolation = (error: unknown): boolean => sqlState(error) === "23503";
export const isConstraintViolation = (error: unknown): boolean => sqlState(error)?.startsWith("23") ?? false;
export class ConnectionLost extends Error {
	constructor(cause?: unknown) {
		super("PostgreSQL connection lost; the operation was not retried", { cause });
		this.name = "ConnectionLost";
	}
}
export class TransactionAborted extends Error {
	constructor(readonly first: unknown) {
		super(`transaction aborted by its first failure: ${first instanceof Error ? first.message : String(first)}`, {
			cause: first,
		});
		this.name = "TransactionAborted";
	}
}
function lost(error: unknown): boolean {
	const state = sqlState(error);
	return (
		error instanceof ConnectionLost ||
		!!state?.startsWith("08") ||
		state === "57P01" ||
		state === "57P02" ||
		state === "57P03" ||
		(error instanceof Error &&
			/connection.*(?:closed|lost|terminated|PostgresSQLConnection)|(?:socket|connection) (?:ended|reset)|ECONNRESET|EPIPE/i.test(
				error.message,
			))
	);
}
function safeInteger(value: bigint, column: string): number {
	if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER))
		throw new RangeError(`PostgreSQL bigint in ${column} exceeds the safe integer range`);
	return Number(value);
}
export function arrayLiteral(values: readonly (string | number | bigint)[]): string {
	return `{${values
		.map((value) => {
			if (typeof value === "string") return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
			if (typeof value === "bigint") return String(value);
			if (
				typeof value !== "number" ||
				!Number.isFinite(value) ||
				(Number.isInteger(value) && !Number.isSafeInteger(value))
			)
				throw new RangeError("SQL array parameter is not a finite safe number or text");
			return String(value);
		})
		.join(",")}}`;
}
function encode(value: unknown): string | number | bigint | boolean | null | Uint8Array {
	if (Array.isArray(value)) return arrayLiteral(value);
	if (typeof value === "bigint") return value;
	if (
		typeof value === "number" &&
		(!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))
	)
		throw new RangeError("SQL number parameter exceeds the safe integer range");
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean" ||
		value instanceof Uint8Array
	)
		return value;
	throw new TypeError("unsupported SQL parameter");
}
function decode(value: unknown, column: string): unknown {
	if (typeof value === "bigint") return safeInteger(value, column);
	if (Array.isArray(value)) return value.map((item) => decode(item, column));
	return value;
}
function decodeRow<R>(row: R): R {
	if (typeof row !== "object" || row === null) throw new TypeError("PostgreSQL returned a non-object row");
	for (const key of Object.keys(row)) Reflect.set(row, key, decode(Reflect.get(row, key), key));
	return row;
}
function bind<P extends Params>(statement: Statement<P, unknown>, params: P | undefined): ReturnType<typeof encode>[] {
	if (statement.names === null) {
		if (!Array.isArray(params) || params.length !== statement.slots)
			throw new Error(`SQL expects ${statement.slots} positional parameters`);
		return params.map(encode);
	}
	if (params === undefined) {
		if (statement.names.length) throw new Error(`missing SQL parameter ${statement.names[0]}`);
		return [];
	}
	if (Array.isArray(params)) {
		if (params.length === 0 && statement.names.length === 0) return [];
		throw new Error("named SQL expects a parameter object");
	}
	for (const name of statement.names)
		if (!Object.hasOwn(params, name)) throw new Error(`missing SQL parameter ${name}`);
	for (const name of Object.keys(params))
		if (!statement.names.includes(name)) throw new Error(`unexpected SQL parameter ${name}`);
	return statement.names.map((name) => encode(Reflect.get(params, name)));
}

/** Parses JSON whose shape was checked before it was stored. */
export function json<T>(text: string): T {
	return JSON.parse(text);
}

type Effect = () => void | Promise<void>;
type Transaction = { aborted: { error: unknown } | null; queues: Effect[][] };
type Lease = {
	conn: ReservedSQL;
	alive: boolean;
	lost: ConnectionLost | null;
	poisoned: boolean;
	tx: Transaction | null;
	statements: () => void;
};
async function query<R>(
	lease: Lease,
	text: string,
	params: readonly SqlValue[] = [],
	control = false,
	simple = false,
): Promise<R[] & { count: number }> {
	if (!lease.alive) throw new Error("database scope has ended");
	if (lease.lost) throw lease.lost;
	if (!control && lease.tx?.aborted) throw new TransactionAborted(lease.tx.aborted.error);
	const values = params.map(encode);
	lease.statements();
	try {
		const pending = lease.conn.unsafe<R[] & { count: number }>(text, values);
		return await (simple ? pending.simple() : pending);
	} catch (error) {
		if (lost(error)) {
			lease.poisoned = true;
			lease.lost = error instanceof ConnectionLost ? error : new ConnectionLost(error);
			throw lease.lost;
		}
		if (lease.tx && !lease.tx.aborted) lease.tx.aborted = { error };
		throw error;
	}
}

class Scope implements WriteDb {
	constructor(
		private readonly lease: Lease,
		private readonly writable: boolean,
	) {}
	get inTransaction(): boolean {
		return this.lease.tx !== null;
	}
	async all<P extends Params, R>(statement: Statement<P, R>, ...args: Args<P>): Promise<R[]> {
		const rows = await query<R>(this.lease, statement.text, bind(statement, args[0]));
		return rows.map(decodeRow);
	}
	async get<P extends Params, R>(statement: Statement<P, R>, ...args: Args<P>): Promise<R | null> {
		return (await this.all(statement, ...args))[0] ?? null;
	}
	async one<P extends Params, R>(statement: Statement<P, R>, ...args: Args<P>): Promise<R> {
		const rows = await this.all(statement, ...args);
		if (rows.length !== 1) throw new Error(`expected exactly one SQL row, received ${rows.length}`);
		// Length checked at the driver boundary above.
		return rows[0] as R;
	}
	async allDynamic<R>(text: string, params: readonly SqlValue[] = []): Promise<R[]> {
		return (await query<R>(this.lease, text, params)).map(decodeRow);
	}
	private requireWrite(): Transaction {
		if (!this.writable) throw new Error("a read scope cannot write");
		if (!this.lease.alive) throw new Error("database scope has ended");
		if (!this.lease.tx) throw new Error("a domain write requires an open transaction");
		return this.lease.tx;
	}
	async run<P extends Params>(statement: Statement<P, unknown>, ...args: Args<P>): Promise<RunResult> {
		this.requireWrite();
		return { changes: (await query(this.lease, statement.text, bind(statement, args[0]))).count };
	}
	async runDynamic(text: string, params: readonly SqlValue[] = []): Promise<RunResult> {
		this.requireWrite();
		return { changes: (await query(this.lease, text, params)).count };
	}
	async exec(text: string): Promise<void> {
		this.requireWrite();
		await query(this.lease, text, [], false, true);
	}
	async begin(): Promise<void> {
		if (!this.writable) throw new Error("a read scope cannot write");
		if (this.lease.tx) throw new Error("transaction already open");
		await query(this.lease, "BEGIN", [], true);
		this.lease.tx = { aborted: null, queues: [[]] };
	}
	async commit(): Promise<void> {
		const tx = this.requireWrite();
		if (tx.queues.length !== 1) throw new Error("cannot commit with an open savepoint");
		if (tx.aborted) throw new TransactionAborted(tx.aborted.error);
		await query(this.lease, "COMMIT", [], true);
		this.lease.tx = null;
		for (const effect of tx.queues[0] ?? []) {
			try {
				const result = effect();
				if (result) void result.catch(() => console.error("[mainworthy] after-commit effect failed"));
			} catch {
				console.error("[mainworthy] after-commit effect failed");
			}
		}
	}
	async rollback(): Promise<void> {
		if (!this.lease.tx) return;
		try {
			await query(this.lease, "ROLLBACK", [], true);
		} catch (error) {
			this.lease.poisoned = true;
			throw error;
		} finally {
			this.lease.tx = null;
		}
	}
	afterCommit(effect: Effect): void {
		const tx = this.requireWrite();
		const queue = tx.queues.at(-1);
		if (!queue) throw new Error("transaction effect queue missing");
		queue.push(effect);
	}
	async transaction<T>(fn: (db: WriteDb) => T | Promise<T>): Promise<T> {
		if (this.lease.tx) {
			this.requireWrite();
			return await fn(this);
		}
		await this.begin();
		try {
			const result = await fn(this);
			await this.commit();
			return result;
		} catch (error) {
			await this.rollback();
			throw error;
		}
	}
	async *savepointSteps<T, Y = undefined>(fn: (db: WriteDb) => AsyncGenerator<Y, T, void>): AsyncGenerator<Y, T, void> {
		const tx = this.requireWrite();
		if (tx.aborted) throw new TransactionAborted(tx.aborted.error);
		const name = `mw_sp_${tx.queues.length}`;
		await query(this.lease, `SAVEPOINT ${name}`);
		const effects: Effect[] = [];
		tx.queues.push(effects);
		let completed = false;
		try {
			const result = yield* fn(this);
			this.checkAborted(tx);
			await query(this.lease, `RELEASE SAVEPOINT ${name}`);
			completed = true;
			return result;
		} finally {
			await this.finishSavepoint(tx, name, completed, effects);
		}
	}
	private checkAborted(tx: Transaction): void {
		if (tx.aborted) throw new TransactionAborted(tx.aborted.error);
	}
	private async finishSavepoint(tx: Transaction, name: string, completed: boolean, effects: Effect[]): Promise<void> {
		try {
			if (!completed) {
				try {
					await query(this.lease, `ROLLBACK TO SAVEPOINT ${name}`, [], true);
					await query(this.lease, `RELEASE SAVEPOINT ${name}`, [], true);
					tx.aborted = null;
				} catch (error) {
					this.lease.poisoned = true;
					throw error;
				}
			}
		} finally {
			tx.queues.pop();
		}
		if (completed) tx.queues.at(-1)?.push(...effects);
	}
	async savepoint<T>(fn: (db: WriteDb) => T | Promise<T>): Promise<T> {
		// biome-ignore lint/correctness/useYield: callbacks drain the same savepoint implementation as generators.
		const steps = this.savepointSteps(async function* (db) {
			return await fn(db);
		});
		return drain(steps);
	}
	async deferred<T>(fn: (db: WriteDb) => T | Promise<T>): Promise<T> {
		return this.savepoint(async (db) => {
			await query(this.lease, "SET CONSTRAINTS ALL DEFERRED");
			return await fn(db);
		});
	}
	async *checkedBulkSteps<T, Y = undefined>(
		fn: (db: WriteDb) => AsyncGenerator<Y, T, void>,
	): AsyncGenerator<Y, T, void> {
		const lease = this.lease;
		return yield* this.savepointSteps(async function* (db) {
			await query(lease, "SET CONSTRAINTS ALL DEFERRED");
			const result = yield* fn(db);
			await query(lease, "SET CONSTRAINTS ALL IMMEDIATE");
			return result;
		});
	}
	async checkedBulk<T>(fn: (db: WriteDb) => T | Promise<T>): Promise<T> {
		return drain(
			// biome-ignore lint/correctness/useYield: callbacks drain the same checked bulk implementation as generators.
			this.checkedBulkSteps(async function* (db) {
				return await fn(db);
			}),
		);
	}
	async catalog(): Promise<readonly Table[]> {
		const columns = await this.allDynamic<Column & { table: string }>(`
			SELECT c.table_name AS "table", c.column_name AS name, c.udt_name AS type,
			c.is_nullable = 'YES' AS nullable,
			CASE WHEN c.is_identity = 'YES' THEN 'identity' WHEN c.is_generated = 'ALWAYS' THEN 'stored' ELSE 'none' END AS generated
			FROM information_schema.columns c WHERE c.table_schema = 'public' ORDER BY c.table_name, c.ordinal_position`);
		const keys = await this.allDynamic<{ table: string; name: string }>(`
			SELECT t.relname AS "table", a.attname AS name FROM pg_constraint c
			JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
			CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
			JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
			WHERE n.nspname = 'public' AND c.contype = 'p' ORDER BY t.relname, k.ord`);
		const foreign = await this.allDynamic<ForeignKey & { table: string }>(`
			SELECT t.relname AS "table", p.relname AS parent, array_agg(a.attname::text ORDER BY k.ord) AS columns,
			array_agg(pa.attname::text ORDER BY k.ord) AS "parentColumns",
			CASE c.confdeltype WHEN 'r' THEN 'restrict' WHEN 'c' THEN 'cascade' WHEN 'n' THEN 'set-null'
			WHEN 'd' THEN 'set-default' ELSE 'no-action' END AS "deleteAction"
			FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
			JOIN pg_class p ON p.oid = c.confrelid
			CROSS JOIN LATERAL unnest(c.conkey, c.confkey) WITH ORDINALITY k(attnum, parentnum, ord)
			JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
			JOIN pg_attribute pa ON pa.attrelid = p.oid AND pa.attnum = k.parentnum
			WHERE n.nspname = 'public' AND c.contype = 'f' GROUP BY t.relname, p.relname, c.oid, c.confdeltype`);
		return [...new Set(columns.map((column) => column.table))].map((name) => ({
			name,
			columns: columns.filter((column) => column.table === name).map(({ table: _, ...column }) => column),
			primary: keys.filter((key) => key.table === name).map((key) => key.name),
			foreignKeys: foreign.filter((key) => key.table === name).map(({ table: _, ...key }) => key),
		}));
	}
}
async function drain<T>(steps: AsyncGenerator<undefined, T, void>): Promise<T> {
	for (;;) {
		const step = await steps.next();
		if (step.done) return step.value;
	}
}

function poolSize(value: number | string | undefined, fallback: number): number {
	const count = value === undefined ? fallback : Number(value);
	if (!Number.isSafeInteger(count) || count < 1 || count > 64)
		throw new Error("database pool size must be an integer from 1 to 64");
	return count;
}
export type OpenOptions = { url: string; readPool?: number; writePool?: number; acquireTimeoutMs?: number };
export class Database {
	private readonly readers: SQL;
	private readonly writers: SQL;
	private readonly shutdown = new AbortController();
	private tail: Promise<void> = Promise.resolve();
	private count = 0;
	private constructor(private readonly options: OpenOptions) {
		this.readers = new SQL(options.url, {
			bigint: true,
			max: poolSize(options.readPool ?? process.env.MAINWORTHY_DB_POOL, 2),
		});
		this.writers = new SQL(options.url, {
			bigint: true,
			max: poolSize(options.writePool ?? process.env.MAINWORTHY_DB_WRITE_POOL, 1),
		});
	}
	static async open(input: OpenOptions): Promise<Database> {
		if (!input.url) throw new Error("MAINWORTHY_DATABASE_URL is required; see compose.yaml");
		const database = new Database(input);
		try {
			await database.read((db) => db.allDynamic("SELECT 1"));
			return database;
		} catch (error) {
			await database.close();
			throw error;
		}
	}
	get statementCount(): number {
		return this.count;
	}
	resetStatementCount(): void {
		this.count = 0;
	}
	private signal(signal?: AbortSignal): AbortSignal {
		return AbortSignal.any([
			this.shutdown.signal,
			AbortSignal.timeout(this.options.acquireTimeoutMs ?? 30_000),
			...(signal ? [signal] : []),
		]);
	}
	private async lease(pool: SQL, signal?: AbortSignal): Promise<Lease> {
		const conn = await pool.reserve({ signal: this.signal(signal) });
		return {
			conn,
			alive: true,
			lost: null,
			poisoned: false,
			tx: null,
			statements: () => {
				this.count++;
			},
		};
	}
	private async dispose(lease: Lease): Promise<void> {
		lease.alive = false;
		if (lease.poisoned || lease.lost) {
			await lease.conn.close({ timeout: 0 });
		}
		lease.conn.release();
	}
	async read<T>(fn: (db: ReadDb) => T | Promise<T>, options: { signal?: AbortSignal } = {}): Promise<T> {
		const lease = await this.lease(this.readers, options.signal);
		try {
			await query(lease, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY", [], true);
			lease.tx = { aborted: null, queues: [[]] };
			const result = await fn(new Scope(lease, false));
			if (lease.tx.aborted) throw new TransactionAborted(lease.tx.aborted.error);
			await query(lease, "COMMIT", [], true);
			lease.tx = null;
			return result;
		} finally {
			await this.finishRead(lease);
		}
	}
	private async finishRead(lease: Lease): Promise<void> {
		try {
			if (lease.tx && !lease.lost) await query(lease, "ROLLBACK", [], true);
		} catch (error) {
			lease.poisoned = true;
			throw error;
		} finally {
			await this.dispose(lease);
		}
	}
	async write<T>(fn: (db: WriteDb) => T | Promise<T>, options: { signal?: AbortSignal } = {}): Promise<T> {
		const previous = this.tail;
		let release = () => {};
		this.tail = new Promise<void>((resolve) => {
			release = resolve;
		});
		const signal = this.signal(options.signal);
		try {
			await abortable(previous, signal);
			return await this.locked(this.writers, WRITE_LOCK, fn, signal);
		} finally {
			// A cancelled waiter cannot let its successor jump ahead of an active lease.
			void previous.then(release);
		}
	}
	/** Only migrationLock calls this; its pool is never shared with application leases. */
	async migration<T>(fn: (db: WriteDb) => T | Promise<T>): Promise<T> {
		const dedicated = new SQL(this.options.url, { bigint: true, max: 1 });
		try {
			return await this.locked(dedicated, MIGRATION_LOCK, fn, this.signal());
		} finally {
			await dedicated.close();
		}
	}
	private async locked<T>(
		pool: SQL,
		key: bigint,
		fn: (db: WriteDb) => T | Promise<T>,
		signal: AbortSignal,
	): Promise<T> {
		const lease = await this.lease(pool, signal);
		const db = new Scope(lease, true);
		let acquired = false;
		try {
			// Once sent, an uncertain acquisition must destroy the connection too.
			lease.poisoned = true;
			await query(lease, "SELECT pg_advisory_lock($1::bigint)", [key]);
			acquired = true;
			lease.poisoned = false;
			const result = await fn(db);
			if (lease.lost) throw lease.lost;
			if (lease.tx) throw new Error("write callback returned with an open transaction");
			return result;
		} finally {
			await this.finishWrite(lease, db, acquired, key);
		}
	}
	private async finishWrite(lease: Lease, db: Scope, acquired: boolean, key: bigint): Promise<void> {
		try {
			if (lease.tx && !lease.lost) await db.rollback();
			if (acquired && !lease.lost && !lease.poisoned) {
				try {
					const rows = await query<{ unlocked: boolean }>(
						lease,
						"SELECT pg_advisory_unlock($1::bigint) AS unlocked",
						[key],
						true,
					);
					if (rows[0]?.unlocked !== true) throw new Error("PostgreSQL write lock was not held at release");
				} catch (error) {
					lease.poisoned = true;
					throw error;
				}
			}
		} finally {
			await this.dispose(lease);
		}
	}
	async close(): Promise<void> {
		this.shutdown.abort(new Error("database is closed"));
		await this.tail;
		await Promise.all([this.readers.close(), this.writers.close()]);
	}
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	signal.throwIfAborted();
	return new Promise((resolve, reject) => {
		const abort = () => {
			reject(signal.reason);
		};
		signal.addEventListener("abort", abort, { once: true });
		void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}
export async function migrationLock<T>(database: Database, fn: (db: WriteDb) => T | Promise<T>): Promise<T> {
	return database.migration(fn);
}

/** Fixture administration outside a transaction, still keeping the driver private to the kernel. */
export type DatabaseAdmin = {
	all<R>(text: string, params?: readonly SqlValue[]): Promise<R[]>;
	exec(text: string): Promise<void>;
};
export async function databaseAdmin<T>(url: string, fn: (admin: DatabaseAdmin) => Promise<T>): Promise<T> {
	const pool = new SQL(url, { max: 1, bigint: true });
	const conn = await pool.reserve({ signal: AbortSignal.timeout(30_000) });
	const lease: Lease = { conn, alive: true, lost: null, poisoned: false, tx: null, statements: () => {} };
	try {
		return await fn({
			async all<R>(text: string, params: readonly SqlValue[] = []): Promise<R[]> {
				return (await query<R>(lease, text, params)).map(decodeRow);
			},
			async exec(text: string): Promise<void> {
				await query(lease, text, [], false, true);
			},
		});
	} finally {
		lease.alive = false;
		conn.release();
		await pool.close();
	}
}
