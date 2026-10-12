import { expect, test } from "bun:test";
import { browserAvailable, eventually, openPage, startServer } from "./support.ts";

test.skipIf(!browserAvailable)(
	"shell routes, palette, help and theme work against the real server",
	async () => {
		const server = await startServer({ cases: 1 });
		const browser = await openPage(server);
		try {
			const { page } = browser;
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
			await page.keyboard.press("[");
			expect(await page.locator("#side").evaluate((node) => node.getBoundingClientRect().width)).toBe(64);
			expect(await page.getByRole("link", { name: "Suite", exact: true }).isVisible()).toBe(true);
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
