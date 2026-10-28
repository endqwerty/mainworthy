import { createHash } from "node:crypto";
import { z } from "zod";
import { Attachment, AttachmentData } from "../../core/attachments.ts";
import { claimHash, versionHash } from "../../core/hash.ts";
import { Policy } from "../../core/kinds.ts";
import { CaseBody } from "../../core/model.ts";
import { ResultIn, resultDuration } from "../../core/ops.ts";
import { policyProblem, storedPolicy } from "../../core/presets.ts";
import { MAX_OBLIGATIONS, Obligation } from "../../core/runs.ts";
import { readSubject } from "../decisions/questions.ts";
import { rebuildAssertionIndexes } from "../evidence/assertions.ts";
import { restoreReportMapJobs } from "../evidence/report-maps.ts";
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
	missingSlotVersion: sql<readonly [], { id: number; case_id: number; version: number }>(
		`SELECT s.id, s.case_id, s.version FROM slots s
 LEFT JOIN versions v ON v.case_id = s.case_id AND v.no = s.version
 WHERE v.case_id IS NULL LIMIT 1`,
	),
	invalidCorrection: sql<readonly [], { id: number; corrects: number }>(
		`SELECT r.id, r.corrects FROM results r LEFT JOIN results earlier ON earlier.id = r.corrects
 WHERE r.corrects IS NOT NULL AND (earlier.id IS NULL OR earlier.project <> r.project
 OR earlier.test <> r.test OR earlier.actor <> r.actor) LIMIT 1`,
	),
	invalidHeadHash: sql<readonly [], { id: number; head: number; column: "head_hash" | "claim_hash" }>(
		`SELECT c.id, c.head, CASE WHEN c.head_hash IS DISTINCT FROM v.hash THEN 'head_hash' ELSE 'claim_hash' END AS column
 FROM cases c JOIN versions v ON v.case_id = c.id AND v.no = c.head
 WHERE c.head_hash IS DISTINCT FROM v.hash OR c.claim_hash IS DISTINCT FROM v.claim_hash LIMIT 1`,
	),
	heads: sql<readonly [], { id: number; project: number; tags: string; body: string | null }>(
		`SELECT c.id, c.project, c.tags, v.body FROM cases c
 LEFT JOIN versions v ON v.case_id = c.id AND v.no = c.head ORDER BY c.id`,
	),
};

/**
 * The tables an archive never holds. Identity tables keep what lets somebody in. A token's, a session's and an
 * invitation's row holds the hash of a secret; a credential's holds who a person is at the identity provider.
 * An export leaves them out and an import
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
	"background_jobs",
	"blob_objects",
	"batch_admissions",
	"identity_ceremonies",
	"identity_ceremony_epoch",
	"identity_limits",
	"identity_starts",
	"change_events",
	"assertion_seen",
	"assertion_spreads",
	"assertion_roots",
	"assertion_index",
	"slot_leases",
	"sessions",
	"credentials",
	"invitations",
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
	"identity_ceremonies",
	"identity_ceremony_epoch",
	"identity_limits",
	"identity_starts",
	"background_jobs",
	"blob_objects",

	"meta",
	"orgs",
	"actors",
	"tokens",
	"sessions",
	"credentials",
	"invitations",
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
		if (["actors", "orgs", "grants"].includes(table.name)) continue;
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
					const content = await options.blobs?.get(item.hash);
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
			for (const name of UNEXPORTED) {
				if (name === "identity_limits" || name === "identity_starts" || name === "blob_objects") continue;
				await db.runDynamic(`DELETE FROM ${identifier(name)}`);
			}
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
					await options.blobs.put(bytes);
				} else if (entry.blob !== undefined) throw invalid("only an attachment row may carry blob content");
				const columns = new Set(table.columns);
				for (const column of entry.r.keys()) {
					if (!columns.has(column)) throw invalid(`unknown column ${entry.t}.${column}`);
				}
				for (const column of table.columns) {
					if (!entry.r.has(column) && !table.nullable.has(column)) throw invalid(`missing column ${entry.t}.${column}`);
				}
				if (entry.t === "versions") {
					let body: CaseBody;
					try {
						body = CaseBody.parse(JSON.parse(z.string().parse(entry.r.get("body"))));
						entry.r.set("methods", JSON.stringify([...new Set(body.methods)]));
					} catch {
						throw invalid(
							`invalid archive versions.body for row (case_id ${entry.r.get("case_id")}, no ${entry.r.get("no")}) on line ${position}: expected a valid CaseBody`,
						);
					}
					for (const [column, computed] of Object.entries({ hash: versionHash(body), claim_hash: claimHash(body) })) {
						if (entry.r.get(column) !== computed)
							throw invalid(
								`invalid archive versions.${column} for row (case_id ${entry.r.get("case_id")}, no ${entry.r.get("no")}) on line ${position}: case body hash mismatch`,
							);
					}
				}
				if (entry.t === "runs") {
					try {
						z.array(Obligation)
							.max(MAX_OBLIGATIONS)
							.parse(JSON.parse(z.string().parse(entry.r.get("require"))));
					} catch {
						throw invalid(
							`invalid archive runs.require on line ${position}: obligation or job limit exceeded, or invalid obligation`,
						);
					}
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
			const missingPin = await db.get(Q.missingSlotVersion);
			if (missingPin)
				throw invalid(
					`invalid archive slots for row ${missingPin.id}: case_id ${missingPin.case_id}, version ${missingPin.version} has no matching versions row`,
				);
			const correction = await db.get(Q.invalidCorrection);
			if (correction)
				throw invalid(
					`invalid archive results.corrects for row ${correction.id}: result ${correction.corrects} must exist with the same project, test and actor`,
				);
			const head = await db.get(Q.invalidHeadHash);
			if (head)
				throw invalid(
					`invalid archive cases.${head.column} for row ${head.id}: does not match head version ${head.head}`,
				);
			await rebuildSearch(db);
			// Earlier versions are history; the policy in force is what the next report is asked under.
			const current = await db.all(Q.policy);
			for (const row of current) {
				const parsed = Policy.safeParse(storedPolicy(row));
				const problem = parsed.success ? policyProblem(parsed.data) : "policy is not valid";
				if (problem) throw invalid(`archive policy of project ${row.key} is refused: ${problem}`);
			}
			await rebuildAssertionIndexes(db, true);
			await restoreReportMapJobs(db);
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
 * and so does every other project. The files of its attachments stay until the age-bounded prune job finds no row naming them. The project's key is free afterwards, and a project made under it starts empty.
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
/**
 * How the project owns a table's rows: by its own row (`projects`), by a `project` column, or through a chain of
 * parents (`PROJECT_PARENT`) that ends in a table with one, the ancestor. Null for a table no project owns.
 */
type SliceOwner =
	| { by: "id" }
	| { by: "project" }
	| { by: "parents"; chain: readonly { column: string; table: string }[] }
	| null;
type SliceTable = {
	name: string;
	keys: string[];
	owner: SliceOwner;
	incoming: SliceReference[];
	parents: string[];
	/**
	 * The nullable columns by which a row of a project-owned table refers to another row of the same table (a
	 * folder's parent, the result a result corrects). A drain sets them to null before it deletes from the table.
	 */
	selfReferences: string[];
	walk: Walk | null;
};
/**
 * What one drain carries from slice to slice: the tables in visiting order, read once (the schema does not change
 * while serving), the tables already found empty for the project being removed, and, for a table owned through its
 * parents, the place in its walk of those parents (`Place`). A slice skips the empty tables, so it reads only the
 * table it deletes from, not every table the project once had; and it reads a parent-owned table under one batch of
 * parents on from where the last slice stopped, at every level of the chain, not from the first parent again (#914).
 * For a table that refers to itself, `unlinked` says how far the drain has set those references to null: the id it
 * has reached, or `true` once it has passed the last row. No table is read again before the project row goes: a
 * retired demo takes no writes (the registry refuses them), so a table the drain emptied stays empty. A row that
 * appears anyway makes the project row's foreign keys refuse its deletion, and the next drain's new plan finds it.
 */
export type RemovalPlan = {
	readonly tables: readonly SliceTable[];
	project: string | null;
	readonly empty: Set<string>;
	readonly after: Map<string, Place>;
	readonly unlinked: Map<string, string | true>;
	/** How many rows of a level a slice reads at once: `PARENTS_PER_SLICE`, or fewer for a test. */
	readonly batch: number;
};
export async function removalPlan(db: ReadDb, batch = PARENTS_PER_SLICE): Promise<RemovalPlan> {
	return {
		tables: await slicePlan(db),
		project: null,
		empty: new Set(),
		after: new Map(),
		unlinked: new Map(),
		batch,
	};
}

/**
 * Planner settings for a slice. Its statements are prepared, and a generic plan expects an average project's rows
 * behind `project = $1`: once the retired project's rows of a table were gone, `LIMIT 1` scanned every other
 * project's rows to find none, on every later slice (#914). A custom plan sees the retired project's own share, and
 * without sequential or bitmap scans, sorts, hash or merge joins each query walks that project's index entries, stops at
 * its LIMIT, and probes its dependants by index. A table without a usable index still gets its sequential scan;
 * `test/demo-removal-indexes.test.ts` holds every table a slice reads to having one.
 */
const SLICE_SETTINGS: readonly (readonly [string, string])[] = [
	["plan_cache_mode", "force_custom_plan"],
	["enable_seqscan", "off"],
	["enable_bitmapscan", "off"],
	["enable_sort", "off"],
	["enable_incremental_sort", "off"],
	["enable_hashjoin", "off"],
	["enable_mergejoin", "off"],
	["max_parallel_workers_per_gather", "0"],
];

/**
 * How many parents a slice reads a parent-owned table under. Reading all of the project's parents into an array on
 * every slice made the work grow with the square of their number, and a large demo's slice could outlast the
 * transaction timeout while it held the project's locks (#914).
 */
const PARENTS_PER_SLICE = 256;

function sliceOwner(table: { name: string; columns: readonly string[] }): SliceOwner {
	if (table.name === "projects") return { by: "id" };
	if (table.columns.includes("project")) return { by: "project" };
	const chain: { column: string; table: string }[] = [];
	for (let name = table.name; ; ) {
		const parent = PROJECT_PARENT[name];
		if (!parent) throw invalid(`removing a project has no ownership rule for table ${table.name}`);
		chain.push(parent);
		if (!PROJECT_PARENT[parent.table]) return { by: "parents", chain };
		name = parent.table;
	}
}

/** Whether the row `alias` names is the project's: a check of that row alone, through its parents' primary keys. */
function ownedRow(table: SliceTable, alias: string): string {
	const { owner } = table;
	if (owner === null) return "FALSE";
	if (owner.by === "id") return `${alias}.id = $1::bigint`;
	if (owner.by === "project") return `${alias}.project = $1::bigint`;
	const check = (at: number, outer: string): string => {
		const link = owner.chain[at];
		if (!link) return `${outer}.project = $1::bigint`;
		const inner = `o${at}`;
		return `EXISTS (SELECT 1 FROM ${identifier(link.table)} ${inner} WHERE ${inner}.id = ${outer}.${identifier(link.column)} AND ${check(at + 1, inner)})`;
	};
	return check(0, alias);
}

/**
 * How a slice reads a table in batches, from where the last slice stopped: down `levels`, the top one read by
 * (project, id) and each lower one by (its column naming the level above, id), and then the table's rows whose `key`
 * names a row of the lowest level. A parent-owned table walks its parents (a lease: runs, then slots, by `slot`). A
 * project's table that refers to itself walks its own rows (folders, by `id`), so a slice reads one batch of them, not
 * the whole table from its first row.
 */
type Walk = { readonly levels: readonly { table: string; column: string }[]; readonly key: string };

/**
 * The walk for a table, given which tables have an index in (column, id) order (`ordered`, as `table:column`). A table
 * with one on the column naming its owner is walked down to its own rows, so a slice reads one batch of them after the
 * rows already removed: under one parent (a run's thousands of slots) or one project, a batch of parents alone could
 * hold any number of rows, and each slice would read past every one it had removed.
 */
function walkOf(
	name: string,
	owner: SliceOwner,
	selfReferences: readonly string[],
	ordered: ReadonlySet<string>,
): Walk | null {
	if (owner?.by === "parents") {
		const levels = owner.chain
			.map((link, at) => ({ table: link.table, column: owner.chain[at + 1]?.column ?? "project" }))
			.reverse();
		const key = owner.chain[0]?.column ?? "";
		return ordered.has(`${name}:${key}`)
			? { levels: [...levels, { table: name, column: key }], key: "id" }
			: { levels, key };
	}
	if (owner?.by === "project" && (selfReferences.length > 0 || ordered.has(`${name}:project`)))
		return { levels: [{ table: name, column: "project" }], key: "id" };
	return null;
}

/** Where a slice is in a walk: one id for each level, the top one's first. "0" is before the first row of a level. */
type Place = readonly string[];
const startOf = (walk: Walk): Place => walk.levels.map(() => "0");

/**
 * Up to `count` rows of level `at` after the one `place` names there, under the row it names at the level above (the
 * project, at the top), read in the order of that level's index on (parent column, id). However many rows the levels
 * above hold, a read examines at most `count` of them.
 *
 * The parent is bounded by a row comparison and `<=`, not by `=`: with `=` the planner knows it and may read the rows
 * in id order off the primary key instead, filtering out every other parent's rows (other projects' included), which
 * it prefers when the table's ids follow its storage order.
 */
async function following(
	db: WriteDb,
	walk: Walk,
	at: number,
	place: Place,
	project: string,
	count: number,
): Promise<string[]> {
	const level = walk.levels[at];
	if (!level) throw new Error(`no level ${at} in a walk of ${walk.levels.length}`);
	const parent = identifier(level.column);
	const rows = await db.allDynamic<{ row_id: string }>(
		`SELECT id::text AS row_id FROM ${identifier(level.table)} WHERE (${parent}, id) > ($1::bigint, $2::bigint) AND ${parent} <= $1::bigint ORDER BY ${parent}, id LIMIT ${count}`,
		[at === 0 ? project : (place[at - 1] ?? "0"), place[at] ?? "0"],
	);
	return rows.map((row) => row.row_id);
}

/**
 * The place after every row under the current row of the level above: the next row at the nearest level above that
 * has one, with the levels below it started again, or null once the top level has none left.
 */
async function nextAbove(db: WriteDb, walk: Walk, place: Place, project: string): Promise<Place | null> {
	for (let at = walk.levels.length - 2; at >= 0; at--) {
		const [row] = await following(db, walk, at, place, project, 1);
		if (row !== undefined) return [...place.slice(0, at), row, ...place.slice(at + 1).map(() => "0")];
	}
	return null;
}
const setLocal = (count: number): string =>
	`SELECT ${Array.from({ length: count }, (_, i) => `set_config($${2 * i + 1}, $${2 * i + 2}, true)`).join(", ")}`;

async function slicePlan(db: ReadDb): Promise<SliceTable[]> {
	const catalog = await db.catalog();
	// Valid, whole-table indexes whose first two columns are (some column, id).
	const indexed = new Set(
		(
			await db.allDynamic<{ name: string; first: string }>(
				`SELECT t.relname AS name, a.attname AS first FROM pg_index x
				 JOIN pg_class t ON t.oid = x.indrelid JOIN pg_namespace n ON n.oid = t.relnamespace
				 JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = x.indkey[0]
				 JOIN pg_attribute b ON b.attrelid = t.oid AND b.attnum = x.indkey[1]
				 WHERE n.nspname = 'public' AND x.indisvalid AND x.indpred IS NULL AND x.indnkeyatts >= 2 AND b.attname = 'id'`,
			)
		).map((row) => `${row.name}:${row.first}`),
	);
	const tables = new Map<string, SliceTable>();
	for (const table of catalog) {
		const owner = INSTANCE_TABLES.includes(table.name)
			? null
			: sliceOwner({ name: table.name, columns: table.columns.map((column) => column.name) });
		const selfReferences =
			owner?.by === "project" && table.columns.some((column) => column.name === "id")
				? table.foreignKeys.flatMap((reference) => {
						const [column, ...more] = reference.columns;
						const nullable = table.columns.find((each) => each.name === column)?.nullable === true;
						return reference.parent === table.name && column !== undefined && more.length === 0 && nullable
							? [column]
							: [];
					})
				: [];
		tables.set(table.name, {
			name: table.name,
			keys: [...table.primary],
			owner,
			incoming: [],
			parents: table.foreignKeys.map((reference) => reference.parent),
			selfReferences,
			walk: walkOf(table.name, owner, selfReferences, indexed),
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
	const remaining = new Map([...tables].filter(([, table]) => table.owner !== null));
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
 * A caller may supply its transaction to hold authority and project locks. Commit and yield between slices. No whole-instance audit is
 * needed; a drain passes one `removalPlan` to every slice so each reads only the table it is emptying, and a
 * parent-owned table under one batch of its parents, from where the last slice stopped at each level. A slice that read a batch and
 * found nothing to remove returns with no rows; without a plan, a slice reads every batch. Leaf rows go
 * first, so cascades cannot turn a small slice into a large deletion. A bounded incoming
 * closure handles cycles; a larger cycle or a reference from retained data refuses the slice unchanged.
 * The last transaction deletes the demo mark and project together (at most two rows, even for limit=1).
 * `rows` counts deleted owned rows, including the mark and cascades; FTS shadow writes and trigger work are additional.
 */
export async function removeProjectSlice(
	db: WriteDb,
	key: string,
	limit = 128,
	plan?: RemovalPlan,
): Promise<{ done: boolean; table: string | null; rows: number }> {
	if (!Number.isSafeInteger(limit) || limit < 1)
		throw invalid("project removal slice limit must be a positive safe integer");
	return db.transaction(() =>
		db.checkedBulk(async () => {
			// A failed slice rolls its savepoint back, settings included; a finished one gives the caller its own back.
			const before = await db.allDynamic<{ name: string; setting: string }>(
				"SELECT name, current_setting(name) AS setting FROM unnest($1::text[]) name",
				[arrayLiteral(SLICE_SETTINGS.map(([name]) => name))],
			);
			await db.allDynamic(setLocal(SLICE_SETTINGS.length), SLICE_SETTINGS.flat());
			const result = await slice(db, key, limit, plan);
			await db.allDynamic(
				setLocal(before.length),
				before.flatMap(({ name, setting }) => [name, setting]),
			);
			return result;
		}),
	);
}

/**
 * What a slice removes from `table` next: up to `limit` rows nothing references (`roots`), else one row to remove with
 * its dependants (`root`), else `none`. A parent-owned table is read under the next batch of its own parents after
 * `place`, and `none` then names the place to read from next, or null when no parent is left at any level; any other
 * table is read whole, and its `none` names none. Rows found under a batch come with `from`, the place just before the
 * batch's first parent: every parent before it is done with, so the next slice need not read past it again, which
 * matters when the walk reads the table's own rows, as their removed index entries stay behind it.
 */
async function rowsToRemove(
	db: WriteDb,
	table: SliceTable,
	project: string,
	limit: number,
	place: Place | undefined,
	batch: number,
): Promise<
	| { kind: "roots"; roots: string[][]; from: Place | null }
	| { kind: "root"; root: string; from: Place | null }
	| { kind: "none"; next: Place | null }
> {
	let params: SqlValue[] = [project];
	let scope = ownedRow(table, identifier(table.name));
	let next: Place | null = null;
	let from: Place | null = null;
	const { walk } = table;
	if (walk) {
		const at = place ?? startOf(walk);
		const parents = await following(db, walk, walk.levels.length - 1, at, project, batch);
		if (parents.length === 0) return { kind: "none", next: await nextAbove(db, walk, at, project) };
		next = [...at.slice(0, -1), parents.at(-1) ?? "0"];
		from = [...at.slice(0, -1), String(BigInt(parents[0] ?? "1") - 1n)];
		scope = `${identifier(table.name)}.${identifier(walk.key)} = ANY($1::bigint[])`;
		params = [arrayLiteral(parents)];
	}
	const blockers = table.incoming.map(({ child, columns }) => {
		const matches = columns
			.map(({ from, to }) => `c.${identifier(from)} = ${identifier(table.name)}.${identifier(to)}`)
			.join(" AND ");
		const same =
			child === table
				? ` AND NOT (${table.keys.map((key) => `c.${identifier(key)} = ${identifier(table.name)}.${identifier(key)}`).join(" AND ")})`
				: "";
		return ` AND NOT EXISTS (SELECT 1 FROM ${identifier(child.name)} c WHERE ${matches}${same})`;
	});
	const roots = await db.allDynamic<{ keys: string }>(
		`SELECT ${sliceKeys(table)} AS keys FROM ${identifier(table.name)} WHERE ${scope}${blockers.join("")} LIMIT ${limit}`,
		params,
	);
	if (roots.length > 0)
		return { kind: "roots", roots: roots.map(({ keys }) => z.array(z.string()).parse(JSON.parse(keys))), from };
	const root = (
		await db.allDynamic<{ keys: string }>(
			`SELECT ${sliceKeys(table)} AS keys FROM ${identifier(table.name)} WHERE ${scope} LIMIT 1`,
			params,
		)
	)[0];
	return root ? { kind: "root", root: root.keys, from } : { kind: "none", next };
}

/**
 * Sets to null, for one batch of the project's rows of `table` in (project, id) order, the columns by which a row
 * refers to another row of the table, and says whether the table has none left to set. A row that another row of its
 * own table refers to is deleted only after that one, so in a chain (a folder in a folder in a folder) only the leaf
 * was free to go: a slice read the whole chain to find it, and the next slice read it again, less one row (#914).
 * With the references gone first, every row is free, and each row is read once to clear them. Only the rows of a
 * project being removed are changed, and nothing else reads them by those columns. Without `resume` (no plan, or the
 * pass before the project row goes) every batch is cleared at once.
 */
async function unlinkSelf(
	db: WriteDb,
	table: SliceTable,
	project: string,
	plan: RemovalPlan | undefined,
	resume: RemovalPlan | undefined,
): Promise<boolean> {
	const { walk } = table;
	if (table.selfReferences.length === 0 || !walk) return true;
	const reached = plan?.unlinked.get(table.name);
	if (reached === true) return true;
	const set = table.selfReferences.map((column) => `${identifier(column)} = NULL`).join(", ");
	const held = table.selfReferences.map((column) => `${identifier(column)} IS NOT NULL`).join(" OR ");
	for (let after = reached ?? "0"; ; ) {
		const rows = await following(db, walk, 0, [after], project, plan?.batch ?? PARENTS_PER_SLICE);
		const last = rows.at(-1);
		if (last === undefined) {
			plan?.unlinked.set(table.name, true);
			return true;
		}
		await db.runDynamic(`UPDATE ${identifier(table.name)} SET ${set} WHERE id = ANY($1::bigint[]) AND (${held})`, [
			arrayLiteral(rows),
		]);
		after = last;
		if (resume) {
			resume.unlinked.set(table.name, after);
			return false;
		}
	}
}

async function slice(
	db: WriteDb,
	key: string,
	limit: number,
	plan: RemovalPlan | undefined,
): Promise<{ done: boolean; table: string | null; rows: number }> {
	const project = (await db.allDynamic<{ id: string }>("SELECT id::text AS id FROM projects WHERE key=$1", [key]))[0];
	if (!project) return { done: true, table: null, rows: 0 };
	if (plan && plan.project !== `${key}:${project.id}`) {
		plan.project = `${key}:${project.id}`;
		plan.empty.clear();
		plan.after.clear();
		plan.unlinked.clear();
	}
	const tables = plan?.tables ?? (await slicePlan(db));
	const batch = plan?.batch ?? PARENTS_PER_SLICE;
	const ordinary = tables.filter((table) => table.name !== "projects" && table.name !== "demo_projects");
	let blocked: string | null = null;
	for (const table of ordinary) {
		if (plan?.empty.has(table.name)) continue;
		// A drain's slice reads one batch of a parent-owned table's parents, or moves one row on at a level above, and
		// leaves the rest to the next slice. Without a plan to keep its place, a slice reads them all.
		const resume = plan;
		if (!(await unlinkSelf(db, table, project.id, plan, resume))) return { done: false, table: table.name, rows: 0 };
		let found = await rowsToRemove(db, table, project.id, limit, resume?.after.get(table.name), batch);
		while (found.kind === "none" && found.next !== null) {
			if (resume) {
				resume.after.set(table.name, found.next);
				return { done: false, table: table.name, rows: 0 };
			}
			found = await rowsToRemove(db, table, project.id, limit, found.next, batch);
		}
		if (found.kind === "none") {
			plan?.empty.add(table.name);
			plan?.after.delete(table.name);
			continue;
		}
		if (resume && found.from) resume.after.set(table.name, found.from);
		if (found.kind === "roots") {
			const identity = `(${table.keys.map(identifier).join(",")})`;
			const placeholders = found.roots
				.map((keys, row) => `(${keys.map((_, i) => `$${2 + row * table.keys.length + i}`).join(",")})`)
				.join(",");
			await db.runDynamic(
				`DELETE FROM ${identifier(table.name)} WHERE ${ownedRow(table, identifier(table.name))} AND ${identity} IN (${placeholders})`,
				[project.id, ...found.roots.flat()],
			);
			return { done: false, table: table.name, rows: found.roots.length };
		}
		const pending = [{ table, keys: z.array(z.string()).parse(JSON.parse(found.root)) }];
		const included = new Set([`${table.name}:${found.root}`]);
		let oversized = false;
		for (let at = 0; at < pending.length && !oversized; at++) {
			const row = pending[at];
			if (!row) continue;
			for (const { child, columns } of row.table.incoming) {
				const childColumns = columns.map(({ from }) => `c.${identifier(from)}`).join(",");
				const parentColumns = columns.map(({ to }) => `p.${identifier(to)}`).join(",");
				const dependants = await db.allDynamic<{ keys: string; owned: boolean }>(
					`SELECT ${sliceKeys(child, "c.")} AS keys, (${ownedRow(child, "c")}) AS owned FROM ${identifier(child.name)} c WHERE (${childColumns}) IN (SELECT ${parentColumns} FROM ${identifier(row.table.name)} p WHERE (${ownedRow(row.table, "p")}) AND ${sliceIdentity(row.table, "p.")}) LIMIT ${limit + 1}`,
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
	// Every table is empty of the project's rows, and stays so: a retired demo takes no writes (`retiredDemo` in the
	// registry), so no table is read again. A row of another project that still refers to this one fails the foreign
	// key check at the end of the transaction, which rolls it back.
	let rows = (await db.runDynamic("DELETE FROM demo_projects WHERE project=$1", [project.id])).changes;
	rows += (await db.runDynamic("DELETE FROM projects WHERE id=$1", [project.id])).changes;
	return { done: true, table: "projects", rows };
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
