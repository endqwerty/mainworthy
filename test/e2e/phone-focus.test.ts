import { expect, test } from "bun:test";
import axe from "axe-core";
import type { Page } from "playwright-core";
import { browserAvailable, eventually, openPage, startServer } from "./support.ts";

// Read Chromium's accessibility tree, including inert handling, rather than Playwright's DOM-derived ARIA snapshot.
async function exposed(page: Page, selector: string): Promise<number> {
	const cdp = await page.context().newCDPSession(page);
	try {
		const { root } = await cdp.send("DOM.getDocument");
		const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
		const { node } = await cdp.send("DOM.describeNode", { nodeId, depth: -1 });
		const ids = new Set<number>();
		const collect = (item: typeof node): void => {
			ids.add(item.backendNodeId);
			for (const child of item.children ?? []) collect(child);
		};
		collect(node);
		const tree = await cdp.send("Accessibility.getFullAXTree");
		return tree.nodes.filter((item) => !item.ignored && item.backendDOMNodeId && ids.has(item.backendDOMNodeId)).length;
	} finally {
		await cdp.detach();
	}
}

test.skipIf(!browserAvailable)(
	"phone exposes only its shown pane and row activation reaches detail",
	async () => {
		const server = await startServer({ cases: 5 });
		const phone = await openPage(server, { device: "phone" });
		try {
			const { page } = phone;
			for (const screen of ["suite", "queue", "runs", "changes", "settings"]) {
				await page.goto(`${server.url}/p/scratch/${screen}`);
				await page.locator("#list [role=option]").first().waitFor();
				expect(await exposed(page, "#detail")).toBe(0);
				expect(await exposed(page, "#list")).toBeGreaterThan(0);
				for (let n = 0; n < 15; n++) {
					await page.keyboard.press("Tab");
					expect(await page.evaluate(() => document.activeElement?.closest("#detail") !== null)).toBe(false);
				}
				await page.locator("#list [role=option]").first().tap();
				await eventually(
					() => page.locator("#app").getAttribute("data-pane"),
					(pane) => pane === "detail",
				);
				expect(await exposed(page, "#list")).toBe(0);
				expect(await exposed(page, "#detail")).toBeGreaterThan(0);
				expect(await page.evaluate(() => document.activeElement?.closest("#detail") !== null)).toBe(true);
				await page.getByRole("button", { name: "Back to the list", exact: true }).tap();
			}
			await page.goto(`${server.url}/p/scratch/suite`);
			await page.getByRole("option", { name: /^C-2 / }).tap();
			await page.waitForURL("**/suite/c/2");
			expect(await page.locator("#detail .ctitle").innerText()).not.toBe("");
			await page.getByRole("button", { name: "Back to the list", exact: true }).tap();
			await page.locator("#list [role=listbox]").focus();
			await page.keyboard.press("Enter");
			await eventually(() => page.evaluate(() => document.activeElement?.closest("#detail") !== null), Boolean);
			expect(await exposed(page, "#list")).toBe(0);
			expect(phone.errors).toEqual([]);
		} finally {
			await phone.close();
			await server.stop();
		}
	},
	60_000,
);

test.skipIf(!browserAvailable)(
	"keys sheet restores its opener on phone and desktop",
	async () => {
		const server = await startServer({ cases: 2 });
		try {
			for (const device of ["phone", "desktop"] as const) {
				const h = await openPage(server, { device });
				try {
					const { page } = h;
					await page.locator("#filter").focus();
					for (const close of ["Escape", "button", "backdrop"]) {
						// ? is an app key outside a text field, with a concrete control to return to.
						const opener =
							device === "phone"
								? page.getByRole("button", { name: "Actions", exact: true })
								: page.getByRole("button", { name: "Keyboard shortcuts", exact: true });
						await opener.focus();
						await page.keyboard.press("?");
						await page.getByRole("region", { name: "Keyboard shortcuts" }).waitFor();
						if (close === "Escape") await page.keyboard.press("Escape");
						else if (close === "button") await page.locator(".help-close").click();
						else
							await page.getByRole("button", { name: "Close keys", exact: true }).click({ position: { x: 2, y: 2 } });
						await eventually(() => opener.evaluate((node) => node === document.activeElement), Boolean);
					}
					if (device === "desktop") {
						const opener = page.getByRole("button", { name: "Keyboard shortcuts", exact: true });
						await opener.focus();
						await page.keyboard.press("ControlOrMeta+k");
						await page.locator(".palette-input").fill("All keys");
						await page
							.locator("[data-overlay=palette]")
							.getByRole("option", { name: /All keys/ })
							.click();
						await page.locator(".help-close").click();
						await eventually(() => opener.evaluate((node) => node === document.activeElement), Boolean);
					}
				} catch (error) {
					console.error(error);
					throw error;
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

for (const device of ["ios", "android"] as const) {
	test.skipIf(!browserAvailable)(
		`${device} phone profile: accessibility, rotation and reduced keyboard viewport`,
		async () => {
			const server = await startServer({ cases: 5 });
			const h = await openPage(server, { device });
			try {
				const { page } = h;
				const portrait = page.viewportSize();
				if (!portrait) throw new Error("Missing device viewport");
				const audit = async () => {
					await page.evaluate(axe.source);
					const violations = await page.evaluate(async () =>
						(
							await window.axe.run(document, {
								runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] },
							})
						).violations.map((rule) => ({ id: rule.id, targets: rule.nodes.map((node) => node.target) })),
					);
					expect(violations).toEqual([]);
				};
				await page.getByRole("option", { name: /^C-2 / }).waitFor();
				expect(await exposed(page, "#detail")).toBe(0);
				await audit();
				await page.getByRole("option", { name: /^C-2 / }).tap();
				await page.waitForURL("**/suite/c/2");
				expect(await page.evaluate(() => document.activeElement?.closest("#detail") !== null)).toBe(true);
				expect(await exposed(page, "#list")).toBe(0);
				await audit();
				const { run } = await server.api("plan", { name: "Phone note", select: { cases: ["C-1"] } });
				await page.goto(`${server.url}/p/scratch/runs/${run.slice(2)}`);
				const note = page.getByRole("textbox", { name: "Result note", exact: true });
				await note.waitFor();
				// Playwright does not open an OS keyboard. Reserve its space by shrinking the viewport, as for browser bars.
				for (const size of [
					{ width: portrait.width, height: portrait.height - 300 },
					{ width: portrait.height, height: portrait.width },
					portrait,
				]) {
					await page.setViewportSize(size);
					await eventually(
						() => page.locator("html").getAttribute("data-layout"),
						(value) => value === "phone",
					);
					await note.fill("A note beside the software keyboard");
					await note.scrollIntoViewIfNeeded();
					expect(
						await note.evaluate((node) => {
							const box = node.getBoundingClientRect();
							const viewport = window.visualViewport;
							return (
								box.top >= (viewport?.offsetTop ?? 0) &&
								box.bottom <= (viewport?.height ?? innerHeight) + (viewport?.offsetTop ?? 0) &&
								box.left >= 0 &&
								box.right <= innerWidth
							);
						}),
					).toBe(true);
					expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
					expect(await exposed(page, "#list")).toBe(0);
					const actions = page.getByRole("button", { name: "Actions", exact: true });
					await actions.tap();
					await page.locator("[data-overlay=palette]").waitFor();
					await page
						.locator("[data-overlay=palette]")
						.getByRole("option", { name: /Go to Suite/ })
						.tap();
					await page.waitForURL("**/p/scratch/suite");
					await page.goto(`${server.url}/p/scratch/runs/${run.slice(2)}`);
					await note.waitFor();
				}
				await audit();
				expect(h.errors).toEqual([]);
			} finally {
				await h.close();
				await server.stop();
			}
		},
		60_000,
	);
}
