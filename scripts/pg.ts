// PostgreSQL for this checkout. No installed imports: preflight also runs before bun install.
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { defaultRoot, make, refusal } from "./work/scratch.ts";

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
type Stored = { directory: string; port: number; bin: string; startMs: number; checkout: string | null };
type ClusterFiles = Pick<Stored, "directory"> & { bin: string | null };
const checkout = realpathSync(resolve(import.meta.dir, ".."));
const checkoutId = (path: string): string => createHash("sha256").update(path).digest("hex").slice(0, 16);
const id = checkoutId(checkout);
const stateRoot = join(homedir(), ".cache", "mainworthy", "pg");
const stateFile = join(stateRoot, `${id}.json`);
function stored(file = stateFile): Stored | null {
	if (!existsSync(file)) return null;
	const value: unknown = JSON.parse(readFileSync(file, "utf8"));
	if (typeof value !== "object" || value === null) throw new Error("invalid checkout PostgreSQL metadata");
	const directory: unknown = Reflect.get(value, "directory");
	const port: unknown = Reflect.get(value, "port");
	const bin: unknown = Reflect.get(value, "bin");
	const startMs: unknown = Reflect.get(value, "startMs");
	const owner: unknown = Reflect.get(value, "checkout");
	if (
		typeof directory !== "string" ||
		typeof port !== "number" ||
		typeof bin !== "string" ||
		typeof startMs !== "number" ||
		(owner !== undefined && typeof owner !== "string")
	)
		throw new Error("invalid checkout PostgreSQL metadata");
	return { directory, port, bin, startMs, checkout: typeof owner === "string" ? owner : null };
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
function controlBinaries(state: Pick<ClusterFiles, "bin">): string {
	if (state.bin && existsSync(join(state.bin, "pg_ctl"))) return state.bin;
	const bin = binaries();
	if (!bin) throw new Error(POSTGRES_MISSING);
	return bin;
}
function running(state: ClusterFiles): boolean {
	const data = join(state.directory, "data");
	if (!existsSync(join(data, "postmaster.pid"))) return false;
	const result = Bun.spawnSync([join(controlBinaries(state), "pg_ctl"), "-D", data, "status"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode === 0) return true;
	if (result.exitCode === 3 || !existsSync(join(data, "postmaster.pid"))) return false;
	throw new Error(`cannot establish checkout PostgreSQL status: ${result.stderr.toString().trim()}`);
}
async function exclusive<T>(fn: () => Promise<T>, clusterId = id): Promise<T> {
	const lockDir = join(stateRoot, `${clusterId}.lock`);
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
function save(file: string, state: Stored): void {
	writeFileSync(`${file}.tmp`, JSON.stringify(state));
	renameSync(`${file}.tmp`, file);
}
function validateDirectory(directory: string, clusterId: string): void {
	if (!basename(directory).startsWith(`mw-pg-${clusterId}-`))
		throw new Error("cluster directory does not match its id");
	if (existsSync(directory)) {
		const why = refusal(directory);
		if (why !== null) throw new Error(why);
	} else if (resolve(directory, "..") !== realpathSync(defaultRoot())) {
		throw new Error("cluster directory is outside the scratch root");
	}
}
async function deleteState(state: ClusterFiles, clusterId: string): Promise<void> {
	validateDirectory(state.directory, clusterId);
	if (running(state))
		await command([
			join(controlBinaries(state), "pg_ctl"),
			"-D",
			join(state.directory, "data"),
			"-m",
			"fast",
			"-w",
			"stop",
		]);
	rmSync(state.directory, { recursive: true, force: true });
}
/** A path supplied for legacy recovery must be the original absolute checkout path, not a guess from its id. */
export async function cleanupClusters(
	paths: string[] = [],
	{ strict = true }: { strict?: boolean } = {},
): Promise<string[]> {
	const retained: string[] = [];
	mkdirSync(stateRoot, { recursive: true });
	const owners = new Map(
		[checkout, ...paths].map((path) => {
			const owner = existsSync(path) ? realpathSync(path) : resolve(path);
			return [checkoutId(owner), owner];
		}),
	);
	const ids = new Set(
		readdirSync(stateRoot).flatMap((name) => (/^[a-f0-9]{16}\.json$/.test(name) ? [name.slice(0, -5)] : [])),
	);
	for (const clusterId of owners.keys()) ids.add(clusterId);
	for (const clusterId of ids) {
		try {
			await exclusive(async () => {
				const file = join(stateRoot, `${clusterId}.json`);
				const state = stored(file);
				const owner = state?.checkout ?? owners.get(clusterId);
				if (!owner) {
					retained.push(clusterId);
					return;
				}
				if (checkoutId(owner) !== clusterId) throw new Error("checkout PostgreSQL owner does not match its id");
				if (existsSync(owner)) {
					if (state && state.checkout === null) save(file, { ...state, checkout: owner });
					return;
				}
				if (state) await deleteState(state, clusterId);
				for (const name of readdirSync(defaultRoot())) {
					if (!new RegExp(`^mw-pg-${clusterId}-[a-zA-Z0-9]+$`).test(name)) continue;
					const directory = join(defaultRoot(), name);
					if (refusal(directory) !== null) continue;
					await deleteState({ directory, bin: state?.bin ?? null }, clusterId);
				}
				rmSync(file, { force: true });
			}, clusterId);
		} catch (error) {
			if (strict) throw error;
			console.warn(
				`PostgreSQL ${clusterId}: cleanup failed; retained: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return retained;
}
export async function cluster(): Promise<Cluster> {
	if (process.env.MAINWORTHY_TEST_PG)
		return { adminUrl: process.env.MAINWORTHY_TEST_PG, directory: null, owned: false, startMs: 0 };
	await cleanupClusters([], { strict: false });
	return exclusive(async () => {
		let state = stored();
		if (state && running(state)) return describe(state);
		const bin = binaries();
		if (!bin) throw new Error(POSTGRES_MISSING);
		const start = performance.now();
		if (!state) {
			const directory = make(`pg-${id}`);
			state = { directory, port: await freePort(), bin, startMs: 0, checkout };
			save(stateFile, state);
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
		save(stateFile, state);
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
		save(stateFile, state);
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
		await command([
			join(controlBinaries(state), "pg_ctl"),
			"-D",
			join(state.directory, "data"),
			"-m",
			"fast",
			"-w",
			"stop",
		]);
		return "stopped checkout PostgreSQL";
	});
}
export async function removeCluster(): Promise<string> {
	return exclusive(async () => {
		const state = stored();
		if (!state) return "no checkout PostgreSQL to delete";
		await deleteState(state, id);
		rmSync(stateFile);
		return "deleted checkout PostgreSQL";
	});
}
if (import.meta.main) {
	const action = process.argv[2] ?? "start";
	if (action === "cleanup") {
		const retained = await cleanupClusters(process.argv.slice(3));
		if (retained.length)
			console.log(`Legacy ownership unknown; retained: ${retained.join(", ")}. See docs/development/tests.md.`);
	} else if (action === "cleanup-scratch") {
		const [directory, root, ...paths] = process.argv.slice(3);
		if (!directory || !root) throw new Error("cleanup-scratch needs a directory and its scratch root");
		const why = refusal(directory, root);
		if (why !== null) throw new Error(why);
		rmSync(directory, { recursive: true });
		await cleanupClusters(paths, { strict: false });
	} else if (action === "stop") console.log(await stopCluster());
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
	} else throw new Error("usage: bun scripts/pg.ts start|url|status|stop|delete|dev|cleanup [known-checkout-path...]");
}
