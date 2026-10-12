import { expect, test } from "bun:test";
import { parseCase } from "../../src/core/markdown.ts";
import { browserAvailable, eventually, keyCount, openPage, paste, startServer } from "./support.ts";

test.skipIf(!browserAvailable)(
	"an ordinary edit preserves custom fields omitted from JSON case reads",
	async () => {
		const server = await startServer();
		await server.api("propose", {
			edits: [{ op: "create", body: { title: "Field-bearing case", fields: { priority: "P1" } } }],
		});
		const browser = await openPage(server, { path: "/p/scratch/suite/c/1" });
		try {
			await browser.page.getByRole("button", { name: "Field-bearing case", exact: true }).waitFor();
			await browser.page.keyboard.press("e");
			await browser.page.getByRole("textbox", { name: "Case title", exact: true }).fill("Revised field-bearing case");
			await browser.page.keyboard.press("Escape");
			const rows = await eventually(
				() => server.api("get", { refs: ["C-1"], as: "md" }),
				(rows) => rows[0]?.version === 2,
			);
			const md = rows[0]?.md;
			if (typeof md !== "string") throw new Error("Canonical case body missing");
			const parsed = parseCase(md);
			if (!parsed.ok) throw new Error("Canonical case body did not parse");
			expect(parsed.doc.body.fields).toEqual({ priority: "P1" });
			expect(parsed.doc.body.title).toBe("Revised field-bearing case");
			expect(browser.errors).toEqual([]);
		} finally {
			await browser.close();
			await server.stop();
		}
	},
	30_000,
);

test.skipIf(!browserAvailable)(
	"the sidebar tag filter uses server counts and capture keeps the selected tag",
	async () => {
		const server = await startServer();
		await server.api("propose", {
			edits: [
				{ op: "create", body: { title: "Checkout case" }, tags: ["checkout"] },
				{ op: "create", body: { title: "Other case" }, tags: ["accounts"] },
			],
		});
		const browser = await openPage(server);
		try {
			const { page } = browser;
			await page.locator(".sidebar-tags").getByRole("button", { name: "#checkout 1" }).click();
			await page.waitForFunction(() => document.querySelector("#lcount")?.textContent === "1 cases");
			expect(await page.locator('[data-testid="case-list"]').innerText()).not.toContain("Other case");
			await page.keyboard.press("c");
			await page.keyboard.type("Second checkout case");
			await page.keyboard.press("Escape");
			const rows = await eventually(
				() => server.api("find", { in: "cases", tags: ["checkout"] }),
				(reply) => reply.count === 2,
			);
			expect(rows.items.map((row) => row.title)).toContain("Second checkout case");
			expect(rows.items.every((row) => Array.isArray(row.tags) && row.tags.includes("checkout"))).toBe(true);
			expect(browser.errors).toEqual([]);
		} finally {
			await browser.close();
			await server.stop();
		}
	},
	30_000,
);

test.skipIf(!browserAvailable)(
	"J1 captures six steps with three expected results without a dialog or page load",
	async () => {
		const server = await startServer();
		const browser = await openPage(server);
		try {
			const { page } = browser;
			let textKeys = 0;
			const type = async (text: string) => {
				textKeys += text.length;
				await page.keyboard.type(text);
			};
			await page.keyboard.press("c");
			expect(
				await page.getByRole("textbox", { name: "Case title" }).evaluate((node) => document.activeElement === node),
			).toBe(true);
			expect(await page.locator('#detail [data-field="title"]').count()).toBe(1);
			await type("Expired coupon is rejected #checkout");
			expect(await page.locator(".capture-mirror").innerText()).toBe("Expired coupon is rejected #checkout");
			await page.keyboard.press("Enter");
			await type("Open the cart");
			await page.keyboard.press("Tab");
			await type("Cart is visible");
			await page.keyboard.press("Enter");
			await type("Apply OLD10 > Coupon expired");
			await page.keyboard.press("Enter");
			await type("Reload the page");
			await page.keyboard.press("Enter");
			await paste(page, "4. Open summary > Total stays $100\n5. Open orders\n6. Check stored total");
			await page.keyboard.press("Escape");
			const rows = await eventually(
				() => server.api("find", { in: "cases" }),
				(value) => value.items.length === 1,
			);
			const ref = rows.items[0]?.ref;
			expect(typeof ref).toBe("string");
			if (typeof ref !== "string") throw new Error("Case ref missing");
			const item = (await server.api("get", { refs: [ref] }))[0];
			expect(item?.title).toBe("Expired coupon is rejected");
			expect(item?.version).toBe(1);
			expect(item?.tags).toEqual(["checkout"]);
			expect(item?.steps).toMatchObject([
				{ action: "Open the cart", expected: "Cart is visible" },
				{ action: "Apply OLD10", expected: "Coupon expired" },
				{ action: "Reload the page", expected: null },
				{ action: "Open summary", expected: "Total stays $100" },
				{ action: "Open orders", expected: null },
				{ action: "Check stored total", expected: null },
			]);
			await page.waitForFunction(() => document.querySelector(".cstate")?.textContent?.includes("v1"));
			expect(
				await page.evaluate(
					() =>
						document.activeElement instanceof HTMLTextAreaElement || document.activeElement instanceof HTMLInputElement,
				),
			).toBe(false);
			expect(browser.dialogs).toEqual([]);
			expect(browser.loads()).toBe(1);
			expect(browser.errors).toEqual([]);
			console.info(
				`J1: ${(await keyCount(page)) - textKeys} control keys beyond text; plus 3 typed delimiter characters. 0 dialogs, 0 document loads after opening.`,
			);
		} finally {
			await browser.close();
			await server.stop();
		}
	},
	30_000,
);

test.skipIf(!browserAvailable)(
	"capture accepts an outline title and spreadsheet columns, and rapid capture creates the next row",
	async () => {
		const server = await startServer();
		const browser = await openPage(server);
		try {
			const { page } = browser;
			await page.keyboard.press("c");
			await paste(
				page,
				"# Coupon stays applied #checkout\n1. Add coupon\tDiscount appears\n2. Reload\tDiscount remains",
			);
			await page.keyboard.press("Shift+Enter");
			await page.getByRole("textbox", { name: "Case title" }).fill("Second case");
			await page.keyboard.press("Escape");
			const cases = await eventually(
				() => server.api("find", { in: "cases" }),
				(value) => value.items.length === 2,
			);
			expect(cases.items.map((item) => item.title)).toContain("Coupon stays applied");
			const ref = cases.items.find((item) => item.title === "Coupon stays applied")?.ref;
			if (typeof ref !== "string") throw new Error("Outline case missing");
			const body = (await server.api("get", { refs: [ref] }))[0];
			expect(body?.steps).toMatchObject([
				{ action: "Add coupon", expected: "Discount appears" },
				{ action: "Reload", expected: "Discount remains" },
			]);
			expect(browser.errors).toEqual([]);
		} finally {
			await browser.close();
			await server.stop();
		}
	},
	30_000,
);

test.skipIf(!browserAvailable)(
	"rapid capture keeps the folder and the order before earlier seals finish",
	async () => {
		const server = await startServer();
		await server.api("propose", { edits: [{ op: "create", folder: "Checkout", body: { title: "Anchor case" } }] });
		const browser = await openPage(server, { path: "/p/scratch/suite" });
		try {
			const { page } = browser;
			await page.getByRole("option").filter({ hasText: "Anchor case" }).waitFor();
			await page.route("**/api/p/scratch/propose", async (route) => {
				await Bun.sleep(250);
				await route.continue();
			});
			await page.keyboard.press("c");
			await page.keyboard.type("First captured case");
			await page.keyboard.press("Shift+Enter");
			await page.keyboard.type("Second captured case");
			await page.keyboard.press("Escape");
			const rows = await eventually(
				() => server.api("find", { in: "cases", folder: "Checkout" }),
				(value) => value.items.length === 3,
			);
			expect(rows.items.map((row) => row.title)).toEqual([
				"Anchor case",
				"First captured case",
				"Second captured case",
			]);
			expect(browser.errors).toEqual([]);
		} finally {
			await browser.close();
			await server.stop();
		}
	},
	30_000,
);

test.skipIf(!browserAvailable)(
	"case producer settings are private until sealing and appear in the version diff",
	async () => {
		const server = await startServer();
		await server.api("propose", {
			edits: [
				{
					op: "create",
					body: { title: "Producer settings", steps: [{ id: "aa", action: "Open cart", expected: null }] },
				},
			],
		});
		const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
		try {
			const { page } = h;
			await page.getByRole("button", { name: "Producer settings", exact: true }).waitFor();
			await page.locator(".case-properties summary").click();
			await page.getByRole("checkbox", { name: "Pipeline" }).check();
			expect((await server.api("get", { refs: ["C-1"] }))[0]?.methods).toEqual(["human"]);
			await page.keyboard.press("Control+Enter");
			const rows = await eventually(
				() => server.api("get", { refs: ["C-1"] }),
				(value) => value[0]?.version === 2,
			);
			expect(rows[0]?.methods).toEqual(["human", "auto"]);
			await page.keyboard.press("v");
			await page.getByRole("region", { name: "Case diff" }).first().waitFor();
			expect(await page.getByRole("region", { name: "Case diff" }).first().textContent()).toContain("pipeline");
			expect(h.errors).toEqual([]);
		} finally {
			await h.close();
			await server.stop();
		}
	},
	30_000,
);

test.skipIf(!browserAvailable)(
	"deleted step ids remain reserved after sealing and reloading",
	async () => {
		const server = await startServer();
		await server.api("propose", {
			edits: [
				{
					op: "create",
					body: { title: "Stable step identity", steps: [{ id: "a0", action: "Original step", expected: null }] },
				},
			],
		});
		const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
		try {
			const { page } = h;
			for (const [version, id] of [
				[2, "a1"],
				[3, "a2"],
			]) {
				await page.getByRole("button", { name: "Stable step identity", exact: true }).waitFor();
				await page.evaluate(() => {
					Math.random = () => 0;
				});
				await page.keyboard.press("e");
				await page.getByRole("textbox", { name: "Step 1", exact: true }).fill("");
				await page.getByRole("textbox", { name: "Step 1", exact: true }).focus();
				await page.keyboard.press("Backspace");
				await page.keyboard.press("Enter");
				await page.keyboard.type(`Replacement ${version}`);
				await page.keyboard.press("Escape");
				const rows = await eventually(
					() => server.api("get", { refs: ["C-1"] }),
					(value) => value[0]?.version === version,
				);
				expect(rows[0]?.steps).toMatchObject([{ id, action: `Replacement ${version}` }]);
				await page.waitForFunction(
					(value) => document.querySelector(".cstate")?.textContent?.includes(`v${value}`),
					version,
				);
				if (version === 2) {
					await page.reload();
					await page.getByRole("button", { name: "Stable step identity", exact: true }).waitFor();
				}
			}
			expect(h.errors).toEqual([]);
		} finally {
			await h.close();
			await server.stop();
		}
	},
	30_000,
);
