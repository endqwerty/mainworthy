import { expect, test } from "bun:test";
import { browserAvailable, eventually, keyCount, openPage, paste, startServer } from "./support.ts";

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
				await page.getByRole("textbox", { name: "Capture title" }).evaluate((node) => document.activeElement === node),
			).toBe(true);
			await type("Expired coupon is rejected #checkout");
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
			await page.getByRole("textbox", { name: "Capture title" }).fill("Second case");
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
