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
		const minters = files.filter(
			(file) =>
				/\bmintWitness\b|Witness\.mint\b/.test(readFileSync(file, "utf8")) && !file.endsWith("kernel/witness.ts"),
		);
		expect(minters).toEqual(["src/server/decisions/decisions.ts"]);
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
