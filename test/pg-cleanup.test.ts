import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { binaries } from "../scripts/pg.ts";
import { make, remove } from "../scripts/work/scratch.ts";

const stateSchema = z.object({ directory: z.string(), port: z.number(), bin: z.string(), startMs: z.number() });
const key = (checkout: string) => createHash("sha256").update(checkout).digest("hex").slice(0, 16);

async function fixture() {
	const root = make("pg-cleanup-test");
	const home = join(root, "home");
	const cache = join(home, ".cache");
	mkdirSync(cache, { recursive: true });
	const bin = binaries();
	if (!bin) throw new Error("the cluster cleanup regression needs PostgreSQL 18 binaries");
	const env = { ...process.env, HOME: home, MAINWORTHY_TEST_PG: "", MAINWORTHY_PG_BIN: bin };
	const states: z.infer<typeof stateSchema>[] = [];
	const run = async (args: string[]) => {
		const child = Bun.spawn([process.execPath, ...args], { env, stdout: "pipe", stderr: "pipe" });
		const [out, err, rc] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(rc, out + err).toBe(0);
		return out.trim();
	};
	const exported = (parent = cache) => {
		const checkout = make("review-export", parent);
		cpSync("scripts", join(checkout, "scripts"), { recursive: true });
		return checkout;
	};
	const metadata = (checkout: string) => join(cache, "mainworthy/pg", `${key(checkout)}.json`);
	const pg = (checkout: string, ...args: string[]) => run([join(checkout, "scripts/pg.ts"), ...args]);
	const start = async (checkout: string) => {
		await pg(checkout, "start");
		const state = stateSchema.parse(JSON.parse(readFileSync(metadata(checkout), "utf8")));
		states.push(state);
		return state;
	};
	const available = async (state: z.infer<typeof stateSchema>) => {
		const sql = new Bun.SQL(`postgres://postgres@127.0.0.1:${state.port}/postgres`);
		try {
			expect(await sql.unsafe<{ n: number }[]>("SELECT 1::integer AS n")).toEqual([{ n: 1 }]);
		} finally {
			await sql.close();
		}
	};
	const gone = (checkout: string, state: z.infer<typeof stateSchema>, pid: number) => {
		expect(() => process.kill(pid, 0)).toThrow();
		expect(existsSync(state.directory)).toBe(false);
		expect(existsSync(metadata(checkout))).toBe(false);
	};
	return {
		cache,
		exported,
		metadata,
		pg,
		run,
		start,
		available,
		gone,
		async close() {
			const registry = join(cache, "mainworthy/pg");
			for (const name of existsSync(registry) ? readdirSync(registry) : []) {
				if (name.endsWith(".json"))
					states.push(stateSchema.parse(JSON.parse(readFileSync(join(registry, name), "utf8"))));
			}
			for (const state of states)
				Bun.spawnSync([join(bin, "pg_ctl"), "-D", join(state.directory, "data"), "-m", "immediate", "-w", "stop"]);
			remove(root);
		},
	};
}
const pidOf = (directory: string) =>
	Number(readFileSync(join(directory, "data/postmaster.pid"), "utf8").split("\n")[0]);

test("startup reaps deleted exports, keeps existing checkout clusters, and finishes interrupted deletion", async () => {
	const f = await fixture();
	try {
		const deleted = f.exported(),
			keeper = f.exported();
		const orphan = await f.start(deleted),
			existing = await f.start(keeper);
		const pid = pidOf(orphan.directory);
		expect(JSON.parse(readFileSync(f.metadata(deleted), "utf8")).checkout).toBe(deleted);
		rmSync(deleted, { recursive: true });
		await f.pg(keeper, "start");
		f.gone(deleted, orphan, pid);
		await f.available(existing);

		const stoppedCheckout = f.exported();
		const stopped = await f.start(stoppedCheckout);
		await f.pg(stoppedCheckout, "stop");
		rmSync(stoppedCheckout, { recursive: true });
		rmSync(stopped.directory, { recursive: true });
		await f.pg(keeper, "start");
		expect(existsSync(f.metadata(stoppedCheckout))).toBe(false);
		await f.available(existing);
	} finally {
		await f.close();
	}
}, 120_000);

test("scratch deletion stops a nested export before returning and handles legacy ownership", async () => {
	const f = await fixture();
	try {
		const parent = make("review", f.cache);
		const nested = f.exported(parent),
			keeper = f.exported();
		const orphan = await f.start(nested),
			existing = await f.start(keeper);
		const pid = pidOf(orphan.directory);
		writeFileSync(f.metadata(nested), JSON.stringify(orphan));
		await f.run([join(keeper, "scripts/work.ts"), "scratch", "rm", parent]);
		f.gone(nested, orphan, pid);
		await f.available(existing);
	} finally {
		await f.close();
	}
}, 120_000);

test("legacy metadata and unreferenced data require a matching absent checkout path", async () => {
	const f = await fixture();
	try {
		const deleted = f.exported(),
			keeper = f.exported();
		const orphan = await f.start(deleted),
			existing = await f.start(keeper);
		writeFileSync(f.metadata(deleted), JSON.stringify({ ...orphan, bin: join(f.cache, "removed-binaries") }));
		writeFileSync(f.metadata(keeper), JSON.stringify(existing));
		await f.pg(deleted, "stop");
		rmSync(deleted, { recursive: true });
		await f.pg(keeper, "start");
		expect(existsSync(orphan.directory)).toBe(true);
		expect(JSON.parse(readFileSync(f.metadata(keeper), "utf8")).checkout).toBe(keeper);
		await f.pg(keeper, "stop");
		await f.pg(keeper, "cleanup", keeper);
		expect(existsSync(existing.directory)).toBe(true);
		expect(existsSync(f.metadata(keeper))).toBe(true);
		const restarted = await f.start(keeper);
		expect(restarted.directory).toBe(existing.directory);
		await f.available(restarted);
		expect(existsSync(orphan.directory)).toBe(true);
		await f.pg(keeper, "cleanup", deleted);
		expect(existsSync(orphan.directory)).toBe(false);
		expect(existsSync(f.metadata(deleted))).toBe(false);

		const lost = f.exported();
		const unreferenced = await f.start(lost);
		await f.pg(lost, "stop");
		rmSync(f.metadata(lost));
		rmSync(lost, { recursive: true });
		await f.pg(keeper, "cleanup");
		expect(existsSync(unreferenced.directory)).toBe(true);
		await f.pg(keeper, "cleanup", lost);
		expect(existsSync(unreferenced.directory)).toBe(false);
		await f.available(restarted);
	} finally {
		await f.close();
	}
}, 120_000);

// The CLI can be running from the export that it deletes.
test("scratch deletion loads cleanup before removing its own checkout", async () => {
	const f = await fixture();
	try {
		const self = f.exported(),
			keeper = f.exported();
		const orphan = await f.start(self),
			existing = await f.start(keeper);
		const pid = pidOf(orphan.directory);
		await f.run([join(self, "scripts/work.ts"), "scratch", "rm", self]);
		f.gone(self, orphan, pid);
		await f.available(existing);
	} finally {
		await f.close();
	}
}, 120_000);

test("damaged abandoned clusters cannot prevent another checkout from starting", async () => {
	const f = await fixture();
	try {
		const deleted = f.exported(),
			keeper = f.exported();
		const orphan = await f.start(deleted);
		await f.pg(deleted, "stop");
		const metadata = readFileSync(f.metadata(deleted), "utf8");
		rmSync(deleted, { recursive: true });
		const marker = join(orphan.directory, ".mw-scratch");
		rmSync(marker);
		await f.pg(keeper, "start");
		expect(existsSync(orphan.directory)).toBe(true);
		const strict = Bun.spawnSync([process.execPath, join(keeper, "scripts/pg.ts"), "cleanup"], {
			env: { ...process.env, HOME: join(f.cache, ".."), MAINWORTHY_TEST_PG: "", MAINWORTHY_PG_BIN: binaries() ?? "" },
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(strict.exitCode).not.toBe(0);
		expect(strict.stderr.toString()).toContain("was not made by");
		writeFileSync(marker, `${orphan.directory}\n`);
		writeFileSync(f.metadata(deleted), "{");
		await f.pg(keeper, "start");
		expect(existsSync(orphan.directory)).toBe(true);
		writeFileSync(f.metadata(deleted), metadata);
		rmSync(join(orphan.directory, "data/PG_VERSION"));
		writeFileSync(join(orphan.directory, "data/postmaster.pid"), `${process.pid}\n`);
		await f.pg(keeper, "start");
		expect(existsSync(orphan.directory)).toBe(true);
		rmSync(join(orphan.directory, "data/postmaster.pid"));
		await f.pg(keeper, "start");
		expect(existsSync(orphan.directory)).toBe(false);
		const existing = await f.start(keeper);
		await f.available(existing);
	} finally {
		await f.close();
	}
}, 120_000);
