import { expect, test } from "bun:test";
import { z } from "zod";
import { browserAvailable, eventually, openPage, startServer } from "./support.ts";

test.skipIf(!browserAvailable)(
	"L2 reload restores an unsealed sentence and its caret",
	async () => {
		const server = await startServer();
		const browser = await openPage(server);
		try {
			const { page } = browser;
			await page.keyboard.press("c");
			await page.keyboard.type("Coupon capture");
			await page.keyboard.press("Enter");
			await page.keyboard.type("The coupon should preserve the");
			await page.reload();
			await page.waitForSelector("#app");
			const step = page.getByRole("textbox", { name: "Step 1", exact: true });
			await step.waitFor();
			expect(await step.inputValue()).toBe("The coupon should preserve the");
			const selection = await step.evaluate((node) =>
				node instanceof HTMLTextAreaElement
					? { start: node.selectionStart, end: node.selectionEnd, focused: document.activeElement === node }
					: null,
			);
			expect(selection).toEqual({ start: 30, end: 30, focused: true });
			await page.keyboard.type(" discount after reload");
			await page.keyboard.press("Escape");
			const stored = await eventually(
				() => server.api("find", { in: "cases" }),
				(rows) => rows.items.length === 1,
			);
			const ref = stored.items[0]?.ref;
			if (typeof ref !== "string") throw new Error("Case ref missing");
			await eventually(
				() => server.api("get", { refs: [ref] }),
				(rows) =>
					z.array(z.object({ action: z.string() })).parse(rows[0]?.steps)[0]?.action ===
					"The coupon should preserve the discount after reload",
			);
			expect((await server.api("get", { refs: [ref] }))[0]?.steps).toMatchObject([
				{ action: "The coupon should preserve the discount after reload" },
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
	"a refused seal keeps the typed text and retries under a fresh command",
	async () => {
		const server = await startServer();
		const browser = await openPage(server);
		try {
			const { page } = browser;
			let refused = true;
			const commands: string[] = [];
			await browser.context.route("**/api/p/scratch/propose", async (route) => {
				commands.push(z.object({ cmd: z.string() }).parse(route.request().postDataJSON()).cmd);
				if (refused)
					await route.fulfill({
						status: 200,
						contentType: "application/json",
						body: JSON.stringify({ ok: false, error: { code: "internal", message: "Temporarily unavailable" } }),
					});
				else await route.continue();
			});
			await page.keyboard.press("c");
			await page.keyboard.type("Network recovery");
			await page.keyboard.press("Enter");
			await page.keyboard.type("The draft is kept");
			await page.keyboard.press("Escape");
			await page.waitForFunction(() => document.getElementById("stat")?.textContent?.includes("kept on this device"));
			expect(await page.getByRole("textbox", { name: "Step 1", exact: true }).inputValue()).toBe("The draft is kept");
			refused = false;
			await page.keyboard.press("Control+Enter");
			await page.waitForURL("**/suite/c/1");
			expect((await server.api("get", { refs: ["C-1"] }))[0]?.version).toBe(1);
			expect(commands.length).toBeGreaterThanOrEqual(2);
			expect(commands[0]).not.toBe(commands.at(-1));
		} finally {
			await browser.close();
			await server.stop();
		}
	},
	30_000,
);

// Issue #86. A step with an expected result and no action yet cannot be recorded, so no version holds it. Its
// draft stays on the device when the rest is recorded, and is not proposed again until the step can be.
test.skipIf(!browserAvailable)(
	"a step with an expected result and no action stays in the draft when the rest is recorded, and after a reload",
	async () => {
		const server = await startServer();
		await server.api("propose", {
			edits: [{ op: "create", outline: "Coupon case\n  Open the cart\n  Apply the coupon" }],
		});
		const browser = await openPage(server, { path: "/p/scratch/suite/c/1" });
		try {
			const { page } = browser;
			page.setDefaultTimeout(5000);
			const head = async () =>
				z
					.object({
						version: z.number(),
						title: z.string(),
						steps: z.array(z.object({ action: z.string(), expected: z.string().nullable() })),
					})
					.parse((await server.api("get", { refs: ["C-1"] }))[0]);
			const drafts = () =>
				page.evaluate(() =>
					Object.keys(localStorage)
						.filter((key) => key.includes(":draft:"))
						.map((key) => localStorage.getItem(key) ?? ""),
				);
			const expected = page.getByRole("textbox", { name: "Expected result 3", exact: true });
			let proposals = 0;
			page.on("request", (request) => {
				if (request.url().endsWith("/propose")) proposals++;
			});
			await page.getByRole("button", { name: "Coupon case", exact: true }).waitFor();
			await page.keyboard.press("e");
			await page.getByRole("textbox", { name: "Step 2", exact: true }).press("End");
			await page.keyboard.press("Enter");
			await page.keyboard.press("Tab");
			await page.keyboard.type("Total shows $90.00");
			await page.getByRole("textbox", { name: "Case title", exact: true }).fill("Coupon case revised");
			await page.keyboard.press("Escape");
			await page.locator("#stat").filter({ hasText: "Version 2, by you" }).waitFor();
			// The version has what can be recorded, and the draft still has the step that cannot.
			expect(await head()).toMatchObject({
				version: 2,
				title: "Coupon case revised",
				steps: [{ action: "Open the cart" }, { action: "Apply the coupon" }],
			});
			expect((await drafts()).join(" ")).toContain("Total shows $90.00");
			await page.reload();
			await expected.waitFor();
			expect(await expected.inputValue()).toBe("Total shows $90.00");
			// Leaving again records nothing and proposes nothing: all that is left cannot be sent.
			await expected.press("Escape");
			await page.evaluate(() => undefined);
			expect(proposals).toBe(1);
			expect((await drafts()).join(" ")).toContain("Total shows $90.00");
			// With an action the step is recorded, and then no draft is left.
			await page.getByRole("textbox", { name: "Step 3", exact: true }).fill("Reload the page");
			await page.keyboard.press("Escape");
			await eventually(head, (value) => value.version === 3);
			expect((await head()).steps[2]).toEqual({ action: "Reload the page", expected: "Total shows $90.00" });
			await eventually(drafts, (rows) => rows.length === 0);
			expect(proposals).toBe(2);
			expect(browser.errors).toEqual([]);
		} finally {
			await browser.close();
			await server.stop();
		}
	},
	30_000,
);

test.skipIf(!browserAvailable)(
	"30 seconds idle records one version, preserves the caret and updates current proof",
	async () => {
		const server = await startServer();
		await server.api("propose", {
			edits: [
				{ op: "create", body: { title: "Idle case", steps: [{ id: "a1", action: "Open cart", expected: null }] } },
			],
		});
		const planned = await server.api("plan", { name: "Evidence", select: { cases: ["C-1"] } });
		await server.api("report", { run: planned.run, results: [{ test: { case: "C-1" }, outcome: "pass" }] });
		const browser = await openPage(server, { path: "/p/scratch/suite/c/1" });
		try {
			const { page } = browser;
			await page.getByRole("button", { name: "Idle case", exact: true }).waitFor();
			await page.keyboard.press("e");
			const title = page.getByRole("textbox", { name: "Case title", exact: true });
			await title.fill("Idle case revised");
			await page.waitForFunction(() => document.querySelector(".cstate")?.textContent?.includes("v2"), null, {
				timeout: 35_000,
			});
			expect(await title.inputValue()).toBe("Idle case revised");
			expect(
				await title.evaluate((node) =>
					node instanceof HTMLTextAreaElement
						? { focused: document.activeElement === node, caret: node.selectionStart }
						: null,
				),
			).toEqual({ focused: true, caret: 17 });
			expect(await page.getByRole("option").filter({ hasText: "C-1" }).locator(".pf").first().textContent()).toContain(
				"~",
			);
			await page.keyboard.press("Control+Enter");
			expect((await server.api("get", { refs: ["C-1"] }))[0]?.version).toBe(2);
			expect(browser.errors).toEqual([]);
		} finally {
			await browser.close();
			await server.stop();
		}
	},
	45_000,
);

test.skipIf(!browserAvailable)(
	"full device storage still accepts capture and reports the draft honestly",
	async () => {
		const server = await startServer();
		const h = await openPage(server);
		try {
			const { page } = h;
			await page.evaluate(() => {
				let index = 0;
				for (const size of [128 * 1024, 1024, 64, 1]) {
					const chunk = "x".repeat(size);
					for (let attempt = 0; attempt < 10_000; attempt++) {
						try {
							localStorage.setItem(`quota-${index++}`, chunk);
						} catch {
							break;
						}
					}
				}
			});
			await page.keyboard.press("c");
			expect(
				await page.getByRole("textbox", { name: "Case title" }).evaluate((node) => node === document.activeElement),
			).toBe(true);
			await page.keyboard.type("Storage is full");
			await page.keyboard.press("Enter");
			await page.keyboard.type("This text is kept");
			expect(await page.locator(".cstate").textContent()).toContain("kept in this tab");
			await page.keyboard.press("Escape");
			await eventually(
				() => server.api("find", { in: "cases" }),
				(rows) => rows.items.length === 1,
			);
			expect(h.errors).toEqual([]);
		} finally {
			await h.close();
			await server.stop();
		}
	},
	30_000,
);
