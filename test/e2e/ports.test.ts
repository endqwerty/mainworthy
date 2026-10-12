// The port reservation the browser tests share (`support.ts`): what parallel workers and a second checkout rely on.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reservePort } from "./support.ts";

let directory = "";
let ports: number[] = [];
const lockOf = (port: number): string => join(directory, `casebook-e2e-port-${port}`);

/** Ports the system says are free, and a lock directory nobody else uses. */
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "casebook-ports-"));
	const probes = [0, 0].map(() => Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() }));
	ports = probes.map((probe) => probe.port ?? 0);
	for (const probe of probes) await probe.stop(true);
});
afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});

async function endedProcess(): Promise<number> {
	const child = Bun.spawn([process.execPath, "-e", ""], { stdout: "ignore", stderr: "ignore" });
	await child.exited;
	return child.pid;
}

test("two reservations never share a port, and a released port can be taken again", async () => {
	const first = await reservePort(ports, directory);
	const second = await reservePort(ports, directory);
	expect(new Set([first.port, second.port])).toEqual(new Set(ports));
	expect(await readFile(join(lockOf(first.port), "pid"), "utf8")).toBe(String(process.pid));
	await expect(reservePort(ports, directory)).rejects.toThrow("No free Casebook e2e port");
	await first.release();
	expect(existsSync(lockOf(first.port))).toBe(false);
	const again = await reservePort(ports, directory);
	expect(again.port).toBe(first.port);
	await again.release();
	await second.release();
});

test("a lock of the first protocol, a bare directory, is respected while it is young", async () => {
	const [held = 0, free = 0] = ports;
	await mkdir(lockOf(held));
	expect((await reservePort(ports, directory)).port).toBe(free);
	await expect(reservePort(ports, directory)).rejects.toThrow("No free Casebook e2e port");
	expect(existsSync(lockOf(held))).toBe(true);
});

test("a lock whose owner has ended is taken over, and one whose owner runs is not", async () => {
	const [abandoned = 0, running = 0] = ports;
	await mkdir(lockOf(abandoned));
	await writeFile(join(lockOf(abandoned), "pid"), String(await endedProcess()));
	await mkdir(lockOf(running));
	await writeFile(join(lockOf(running), "pid"), String(process.ppid));
	const taken = await reservePort(ports, directory);
	expect(taken.port).toBe(abandoned);
	expect(await readFile(join(lockOf(abandoned), "pid"), "utf8")).toBe(String(process.pid));
	await expect(reservePort(ports, directory)).rejects.toThrow("No free Casebook e2e port");
	expect(await readFile(join(lockOf(running), "pid"), "utf8")).toBe(String(process.ppid));
});

test("a lock left for longer than any test runs is taken over, whoever it names", async () => {
	const [bare = 0, named = 0] = ports;
	const longAgo = new Date(Date.now() - 11 * 60_000);
	await mkdir(lockOf(bare));
	await utimes(lockOf(bare), longAgo, longAgo);
	await mkdir(lockOf(named));
	await writeFile(join(lockOf(named), "pid"), String(process.ppid));
	await utimes(lockOf(named), longAgo, longAgo);
	const taken = [await reservePort(ports, directory), await reservePort(ports, directory)];
	expect(new Set(taken.map((reservation) => reservation.port))).toEqual(new Set(ports));
	for (const port of ports) expect(await readFile(join(lockOf(port), "pid"), "utf8")).toBe(String(process.pid));
});

test("a port something listens on is passed over, and its lock is not kept", async () => {
	const [busy = 0, free = 0] = ports;
	const listener = Bun.serve({ hostname: "127.0.0.1", port: busy, fetch: () => new Response() });
	try {
		expect((await reservePort(ports, directory)).port).toBe(free);
		expect(existsSync(lockOf(busy))).toBe(false);
	} finally {
		await listener.stop(true);
	}
});
