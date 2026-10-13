import { expect, test } from "bun:test";
import { browserAvailable, eventually, openPage, startServer } from "./support.ts";

test.skipIf(!browserAvailable)(
	"shell routes, palette, help and theme work against the real server",
	async () => {
		const server = await startServer({ cases: 1 });
		const browser = await openPage(server);
		try {
			const { page } = browser;
			// The counts end in one column, whatever the width of the label before them, and a count that
			// turns hot keeps its digits where they were.
			await page.locator('#nav a[aria-label="Suite"] em').filter({ hasText: "1" }).waitFor();
			const [suite, queue] = await page.evaluate(() =>
				["Suite", "Queue"].map((label) => {
					const count = document.querySelector(`#nav a[aria-label="${label}"] em`);
					if (!count) throw new Error(`${label} has no count`);
					const digitsEnd = () => {
						const digits = document.createRange();
						digits.selectNodeContents(count);
						return digits.getBoundingClientRect().right;
					};
					const plain = digitsEnd();
					count.classList.add("hot");
					const hot = digitsEnd();
					count.classList.remove("hot");
					return { plain, hot };
				}),
			);
			expect(queue?.plain).toBe(suite?.plain);
			expect(suite?.hot).toBe(suite?.plain);
			expect(queue?.hot).toBe(queue?.plain);
			for (const [keys, route] of [
				["gs", "suite"],
				["gq", "queue"],
				["gr", "runs"],
				["gc", "changes"],
				["g,", "settings"],
			]) {
				if (!keys || !route) continue;
				await page.keyboard.press("Escape");
				await page.keyboard.type(keys);
				await page.waitForURL(`**/p/scratch/${route}`);
				expect(await page.locator("#list").count()).toBe(1);
				expect(await page.locator("#tree").count()).toBe(route === "suite" ? 1 : 0);
			}
			// The navigation is the four places the work is done. Settings and the docs are in the footer:
			// Settings beside who is signed in, the docs beside the keys and the theme.
			const nav = page.getByRole("navigation", { name: "Main" });
			expect(await nav.getByRole("link").allInnerTexts()).toEqual([
				expect.stringContaining("Suite"),
				expect.stringContaining("Queue"),
				expect.stringContaining("Runs"),
				expect.stringContaining("Changes"),
			]);
			const footer = page.locator(".sfoot");
			const settings = footer.getByRole("link", { name: "Settings", exact: true });
			// The loop above ended on Settings, and the link says so as a place in the navigation does.
			expect(await settings.getAttribute("aria-current")).toBe("page");
			expect(await footer.getByRole("link", { name: "Docs", exact: true }).getAttribute("href")).toBe(
				"/docs/customize",
			);
			expect(
				await footer.locator("a, button").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label"))),
			).toEqual(["Settings", "Sign out", "Docs", "Keyboard shortcuts", "Toggle theme"]);
			await page.keyboard.type("gs");
			await page.waitForURL("**/p/scratch/suite");
			expect(await settings.getAttribute("aria-current")).toBeNull();
			await settings.click();
			await page.waitForURL("**/p/scratch/settings");
			expect(browser.loads()).toBe(1);
			await page.keyboard.press("[");
			expect(await page.locator("#side").evaluate((node) => node.getBoundingClientRect().width)).toBe(64);
			expect(await page.getByRole("link", { name: "Suite", exact: true }).isVisible()).toBe(true);
			// Collapsed, the footer keeps its links as icons, one under the other and inside the sidebar.
			for (const name of ["Settings", "Docs"]) {
				const box = await footer.getByRole("link", { name, exact: true }).boundingBox();
				expect(box && box.x >= 0 && box.x + box.width <= 64 && box.width > 0).toBe(true);
			}
			await page.keyboard.press("[");
			expect(await page.locator("#side").evaluate((node) => node.getBoundingClientRect().width)).toBe(236);
			await page.keyboard.press("Control+k");
			await page.getByRole("textbox", { name: "Jump to or run" }).fill("C-1");
			await page.keyboard.press("Enter");
			await page.waitForURL("**/suite/c/1");
			await page.keyboard.press("?");
			expect(await page.getByRole("region", { name: "Keyboard shortcuts" }).count()).toBe(1);
			await page.keyboard.press("Escape");
			await page.getByRole("button", { name: "Toggle theme" }).click();
			expect(await page.locator("html").getAttribute("data-theme")).toBe("dark");
			expect(browser.loads()).toBe(1);
			expect(browser.dialogs).toEqual([]);
			expect(browser.errors).toEqual([]);
		} finally {
			await browser.close();
			await server.stop();
		}
	},
	30_000,
);

test.skipIf(!browserAvailable)(
	"collapsing the sidebar gives its width to the pane that is read, on every screen, keeps the keys, and lasts a reload",
	async () => {
		const server = await startServer({ cases: 1 });
		const browser = await openPage(server);
		try {
			const { page } = browser;
			const widths = () =>
				page.evaluate(() =>
					["#side", "#list", "#detail"].map(
						(selector) => document.querySelector(selector)?.getBoundingClientRect().width ?? Number.NaN,
					),
				);
			const caps = () =>
				page
					.locator("#list kbd, #detail kbd, #bar kbd")
					.evaluateAll((nodes) => nodes.filter((node) => node.getClientRects().length > 0).length);
			// The sidebar and its mark keep their colours: the mark is drawn in the sidebar's colour on the ink.
			expect(
				await page.evaluate(() => {
					const colour = (selector: string, property: "backgroundColor" | "color") => {
						const node = document.querySelector(selector);
						return node ? getComputedStyle(node)[property] : "";
					};
					return colour("#side", "backgroundColor") === colour(".brand .logo", "color");
				}),
			).toBe(true);
			// Three columns down to 760 px, and under that the list above the detail, beside the sidebar.
			for (const [window, stacked] of [
				[1440, false],
				[1000, false],
				[700, true],
			] as const) {
				await page.setViewportSize({ width: window, height: 900 });
				for (const [keys, screen] of [
					["gs", "suite"],
					["gq", "queue"],
					["gr", "runs"],
					["gc", "changes"],
					["g,", "settings"],
				] as const) {
					await page.keyboard.type(keys);
					await page.waitForURL(`**/p/scratch/${screen}`);
					await page.locator("#detail").waitFor();
					const [side = 0, list = 0, detail = 0] = await widths();
					const shown = await caps();
					await page.keyboard.press("[");
					const freed = side - 64;
					const collapsed = await widths();
					// The list keeps its width and the pane on its right takes what the sidebar gave up. Where one is
					// above the other, both take it.
					expect([screen, window, ...collapsed.map(Math.round)]).toEqual([
						screen,
						window,
						64,
						Math.round(stacked ? list + freed : list),
						Math.round(detail + freed),
					]);
					// A key cap outside the sidebar is as visible as it was.
					expect([screen, window, await caps()]).toEqual([screen, window, shown]);
					expect(shown).toBeGreaterThan(0);
					await page.keyboard.press("[");
					expect((await widths()).map(Math.round)).toEqual([side, list, detail].map(Math.round));
				}
			}
			await page.setViewportSize({ width: 1440, height: 900 });

			// A case pane that was widened (z) stays widened when the sidebar changes, and takes its width too.
			await page.keyboard.type("gs");
			await page.waitForURL("**/p/scratch/suite");
			await page.keyboard.press("z");
			expect(await widths()).toEqual([236, 340, 864]);
			await page.keyboard.press("[");
			expect(await widths()).toEqual([64, 340, 1036]);
			await page.keyboard.press("[");
			expect(await widths()).toEqual([236, 340, 864]);
			await page.keyboard.press("z");
			expect((await widths())[1]).toBeGreaterThan(340);

			// The button says what it does and which key does the same, and the choice stays in the browser.
			const collapse = page.getByRole("button", { name: "Collapse sidebar", exact: true });
			expect(await collapse.getAttribute("title")).toBe("Collapse sidebar ([)");
			await collapse.click();
			expect((await widths())[0]).toBe(64);
			const expand = page.getByRole("button", { name: "Expand sidebar", exact: true });
			expect(await expand.getAttribute("title")).toBe("Expand sidebar ([)");
			const box = await expand.boundingBox();
			expect(box && box.width > 0 && box.x >= 0 && box.x + box.width <= 64).toBe(true);
			expect(await collapse.count()).toBe(0);
			await page.reload();
			await page.locator("#app").waitFor();
			expect((await widths())[0]).toBe(64);
			await expand.click();
			expect((await widths())[0]).toBe(236);
			await page.reload();
			await page.locator("#app").waitFor();
			expect((await widths())[0]).toBe(236);
			expect(await collapse.count()).toBe(1);
			expect(browser.dialogs).toEqual([]);
			expect(browser.errors).toEqual([]);
		} finally {
			await browser.close();
			await server.stop();
		}
	},
	30_000,
);

test.skipIf(!browserAvailable)(
	"what a browser kept under the former name is read under the new one",
	async () => {
		const server = await startServer({ cases: 1 });
		const browser = await openPage(server);
		try {
			const { page } = browser;
			await page.goto(`${server.url}/p/scratch/suite`);
			await page.locator("#app").waitFor();
			expect(await page.locator("html").getAttribute("data-theme")).toBe("light");
			await page.evaluate(() => {
				localStorage.removeItem("mainworthy:theme");
				localStorage.setItem("casebook:theme", "dark");
			});
			await page.reload();
			await page.locator("#app").waitFor();
			expect(await page.locator("html").getAttribute("data-theme")).toBe("dark");
			expect(
				await page.evaluate(() => [localStorage.getItem("casebook:theme"), localStorage.getItem("mainworthy:theme")]),
			).toEqual([null, "dark"]);
			expect(browser.errors).toEqual([]);
		} finally {
			await browser.close();
			await server.stop();
		}
	},
	30_000,
);

test.skipIf(!browserAvailable)(
	"suite shortcuts navigate, filter, edit, select, tag, move, archive, undo and create a folder",
	async () => {
		const server = await startServer();
		await server.api("propose", {
			edits: [
				{
					op: "create",
					folder: "Original",
					body: {
						title: "Keyboard case 1",
						steps: Array.from({ length: 10 }, (_, i) => ({
							id: `s${i}`,
							action: `Step ${i + 1}`,
							expected: `Result ${i + 1}`,
						})),
					},
				},
				{ op: "create", folder: "Original", outline: "Shortcut target" },
				{ op: "folder", name: "Destination" },
			],
		});
		const browser = await openPage(server, { path: "/p/scratch/suite?folder=Original" });
		try {
			const { page } = browser;
			page.setDefaultTimeout(5000);
			await page.getByRole("option").filter({ hasText: "C-1" }).waitFor();
			for (const [key, ref] of [
				["j", "C-2"],
				["ArrowUp", "C-1"],
				["ArrowDown", "C-2"],
				["k", "C-1"],
			]) {
				if (!key || !ref) throw new Error("Shortcut target missing");
				await page.keyboard.press(key);
				await page.waitForFunction(
					(ref) => document.querySelector('#list [aria-selected="true"] .id')?.textContent === ref,
					ref,
				);
			}
			await page.keyboard.press("x");
			expect(await page.locator(".selected-check").count()).toBe(1);
			await page.keyboard.press("x");
			expect(await page.locator(".selected-check").count()).toBe(0);
			await page.keyboard.press("/");
			await page.keyboard.type("target");
			await page.waitForFunction(() => document.querySelector("#lcount")?.textContent === "1 cases");
			await page.keyboard.press("Escape");
			await page.waitForFunction(() => document.querySelector("#lcount")?.textContent === "2 cases");
			await page.keyboard.press("e");
			await page.getByRole("textbox", { name: "Case title", exact: true }).fill("Keyboard case 1 updated");
			await page.keyboard.press("Control+Enter");
			await page.waitForFunction(() => document.querySelector(".cstate .chip")?.textContent === "v2");
			await page.keyboard.press("v");
			await page.getByRole("region", { name: "Case diff" }).last().waitFor();
			expect(await page.getByRole("region", { name: "Case diff" }).last().innerText()).toContain("updated");
			await page.getByRole("button", { name: "Close", exact: true }).click();
			await page.keyboard.press("t");
			await page.getByLabel("Tag selected cases").fill("keyboard");
			await page.keyboard.press("Enter");
			await eventually(
				() => server.api("get", { refs: ["C-1"] }),
				(rows) => Array.isArray(rows[0]?.tags) && rows[0]?.tags.includes("keyboard"),
			);
			await page.keyboard.press("u");
			await eventually(
				() => server.api("get", { refs: ["C-1"] }),
				(rows) => Array.isArray(rows[0]?.tags) && rows[0]?.tags.length === 0,
			);
			await page.keyboard.press("m");
			await page.getByRole("textbox", { name: "Move selected cases to a folder" }).fill("Destination");
			await page.keyboard.press("Enter");
			await eventually(
				() => server.api("find", { in: "cases", folder: "Destination" }),
				(rows) => rows.items.some((row) => row.ref === "C-1"),
			);
			await page.keyboard.press("u");
			await eventually(
				() => server.api("find", { in: "cases", folder: "Original" }),
				(rows) => rows.count === 2,
			);
			await page.keyboard.press("#");
			await eventually(
				() => server.api("get", { refs: ["C-1"] }),
				(rows) => rows[0]?.state === "archived",
			);
			await page.keyboard.press("u");
			await eventually(
				() => server.api("get", { refs: ["C-1"] }),
				(rows) => rows[0]?.state === "active",
			);
			await page.keyboard.press("z");
			expect(await page.locator("#app").getAttribute("class")).toContain("zoom");
			await page.keyboard.press("z");
			expect(await page.locator("#app").getAttribute("class")).not.toContain("zoom");
			await page.locator("#detail .pane-scroll").evaluate((pane) => {
				pane.scrollTop = 0;
			});
			await page.keyboard.press("Space");
			expect(await page.locator("#detail .pane-scroll").evaluate((pane) => pane.scrollTop)).toBeGreaterThan(0);
			await page.keyboard.press("]");
			await page.waitForFunction(() => new URL(location.href).searchParams.get("folder") === "Destination");
			await page.keyboard.press("Alt+[");
			await page.waitForFunction(() => new URL(location.href).searchParams.get("folder") === "Original");
			await page.keyboard.type("nf");
			await page.getByLabel("New folder name").fill("Keyboard folder");
			await page.keyboard.press("Enter");
			await eventually(
				() => server.api("find", { in: "folders" }),
				(rows) => rows.items.some((row) => row.path === "Original/Keyboard folder"),
			);
			await page.keyboard.press("Control+k");
			await page.getByRole("textbox", { name: "Jump to or run" }).fill("Go to Queue");
			await page.keyboard.press("Enter");
			await page.waitForURL("**/p/scratch/queue");
			expect(browser.loads()).toBe(1);
			expect(browser.dialogs).toEqual([]);
			expect(browser.errors).toEqual([]);
		} finally {
			await browser.close();
			await server.stop();
		}
	},
	30_000,
);
