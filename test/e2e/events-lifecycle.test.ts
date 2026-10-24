import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Browser, chromium, type Page, type Request } from "playwright-core";
import { browserAvailable, eventually, launchBrowser, startServer } from "./support.ts";

const check = test.skipIf(!browserAvailable);

type Server = Awaited<ReturnType<typeof startServer>>;

async function workbench(setup?: (page: Page) => Promise<void>, seed?: (server: Server) => Promise<unknown>) {
	const server = await startServer({ mode: "server" });
	await server.api("propose", { edits: [{ op: "create", outline: "Before the pause" }] });
	await seed?.(server);
	const browser = await launchBrowser({ args: ["--remote-debugging-port=0", "--enable-automation"] }).catch(
		async (error: unknown) => {
			await server.stop();
			throw error;
		},
	);
	let connection: Browser | undefined;
	const close = async () => {
		await connection?.close();
		await browser.close();
		await server.stop();
	};
	try {
		const session = await browser.newBrowserCDPSession();
		const { arguments: args } = await session.send("Browser.getBrowserCommandLine");
		await session.detach();
		const profile = args.find((arg) => arg.startsWith("--user-data-dir="))?.slice("--user-data-dir=".length);
		if (!profile) throw new Error("Chromium did not publish its profile directory");
		const [port] = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).trim().split("\n");
		// Playwright normally forces every page visible through its own CDP session. The default context
		// with noDefaults leaves visibility under Chromium's control, including in the headless shell.
		connection = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults: true });
		const context = connection.contexts()[0];
		if (!context) throw new Error("Chromium has no default context");
		await context.request.post(`${server.url}/api/login`, { data: { token: server.token } });
		const page = await context.newPage();
		await page.setViewportSize({ width: 1440, height: 900 });
		await page.clock.install();
		const active = new Set<Request>();
		// Counted in the page, where the constructor runs: a network event reaches this process only after the
		// clock call that caused it has returned, so a count kept here could miss a stream the page just opened.
		await page.addInitScript(() => {
			const Native = window.EventSource;
			const counted = { opened: 0 };
			Object.assign(window, { streamsOpened: counted });
			window.EventSource = class extends Native {
				constructor(url: string | URL, init?: EventSourceInit) {
					super(url, init);
					counted.opened++;
				}
			};
		});
		page.on("response", (response) => {
			if (response.url().endsWith("/events") && response.status() === 200) active.add(response.request());
		});
		page.on("requestfailed", (request) => active.delete(request));
		page.on("requestfinished", (request) => active.delete(request));
		await setup?.(page);
		const stream = page.waitForResponse((response) => response.url().endsWith("/events"));
		await page.goto(`${server.url}/p/scratch/suite`);
		await page.getByRole("option").filter({ hasText: "Before the pause" }).waitFor();
		const response = await stream;
		await eventually(
			async () => active.size,
			(n) => n === (response.status() === 200 ? 1 : 0),
		);
		await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000);
		const cdp = await context.newCDPSession(page);
		const { windowId } = await cdp.send("Browser.getWindowForTarget");
		return {
			server,
			page,
			active,
			opened: () =>
				page.evaluate(() => (window as unknown as { streamsOpened: { opened: number } }).streamsOpened.opened),
			async visibility(state: "hidden" | "visible") {
				await cdp.send("Browser.setWindowBounds", {
					windowId,
					bounds: { windowState: state === "hidden" ? "minimized" : "normal" },
				});
				expect(await page.evaluate(() => document.visibilityState)).toBe(state);
			},
			close,
		};
	} catch (error) {
		await close();
		throw error;
	}
}

check(
	"a short hide keeps the stream; a minute hidden closes it and returning catches up",
	async () => {
		const h = await workbench();
		try {
			const { page } = h;
			await h.visibility("hidden");
			await page.clock.fastForward(59_000);
			expect(h.active.size).toBe(1);
			await h.visibility("visible");
			await page.clock.fastForward(2_000);
			expect(await h.opened()).toBe(1);
			expect(h.active.size).toBe(1);

			await h.visibility("hidden");
			await page.clock.fastForward(60_000);
			await eventually(
				async () => h.active.size,
				(n) => n === 0,
			);
			expect(await page.locator("#stat").textContent()).not.toContain("disconnected");
			await h.server.api("propose", {
				edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Changed while hidden" } }],
			});
			await h.visibility("visible");
			await eventually(
				() => h.opened(),
				(n) => n === 2,
			);
			await page.clock.resume();
			await page.getByRole("option").filter({ hasText: "Changed while hidden" }).waitFor();
		} finally {
			await h.close();
		}
	},
	30_000,
);

check(
	"visible inactivity closes the stream, and keyboard and pointer input each resume it",
	async () => {
		const h = await workbench();
		try {
			const { page } = h;
			for (const input of [() => page.keyboard.press("Shift"), () => page.mouse.click(10, 10)]) {
				await page.clock.fastForward(29 * 60_000);
				expect(h.active.size).toBe(1);
				await page.clock.fastForward(60_000);
				await eventually(
					async () => h.active.size,
					(n) => n === 0,
				);
				expect(await page.locator("#stat").textContent()).not.toContain("disconnected");
				const opened = await h.opened();
				await page.clock.fastForward(60_000);
				expect(await h.opened()).toBe(opened);
				await input();
				await eventually(
					() => h.opened(),
					(n) => n === opened + 1,
				);
				await eventually(
					async () => h.active.size,
					(n) => n === 1,
				);
			}
		} finally {
			await h.close();
		}
	},
	30_000,
);

for (const reason of ["hidden", "idle"])
	check(
		`a delayed reconnect session check cannot reopen a stream paused because ${reason}`,
		async () => {
			let release = () => {};
			const held = new Promise<void>((resolve) => {
				release = resolve;
			});
			let failed = false;
			let checking = false;
			const h = await workbench(async (page) => {
				await page.route("**/events", async (route) => {
					if (!failed) {
						failed = true;
						await route.fulfill({ status: 502, body: "Unavailable" });
					} else await route.continue();
				});
				await page.route("**/api/session", async (route) => {
					if (failed) {
						checking = true;
						await held;
					}
					await route.continue();
				});
			});
			try {
				const { page } = h;
				await eventually(async () => checking, Boolean);
				if (reason === "hidden") await h.visibility("hidden");
				await page.clock.fastForward(reason === "hidden" ? 60_000 : 30 * 60_000);
				const opened = await h.opened();
				const checked = page.waitForResponse((response) => response.url().endsWith("/api/session"));
				release();
				await checked;
				await page.clock.fastForward(2_000);
				expect(await h.opened()).toBe(opened);
				expect(h.active.size).toBe(0);
				if (reason === "hidden") await h.visibility("visible");
				else await page.keyboard.press("Shift");
				await eventually(
					() => h.opened(),
					(n) => n === opened + 1,
				);
				await eventually(
					async () => h.active.size,
					(n) => n === 1,
				);
			} finally {
				release();
				await h.close();
			}
		},
		30_000,
	);

check(
	"a project opened after a pause does not keep the pause in the status line",
	async () => {
		const h = await workbench(undefined, (server) =>
			server.api("admin", { do: "project.create", key: "other", name: "Other", preset: "standard" }),
		);
		try {
			const { page } = h;
			// The picker is open before the pause, so the key that leaves for the other project is the first input
			// after it: it reopens this project's stream at the moment the page moves on.
			await page.keyboard.type("gp");
			await page.getByRole("region", { name: "Switch project", exact: true }).waitFor();
			await page.clock.fastForward(30 * 60_000);
			await eventually(
				async () => h.active.size,
				(n) => n === 0,
			);
			expect(await page.locator("#stat").textContent()).toContain("paused");
			await page.clock.resume();
			await page.keyboard.press("Enter");
			await page.waitForURL(/\/p\/other\//);
			await eventually(
				async () => [...h.active].map((request) => new URL(request.url()).pathname),
				(paths) => paths.length === 1 && paths[0] === "/api/p/other/events",
			);
			expect(await page.locator("#stat").textContent()).not.toContain("paused");
		} finally {
			await h.close();
		}
	},
	30_000,
);
