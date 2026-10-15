// The rules of the module map, as failing tests (principles P9 and P10). An agent that takes the shortest path that
// compiles, and reaches across a boundary to do it, fails here with a message that says which rule and why.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { Glob } from "bun";
import { z } from "zod";
import { ERROR_CODES, HTTP_STATUS } from "../src/core/api.ts";
import { needs } from "../src/core/kinds.ts";
import { REPLIES } from "../src/core/replies.ts";
import { Db, declaredSql } from "../src/server/kernel/db.ts";
import { MIGRATIONS, migrate } from "../src/server/kernel/migrate.ts";
import { MCP_OPS, OP_LIST } from "../src/server/ops/index.ts";
import { UNEXPORTED } from "../src/server/transfer/transfer.ts";
import { openApi } from "../src/surfaces/http.ts";
import "../src/server/jobs.ts";

const files = [...new Glob("src/**/*.{ts,tsx}").scanSync(".")].filter(
	(file) => !file.endsWith(".test.ts") && !file.endsWith(".d.ts"),
);
const imports = (file: string): string[] =>
	[
		...readFileSync(file, "utf8").matchAll(
			/^\s*(?:import|export)\s[^'"]*?from\s+["']([^"']+)["']|^\s*import\s+["']([^"']+)["']/gm,
		),
	].map((m) => m[1] ?? m[2] ?? "");
const layerOf = (file: string): string => {
	const parts = file.split("/");
	return parts[1] === "server" ? `server/${parts[2]}` : (parts[1] ?? "");
};

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
			for (const match of text.matchAll(
				/^(?:export )?function\*? (\w+)\([^)]*\bwitness: Witness\b[^)]*\)[^{]*\{\n([\s\S]*?)^\}/gm,
			)) {
				const [, name, body] = match;
				if (!/\bdecisionOf\(witness, "\w+"\)|\(ctx, witness\b/.test(body ?? ""))
					offenders.push(`${file}: ${name} never checks its witness`);
			}
		}
		expect(offenders).toEqual([]);
	});

	test("the raw database handle is used only by the kernel and by the archive, which reads every table by design", () => {
		// `db.raw` runs SQL that is neither declared nor prepared against the schema. Everything else goes through
		// `sql()` in the module that owns the table.
		const offenders = files.filter(
			(file) =>
				/\.raw\b/.test(readFileSync(file, "utf8")) &&
				!file.startsWith("src/server/kernel/") &&
				!file.startsWith("src/server/transfer/") &&
				!file.startsWith("src/web/"),
		);
		expect(offenders).toEqual([]);
	});

	test("only the kernel talks to SQLite", () => {
		const offenders = files.filter(
			(file) => imports(file).includes("bun:sqlite") && !file.startsWith("src/server/kernel/"),
		);
		expect(offenders).toEqual([]);
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
		const allowed: Record<string, string[]> = {
			"server/kernel": [],
			"server/identity": ["server/kernel"],
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
			"server/transfer": ["server/kernel", "server/suite"],
			"server/trackers": ["server/kernel", "server/evidence", "server/suite"],
		};
		const offenders: string[] = [];
		for (const file of files) {
			const layer = layerOf(file);
			const may = allowed[layer];
			if (!may) continue;
			for (const path of imports(file)) {
				if (!path.startsWith(".")) continue;
				const target = layerOf(new URL(path, `file:///${file}`).pathname.slice(1));
				if (target === layer || target === "core" || may.includes(target)) continue;
				offenders.push(`${file} imports ${path} (${layer} may not import ${target})`);
			}
		}
		expect(offenders).toEqual([]);
	});

	// The owner of each table. A read of another module's data goes through that module's functions, so the
	// rules about its rows live in one place and a join cannot quietly depend on another module's schema.
	const owners: Record<string, string[]> = {
		"server/kernel": ["meta", "projects", "counters", "commands"],
		"server/identity": [
			"orgs",
			"actors",
			"grants",
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
			"tests",
			"targets",
			"changes",
			"change_ends",
			"batches",
			"signatures",
			"results",
			"flips",
			"findings",
			"reviews",
			"excuses",
		],
		"server/runs": ["runs", "run_tests", "slots", "slot_results", "depends_on"],
		"server/decisions": ["questions", "question_refs", "answers", "decisions"],
		"server/trackers": ["tracker_requests"],
	};

	test("a module runs SQL only on the tables it owns", () => {
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
		const db = new Db(":memory:");
		migrate(db, ":memory:");
		const tables = db.raw
			.query<{ name: string }, []>(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'search_docs_%'",
			)
			.all()
			.map((row) => row.name);
		db.close();
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
		// invitation's code. The three tables named here are all of identity that an archive holds. A table that
		// is added later is unexported, or it is added to these three on purpose: until then this fails, before
		// an export carries what signs somebody in.
		const exported = ["orgs", "actors", "grants"];
		const identity = owners["server/identity"] ?? [];
		// Change endings preserve the old archive version. Tracker delivery belongs to this instance and must
		// never replay after import. Neither table holds credentials.
		const other = ["change_ends", "tracker_requests"];
		expect(UNEXPORTED.filter((table) => !other.includes(table)).sort()).toEqual(
			identity.filter((table) => !exported.includes(table)).sort(),
		);
		expect(UNEXPORTED.filter((table) => other.includes(table))).toEqual(other);
	});

	test("migration versions are contiguous and in order, with exactly one matching file per entry", () => {
		expect(MIGRATIONS.map((migration) => migration.version)).toEqual(MIGRATIONS.map((_, index) => index + 1));
		const directory = "src/server/kernel/migrations";
		const filenames = MIGRATIONS.map(
			(migration) => `${String(migration.version).padStart(4, "0")}_${migration.name}.sql`,
		);
		expect(readdirSync(directory).sort()).toEqual([...filenames].sort());
		for (const [index, migration] of MIGRATIONS.entries()) {
			expect(readFileSync(`${directory}/${filenames[index]}`, "utf8")).toBe(migration.sql);
		}
	});

	test("each migration says truly whether it changes what an archive holds", () => {
		// An import requires the archive version, which is the last migration marked `archive`. A migration that
		// changes an exported table and is not marked would let an older archive in with a column missing; one
		// that is marked and changes none would refuse every archive taken before it for nothing.
		const db = new Db(":memory:");
		const exported = (): string =>
			JSON.stringify(
				db.raw
					.query<{ name: string }, []>(
						"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'search_docs%' ORDER BY name",
					)
					.all()
					.filter((table) => !UNEXPORTED.includes(table.name))
					.map((table) => [
						table.name,
						db.raw
							.query<{ name: string; type: string; notnull: number; pk: number }, []>(
								`PRAGMA table_info(${table.name})`,
							)
							.all()
							.map((column) => `${column.name} ${column.type} ${column.notnull} ${column.pk}`),
					]),
			);
		const changes: string[] = [];
		let before = exported();
		for (const migration of MIGRATIONS) {
			db.exec(migration.sql);
			const after = exported();
			changes.push(`${migration.version} ${migration.name}: ${after !== before}`);
			before = after;
		}
		db.close();
		expect(MIGRATIONS.map((migration) => `${migration.version} ${migration.name}: ${migration.archive}`)).toEqual(
			changes,
		);
	});

	test("writers that undo a withdrawn decision are called only by the kind handlers", () => {
		// These change standing without a witness on purpose: they put back what a decision did when that decision
		// is withdrawn or stops holding, which is itself a recorded event. Nothing else may reach for them.
		const undo = /\b(restoreLink|dropExcuse|reopenRun|restoreFailures)\(/;
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

	test("the columns of the app start with the sidebar's width, which one stylesheet says", () => {
		// Each screen has its own columns, and until decision 0020 each wrote the sidebar's width as a number.
		// The collapsed sidebar then had one set of columns for all of them: it took the room of Queue's and
		// Runs' right pane and of the whole of Settings. A screen that names the variable gets the collapsed
		// sidebar, and the width of a narrower window, without saying anything about either.
		const desktop = sheets.filter((file) => file !== "src/web/phone.css");
		// A rule is about the app's columns when `#app` is what its selector ends in, whatever stands before it
		// (`body #app:has(.pane)` as much as `#app.zoom`), and not when it is about something inside the app.
		const subject = (selector: string): string =>
			selector
				.replace(/\([^()]*\)|\[[^\]]*\]/g, "")
				.trim()
				.split(/[\s>+~]+/)
				.at(-1) ?? "";
		const columns = desktop.flatMap((file) =>
			[
				...readFileSync(file, "utf8")
					.replace(/\/\*[\s\S]*?\*\//g, "")
					.matchAll(/(?<=^|[{}])\s*([^{}@]+?)\s*\{([^{}]*)\}/g),
			].flatMap((rule) => {
				const selectors = (rule[1] ?? "").replace(/\([^()]*\)/g, "()").split(",");
				const found = /grid-template-columns:\s*([^;]+);/.exec(rule[2] ?? "");
				return found && selectors.some((selector) => subject(selector).startsWith("#app"))
					? [{ file, selector: (rule[1] ?? "").replace(/\s+/g, " "), columns: (found[1] ?? "").replace(/\s+/g, " ") }]
					: [];
			}),
		);
		// The five screens, at three widths of the window each, and the widened case pane.
		expect(columns.length).toBeGreaterThanOrEqual(16);
		expect(columns.filter((rule) => !rule.columns.startsWith("var(--side-width) "))).toEqual([]);
		expect(
			desktop.filter(
				(file) => file !== "src/web/base.css" && /--side-(width|open|freed)\s*:/.test(readFileSync(file, "utf8")),
			),
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

	test("every statement the server can run prepares against the schema", () => {
		const db = new Db(":memory:");
		migrate(db, ":memory:");
		const broken: string[] = [];
		for (const text of declaredSql()) {
			try {
				db.raw.prepare(text).finalize();
			} catch (error) {
				broken.push(
					`${error instanceof Error ? error.message : error}\n  in: ${text.replace(/\s+/g, " ").slice(0, 160)}`,
				);
			}
		}
		db.close();
		expect(broken).toEqual([]);
		expect(declaredSql().length).toBeGreaterThan(150);
	});

	test("every operation is declared once, with a summary; the agent surface is at most ten tools", () => {
		expect(new Set(OP_LIST.map((op) => op.name)).size).toBe(OP_LIST.length);
		for (const op of OP_LIST) expect(op.summary.length).toBeGreaterThan(20);
		expect(MCP_OPS.length).toBeLessThanOrEqual(10);
	});

	test("a pipeline's token reaches three operations: report, change and gate", () => {
		// `record` is all a pipeline's token holds by default, so an operation that accepts it is one more thing a
		// secret in a CI system can do. Adding to this list is a decision (docs/decisions/0014), not a copy of the
		// nearest operation: `change`, which says that a pull request ended, came with decision 0022. `gate` is
		// also the one operation that accepts either of two capabilities.
		const accepts = (capability: "record" | "read") =>
			OP_LIST.filter((op) => needs(op.needs).includes(capability)).map((op) => op.name);
		expect(accepts("record")).toEqual(["report", "change", "gate"]);
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

describe("the project's name", () => {
	test("the former name appears only where an install or a deployment still carries it", () => {
		// The project was called Casebook until 2026-10-13 (decision 0015). Each file here says why it still
		// says so. A new mention anywhere else fails: use the current name, or add the file with its reason.
		const allowed: Record<string, string> = {
			".gitignore": "a checkout made before the rename keeps its `.casebook` directory",
			"AGENTS.md": "says what the project was called, and releases the `.casebook` of an older checkout",
			"CHANGELOG.md": "the entry for the rename",
			"README.md": "says what the project was called",
			"compose.coolify.yaml": "the names the existing deployment stored",
			"docs/decisions/0014-pipeline-token-and-ci-instance.md": "the address of the existing deployment",
			"docs/decisions/0015-the-project-is-called-mainworthy.md": "the decision",
			"docs/deploy.md": "the existing deployment's names, and how to move them",
			"src/cli/startup.test.ts": "starts the server on an install under the former name",
			"src/server/kernel/former-name.test.ts": "the carry-over of a former install",
			"src/server/kernel/former-name.ts": "the carry-over of a former install",
			"src/server/kernel/migrations/0001_init.sql": "a shipped migration is never edited",
			"src/server/transfer/transfer.test.ts": "an archive exported under the former name",
			"src/server/transfer/transfer.ts": "an archive exported under the former name",
			"src/surfaces/formats/junit.test.ts": "a report that names its case with the former property",
			"src/surfaces/formats/junit.ts": "a report that names its case with the former property",
			"src/web/lib/former-name.test.ts": "what a browser kept under the former name",
			"src/web/lib/former-name.ts": "what a browser kept under the former name",
			"t3.json": "releases the `.casebook` of an older checkout",
			"test/architecture.test.ts": "this list",
			"test/e2e/shell.test.ts": "what a browser kept under the former name",
		};
		const outside = new Set([".git", "node_modules", "dist", ".mainworthy", ".casebook", "test-results"]);
		const binary = /\.(png|jpe?g|gif|ico|gz|db|db-wal|db-shm)$/;
		// Bun writes an executable it is building to `.<hash>-<number>.bun-build` in the directory it was started
		// in, and removes it. `test/headers.test.ts` builds one from here beside this test, and that file holds the
		// whole source: seen in that moment it failed this test (2026-10-13, on macOS, in one check of two).
		const local = /^(\.env|bench\/results-.*\.json$|\.[0-9a-f]+-[0-9a-f]+\.bun-build$)/;
		const found = readdirSync(".", { withFileTypes: true })
			.filter((entry) => !outside.has(entry.name))
			.flatMap((entry) =>
				entry.isDirectory() ? [...new Glob(`${entry.name}/**/*`).scanSync({ cwd: ".", dot: true })] : [entry.name],
			)
			.filter((file) => !binary.test(file) && !local.test(file))
			.filter((file) => /casebook/i.test(readFileSync(file, "utf8")));
		expect(found.sort()).toEqual(Object.keys(allowed).sort());
	});
});
