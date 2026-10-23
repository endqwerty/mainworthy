import { expect, test } from "bun:test";
import { chromium, type Page, type Request } from "playwright-core";
import { browserAvailable, eventually, launchBrowser, reservePort, startServer } from "./support.ts";

const check = test.skipIf(!browserAvailable);

async function workbench(setup?: (page: Page) => Promise<void>) {
	const server = await startServer({ mode: "server" });
	await server.api("propose", { edits: [{ op: "create", outline: "Before the pause" }] });
	const port = await reservePort();
	const browser = await launchBrowser({ args: [`--remote-debugging-port=${port.port}`] });
	// Playwright normally forces every page visible through its own CDP session. The default context
	// with noDefaults leaves visibility under Chromium's control, including in the headless shell.
	const connection = await chromium.connectOverCDP(`http://127.0.0.1:${port.port}`, { noDefaults: true });
	const close = async () => {
		await connection.close();
		await browser.close();
		await port.release();
		await server.stop();
	};
	try {
		const context = connection.contexts()[0];
		if (!context) throw new Error("Chromium has no default context");
		await context.request.post(`${server.url}/api/login`, { data: { token: server.token } });
		const page = await context.newPage();
		await page.setViewportSize({ width: 1440, height: 900 });
		await page.clock.install();
		const active = new Set<Request>();
		let opened = 0;
		page.on("request", (request) => {
			if (request.url().endsWith("/events")) {
				opened++;
			}
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
			opened: () => opened,
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
			expect(h.opened()).toBe(1);
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
				async () => h.opened(),
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
				const opened = h.opened();
				await page.clock.fastForward(60_000);
				expect(h.opened()).toBe(opened);
				await input();
				await eventually(
					async () => h.opened(),
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
				const opened = h.opened();
				const checked = page.waitForResponse((response) => response.url().endsWith("/api/session"));
				release();
				await checked;
				await page.clock.fastForward(2_000);
				expect(h.opened()).toBe(opened);
				expect(h.active.size).toBe(0);
				if (reason === "hidden") await h.visibility("visible");
				else await page.keyboard.press("Shift");
				await eventually(
					async () => h.opened(),
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
