import { createHash } from "node:crypto";
import { z } from "zod";
import type { Db } from "../kernel/db.ts";
import { OpError } from "../kernel/errors.ts";
import { ARCHIVE_VERSION } from "../kernel/migrate.ts";

const CHUNK_BYTES = 64 * 1024;
const Count = z.number().int().nonnegative();

// Maps preserve every JSON key, including __proto__, which Zod object records discard.
function jsonMap<T extends z.ZodType>(values: T) {
	return z.preprocess(
		(value) =>
			typeof value === "object" && value !== null && !Array.isArray(value) ? new Map(Object.entries(value)) : value,
		z.map(z.string(), values),
	);
}

const headerFields = { format: Count, schema: Count, exportedAt: Count, tables: jsonMap(Count) };
/** The second shape is what an export wrote while the project was called Casebook (decision 0015). */
const Header = z.union([
	z.strictObject({ mainworthy: z.literal("archive"), ...headerFields }),
	z.strictObject({ casebook: z.literal("archive"), ...headerFields }),
]);
const Value = z.union([
	z.string(),
	z.number().finite(),
	z.bigint().min(-9_223_372_036_854_775_808n).max(9_223_372_036_854_775_807n),
	z.null(),
]);
const Entry = z.union([
	z.strictObject({ t: z.string(), r: jsonMap(Value) }),
	z.strictObject({ end: z.literal(true), rows: Count, sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
]);
type Value = z.infer<typeof Value>;
type Header = z.infer<typeof Header>;
const TableName = z.object({ name: z.string() });
const TableKind = z.object({ schema: z.string(), name: z.string(), type: z.string() });
const Column = z.object({ name: z.string(), pk: Count });
const ForeignKey = z.object({ table: z.string() });
const ConstraintError = z.object({ code: z.string().startsWith("SQLITE_CONSTRAINT"), message: z.string() });
type Table = { name: string; columns: string[]; primary: string[]; parents: string[] };

/**
 * The tables an archive never holds: each keeps what lets somebody in. A token's, a session's and an
 * invitation's row holds the hash of a secret; a credential's holds a password's hash or a passkey's public key;
 * `passkey_users` holds the handle a person's passkeys are filed under. An export leaves them out and an import
 * empties them, in this order, so a table comes before the one it refers to. This one list serves both, and
 * `test/architecture.test.ts` holds it to the schema: a table of identity that is neither listed here nor one
 * of the three an archive is meant to hold fails there.
 */
export const UNEXPORTED: readonly string[] = ["sessions", "credentials", "invitations", "passkey_users", "tokens"];

/** The row counts describe exported data, excluding migration metadata, credentials and the search index. */
export type ArchiveCounts = { rows: number; tables: Record<string, number> };

/** The digest covers the UTF-8 bytes of the header and all row lines, including each newline. */
export type ExportedArchive = ArchiveCounts & { sha256: string };

function invalid(message: string): OpError {
	return new OpError("invalid", message);
}

function identifier(name: string): string {
	return `"${name.replaceAll('"', '""')}"`;
}

function literal(text: string): string {
	return `'${text.replaceAll("'", "''")}'`;
}

function where(table: Table): string {
	return table.name === "meta" ? "WHERE key <> 'schema_version'" : "";
}

function discoverTables(db: Db): Table[] {
	const shadowTables = new Set(
		TableKind.array()
			.parse(db.raw.query("PRAGMA table_list").all())
			.filter((table) => table.schema === "main" && table.type === "shadow" && table.name.startsWith("search_docs_"))
			.map((table) => table.name),
	);
	const names = TableName.array()
		.parse(db.raw.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all())
		.map((table) => table.name)
		.filter(
			(name) =>
				!UNEXPORTED.includes(name) && name !== "search_docs" && !shadowTables.has(name) && !name.startsWith("sqlite_"),
		);
	const tables = new Map<string, Table>();
	for (const name of names) {
		const columns = Column.array().parse(db.raw.query(`PRAGMA table_info(${identifier(name)})`).all());
		const foreignKeys = ForeignKey.array().parse(db.raw.query(`PRAGMA foreign_key_list(${identifier(name)})`).all());
		tables.set(name, {
			name,
			columns: columns.map((column) => column.name),
			primary: columns
				.filter((column) => column.pk > 0)
				.sort((a, b) => a.pk - b.pk)
				.map((column) => column.name),
			parents: [...new Set(foreignKeys.map((foreign) => foreign.table))].sort(),
		});
	}
	const ordered: Table[] = [];
	const visited = new Set<string>();
	const visit = (name: string): void => {
		if (visited.has(name)) return;
		visited.add(name);
		const table = tables.get(name);
		if (!table) return;
		// Parent tables precede children. Self references and cycles require the importer's deferred keys.
		for (const parent of table.parents) visit(parent);
		ordered.push(table);
	};
	for (const name of names) visit(name);
	return ordered;
}

/**
 * Streams a whole migrated instance as NDJSON inside one consistent read snapshot. Rows follow primary keys;
 * JSON-typed TEXT remains text, and SQLite serializes integers exactly, including values outside JS's safe range.
 * Tokens, sessions, passwords, passkeys and invitations never travel (`UNEXPORTED`). The FTS index is omitted and
 * rebuilt during import. The header names the archive version, not the schema version (`ARCHIVE_VERSION`).
 * Invalid UTF-8 in stored TEXT is refused because replacing bytes would make the archive lossy.
 * Chunks contain whole lines and are at most about 64 KiB, except for a single larger row. The synchronous
 * writer must not mutate this database connection. A writer failure propagates and releases the snapshot.
 */
export function exportArchive(db: Db, write: (chunk: string) => void, options: { now?: number } = {}): ExportedArchive {
	const exportedAt = options.now ?? Date.now();
	if (!Number.isSafeInteger(exportedAt) || exportedAt < 0)
		throw invalid("exportedAt must be a nonnegative integer millisecond timestamp");
	return db.snapshot(() => {
		const metadata = discoverTables(db);
		const tables = Object.fromEntries(
			metadata.map((table) => [
				table.name,
				db.raw
					.query<{ count: number }, []>(`SELECT count(*) AS count FROM ${identifier(table.name)} ${where(table)}`)
					.get()?.count ?? 0,
			]),
		);
		const hash = createHash("sha256");
		const decoder = new TextDecoder("utf-8", { fatal: true });
		let chunk = "";
		let bytes = 0;
		let rows = 0;
		const flush = (): void => {
			if (chunk.length === 0) return;
			write(chunk);
			chunk = "";
			bytes = 0;
		};
		const append = (line: string, hashed = true): void => {
			const size = Buffer.byteLength(line);
			if (bytes + size > CHUNK_BYTES) flush();
			if (hashed) hash.update(line);
			chunk += line;
			bytes += size;
			if (bytes >= CHUNK_BYTES) flush();
		};
		append(`${JSON.stringify({ mainworthy: "archive", format: 1, schema: ARCHIVE_VERSION, exportedAt, tables })}\n`);
		for (const table of metadata) {
			const fields = table.columns.flatMap((column) => [literal(column), identifier(column)]);
			const order = (table.primary.length > 0 ? table.primary : table.columns).map(identifier).join(", ");
			const statement = db.raw.prepare<{ json: Uint8Array }, []>(
				`SELECT CAST(json_object(${fields.join(", ")}) AS BLOB) AS json FROM ${identifier(table.name)} ${where(table)} ORDER BY ${order}`,
			);
			try {
				for (const row of statement.iterate()) {
					let json: string;
					try {
						json = decoder.decode(row.json);
					} catch {
						throw invalid(`cannot export table ${table.name} losslessly: stored TEXT contains invalid UTF-8`);
					}
					append(`{"t":${JSON.stringify(table.name)},"r":${json}}\n`);
					rows++;
				}
			} finally {
				statement.finalize();
			}
		}
		const sha256 = hash.digest("hex");
		append(`${JSON.stringify({ end: true, rows, sha256 })}\n`, false);
		flush();
		return { rows, tables, sha256 };
	});
}

function parseLine(line: string, position: number): unknown {
	if (line.includes("\n")) throw invalid(`archive line ${position} contains a newline; pass individual lines`);
	try {
		return JSON.parse(line, (_key: string, value: unknown, context?: { source: string }): unknown => {
			// Bun supplies the original numeric lexeme. Convert unsafe integer tokens before precision is lost.
			const source = context?.source;
			if (typeof value === "number" && !Number.isSafeInteger(value) && source !== undefined && /^-?\d+$/.test(source)) {
				return BigInt(source);
			}
			return value;
		});
	} catch (error) {
		throw invalid(
			`invalid JSON on archive line ${position}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function readHeader(line: string, metadata: readonly Table[]): Header {
	const result = Header.safeParse(parseLine(line, 1));
	if (!result.success) throw invalid(`invalid archive header: ${result.error.message}`);
	const header = result.data;
	if (header.format !== 1) throw invalid(`unsupported archive format ${header.format}; this build supports format 1`);
	if (header.schema > ARCHIVE_VERSION) {
		throw invalid(
			`archive schema ${header.schema} is newer than this build's archive schema ${ARCHIVE_VERSION}; upgrade Mainworthy`,
		);
	}
	if (header.schema !== ARCHIVE_VERSION) {
		throw invalid(
			`archive schema ${header.schema} is older than this build's archive schema ${ARCHIVE_VERSION}; replay across migrations that may rename columns is not supported yet`,
		);
	}
	const names = new Set(metadata.map((table) => table.name));
	for (const name of header.tables.keys()) {
		if (!names.has(name)) throw invalid(`unknown or excluded archive table ${name}`);
	}
	for (const name of names) {
		if (!header.tables.has(name)) throw invalid(`archive header is missing table ${name}`);
	}
	return header;
}

function importTransaction<T>(db: Db, fn: () => T): T {
	const deferred =
		db.raw.query<{ defer_foreign_keys: number }, []>("PRAGMA defer_foreign_keys").get()?.defer_foreign_keys ?? 0;
	if (db.raw.inTransaction && deferred === 0 && db.raw.query("PRAGMA foreign_key_check").get()) {
		throw new OpError("conflict", "the caller has pending foreign key violations; resolve them before importing");
	}
	try {
		return db.savepoint(fn);
	} finally {
		// Restore only after a failing savepoint has rolled back its pending references.
		if (db.raw.inTransaction) {
			const current = db.raw.query<{ defer_foreign_keys: number }, []>("PRAGMA defer_foreign_keys").get();
			if (current?.defer_foreign_keys !== deferred) db.raw.exec(`PRAGMA defer_foreign_keys = ${deferred}`);
		}
	}
}

/**
 * Replays a format-1 archive into an instance with no projects, preserving all IDs and stored values. The
 * header must name this build's archive version, which is the last migration that changed an exported table, so an
 * archive taken before a migration that changed none still imports. Every count, digest, column and foreign key
 * is checked before commit; a failure restores the entire target, including bootstrap rows, sessions and the old
 * search index. Tokens and sessions are discarded on success along with bootstrap identity rows.
 * Migration-owned schema_version is retained.
 * Lines exclude the LF separator and retain all other characters, since their bytes determine the digest.
 * Import uses one write transaction, or a savepoint if its caller already owns a write transaction, restoring
 * the caller's foreign-key deferral setting. Archived rows violating SQLite constraints are invalid operations.
 * A caller with pending deferred constraints and global deferral off must resolve those references first,
 * because restoring that PRAGMA would otherwise discard its pending constraint checks.
 */
export function importArchive(db: Db, lines: Iterable<string>): ArchiveCounts {
	return importTransaction(db, () => {
		if (db.raw.query("SELECT 1 FROM projects LIMIT 1").get()) {
			throw new OpError(
				"conflict",
				"importing into a non-empty instance is not supported yet; use an instance with no projects",
			);
		}
		const metadata = discoverTables(db);
		const iterator = lines[Symbol.iterator]();
		const inserts = new Map<string, ReturnType<typeof db.raw.prepare<unknown, Value[]>>>();
		try {
			const first = iterator.next();
			if (first.done) throw invalid("empty archive: the header is missing");
			const header = readHeader(first.value, metadata);
			const tables = new Map(metadata.map((table) => [table.name, table]));
			const counts = new Map(metadata.map((table) => [table.name, 0]));
			const hash = createHash("sha256").update(`${first.value}\n`);
			let rows = 0;
			let position = 1;
			let ended = false;
			db.raw.exec("PRAGMA defer_foreign_keys = ON");
			for (const name of UNEXPORTED) db.raw.exec(`DELETE FROM ${identifier(name)}`);
			db.raw.exec("DELETE FROM search_docs");
			for (const table of [...metadata].reverse()) {
				db.raw.exec(`DELETE FROM ${identifier(table.name)} ${where(table)}`);
				inserts.set(
					table.name,
					db.raw.prepare<unknown, Value[]>(
						`INSERT INTO ${identifier(table.name)} (${table.columns.map(identifier).join(", ")}) VALUES (${table.columns.map(() => "?").join(", ")})`,
					),
				);
			}
			for (let next = iterator.next(); !next.done; next = iterator.next()) {
				position++;
				if (ended) throw invalid(`trailing data after archive footer on line ${position}`);
				const parsed = Entry.safeParse(parseLine(next.value, position));
				if (!parsed.success)
					throw invalid(`invalid archive row or footer on line ${position}: ${parsed.error.message}`);
				const entry = parsed.data;
				if ("end" in entry) {
					if (entry.rows !== rows)
						throw invalid(`archive footer row count ${entry.rows} does not match loaded row count ${rows}`);
					if (entry.sha256 !== hash.digest("hex")) throw invalid("archive SHA-256 checksum mismatch");
					for (const [name, count] of counts) {
						if (count !== header.tables.get(name))
							throw invalid(
								`archive table ${name} row count ${count} does not match header count ${header.tables.get(name)}`,
							);
					}
					ended = true;
					continue;
				}
				const table = tables.get(entry.t);
				const insert = inserts.get(entry.t);
				if (!table || !insert) throw invalid(`unknown or excluded archive table ${entry.t}`);
				const columns = new Set(table.columns);
				for (const column of entry.r.keys()) {
					if (!columns.has(column)) throw invalid(`unknown column ${entry.t}.${column}`);
				}
				for (const column of table.columns) {
					if (!entry.r.has(column)) throw invalid(`missing column ${entry.t}.${column}`);
				}
				if (entry.t === "meta" && entry.r.get("key") === "schema_version")
					throw invalid("archive must not overwrite meta.schema_version");
				try {
					insert.run(...table.columns.map((column) => entry.r.get(column) ?? null));
				} catch (error) {
					const constraint = ConstraintError.safeParse(error);
					if (constraint.success) {
						throw invalid(`invalid archive row in table ${entry.t} on line ${position}: ${constraint.data.message}`);
					}
					throw error;
				}
				counts.set(entry.t, (counts.get(entry.t) ?? 0) + 1);
				rows++;
				hash.update(`${next.value}\n`);
			}
			if (!ended) throw invalid("truncated archive: footer is missing");
			rebuildSearch(db);
			const foreign = db.raw.query<{ table: string; parent: string }, []>("PRAGMA foreign_key_check").get();
			if (foreign)
				throw invalid(`archive foreign key violation in table ${foreign.table}, referencing ${foreign.parent}`);
			return { rows, tables: Object.fromEntries(counts) };
		} finally {
			for (const insert of inserts.values()) insert.finalize();
			iterator.return?.();
		}
	});
}

const SearchBody = z.object({
	title: z.string(),
	pre: z.string(),
	steps: z.array(z.object({ action: z.string(), expected: z.string().nullable() })),
});
const Tags = z.array(z.string());

/** Mirrors suite.ts's private indexCase/searchText helpers, including steps whose expected result is null. */
function rebuildSearch(db: Db): void {
	const heads = db.raw.prepare<{ id: string; project: string; tags: string; body: string | null }, []>(`
		SELECT CAST(c.id AS TEXT) AS id, CAST(c.project AS TEXT) AS project, c.tags, v.body
		FROM cases c LEFT JOIN versions v ON v.case_id = c.id AND v.no = c.head ORDER BY c.id
	`);
	const insert = db.raw.prepare<unknown, [bigint, string, string, string, bigint]>(
		"INSERT INTO search_docs (rowid, title, body, tags, project) VALUES (?, ?, ?, ?, ?)",
	);
	try {
		for (const row of heads.iterate()) {
			if (row.body === null) throw invalid(`case ${row.id} has no head version; cannot rebuild search`);
			try {
				const body = SearchBody.parse(JSON.parse(row.body));
				const tags = Tags.parse(JSON.parse(row.tags));
				const text = [
					body.pre,
					...body.steps.map((step) => (step.expected ? `${step.action}\n${step.expected}` : step.action)),
				].join("\n");
				insert.run(BigInt(row.id), body.title, text, tags.join(" "), BigInt(row.project));
			} catch (error) {
				throw invalid(
					`cannot rebuild search for case ${row.id}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	} finally {
		heads.finalize();
		insert.finalize();
	}
}

/**
 * Empties an instance that holds nothing but what first start put there, so an archive can take its place.
 * `start()` creates the project `scratch` before it listens; only that untouched project may be replaced. Anything
 * else (another project, a command that ran, another actor, a changed policy) is refused: an import never
 * overwrites work.
 */
export function removeBootstrap(db: Db): void {
	const projects = z
		.array(z.object({ key: z.string(), name: z.string(), seq: z.number() }))
		.parse(db.raw.query("SELECT key, name, seq FROM projects").all());
	if (projects.length === 0) return;
	const first = projects[0];
	const count = (query: string): number => z.object({ n: z.number() }).parse(db.raw.query(query).get()).n;
	if (
		projects.length !== 1 ||
		!first ||
		first.key !== "scratch" ||
		first.name !== "scratch" ||
		first.seq !== 1 ||
		count("SELECT count(*) AS n FROM commands") !== 0 ||
		count("SELECT count(*) AS n FROM actors") !== 2 ||
		count("SELECT count(*) AS n FROM policies WHERE version <> 1 OR preset <> 'loose'") !== 0
	) {
		throw new OpError("conflict", "import needs a fresh instance; existing projects or user data will not be replaced");
	}
	db.raw.exec("DELETE FROM policies; DELETE FROM folders; DELETE FROM projects");
}

/** Splits LF-delimited text lazily, retaining blank lines and CR bytes. A final LF creates no extra line. */
export function* linesOf(text: string): Iterable<string> {
	let start = 0;
	for (let end = text.indexOf("\n", start); end !== -1; end = text.indexOf("\n", start)) {
		yield text.slice(start, end);
		start = end + 1;
	}
	if (start < text.length) yield text.slice(start);
}

/**
 * Decodes UTF-8 incrementally and yields LF-delimited lines with the same byte-preserving rules as linesOf.
 * Invalid UTF-8 is an error. Memory is bounded by the current line plus a chunk; the reader lock is always released.
 */
export async function* linesOfStream(stream: ReadableStream<Uint8Array>): AsyncIterable<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
	let pending = "";
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) {
				pending += decoder.decode();
				if (pending.length > 0) yield pending;
				return;
			}
			pending += decoder.decode(chunk.value, { stream: true });
			let start = 0;
			for (let end = pending.indexOf("\n", start); end !== -1; end = pending.indexOf("\n", start)) {
				yield pending.slice(start, end);
				start = end + 1;
			}
			pending = pending.slice(start);
		}
	} finally {
		reader.releaseLock();
	}
}
