// The web UI under the policy the server sends with it, in a real browser: nothing the app does is refused, a
// script that was not served by this instance is, and no other page can put the workbench in a frame.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { SESSION_LIFETIMES } from "../../src/server/kernel/app.ts";
import { start } from "../../src/server/start.ts";
import { securityHeaders } from "../../src/surfaces/headers.ts";
import { browserAvailable, eventually, launchBrowser, openPage, reservePort, startServer } from "./support.ts";

type Violation = { directive: string; blocked: string };

/** Records every refusal the browser reports for this page, from the first byte of each document it loads. */
const VIOLATIONS = "mainworthyPolicyViolations";
function recordViolations(name: string): void {
	const seen: Violation[] = [];
	Object.defineProperty(window, name, { get: () => seen });
	document.addEventListener("securitypolicyviolation", (event) => {
		seen.push({ directive: event.effectiveDirective, blocked: event.blockedURI });
	});
}

test.skipIf(!browserAvailable)(
	"the app signs in, opens a case and works the queue under the strict policy, and the browser refuses nothing",
	async () => {
		const server = await startServer({ cases: 8, mode: "server" });
		const browser = await openPage(server, { signedIn: false, path: "/p/scratch/suite" });
		try {
			const { page } = browser;
			page.setDefaultTimeout(10_000);
			const violations = () => page.evaluate((name): unknown => Reflect.get(window, name), VIOLATIONS);
			// The sign-in page is loaded once more with the recorder in place, so the first load is recorded too.
			await page.addInitScript(recordViolations, VIOLATIONS);
			const reloaded = await page.reload();
			const policy = securityHeaders({ url: server.url, forwardedProto: null }, { kind: "page" })[
				"content-security-policy"
			];
			expect(policy).not.toContain("unsafe");
			expect(reloaded?.headers()["content-security-policy"]).toBe(policy ?? "");
			expect(reloaded?.headers()["x-frame-options"]).toBe("DENY");

			// The change stream is a connection of its own, and it too must be allowed.
			const stream = page.waitForResponse((response) => response.url().endsWith("/api/p/scratch/events"));
			await page.getByRole("textbox", { name: "Sign in with your token" }).fill(server.token);
			await page.keyboard.press("Enter");
			await page.locator("#app").waitFor();
			await page.goto(`${server.url}/p/scratch/suite/c/1`);
			await page.getByRole("button", { name: "Expired coupon is rejected", exact: true }).waitFor();
			await page.keyboard.press("e");
			await page.getByRole("textbox", { name: "Step 1", exact: true }).fill("Open the cart with two items");
			await page.keyboard.press("Escape");
			await page.keyboard.type("gq");
			await page.waitForURL("**/p/scratch/queue");
			await page.locator("[data-current-question]").waitFor();
			expect((await stream).status()).toBe(200);
			expect(await violations()).toEqual([]);
			expect(browser.errors).toEqual([]);

			// The same recorder does see a refusal: a script written into the page is not run.
			await page.evaluate(() => {
				const script = document.createElement("script");
				script.textContent = "window.mainworthyInjected = true";
				document.head.append(script);
			});
			expect(await page.evaluate((): unknown => Reflect.get(window, "mainworthyInjected"))).toBeUndefined();
			expect(await violations()).toEqual([{ directive: "script-src-elem", blocked: "inline" }]);
		} finally {
			await browser.close();
			await server.stop();
		}
	},
	45_000,
);

test.skipIf(!browserAvailable)(
	"a page on another origin cannot put the local workbench, which needs no sign-in, in a frame",
	async () => {
		const server = await startServer({ cases: 1 });
		const reservation = await reservePort();
		// The other origin: a page that frames the app and says when the frame has settled, loaded or refused.
		const other = Bun.serve({
			hostname: "127.0.0.1",
			port: reservation.port,
			fetch: () =>
				new Response(
					`<!doctype html><title>waiting</title><iframe src="${server.url}/p/scratch/suite" onload="document.title = 'settled'"></iframe>`,
					{ headers: { "content-type": "text/html" } },
				),
		});
		const browser = await openPage(server);
		try {
			const { page } = browser;
			// The app itself opens for this browser without a token: that is what a frame would show.
			expect(await page.locator("#app").count()).toBe(1);
			await page.goto(`http://127.0.0.1:${reservation.port}/`);
			await page.waitForFunction(() => document.title === "settled");
			const frame = page.frames().find((candidate) => candidate !== page.mainFrame());
			expect(frame).toBeDefined();
			expect(await frame?.locator("#root").count()).toBe(0);
			expect(browser.errors.filter((error) => /frame-ancestors|X-Frame-Options/.test(error))).toHaveLength(1);
		} finally {
			await browser.close();
			await other.stop(true);
			await reservation.release();
			await server.stop();
		}
	},
	30_000,
);

/** Whether a page can open a WebSocket at an address: run in the page, so the browser sends that page's Origin. */
const opens = (address: string): Promise<boolean> =>
	new Promise((resolve) => {
		const tried = new WebSocket(address);
		tried.onopen = () => resolve(true);
		tried.onerror = () => resolve(false);
	});

test.skipIf(!browserAvailable)(
	"in development a file changed on disk reaches the open page through the relayed reload socket, which a page on another origin cannot open",
	async () => {
		// A page of this test's own, so that changing it changes no file of the repository. Bun bundles it the way
		// it bundles the app from source, and in development, because a test process is not a production one.
		const directory = mkdtempSync(join(tmpdir(), "mainworthy-reload-"));
		writeFileSync(
			join(directory, "index.html"),
			'<!doctype html><title>reload</title><p id="text">nothing yet</p><script type="module" src="./page.js"></script>',
		);
		const write = (text: string) =>
			writeFileSync(join(directory, "page.js"), `document.getElementById("text").textContent = "${text}";\n`);
		write("as first written");
		const imported = z.object({ default: z.unknown() }).parse(await import(join(directory, "index.html")));
		const app = await reservePort();
		const elsewhere = await reservePort();
		const instance = start(
			{
				dataDir: join(directory, "data"),
				host: "127.0.0.1",
				port: app.port,
				mode: "local",
				owner: "robin",
				ownerToken: null,
				commit: null,
				proxy: null,
				...SESSION_LIFETIMES,
			},
			() => ({ ui: imported.default }),
		);
		const other = Bun.serve({
			hostname: "127.0.0.1",
			port: elsewhere.port,
			fetch: () =>
				new Response("<!doctype html><title>another origin</title>", { headers: { "content-type": "text/html" } }),
		});
		const browser = await launchBrowser();
		try {
			const page = await browser.newPage();
			const errors: string[] = [];
			page.on("pageerror", (error) => errors.push(error.message));
			page.on("console", (message) => {
				if (message.type() === "error") errors.push(message.text());
			});
			const reload = `${instance.url.replace("http", "ws")}/_bun/hmr`;
			const frames = { sent: 0, received: 0 };
			page.on("websocket", (socket) => {
				if (socket.url() !== reload) return;
				socket.on("framesent", () => frames.sent++);
				socket.on("framereceived", () => frames.received++);
			});
			const reply = await page.goto(instance.url);
			expect(reply?.headers()["content-security-policy"]).toContain("script-src 'self' blob: 'sha256-");
			await page.getByText("as first written").waitFor();
			// The page tells the bundler which files it shows, and the bundler answers; a change made before that
			// is sent to nobody. Both directions of the relay have carried something by then.
			await eventually(
				async () => frames,
				(seen) => seen.sent > 0 && seen.received > 1,
			);
			write("as changed on disk");
			await page.getByText("as changed on disk").waitFor({ timeout: 10_000 });
			expect(errors).toEqual([]);

			// The same address from a page on another origin: this machine too, another port. Bun's own check lets
			// that Origin in; the server's rule for its own page does not.
			const foreign = await browser.newPage();
			await foreign.goto(`http://127.0.0.1:${elsewhere.port}/`);
			expect(await foreign.evaluate(opens, reload)).toBe(false);
			expect(await page.evaluate(opens, reload)).toBe(true);
		} finally {
			await browser.close();
			await other.stop(true);
			await instance.stop();
			await app.release();
			await elsewhere.release();
			rmSync(directory, { recursive: true, force: true });
		}
	},
	30_000,
);
