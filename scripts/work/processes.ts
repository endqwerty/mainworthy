// The processes an agent starts and waits for. `pkill -f` and `pgrep -f` match a process's whole command line,
// and the shell that runs them has the pattern in its own; they also match another agent's. These read the process
// table, leave the caller and its parents out, and stop only a server that runs from this checkout.
import { readlinkSync } from "node:fs";
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

/** `bun test --test-worker ...`: one of the processes a test run starts for its files. */
export const isTestWorker = (command: string): boolean => runsBun(command) && words(command).includes("--test-worker");

export const outsideLineage = (procs: readonly Proc[], self: number): Proc[] => {
	const own = lineage(procs, self);
	return procs.filter((proc) => !own.has(proc.pid));
};

/** The directory a process runs in, or null when it is gone or cannot be read. */
export async function directoryOf(pid: number): Promise<string | null> {
	try {
		return readlinkSync(`/proc/${pid}/cwd`);
	} catch {
		const done = await run(["lsof", "-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
		return (
			done.out
				.split("\n")
				.find((line) => line.startsWith("n"))
				?.slice(1) ?? null
		);
	}
}

export const within = (directory: string, root: string): boolean =>
	directory === root || directory.startsWith(`${root}/`);

/** Stops the servers that run from `root`; returns the pids it signalled. */
export async function stopServers(root: string, self = process.pid): Promise<number[]> {
	const candidates = outsideLineage(await processTable(), self).filter((proc) => isServer(proc.command));
	const mine: number[] = [];
	for (const proc of candidates) {
		const directory = await directoryOf(proc.pid);
		if (directory !== null && within(directory, root)) mine.push(proc.pid);
	}
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
