// The rules of the module map, as failing tests (principles P9 and P10). An agent that takes the shortest path that
// compiles, and reaches across a boundary to do it, fails here with a message that says which rule and why.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Glob } from "bun";
import { Db, declaredSql } from "../src/server/kernel/db.ts";
import { migrate } from "../src/server/kernel/migrate.ts";
import { MCP_OPS, OP_LIST } from "../src/server/ops/index.ts";
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
				if (!/\bdecisionOf\(witness\)|\(ctx, witness\b/.test(body ?? ""))
					offenders.push(`${file}: ${name} never checks its witness`);
			}
		}
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

	test("a module runs SQL only on the tables it owns", () => {
		// The owner of each table. A read of another module's data goes through that module's functions, so the
		// rules about its rows live in one place and a join cannot quietly depend on another module's schema.
		const owners: Record<string, string[]> = {
			"server/kernel": ["meta", "projects", "counters", "commands"],
			"server/identity": ["orgs", "actors", "grants", "tokens"],
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
		};
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

describe("the registry", () => {
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
