// PostgreSQL for this checkout. No installed imports: preflight also runs before bun install.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { make, remove } from "./work/scratch.ts";

export const POSTGRES_MISSING =
	"PostgreSQL 18 is required: set MAINWORTHY_TEST_PG to a database URL or install PostgreSQL 18 and set MAINWORTHY_PG_BIN (see compose.yaml).";
export function binaries(): string | null {
	const pgConfig = Bun.which("pg_config");
	const configured = pgConfig
		? Bun.spawnSync([pgConfig, "--bindir"], { stdout: "pipe", stderr: "pipe" }).stdout.toString().trim()
		: "";
	for (const directory of [
		process.env.MAINWORTHY_PG_BIN,
		configured,
		"/opt/homebrew/opt/postgresql@18/bin",
		"/usr/lib/postgresql/18/bin",
	]) {
		if (!directory || !["initdb", "pg_ctl", "postgres"].every((name) => existsSync(join(directory, name)))) continue;
		const version = Bun.spawnSync([join(directory, "postgres"), "--version"], { stdout: "pipe", stderr: "pipe" });
		if (version.exitCode === 0 && /\b18(?:\.|\b)/.test(version.stdout.toString())) return directory;
	}
	return null;
}
export type Cluster = { adminUrl: string; directory: string | null; owned: boolean; startMs: number };
type Stored = { directory: string; port: number; bin: string; startMs: number };
const checkout = realpathSync(resolve(import.meta.dir, ".."));
const id = createHash("sha256").update(checkout).digest("hex").slice(0, 16);
const stateRoot = join(homedir(), ".cache", "mainworthy", "pg");
const stateFile = join(stateRoot, `${id}.json`);
const lockDir = join(stateRoot, `${id}.lock`);
function stored(): Stored | null {
	if (!existsSync(stateFile)) return null;
	const value: unknown = JSON.parse(readFileSync(stateFile, "utf8"));
	if (typeof value !== "object" || value === null) throw new Error("invalid checkout PostgreSQL metadata");
	const directory: unknown = Reflect.get(value, "directory");
	const port: unknown = Reflect.get(value, "port");
	const bin: unknown = Reflect.get(value, "bin");
	const startMs: unknown = Reflect.get(value, "startMs");
	if (
		typeof directory !== "string" ||
		typeof port !== "number" ||
		typeof bin !== "string" ||
		typeof startMs !== "number"
	)
		throw new Error("invalid checkout PostgreSQL metadata");
	return { directory, port, bin, startMs };
}
async function command(args: string[]): Promise<void> {
	const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
	const [rc, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	if (rc !== 0) throw new Error(`${args[0]?.split("/").at(-1)} failed: ${(stderr || stdout).trim().slice(-1000)}`);
}
function running(state: Stored): boolean {
	return (
		Bun.spawnSync([join(state.bin, "pg_ctl"), "-D", join(state.directory, "data"), "status"], {
			stdout: "pipe",
			stderr: "pipe",
		}).exitCode === 0
	);
}
async function exclusive<T>(fn: () => Promise<T>): Promise<T> {
	mkdirSync(stateRoot, { recursive: true });
	const deadline = Date.now() + 30_000;
	for (;;) {
		try {
			mkdirSync(lockDir);
			writeFileSync(join(lockDir, "pid"), String(process.pid));
			break;
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
			try {
				const pid = Number(readFileSync(join(lockDir, "pid"), "utf8"));
				try {
					process.kill(pid, 0);
				} catch {
					rmSync(lockDir, { recursive: true, force: true });
					continue;
				}
			} catch {
				// The owner writes its pid synchronously; an old empty lock was interrupted.
				const lock = statSync(lockDir, { throwIfNoEntry: false });
				if (!lock) continue;
				if (Date.now() - lock.mtimeMs > 2_000) rmSync(lockDir, { recursive: true, force: true });
			}
			if (Date.now() > deadline) throw new Error("timed out waiting for checkout PostgreSQL startup");
			await Bun.sleep(25);
		}
	}
	try {
		return await fn();
	} finally {
		rmSync(lockDir, { recursive: true, force: true });
	}
}
async function freePort(): Promise<number> {
	const port = await new Promise<number>((resolvePort, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close();
				reject(new Error("no TCP port"));
				return;
			}
			server.close((error) => (error ? reject(error) : resolvePort(address.port)));
		});
	});
	return port > 20_000 ? port : freePort();
}
function describe(state: Stored): Cluster {
	return {
		adminUrl: `postgres://postgres@127.0.0.1:${state.port}/postgres`,
		directory: state.directory,
		owned: true,
		startMs: state.startMs,
	};
}
export async function cluster(): Promise<Cluster> {
	if (process.env.MAINWORTHY_TEST_PG)
		return { adminUrl: process.env.MAINWORTHY_TEST_PG, directory: null, owned: false, startMs: 0 };
	return exclusive(async () => {
		let state = stored();
		if (state && running(state)) return describe(state);
		const bin = binaries();
		if (!bin) throw new Error(POSTGRES_MISSING);
		const start = performance.now();
		if (!state) {
			const directory = make(`pg-${id}`);
			state = { directory, port: await freePort(), bin, startMs: 0 };
			writeFileSync(stateFile, JSON.stringify(state));
		}
		const data = join(state.directory, "data");
		if (!existsSync(join(data, "PG_VERSION"))) {
			await command([
				join(bin, "initdb"),
				"-D",
				data,
				"-U",
				"postgres",
				"--auth=trust",
				"--encoding=UTF8",
				"--locale=C",
			]);
		}
		writeFileSync(
			join(data, "postgresql.auto.conf"),
			"listen_addresses = '127.0.0.1'\nunix_socket_directories = ''\nmax_connections = 300\n",
		);
		state.port = await freePort();
		state.bin = bin;
		writeFileSync(stateFile, JSON.stringify(state));
		await command([
			join(bin, "pg_ctl"),
			"-D",
			data,
			"-l",
			join(state.directory, "postgres.log"),
			"-o",
			`-p ${state.port}`,
			"-w",
			"start",
		]);
		state.startMs = performance.now() - start;
		writeFileSync(stateFile, JSON.stringify(state));
		return describe(state);
	});
}
export async function clusterStatus(): Promise<Cluster | null> {
	if (process.env.MAINWORTHY_TEST_PG)
		return { adminUrl: process.env.MAINWORTHY_TEST_PG, directory: null, owned: false, startMs: 0 };
	const state = stored();
	return state && running(state) ? describe(state) : null;
}
export async function stopCluster(): Promise<string> {
	return exclusive(async () => {
		const state = stored();
		if (!state || !running(state)) return "checkout PostgreSQL is stopped";
		await command([join(state.bin, "pg_ctl"), "-D", join(state.directory, "data"), "-m", "fast", "-w", "stop"]);
		return "stopped checkout PostgreSQL";
	});
}
export async function removeCluster(): Promise<string> {
	return exclusive(async () => {
		const state = stored();
		if (!state) return "no checkout PostgreSQL to delete";
		if (running(state))
			await command([join(state.bin, "pg_ctl"), "-D", join(state.directory, "data"), "-m", "fast", "-w", "stop"]);
		remove(state.directory);
		rmSync(stateFile);
		return "deleted checkout PostgreSQL";
	});
}
if (import.meta.main) {
	const action = process.argv[2] ?? "start";
	if (action === "stop") console.log(await stopCluster());
	else if (action === "delete") console.log(await removeCluster());
	else if (action === "status") console.log(JSON.stringify(await clusterStatus()));
	else if (action === "start" || action === "url")
		console.log(action === "url" ? (await cluster()).adminUrl : JSON.stringify(await cluster()));
	else if (action === "dev") {
		const url = process.env.MAINWORTHY_DATABASE_URL ?? (await cluster()).adminUrl;
		const child = Bun.spawn([process.execPath, "--watch", "src/cli/main.ts", "serve"], {
			cwd: checkout,
			env: { ...process.env, MAINWORTHY_DATABASE_URL: url },
			stdin: "inherit",
			stdout: "inherit",
			stderr: "inherit",
		});
		process.exit(await child.exited);
	} else throw new Error("usage: bun scripts/pg.ts start|url|status|stop|delete|dev");
}
