import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { API } from "typescript/unstable/async";
import { planAsyncPort } from "../scripts/async-port.ts";

const root = resolve(import.meta.dir, "..");
const scratchCommand = Bun.spawnSync(["bun", "scripts/work.ts", "scratch", "new", "async-port-test"], { cwd: root });
if (scratchCommand.exitCode !== 0) throw new Error(scratchCommand.stderr.toString());
const scratch = scratchCommand.stdout.toString().trim();
afterAll(() => {
	const cleanup = Bun.spawnSync(["bun", "scripts/work.ts", "scratch", "rm", scratch], { cwd: root });
	if (cleanup.exitCode !== 0) throw new Error(cleanup.stderr.toString());
});
const fixture = (name: string): string => readFileSync(join(root, "scripts/async-port", name), "utf8");
function prepare(name: string, source: string): string {
	const dir = join(scratch, name);
	mkdirSync(join(dir, "src/server/kernel"), { recursive: true });
	writeFileSync(join(dir, "src/server/kernel/db.ts"), fixture("kernel.ts.txt"));
	writeFileSync(join(dir, "src/server/kernel/app.ts"), fixture("app.ts.txt"));
	writeFileSync(join(dir, "use.ts"), source);
	writeFileSync(
		join(dir, "tsconfig.json"),
		JSON.stringify({
			compilerOptions: {
				strict: true,
				target: "esnext",
				module: "preserve",
				noEmit: true,
				allowImportingTsExtensions: true,
			},
			include: ["**/*.ts"],
		}),
	);
	return dir;
}

async function semanticDiagnostics(dir: string) {
	const api = new API({ cwd: dir });
	try {
		const snapshot = await api.updateSnapshot({ openProjects: [join(dir, "tsconfig.json")] });
		try {
			return await snapshot.getProjects()[0]?.program.getSemanticDiagnostics();
		} finally {
			await snapshot.dispose();
		}
	} finally {
		await api.close();
	}
}

describe("async port compiler conversion", () => {
	for (const name of ["safe", "refusals", "generators", "last-id", "reader", "unsupported"]) {
		test(`${name}: formatted golden output and a second pass changes nothing`, async () => {
			const dir = prepare(name, fixture(`${name}.input.ts.txt`));
			const plan = await planAsyncPort({ root: dir });
			const output = plan.changes.find((change) => change.file === "use.ts")?.after ?? fixture(`${name}.input.ts.txt`);
			expect(output).toBe(fixture(`${name}.expected.ts.txt`));
			for (const change of plan.changes) writeFileSync(join(dir, change.file), change.after);
			const second = await planAsyncPort({ root: dir });
			expect(second.changes).toEqual([]);
			if (name === "safe" || name === "generators") {
				expect(plan.diagnostics).toEqual([]);
				expect(await semanticDiagnostics(dir)).toEqual([]);
			}
			if (name === "refusals") {
				expect(plan.counts.refusals["boolean-position"]).toBe(5);
				expect(plan.counts.refusals["array-callback"]).toBe(2);
				expect(plan.counts.refusals["sync-callback"]).toBeGreaterThanOrEqual(2);
				expect(plan.counts.refusals["constructor-accessor-field"]).toBeGreaterThanOrEqual(4);
			}
			if (name === "last-id") expect(second.counts.refusals["returning-id"]).toBe(4);
			if (name === "reader") expect(plan.counts.refusals["reader-scope"]).toBe(3);
			if (name === "unsupported") {
				expect(plan.counts.refusals["external-contract"]).toBe(2);
				expect(plan.counts.refusals["unresolved-call"]).toBe(1);
			}
		});
	}
	test("handled promise uses preserve expectations, concurrency, identity and callbacks", async () => {
		const dir = prepare("handled", fixture("handled.input.ts.txt"));
		const plan = await planAsyncPort({ root: dir });
		expect(plan.diagnostics).toEqual([]);
		expect(plan.pendingCalls).toEqual([]);
		expect(plan.changes).toEqual([]);
		expect(await semanticDiagnostics(dir)).toEqual([]);
	});

	test("handled calls still colour async and promise-chain wrappers for their unhandled callers", async () => {
		const dir = prepare(
			"floating-wrappers",
			`
import type { ReadDb } from "./src/server/kernel/db.ts";
declare const db: ReadDb;
async function read() { return await db.get("SELECT x"); }
function chain() { return db.get("SELECT x").then((value) => value); }
export async function caller() { read(); chain(); }
`,
		);
		const plan = await planAsyncPort({ root: dir });
		expect(plan.diagnostics).toEqual([]);
		expect(plan.pendingCalls).toHaveLength(2);
		const output = plan.changes.find((change) => change.file === "use.ts")?.after;
		expect(output).toContain("await read()");
		expect(output).toContain("await chain()");
	});

	test("opaque data consumers receive the value when a synchronous call becomes async", async () => {
		const dir = prepare(
			"opaque-data",
			`
import type { ReadDb } from "./src/server/kernel/db.ts";
declare function parse(value: unknown): { x: number };
declare function postMessage(value: unknown): void;
declare function expect<T>(value: T): { resolves: { toBe(value: unknown): Promise<void> } };
function changed(db: ReadDb) { db.get("SELECT x"); return { x: 1 }; }
export function parsed(db: ReadDb) { return parse(changed(db)).x; }
export function sent(db: ReadDb) { const value = changed(db); postMessage({ value }); }
export async function dataObject(db: ReadDb): Promise<{ value: { x: number } }> {
 const value = changed(db); return { value };
}
export async function collected(db: ReadDb) {
 await Promise.all([changed(db)]);
 await expect(changed(db)).resolves.toBe({ x: 1 });
}
`,
		);
		const plan = await planAsyncPort({ root: dir });
		expect(plan.diagnostics).toEqual([]);
		const output = plan.changes.find((change) => change.file === "use.ts")?.after;
		expect(output).toContain("parse(await changed(db))");
		expect(output).toContain("const value = await changed(db)");
		expect(output).toContain("Promise.all([changed(db)])");
		expect(output).toContain("expect(changed(db)).resolves");
		for (const change of plan.changes) writeFileSync(join(dir, change.file), change.after);
		expect(await semanticDiagnostics(dir)).toEqual([]);
	});

	test("returned promises colour the enclosing function through branches and bindings", async () => {
		const dir = prepare(
			"forwarded-values",
			`
import type { ReadDb } from "./src/server/kernel/db.ts";
function changed(db: ReadDb) { db.get("SELECT x"); return { x: 1 }; }
function branch(db: ReadDb, flag: boolean): { x: number } { return flag ? changed(db) : changed(db); }
function parked(db: ReadDb): { x: number } { const value = changed(db); return value; }
export function caller(db: ReadDb) { return branch(db, true).x + parked(db).x; }
`,
		);
		const plan = await planAsyncPort({ root: dir });
		expect(plan.diagnostics).toEqual([]);
		const output = plan.changes.find((change) => change.file === "use.ts")?.after;
		expect(output).toContain("async function branch");
		expect(output).toContain("async function parked");
		for (const change of plan.changes) writeFileSync(join(dir, change.file), change.after);
		expect(await semanticDiagnostics(dir)).toEqual([]);
		expect((await planAsyncPort({ root: dir })).changes).toEqual([]);
	});

	test("a future async colour does not turn value comparisons into promise identity or presence", async () => {
		const dir = prepare(
			"value-comparisons",
			`
import type { ReadDb } from "./src/server/kernel/db.ts";
function scalar(db: ReadDb): number { db.get("SELECT x"); return 1; }
export function compare(db: ReadDb) { const value = scalar(db); return value === scalar(db); }
function optional<T>(db: ReadDb, value: T): T | undefined { db.get("SELECT x"); return value; }
export function presence<T>(db: ReadDb, value: T) { return !optional(db, value); }
`,
		);
		const plan = await planAsyncPort({ root: dir });
		expect(plan.changes.find((change) => change.file === "use.ts")?.after).toContain("const value = await scalar(db)");
		expect(plan.counts.refusals["boolean-position"]).toBe(2);
	});

	test("one invocation reaches the compiler inference fixpoint", async () => {
		const dir = prepare("fixpoint", fixture("fixpoint.input.ts.txt"));
		const plan = await planAsyncPort({ root: dir });
		expect(plan.diagnostics).toEqual([]);
		expect(plan.changes.find((change) => change.file === "use.ts")?.after).toContain('await db.get("SELECT x")');
		for (const change of plan.changes) writeFileSync(join(dir, change.file), change.after);
		const second = await planAsyncPort({ root: dir });
		expect(second.changes).toEqual([]);
		expect(second.pendingCalls).toEqual([]);
	});

	test("removed Db export remains resolvable in the virtual compiler view, including aliased imports", async () => {
		const dir = prepare(
			"removed-db",
			fixture("safe.input.ts.txt").replace("{ Db }", "{ Db as Handle }").replaceAll(": Db", ": Handle"),
		);
		writeFileSync(
			join(dir, "src/server/kernel/db.ts"),
			fixture("kernel.ts.txt").replace("export type Db = WriteDb;\n", ""),
		);
		const plan = await planAsyncPort({ root: dir });
		expect(plan.diagnostics).toEqual([]);
		expect(plan.changes.find((change) => change.file === "use.ts")?.after).toBe(fixture("safe.expected.ts.txt"));
		expect(readFileSync(join(dir, "src/server/kernel/db.ts"), "utf8")).not.toContain("export type Db");
	});

	test("check succeeds on a clean output and stays red for refusal-only output", async () => {
		for (const [name, rc] of [
			["safe", 0],
			["handled", 0],
			["last-id", 1],
		] satisfies [string, number][]) {
			const source = fixture(`${name}.${name === "handled" ? "input" : "expected"}.ts.txt`);
			const dir = prepare(`check-${name}`, source);
			const child = Bun.spawn(["bun", join(root, "scripts/async-port.ts"), "--root", dir, "--check"], {
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, code] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			expect(stderr).toBe("");
			expect(code).toBe(rc);
			expect(stdout).not.toContain("would change");
			expect(readFileSync(join(dir, "use.ts"), "utf8")).toBe(source);
		}
	});

	test("CLI dry-run and check report work without writing; seed files resolve aliases", async () => {
		const dir = prepare(
			"cli",
			"function source(): number { return 1; }\nexport { source as renamed };\nexport function caller() { return source(); }\n",
		);
		writeFileSync(
			join(dir, "alias.ts"),
			'import { renamed as imported } from "./use.ts"; export function aliasCaller() { return imported(); }\n',
		);
		writeFileSync(join(dir, "seeds.json"), JSON.stringify([{ file: "use.ts", name: "source" }]));
		const run = async (mode: string) => {
			const child = Bun.spawn(
				["bun", join(root, "scripts/async-port.ts"), "--root", dir, "--seeds", "seeds.json", mode],
				{ stdout: "pipe", stderr: "pipe" },
			);
			const [stdout, stderr, rc] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			return { stdout, stderr, rc };
		};
		const before = readFileSync(join(dir, "use.ts"), "utf8");
		const dry = await run("--dry-run");
		expect(dry.stderr).toBe("");
		expect(dry.rc).toBe(0);
		expect(dry.stdout).toContain("would change use.ts");
		expect(dry.stdout).toContain("would change alias.ts");
		expect(readFileSync(join(dir, "use.ts"), "utf8")).toBe(before);
		const check = await run("--check");
		expect(check.rc).toBe(1);
		expect(check.stdout).toContain("would change use.ts");
		expect(readFileSync(join(dir, "use.ts"), "utf8")).toBe(before);
	});
});
