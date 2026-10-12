import { existsSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright-core";
import type { Api, OpName } from "../../src/core/api.ts";
import { type SeedResult, seed } from "../../src/web/dev/seed.ts";
import { call } from "../../src/web/lib/api.ts";

export const chromiumPath = [
	process.env.CASEBOOK_CHROMIUM,
	"/usr/bin/chromium",
	"/usr/bin/google-chrome",
	"/usr/bin/chromium-browser",
].find((path) => path && existsSync(path));
export const browserAvailable = Boolean(chromiumPath);
if (!browserAvailable) console.info("Skipping Casebook e2e: set CASEBOOK_CHROMIUM or install system Chromium.");
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
let nextPort = 7400 + (process.pid % 50);
async function freePort(): Promise<{ port: number; release: () => Promise<void> }> {
	for (let i = 0; i < 50; i++) {
		const port = 7400 + ((nextPort++ - 7400) % 50);
		const lock = join(tmpdir(), `casebook-e2e-port-${port}`);
		try {
			await mkdir(lock);
		} catch {
			continue;
		}
		ownedDirectories.add(lock);
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
	throw new Error("No free Casebook e2e port in 7400..7449");
}
export async function startServer({
	cases = 0,
	mode = "local",
	preset,
	seed: seedData = cases > 0,
}: {
	cases?: number;
	mode?: "local" | "server";
	preset?: string;
	seed?: boolean;
} = {}): Promise<Server> {
	const dataDir = await mkdtemp(join(tmpdir(), `casebook-e2e-${process.pid}-`));
	ownedDirectories.add(dataDir);
	const reservation = await freePort();
	const port = reservation.port;
	const token = crypto.randomUUID();
	const url = `http://127.0.0.1:${port}`;
	const child = Bun.spawn([process.execPath, "test/e2e/serve.ts"], {
		cwd: process.cwd(),
		env: {
			...process.env,
			NODE_ENV: "production",
			CASEBOOK_DATA: dataDir,
			CASEBOOK_PORT: String(port),
			CASEBOOK_MODE: mode,
			CASEBOOK_OWNER_TOKEN: token,
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
				throw new Error(`Casebook failed to start: ${await new Response(child.stderr).text()}`);
			try {
				ready = (await fetch(`${url}/healthz`)).ok;
			} catch {}
			if (ready) break;
			await Bun.sleep(50);
		}
		if (!ready) throw new Error("Casebook e2e server did not become ready");
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
export async function launchBrowser(): Promise<Browser> {
	if (!chromiumPath) throw new Error("System Chromium is missing");
	return chromium.launch({
		executablePath: chromiumPath,
		headless: true,
		args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
	});
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
	const ownedBrowser = browser ?? (await launchBrowser());
	const context = await ownedBrowser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "light" });
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
		Object.defineProperty(window, "casebookKeyCount", { get: () => count });
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
			if (!browser) await ownedBrowser.close();
		},
	};
}
export async function keyCount(page: Page): Promise<number> {
	return page.evaluate(() => {
		const value: unknown = Reflect.get(window, "casebookKeyCount");
		return typeof value === "number" ? value : 0;
	});
}
export async function paste(page: Page, text: string): Promise<void> {
	await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
	await page.evaluate((value) => navigator.clipboard.writeText(value), text);
	await page.keyboard.press("Control+V");
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
