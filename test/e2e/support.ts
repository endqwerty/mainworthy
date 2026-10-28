import { afterAll } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type APIResponse,
	type Browser,
	type BrowserContext,
	chromium,
	devices,
	type Page,
	type Route,
} from "playwright-core";
import { z } from "zod";
import { chromiumLaunchOptions, findChromium, sharedBrowserEndpoint } from "../../scripts/check-plan.ts";
import { markOwned, sweepOwned } from "../../scripts/work/scratch.ts";
import { processIdentity } from "../../scripts/work/test-databases.ts";
import { Client } from "../../src/cli/client.ts";
import { type SeedResult, seed } from "../../src/cli/seed.ts";
import type { Api, OpName } from "../../src/core/api.ts";
import type { Capability } from "../../src/core/kinds.ts";
import { call } from "../../src/web/lib/api.ts";
import { provider as fakeProvider, type Provider } from "../oidc-support.ts";
import { browserDiagnostics } from "./browser-diagnostics.ts";

const found = findChromium();
export const browserAvailable = found.path !== null;
/**
 * Runs its arguments in the background with this shell's stdin, then waits. POSIX `sh` (dash on Ubuntu) points a
 * background job's stdin at /dev/null before applying its redirections, so `<&0` alone would hand the supervisor
 * an empty lifetime pipe; copying the pipe to fd 3 first keeps it.
 */
export const FORWARD_STDIN = 'exec 3<&0; "$@" 0<&3 3<&- & wait "$!"';
if (found.path === null) console.info(`Skipping Mainworthy e2e. ${found.skipped}`);
export type Server = {
	url: string;
	project: string;
	token: string;
	/**
	 * The identity provider people sign in through, which this process runs (`startServer({ provider: true })`);
	 * absent or null for a server with none.
	 */
	idp?: Provider | null;
	seeded: SeedResult | null;
	api: <O extends OpName>(op: O, input: Api[O]["input"], options?: { token?: string }) => Promise<Api[O]["reply"]>;
	stop: () => Promise<void>;
};
const ownedDirectories = new Set<string>();
process.once("exit", () => {
	for (const path of ownedDirectories) rmSync(path, { recursive: true, force: true });
});
const BoundUrl = z.url().refine((value) => {
	const url = new URL(value);
	return (
		url.protocol === "http:" && url.hostname === "127.0.0.1" && Number(url.port) > 0 && url.href === `${url.origin}/`
	);
}, "fixture readiness must name its bound loopback URL");
export async function startServer({
	source = false,
	cases = 0,
	firstProject = "scratch",
	mode = "local",
	preset,
	unlinked,
	seed: seedData = cases > 0,
	days = 0,
	provider = false,
	handoff,
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
	 * The server is given a public address, `http://localhost:<port>`, and an identity provider people sign in
	 * through (`test/oidc-support.ts`, named "Example ID"), which this process runs: `idp` of the server. The
	 * provider sends the browser back to the public address, so `url` is at `localhost` too.
	 */
	provider?: boolean;
	/** Where failures of the first project are handed to an agent (`MAINWORTHY_HANDOFF_*`). */
	handoff?: { url: string; secret: string };
} = {}): Promise<Server> {
	sweepOwned(tmpdir(), "mainworthy-e2e-");
	const idp = provider ? await fakeProvider() : null;
	const oidc = idp?.config();
	const dataDir = await mkdtemp(join(tmpdir(), `mainworthy-e2e-${process.pid}-`));
	ownedDirectories.add(dataDir);
	markOwned(dataDir);
	const token = crypto.randomUUID();
	const executable = source ? undefined : process.env.MAINWORTHY_E2E_SERVER;
	let child: Bun.Subprocess<"pipe", "pipe", "pipe">;
	try {
		child = Bun.spawn(
			[
				// Observed on Bun 1.4.3: Linux no-orphans spawn installs PDEATHSIG even if the child disables it.
				// A shell fork clears that signal; the supervisor can outlive worker loss and reap its group.
				"/bin/sh",
				"-c",
				FORWARD_STDIN,
				"mainworthy-fixture-supervisor",
				process.execPath,
				"test/e2e/supervise.ts",
				JSON.stringify({
					command: executable === undefined ? [process.execPath, "test/e2e/serve.ts"] : [executable],
					data: dataDir,
				}),
			],
			{
				cwd: process.cwd(),
				env: {
					...process.env,
					// Observed on Bun 1.4.3: inherited no-orphans mode terminates on parent loss before JS
					// cleanup. Disable it so the supervisor finishes pipe-driven shutdown after worker death.
					BUN_FEATURE_FLAG_NO_ORPHANS: "0",
					NODE_ENV: "production",
					MAINWORTHY_DATA: dataDir,
					MAINWORTHY_PORT: "0",
					MAINWORTHY_MODE: mode,
					MAINWORTHY_FIRST_PROJECT: firstProject,
					MAINWORTHY_OWNER_TOKEN: token,
					MAINWORTHY_PUBLIC_URL: oidc ? "http://localhost:0" : "",
					MAINWORTHY_OIDC_ISSUER: oidc?.issuer ?? "",
					MAINWORTHY_OIDC_CLIENT_ID: oidc?.clientId ?? "",
					MAINWORTHY_OIDC_CLIENT_SECRET: oidc?.clientSecret ?? "",
					MAINWORTHY_OIDC_NAME: oidc?.name ?? "",
					MAINWORTHY_HANDOFF_PROJECT: handoff ? firstProject : "",
					MAINWORTHY_HANDOFF_URL: handoff?.url ?? "",
					MAINWORTHY_HANDOFF_SECRET: handoff?.secret ?? "",
				},
				stdout: "pipe",
				stderr: "pipe",
				stdin: "pipe",
				detached: true,
			},
		);
		// The supervisor owns cleanup while the worker is gone; the worker also removes data after its exit. A normal
		// worker exit under Bun 1.4.3 --no-orphans can kill the supervisor before cleanup, leaving directories
		// behind. Do not delete them in the worker's exit hook: the fixture can still own its database then.
		ownedDirectories.delete(dataDir);
	} catch (error) {
		idp?.stop();
		await rm(dataDir, { recursive: true, force: true });
		ownedDirectories.delete(dataDir);
		throw error;
	}
	const killFixture = () => {
		try {
			const pid = Number(readFileSync(join(dataDir, "fixture-pid"), "utf8"));
			// An empty stamp (no `/proc` to tell the fixture from a process that took its pid) signals nothing.
			const stamp = readFileSync(join(dataDir, "fixture-stamp"), "utf8");
			if (Number.isSafeInteger(pid) && pid > 0 && stamp && processIdentity(pid) === stamp)
				process.kill(-pid, "SIGKILL");
		} catch {}
	};
	const exited = child.exited.then(async (code) => {
		if (code !== 0) killFixture();
		await rm(dataDir, { recursive: true, force: true });
		return code;
	});
	let stopping: Promise<void> | undefined;
	const stop = () =>
		(stopping ??= (async () => {
			idp?.stop();
			child.stdin.end();
			// The supervisor stops a blocked fixture inside 1.5 seconds. Its own cleanup then drops the fixture's
			// database, about 7 seconds on a cluster that has just started (#961), so it gets longer, but less than
			// the 20-second test timeout (test/preflight.ts). Both bounds only catch a supervisor failure.
			const fixture = setTimeout(killFixture, 3_000);
			const supervisor = setTimeout(() => {
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {}
			}, 15_000);
			try {
				const code = await exited;
				if (code !== 0) throw new Error(`Mainworthy e2e supervisor exited with ${code}`);
			} finally {
				clearTimeout(fixture);
				clearTimeout(supervisor);
			}
		})());
	const stderr = new Response(child.stderr).text();
	const readiness = Promise.withResolvers<string>();
	void (async () => {
		const decoder = new TextDecoder();
		let output = "";
		let published = false;
		for await (const chunk of child.stdout) {
			if (published) continue;
			output += decoder.decode(chunk, { stream: true });
			const end = output.indexOf("\n");
			if (end < 0) continue;
			const url = new URL(BoundUrl.parse(output.slice(0, end).trim())).origin;
			published = true;
			readiness.resolve(url);
		}
		if (!published) throw new Error(`Mainworthy failed to start: ${await stderr}`);
	})().catch(readiness.reject);
	const deadline = setTimeout(
		() => readiness.reject(new Error("Mainworthy e2e server did not publish readiness")),
		15_000,
	);
	try {
		const bound = await readiness.promise;
		clearTimeout(deadline);
		const url = idp ? bound.replace("127.0.0.1", "localhost") : bound;
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
		return { url, project: firstProject, token, idp, seeded, api, stop };
	} catch (error) {
		await stop();
		throw error;
	} finally {
		clearTimeout(deadline);
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
/** The subject a person of this name has at the test's provider, as in `test/people-support.ts`. */
export const subjectOf = (name: string): string => `sub-${name}`;

/**
 * An identity at the test's provider: by default the one `name` joined as, `subjectOf(name)`, whose email
 * `name@example.com` names it in a list ("Example ID (name@example.com)").
 */
export type Identity = { subject: string; email?: string };
const identityOf = (name: string): Identity => ({ subject: subjectOf(name), email: `${name}@example.com` });

/** Where a ceremony begun with the provider sends the browser back to: the query the page hands the server. */
async function providerAnswer(server: Server, url: string, who: Identity): Promise<string> {
	if (!server.idp) throw new Error("this server has no identity provider: startServer({ provider: true })");
	server.idp.next(who);
	const answered = await fetch(url, { redirect: "manual" });
	const back = new URL(answered.headers.get("location") ?? "");
	if (back.origin + back.pathname !== `${server.url}/signin/oidc`)
		throw new Error(`the provider sent the browser to ${back.href}`);
	return back.search;
}

/**
 * Accepts the invitation `code` as a script would, with no page: begins with the provider, signs in there as `who`
 * and hands the answer back. The session cookie it opened, as `name=value`.
 */
export async function acceptInvitation(server: Server, code: string, who: Identity): Promise<string> {
	const post = (path: string, body: unknown, cookie = "") =>
		fetch(`${server.url}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
			body: JSON.stringify(body),
		});
	const begun = await post("/api/login/oidc", { invitation: code });
	if (!begun.ok) throw new Error(`the invitation did not begin: ${begun.status} ${await begun.text()}`);
	const ceremony = begun.headers.getSetCookie()[0]?.split(";")[0] ?? "";
	const { url } = z.object({ result: z.object({ url: z.string() }) }).parse(await begun.json()).result;
	const accepted = await post("/api/login", { oidc: await providerAnswer(server, url, who) }, ceremony);
	if (!accepted.ok) throw new Error(`the invitation was not accepted: ${accepted.status} ${await accepted.text()}`);
	return (
		accepted.headers
			.getSetCookie()
			.find((cookie) => cookie.startsWith("mainworthy_sid="))
			?.split(";")[0] ?? ""
	);
}

/**
 * Invites `name` as the owner does, with `grant`, and accepts the invitation through the provider as
 * `subjectOf(name)`, as the invitation's page does, then signs that session out: the person has no session, and
 * can be signed in by `openPage({ as })`.
 */
export async function joinPerson(
	server: Server,
	name: string,
	grant: { can?: Capability[]; project?: string } = {},
): Promise<void> {
	const invitation = await server.api("invitation", { do: "create", name, ...grant });
	if (!("code" in invitation)) throw new Error(`the invitation for ${name} has no code`);
	const cookie = await acceptInvitation(server, invitation.code, identityOf(name));
	await fetch(`${server.url}/api/logout`, {
		method: "POST",
		headers: { "content-type": "application/json", cookie },
		body: "{}",
	});
}

/** Signs `name` in through the provider in `context` as `who`, as the sign-in page's button does. */
async function signInThroughProvider(
	context: BrowserContext,
	server: Server,
	name: string,
	who: Identity = identityOf(name),
): Promise<void> {
	const begun = await context.request.post(`${server.url}/api/login/oidc`, { data: {} });
	if (!begun.ok()) throw new Error(`The e2e sign-in of ${name} did not begin: ${begun.status()}`);
	const { url } = z.object({ result: z.object({ url: z.string() }) }).parse(await begun.json()).result;
	const opened = await context.request.post(`${server.url}/api/login`, {
		data: { oidc: await providerAnswer(server, url, who) },
	});
	if (!opened.ok()) throw new Error(`The e2e sign-in of ${name} was refused: ${opened.status()}`);
}

/** One round through the provider from the browser of `context`, begun with `body`, signed in there as `who`. */
async function ceremonyIn(context: BrowserContext, server: Server, body: object, who: Identity): Promise<void> {
	const begun = await context.request.post(`${server.url}/api/login/oidc`, { data: body });
	if (!begun.ok()) throw new Error(`${JSON.stringify(body)} did not begin: ${begun.status()} ${await begun.text()}`);
	const { url } = z.object({ result: z.object({ url: z.string() }) }).parse(await begun.json()).result;
	const done = await context.request.post(`${server.url}/api/login`, {
		data: { oidc: await providerAnswer(server, url, who) },
	});
	if (!done.ok()) throw new Error(`${JSON.stringify(body)} was refused: ${done.status()} ${await done.text()}`);
}

/**
 * Links an identity to whoever is signed in in `context`, as "Link Example ID" in Settings does: the one `name`
 * joins as, or `who`. The first identity of a person needs no proof; a later one needs the session's recent
 * proof (`proveIdentity`, or a token's sign-in).
 */
export const linkIdentity = (context: BrowserContext, server: Server, name: string, who = identityOf(name)) =>
	ceremonyIn(context, server, { link: true }, who);

/** `name`, signed in in `context` through the provider, confirms it is them there: ten minutes of proof. */
export const proveIdentity = (context: BrowserContext, server: Server, name: string) =>
	ceremonyIn(context, server, { proof: true }, identityOf(name));

/**
 * Answers the "Confirm it is you" prompt on the page by signing in at the provider as `name`: the page leaves for
 * the provider and comes back to the section of Settings it was on, which says that the confirmation took. The
 * change that asked for it is not repeated: the test repeats it, as the person does.
 */
export async function confirmWithProvider(page: Page, server: Server, name: string): Promise<void> {
	if (!server.idp) throw new Error("this server has no identity provider: startServer({ provider: true })");
	server.idp.next({ subject: subjectOf(name) });
	// The page the provider sends the browser back to is a new document; the sentence of an earlier confirmation
	// may still be on the one before it.
	const back = page.waitForEvent("load");
	await page
		.getByRole("region", { name: "Confirm it is you", exact: true })
		.getByRole("button", { name: "Confirm with Example ID", exact: true })
		.click();
	await back;
	await page.getByText("Confirmed it is you. Repeat the change within ten minutes.", { exact: true }).waitFor();
}

export async function launchBrowser({ args = [] }: { args?: string[] } = {}): Promise<Browser> {
	if (found.path === null) throw new Error(found.skipped);
	return chromium.launch(chromiumLaunchOptions(found.path, args));
}
/**
 * One browser connection for a test file, and for every page a test opens a context of its own: its own storage, cache
 * and permissions, as a browser of its own had. A launch for each page was a quarter of the longest file's time.
 * The check lends this file a worker-slot browser; closing a connected Browser disconnects and closes its contexts.
 * Bun runs this hook after the file's last test. Where nothing would close a shared browser, each page has its
 * own, as before: outside `bun test` (`screenshots.ts`, `profile-latency.ts`), and in the later files of a run
 * with no `--isolate` or `--parallel`, which load this module once.
 */
let shared: Promise<Browser> | null = null;
let closesShared = false;
try {
	afterAll(async () => {
		closesShared = false;
		browserDiagnostics.clear();
		await (await shared?.catch(() => null))?.close();
		shared = null;
	}, 60_000); // A hang guard for teardown, not a browser-performance assertion (issue #497).
	closesShared = true;
} catch {}
async function fileBrowser(): Promise<Browser | null> {
	if (!closesShared) return null;
	// A timed-out test can lose its local browser or its connection. Reconnect to the runner-owned slot,
	// or launch a new local browser. A dead runner-owned slot fails clearly instead of falling back.
	if (!(await shared?.catch(() => null))?.isConnected()) {
		const endpoint = sharedBrowserEndpoint(Bun.main);
		shared = endpoint
			? chromium
					.connect(endpoint, { timeout: 10_000 })
					.then((browser) => {
						browserDiagnostics.connected(browser);
						return browser;
					})
					.catch((cause: unknown) => {
						throw new Error(
							`Cannot connect to shared Chromium for Bun worker ${process.env.BUN_TEST_WORKER_ID ?? "1"}`,
							{
								cause,
							},
						);
					})
			: launchBrowser();
	}
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
/**
 * How long the page, or the server behind it, is given to reach a state a test waits for: every action and wait
 * of a page from `openPage`, and `eventually`. One number for the whole suite. A test sets no deadline of its own:
 * one per file, from 3 to 8 s, measured how busy the machine was beside the other tests, and was half of all the
 * flaky-test issues. A state that never arrives still fails here, before the test's own guard, naming the wait.
 */
export const SETTLES = 10_000;
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
		/**
		 * Who is signed in when not the owner by their token: a person who joined through the provider (`joinPerson`),
		 * signed in there as `subjectOf(name)`, or as another identity of theirs (`linkIdentity`).
		 */
		as?: { name: string; identity?: Identity };
		/** What shows that the page is up, for a page that is neither the app nor the sign-in page. */
		ready?: string;
		/** Installs routes and init scripts before the first document loads. */
		setup?: (page: Page, context: BrowserContext) => Promise<void>;
		browser?: Browser;
		/**
		 * A phone is a window 390 wide whose pointer is a finger, so the page lays itself out for one
		 * (`src/web/lib/layout.ts`); `tap` is its press. The desktop is a mouse at 1440 by 900. ios and android use Playwright device profiles
		 * in the shared Chromium browser; they do not change its engine.
		 */
		device?: "desktop" | "phone" | "ios" | "android";
	} = {},
): Promise<PageHarness> {
	const lent = browser ?? (await fileBrowser());
	const ownedBrowser = lent ?? (await launchBrowser());
	const context = await ownedBrowser.newContext({
		...(device === "ios"
			? devices["iPhone 13"]
			: device === "android"
				? devices["Pixel 7"]
				: device === "phone"
					? { viewport: { width: 390, height: 844 }, hasTouch: true }
					: { viewport: { width: 1440, height: 900 } }),
		colorScheme: "light",
	});
	browserDiagnostics.context(context);
	context.setDefaultTimeout(SETTLES);
	routesWaitForInterception(context);
	throttleRenderers(context);
	if (signedIn) {
		if (as) await signInThroughProvider(context, server, as.name, as.identity);
		else await context.request.post(`${server.url}/api/login`, { data: { token: server.token } });
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
			errors.push(withResource(message.text(), message.location().url));
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
 * A resource that failed to load unexpectedly, named: the console says only how it failed (#654 was a
 * `net::ERR_FILE_NOT_FOUND` with no way to tell what). A test makes a load fail with a status from the server or
 * with `route.abort()` (`net::ERR_FAILED`), and asserts those as the console words them. A path of the page's own
 * server is written without its address, which changes per run.
 */
function withResource(text: string, url: string): string {
	if (!/^Failed to load resource: net::ERR_(?!FAILED$)/.test(text) || !url) return text;
	const resource = /^https?:\/\/(127\.0\.0\.1|localhost):\d+(\/.*)$/.exec(url)?.[2] ?? url;
	return `${text} (${resource})`;
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
/**
 * Returns once the suite has the project's folders: the sidebar lists the one named. The suite reads them apart
 * from its cases, so a case can show first. Until they arrive, `]` and `Alt+[` have no folder to step to and the
 * move palette offers none, and a key pressed then does nothing (issue #994). The sidebar and the suite share one
 * read of the folders, so the sidebar listing them means the suite has them too.
 */
export async function foldersShown(page: Page, name: string): Promise<void> {
	await page.locator("#tree .fo .fn").getByText(name, { exact: true }).waitFor();
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
	try {
		await route(probe, (route) => route.fulfill({ status: 204, headers: { "x-mainworthy-e2e": "intercepted" } }));
		// A busy renderer may not run the probe promptly. The test's hang guard bounds the wait, not readiness.
		while (true) {
			const intercepted = await page.evaluate(
				(url) =>
					fetch(url).then(
						(reply) => reply.headers.get("x-mainworthy-e2e") === "intercepted",
						() => false,
					),
				`/health?interception=${id}`,
			);
			if (intercepted) return;
		}
	} catch {
		// The page closed or went to another document meanwhile. Neither has a key waiting ahead of the switch.
		return;
	} finally {
		await page.unroute(probe).catch(() => {});
	}
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
	const end = Date.now() + SETTLES;
	let value = await read();
	while (!accepts(value) && Date.now() < end) {
		await Bun.sleep(40);
		value = await read();
	}
	if (!accepts(value))
		throw new Error(
			`The expected server state did not arrive within ${SETTLES / 1000} s. The last read was ${shown(value)}`,
		);
	return value;
}
/** A value in an error message: short enough to read, long enough to say what the state was. */
function shown(value: unknown): string {
	const text = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
	return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}
/**
 * Answers short proposals after their edits load. A press can reveal evidence, or meet a fresh read started by
 * the change stream (issues #322 and #411). Retry when the card was not yet shown whole at the key; otherwise
 * wait for the decide request. Two frames before each try let the gate record a reveal or re-fetch. Tests of long
 * proposals page explicitly, rather than using this helper's five tries.
 */
export async function answerWhenRead(page: Page, q: string, key: string): Promise<void> {
	for (let attempt = 1; attempt <= 5; attempt++) {
		await page.locator(`[data-proposal-evidence="${q}"][data-proposal-loaded="true"]`).waitFor();
		await page.evaluate(
			() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
		);
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
