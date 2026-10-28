// The runner owns these exact database names until every process of its run has exited.
import { createHash } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

type Record = { name: string; adminUrl: string; owned: boolean };
const databaseName = /^mw_test_\d+_[a-f0-9]{32}$/;
const suffix = ".database.json";
export function processStamp(pid: number): string | null {
	const answer = Bun.spawnSync(["ps", "-p", String(pid), "-o", "lstart="], {
		env: { ...process.env, LC_ALL: "C" },
		stdout: "pipe",
		stderr: "ignore",
	});
	return answer.exitCode === 0 ? answer.stdout.toString().trim() || null : null;
}
/** The start time in `/proc/<pid>/stat`, in clock ticks since boot: field 22, counted after the parenthesised name. */
export function startTicks(stat: string): string | null {
	// The command name is in parentheses and may hold spaces and parentheses itself, so count from the last one.
	const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
	return start && /^\d+$/.test(start) ? start : null;
}
/**
 * A process's start as the kernel counts it, in clock ticks (hundredths of a second) since boot, or null where
 * `/proc` does not say. A recycled pid matches only if the pid space wrapped within one tick of the original's start.
 * Without it there is no identity fine enough to signal by, so a caller signals nothing: `ps`'s one-second start time
 * could match a process that took the pid in the same second.
 */
export function processIdentity(pid: number): string | null {
	try {
		const start = startTicks(readFileSync(`/proc/${pid}/stat`, "utf8"));
		if (start) return `ticks:${start}`;
	} catch {}
	return null;
}
const runsRoot = (root: string): string =>
	join(
		homedir(),
		".cache",
		"mainworthy",
		"test-databases",
		createHash("sha256").update(realpathSync(root)).digest("hex").slice(0, 16),
	);
export function beginDatabaseRun(root: string): { directory: string; children: string } {
	const parent = runsRoot(root);
	mkdirSync(parent, { recursive: true });
	const directory = mkdtempSync(join(parent, "run-"));
	const children = join(directory, "children");
	mkdirSync(children);
	const stamp = processStamp(process.pid);
	if (!stamp) throw new Error("cannot identify the database cleanup owner");
	writeFileSync(
		join(directory, "owner.json"),
		JSON.stringify({ pid: process.pid, stamp, ownedCluster: !process.env.MAINWORTHY_TEST_PG }),
	);
	return { directory, children };
}
export function recordDatabase(directory: string | undefined, record: Record): string | null {
	if (!directory) return null;
	if (!databaseName.test(record.name)) throw new Error("invalid test database name");
	const path = join(directory, record.name + suffix);
	const ownerPath = join(directory, "owner.json");
	const owner: unknown = existsSync(ownerPath) ? JSON.parse(readFileSync(ownerPath, "utf8")) : null;
	const ownedCluster = typeof owner === "object" && owner !== null && Reflect.get(owner, "ownedCluster") === true;
	writeFileSync(path, JSON.stringify({ ...record, owned: record.owned || ownedCluster }), { flag: "wx", mode: 0o600 });
	return path;
}
export function databaseCreated(path: string | null): void {
	if (path)
		appendFileSync(join(path, "..", "events.jsonl"), `${JSON.stringify(["created", basename(path, suffix)])}\n`);
}
export function releaseDatabase(path: string | null): boolean {
	if (!path) return false;
	try {
		const owner: unknown = JSON.parse(readFileSync(join(path, "..", "owner.json"), "utf8"));
		if (typeof owner !== "object" || owner === null) return false;
		const pid: unknown = Reflect.get(owner, "pid"),
			stamp: unknown = Reflect.get(owner, "stamp");
		if (
			typeof pid !== "number" ||
			!Number.isSafeInteger(pid) ||
			pid <= 0 ||
			typeof stamp !== "string" ||
			processStamp(pid) !== stamp
		)
			return false;
	} catch {
		return false;
	}
	writeFileSync(`${path}.released`, "");
	return true;
}
export function databaseDropped(path: string | null): void {
	if (!path) return;
	rmSync(path, { force: true });
	rmSync(`${path}.released`, { force: true });
	appendFileSync(join(path, "..", "events.jsonl"), `${JSON.stringify(["dropped", basename(path, suffix)])}\n`);
}
export function peakDatabases(directory: string): number {
	const events = join(directory, "events.jsonl");
	if (!existsSync(events)) return 0;
	const live = new Set<string>();
	let peak = 0;
	for (const line of readFileSync(events, "utf8").trim().split("\n")) {
		const event: unknown = JSON.parse(line);
		if (
			!Array.isArray(event) ||
			event.length !== 2 ||
			!["created", "dropped"].includes(event[0]) ||
			typeof event[1] !== "string" ||
			!databaseName.test(event[1])
		)
			throw new Error("invalid test database lifecycle event");
		if (event[0] === "created") live.add(event[1]);
		else live.delete(event[1]);
		peak = Math.max(peak, live.size);
	}
	return peak;
}
function parseRecord(directory: string, file: string): Record {
	const value: unknown = JSON.parse(readFileSync(join(directory, file), "utf8"));
	if (typeof value !== "object" || value === null) throw new Error("invalid test database record");
	const name: unknown = Reflect.get(value, "name"),
		adminUrl: unknown = Reflect.get(value, "adminUrl"),
		owned: unknown = Reflect.get(value, "owned");
	if (
		typeof name !== "string" ||
		!databaseName.test(name) ||
		file !== name + suffix ||
		typeof adminUrl !== "string" ||
		typeof owned !== "boolean"
	)
		throw new Error("invalid test database record");
	const url = new URL(adminUrl);
	if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error("invalid test database server");
	return { name, adminUrl, owned };
}
/** One exact manifest can be drained by its worker or the runner, never concurrently. */
export async function dropRecordedDatabase(path: string): Promise<{ ms: number; dropped: boolean }> {
	const directory = join(path, "..");
	const file = basename(path);
	const timing = `${path}.dropped`;
	if (!existsSync(path)) return { ms: Number(readFileSync(timing, "utf8")), dropped: false };
	let record: Record;
	try {
		record = parseRecord(directory, file);
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		return { ms: Number(readFileSync(timing, "utf8")), dropped: false };
	}
	const { databaseAdmin } = await import("../../src/server/kernel/db.ts");
	const url = record.owned ? (await (await import("../pg.ts")).cluster()).adminUrl : record.adminUrl;
	return await databaseAdmin(url, async (admin) => {
		await admin.all("SELECT pg_advisory_lock(hashtextextended($1::text, 0))", [record.name]);
		// The lock's connection closes below, including on error. Another cleanup owner may have finished first.
		if (!existsSync(path)) return { ms: Number(readFileSync(timing, "utf8")), dropped: false };
		const began = performance.now();
		await admin.exec(`DROP DATABASE IF EXISTS "${record.name}" WITH (FORCE)`);
		const ms = performance.now() - began;
		writeFileSync(timing, String(ms));
		databaseDropped(path);
		return { ms, dropped: true };
	});
}
export async function drainRecordedDatabases(directory: string, releasedOnly = false): Promise<number> {
	const files = readdirSync(directory).filter(
		(name) => name.endsWith(suffix) && (!releasedOnly || existsSync(`${join(directory, name)}.released`)),
	);
	// A release is published only after the manifest and fixture are complete. Validate the whole selection first.
	const records = files.flatMap((file) => {
		try {
			parseRecord(directory, file);
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
			throw error;
		}
		return [join(directory, file)];
	});
	let count = 0;
	for (const path of records) {
		if (!existsSync(path) || (releasedOnly && !existsSync(`${path}.released`))) continue;
		if ((await dropRecordedDatabase(path)).dropped) count++;
	}
	return count;
}

/** A single consumer releases closed fixtures during a run; open and interrupted fixtures stay owned. */
export function reapReleasedDatabases(directory: string): { stop(): Promise<number> } {
	let stopped = false;
	let count = 0;
	let failure: unknown;
	const work = (async () => {
		while (!stopped) {
			count += await drainRecordedDatabases(directory, true);
			if (!stopped) await Bun.sleep(25);
		}
	})().catch((error: unknown) => {
		failure = error;
	});
	return {
		async stop() {
			stopped = true;
			await work;
			if (failure) throw failure;
			return count;
		},
	};
}
export async function recoverTestDatabases(root: string): Promise<number> {
	const parent = runsRoot(root);
	if (!existsSync(parent)) return 0;
	let dropped = 0;
	for (const name of readdirSync(parent)) {
		if (!/^run-[a-zA-Z0-9]+$/.test(name)) throw new Error("invalid test database run directory");
		const directory = join(parent, name);
		if (!existsSync(join(directory, "owner.json"))) continue;
		const value: unknown = JSON.parse(readFileSync(join(directory, "owner.json"), "utf8"));
		if (typeof value !== "object" || value === null) throw new Error("invalid test database owner");
		const pid: unknown = Reflect.get(value, "pid"),
			stamp: unknown = Reflect.get(value, "stamp");
		if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0 || typeof stamp !== "string")
			throw new Error("invalid test database owner");
		if (processStamp(pid) === stamp) continue;
		const { ownedChildren } = await import("./processes.ts");
		const deadline = Date.now() + 15_000;
		while ((await ownedChildren(join(directory, "children"))).length) {
			if (Date.now() >= deadline)
				throw new Error(`earlier test children are still alive; databases kept at ${directory}`);
			await Bun.sleep(50);
		}
		dropped += await drainRecordedDatabases(directory);
		rmSync(directory, { recursive: true });
	}
	return dropped;
}

export async function clusterDiskBytes(): Promise<number | null> {
	const info = await (await import("../pg.ts")).clusterStatus();
	if (!info?.directory) return null;
	const result = Bun.spawnSync(["du", "-sk", info.directory], { stdout: "pipe", stderr: "ignore" });
	if (result.exitCode !== 0) throw new Error("cannot measure checkout PostgreSQL disk use");
	const kib = Number(result.stdout.toString().trim().split(/\s/)[0]);
	if (!Number.isFinite(kib)) throw new Error("invalid PostgreSQL disk measurement");
	return kib * 1024;
}
