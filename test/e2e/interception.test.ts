// A route must be in force before the next key is pressed (`interceptionLive` in `support.ts`).
import { expect, test } from "bun:test";
import { browserAvailable, interceptionLive, openPage, startServer } from "./support.ts";

const check = test.skipIf(!browserAvailable);

check(
	"a busy page can confirm an installed route after more than ten seconds",
	async () => {
		const server = await startServer();
		const h = await openPage(server);
		try {
			const { page } = h;
			await page.route("**/never-requested", (route) => route.abort());
			let started = () => {};
			const busy = new Promise<void>((resolve) => {
				started = resolve;
			});
			await page.exposeFunction("mainworthyBusy", started);
			const blocking = page.evaluate(() => {
				window.addEventListener("keydown", (event) => {
					if (event.key === "F8") void fetch("/health?key");
				});
				const notify: unknown = Reflect.get(window, "mainworthyBusy");
				if (typeof notify !== "function") throw new Error("The busy-page binding is missing");
				void notify();
				// Keep a real renderer busy beyond the former readiness deadline (issue #406).
				const end = performance.now() + 11_000;
				while (performance.now() < end);
			});
			await busy;
			const intercepted: string[] = [];
			try {
				await page.route("**/health?key", (route) => {
					intercepted.push(route.request().url());
					return route.fulfill({ status: 204 });
				});
			} finally {
				await blocking;
			}
			const answered = page.waitForResponse(`${server.url}/health?key`);
			await page.keyboard.press("F8");
			expect((await answered).status()).toBe(204);
			expect(intercepted).toEqual([`${server.url}/health?key`]);
			expect(h.errors).toEqual([]);
		} finally {
			await h.close();
			await server.stop();
		}
	},
	60_000,
);

// Chromium acknowledges that it will intercept before a page that is already open sends its requests through the
// interceptor, and that page handles a key before it makes the switch. Here the page is kept busy across both, so
// the order is forced: without the wait, the request the key sends is never paused. `page.route` cannot force it
// (it also waits for an answer from the page itself), so the interception is switched on over the protocol.
check(
	"after interceptionLive, the request sent by the next key press is intercepted even while the page is busy",
	async () => {
		const server = await startServer();
		try {
			for (let round = 0; round < 5; round++) {
				const h = await openPage(server);
				try {
					const { page } = h;
					const cdp = await page.context().newCDPSession(page);
					const paused: string[] = [];
					cdp.on("Fetch.requestPaused", (event) => {
						paused.push(event.request.url);
						void cdp.send("Fetch.continueRequest", { requestId: event.requestId }).catch(() => {});
					});
					await cdp.send("Debugger.enable");
					const entered = new Promise<void>((resolve) => cdp.once("Debugger.paused", () => resolve()));
					const blocking = page.evaluate(() => {
						window.addEventListener("keydown", (event) => {
							if (event.key === "F8") void fetch("/health?key").then(() => Reflect.set(window, "keyRequestDone", true));
						});
						// biome-ignore lint/suspicious/noDebugger: hold the renderer until interception is enabled.
						debugger;
					});
					await entered;
					await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
					const ready = interceptionLive(page);
					await cdp.send("Debugger.resume");
					await blocking;
					await ready;
					await page.keyboard.press("F8");
					await page.waitForFunction(() => Reflect.get(window, "keyRequestDone") === true);
					expect(paused.filter((url) => url.endsWith("/health?key"))).toHaveLength(1);
				} finally {
					await h.close();
				}
			}
		} finally {
			await server.stop();
		}
	},
	60_000,
);

check(
	"a route installed on a page or on its context has waited for every open page before it returns",
	async () => {
		const server = await startServer();
		const h = await openPage(server);
		try {
			await h.page.route("**/health?page-route", (route) => route.fulfill({ status: 204 }));
			expect(await h.page.evaluate(() => fetch("/health?page-route").then((reply) => reply.status))).toBe(204);
			// A page opened later is covered, including a route installed before its first document.
			const later = await h.context.newPage();
			await later.route("**/health?later-route", (route) => route.fulfill({ status: 202 }));
			await later.goto(`${server.url}/p/scratch/suite`);
			await later.waitForSelector("#app");
			expect(await later.evaluate(() => fetch("/health?later-route").then((reply) => reply.status))).toBe(202);
			await h.context.route("**/health?context-route", (route) => route.fulfill({ status: 203 }));
			for (const page of [h.page, later])
				expect(await page.evaluate(() => fetch("/health?context-route").then((reply) => reply.status))).toBe(203);
			// The readiness probe leaves no route behind and causes no page error.
			expect(h.errors).toEqual([]);
			expect(await h.page.evaluate(() => fetch("/health?interception=x").then((reply) => reply.status))).toBe(200);
			await later.close();
			await h.context.route("**/health?after-close", (route) => route.fulfill({ status: 205 }));
			expect(await h.page.evaluate(() => fetch("/health?after-close").then((reply) => reply.status))).toBe(205);
		} finally {
			await h.close();
			await server.stop();
		}
	},
	30_000,
);
