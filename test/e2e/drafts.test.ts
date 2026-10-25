import { expect, test } from "bun:test";
import { z } from "zod";
import { budget } from "../../scripts/budget.ts";
import { browserAvailable, eventually, openPage, paste, startServer } from "./support.ts";

test.skipIf(!browserAvailable)(
	"L2 reload restores an unsealed sentence and its caret",
	async () => {
		const server = await startServer();
		const browser = await openPage(server);
		const recovery = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		try {
			const { page } = browser;
			await browser.context.route("**/api/p/scratch/get", async (route) => {
				if (z.object({ version: z.number().optional() }).parse(route.request().postDataJSON()).version !== undefined) {
					recovery.resolve();
					await release.promise;
				}
				await route.continue();
			});
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
			await recovery.promise;
			await page.keyboard.type(" discount after ");
			expect(await step.inputValue()).toBe("The coupon should preserve the discount after ");
			release.resolve();
			await page.waitForURL("**/suite/c/1");
			expect(await step.inputValue()).toBe("The coupon should preserve the discount after ");
			await page.keyboard.type("reload");
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
			release.resolve();
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
						status: 429,
						contentType: "application/json",
						body: JSON.stringify({ ok: false, error: { code: "limited", message: "Temporarily unavailable" } }),
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

// Issue #381. The create was accepted, then the read of the recorded version failed. That is not a refusal of the
// write: the next save asks what the server recorded (`command`) and does not create the case again.
test.skipIf(!browserAvailable)(
	"a failed read after a case was created does not make the next save create it again",
	async () => {
		const server = await startServer();
		const browser = await openPage(server);
		try {
			const { page } = browser;
			const commands: string[] = [];
			const lookups: string[] = [];
			await browser.context.route("**/api/p/scratch/propose", async (route) => {
				commands.push(z.object({ cmd: z.string() }).parse(route.request().postDataJSON()).cmd);
				await route.continue();
			});
			await browser.context.route("**/api/p/scratch/command", async (route) => {
				lookups.push(z.object({ cmd: z.string() }).parse(route.request().postDataJSON()).cmd);
				await route.continue();
			});
			let failed = false;
			await browser.context.route("**/api/p/scratch/get", async (route) => {
				const asked = z.object({ version: z.number().optional() }).parse(route.request().postDataJSON());
				if (!failed && asked.version !== undefined) {
					failed = true;
					await route.fulfill({
						status: 500,
						contentType: "application/json",
						body: JSON.stringify({ ok: false, error: { code: "internal", message: "Temporarily unavailable" } }),
					});
				} else await route.continue();
			});
			await page.keyboard.press("c");
			await page.keyboard.type("Created once");
			await page.keyboard.press("Enter");
			await page.keyboard.type("The case is recorded");
			await page.keyboard.press("Escape");
			await page.waitForFunction(() => document.getElementById("stat")?.textContent?.includes("kept on this device"));
			expect(failed).toBe(true);
			expect((await server.api("find", { in: "cases" })).items.length).toBe(1);
			await page.keyboard.press("Control+Enter");
			await page.waitForURL("**/suite/c/*");
			expect(page.url()).toEndWith("/suite/c/1");
			expect((await server.api("find", { in: "cases" })).items.length).toBe(1);
			expect(new Set(commands).size).toBe(1);
			expect(lookups).toEqual([commands[0] ?? ""]);
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

// The independent review of the change for issue #86 (B1). An action emptied on a recorded step is recorded as
// the step's removal, and what the editor still holds of the step stays in the draft. When a colleague then
// restores the step, the draft is carried onto a version that has it again. What is left of the step in the
// draft is not a removal of the colleague's step: nobody removed that one.
test.skipIf(!browserAvailable)(
	"a step a colleague restored is not removed by what a draft still held of it, and leaving again sends nothing",
	async () => {
		const server = await startServer();
		await server.api("propose", {
			edits: [{ op: "create", outline: "Coupon case\n  Open the cart\n  Apply the coupon > Total shows $90.00" }],
		});
		const browser = await openPage(server, { path: "/p/scratch/suite/c/1" });
		try {
			const { page } = browser;
			const head = async () =>
				z
					.object({ version: z.number(), title: z.string(), steps: z.array(z.object({ action: z.string() })) })
					.parse((await server.api("get", { refs: ["C-1"] }))[0]);
			const drafts = () => page.evaluate(() => Object.keys(localStorage).filter((key) => key.includes(":draft:")));
			const title = page.getByRole("textbox", { name: "Case title", exact: true });
			const second = page.getByRole("textbox", { name: "Step 2", exact: true });
			let proposals = 0;
			page.on("request", (request) => {
				if (request.url().endsWith("/propose")) proposals++;
			});
			await page.getByRole("button", { name: "Coupon case", exact: true }).waitFor();
			await page.keyboard.press("e");
			await second.fill("");
			await page.keyboard.press("Escape");
			await page.locator("#stat").filter({ hasText: "Version 2, by you" }).waitFor();
			expect((await head()).steps).toEqual([{ action: "Open the cart" }]);
			// A colleague restores version 1, as version 3. The person changes only the title.
			await server.api("propose", { edits: [{ op: "restore", case: "C-1", to: 1 }] });
			await title.fill("Coupon case revised");
			await page.keyboard.press("Escape");
			await page.locator("#stat").filter({ hasText: "Version 4, by you" }).waitFor();
			const merged = { version: 4, title: "Coupon case revised", steps: ["Open the cart", "Apply the coupon"] };
			const recorded = async () => {
				const { steps, ...rest } = await head();
				return { ...rest, steps: steps.map((step) => step.action) };
			};
			expect(await recorded()).toEqual(merged);
			// Leaving again, with nothing typed, sends nothing: version 4 stands, with the colleague's step.
			await title.press("Escape");
			await page.evaluate(() => undefined);
			expect(proposals).toBe(2);
			expect(await recorded()).toEqual(merged);
			// The editor shows the step as the colleague restored it, and no draft is left.
			expect(await second.inputValue()).toBe("Apply the coupon");
			expect(await drafts()).toEqual([]);
			// The same for an editor with nothing to record, which follows the versions it reads. The first step
			// has no expected result, so nothing of it keeps a draft once its removal is version 5. A colleague
			// restores it as version 6, and the editor shows it again. The next change does not remove it.
			const first = page.getByRole("textbox", { name: "Step 1", exact: true });
			await first.fill("");
			await page.keyboard.press("Escape");
			await page.locator("#stat").filter({ hasText: "Version 5, by you" }).waitFor();
			await server.api("propose", { edits: [{ op: "restore", case: "C-1", to: 4 }] });
			await eventually(
				() => first.inputValue(),
				(value) => value === "Open the cart",
			);
			await title.fill("Coupon case revised again");
			await page.keyboard.press("Escape");
			await page.locator("#stat").filter({ hasText: "Version 7, by you" }).waitFor();
			expect(await recorded()).toEqual({ ...merged, version: 7, title: "Coupon case revised again" });
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
			let writes = 0;
			page.on("request", (request) => {
				if (request.url().endsWith("/propose")) writes++;
			});
			await page.clock.install();
			await page.clock.pauseAt(new Date(Date.now() + 1000));
			await page.keyboard.press("e");
			const title = page.getByRole("textbox", { name: "Case title", exact: true });
			await title.fill("Idle case revised");
			await page.clock.fastForward(29_999);
			expect(writes).toBe(0);
			expect((await server.api("get", { refs: ["C-1"] }))[0]?.version).toBe(1);
			expect(
				await page.evaluate(() =>
					Object.keys(localStorage)
						.filter((key) => key.includes(":draft:") && key.endsWith(":C-1"))
						.map((key) => JSON.parse(localStorage.getItem(key) ?? "null")),
				),
			).toMatchObject([{ body: { title: "Idle case revised" } }]);
			const recorded = page.waitForResponse((response) => response.url().endsWith("/propose"));
			await page.clock.fastForward(2);
			await recorded;
			expect((await server.api("get", { refs: ["C-1"] }))[0]?.version).toBe(2);
			await page.clock.resume();
			await page.waitForFunction(() => document.querySelector(".cstate")?.textContent?.includes("v2"));
			expect(writes).toBe(1);
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
			expect(writes).toBe(1);
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
			const rows = await eventually(
				() => server.api("find", { in: "cases" }),
				(rows) => rows.items.length === 1,
			);
			const ref = rows.items[0]?.ref;
			if (typeof ref !== "string") throw new Error("The captured case has no reference");
			const [saved] = await server.api("get", { refs: [ref] });
			expect(saved?.title).toBe("Storage is full");
			expect(saved?.steps).toMatchObject([{ action: "This text is kept" }]);
			expect(h.errors).toEqual([]);
		} finally {
			await h.close();
			await server.stop();
		}
	},
	30_000,
);

for (const device of ["desktop", "phone"] satisfies ("desktop" | "phone")[])
	test.skipIf(!browserAvailable)(
		`editor textareas fit initial text, pasted lines and pane wrapping without moving the caret on ${device}`,
		async () => {
			const server = await startServer();
			await server.api("propose", {
				edits: [
					{
						op: "create",
						body: {
							title: "Growing fields",
							pre: "First line\nSecond line\nThird line",
							steps: [{ id: "s1", action: "Open the cart", expected: null }],
						},
					},
				],
			});
			const browser = await openPage(server, { path: "/p/scratch/suite/c/1", device });
			try {
				const { page } = browser;
				await page.getByRole("button", { name: "Growing fields", exact: true }).waitFor();
				await page.keyboard.press("e");
				const pre = page.getByRole("textbox", { name: "Preconditions", exact: true });
				expect(await pre.inputValue()).toBe("First line\nSecond line\nThird line");
				expect(await pre.evaluate((node) => node.clientHeight >= node.scrollHeight)).toBe(true);
				const step = page.getByRole("textbox", { name: "Step 1", exact: true });
				await step.focus();
				await page.keyboard.press("Tab");
				const expected = page.getByRole("textbox", { name: "Expected result 1", exact: true });
				const height = () => expected.evaluate((node) => node.clientHeight);
				const short = await height();
				const lines = "One\nTwo\nThree\nFour\nFive";
				await paste(page, lines);
				expect(await expected.inputValue()).toBe(lines);
				expect(await height()).toBeGreaterThan(short);
				expect(await expected.evaluate((node) => node.clientHeight >= node.scrollHeight)).toBe(true);
				await page.keyboard.press("ControlOrMeta+A");
				await page.keyboard.type("Visible");
				expect(await height()).toBe(short);
				await page.keyboard.press("ArrowLeft");
				await page.keyboard.type("X");
				expect(await expected.inputValue()).toBe("VisiblXe");
				expect(
					await expected.evaluate(
						(node) =>
							node instanceof HTMLTextAreaElement && {
								start: node.selectionStart,
								end: node.selectionEnd,
								focused: document.activeElement === node,
							},
					),
				).toEqual({ start: 7, end: 7, focused: true });
				const wrapped = "The expected result stays completely visible when the case pane becomes narrower. ".repeat(5);
				await expected.fill(wrapped);
				const wide = await height();
				await page.locator(".body-editor").evaluate((node) => {
					node.style.width = "280px";
				});
				await page.waitForFunction(() => {
					const field = document.querySelector('[aria-label="Expected result 1"]');
					return field instanceof HTMLTextAreaElement && field.clientHeight >= field.scrollHeight;
				});
				expect(await height()).toBeGreaterThan(wide);
				await page.locator(".body-editor").evaluate((node) => {
					node.style.width = "";
				});
				await page.waitForFunction((wide) => {
					const field = document.querySelector('[aria-label="Expected result 1"]');
					return field instanceof HTMLTextAreaElement && field.clientHeight === wide;
				}, wide);
				expect(await expected.inputValue()).toBe(wrapped);
				if (device === "phone") {
					const portraitWidth = await expected.evaluate((node) => node.clientWidth);
					await page.setViewportSize({ width: 844, height: 390 });
					await page.waitForFunction((portraitWidth) => {
						const field = document.querySelector('[aria-label="Expected result 1"]');
						return (
							field instanceof HTMLTextAreaElement &&
							field.clientWidth > portraitWidth &&
							field.clientHeight >= field.scrollHeight
						);
					}, portraitWidth);
					await page.setViewportSize({ width: 390, height: 844 });
					await page.waitForFunction((portraitWidth) => {
						const field = document.querySelector('[aria-label="Expected result 1"]');
						return (
							field instanceof HTMLTextAreaElement &&
							field.clientWidth === portraitWidth &&
							field.clientHeight >= field.scrollHeight
						);
					}, portraitWidth);
				}

				await expected.fill("");
				const cdp = await browser.context.newCDPSession(page);
				await cdp.send("Input.imeSetComposition", { text: "にほんご", selectionStart: 4, selectionEnd: 4 });
				expect(await expected.inputValue()).toBe("にほんご");
				await cdp.send("Input.imeSetComposition", { text: "日本語", selectionStart: 3, selectionEnd: 3 });
				await cdp.send("Input.insertText", { text: "日本語" });
				expect(await expected.inputValue()).toBe("日本語");
				expect(await page.getByRole("textbox", { name: /^Step \d+$/ }).count()).toBe(1);
				expect(await expected.evaluate((node) => document.activeElement === node)).toBe(true);
				expect(browser.errors).toEqual([]);
			} finally {
				await browser.close();
				await server.stop();
			}
		},
		30_000,
	);

for (const device of ["desktop", "phone"] satisfies ("desktop" | "phone")[])
	test.skipIf(!browserAvailable)(
		`a hidden editor fits its fields when shown without window errors on ${device}`,
		async () => {
			const server = await startServer();
			const body = {
				title: "Shown again",
				pre: "First line\nSecond line\nThird line",
				steps: [
					{
						id: "s1",
						action: "Open the cart and check every item before applying the coupon. ".repeat(5).trim(),
						expected: "The total includes the discount.\nEvery item stays visible.\nThe coupon remains applied.",
					},
				],
			};
			await server.api("propose", { edits: [{ op: "create", body }] });
			const browser = await openPage(server, { path: "/p/scratch/suite/c/1", device });
			try {
				const { page } = browser;
				await page.getByRole("button", { name: body.title, exact: true }).waitFor();
				await page.keyboard.press("e");
				const fields = page.locator(".body-editor textarea");
				const values = [body.title, body.pre, ...body.steps.flatMap((step) => [step.action, step.expected])];
				for (const width of ["280px", ""]) {
					await page.locator(".body-editor").evaluate(async (node) => {
						await document.fonts.ready;
						node.style.display = "none";
						await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
					});
					expect(await fields.evaluateAll((nodes) => nodes.map((node) => node.clientWidth))).toEqual([0, 0, 0, 0]);
					await page.locator(".body-editor").evaluate(async (node, width) => {
						node.style.width = width;
						node.style.display = "";
						await new Promise((resolve) =>
							requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve))),
						);
					}, width);
					expect(
						await fields.evaluateAll((nodes) =>
							nodes.map((node) => ({
								value: node instanceof HTMLTextAreaElement ? node.value : null,
								fits: node.clientWidth > 0 && node.clientHeight >= node.scrollHeight,
							})),
						),
					).toEqual(values.map((value) => ({ value, fits: true })));
					expect(browser.errors).toEqual([]);
				}
			} finally {
				await browser.close();
				await server.stop();
			}
		},
		30_000,
	);

test.skipIf(!browserAvailable)(
	"typing in one editor field measures that field without measuring unchanged siblings",
	async () => {
		const server = await startServer();
		await server.api("propose", {
			edits: [
				{
					op: "create",
					body: {
						title: "Independent fields",
						steps: Array.from({ length: 12 }, (_, i) => ({
							id: `s${i}`,
							action: `Step ${i}`,
							expected: `Expected ${i}`,
						})),
					},
				},
			],
		});
		const browser = await openPage(server, { path: "/p/scratch/suite/c/1" });
		try {
			const { page } = browser;
			await page.getByRole("button", { name: "Independent fields", exact: true }).waitFor();
			await page.keyboard.press("e");
			const field = page.getByRole("textbox", { name: "Step 1", exact: true });
			await field.focus();
			await page.evaluate(async () => {
				await document.fonts.ready;
				await new Promise<void>((resolve) => {
					const observer = new ResizeObserver(() => {
						observer.disconnect();
						requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
					});
					for (const textarea of document.querySelectorAll("textarea")) observer.observe(textarea);
				});
				const native = Object.getOwnPropertyDescriptor(Element.prototype, "scrollHeight")?.get;
				if (!native) throw new Error("No scrollHeight getter");
				const reads: string[] = [];
				Reflect.set(window, "textareaHeightReads", reads);
				Object.defineProperty(Element.prototype, "scrollHeight", {
					configurable: true,
					get() {
						if (this instanceof HTMLTextAreaElement) reads.push(this.getAttribute("aria-label") ?? "");
						return native.call(this);
					},
				});
			});
			await page.keyboard.type("abcdefgh");
			expect(await field.inputValue()).toBe("abcdefghStep 0");
			const reads = z.array(z.string()).parse(await page.evaluate(() => Reflect.get(window, "textareaHeightReads")));
			budget("textarea height reads while typing eight keys", reads.length, 8, "reads");
			expect(reads.every((label) => label === "Step 1")).toBe(true);
			expect(
				await field.evaluate((element) => {
					if (!(element instanceof HTMLTextAreaElement)) throw new Error("Not a textarea");
					return {
						fits: element.clientHeight >= element.scrollHeight,
						start: element.selectionStart,
						end: element.selectionEnd,
					};
				}),
			).toEqual({ fits: true, start: 8, end: 8 });
			expect(browser.errors).toEqual([]);
		} finally {
			await browser.close();
			await server.stop();
		}
	},
	30_000,
);
