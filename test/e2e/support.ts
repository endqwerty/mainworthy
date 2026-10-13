import { afterAll } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright-core";
import { testReaders } from "../../scripts/check-plan.ts";
import type { Api, OpName } from "../../src/core/api.ts";
import { type SeedResult, seed } from "../../src/web/dev/seed.ts";
import { call } from "../../src/web/lib/api.ts";

export const chromiumPath = [
	process.env.MAINWORTHY_CHROMIUM,
	"/usr/bin/chromium",
	"/usr/bin/google-chrome",
	"/usr/bin/chromium-browser",
].find((path) => path && existsSync(path));
export const browserAvailable = Boolean(chromiumPath);
if (!browserAvailable) console.info("Skipping Mainworthy e2e: set MAINWORTHY_CHROMIUM or install system Chromium.");
export type Server = {
	url: string;
	project: string;
	token: string;
	seeded: SeedResult | null;
	api: <O extends OpName>(op: O, input: Api[O]["input"], options?: { token?: string }) => Promise<Api[O]["reply"]>;
	stop: () => Promise<void>;
};
const ownedDirectories = new Set<string>();
process.once("exit", () => {
	for (const path of ownedDirectories) rmSync(path, { recursive: true, force: true });
});
/**
 * The ports of the servers the browser tests start. Any number of test processes share them (parallel workers,
 * a second checkout on the same machine): a port is held by the directory `mainworthy-e2e-port-<port>` in the
 * temporary directory, made with mkdir, which only one process can do. 7400 to 7449 is the range the protocol
 * began with and 7500 to 7599 was added for parallel workers; a process that knows only the first fifty takes
 * and frees the same directories. 7450 to 7499 stays out: four test files (agent, execution, settings and
 * triage) pick their own ports there, with no lock.
 */
const PORTS = [...Array.from({ length: 50 }, (_, i) => 7400 + i), ...Array.from({ length: 100 }, (_, i) => 7500 + i)];
/** No test keeps a server for ten minutes: a lock that old was left by a process that was killed. */
const ABANDONED_MS = 10 * 60_000;
let nextPort = process.pid % PORTS.length;
const made = (lock: string): Promise<boolean> =>
	mkdir(lock).then(
		() => true,
		() => false,
	);
const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error instanceof Error && "code" in error && error.code === "EPERM";
	}
};
/**
 * Frees a lock nobody holds. A killed process cannot release its ports, and a lock was never given up otherwise:
 * on 2026-10-12 thirteen of the fifty were held by processes that had ended hours before. A lock names its
 * owner in `pid`; one without the file (the first protocol's) is abandoned when it is old.
 */
async function reclaimed(lock: string): Promise<boolean> {
	const held = await stat(lock).catch(() => null);
	if (!held) return true;
	const owner = Number(await readFile(join(lock, "pid"), "utf8").catch(() => ""));
	const ownerGone = Number.isInteger(owner) && owner > 0 && !alive(owner);
	if (!ownerGone && Date.now() - held.mtimeMs < ABANDONED_MS) return false;
	// Several processes can find the same abandoned lock. A rename moves it for exactly one of them.
	const grave = `${lock}-abandoned-${process.pid}`;
	try {
		await rename(lock, grave);
	} catch {
		return false;
	}
	// If the lock was freed and taken again in between, this moved a live one: put it back.
	if ((await stat(grave)).ino !== held.ino) {
		await rename(grave, lock).catch(() => {});
		return false;
	}
	await rm(grave, { recursive: true, force: true });
	return true;
}
/** Takes a port nobody holds, here or in another process. `ports` and `directory` are for the test of this. */
export async function reservePort(
	ports: readonly number[] = PORTS,
	directory = tmpdir(),
): Promise<{ port: number; release: () => Promise<void> }> {
	for (let i = 0; i < ports.length; i++) {
		const port = ports[nextPort++ % ports.length] ?? 0;
		const lock = join(directory, `mainworthy-e2e-port-${port}`);
		if (!(await made(lock)) && !((await reclaimed(lock)) && (await made(lock)))) continue;
		ownedDirectories.add(lock);
		await writeFile(join(lock, "pid"), String(process.pid));
		const release = async () => {
			await rm(lock, { recursive: true, force: true });
			ownedDirectories.delete(lock);
		};
		try {
			const probe = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("probe") });
			await probe.stop(true);
			return { port, release };
		} catch {
			await release();
		}
	}
	throw new Error("No free Mainworthy e2e port in 7400..7449 or 7500..7599");
}
export async function startServer({
	cases = 0,
	mode = "local",
	preset,
	seed: seedData = cases > 0,
	passkeys = false,
}: {
	cases?: number;
	mode?: "local" | "server";
	preset?: string;
	seed?: boolean;
	/**
	 * The server is told that people open it at `http://localhost:<port>`, so it offers passkeys there. A test
	 * then opens its pages at `localhost`: Chromium makes no passkey at `127.0.0.1` (`passkey-verifier.test.ts`).
	 */
	passkeys?: boolean;
} = {}): Promise<Server> {
	const dataDir = await mkdtemp(join(tmpdir(), `mainworthy-e2e-${process.pid}-`));
	ownedDirectories.add(dataDir);
	const reservation = await reservePort();
	const port = reservation.port;
	const token = crypto.randomUUID();
	const url = `http://127.0.0.1:${port}`;
	const child = Bun.spawn([process.execPath, "test/e2e/serve.ts"], {
		cwd: process.cwd(),
		env: {
			...process.env,
			NODE_ENV: "production",
			MAINWORTHY_DATA: dataDir,
			MAINWORTHY_PORT: String(port),
			MAINWORTHY_MODE: mode,
			MAINWORTHY_OWNER_TOKEN: token,
			MAINWORTHY_PUBLIC_URL: passkeys ? `http://localhost:${port}` : "",
			MAINWORTHY_READERS: process.env.MAINWORTHY_READERS ?? testReaders(),
		},
		stdout: "ignore",
		stderr: "pipe",
	});
	const stop = async () => {
		child.kill("SIGTERM");
		await child.exited;
		await rm(dataDir, { recursive: true, force: true });
		ownedDirectories.delete(dataDir);
		await reservation.release();
	};
	try {
		let ready = false;
		for (let i = 0; i < 300; i++) {
			if (child.exitCode !== null)
				throw new Error(`Mainworthy failed to start: ${await new Response(child.stderr).text()}`);
			try {
				ready = (await fetch(`${url}/healthz`)).ok;
			} catch {}
			if (ready) break;
			await Bun.sleep(50);
		}
		if (!ready) throw new Error("Mainworthy e2e server did not become ready");
		const api = <O extends OpName>(op: O, input: Api[O]["input"], options: { token?: string } = {}) =>
			call(op, input, { url, project: "scratch", token: options.token ?? token });
		const seeded = seedData ? await seed({ url, cases, token }) : null;
		if (preset) {
			const proposed = await api("propose", { edits: [{ op: "policy", preset }] });
			const question = (await api("inbox", { kind: "adopt" })).items.find((q) => q.q === proposed.question);
			if (question) await api("decide", { q: question.q, onEvidence: question.evidenceHash, answer: { is: "accept" } });
		}
		return { url, project: "scratch", token, seeded, api, stop };
	} catch (error) {
		await stop();
		throw error;
	}
}
export async function launchBrowser({ args = [] }: { args?: string[] } = {}): Promise<Browser> {
	if (!chromiumPath) throw new Error("System Chromium is missing");
	return chromium.launch({
		executablePath: chromiumPath,
		headless: true,
		args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", ...args],
	});
}
/**
 * One Chromium for a test file, and for every page a test opens a context of its own: its own storage, cache
 * and permissions, as a browser of its own had. A launch for each page was a quarter of the longest file's time.
 * Bun runs this hook after the file's last test. Where nothing would close a shared browser, each page has its
 * own, as before: outside `bun test` (`screenshots.ts`, `profile-latency.ts`), and in the later files of a run
 * with no `--isolate` or `--parallel`, which load this module once.
 */
let shared: Promise<Browser> | null = null;
let closesShared = false;
try {
	afterAll(async () => {
		closesShared = false;
		await (await shared?.catch(() => null))?.close();
		shared = null;
	});
	closesShared = true;
} catch {}
async function fileBrowser(): Promise<Browser | null> {
	if (!closesShared) return null;
	// Bun ends the processes a test started when the test runs out of time, this browser among them. The tests
	// after it get a new one: one test's failure is not the failure of the rest of its file.
	if (!(await shared?.catch(() => null))?.isConnected()) shared = launchBrowser();
	return shared;
}
export type PageHarness = {
	page: Page;
	context: BrowserContext;
	errors: string[];
	dialogs: string[];
	loads: () => number;
	keys: () => Promise<number>;
	close: () => Promise<void>;
};
/** Trusted browser input, isolated storage, and observable errors for each journey. */
export async function openPage(
	server: Server,
	{
		path = "/p/scratch/suite",
		signedIn = true,
		browser,
	}: { path?: string; signedIn?: boolean; browser?: Browser } = {},
): Promise<PageHarness> {
	const lent = browser ?? (await fileBrowser());
	const ownedBrowser = lent ?? (await launchBrowser());
	const context = await ownedBrowser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "light" });
	routesWaitForInterception(context);
	if (signedIn) await context.request.post(`${server.url}/api/login`, { data: { token: server.token } });
	const page = await context.newPage();
	const errors: string[] = [];
	const dialogs: string[] = [];
	let loads = 0;
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("console", (message) => {
		if (
			message.type() === "error" &&
			!/^Failed to load resource: the server responded with a status of 401/.test(message.text())
		)
			errors.push(message.text());
	});
	page.on("dialog", (dialog) => {
		dialogs.push(dialog.message());
		void dialog.dismiss();
	});
	page.on("load", () => loads++);
	await page.addInitScript(() => {
		let count = 0;
		window.addEventListener("keydown", (event) => {
			if (!["Control", "Meta", "Shift", "Alt"].includes(event.key)) count++;
		});
		Object.defineProperty(window, "mainworthyKeyCount", { get: () => count });
	});
	await page.goto(`${server.url}${path}`);
	await page.waitForSelector(signedIn ? "#app" : "#token");
	return {
		page,
		context,
		errors,
		dialogs,
		loads: () => loads,
		keys: () => keyCount(page),
		close: async () => {
			await context.close();
			if (!lent) await ownedBrowser.close();
		},
	};
}
export async function keyCount(page: Page): Promise<number> {
	return page.evaluate(() => {
		const value: unknown = Reflect.get(window, "mainworthyKeyCount");
		return typeof value === "number" ? value : 0;
	});
}
export async function paste(page: Page, text: string): Promise<void> {
	await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
	await page.evaluate((value) => navigator.clipboard.writeText(value), text);
	await page.keyboard.press("Control+V");
}
/**
 * `page.route` and `context.route` return when the browser has accepted the interception. A page that is already
 * open starts sending its requests through it a moment later, and it handles a key pressed in between first:
 * the request that key sends goes to the server unseen, the handler never runs and there is no `request` event.
 * On a quiet machine the moment is too short to hit; beside other tests it failed 13 of 18 runs of one file
 * (2026-10-12). This returns once a request from the page has been intercepted. Every route installed on a
 * context or page from `openPage` waits for it (`routesWaitForInterception`), so a test does not call it.
 */
export async function interceptionLive(page: Page): Promise<void> {
	// A page with no document sends nothing yet: a route installed before `goto` is in place for all it loads.
	if (page.isClosed() || !/^https?:/.test(page.url())) return;
	const id = crypto.randomUUID();
	const probe = (url: URL) => url.searchParams.get("interception") === id;
	const route = unwrappedRoute.get(page) ?? page.route.bind(page);
	const end = Date.now() + 10_000;
	try {
		await route(probe, (route) => route.fulfill({ status: 204, headers: { "x-mainworthy-e2e": "intercepted" } }));
		while (Date.now() < end) {
			const intercepted = await Promise.race([
				page.evaluate(
					(url) =>
						fetch(url).then(
							(reply) => reply.headers.get("x-mainworthy-e2e") === "intercepted",
							() => false,
						),
					`/healthz?interception=${id}`,
				),
				Bun.sleep(Math.max(0, end - Date.now())).then(() => false),
			]);
			if (intercepted) return;
		}
	} catch {
		// The page closed or went to another document meanwhile. Neither has a key waiting ahead of the switch.
		return;
	} finally {
		await page.unroute(probe).catch(() => {});
	}
	throw new Error(`Interception did not start on ${page.url()} within 10 s of installing a route`);
}
const unwrappedRoute = new WeakMap<Page, Page["route"]>();
/** Makes installing a route on the context, or on any page it has or opens, wait until the route is in force. */
function routesWaitForInterception(context: BrowserContext): void {
	const live = () => Promise.all(context.pages().map(interceptionLive));
	const contextRoute = context.route.bind(context);
	context.route = async (...args) => {
		const installed = await contextRoute(...args);
		await live();
		return installed;
	};
	const wrap = (page: Page) => {
		if (unwrappedRoute.has(page)) return;
		const pageRoute = page.route.bind(page);
		unwrappedRoute.set(page, pageRoute);
		page.route = async (...args) => {
			const installed = await pageRoute(...args);
			await live();
			return installed;
		};
	};
	for (const page of context.pages()) wrap(page);
	context.on("page", wrap);
}
export async function eventually<T>(read: () => Promise<T>, accepts: (value: T) => boolean): Promise<T> {
	const end = Date.now() + 10_000;
	let value = await read();
	while (!accepts(value) && Date.now() < end) {
		await Bun.sleep(40);
		value = await read();
	}
	if (!accepts(value)) throw new Error("The expected server state did not arrive");
	return value;
}
