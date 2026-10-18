import { afterAll } from "bun:test";
import { rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type APIResponse, type Browser, type BrowserContext, chromium, type Page, type Route } from "playwright-core";
import { findChromium, testReaders } from "../../scripts/check-plan.ts";
import { Client } from "../../src/cli/client.ts";
import { type SeedResult, seed } from "../../src/cli/seed.ts";
import type { Api, OpName } from "../../src/core/api.ts";
import { call } from "../../src/web/lib/api.ts";

const found = findChromium();
export const chromiumPath = found.path;
export const browserAvailable = found.path !== null;
if (found.path === null) console.info(`Skipping Mainworthy e2e. ${found.skipped}`);
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
	source = false,
	cases = 0,
	firstProject = "scratch",
	mode = "local",
	preset,
	unlinked,
	seed: seedData = cases > 0,
	days = 0,
	passkeys = false,
	mail,
	oidc,
}: {
	/** Exercise Bun's source bundler even when the check supplies a compiled fixture. */
	source?: boolean;
	cases?: number;
	firstProject?: string;
	/** How many days of history the seed writes. Absent: no history. */
	days?: number;
	mode?: "local" | "server";
	preset?: string;
	/** What happens to a test with no case, when it is not what the preset starts with. */
	unlinked?: "ask" | "track" | "create";
	seed?: boolean;
	/**
	 * The server is told that people open it at `http://localhost:<port>`, so it offers passkeys there. A test
	 * then opens its pages at `localhost`: Chromium makes no passkey at `127.0.0.1` (`passkey-verifier.test.ts`).
	 */
	passkeys?: boolean;
	mail?: { port: number };
	/** An identity provider (`test/oidc-support.ts`). People open the pages at `localhost`, as with passkeys. */
	oidc?: { issuer: string; clientId: string; clientSecret: string; name: string };
} = {}): Promise<Server> {
	const dataDir = await mkdtemp(join(tmpdir(), `mainworthy-e2e-${process.pid}-`));
	ownedDirectories.add(dataDir);
	const reservation = await reservePort();
	const port = reservation.port;
	const token = crypto.randomUUID();
	const url = `http://127.0.0.1:${port}`;
	const executable = source ? undefined : process.env.MAINWORTHY_E2E_SERVER;
	let child: Bun.Subprocess<"ignore", "ignore", "pipe">;
	try {
		child = Bun.spawn(executable === undefined ? [process.execPath, "test/e2e/serve.ts"] : [executable], {
			cwd: process.cwd(),
			env: {
				...process.env,
				NODE_ENV: "production",
				MAINWORTHY_DATA: dataDir,
				MAINWORTHY_PORT: String(port),
				MAINWORTHY_MODE: mode,
				MAINWORTHY_FIRST_PROJECT: firstProject,
				MAINWORTHY_OWNER_TOKEN: token,
				MAINWORTHY_PUBLIC_URL: passkeys || mail || oidc ? `http://localhost:${port}` : "",
				MAINWORTHY_OIDC_ISSUER: oidc?.issuer ?? "",
				MAINWORTHY_OIDC_CLIENT_ID: oidc?.clientId ?? "",
				MAINWORTHY_OIDC_CLIENT_SECRET: oidc?.clientSecret ?? "",
				MAINWORTHY_OIDC_NAME: oidc?.name ?? "",
				MAINWORTHY_SMTP_HOST: mail ? "127.0.0.1" : "",
				MAINWORTHY_SMTP_PORT: mail ? String(mail.port) : "",
				MAINWORTHY_SMTP_TLS: mail ? "none" : "",
				MAINWORTHY_SMTP_USER: "",
				MAINWORTHY_SMTP_PASSWORD: "",
				MAINWORTHY_MAIL_FROM: mail ? "mainworthy@example.com" : "",
				MAINWORTHY_READERS: process.env.MAINWORTHY_READERS ?? testReaders(),
			},
			stdout: "ignore",
			stderr: "pipe",
		});
	} catch (error) {
		await rm(dataDir, { recursive: true, force: true });
		ownedDirectories.delete(dataDir);
		await reservation.release();
		throw error;
	}
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
			call(op, input, { url, project: firstProject, token: options.token ?? token });
		const seeded = seedData
			? await seed(new Client({ url, token, project: firstProject }), {
					project: firstProject,
					cases,
					days,
				})
			: null;
		if (preset || unlinked) {
			const proposed = await api("propose", {
				edits: [{ op: "policy", ...(preset ? { preset } : {}), ...(unlinked ? { unlinked } : {}) }],
			});
			const question = (await api("inbox", { kind: "adopt" })).items.find((q) => q.q === proposed.question);
			if (question) await api("decide", { q: question.q, onEvidence: question.evidenceHash, answer: { is: "accept" } });
		}
		return { url, project: firstProject, token, seeded, api, stop };
	} catch (error) {
		await stop();
		throw error;
	}
}
/**
 * Moves the clock of a server `startServer` started forward, so that a test of something that runs out (an
 * invitation) does not wait for it. The clock only goes forward, and stays there for the tests that follow.
 */
export async function advanceClock(server: Server, ms: number): Promise<void> {
	const moved = await fetch(`${server.url}/test/clock`, {
		method: "POST",
		headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
		body: JSON.stringify({ advanceMs: ms }),
	});
	if (!moved.ok) throw new Error(`The e2e server's clock did not move: ${moved.status}`);
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
		as,
		ready,
		setup,
		browser,
		device = "desktop",
	}: {
		path?: string;
		signedIn?: boolean;
		/** Who is signed in when not the owner by their token: a person, by name and password. */
		as?: { name: string; password: string };
		/** What shows that the page is up, for a page that is neither the app nor the sign-in page. */
		ready?: string;
		/** Installs routes and init scripts before the first document loads. */
		setup?: (page: Page, context: BrowserContext) => Promise<void>;
		browser?: Browser;
		/**
		 * A phone is a window 390 wide whose pointer is a finger, so the page lays itself out for one
		 * (`src/web/lib/layout.ts`); `tap` is its press. The desktop is a mouse at 1440 by 900.
		 */
		device?: "desktop" | "phone";
	} = {},
): Promise<PageHarness> {
	const lent = browser ?? (await fileBrowser());
	const ownedBrowser = lent ?? (await launchBrowser());
	const context = await ownedBrowser.newContext({
		...(device === "phone"
			? { viewport: { width: 390, height: 844 }, hasTouch: true }
			: { viewport: { width: 1440, height: 900 } }),
		colorScheme: "light",
	});
	routesWaitForInterception(context);
	throttleRenderers(context);
	if (signedIn) {
		const opened = await context.request.post(`${server.url}/api/login`, { data: as ?? { token: server.token } });
		if (as && !opened.ok()) throw new Error(`The e2e sign-in of ${as.name} was refused: ${opened.status()}`);
	}
	const page = await context.newPage();
	await throttled(page);
	const errors: string[] = [];
	const dialogs: string[] = [];
	let loads = 0;
	await page.exposeFunction("mainworthyWindowError", (message: string) => errors.push(message));
	await page.addInitScript(() => {
		window.addEventListener("error", (event) => {
			const report: unknown = Reflect.get(window, "mainworthyWindowError");
			if (typeof report === "function") void report(event.message);
		});
	});
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
	await setup?.(page, context);
	await page.goto(`${server.url}${path}`);
	await page.waitForSelector(ready ?? (signedIn ? "#app" : "#token"));
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
/**
 * `MAINWORTHY_E2E_CPU_THROTTLE=n` runs every page of a test n times slower, as a loaded machine does, so that a
 * test that fails only beside others can be made to fail alone (issues #406, #322, #411). Off unless set.
 */
const THROTTLE = Number(process.env.MAINWORTHY_E2E_CPU_THROTTLE ?? "");
const slowed = new WeakSet<Page>();
async function throttled(page: Page): Promise<void> {
	if (!(THROTTLE > 1) || slowed.has(page)) return;
	slowed.add(page);
	const cdp = await page.context().newCDPSession(page);
	await cdp.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE });
}
function throttleRenderers(context: BrowserContext): void {
	if (THROTTLE > 1) context.on("page", (page) => void throttled(page).catch(() => {}));
}
/**
 * Gives the page an authenticator that Chromium keeps in memory and that confirms the person by itself, so a
 * passkey is made and used with no dialog. `remove` takes it away again: a second one stands for another device.
 * The page must be open at `localhost` (`startServer({ passkeys: true })`).
 */
export async function addAuthenticator(harness: PageHarness): Promise<{ remove: () => Promise<void> }> {
	const cdp = await harness.context.newCDPSession(harness.page);
	await cdp.send("WebAuthn.enable");
	const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
		options: {
			protocol: "ctap2",
			transport: "internal",
			hasResidentKey: true,
			hasUserVerification: true,
			isUserVerified: true,
			automaticPresenceSimulation: true,
		},
	});
	return {
		remove: async () => {
			await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
		},
	};
}
/** The start of every storage key the page keeps for the actor this token belongs to: their id, not their name (issue #380). */
export async function devicePrefix(server: Pick<Server, "url" | "project">, token: string): Promise<string> {
	const { actorId } = await new Client({ url: server.url, token, project: server.project }).session();
	return `mainworthy:#${actorId}:`;
}
export async function keyCount(page: Page): Promise<number> {
	return page.evaluate(() => {
		const value: unknown = Reflect.get(window, "mainworthyKeyCount");
		return typeof value === "number" ? value : 0;
	});
}
/** Pastes with the key of the machine the browser runs on: Control+V pastes nothing on macOS (issue #103). */
export async function paste(page: Page, text: string): Promise<void> {
	await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
	await page.evaluate((value) => navigator.clipboard.writeText(value), text);
	await page.keyboard.press("ControlOrMeta+V");
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
	// What the probes met, for the error: a reply the server gave means the request went past the interceptor; a
	// probe that did not answer means the page did not run it.
	const met = { probes: 0, served: 0, failed: 0 };
	try {
		await route(probe, (route) => route.fulfill({ status: 204, headers: { "x-mainworthy-e2e": "intercepted" } }));
		while (Date.now() < end) {
			met.probes++;
			const outcome = await Promise.race([
				page.evaluate(
					(url) =>
						fetch(url).then(
							(reply) => (reply.headers.get("x-mainworthy-e2e") === "intercepted" ? "intercepted" : "served"),
							() => "failed",
						),
					`/healthz?interception=${id}`,
				),
				Bun.sleep(Math.max(0, end - Date.now())).then(() => "unanswered" as const),
			]);
			if (outcome === "intercepted") return;
			if (outcome === "served") met.served++;
			if (outcome === "failed") met.failed++;
		}
	} catch {
		// The page closed or went to another document meanwhile. Neither has a key waiting ahead of the switch.
		return;
	} finally {
		await page.unroute(probe).catch(() => {});
	}
	throw new Error(
		`Interception did not start on ${page.url()} within 10 s of installing a route: ${met.probes} probes, ${met.served} answered by the server, ${met.failed} failed, the rest unanswered`,
	);
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
/**
 * The reply to a request that a route handler sends on to the server, with its body read as JSON, or null when
 * the page's browser context was closed while the handler held the request. A page asks again by itself for
 * what it shows (the inbox, a list of tokens), so such a request can be in a handler when the test has passed
 * and its `close` ends the context. `route.fetch` then fails, or the reply it brought is already disposed:
 * "json: Response has been disposed" failed R4B-1 in CI on 2026-10-13 (run 38388161751). A navigation does not
 * do this, and neither does closing the page alone: the reply of a document that was left, or of a page that
 * was closed in a context that lives on, can still be read. A handler that gets null returns: nobody waits for that request. Any other
 * failure is thrown, and the handler parses `json` itself, so a wrong reply still fails the test. The handler
 * answers with `answer`, which is quiet in the same case and no other.
 */
export async function fetched(route: Route): Promise<{ response: APIResponse; json: unknown } | null> {
	try {
		const response = await route.fetch();
		return { response, json: await response.json() };
	} catch (error) {
		if (abandoned(route, error)) return null;
		throw error;
	}
}
export async function answer(route: Route, reply: Parameters<Route["fulfill"]>[0]): Promise<void> {
	await route.fulfill(reply).catch((error: unknown) => {
		if (!abandoned(route, error)) throw error;
	});
}
function abandoned(route: Route, error: unknown): boolean {
	// The two messages are what the context's close gives while it is still under way and the page does not say closed yet.
	const closing = error instanceof Error && /has been (closed|disposed)/.test(error.message);
	return closing || route.request().frame().page().isClosed();
}
export async function eventually<T>(read: () => Promise<T>, accepts: (value: T) => boolean): Promise<T> {
	const end = Date.now() + 10_000;
	let value = await read();
	while (!accepts(value) && Date.now() < end) {
		await Bun.sleep(40);
		value = await read();
	}
	if (!accepts(value))
		throw new Error(`The expected server state did not arrive within 10 s. The last read was ${shown(value)}`);
	return value;
}
/** A value in an error message: short enough to read, long enough to say what the state was. */
function shown(value: unknown): string {
	const text = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
	return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}
/**
 * Presses the answer key for proposal `q` once the page has read the proposal, and again when the page refused it.
 * A proposal is answered only while its card says it is read (`data-proposal-read="ready"`, `src/web/queue/
 * evidence.tsx`), and the page reads it again on its own: once when its change stream opens, right after the
 * edits first appear, and after every change to a case it touches. The card is marked read between those reads,
 * so a key that follows the mark by a few milliseconds can still land in a read and be refused with "Still
 * reading the proposal" (issues #322 and #411: 2 of 56 runs beside sixteen busy loops). A person told so presses
 * again, and so does this. Whether a press was refused is read the way the page decides it, from the card at the
 * moment of the key (`proposalReadMessage`), not guessed from how long a request takes.
 */
export async function answerWhenRead(page: Page, q: string, key: string): Promise<void> {
	for (let attempt = 1; attempt <= 5; attempt++) {
		await page.locator(`[data-proposal-evidence="${q}"][data-proposal-read="ready"]`).waitFor();
		await page.evaluate((q) => {
			const read = () =>
				document.querySelector<HTMLElement>(`[data-proposal-evidence="${CSS.escape(q)}"]`)?.dataset.proposalRead;
			window.addEventListener("keydown", () => Reflect.set(window, "mainworthyReadAtKey", read() === "ready"), {
				capture: true,
				once: true,
			});
		}, q);
		const sent = page.waitForRequest((request) => request.url().endsWith("/decide"));
		await page.keyboard.press(key);
		if (await page.evaluate((): unknown => Reflect.get(window, "mainworthyReadAtKey"))) {
			await sent;
			return;
		}
		sent.catch(() => {});
	}
	throw new Error(`${key} was refused 5 times while the page read ${q} again`);
}
