// The rules of the module map, as failing tests (principles P9 and P10). An agent that takes the shortest path that
// compiles, and reaches across a boundary to do it, fails here with a message that says which rule and why.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { Glob } from "bun";
import { z } from "zod";
import { ERROR_CODES, HTTP_STATUS } from "../src/core/api.ts";
import { needs } from "../src/core/kinds.ts";
import { REPLIES } from "../src/core/replies.ts";
import { Database, declaredSql } from "../src/server/kernel/db.ts";
import {
	ARCHIVE_VERSION,
	baselineSchema,
	migrate,
	SCHEMA_VERSION,
	schemaVersion,
} from "../src/server/kernel/migrate.ts";
import { OP_LIST } from "../src/server/ops/index.ts";
import { UNEXPORTED } from "../src/server/transfer/transfer.ts";
import { openApi } from "../src/surfaces/http.ts";
import "../src/server/ops/jobs.ts";
import { testDatabase } from "./db.ts";

const files = [...new Glob("src/**/*.{ts,tsx}").scanSync(".")].filter(
	(file) => !file.endsWith(".test.ts") && !file.endsWith(".d.ts"),
);
const transpilers = { ts: new Bun.Transpiler({ loader: "ts" }), tsx: new Bun.Transpiler({ loader: "tsx" }) };
const imports = (file: string): string[] => {
	const source = readFileSync(file, "utf8").replace(/^#![^\n]*/, "");
	return [
		...new Set([
			...transpilers[file.endsWith(".tsx") ? "tsx" : "ts"].scanImports(source).map(({ path }) => path),
			// Bun erases type-only imports; keep checking the static imports the map already covered.
			...[
				...source.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+["']([^"']+)["']|^\s*import\s+["']([^"']+)["']/gm),
			].map((m) => m[1] ?? m[2] ?? ""),
		]),
	];
};
const layerOf = (file: string): string => {
	const parts = file.split("/");
	return parts[1] === "server" ? `server/${parts[2]}` : (parts[1] ?? "");
};

describe("the PostgreSQL baseline", () => {
	test("the fixture applies the immutable ledger and isolates later clones", async () => {
		const first = await testDatabase();
		const second = await testDatabase();
		const database = await Database.open({ url: first.url });
		const peer = await Database.open({ url: second.url });
		try {
			await migrate(database);
			const ledger = await database.read(async (db) => {
				expect(await schemaVersion(db)).toBe(SCHEMA_VERSION);
				return await db.allDynamic<{ key: string; value: string }>("SELECT key, value FROM meta ORDER BY key");
			});
			expect(ledger).toEqual([
				{ key: "archive_version", value: String(ARCHIVE_VERSION) },
				{ key: "baseline_hash", value: baselineSchema().hash },
				{ key: "schema_version", value: String(SCHEMA_VERSION) },
			]);
			expect(baselineSchema().sql).toBe(readFileSync("src/server/kernel/schema.sql", "utf8"));
			expect(baselineSchema().hash).toMatch(/^[a-f0-9]{64}$/);
			await database.write((db) => db.transaction(() => db.exec("INSERT INTO meta VALUES ('private', 'first clone')")));
			expect(await peer.read((db) => db.allDynamic("SELECT value FROM meta WHERE key = 'private'"))).toEqual([]);
		} finally {
			await database.close();
			await peer.close();
			await first.close();
			await second.close();
		}
	});
});

function uncheckedWitnesses(text: string): string[] {
	return [
		...text.matchAll(
			/^(?:export )?(?:async )?function\*? (\w+)\([^)]*\bwitness: Witness\b[^)]*\)[^{]*\{\n([\s\S]*?)^\}/gm,
		),
	]
		.filter(([, , body]) => !/\bdecisionOf\(witness, "[\w-]+"\)|\(ctx, witness\b/.test(body ?? ""))
		.map(([, name]) => name ?? "");
}

describe("the module map", () => {
	test("only the decision machinery can mint a witness, so standing cannot change without a decision", () => {
		// The mint is claimed once, by the module that settles decisions; a second claim throws when it loads
		// (test/integrity.test.ts). This names the one place the claim is written.
		const claimers = files.filter(
			(file) =>
				/\bclaimMint\b|Witness\.claim\b/.test(readFileSync(file, "utf8")) && !file.endsWith("kernel/witness.ts"),
		);
		expect(claimers).toEqual(["src/server/decisions/decisions.ts"]);
	});

	test("every function that is handed a witness checks it", () => {
		// A standing writer must read its decision through `decisionOf`, which refuses anything the mint did not make,
		// or hand the witness on to a function that does. A parameter that is taken and ignored proves nothing.
		// (A kind handler in `decisions` may ignore the witness it is offered: one that writes no standing has no use
		// for it. The writers are in the modules below.)
		const offenders: string[] = [];
		for (const file of files.filter((file) => file.startsWith("src/server/") && !file.endsWith("kernel/witness.ts"))) {
			const text = readFileSync(file, "utf8");
			if (/\b_witness\b/.test(text) && !file.startsWith("src/server/decisions/"))
				offenders.push(`${file} ignores a witness`);
			for (const name of uncheckedWitnesses(text)) offenders.push(`${file}: ${name} never checks its witness`);
		}
		expect(offenders).toEqual([]);
	});

	test("the witness scan rejects unchecked async writers and accepts checked or forwarded witnesses", () => {
		for (const declaration of ["function", "function*", "async function", "async function*"]) {
			const writer = (body: string) => `export ${declaration} probe(ctx: Ctx, witness: Witness) {\n${body}\n}`;
			expect(uncheckedWitnesses(writer("writeStanding(ctx);"))).toEqual(["probe"]);
			expect(uncheckedWitnesses(writer('decisionOf(witness, "probe");'))).toEqual([]);
			expect(uncheckedWitnesses(writer("writeStanding(ctx, witness);"))).toEqual([]);
		}
	});

	test("only db.ts imports the PostgreSQL driver or reaches a raw driver handle", () => {
		const offenders = files.filter((file) => {
			if (file === "src/server/kernel/db.ts") return false;
			const source = readFileSync(file, "utf8");
			return (
				imports(file).some((path) => /^(?:bun:sqlite|postgres|pg|bun:sql)$/.test(path)) ||
				/\bBun\.(?:sql|SQL)\b|\bnew\s+SQL\b|\.unsafe\s*\(|\.reserve\s*\(|\.raw\b/.test(source) ||
				/(?:import|export)[\s\S]*?\{[^}]*\b(?:SQL|sql|ReservedSQL)\b[^}]*\}\s*from\s*["']bun["']/.test(source)
			);
		});
		expect(offenders).toEqual([]);
	});

	test("only the registry slices WriteDb transactions; only transfer uses dynamic writes and catalogs", () => {
		for (const [pattern, allowed] of [
			[/\.(?:begin|commit|rollback)\s*\(/, ["src/server/kernel/db.ts", "src/server/ops/registry.ts"]],
			[/\.(?:runDynamic|catalog)\s*\(/, ["src/server/kernel/db.ts", "src/server/transfer/"]],
			[/\.migration\s*\(/, ["src/server/kernel/db.ts"]],
		] as const) {
			expect(
				[...files, ...new Glob("scripts/**/*.ts").scanSync(".")].filter(
					(file) =>
						!allowed.some((path) => file === path || (path.endsWith("/") && file.startsWith(path))) &&
						pattern.test(readFileSync(file, "utf8")),
				),
			).toEqual([]);
		}
	});

	test("database administration belongs only to the fixture, tests and scripts", () => {
		const paths = [...files, ...new Glob("{test,scripts,bench}/**/*.ts").scanSync(".")];
		expect(
			paths.filter(
				(file) =>
					file !== "src/server/kernel/db.ts" &&
					!file.startsWith("test/") &&
					!file.startsWith("scripts/") &&
					/\bdatabaseAdmin\b/.test(readFileSync(file, "utf8")),
			),
		).toEqual([]);
	});

	test("the pure core imports nothing from the server, the surfaces or the web", () => {
		const offenders = files
			.filter((file) => file.startsWith("src/core/"))
			.filter((file) =>
				imports(file).some((path) => path.startsWith("..") || path.startsWith("bun:") || path.startsWith("node:")),
			);
		expect(offenders).toEqual([]);
	});

	test("domain modules do not reach upward: imports go down the map, never up", () => {
		// Each layer may import the layers listed after it. `ops` composes everything; `decisions` sits above the
		// modules whose standing it writes; none of those may import `decisions` or `ops`.
		const domain: Record<string, string[]> = {
			"server/kernel": [],
			"server/identity": ["batch_admissions", "server/kernel"],
			"server/policy": ["server/kernel"],
			"server/suite": ["server/kernel", "server/policy"],
			"server/evidence": ["server/kernel", "server/suite"],
			"server/runs": ["server/kernel", "server/suite", "server/evidence"],
			"server/decisions": [
				"server/kernel",
				"server/identity",
				"server/policy",
				"server/suite",
				"server/evidence",
				"server/runs",
			],
			"server/transfer": ["server/kernel", "server/suite", "server/evidence", "server/decisions"],
			"server/trackers": ["server/kernel", "server/evidence", "server/suite"],
			"server/statuses": ["server/kernel", "server/evidence", "server/runs"],
			"server/handoffs": ["server/kernel", "server/evidence", "server/decisions"],
		};
		const server = [...Object.keys(domain), "server/ops"];
		const allowed: Record<string, string[]> = {
			...domain,
			core: [],
			web: [],
			"server/ops": Object.keys(domain),
			surfaces: ["server/ops", "server/kernel", "server/identity", "web"],
			app: [...server, "surfaces"],
			cli: ["app", "surfaces", "server/ops", "server/kernel", "server/policy", "web"],
		};
		const exceptions: Record<string, string[]> = {
			// The HTTP client shares the sign-in token length bound.
			"src/cli/client.ts": ["server/identity"],
			// Demo deployment issues a short-lived token and drains retired storage after swapping.
			"src/cli/demo.ts": ["server/identity", "server/transfer"],
		};
		const offenders: string[] = [];
		for (const file of files) {
			const layer = layerOf(file);
			const may = allowed[layer];
			if (!may) {
				offenders.push(`${file} belongs to an unlisted layer (${layer})`);
				continue;
			}
			for (const path of imports(file)) {
				if (!path.startsWith(".")) continue;
				const resolved = new URL(path, `file:///${file}`).pathname.slice(1);
				// Bundled documentation and licence text outside src are assets, not runtime layers.
				if (!resolved.startsWith("src/") && !/\.tsx?$/.test(resolved)) continue;
				if (file === "src/cli/test-support.ts" && resolved === "test/db.ts") continue;
				const target = layerOf(resolved);
				if (target === layer || target === "core" || may.includes(target) || exceptions[file]?.includes(target))
					continue;
				offenders.push(`${file} imports ${path} (${layer} may not import ${target})`);
			}
		}
		expect(offenders).toEqual([]);
	});

	// The owner of each table. A read of another module's data goes through that module's functions, so the
	// rules about its rows live in one place and a join cannot quietly depend on another module's schema.
	const owners: Record<string, string[]> = {
		"server/kernel": ["meta", "projects", "counters", "commands", "demo_projects"],
		"server/identity": [
			"batch_admissions",
			"mail_contacts",
			"orgs",
			"actors",
			"grants",
			"teams",
			"team_members",
			"team_grants",
			"team_events",
			"tokens",
			"sessions",
			"credentials",
			"invitations",
			"passkey_users",
		],
		"server/policy": ["policies"],
		"server/suite": [
			"folders",
			"cases",
			"case_tags",
			"case_aliases",
			"versions",
			"placements",
			"proposals",
			"search_docs",
			"requirements",
			"covers",
		],
		"server/evidence": [
			"assertion_seen",
			"assertion_spreads",
			"assertion_roots",
			"assertion_index",
			"artifacts",
			"builds",
			"deployments",
			"tests",
			"targets",
			"changes",
			"change_ends",
			"scope_moves",
			"batches",
			"signatures",
			"results",
			"attachments",
			"flips",
			"result_tries",
			"findings",
			"reviews",
			"excuses",
			"result_excuses",
			"quarantines",
		],
		"server/runs": ["runs", "run_tests", "slots", "slot_results", "depends_on", "slot_leases"],
		"server/decisions": [
			"merge_receipt_heads",
			"merge_receipt_dirty",
			"merge_receipt_nodes",
			"merge_receipt_members",
			"merge_receipt_snapshots",
			"merge_receipt_payloads",
			"merge_receipts",
			"questions",
			"question_refs",
			"answers",
			"decisions",
		],
		"server/trackers": ["tracker_requests", "tracker_polls"],
		"server/statuses": ["commit_statuses", "commit_status_delivery"],
		"server/handoffs": ["handoffs"],
	};

	test("a module runs SQL only on the tables it owns", async () => {
		const ownerOf = new Map(
			Object.entries(owners).flatMap(([layer, tables]) => tables.map((table) => [table, layer] as const)),
		);
		const offenders: string[] = [];
		for (const file of files) {
			// The archive reads every table by name from the database itself; it has no table of its own to confuse.
			if (!file.startsWith("src/server/") || file.startsWith("src/server/transfer/") || file.includes("/migrations/"))
				continue;
			const layer = layerOf(file);
			const source = readFileSync(file, "utf8");
			// SQL keywords are upper case in this codebase; prose in comments is not.
			for (const match of source.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+([a-z_]+)\b/g)) {
				const table = match[1] ?? "";
				const owner = ownerOf.get(table);
				if (owner && owner !== layer) offenders.push(`${file} runs SQL on ${table}, which ${owner} owns`);
			}
		}
		expect(offenders).toEqual([]);
		// Every table in the schema has an owner: a new table without one fails here.
		const fixture = await testDatabase();
		const database = await Database.open({ url: fixture.url });
		let tables: string[];
		try {
			tables = await database.read(async (db) =>
				(
					await db.allDynamic<{ name: string }>(
						"SELECT c.relname AS name FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY c.relname",
					)
				).map((row) => row.name),
			);
		} finally {
			await database.close();
			await fixture.close();
		}

		expect(tables.filter((table) => !ownerOf.has(table))).toEqual([]);
		expect([...ownerOf.keys()].filter((table) => !tables.includes(table))).toEqual([]);
	});

	test("identity is entered through identity.ts: no other layer imports another file of it", () => {
		// Tokens, sessions and what is noted of their use are files of one module, and `identity.ts` is its
		// interface. A surface that imported `sessions.ts` could open a session without the proof that
		// `identity.ts` asks for first.
		const offenders = files
			.filter((file) => !file.startsWith("src/server/identity/"))
			.flatMap((file) =>
				imports(file)
					.filter((path) => path.startsWith("."))
					.map((path) => new URL(path, `file:///${file}`).pathname.slice(1))
					.filter((target) => target.startsWith("src/server/identity/") && target !== "src/server/identity/identity.ts")
					.map((target) => `${file} imports ${target}`),
			);
		expect(offenders).toEqual([]);
	});

	test("an archive holds who the actors are and what they may do, and no other table of identity", () => {
		// What lets somebody in never travels in an archive, and an import empties it: a token and a session (the
		// SHA-256 of a secret), a password's hash, a passkey's public key and the handle it is filed under, an
		// invitation's code. The tables named here are all of identity that an archive holds. A table that
		// is added later is unexported, or it is added to this list on purpose: until then this fails, before
		// an export carries what signs somebody in.
		const exported = [
			"orgs",
			"actors",
			"grants",
			"teams",
			"team_members",
			"team_grants",
			"team_events",
			"mail_contacts",
		];
		const identity = owners["server/identity"] ?? [];
		// Change endings, scope-move audit rows and demo marks preserve the old archive version (decisions 0022, 0038
		// and 0100). Tracker delivery and hand-offs must never replay after import. None of these tables holds credentials.
		const other = [
			"assertion_seen",
			"assertion_spreads",
			"assertion_roots",
			"assertion_index",
			"slot_leases",
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
		expect(UNEXPORTED.filter((table) => !other.includes(table)).sort()).toEqual(
			identity.filter((table) => !exported.includes(table)).sort(),
		);
		expect(UNEXPORTED.filter((table) => other.includes(table))).toEqual(other);
	});

	test("writers that undo a withdrawn decision are called only by the kind handlers", () => {
		// These change standing without a witness on purpose: they put back what a decision did when that decision
		// is withdrawn or stops holding, which is itself a recorded event. Nothing else may reach for them.
		const undo = /\b(restoreLink|dropExcuse|dropResultExcuses|reopenRun|restoreFailures)\(/;
		const callers = files.filter((file) => undo.test(readFileSync(file, "utf8")));
		expect(callers.sort()).toEqual([
			"src/server/decisions/kinds.ts",
			"src/server/evidence/evidence.ts",
			"src/server/runs/runs.ts",
		]);
	});

	test("the web UI imports only the pure core, never the server", () => {
		const offenders = files
			.filter((file) => file.startsWith("src/web/"))
			.flatMap((file) =>
				imports(file)
					.filter((path) => path.includes("/server/") || path.includes("/surfaces/") || path.startsWith("bun:"))
					.map((path) => `${file} imports ${path}`),
			);
		expect(offenders).toEqual([]);
	});
});

describe("the phone layout", () => {
	// Decision 0018: a phone gets a layout of its own, and no style of the desktop changes for it. The first three
	// hold that. The fourth holds what a phone may do while the detail is covered.
	const phone = ':root[data-layout="phone"]';
	const sheets = [...new Glob("src/web/**/*.css").scanSync(".")];

	test("a phone is a device whose first pointer is a finger: a mouse matches no part of the query", () => {
		const query = /export const PHONE\s*=\s*"([^"]+)"/.exec(readFileSync("src/web/lib/layout.ts", "utf8"))?.[1] ?? "";
		const alternatives = query.split(",").map((part) => part.trim());
		expect(alternatives.length).toBeGreaterThan(0);
		expect(alternatives.filter((part) => !part.startsWith("(pointer: coarse) and "))).toEqual([]);
	});

	test("every rule of phone.css applies on a phone only", () => {
		const css = readFileSync("src/web/phone.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
		const selectors = [...css.matchAll(/(?:^|[{}])\s*([^{}@]+?)\s*\{/g)].flatMap((rule) =>
			(rule[1] ?? "")
				// A comma inside :is(...) separates arguments, not selectors.
				.replace(/\([^()]*\)/g, "()")
				.split(",")
				.map((selector) => selector.trim()),
		);
		expect(selectors.length).toBeGreaterThan(20);
		expect(selectors.filter((selector) => !selector.startsWith(phone))).toEqual([]);
	});

	test("no other stylesheet has a rule for the phone, so the desktop's styles say nothing about it", () => {
		expect(sheets).toContain("src/web/phone.css");
		expect(
			sheets.filter((file) => file !== "src/web/phone.css" && readFileSync(file, "utf8").includes("data-layout")),
		).toEqual([]);
	});

	test("the bindings marked `list`, which run on a phone while the detail is covered, are the ones named here", () => {
		// `list: true` lets a key or the palette run a binding while the detail of the selected row is covered
		// (`Binding.list` in src/web/lib/keys.ts). An answer, a result, an archive or an accepted proposal marked
		// so would be recorded about something nobody had opened. Whoever adds a binding here says that it goes
		// somewhere or opens something new. The test reads the source as text: it shows a reviewer every mark
		// written as a literal, and cannot see one that is computed.
		const sources = files
			.filter((file) => file.startsWith("src/web/"))
			.map((file) => ({
				file,
				// Without comments, where "the list: ..." is prose.
				text: readFileSync(file, "utf8")
					.replace(/\/\*[\s\S]*?\*\//g, "")
					.replace(/^\s*\/\/.*$/gm, ""),
			}));
		const marked = sources
			.flatMap(({ file, text }) =>
				[...text.matchAll(/label:\s*(["`])([^"`]+)\1,[^{}]*?\blist\s*:\s*true\b/g)].map(
					(match) => `${file}: ${(match[2] ?? "").replace(/\$\{[^}]*\}/g, "…")}`,
				),
			)
			.sort();
		expect(marked).toEqual([
			"src/web/app.tsx: All keys",
			"src/web/app.tsx: Close palette / keys",
			"src/web/app.tsx: Docs for this screen",
			"src/web/app.tsx: Go home",
			// One binding for each of the five screens: the label is a template, and "…" stands for the screen.
			"src/web/app.tsx: Go to …",
			"src/web/app.tsx: Jump to or run",
			"src/web/app.tsx: Sign out",
			"src/web/app.tsx: Switch project",
			"src/web/runs/index.tsx: Plan run",
			// While its form is open: closing a form decides nothing, and a phone has no Escape key.
			"src/web/suite/bindings.ts: Cancel new folder",
			"src/web/suite/bindings.ts: Cancel tag",
			"src/web/suite/bindings.ts: Filter",
			"src/web/suite/bindings.ts: New case",
			// It makes a folder, whose form the shell shows by opening the sidebar, and decides nothing about a case.
			"src/web/suite/bindings.ts: New folder",
		]);
		// Every `list` property in the source is one of those: written `true`, and where the pattern above reads it.
		const values = sources.flatMap(({ file, text }) =>
			[...text.matchAll(/\blist\s*:\s*([^,}\n]+)/g)].map((match) => `${file}: ${(match[1] ?? "").trim()}`),
		);
		expect(values.filter((value) => !value.endsWith(": true"))).toEqual([]);
		expect(values.length).toBe(marked.length);
	});
});

describe("the registry", () => {
	test("every operation registers the reply contract used by clients", () => {
		expect(OP_LIST.map((op) => op.name).sort()).toEqual(Object.keys(REPLIES).sort());
		for (const [name, schema] of Object.entries(REPLIES))
			expect(OP_LIST.find((op) => op.name === name)?.output).toBe(schema);
	});

	test("every statement the server can run prepares against the schema", async () => {
		// Import every runtime server owner, including modules outside the operation registry's graph.
		for (const file of files.filter((file) => file.startsWith("src/server/"))) await import("../" + file);
		const fixture = await testDatabase();
		const database = await Database.open({ url: fixture.url });
		const broken: string[] = [];
		const statements = declaredSql();
		try {
			await database.write((db) =>
				db.transaction(async () => {
					for (const [index, statement] of statements.entries()) {
						try {
							await db.savepoint(async () => {
								await db.exec("PREPARE architecture_" + index + " AS " + statement.text);
								await db.exec("DEALLOCATE architecture_" + index);
							});
						} catch (error) {
							broken.push(String(error) + "\\n  in: " + statement.text.replace(/\s+/g, " ").slice(0, 200));
						}
					}
				}),
			);
		} finally {
			await database.close();
			await fixture.close();
		}
		console.log("Prepared " + statements.length + " declared server statements against the PostgreSQL baseline");
		expect(broken).toEqual([]);
		expect(statements.length).toBeGreaterThan(450);
	});

	// How many MCP tools there are is a budget, reported in src/surfaces/mcp.test.ts (#906).
	test("every operation is declared once", () => {
		expect(new Set(OP_LIST.map((op) => op.name)).size).toBe(OP_LIST.length);
	});

	test("a pipeline's token reaches attach, report, change, announce, work and gate", () => {
		// `record` is all a pipeline's token holds by default, so an operation that accepts it is one more thing a
		// secret in a CI system can do. Adding to this list is a decision (docs/decisions/0014), not a copy of the
		// nearest operation: `change`, which says that a pull request ended, came with decision 0022, and `announce` with decision 0046.
		// `attach` appends only to the producer's own evidence (decision 0065). `gate` is
		// also the one operation that accepts either of two capabilities.
		const accepts = (capability: "record" | "read") =>
			OP_LIST.filter((op) => needs(op.needs).includes(capability)).map((op) => op.name);
		expect(accepts("record")).toEqual(["attach", "report", "change", "announce", "work", "gate"]);
		expect(OP_LIST.filter((op) => typeof op.needs !== "string").map((op) => op.name)).toEqual(["gate"]);
		// What a pipeline may be let do besides: the reads, and nothing that writes.
		expect(OP_LIST.filter((op) => accepts("read").includes(op.name) && op.effect !== "read")).toEqual([]);
	});

	test("the operations any signed-in caller may run are session and credential, and one function says whose things they touch", () => {
		// `self` asks for no capability: whoever is signed in runs the operation, on what is their own. Whether
		// something is the caller's own, or is anyone's because the caller is a person who administers, is
		// decided by `mayActFor` in `identity.ts` and nowhere else. An operation that compared ids itself, or
		// looked for `admin` itself, would be a second rule, and the two would drift.
		const self = OP_LIST.filter((op) => op.needs === "self");
		expect(self.map((op) => op.name)).toEqual(["session", "credential"]);
		for (const op of OP_LIST.filter((op) => ["session", "credential", "invitation"].includes(op.name)))
			expect(`${op.name}: ${op.mcp}`).toBe(`${op.name}: null`);
		const declaring = files.filter((file) => /needs: "self"/.test(readFileSync(file, "utf8")));
		expect(declaring).toEqual(["src/server/ops/people.ts"]);
		const source = readFileSync("src/server/ops/people.ts", "utf8");
		expect(source).toContain("mayActFor(");
		expect(source.match(/actor\.id\s*[!=]==|[!=]==\s*env\.actor\.id|includes\("admin"\)/g) ?? []).toEqual([]);
		const deciding = files.filter((file) => /function mayActFor\b/.test(readFileSync(file, "utf8")));
		expect(deciding).toEqual(["src/server/identity/identity.ts"]);
	});

	test("no operation takes a password: no field of any input schema is named like one", () => {
		// The registry keeps a digest of every request that carries a command id, and an operation's input is
		// what the CLI takes as flags, which a shell keeps in its history. A secret a person chose goes through
		// the sign-in routes (`src/surfaces/signin.ts`) and never through here.
		const named: string[] = [];
		const walk = (op: string, node: unknown): void => {
			if (Array.isArray(node)) for (const item of node) walk(op, item);
			else if (typeof node === "object" && node !== null) {
				for (const [key, value] of Object.entries(node)) {
					if (key === "properties" && typeof value === "object" && value !== null)
						for (const field of Object.keys(value))
							if (/password|passphrase|secret|pwd/i.test(field)) named.push(`${op}.${field}`);
					walk(op, value);
				}
			}
		};
		for (const op of OP_LIST) walk(op.name, z.toJSONSchema(op.input, { io: "input", unrepresentable: "any" }));
		expect(named).toEqual([]);
		// The check finds a field it is given, at any depth.
		walk("example", z.toJSONSchema(z.object({ nested: z.array(z.object({ newPassword: z.string() })) })));
		expect(named).toEqual(["example.newPassword"]);
	});

	test("there is no second way to do what propose, report, plan and decide do", () => {
		const forbidden = [
			"createCase",
			"updateCase",
			"moveCase",
			"linkTest",
			"quarantine",
			"createRun",
			"addResult",
			"closeRun",
			"approve",
		];
		expect(OP_LIST.map((op) => op.name).filter((name) => forbidden.includes(name))).toEqual([]);
	});
});

describe("the codes of a refusal", () => {
	test("the error codes are written once, in src/core/api.ts", () => {
		// A reply that did not run says why with one of `ERROR_CODES`. The status of each, the API description and
		// the schemas with which the CLI, the web client and the reader threads read a reply all take that list.
		// Each of them once had a copy of its own, and a code added to one and not to the others was a reply some
		// client could not read. Four of the codes written side by side, as a union or as an array, are a copy.
		// (Three are not: what became of a decision is `conflict`, `forbidden` or `invalid` among other words.)
		const code = `["'\`](?:${ERROR_CODES.join("|")})["'\`]`;
		const copy = new RegExp(`${code}(?:\\s*[,|]\\s*${code}){3,}`, "g");
		const copies = files.flatMap((file) => [...readFileSync(file, "utf8").matchAll(copy)].map(() => file));
		expect(copies).toEqual(["src/core/api.ts"]);
		// What is made from the list holds every code of it: a status for each, and each in the API description.
		expect(Object.keys(HTTP_STATUS).sort()).toEqual([...ERROR_CODES].sort());
		const described = z
			.object({
				components: z.object({
					schemas: z.object({
						Failed: z.object({
							properties: z.object({
								error: z.object({ properties: z.object({ code: z.object({ enum: z.array(z.string()) }) }) }),
							}),
						}),
					}),
				}),
			})
			.parse(openApi()).components.schemas.Failed.properties.error.properties.code.enum;
		expect(described).toEqual([...ERROR_CODES]);
	});
});

/** Files a machine makes and nobody commits; `.env.example` is committed and is read. */
export const LOCAL = /^(\.env(?!\.example$)|bench\/results-.*\.json$|\.[0-9a-f]+-[0-9a-f]+\.bun-build$)/;

/**
 * Every text file of the checkout, tracked or not: scratch left in the tree is read too. Bun writes an executable it
 * is building to `.<hash>-<number>.bun-build` in the directory it was started in, and does not always remove it. That
 * file holds the whole source: seen while `test/headers.test.ts` still built from here, it failed a test that read it
 * (2026-10-13, on macOS, in one check of two). The test now builds in its own directory (#401); `bun run build` still
 * makes one here.
 */
function wholeTree(): string[] {
	const outside = new Set([".git", "node_modules", "dist", ".mainworthy", ".casebook", "test-results"]);
	const binary = /\.(png|jpe?g|gif|ico|gz|db|db-wal|db-shm)$/;
	return readdirSync(".", { withFileTypes: true })
		.filter((entry) => !outside.has(entry.name))
		.flatMap((entry) =>
			entry.isDirectory() ? [...new Glob(`${entry.name}/**/*`).scanSync({ cwd: ".", dot: true })] : [entry.name],
		)
		.filter((file) => !binary.test(file) && !LOCAL.test(file));
}

/** The tailnet names in `text` that are not under `example.ts.net`, the one name this repository may carry. */
export function foreignTailnetNames(text: string): string[] {
	return (text.match(/\b(?:[\w-]+\.)+ts\.net\b/gi) ?? []).filter((name) => !/(?:^|\.)example\.ts\.net$/i.test(name));
}

/** Workstation account paths, except the named examples used in fixtures and CI. */
function workstationPaths(text: string): string[] {
	const allowed: Record<string, string> = {
		robin: "the project's example person",
		runner: "the GitHub Actions account",
		example: "a neutral documentation account",
	};
	return [...text.matchAll(/\/(?:home|Users)\/([A-Za-z0-9_.-]+)\//g)]
		.filter((match) => !Object.hasOwn(allowed, match[1] ?? ""))
		.map((match) => match[0]);
}

describe("a public repository", () => {
	test("committed logs contain no absolute Mac volume or home paths", () => {
		const paths = wholeTree()
			.filter((file) => file.endsWith(".log"))
			.flatMap((file) =>
				[...readFileSync(file, "utf8").matchAll(/\/(?:Volumes|Users)\/[^\s]+/g)].map((match) => `${file}: ${match[0]}`),
			);
		expect(paths).toEqual([]);
	});

	test("no file names a private tailnet or workstation account", () => {
		// The repository has been public since 2026-10-13 (the owner); commits before that day still carry the
		// real name, and the history was not rewritten.
		expect([".env", ".env.local", ".env.example"].map((name) => LOCAL.test(name))).toEqual([true, true, false]);
		expect(foreignTailnetNames("https://mainworthy.example.ts.net and example.ts.net")).toEqual([]);
		// Built in two parts: this file is read by the check it runs.
		const foreign = `casebook.tail1a2b3.${"ts"}.net`;
		expect(foreignTailnetNames(`curl https://${foreign}/healthz`)).toEqual([foreign]);
		const found = wholeTree().flatMap((file) =>
			foreignTailnetNames(readFileSync(file, "utf8")).map((name) => `${file}: ${name}`),
		);
		expect(found).toEqual([]);
		for (const directory of ["home", "Users"]) {
			for (const account of ["robin", "runner", "example"]) {
				expect(workstationPaths(`/${directory}/${account}/project`)).toEqual([]);
			}
			for (const account of ["work-account", "account.name", "account_name", "runner2", "constructor"]) {
				const path = `/${directory}/${account}/`;
				expect(workstationPaths(`file://${path}project and C:${path}project`)).toEqual([path, path]);
			}
		}
		expect(workstationPaths("$HOME/project docs/reviews/ ./project /home/robinson")).toEqual([]);
		const paths = wholeTree().flatMap((file) =>
			workstationPaths(readFileSync(file, "utf8")).map((path) => `${file}: ${path}`),
		);
		expect(paths).toEqual([]);
	});
});

describe("the browser tests' deadlines", () => {
	// One deadline for every wait of a browser test, `SETTLES` in test/e2e/support.ts. A file's own, from 3 to 8 s,
	// measured how busy the machine was and was half of all the flaky-test issues (#672, 2026-10-20).
	const settles = Number(
		/export const SETTLES = ([\d_]+);/.exec(readFileSync("test/e2e/support.ts", "utf8"))?.[1]?.replaceAll("_", ""),
	);
	const ownDeadlines = (text: string): string[] =>
		[...text.matchAll(/setDefaultTimeout\(|setDefaultNavigationTimeout\(|timeout: ([\d_]+)/g)]
			.filter((match) => match[1] === undefined || Number(match[1].replaceAll("_", "")) < settles)
			.map((match) => match[0]);
	test("a browser test sets no deadline shorter than the suite's", () => {
		expect(ownDeadlines("page.setDefaultTimeout(5000); await x.waitFor({ timeout: 4000 });")).toEqual([
			"setDefaultTimeout(",
			"timeout: 4000",
		]);
		expect(ownDeadlines("await x.waitFor({ timeout: 30000 });")).toEqual([]);
		const found = [...new Glob("test/e2e/*.ts").scanSync(".")]
			.filter((file) => file !== "test/e2e/support.ts")
			.flatMap((file) => ownDeadlines(readFileSync(file, "utf8")).map((deadline) => `${file}: ${deadline}`));
		expect(found).toEqual([]);
	});
});
