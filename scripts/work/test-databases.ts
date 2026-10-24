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
export function databaseDropped(path: string | null): void {
	if (!path) return;
	rmSync(path, { force: true });
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
export async function drainRecordedDatabases(directory: string): Promise<number> {
	const files = readdirSync(directory).filter((name) => name.endsWith(suffix));
	// Parse every record before issuing anything, so malformed ownership data cannot cause a partial cleanup.
	const records = files.map((file) => ({ ...parseRecord(directory, file), file }));
	if (!records.length) return 0;
	const { databaseAdmin } = await import("../../src/server/kernel/db.ts");
	const ownUrl = records.some((record) => record.owned) ? (await (await import("../pg.ts")).cluster()).adminUrl : null;
	const groups = Map.groupBy(records, (record) => (record.owned && ownUrl ? ownUrl : record.adminUrl));
	for (const [url, entries] of groups) {
		await databaseAdmin(url, async (admin) => {
			for (const record of entries) {
				await admin.exec(`DROP DATABASE IF EXISTS "${record.name}" WITH (FORCE)`);
				databaseDropped(join(directory, record.file));
			}
		});
	}
	return records.length;
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
