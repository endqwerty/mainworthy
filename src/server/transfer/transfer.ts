import { createHash } from "node:crypto";
import { z } from "zod";
import { Attachment, AttachmentData } from "../../core/attachments.ts";
import { Policy } from "../../core/kinds.ts";
import { CaseBody } from "../../core/model.ts";
import { ResultIn, resultDuration } from "../../core/ops.ts";
import { policyProblem, storedPolicy } from "../../core/presets.ts";
import { readSubject } from "../decisions/questions.ts";
import { rebuildAssertionIndexes } from "../evidence/assertions.ts";
import { attachmentType, type BlobStore, blobHash } from "../kernel/blobs.ts";
import { retiredDemos } from "../kernel/ctx.ts";
import { arrayLiteral, isConstraintViolation, type ReadDb, type SqlValue, sql, type WriteDb } from "../kernel/db.ts";
import { OpError } from "../kernel/errors.ts";
import { ARCHIVE_VERSION } from "../kernel/migrate.ts";
import { searchText } from "../suite/suite.ts";

const CHUNK_BYTES = 64 * 1024;
const Count = z.number().int().nonnegative();
const StagedResults = ResultIn.array();
const DataError = z.object({ errno: z.string().startsWith("22") });
const invalidStoredValue = (error: unknown) => isConstraintViolation(error) || DataError.safeParse(error).success;

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
type Table = {
	name: string;
	columns: string[];
	nullable: Set<string>;
	primary: string[];
	parents: string[];
	references: { table: string; from: string }[];
	identities: string[];
	types: Map<string, string>;
};
const LEDGER = ["schema_version", "baseline_hash", "archive_version"];
const Q = {
	project: sql<{ key: string }, { id: number }>("SELECT id FROM projects WHERE key = $key"),
	anyProject: sql<readonly [], { id: number }>("SELECT id FROM projects LIMIT 1"),
	projects: sql<readonly [], { key: string; name: string; seq: number }>("SELECT key, name, seq FROM projects"),
	policy: sql<readonly [], { key: string; preset: string; clauses: string; settings: string }>(
		`SELECT p.key, o.preset, o.clauses, o.settings FROM projects p
 JOIN policies o ON o.project = p.id AND o.version = (SELECT max(version) FROM policies WHERE project = p.id)`,
	),
	heads: sql<readonly [], { id: number; project: number; tags: string; body: string | null }>(
		`SELECT c.id, c.project, c.tags, v.body FROM cases c
 LEFT JOIN versions v ON v.case_id = c.id AND v.no = c.head ORDER BY c.id`,
	),
};

/**
 * The tables an archive never holds. Identity tables keep what lets somebody in. A token's, a session's and an
 * invitation's row holds the hash of a secret; a credential's holds a password's hash or a passkey's public key;
 * `passkey_users` holds the handle a person's passkeys are filed under. An export leaves them out and an import
 * empties them, in this order, so a table comes before the one it refers to. This one list serves both, and
 * `test/architecture.test.ts` holds it to the schema: a table of identity that is neither listed here nor one
 * of the tables an archive is meant to hold fails there.
 *
 * `change_ends` says which changes have ended and records received landings (decision 0022). Its frozen gate
 * observations (`merge_receipts`) stay with this instance too. None travels:
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
	"batch_admissions",
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
	"merge_receipt_heads",
	"merge_receipt_dirty",
	"merge_receipt_members",
	"merge_receipts",
	"merge_receipt_snapshots",
	"merge_receipt_nodes",
	"merge_receipt_payloads",
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
export type ExportedArchive = ArchiveCounts & { sha256: string; warnings: string[] };

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
	return table.name === "meta" ? `WHERE key NOT IN (${LEDGER.map(literal).join(", ")})` : "";
}

async function discoverTables(db: ReadDb, exported = true): Promise<Table[]> {
	const catalog = await db.catalog();
	const tables = new Map<string, Table>();
	for (const table of catalog) {
		if (exported && (UNEXPORTED.includes(table.name) || table.name === "search_docs")) continue;
		tables.set(table.name, {
			name: table.name,
			columns: table.columns
				.filter(
					(column) =>
						column.generated !== "stored" && !(exported && table.name === "actors" && column.name === "auth_version"),
				)
				.map((column) => column.name),
			nullable: new Set(table.columns.filter((column) => column.nullable).map((column) => column.name)),
			primary: [...table.primary],
			parents: [...new Set(table.foreignKeys.map((key) => key.parent))].sort(),
			references: table.foreignKeys.flatMap((key) => key.columns.map((from) => ({ table: key.parent, from }))),
			types: new Map(table.columns.map((column) => [column.name, column.type])),
			identities: table.columns.filter((column) => column.generated === "identity").map((column) => column.name),
		});
	}
	const ordered: Table[] = [];
	const visited = new Set<string>();
	const visit = (name: string): void => {
		if (visited.has(name)) return;
		visited.add(name);
		const table = tables.get(name);
		if (!table) return;
		for (const parent of table.parents) visit(parent);
		ordered.push(table);
	};
	for (const name of [...tables.keys()].sort()) visit(name);
	return ordered;
}

/** Tables whose project is held by a parent rather than their own row. Unknown unscoped tables fail closed. */
const PROJECT_PARENT: Readonly<Record<string, { column: string; table: string }>> = {
	batch_admissions: { column: "batch", table: "batches" },
	merge_receipt_members: { column: "node", table: "merge_receipt_nodes" },
	merge_receipt_dirty: { column: "run", table: "runs" },
	// Drop live capture roots before source rows so invalidation triggers cannot refill the dirty set.
	merge_receipt_heads: { column: "run", table: "runs" },
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

async function projectLiteral(db: ReadDb, key: string): Promise<string> {
	const project = await db.get(Q.project, { key });
	if (!project) throw new OpError("not_found", `project ${key} not found`);
	return String(project.id);
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

async function projectFilters(db: ReadDb, metadata: readonly Table[], key: string): Promise<Map<string, string>> {
	const id = await projectLiteral(db, key);
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
		filters.set(table.name, table.name === "meta" ? "WHERE false" : ownedBy(table, id, "project export"));
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
		`SELECT (s.value->>'by')::bigint FROM decisions d, jsonb_array_elements(d.signers::jsonb) s WHERE d.project = ${id} AND jsonb_typeof(s.value) = 'object'`,
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

/** Streams an archive from the caller's consistent read scope. Stored JSON text stays text. */
export async function exportArchive(
	db: ReadDb,
	write: (chunk: string) => void,
	options: { now?: number; project?: string; blobs?: BlobStore } = {},
): Promise<ExportedArchive> {
	const exportedAt = options.now ?? Date.now();
	if (!Number.isSafeInteger(exportedAt) || exportedAt < 0)
		throw invalid("exportedAt must be a nonnegative integer millisecond timestamp");
	if ((await retiredDemos(db)).some((project) => options.project === undefined || project.key === options.project))
		throw invalid("an instance archive waits for retired demo cleanup; export a live project or finish cleanup first");
	const metadata = await discoverTables(db);
	const filters = options.project === undefined ? null : await projectFilters(db, metadata, options.project);
	const filter = (table: Table): string => filters?.get(table.name) ?? where(table);
	const warnings: string[] = [];
	const countsByTable = new Map<string, number>();
	for (const table of metadata) {
		const timed = table.name === "results" || table.name === "result_tries";
		const durationCheck = timed
			? `, bool_or(duration_ms NOT BETWEEN ${resultDuration.minValue} AND ${resultDuration.maxValue}) AS invalid`
			: "";
		const [counts] = await db.allDynamic<{ count: number; invalid?: boolean | null }>(
			`SELECT count(*) AS count${durationCheck} FROM ${identifier(table.name)} ${filter(table)}`,
		);
		countsByTable.set(table.name, counts?.count ?? 0);
		if (counts?.invalid)
			warnings.push(
				`Archive contains ${table.name}.duration_ms outside the integer range ${resultDuration.minValue} to ${resultDuration.maxValue} ms; this build will refuse to import it. Original values were preserved. See /docs/data#import-into-a-new-instance.`,
			);
	}
	const tables = Object.fromEntries(countsByTable);
	const hash = createHash("sha256");
	let chunk = "";
	let bytes = 0;
	let rows = 0;
	const flush = (): void => {
		if (!chunk.length) return;
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
		const keys = table.primary.length ? table.primary : table.columns;
		const order = keys.map(identifier).join(", ");
		let after: SqlValue[] = [];
		for (;;) {
			const base = filter(table);
			const page = after.length
				? `${base ? " AND" : "WHERE"} (${order}) > (${keys.map((_, i) => `$${i + 1}`).join(", ")})`
				: "";
			const batch = await db.allDynamic<{ json: string }>(
				`SELECT json_build_object(${fields.join(", ")})::text AS json FROM ${identifier(table.name)} ${base} ${page} ORDER BY ${order} LIMIT 1000`,
				after,
			);
			for (const row of batch) {
				row.json = row.json.replace(/"(?:[^"\\]|\\.)*"|\s+/g, (token) => (token.startsWith('"') ? token : ""));
				let blob = "";
				if (table.name === "attachments") {
					const item = Attachment.parse(JSON.parse(row.json));
					const content = options.blobs?.get(item.hash);
					if (!content || content.length !== item.size || attachmentType(content) !== item.type)
						throw invalid(`attachment ${item.id} is missing or damaged; restore its content before exporting`);
					blob = `,"blob":${JSON.stringify(Buffer.from(content).toString("base64"))}`;
				}
				append(`{"t":${JSON.stringify(table.name)},"r":${row.json}${blob}}\n`);
				rows++;
			}
			if (batch.length < 1000) break;
			const last = batch.at(-1);
			if (!last) break;
			const values = jsonMap(Value).parse(parseLine(last.json, rows));
			after = keys.map((key) => values.get(key) ?? null);
		}
	}
	const sha256 = hash.digest("hex");
	append(`${JSON.stringify({ end: true, rows, sha256 })}\n`, false);
	flush();
	return { rows, tables, sha256, warnings };
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

async function importTransaction<T>(
	db: WriteDb,
	fn: () => T | Promise<T>,
	progress: (step: string, ms: number) => void = () => {},
): Promise<T> {
	const began = performance.now();
	try {
		return await db.transaction(() => db.checkedBulk(fn));
	} catch (error) {
		if (invalidStoredValue(error))
			throw invalid(`archive constraint violation: ${error instanceof Error ? error.message : String(error)}`);
		throw error;
	} finally {
		progress("finish transfer transaction", performance.now() - began);
	}
}

/**
 * Replays a format-1 archive into an instance with no projects, preserving all IDs and stored values. The
 * header must name this build's archive version. Missing nullable, non-key columns are filled with NULL, so adding
 * such columns need not change the archive version when NULL preserves the earlier behavior. Every count, digest,
 * column, duration, failure subject, pending result input and foreign key is checked before commit; a failure restores the entire target, including bootstrap rows, sessions and the old
 * search index. Tokens and sessions are discarded on success along with bootstrap identity rows.
 * Migration-owned schema and baseline metadata are retained.
 * Lines exclude the LF separator and retain all other characters, since their bytes determine the digest.
 * Import uses one write transaction, or a savepoint if its caller already owns a write transaction.
 * Deferred foreign keys are checked before it returns. Invalid stored values refuse the archive.
 */
export async function importArchive(
	db: WriteDb,
	lines: Iterable<string>,
	options: { blobs?: BlobStore } = {},
): Promise<ArchiveCounts> {
	return await importTransaction(db, async () => {
		if (await db.get(Q.anyProject)) {
			throw new OpError(
				"conflict",
				"importing into a non-empty instance is not supported yet; use an instance with no projects",
			);
		}
		const metadata = await discoverTables(db);
		const iterator = lines[Symbol.iterator]();
		const pending = new Map<string, Value[][]>();
		const flushRows = async (table: Table): Promise<void> => {
			const batch = pending.get(table.name) ?? [];
			if (!batch.length) return;
			const values = table.columns.map((_, i) => arrayLiteral(batch.map((row) => row[i] ?? null)));
			const arrays = table.columns.map((column, i) => `$${i + 1}::${identifier(table.types.get(column) ?? "text")}[]`);
			try {
				await db.runDynamic(
					`INSERT INTO ${identifier(table.name)} (${table.columns.map(identifier).join(", ")}) SELECT * FROM unnest(${arrays.join(", ")})`,
					values,
				);
			} catch (error) {
				if (invalidStoredValue(error))
					throw invalid(
						`invalid archive row in table ${table.name}: ${error instanceof Error ? error.message : String(error)}`,
					);
				throw error;
			}
			pending.set(table.name, []);
		};
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
			for (const name of UNEXPORTED) await db.runDynamic(`DELETE FROM ${identifier(name)}`);
			await db.runDynamic("DELETE FROM search_docs");
			for (const table of [...metadata].reverse())
				await db.runDynamic(`DELETE FROM ${identifier(table.name)} ${where(table)}`);
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
				if (!table) throw invalid(`unknown or excluded archive table ${entry.t}`);
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
				const duration = entry.r.get("duration_ms");
				if (
					(entry.t === "results" || entry.t === "result_tries") &&
					duration !== null &&
					duration !== undefined &&
					!resultDuration.safeParse(duration).success
				) {
					throw invalid(
						`invalid archive ${entry.t}.duration_ms for row ${entry.r.get("id")} on line ${position}: expected an integer from ${resultDuration.minValue} to ${resultDuration.maxValue} ms`,
					);
				}
				if (entry.t === "questions" && entry.r.get("kind") === "failure") {
					try {
						readSubject({ kind: "failure", subject: z.string().parse(entry.r.get("subject")) });
					} catch {
						throw invalid(
							`invalid archive questions.subject for row ${entry.r.get("id")} on line ${position}: expected a valid failure subject`,
						);
					}
				}
				if (entry.t === "batches" && entry.r.get("state") === "accepted") {
					const stored = entry.r.get("staged");
					const context = `invalid archive batches.staged for row ${entry.r.get("id")} on line ${position}`;
					let staged: unknown;
					try {
						staged = typeof stored === "string" ? JSON.parse(stored) : stored;
					} catch {
						throw invalid(`${context}: invalid JSON`);
					}
					const pending = StagedResults.safeParse(staged);
					if (!pending.success) {
						const issues = pending.error.issues
							.map(({ path, message }) => `${path.join(".") || "results"}: ${message.replace(/[\r\n]+/g, " ")}`)
							.join("; ");
						throw invalid(`${context}: pending results fail result input: ${issues}`);
					}
				}
				if (entry.t === "meta" && LEDGER.includes(z.string().parse(entry.r.get("key"))))
					throw invalid("archive must not overwrite meta.schema_version or other migration metadata");
				const batch = pending.get(table.name) ?? [];
				batch.push(table.columns.map((column) => entry.r.get(column) ?? null));
				pending.set(table.name, batch);
				if (batch.length >= 500) await flushRows(table);
				counts.set(entry.t, (counts.get(entry.t) ?? 0) + 1);
				rows++;
				hash.update(`${next.value}\n`);
			}
			if (!ended) throw invalid("truncated archive: footer is missing");
			for (const table of metadata) await flushRows(table);
			await rebuildSearch(db);
			// Earlier versions are history; the policy in force is what the next report is asked under.
			const current = await db.all(Q.policy);
			for (const row of current) {
				const parsed = Policy.safeParse(storedPolicy(row));
				const problem = parsed.success ? policyProblem(parsed.data) : "policy is not valid";
				if (problem) throw invalid(`archive policy of project ${row.key} is refused: ${problem}`);
			}
			await rebuildAssertionIndexes(db, true);
			await db.exec("SET CONSTRAINTS ALL IMMEDIATE");
			for (const table of await discoverTables(db, false))
				for (const column of table.identities) {
					const [row] = await db.allDynamic<{ next: number }>(
						`SELECT coalesce(max(${identifier(column)}), 0) + 1 AS next FROM ${identifier(table.name)}`,
					);
					if (!row) throw new Error("identity allocation has no next value");
					await db.exec(
						`ALTER TABLE ${identifier(table.name)} ALTER COLUMN ${identifier(column)} RESTART WITH ${row.next}`,
					);
				}
			return { rows, tables: Object.fromEntries(counts) };
		} finally {
			iterator.return?.();
		}
	});
}

const Tags = z.array(z.string());

async function rebuildSearch(db: WriteDb): Promise<void> {
	const rows: [number, string, string, string, number][] = [];
	for (const row of await db.all(Q.heads)) {
		if (row.body === null) throw invalid(`case ${row.id} has no head version; cannot rebuild search`);
		try {
			const body = CaseBody.parse(JSON.parse(row.body));
			const tags = Tags.parse(JSON.parse(row.tags));
			rows.push([row.id, body.title, await searchText(db, row.project, body), tags.join(" "), row.project]);
		} catch (error) {
			throw invalid(
				`cannot rebuild search for case ${row.id}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	for (let start = 0; start < rows.length; start += 500) {
		const batch = rows.slice(start, start + 500);
		const tuples = batch.map((_, i) => `(${[1, 2, 3, 4, 5].map((n) => `$${i * 5 + n}`).join(", ")})`);
		await db.runDynamic(
			`INSERT INTO search_docs (id, title, body, tags, project) VALUES ${tuples.join(", ")}`,
			batch.flat(),
		);
	}
}

/**
 * Empties an instance that holds nothing but what first start put there, so an archive can take its place.
 * `start()` creates the project `scratch` before it listens; only that untouched project may be replaced. Anything
 * else (another project, a command that ran, another actor, a changed policy) is refused: an import never
 * overwrites work.
 */
export async function removeBootstrap(db: WriteDb): Promise<void> {
	const projects = await db.all(Q.projects);
	if (projects.length === 0) return;
	const first = projects[0];
	const count = async (query: string): Promise<number> => (await db.allDynamic<{ n: number }>(query))[0]?.n ?? 0;
	if (
		projects.length !== 1 ||
		!first ||
		first.key !== "scratch" ||
		first.name !== "scratch" ||
		first.seq !== 1 ||
		(await count("SELECT count(*) AS n FROM commands")) !== 0 ||
		(await count("SELECT count(*) AS n FROM actors")) !== 2 ||
		(await count("SELECT count(*) AS n FROM teams")) !== 0 ||
		(await count("SELECT count(*) AS n FROM policies WHERE version <> 1 OR preset <> 'loose'")) !== 0
	) {
		throw new OpError("conflict", "import needs a fresh instance; existing projects or user data will not be replaced");
	}
	// The untouched project may have been made a demo. The mark goes with it: the project an archive puts under
	// the same id is not one.
	await db.exec(
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
export async function removeProject(
	db: WriteDb,
	key: string,
	progress: (step: string, ms: number) => void = () => {},
	validation: "audit" | "deferred" = "audit",
): Promise<ArchiveCounts> {
	if (validation === "deferred" && !db.inTransaction)
		throw new Error("deferred removal needs an enforced deferred transaction");
	const remove = async () => {
		const began = performance.now();
		const id = await projectLiteral(db, key);
		const metadata = await discoverTables(db, false);
		const statements = metadata
			.filter((table) => !INSTANCE_TABLES.includes(table.name))
			.map((table) => ({
				name: table.name,
				parents: table.parents,
				parentOwned: table.name in PROJECT_PARENT,
				rows: `FROM ${identifier(table.name)} ${ownedBy(table, id, "removing a project")}`,
			}))
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
		const countsByTable = new Map<string, number>();
		for (const { name, rows } of statements) {
			const start = performance.now();
			countsByTable.set(name, (await db.allDynamic<{ n: number }>(`SELECT count(*) AS n ${rows}`))[0]?.n ?? 0);
			progress(`count ${name}`, performance.now() - start);
		}
		for (const { name, rows } of ordered) {
			const start = performance.now();
			await db.runDynamic(`DELETE ${rows}`);
			progress(`delete ${name}`, performance.now() - start);
		}
		if (validation === "audit") await db.exec("SET CONSTRAINTS ALL IMMEDIATE");
		const tables = Object.fromEntries(countsByTable);
		return { rows: Object.values(tables).reduce((sum, count) => sum + count, 0), tables };
	};
	return validation === "deferred" ? await db.savepoint(remove) : await importTransaction(db, remove, progress);
}

/**
 * The sequence number of the first write to project `key` after it was made, or null when there was none. Every
 * write stamps the instance's sequence on the rows it leaves (`seq`, `first_seq`, and `rev` where a row records
 * its last change), so the smallest one the project owns is its first write. The policy a project is made with is
 * part of making it, and the project's own row keeps a counter, not a write.
 */
export async function firstWrite(db: ReadDb, key: string): Promise<number | null> {
	const id = await projectLiteral(db, key);
	const parts: string[] = [];
	for (const table of await discoverTables(db, false)) {
		if (table.name === "projects" || INSTANCE_TABLES.includes(table.name)) continue;
		const filter = ownedBy(table, id, "reading a project's first write");
		const made = table.name === "policies" ? " AND version > 1" : "";
		for (const column of table.columns.filter((column) => ["seq", "first_seq", "rev"].includes(column)))
			parts.push(`SELECT min(${identifier(column)}) AS n FROM ${identifier(table.name)} ${filter}${made}`);
	}
	if (!parts.length) return null;
	return (
		(await db.allDynamic<{ n: number | null }>(`SELECT min(n) AS n FROM (${parts.join(" UNION ALL ")}) writes`))[0]
			?.n ?? null
	);
}

type SliceReference = { child: SliceTable; columns: { from: string; to: string }[] };
type SliceTable = {
	name: string;
	keys: string[];
	owned: string | null;
	incoming: SliceReference[];
	parents: string[];
};
async function slicePlan(db: ReadDb): Promise<SliceTable[]> {
	const catalog = await db.catalog();
	const tables = new Map<string, SliceTable>();
	for (const table of catalog) {
		tables.set(table.name, {
			name: table.name,
			keys: [...table.primary],
			owned: INSTANCE_TABLES.includes(table.name)
				? null
				: ownedBy(
						{ name: table.name, columns: table.columns.map((column) => column.name) },
						"$1::bigint",
						"removing a project",
					).slice(6),
			incoming: [],
			parents: table.foreignKeys.map((reference) => reference.parent),
		});
	}
	for (const table of catalog) {
		const child = tables.get(table.name);
		if (!child) continue;
		for (const reference of table.foreignKeys) {
			const parent = tables.get(reference.parent);
			if (!parent) throw invalid(`removing a project cannot resolve references from ${table.name}`);
			parent.incoming.push({
				child,
				columns: reference.columns.map((from, i) => {
					const to = reference.parentColumns[i];
					if (!to) throw invalid(`removing a project cannot resolve reference ${table.name}.${from}`);
					return { from, to };
				}),
			});
		}
	}
	const remaining = new Map([...tables].filter(([, table]) => table.owned !== null));
	const ordered: SliceTable[] = [];
	const visit = (table: SliceTable): void => {
		if (!remaining.delete(table.name)) return;
		for (const child of remaining.values()) {
			if (child.name in PROJECT_PARENT === table.name in PROJECT_PARENT && child.parents.includes(table.name))
				visit(child);
		}
		ordered.push(table);
	};
	for (const table of [...remaining.values()].sort(
		(a, b) => Number(!(a.name in PROJECT_PARENT)) - Number(!(b.name in PROJECT_PARENT)),
	))
		visit(table);
	// Removing live capture roots first prevents later source deletes from refilling dirty buckets.
	ordered.sort((a, b) => Number(b.name === "merge_receipt_heads") - Number(a.name === "merge_receipt_heads"));
	return ordered;
}

function sliceKeys(table: SliceTable, alias = ""): string {
	return `json_build_array(${table.keys.map((key) => `CAST(${alias}${identifier(key)} AS TEXT)`).join(",")})::text`;
}

function sliceIdentity(table: SliceTable, alias = "", first = 2): string {
	return table.keys.map((key, i) => `${alias}${identifier(key)} = $${first + i}`).join(" AND ");
}

/**
 * Removes at most `limit` owned rows, including incoming FK dependants, in an enforced transaction.
 * A caller may supply its transaction to hold authority and project locks. Commit and yield between slices. No persistent cursor or whole-instance audit is
 * needed. Leaf rows go first, so cascades cannot turn a small slice into a large deletion. A bounded incoming
 * closure handles cycles; a larger cycle or a reference from retained data refuses the slice unchanged.
 * The last transaction deletes the demo mark and project together (at most two rows, even for limit=1).
 * `rows` counts deleted owned rows, including the mark and cascades; FTS shadow writes and trigger work are additional.
 */
export async function removeProjectSlice(
	db: WriteDb,
	key: string,
	limit = 128,
): Promise<{ done: boolean; table: string | null; rows: number }> {
	if (!Number.isSafeInteger(limit) || limit < 1)
		throw invalid("project removal slice limit must be a positive safe integer");
	return db.transaction(() =>
		db.checkedBulk(async () => {
			const project = (
				await db.allDynamic<{ id: string }>("SELECT id::text AS id FROM projects WHERE key=$1", [key])
			)[0];
			if (!project) return { done: true, table: null, rows: 0 };
			const tables = await slicePlan(db);
			const ordinary = tables.filter((table) => table.name !== "projects" && table.name !== "demo_projects");
			let blocked: string | null = null;
			for (const table of ordinary) {
				const blockers = table.incoming.map(({ child, columns }) => {
					const matches = columns
						.map(({ from, to }) => `c.${identifier(from)} = ${identifier(table.name)}.${identifier(to)}`)
						.join(" AND ");
					const same =
						child === table
							? ` AND NOT (${table.keys.map((key) => `c.${identifier(key)} = ${identifier(table.name)}.${identifier(key)}`).join(" AND ")})`
							: "";
					return `NOT EXISTS (SELECT 1 FROM ${identifier(child.name)} c WHERE ${matches}${same})`;
				});
				const roots = await db.allDynamic<{ keys: string }>(
					`SELECT ${sliceKeys(table)} AS keys FROM ${identifier(table.name)} WHERE ${table.owned}${blockers.length ? ` AND ${blockers.join(" AND ")}` : ""} LIMIT $2::bigint`,
					[project.id, limit],
				);
				if (roots.length > 0) {
					const identity = `(${table.keys.map(identifier).join(",")})`;
					const selected = roots.map(({ keys }) => z.array(z.string()).parse(JSON.parse(keys)));
					const placeholders = selected
						.map((keys, row) => `(${keys.map((_, i) => `$${2 + row * table.keys.length + i}`).join(",")})`)
						.join(",");
					await db.runDynamic(
						`DELETE FROM ${identifier(table.name)} WHERE ${table.owned} AND ${identity} IN (${placeholders})`,
						[project.id, ...selected.flat()],
					);
					return { done: false, table: table.name, rows: roots.length };
				}
				const root = (
					await db.allDynamic<{ keys: string }>(
						`SELECT ${sliceKeys(table)} AS keys FROM ${identifier(table.name)} WHERE ${table.owned} LIMIT 1`,
						[project.id],
					)
				)[0];
				if (!root) continue;
				const pending = [{ table, keys: z.array(z.string()).parse(JSON.parse(root.keys)) }];
				const included = new Set([`${table.name}:${root.keys}`]);
				let oversized = false;
				for (let at = 0; at < pending.length && !oversized; at++) {
					const row = pending[at];
					if (!row) continue;
					for (const { child, columns } of row.table.incoming) {
						const childColumns = columns.map(({ from }) => `c.${identifier(from)}`).join(",");
						const parentColumns = columns.map(({ to }) => `p.${identifier(to)}`).join(",");
						const dependants = await db.allDynamic<{ keys: string; owned: boolean }>(
							`SELECT ${sliceKeys(child, "c.")} AS keys, (${child.owned ?? "FALSE"}) AS owned FROM ${identifier(child.name)} c WHERE (${childColumns}) IN (SELECT ${parentColumns} FROM ${identifier(row.table.name)} p WHERE (${row.table.owned}) AND ${sliceIdentity(row.table, "p.")}) LIMIT ${limit + 1}`,
							[project.id, ...row.keys],
						);
						for (const dependant of dependants) {
							if (!dependant.owned || child.name === "projects" || child.name === "demo_projects")
								throw invalid(`removing project ${key} would affect retained rows in ${child.name}`);
							const identity = `${child.name}:${dependant.keys}`;
							if (included.has(identity)) continue;
							included.add(identity);
							pending.push({ table: child, keys: z.array(z.string()).parse(JSON.parse(dependant.keys)) });
							if (pending.length > limit) {
								oversized = true;
								break;
							}
						}
						if (oversized) break;
					}
				}
				if (oversized) {
					blocked = table.name;
					continue;
				}
				for (const row of pending.reverse())
					await db.runDynamic(
						`DELETE FROM ${identifier(row.table.name)} WHERE ${sliceIdentity(row.table, "", 1)}`,
						row.keys,
					);
				return { done: false, table: table.name, rows: pending.length };
			}
			if (blocked)
				throw invalid(`removing project ${key} needs a dependency closure above the bounded slice limit in ${blocked}`);
			for (const table of tables.filter((item) => item.name === "projects" || item.name === "demo_projects")) {
				for (const { child, columns } of table.incoming) {
					if (child.name === "demo_projects") continue;
					const from = columns.map((column) => identifier(column.from)).join(",");
					const to = columns.map((column) => identifier(column.to)).join(",");
					if (
						(
							await db.allDynamic(
								`SELECT 1 FROM ${identifier(child.name)} WHERE (${from}) IN (SELECT ${to} FROM ${identifier(table.name)} WHERE ${table.owned}) LIMIT 1`,
								[project.id],
							)
						)[0]
					)
						throw invalid(`removing project ${key} would affect retained rows in ${child.name}`);
				}
			}
			let rows = (await db.runDynamic("DELETE FROM demo_projects WHERE project=$1", [project.id])).changes;
			rows += (await db.runDynamic("DELETE FROM projects WHERE id=$1", [project.id])).changes;
			return { done: true, table: "projects", rows };
		}),
	);
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
