// The documentation as a person meets it: from the app's links to a page that works in a browser, and the one
// page whose contents only a browser can check, the keys.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Page } from "playwright-core";
import { browserAvailable, openPage, startServer } from "./support.ts";

/** A page the app opened in a new tab, with what went wrong on it: a refused script or frame is an error here. */
async function opened(page: Page, act: () => Promise<unknown>): Promise<{ tab: Page; errors: string[] }> {
	const [tab] = await Promise.all([page.context().waitForEvent("page"), act()]);
	const errors: string[] = [];
	tab.on("pageerror", (error) => errors.push(error.message));
	tab.on("console", (message) => {
		if (message.type() === "error") errors.push(message.text());
	});
	await tab.waitForLoadState("domcontentloaded");
	return { tab, errors };
}

test.skipIf(!browserAvailable)(
	"the app leads to the docs, and a page of the docs works: theme, diagram, search",
	async () => {
		// Nothing is seeded: the queue is empty, and says how a question gets there.
		const server = await startServer();
		const browser = await openPage(server, { path: "/p/scratch/queue" });
		try {
			const { page } = browser;
			// The sidebar, the Keys overlay and the empty queue each link to the page about this screen.
			const docs = page.getByRole("link", { name: "Docs", exact: true });
			expect(await docs.getAttribute("href")).toBe("/docs/decide");
			expect(await docs.getAttribute("target")).toBe("_blank");
			expect(await page.locator(".empty-state a").getAttribute("href")).toBe("/docs/decide");
			await page.keyboard.press("?");
			const help = page.getByRole("region", { name: "Keyboard shortcuts" });
			expect(await help.getByRole("link", { name: /Docs for this screen/ }).getAttribute("href")).toBe("/docs/decide");
			expect(await help.getByRole("link", { name: /Every key/ }).getAttribute("href")).toBe("/docs/keyboard");
			await page.keyboard.press("Escape");
			// The palette finds a page by a word of its title.
			await page.keyboard.press("Control+k");
			await page.getByRole("textbox", { name: "Jump to or run" }).fill("docs policy");
			expect(await page.getByRole("option").allInnerTexts()).toEqual([expect.stringContaining("Docs: Policy")]);
			await page.keyboard.press("Escape");

			// The theme chosen in the app is the theme of the docs, which open beside it with g d.
			await page.getByRole("button", { name: "Toggle theme" }).click();
			expect(await page.locator("html").getAttribute("data-theme")).toBe("dark");
			const { tab, errors } = await opened(page, () => page.keyboard.type("gd"));
			await tab.waitForURL("**/docs/decide");
			expect(await tab.title()).toBe("Decide in the queue · Mainworthy docs");
			expect(await tab.locator("html").getAttribute("data-theme")).toBe("dark");
			expect(await tab.locator('.side a[aria-current="page"]').innerText()).toBe("Decide in the queue");
			expect(await tab.locator(".toc a").count()).toBeGreaterThan(2);

			// The diagram is the interactive one, drawn, in the page's theme, and it could not reach the app.
			// A diagram below the first screen is fetched when the reader gets to it.
			await tab.locator(".diagram iframe").first().scrollIntoViewIfNeeded();
			const frame = tab.frameLocator(".diagram iframe").first();
			await frame.locator("svg").first().waitFor();
			expect(await tab.locator(".diagram iframe").first().getAttribute("src")).toContain("theme=dark");
			expect(await frame.locator("html").getAttribute("data-theme")).toBe("dark");
			const diagram = tab.frames().find((candidate) => candidate.url().includes("/docs/diagrams/"));
			expect(await diagram?.evaluate(() => window.origin)).toBe("null");
			expect(
				await diagram?.evaluate(() =>
					fetch("/api/session").then(
						(reply) => `answered ${reply.status}`,
						() => "refused",
					),
				),
			).toBe("refused");

			// The search finds a word under the heading that explains it, and Enter goes there.
			await tab.keyboard.press("/");
			await tab.keyboard.type("exit code");
			const first = tab.locator("#search-results a").first();
			await first.waitFor();
			expect(await tab.locator("#search-results a").count()).toBeGreaterThan(1);
			expect(await first.getAttribute("aria-selected")).toBe("true");
			const target = await first.getAttribute("href");
			await tab.keyboard.press("Enter");
			await tab.waitForURL(`**${target}`);

			// A screenshot is the one for the theme, and a code block can be copied.
			await tab.goto(`${server.url}/docs/quickstart`);
			expect(await tab.locator("pre .copy").count()).toBeGreaterThan(2);
			await tab.getByRole("button", { name: "Toggle theme" }).click();
			expect(await tab.locator("html").getAttribute("data-theme")).toBe("light");
			// The frame's own refusal of the API call above is the one message a browser prints.
			expect(errors.filter((error) => !/api\/session|Content Security Policy/.test(error))).toEqual([]);
			expect(browser.errors).toEqual([]);
		} finally {
			await browser.close();
			await server.stop();
		}
	},
	45_000,
);

test.skipIf(!browserAvailable)(
	"someone who is not signed in can still read the docs",
	async () => {
		const server = await startServer({ mode: "server" });
		const browser = await openPage(server, { signedIn: false });
		try {
			const { page } = browser;
			const link = page.getByRole("link", { name: /Read the docs/ });
			expect(await link.getAttribute("href")).toBe("/docs");
			const { tab } = await opened(page, () => link.click());
			await tab.locator("article h1").waitFor();
			expect(await tab.locator("article h1").innerText()).toBe("Mainworthy documentation");
			// The list of pages on the first page is made from the pages themselves.
			expect(await tab.locator("article").getByRole("link", { name: "Quickstart" }).count()).toBeGreaterThan(0);
		} finally {
			await browser.close();
			await server.stop();
		}
	},
	30_000,
);

/** The rows of the keyboard page: the keys in the first cell, and what the second cell says they do. */
function documentedKeys(): { keys: Set<string>; does: string }[] {
	return readFileSync("docs/guide/keyboard.md", "utf8")
		.split("\n")
		.filter((line) => line.startsWith("| <kbd>"))
		.map((line) => {
			const [, keys = "", does = ""] = line.split("|").map((cell) => cell.trim());
			return {
				keys: new Set([...keys.matchAll(/<kbd>([^<]+)<\/kbd>/g)].map((match) => (match[1] ?? "").toLowerCase())),
				does: does.toLowerCase(),
			};
		});
}

/** How the keyboard page writes the last key of a binding that the Keys overlay shows as `g s`, `⌘k` or `shift+enter`. */
function lastKey(binding: string): string {
	const name = (binding.split(/[ +]/).at(-1) ?? "").replace(/^⌘/, "");
	const written: Record<string, string> = {
		arrowdown: "↓",
		arrowup: "↑",
		arrowleft: "←",
		arrowright: "→",
		enter: "↵",
		escape: "esc",
		backspace: "⌫",
	};
	return written[name] ?? name;
}

test.skipIf(!browserAvailable)(
	"every key the Keys overlay lists on a screen is on the keyboard page, with the same words",
	async () => {
		const server = await startServer({ cases: 12 });
		const run = server.seeded?.run ?? "R-1";
		const browser = await openPage(server);
		try {
			const { page } = browser;
			const documented = documentedKeys();
			expect(documented.length).toBeGreaterThan(40);
			const missing = new Set<string>();
			const screens = [
				["/p/scratch/suite", "Next case"],
				["/p/scratch/suite/c/1", "Next case"],
				["/p/scratch/queue", "Next question"],
				["/p/scratch/runs", "Next run"],
				[`/p/scratch/runs/${run.slice(2)}`, "Next slot"],
				["/p/scratch/changes/pr%3A482", "Next change"],
				["/p/scratch/tests", "Next test"],
				["/p/scratch/reports", "Next report"],
				["/p/scratch/reports/flaky", "Next report page"],
				["/p/scratch/settings", "Next setting"],
			] satisfies [string, string][];
			let listed = 0;
			const repeated = new Set<string>();
			for (const [path, binding] of screens) {
				await page.goto(`${server.url}${path}`);
				await page.locator("#list").waitFor();
				await page.locator('#list [role="option"]').first().waitFor();
				if (path.endsWith("/suite/c/1")) await page.locator("#detail .ctitle").waitFor();
				if (path.includes("/runs/"))
					await page.locator('[data-run-document][data-active="true"][data-ready="true"]').waitFor();
				await page.keyboard.press("?");
				const rows = page.getByRole("region", { name: "Keyboard shortcuts" }).locator(".hk");
				await rows.filter({ hasText: binding }).first().waitFor();
				const seen = new Set<string>();
				for (const row of await rows.all()) {
					const label = (await row.locator("span").first().innerText()).trim().toLowerCase();
					const key = (await row.locator("kbd").innerText()).trim().toLowerCase();
					listed++;
					// A key that several things on one screen register is listed once, or the list cannot say which acts.
					if (seen.has(`${key} ${label}`)) repeated.add(`${path}: ${key} "${label}"`);
					seen.add(`${key} ${label}`);
					const found = documented.some(
						(entry) => (entry.does.startsWith(label) || label.startsWith(entry.does)) && entry.keys.has(lastKey(key)),
					);
					if (!found) missing.add(`${path}: ${key} "${label}"`);
				}
				await page.keyboard.press("Escape");
			}
			expect(listed).toBeGreaterThan(80);
			expect([...missing], "add these to docs/guide/keyboard.md").toEqual([]);
			expect([...repeated], "each key a screen lists once").toEqual([]);
			expect(browser.errors).toEqual([]);
		} finally {
			await browser.close();
			await server.stop();
		}
	},
	45_000,
);
