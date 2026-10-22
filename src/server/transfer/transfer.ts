import { createHash } from "node:crypto";
import { z } from "zod";
import { Attachment, AttachmentData } from "../../core/attachments.ts";
import { Policy } from "../../core/kinds.ts";
import { CaseBody } from "../../core/model.ts";
import { policyProblem, storedPolicy } from "../../core/presets.ts";
import { rebuildAssertionIndexes } from "../evidence/assertions.ts";
import { attachmentType, type BlobStore, blobHash } from "../kernel/blobs.ts";
import type { Db } from "../kernel/db.ts";
import { OpError } from "../kernel/errors.ts";
import { ARCHIVE_VERSION } from "../kernel/migrate.ts";
import { searchText } from "../suite/suite.ts";

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
	z.strictObject({ t: z.string(), r: jsonMap(Value), blob: z.string().optional() }),
	z.strictObject({ end: z.literal(true), rows: Count, sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
]);
type Value = z.infer<typeof Value>;
type Header = z.infer<typeof Header>;
const TableName = z.object({ name: z.string() });
const TableKind = z.object({ schema: z.string(), name: z.string(), type: z.string() });
const Column = z.object({ name: z.string(), pk: Count, notnull: Count });
const ForeignKey = z.object({ table: z.string(), from: z.string() });
const ConstraintError = z.object({ code: z.string().startsWith("SQLITE_CONSTRAINT"), message: z.string() });
type Table = {
	name: string;
	columns: string[];
	nullable: Set<string>;
	primary: string[];
	parents: string[];
	references: z.infer<typeof ForeignKey>[];
};

/**
 * The tables an archive never holds. Identity tables keep what lets somebody in. A token's, a session's and an
 * invitation's row holds the hash of a secret; a credential's holds a password's hash or a passkey's public key;
 * `passkey_users` holds the handle a person's passkeys are filed under. An export leaves them out and an import
 * empties them, in this order, so a table comes before the one it refers to. This one list serves both, and
 * `test/architecture.test.ts` holds it to the schema: a table of identity that is neither listed here nor one
 * of the tables an archive is meant to hold fails there.
 *
 * `change_ends` says which changes have ended and records received landings (decision 0022). Neither travels:
 * a change that arrives in an archive is open, and the questions that were closed when it ended stay closed.
 * `demo_projects` is the leave to date a write (decision 0100), and it does not travel either: a project that
 * arrives in an archive takes the server's clock from then on, whatever it was where it came from. Exported, either
 * table would raise the archive version and refuse every archive taken before it.
 * `tracker_requests` is delivery state for this instance only. Importing it must never send an issue again.
 * Tracker credentials are process configuration and never enter a table or archive.
 * `scope_moves` is also omitted: targets and runs carry the resulting scope, but an import loses the move audit
 * trail (decision 0038). Keeping it out lets older archives import without a format change.
 * `handoffs` is delivery state too: importing it must never start an agent again.
 * `commit_statuses` holds GitHub commit status enrollment and delivery state. An import must not enroll historical commits.
 */
export const UNEXPORTED: readonly string[] = [
	"assertion_seen",
	"assertion_spreads",
	"assertion_roots",
	"assertion_index",
	"slot_leases",
	"sessions",
	"credentials",
	"invitations",
	"passkey_users",
	"tokens",
	"change_ends",
	"tracker_requests",
	"tracker_polls",
	"scope_moves",
	"demo_projects",
	"commit_statuses",
	"commit_status_delivery",
	"handoffs",
];

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
			nullable: new Set(
				columns.filter((column) => column.notnull === 0 && column.pk === 0).map((column) => column.name),
			),
			primary: columns
				.filter((column) => column.pk > 0)
				.sort((a, b) => a.pk - b.pk)
				.map((column) => column.name),
			parents: [...new Set(foreignKeys.map((foreign) => foreign.table))].sort(),
			references: foreignKeys,
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

/** Tables whose project is held by a parent rather than their own row. Unknown unscoped tables fail closed. */
const PROJECT_PARENT: Readonly<Record<string, { column: string; table: string }>> = {
	attachments: { column: "result", table: "results" },
	answers: { column: "question", table: "questions" },
	versions: { column: "case_id", table: "cases" },
	placements: { column: "case_id", table: "cases" },
	covers: { column: "requirement", table: "requirements" },
	run_tests: { column: "run", table: "runs" },
	slots: { column: "run", table: "runs" },
	slot_leases: { column: "slot", table: "slots" },
	slot_results: { column: "run", table: "runs" },
	depends_on: { column: "run", table: "runs" },
	result_excuses: { column: "result", table: "results" },
	// Not in an archive (`UNEXPORTED`), and still the project's: `removeProject` deletes it with its change.
	change_ends: { column: "change", table: "changes" },
	// Not in an archive either: when to ask a tracker again about the issue a decision names. It goes with it.
	tracker_polls: { column: "decision", table: "decisions" },
};

/**
 * Tables that belong to no project: the instance's metadata, who people are and how they sign in, and the teams
 * they are in. Removing a project leaves them; its grants, a team's included, are a project's and go with it.
 */
const INSTANCE_TABLES = [
	"meta",
	"orgs",
	"actors",
	"tokens",
	"sessions",
	"credentials",
	"invitations",
	"passkey_users",
	// A person's recovery address: removing a project does not touch how its people sign in.
	"mail_contacts",
	// A team spans projects: its grant on this project and its events about it go, the team and its members stay.
	"teams",
	"team_members",
	// When the instance may post to GitHub again: one row for every project. A project's statuses go with it.
	"commit_status_delivery",
];

/**
 * The project's ID as an SQL expression: read as text, since SQLite IDs need not fit in a JavaScript number, and
 * cast back to an integer, since a column of the search index has no type to convert the text to.
 */
function projectLiteral(db: Db, key: string): string {
	const project = db.raw
		.query<{ id: string }, [string]>("SELECT CAST(id AS TEXT) AS id FROM projects WHERE key = ?")
		.get(key);
	if (!project) throw new OpError("not_found", `project ${key} not found`);
	return `CAST(${literal(project.id)} AS INTEGER)`;
}

/** The rows of `table` that project `id` owns, as a WHERE clause; it throws for a table with no rule. */
function ownedBy(table: { name: string; columns: string[] }, id: string, what: string): string {
	if (table.name === "projects") return `WHERE id = ${id}`;
	if (table.columns.includes("project")) return `WHERE project = ${id}`;
	const parent = PROJECT_PARENT[table.name];
	if (!parent) throw invalid(`${what} has no ownership rule for table ${table.name}`);
	const filter = PROJECT_PARENT[parent.table]
		? ownedBy({ name: parent.table, columns: [] }, id, what)
		: `WHERE project = ${id}`;
	return `WHERE ${identifier(parent.column)} IN (SELECT id FROM ${identifier(parent.table)} ${filter})`;
}

function projectFilters(db: Db, metadata: readonly Table[], key: string): Map<string, string> {
	const id = projectLiteral(db, key);
	const teams = `SELECT team FROM team_grants WHERE project IN (0, ${id}) UNION SELECT team FROM team_events WHERE project IN (0, ${id})`;
	const filters = new Map<string, string>([
		["teams", `WHERE id IN (${teams})`],
		["team_members", `WHERE team IN (${teams})`],
		["team_grants", `WHERE team IN (${teams}) AND project IN (0, ${id})`],
		["team_events", `WHERE team IN (${teams}) AND (project IS NULL OR project IN (0, ${id}))`],
	]);
	for (const table of metadata) {
		if (filters.has(table.name)) continue;
		if (["actors", "orgs", "grants", "mail_contacts"].includes(table.name)) continue;
		filters.set(table.name, table.name === "meta" ? "WHERE 0" : ownedBy(table, id, "project export"));
	}
	// Declared actor references plus the schema's intentional non-FK references. Keep actors who have access,
	// even if they have not yet acted, and follow on_behalf_of so historical delegation still has its person.
	const implicit: Readonly<Record<string, string>> = {
		commands: "actor",
		policies: "actor",
		results: "actor",
		questions: "owner",
		runs: "created_by",
	};
	const actors = [
		`SELECT actor FROM grants WHERE project IN (0, ${id})`,
		`SELECT id FROM actors WHERE kind = 'rule' AND org IN (SELECT org FROM projects WHERE id = ${id})`,
	];
	for (const table of metadata) {
		const filter = filters.get(table.name);
		if (!filter || table.name === "meta") continue;
		const columns = new Set(table.references.filter((ref) => ref.table === "actors").map((ref) => ref.from));
		const extra = implicit[table.name];
		if (extra) columns.add(extra);
		for (const column of columns) actors.push(`SELECT ${identifier(column)} FROM ${identifier(table.name)} ${filter}`);
	}
	actors.push(
		`SELECT json_extract(s.value, '$.by') FROM decisions d, json_each(d.signers) s WHERE d.project = ${id} AND s.type = 'object'`,
	);
	const included = `WITH RECURSIVE included(id) AS (${actors.join(" UNION ")} UNION SELECT a.on_behalf_of FROM actors a JOIN included i ON a.id = i.id WHERE a.on_behalf_of IS NOT NULL) SELECT id FROM included`;
	filters.set("actors", `WHERE id IN (${included})`);
	filters.set("mail_contacts", `WHERE actor IN (${included})`);
	filters.set(
		"orgs",
		`WHERE id IN (SELECT org FROM projects WHERE id = ${id} UNION SELECT org FROM actors WHERE id IN (${included}))`,
	);
	filters.set("grants", `WHERE project IN (0, ${id}) AND actor IN (${included})`);
	return filters;
}

/**
 * Streams a migrated instance, or one project and its referenced identity, inside one consistent read snapshot.
 * Rows follow primary keys;
 * JSON-typed TEXT remains text, and SQLite serializes integers exactly, including values outside JS's safe range.
 * Tokens, sessions, passwords, passkeys and invitations never travel (`UNEXPORTED`). The FTS index is omitted and
 * rebuilt during import. The header names the archive version, not the schema version (`ARCHIVE_VERSION`).
 * Invalid UTF-8 in stored TEXT is refused because replacing bytes would make the archive lossy.
 * Chunks contain whole lines and are at most about 64 KiB, except for a single larger row. The synchronous
 * writer must not mutate this database connection. A writer failure propagates and releases the snapshot.
 */
export function exportArchive(
	db: Db,
	write: (chunk: string) => void,
	options: { now?: number; project?: string; blobs?: BlobStore } = {},
): ExportedArchive {
	const exportedAt = options.now ?? Date.now();
	if (!Number.isSafeInteger(exportedAt) || exportedAt < 0)
		throw invalid("exportedAt must be a nonnegative integer millisecond timestamp");
	return db.snapshot(() => {
		const metadata = discoverTables(db);
		const filters = options.project === undefined ? null : projectFilters(db, metadata, options.project);
		const filter = (table: Table): string => filters?.get(table.name) ?? where(table);
		const tables = Object.fromEntries(
			metadata.map((table) => [
				table.name,
				db.raw
					.query<{ count: number }, []>(`SELECT count(*) AS count FROM ${identifier(table.name)} ${filter(table)}`)
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
				`SELECT CAST(json_object(${fields.join(", ")}) AS BLOB) AS json FROM ${identifier(table.name)} ${filter(table)} ORDER BY ${order}`,
			);
			try {
				for (const row of statement.iterate()) {
					let json: string;
					try {
						json = decoder.decode(row.json);
					} catch {
						throw invalid(`cannot export table ${table.name} losslessly: stored TEXT contains invalid UTF-8`);
					}
					let blob = "";
					if (table.name === "attachments") {
						const item = Attachment.parse(JSON.parse(json));
						const bytes = options.blobs?.get(item.hash);
						if (!bytes || bytes.length !== item.size || attachmentType(bytes) !== item.type)
							throw invalid(`attachment ${item.id} is missing or damaged; restore its content before exporting`);
						blob = `,"blob":${JSON.stringify(Buffer.from(bytes).toString("base64"))}`;
					}
					append(`{"t":${JSON.stringify(table.name)},"r":${json}${blob}}\n`);
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

function importTransaction<T>(db: Db, fn: () => T, progress: (step: string, ms: number) => void = () => {}): T {
	const checking = performance.now();
	const deferred =
		db.raw.query<{ defer_foreign_keys: number }, []>("PRAGMA defer_foreign_keys").get()?.defer_foreign_keys ?? 0;
	try {
		if (db.raw.inTransaction && deferred === 0 && db.raw.query("PRAGMA foreign_key_check").get()) {
			throw new OpError(
				"conflict",
				"the caller has pending foreign key violations; resolve them before importing or removing a project",
			);
		}
	} finally {
		progress("check pending foreign keys", performance.now() - checking);
	}
	let finishing = performance.now();
	try {
		return db.checkedBulk(() => {
			try {
				return fn();
			} finally {
				finishing = performance.now();
			}
		});
	} finally {
		// Restore only after a failing savepoint has rolled back its pending references.
		if (db.raw.inTransaction) {
			const current = db.raw.query<{ defer_foreign_keys: number }, []>("PRAGMA defer_foreign_keys").get();
			if (current?.defer_foreign_keys !== deferred) db.raw.exec(`PRAGMA defer_foreign_keys = ${deferred}`);
		}
		progress("finish transfer transaction", performance.now() - finishing);
	}
}

/**
 * Replays a format-1 archive into an instance with no projects, preserving all IDs and stored values. The
 * header must name this build's archive version. Missing nullable, non-key columns are filled with NULL, so adding
 * such columns need not change the archive version when NULL preserves the earlier behavior. Every count, digest,
 * column and foreign key is checked before commit; a failure restores the entire target, including bootstrap rows, sessions and the old
 * search index. Tokens and sessions are discarded on success along with bootstrap identity rows.
 * Migration-owned schema_version is retained.
 * Lines exclude the LF separator and retain all other characters, since their bytes determine the digest.
 * Import uses one write transaction, or a savepoint if its caller already owns a write transaction, restoring
 * the caller's foreign-key deferral setting. Archived rows violating SQLite constraints are invalid operations.
 * A caller with pending deferred constraints and global deferral off must resolve those references first,
 * because restoring that PRAGMA would otherwise discard its pending constraint checks.
 */
export function importArchive(db: Db, lines: Iterable<string>, options: { blobs?: BlobStore } = {}): ArchiveCounts {
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
				if (entry.t === "attachments") {
					const item = Attachment.safeParse(Object.fromEntries(entry.r));
					const content = AttachmentData.safeParse(entry.blob);
					if (!item.success || !content.success || !options.blobs)
						throw invalid("archive attachment metadata, content or storage is missing or invalid");
					const bytes = Buffer.from(content.data, "base64");
					if (
						bytes.length !== item.data.size ||
						blobHash(bytes) !== item.data.hash ||
						attachmentType(bytes) !== item.data.type
					)
						throw invalid("archive attachment does not match its hash, size or content type");
					options.blobs.put(bytes);
				} else if (entry.blob !== undefined) throw invalid("only an attachment row may carry blob content");
				const columns = new Set(table.columns);
				for (const column of entry.r.keys()) {
					if (!columns.has(column)) throw invalid(`unknown column ${entry.t}.${column}`);
				}
				for (const column of table.columns) {
					if (!entry.r.has(column) && !table.nullable.has(column)) throw invalid(`missing column ${entry.t}.${column}`);
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
			// Earlier versions are history; the policy in force is what the next report is asked under.
			const current = db.raw.query<{ key: string; preset: string; clauses: string; settings: string }, []>(
				`SELECT p.key, o.preset, o.clauses, o.settings FROM projects p
				 JOIN policies o ON o.project = p.id AND o.version = (SELECT max(version) FROM policies WHERE project = p.id)`,
			);
			for (const row of current.all()) {
				const parsed = Policy.safeParse(storedPolicy(row));
				const problem = parsed.success ? policyProblem(parsed.data) : "policy is not valid";
				if (problem) throw invalid(`archive policy of project ${row.key} is refused: ${problem}`);
			}
			const foreign = db.raw.query<{ table: string; parent: string }, []>("PRAGMA foreign_key_check").get();
			if (foreign)
				throw invalid(`archive foreign key violation in table ${foreign.table}, referencing ${foreign.parent}`);
			rebuildAssertionIndexes(db, true);
			return { rows, tables: Object.fromEntries(counts) };
		} finally {
			for (const insert of inserts.values()) insert.finalize();
			iterator.return?.();
		}
	});
}

const Tags = z.array(z.string());

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
				const body = CaseBody.parse(JSON.parse(row.body));
				const tags = Tags.parse(JSON.parse(row.tags));
				const text = searchText(db, Number(row.project), body);
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
		count("SELECT count(*) AS n FROM teams") !== 0 ||
		count("SELECT count(*) AS n FROM policies WHERE version <> 1 OR preset <> 'loose'") !== 0
	) {
		throw new OpError("conflict", "import needs a fresh instance; existing projects or user data will not be replaced");
	}
	// The untouched project may have been made a demo. The mark goes with it: the project an archive puts under
	// the same id is not one.
	db.exec(
		"DELETE FROM assertion_seen; DELETE FROM assertion_spreads; DELETE FROM assertion_roots; DELETE FROM assertion_index; DELETE FROM demo_projects; DELETE FROM policies; DELETE FROM folders; DELETE FROM projects",
	);
}

/**
 * Deletes project `key` and everything that is its own, in one transaction: the rows a project export selects,
 * the grants on it, its search index, its tracker requests and the ends of its changes. Who people are stays,
 * and so does every other project. The files of its attachments stay on disk until the next start prunes the ones
 * no row names (`start`). The project's key is free afterwards, and a project made under it starts empty.
 * A table with no ownership rule refuses the removal before a row goes, as it refuses a project export.
 *
 * No operation offers this. `mainworthy serve` calls it for the demo it seeds again (`MAINWORTHY_DEMO`, in
 * `src/cli/demo.ts`), and only for a project `mainworthy seed` made.
 */
export function removeProject(
	db: Db,
	key: string,
	progress: (step: string, ms: number) => void = () => {},
	validation: "audit" | "deferred" = "audit",
): ArchiveCounts {
	if (
		validation === "deferred" &&
		(!db.raw.inTransaction ||
			db.raw.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()?.foreign_keys !== 1 ||
			db.raw.query<{ defer_foreign_keys: number }, []>("PRAGMA defer_foreign_keys").get()?.defer_foreign_keys !== 1)
	)
		throw new Error("deferred removal needs an enforced deferred transaction");
	const remove = () => {
		const began = performance.now();
		const id = projectLiteral(db, key);
		const shadow = new Set(
			TableKind.array()
				.parse(db.raw.query("PRAGMA table_list").all())
				.filter((table) => table.type === "shadow")
				.map((table) => table.name),
		);
		const statements = TableName.array()
			.parse(db.raw.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all())
			.map((table) => table.name)
			.filter((name) => !name.startsWith("sqlite_") && !shadow.has(name) && !INSTANCE_TABLES.includes(name))
			.map((name) => {
				const columns = Column.array()
					.parse(db.raw.query(`PRAGMA table_info(${identifier(name)})`).all())
					.map((column) => column.name);
				const parents = ForeignKey.array()
					.parse(db.raw.query(`PRAGMA foreign_key_list(${identifier(name)})`).all())
					.map((key) => key.table);
				return {
					name,
					parents,
					parentOwned: name in PROJECT_PARENT,
					rows: `FROM ${identifier(name)} ${ownedBy({ name, columns }, id, "removing a project")}`,
				};
			})
			// A table that finds its rows through a parent goes first, while the parent's rows are still there.
			.sort((a, b) => Number(!a.parentOwned) - Number(!b.parentOwned));
		const remaining = new Map(statements.map((statement) => [statement.name, statement]));
		const ordered: typeof statements = [];
		const visit = (statement: (typeof statements)[number]): void => {
			if (!remaining.delete(statement.name)) return;
			for (const child of remaining.values()) {
				// Ownership filters still need their parents. Within each group, children precede parents;
				// self references and cycles are covered by the final foreign-key check.
				if (child.parentOwned === statement.parentOwned && child.parents.includes(statement.name)) visit(child);
			}
			ordered.push(statement);
		};
		for (const statement of statements) visit(statement);
		progress("discover tables", performance.now() - began);
		// Counted before any row goes: a delete can take rows of another table with it (ON DELETE CASCADE).
		const tables = Object.fromEntries(
			statements.map(({ name, rows }) => {
				const start = performance.now();
				const n = db.raw.query<{ n: number }, []>(`SELECT count(*) AS n ${rows}`).get()?.n ?? 0;
				progress(`count ${name}`, performance.now() - start);
				return [name, n];
			}),
		);
		db.raw.exec("PRAGMA defer_foreign_keys = ON");
		for (const { name, rows } of ordered) {
			const start = performance.now();
			db.raw.exec(`DELETE ${rows}`);
			progress(`delete ${name}`, performance.now() - start);
		}
		const checking = performance.now();
		const foreign =
			validation === "audit"
				? db.raw.query<{ table: string; parent: string }, []>("PRAGMA foreign_key_check").get()
				: null;
		if (validation === "audit") progress("check foreign keys", performance.now() - checking);
		if (foreign)
			throw new OpError(
				"internal",
				`removing project ${key} left rows in ${foreign.table} that refer to ${foreign.parent}`,
			);
		return { rows: Object.values(tables).reduce((sum, count) => sum + count, 0), tables };
	};
	return validation === "deferred" ? db.savepoint(remove) : importTransaction(db, remove, progress);
}

/**
 * The sequence number of the first write to project `key` after it was made, or null when there was none. Every
 * write stamps the instance's sequence on the rows it leaves (`seq`, `first_seq`, and `rev` where a row records
 * its last change), so the smallest one the project owns is its first write. The policy a project is made with is
 * part of making it, and the project's own row keeps a counter, not a write.
 */
export function firstWrite(db: Db, key: string): number | null {
	const id = projectLiteral(db, key);
	const shadow = new Set(
		TableKind.array()
			.parse(db.raw.query("PRAGMA table_list").all())
			.filter((table) => table.type !== "table")
			.map((table) => table.name),
	);
	let first: number | null = null;
	const names = TableName.array()
		.parse(db.raw.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all())
		.map((table) => table.name)
		.filter((name) => !name.startsWith("sqlite_") && !shadow.has(name) && !INSTANCE_TABLES.includes(name));
	for (const name of names) {
		if (name === "projects") continue;
		const columns = Column.array()
			.parse(db.raw.query(`PRAGMA table_info(${identifier(name)})`).all())
			.map((column) => column.name);
		const where = ownedBy({ name, columns }, id, "reading a project's first write");
		const made = name === "policies" ? " AND version > 1" : "";
		for (const column of columns.filter((column) => ["seq", "first_seq", "rev"].includes(column))) {
			const row = db.raw
				.query<{ n: number | null }, []>(
					`SELECT min(${identifier(column)}) AS n FROM ${identifier(name)} ${where}${made}`,
				)
				.get();
			if (row?.n != null && (first === null || row.n < first)) first = row.n;
		}
	}
	return first;
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
