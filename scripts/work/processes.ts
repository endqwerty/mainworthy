// The processes an agent starts and waits for. `pkill -f` and `pgrep -f` match a process's whole command line,
// and the shell that runs them has the pattern in its own; they also match another agent's. These read the process
// table, leave the caller and its parents out, and stop only a server that runs from this checkout.
import { existsSync, readdirSync, readlinkSync } from "node:fs";
import { basename } from "node:path";
import { read, run, sleep } from "./run.ts";

export type Proc = { pid: number; ppid: number; command: string };

export function parseProcessTable(table: string): Proc[] {
	return table.split("\n").flatMap((line) => {
		const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
		return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] ?? "" }] : [];
	});
}

export async function processTable(): Promise<Proc[]> {
	return parseProcessTable(await read(["ps", "-axo", "pid=,ppid=,command="]));
}

/** The caller and every process above it: a pattern in the caller's own command line is not a match. */
export function lineage(procs: readonly Proc[], pid: number): Set<number> {
	const parent = new Map(procs.map((proc) => [proc.pid, proc.ppid]));
	const found = new Set<number>();
	for (let at: number | undefined = pid; at !== undefined && at > 0 && !found.has(at); at = parent.get(at))
		found.add(at);
	return found;
}

const words = (command: string): string[] => command.split(/\s+/).filter(Boolean);
const runsBun = (command: string): boolean => basename(words(command)[0] ?? "") === "bun";

/** `bun [--watch] src/cli/main.ts serve`: what `bun run dev` and `bun run start` start. */
export function isServer(command: string): boolean {
	const tokens = words(command);
	const at = tokens.findIndex((token) => token.endsWith("src/cli/main.ts"));
	return runsBun(command) && at >= 0 && tokens[at + 1] === "serve";
}

/**
 * A test run: `bun test ...` itself (the quiet phase runs with `--parallel=1` and has no worker) or one of the
 * `bun test --test-worker ...` processes it starts for its files.
 */
export const isTestWorker = (command: string): boolean =>
	runsBun(command) && (words(command)[1] === "test" || words(command).includes("--test-worker"));

export const outsideLineage = (procs: readonly Proc[], self: number): Proc[] => {
	const own = lineage(procs, self);
	return procs.filter((proc) => !own.has(proc.pid));
};

/** What `lsof` says of each process's directory; an `lsof` that did not work is an error, not an empty answer. */
export async function directoriesFromLsof(
	command: readonly string[] = ["lsof", "-a", "-d", "cwd", "-Fpn"],
): Promise<Map<number, string>> {
	const found = new Map<number, string>();
	let pid = 0;
	const listed = await run(command);
	// lsof exits 1 for a process it may not look at; with nothing listed it did not work, and a release must not guess.
	if (listed.status !== 0 && listed.out.trim() === "")
		throw new Error(`the processes' directories could not be read (lsof exit ${listed.status}: ${listed.err.trim()})`);
	for (const line of listed.out.split("\n")) {
		if (line.startsWith("p")) pid = Number(line.slice(1));
		else if (line.startsWith("n") && pid > 0) found.set(pid, line.slice(1));
	}
	return found;
}

/** The directory each process runs in, by pid, for the processes this user may look at. */
export async function directories(): Promise<Map<number, string>> {
	const found = new Map<number, string>();
	if (existsSync("/proc/self/cwd")) {
		for (const name of readdirSync("/proc").filter((entry) => /^\d+$/.test(entry))) {
			try {
				found.set(Number(name), readlinkSync(`/proc/${name}/cwd`));
			} catch {}
		}
		return found;
	}
	return directoriesFromLsof();
}

export const within = (directory: string, root: string): boolean =>
	directory === root || directory.startsWith(`${root}/`);

/** Stops the servers that run from `root`; returns the pids it signalled. */
export async function stopServers(root: string, self = process.pid): Promise<number[]> {
	const where = await directories();
	const mine = outsideLineage(await processTable(), self)
		.filter((proc) => isServer(proc.command) && within(where.get(proc.pid) ?? "", root))
		.map((proc) => proc.pid);
	for (const pid of mine) process.kill(pid, "SIGTERM");
	return mine;
}

/** Waits until no other test run has a worker; returns the workers still there when `timeoutSeconds` ran out. */
export async function waitForTests(
	timeoutSeconds: number,
	{
		self = process.pid,
		pollMs = 2000,
		table = processTable,
	}: { self?: number; pollMs?: number; table?: () => Promise<Proc[]> } = {},
): Promise<Proc[]> {
	const deadline = Date.now() + timeoutSeconds * 1000;
	for (;;) {
		const workers = outsideLineage(await table(), self).filter((proc) => isTestWorker(proc.command));
		if (workers.length === 0 || Date.now() >= deadline) return workers;
		await sleep(pollMs);
	}
}

const runsNode = (command: string): boolean => basename(words(command)[0] ?? "") === "node";

/** The Bun and Node processes that run from `root` (a server, a test run, a single test file), other than the caller's. */
export async function runningIn(root: string, self = process.pid): Promise<Proc[]> {
	const where = await directories();
	return outsideLineage(await processTable(), self).filter(
		(proc) => (runsBun(proc.command) || runsNode(proc.command)) && within(where.get(proc.pid) ?? "", root),
	);
}

/** Whether a test run other than the caller's has workers. */
export const otherTestRuns = async (self = process.pid): Promise<boolean> =>
	outsideLineage(await processTable(), self).some((proc) => isTestWorker(proc.command));
