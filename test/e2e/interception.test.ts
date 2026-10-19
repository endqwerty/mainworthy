// A route must be in force before the next key is pressed (`interceptionLive` in `support.ts`).
import { expect, test } from "bun:test";
import type { Page } from "playwright-core";
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
					if (event.key === "F8") void fetch("/healthz?key");
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
				await page.route("**/healthz?key", (route) => {
					intercepted.push(route.request().url());
					return route.fulfill({ status: 204 });
				});
			} finally {
				await blocking;
			}
			const answered = page.waitForResponse(`${server.url}/healthz?key`);
			await page.keyboard.press("F8");
			expect((await answered).status()).toBe(204);
			expect(intercepted).toEqual([`${server.url}/healthz?key`]);
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
					await page.evaluate(() => {
						window.addEventListener("keydown", (event) => {
							if (event.key === "F8")
								void fetch("/healthz?key").then(() => Reflect.set(window, "keyRequestDone", true));
						});
						setTimeout(() => {
							const end = performance.now() + 300;
							while (performance.now() < end);
						}, 0);
					});
					await Bun.sleep(20);
					await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
					await interceptionLive(page);
					await page.keyboard.press("F8");
					await page.waitForFunction(() => Reflect.get(window, "keyRequestDone") === true);
					expect(paused.filter((url) => url.endsWith("/healthz?key"))).toHaveLength(1);
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

/** The requests by which a page was seen to be intercepted. */
function probes(page: Page): string[] {
	const seen: string[] = [];
	page.on("request", (request) => {
		if (new URL(request.url()).searchParams.has("interception")) seen.push(request.url());
	});
	return seen;
}

check(
	"a route installed on a page or on its context has waited for every open page before it returns",
	async () => {
		const server = await startServer();
		const h = await openPage(server);
		try {
			const first = probes(h.page);
			await h.page.route("**/never-requested", (route) => route.abort());
			expect(first).toHaveLength(1);
			// A page the context opens later is covered too, and one with no document yet has nothing to wait for.
			const later = await h.context.newPage();
			const second = probes(later);
			await later.route("**/never-requested", (route) => route.abort());
			expect([first.length, second.length]).toEqual([2, 0]);
			await later.goto(`${server.url}/p/scratch/suite`);
			await later.waitForSelector("#app");
			await h.context.route("**/never-requested-either", (route) => route.abort());
			expect([first.length, second.length]).toEqual([3, 1]);
			// The probe is not an error in the page and leaves no route behind.
			expect(h.errors).toEqual([]);
			expect(await h.page.evaluate(() => fetch("/healthz?interception=x").then((reply) => reply.status))).toBe(200);
			// A page that has closed is passed over.
			await later.close();
			await h.context.route("**/never-requested-again", (route) => route.abort());
			expect(first.length).toBeGreaterThan(3);
		} finally {
			await h.close();
			await server.stop();
		}
	},
	30_000,
);
