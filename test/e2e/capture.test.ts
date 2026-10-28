import { expect, test } from "bun:test";
import { z } from "zod";
import { Policy } from "../../src/core/kinds.ts";
import { parseCase } from "../../src/core/markdown.ts";
import { CaseView, editDraft } from "../../src/web/suite/model.ts";
import { browserAvailable, eventually, joinPerson, keyCount, openPage, paste, startServer } from "./support.ts";

test.skipIf(!browserAvailable)(
	"a save lets the Suite's first list read finish when there is no cached list to patch",
	async () => {
		const server = await startServer();
		await server.api("propose", {
			edits: [
				{ op: "create", body: { title: "Local case" } },
				{ op: "create", body: { title: "Remote case" } },
			],
		});
		const h = await openPage(server, {
			path: "/p/scratch/suite/c/1",
			setup: async (page) => {
				await page.addInitScript(() => {
					const send = window.fetch.bind(window);
					let reads = 0;
					const sending = async (input: RequestInfo | URL, init?: RequestInit) => {
						const reply = await send(input, init);
						if (String(input).endsWith("/find") && typeof init?.body === "string" && init.body.includes('"cases"')) {
							const read = ++reads;
							document.documentElement.dataset.heldReads = String(read);
							await new Promise<void>((resolve) =>
								window.addEventListener(read === 1 ? "test:first" : "test:fresh", () => resolve(), { once: true }),
							);
						}
						return reply;
					};
					window.fetch = Object.assign(sending, { preconnect: window.fetch.preconnect });
				});
			},
		});
		try {
			const { page } = h;
			await page.getByRole("button", { name: "Local case", exact: true }).waitFor();
			await page.waitForFunction(() => document.documentElement.dataset.heldReads === "1");
			expect(await page.locator('[data-testid="case-list"]').getAttribute("data-loaded")).toBe("0");
			await page.keyboard.press("e");
			await page.getByRole("textbox", { name: "Case title", exact: true }).fill("Saved local case");
			await page.keyboard.press("Escape");
			await page.waitForFunction(() => document.querySelector(".cstate .chip")?.textContent === "v2");
			await page.evaluate(() => window.dispatchEvent(new Event("test:first")));
			await page.waitForFunction(
				() => document.querySelector('[data-testid="case-list"]')?.getAttribute("data-loaded") === "2",
			);
			expect(await page.locator('#list [role="option"] .ti').allTextContents()).toEqual([
				"Saved local case",
				"Remote case",
			]);
			await page.waitForFunction(() => Number(document.documentElement.dataset.heldReads) >= 2);
			await page.evaluate(() => window.dispatchEvent(new Event("test:fresh")));
			await page.getByRole("option").filter({ hasText: "Saved local case" }).waitFor();
			expect(h.errors).toEqual([]);
		} finally {
			await h.close();
			await server.stop();
		}
	},
	30_000,
);

for (const action of ["placement", "save"] as const) {
	test.skipIf(!browserAvailable)(
		`a held Suite page cannot overwrite a ${action} and is followed by a fresh read`,
		async () => {
			const server = await startServer();
			await server.api("propose", {
				edits: [
					{ op: "create", body: { title: "Local case" } },
					{ op: "create", body: { title: "Remote case" } },
				],
			});
			const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
			try {
				const { page } = h;
				await page.getByRole("button", { name: "Local case", exact: true }).waitFor();
				await page.getByRole("option").filter({ hasText: "Remote case" }).waitFor();
				await page.evaluate(() => {
					const send = window.fetch.bind(window);
					let reads = 0;
					const sending = async (input: RequestInfo | URL, init?: RequestInit) => {
						const reply = await send(input, init);
						if (String(input).endsWith("/find") && typeof init?.body === "string" && init.body.includes('"cases"')) {
							const read = ++reads;
							document.documentElement.dataset.heldReads = String(read);
							await new Promise<void>((resolve) =>
								window.addEventListener(read === 1 ? "test:old" : "test:fresh", () => resolve(), { once: true }),
							);
						}
						return reply;
					};
					window.fetch = Object.assign(sending, { preconnect: window.fetch.preconnect });
				});
				await server.api("propose", {
					edits: [{ op: "edit", case: "C-2", base: 1, body: { title: "Remote update" } }],
				});
				await page.waitForFunction(() => document.documentElement.dataset.heldReads === "1");
				const row = page.getByRole("option").filter({ hasText: "Local case" });
				const expected = action === "placement" ? "#localtag" : "Saved local case";
				if (action === "placement") {
					await page.keyboard.press("t");
					await page.keyboard.type("localtag");
					await page.keyboard.press("Enter");
				} else {
					await page.keyboard.press("e");
					await page.getByRole("textbox", { name: "Case title", exact: true }).fill(expected);
					await page.keyboard.press("Escape");
					await page.waitForFunction(() => document.querySelector(".cstate .chip")?.textContent === "v2");
					await page.getByRole("option").filter({ hasText: "Remote case" }).click();
				}
				const shown = action === "placement" ? row : page.getByRole("option").filter({ hasText: expected });
				await eventually(
					() => shown.textContent(),
					(text) => text?.includes(expected) === true,
				);
				await page.evaluate(() => window.dispatchEvent(new Event("test:old")));
				await page.waitForFunction(() => Number(document.documentElement.dataset.heldReads) >= 2);
				await page.evaluate(
					() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
				);
				expect(await page.locator('#list [role="option"]').allTextContents()).toContainEqual(
					expect.stringContaining(expected),
				);
				await page.evaluate(() => window.dispatchEvent(new Event("test:fresh")));
				await page.getByRole("option").filter({ hasText: "Remote update" }).waitFor();
				expect(await page.locator('#list [role="option"]').allTextContents()).toContainEqual(
					expect.stringContaining(expected),
				);
				expect(h.errors).toEqual([]);
			} finally {
				await h.close();
				await server.stop();
			}
		},
		30_000,
	);
}

test.skipIf(!browserAvailable)(
	"UI-3 capture from a case URL creates a new case without editing the selected case",
	async () => {
		const server = await startServer();
		await server.api("propose", {
			edits: [
				{
					op: "create",
					body: { title: "Original case", steps: [{ id: "aa", action: "Original step", expected: null }] },
				},
			],
		});
		const browser = await openPage(server, { path: "/p/scratch/suite/c/1" });
		try {
			const { page } = browser;
			await page.getByRole("button", { name: "Original case", exact: true }).waitFor();
			await page.keyboard.press("c");
			await page.keyboard.type("New case");
			await page.keyboard.press("Enter");
			await page.keyboard.type("New step");
			await page.keyboard.press("Escape");
			const rows = await eventually(
				() => server.api("find", { in: "cases" }),
				(reply) => reply.count === 2,
			);
			expect(rows.items.map((row) => row.title)).toContain("New case");
			const cases = await server.api("get", { refs: ["C-1", "C-2"] });
			expect(cases[0]).toMatchObject({
				title: "Original case",
				version: 1,
				steps: [{ id: "aa", action: "Original step" }],
			});
			expect(cases[1]).toMatchObject({ title: "New case", version: 1, steps: [{ action: "New step" }] });
			expect(browser.errors).toEqual([]);
		} finally {
			await browser.close();
			await server.stop();
		}
	},
	30_000,
);

test.skipIf(!browserAvailable)(
	"the Suite finishes paging and refreshes while changes arrive during every read",
	async () => {
		const server = await startServer({ cases: 1001 });
		const h = await openPage(server, {
			path: "/p/scratch/suite",
			setup: async (page) => {
				await page.addInitScript(() => {
					let reads = 0;
					let eventfulReads = 0;
					const streams: EventSource[] = [];
					const Native = window.EventSource;
					window.EventSource = class extends Native {
						constructor(url: string | URL, init?: EventSourceInit) {
							super(url, init);
							streams.push(this);
						}
					};
					const send = window.fetch.bind(window);
					const sending = async (input: RequestInfo | URL, init?: RequestInit) => {
						const reply = await send(input, init);
						if (String(input).endsWith("/find") && typeof init?.body === "string" && init.body.includes('"cases"')) {
							const stream = streams.find((stream) => stream.onmessage !== null);
							if (!stream?.onmessage) throw new Error("No change-stream handler for the held case read");
							stream.onmessage(new MessageEvent("message", { data: '{"op":"propose","touched":[]}' }));
							eventfulReads++;
							document.documentElement.dataset.caseReads = String(++reads);
							document.documentElement.dataset.eventfulReads = String(eventfulReads);
						}
						return reply;
					};
					window.fetch = Object.assign(sending, { preconnect: window.fetch.preconnect });
				});
			},
		});
		try {
			const { page } = h;
			await page.waitForFunction(
				() => document.querySelector('[data-testid="case-list"]')?.getAttribute("data-loaded") === "1001",
			);
			expect(await page.locator('[data-testid="case-list"]').getAttribute("data-total")).toBe("1001");
			const duringReads = () =>
				page.evaluate(() => ({
					reads: Number(document.documentElement.dataset.caseReads),
					eventful: Number(document.documentElement.dataset.eventfulReads),
				}));
			const initialReads = await duringReads();
			expect(initialReads.reads).toBeGreaterThan(0);
			expect(initialReads.eventful).toBe(initialReads.reads);
			await server.api("propose", {
				edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Updated while reading" } }],
			});
			await page.getByRole("option").filter({ hasText: "Updated while reading" }).waitFor();
			expect(await page.locator('[data-testid="case-list"]').getAttribute("data-loaded")).toBe("1001");
			const refreshedReads = await duringReads();
			expect(refreshedReads.reads).toBeGreaterThan(initialReads.reads);
			expect(refreshedReads.eventful).toBe(refreshedReads.reads);
			expect(h.errors).toEqual([]);
		} finally {
			await h.close();
			await server.stop();
		}
	},
	30_000,
);

for (const device of ["desktop", "phone"] as const) {
	test.skipIf(!browserAvailable)(
		`the ${device} editor validates and saves defined custom fields for a case author`,
		async () => {
			const server = await startServer({ mode: "server", provider: true });
			const policy = Policy.extend({ version: z.number() }).parse(
				await server.api("admin", { do: "policy.show", project: "scratch" }),
			);
			const proposed = await server.api("propose", {
				edits: [
					{
						op: "policy",
						base: policy.version,
						settings: {
							...policy.settings,
							fields: {
								risk: { kind: "text", label: "Risk", required: true },
								priority: { kind: "choice", label: "Priority", required: true, choices: ["low", "high"] },
								notes: { kind: "text", label: "Notes", required: false },
								team: { kind: "choice", label: "Team", required: false, choices: ["checkout", "accounts"] },
							},
						},
					},
				],
			});
			const question = (await server.api("inbox", { kind: "adopt" })).items.find((q) => q.q === proposed.question);
			if (!question) throw new Error("Policy question missing");
			await server.api("decide", { q: question.q, onEvidence: question.evidenceHash, answer: { is: "accept" } });
			await joinPerson(server, "case-author", { project: "scratch", can: ["read", "produce"] });
			const h = await openPage(server, { device, as: { name: "case-author" } });
			try {
				const { page } = h;
				let saves = 0;
				page.on("request", (request) => {
					if (request.url().endsWith("/propose")) saves++;
				});
				await page.keyboard.press("c");
				await page.getByRole("textbox", { name: "Case title", exact: true }).fill("Case with custom fields");
				const screenshot = process.env.MAINWORTHY_FIELDS_SCREENSHOT;
				if (screenshot) await page.screenshot({ path: `${screenshot}-${device}.png`, fullPage: true });
				await page.getByLabel("Risk (required)", { exact: true }).waitFor();
				await page.keyboard.press("Escape");
				await page.getByText("risk: Risk is required; priority: Priority is required", { exact: true }).waitFor();
				expect(saves).toBe(0);
				expect((await server.api("find", { in: "cases" })).count).toBe(0);
				await page.getByLabel("Priority (required)", { exact: true }).selectOption("high");
				await page.getByLabel("Risk (required)", { exact: true }).fill("   ");
				await page.keyboard.press("Escape");
				await page.getByText("risk: Risk is required", { exact: true }).waitFor();
				expect(saves).toBe(0);
				await page.getByLabel("Risk (required)", { exact: true }).fill("Payments");
				await page.getByLabel("Notes", { exact: true }).fill("Check refunds");
				await page.getByLabel("Team", { exact: true }).selectOption("checkout");
				await page.keyboard.press("Escape");
				await eventually(
					() => server.api("find", { in: "cases" }),
					(reply) => reply.count === 1,
				);
				const read = await eventually(
					() => server.api("get", { refs: ["C-1"], as: "md" }),
					(rows) => rows[0]?.version === 1,
				);
				const parsed = parseCase(String(read[0]?.md));
				if (!parsed.ok) throw new Error("Saved case did not parse");
				expect(parsed.doc.body.fields).toEqual({
					risk: "Payments",
					priority: "high",
					notes: "Check refunds",
					team: "checkout",
				});
				expect(saves).toBe(1);
				await page.waitForFunction(() => document.querySelector(".cstate .chip")?.textContent === "v1");
				await page.reload();
				await page.getByRole("button", { name: "Case with custom fields", exact: true }).waitFor();
				await page.keyboard.press("e");
				expect(await page.getByLabel("Risk (required)", { exact: true }).inputValue()).toBe("Payments");
				expect(await page.getByLabel("Priority (required)", { exact: true }).inputValue()).toBe("high");
				await page.getByLabel("Risk (required)", { exact: true }).fill("");
				await page.keyboard.press("Escape");
				await page.getByText("risk: Risk is required", { exact: true }).waitFor();
				expect(saves).toBe(1);
				await page.getByLabel("Risk (required)", { exact: true }).fill("Refunds");
				await page.getByLabel("Team", { exact: true }).selectOption("");
				await page.keyboard.press("Escape");
				const edited = await eventually(
					() => server.api("get", { refs: ["C-1"], as: "md" }),
					(rows) => rows[0]?.version === 2,
				);
				const updated = parseCase(String(edited[0]?.md));
				if (!updated.ok) throw new Error("Edited case did not parse");
				expect(updated.doc.body.fields).toEqual({ risk: "Refunds", priority: "high", notes: "Check refunds" });
				expect(saves).toBe(2);
				expect(h.errors).toEqual([]);
			} finally {
				await h.close();
				await server.stop();
			}
		},
		30_000,
	);
}

test.skipIf(!browserAvailable)(
	"a stored draft from before field reads preserves optional and undefined values",
	async () => {
		const server = await startServer();
		await server.api("propose", {
			edits: [
				{
					op: "create",
					body: {
						title: "Before deploy",
						fields: { notes: "Keep optional notes", legacy: "Keep undefined value" },
					},
				},
			],
		});
		const policy = Policy.extend({ version: z.number() }).parse(
			await server.api("admin", { do: "policy.show", project: "scratch" }),
		);
		const proposed = await server.api("propose", {
			edits: [
				{
					op: "policy",
					base: policy.version,
					settings: {
						...policy.settings,
						fields: { notes: { kind: "text", label: "Notes", required: false } },
					},
				},
			],
		});
		const question = (await server.api("inbox", { kind: "adopt" })).items.find((q) => q.q === proposed.question);
		if (!question) throw new Error("Policy question missing");
		await server.api("decide", { q: question.q, onEvidence: question.evidenceHash, answer: { is: "accept" } });
		// A draft saved after drafts carried their project (issue #755) but before the editor read fields.
		const scratch = z
			.array(z.object({ key: z.string(), identity: z.string() }))
			.parse(await server.api("admin", { do: "project.list" }))
			.find((entry) => entry.key === "scratch");
		const old = editDraft(CaseView.parse((await server.api("get", { refs: ["C-1"] }))[0]), scratch?.identity);
		old.body = { ...old.body, title: "Draft written before deploy", fields: {} };
		old.original = { ...old.original, fields: {} };
		old.dirty = true;
		const h = await openPage(server, {
			path: "/p/scratch/suite/c/1",
			setup: async (page, context) => {
				const session = z
					.object({ result: z.object({ actorId: z.number() }) })
					.parse(await (await context.request.get(`${server.url}/api/session`)).json());
				await page.addInitScript(
					({ actorId, draft }) => {
						localStorage.setItem(`mainworthy:#${actorId}:draft:scratch:C-1`, JSON.stringify(draft));
					},
					{ actorId: session.result.actorId, draft: old },
				);
			},
		});
		try {
			const { page } = h;
			const title = page.getByRole("textbox", { name: "Case title", exact: true });
			await title.waitFor();
			expect(await title.inputValue()).toBe("Draft written before deploy");
			expect(await page.getByLabel("Notes", { exact: true }).inputValue()).toBe("");
			await title.press("Escape");
			const rows = await eventually(
				() => server.api("get", { refs: ["C-1"] }),
				(rows) => rows[0]?.version === 2,
			);
			expect(rows[0]).toMatchObject({
				title: "Draft written before deploy",
				fields: { notes: "Keep optional notes", legacy: "Keep undefined value" },
			});
			expect(h.errors).toEqual([]);
		} finally {
			await h.close();
			await server.stop();
		}
	},
	30_000,
);

test.skipIf(!browserAvailable)(
	"an ordinary edit preserves old fields and is not blocked by a new required field",
	async () => {
		const server = await startServer();
		await server.api("propose", {
			edits: [{ op: "create", body: { title: "Field-bearing case", fields: { priority: "P1" } } }],
		});
		const policy = Policy.extend({ version: z.number() }).parse(
			await server.api("admin", { do: "policy.show", project: "scratch" }),
		);
		const proposed = await server.api("propose", {
			edits: [
				{
					op: "policy",
					base: policy.version,
					settings: {
						...policy.settings,
						fields: {
							risk: { kind: "choice", label: "Risk", required: true, choices: ["low", "high"] },
							priority: { kind: "choice", label: "Priority", required: false, choices: ["P2", "P3"] },
						},
					},
				},
			],
		});
		const question = (await server.api("inbox", { kind: "adopt" })).items.find((item) => item.q === proposed.question);
		if (!question) throw new Error("Policy review question missing");
		expect(
			(await server.api("decide", { q: question.q, onEvidence: question.evidenceHash, answer: { is: "accept" } }))[0]
				?.status,
		).toBe("decided");
		const browser = await openPage(server, { path: "/p/scratch/suite/c/1" });
		try {
			await browser.page.getByRole("button", { name: "Field-bearing case", exact: true }).waitFor();
			await browser.page.keyboard.press("e");
			expect(await browser.page.getByLabel("Priority", { exact: true }).inputValue()).toBe("P1");
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
	"Tab from a step opens and focuses its expected result without losing the draft",
	async () => {
		const server = await startServer();
		await server.api("propose", { edits: [{ op: "create", outline: "Checkout\n  Open the cart" }] });
		const browser = await openPage(server, { path: "/p/scratch/suite/c/1" });
		try {
			const { page } = browser;
			await page.getByRole("button", { name: "Checkout", exact: true }).waitFor();
			await page.keyboard.press("e");
			const step = page.getByRole("textbox", { name: "Step 1", exact: true });
			await step.fill("Open the checkout");
			await step.press("Tab");
			const expected = page.getByRole("textbox", { name: "Expected result 1", exact: true });
			await expected.waitFor();
			expect(await expected.evaluate((node) => node === document.activeElement)).toBe(true);
			await page.keyboard.type("Checkout is visible");
			expect(await step.inputValue()).toBe("Open the checkout");
			expect(await expected.inputValue()).toBe("Checkout is visible");
			await expected.press("Escape");
			const saved = await eventually(
				() => server.api("get", { refs: ["C-1"] }),
				(rows) => rows[0]?.version === 2,
			);
			expect(saved[0]).toMatchObject({ steps: [{ action: "Open the checkout", expected: "Checkout is visible" }] });
			expect(browser.errors).toEqual([]);
		} finally {
			await browser.close();
			await server.stop();
		}
	},
	15_000,
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
			expect((await keyCount(page)) - textKeys).toBe(8);
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
		const browser = await openPage(server, { path: "/p/scratch/suite?folder=Checkout" });
		let release = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		try {
			const { page } = browser;
			await page.getByRole("option").filter({ hasText: "Anchor case" }).waitFor();
			let first = true;
			let requested = () => {};
			const pending = new Promise<void>((resolve) => {
				requested = resolve;
			});
			await page.route("**/api/p/scratch/propose", async (route) => {
				if (first) {
					first = false;
					requested();
					await held;
				}
				await route.continue();
			});
			await page.keyboard.press("c");
			await page.keyboard.type("First captured case");
			await page.keyboard.press("Shift+Enter");
			await pending;
			await page.keyboard.type("Second captured case");
			expect(await page.getByRole("textbox", { name: "Case title" }).inputValue()).toBe("Second captured case");
			await page.keyboard.press("Escape");
			release();
			const rows = await eventually(
				() => server.api("find", { in: "cases", folder: "Checkout" }),
				(value) => value.items.length === 3,
			);
			expect(rows.items.map((row) => row.title)).toEqual([
				"Anchor case",
				"First captured case",
				"Second captured case",
			]);
			await page.waitForFunction(() => document.querySelector(".cstate .chip")?.textContent === "v1");
			expect(new URL(page.url()).searchParams.get("folder")).toBe("Checkout");
			expect(await page.locator("#ltitle").innerText()).toBe("Checkout");
			await page.waitForFunction(
				() => document.querySelector('[data-testid="case-list"]')?.getAttribute("data-loaded") === "3",
			);
			expect(await page.locator('#list [role="option"] .ti').allTextContents()).toEqual([
				"Anchor case",
				"First captured case",
				"Second captured case",
			]);
			expect(browser.errors).toEqual([]);
		} finally {
			release();
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
			await page.waitForFunction(() => document.querySelector(".cstate .chip")?.textContent === "v2");
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
		let release = () => {};
		try {
			const { page } = h;
			let held = Promise.resolve();
			await page.route("**/api/p/scratch/propose", async (route) => {
				const response = await route.fetch();
				await held;
				await route.fulfill({ response });
			});
			const used = new Set(["a0"]);
			for (const version of [2, 3]) {
				held = new Promise<void>((resolve) => {
					release = resolve;
				});
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
				const steps = z.array(z.object({ id: z.string(), action: z.string() })).parse(rows[0]?.steps);
				expect(steps.map((step) => step.action)).toEqual([`Replacement ${version}`]);
				for (const step of steps) {
					expect(used.has(step.id)).toBe(false);
					used.add(step.id);
				}
				await page.locator(".cstate").filter({ hasText: "Draft" }).waitFor();
				release();
				await page.waitForFunction(
					(value) =>
						document.querySelector(".cstate .chip")?.textContent === `v${value}` &&
						Object.keys(localStorage).every((key) => !key.endsWith(":draft:scratch:C-1")),
					version,
				);
				if (version === 2) {
					await page.reload();
					await page.getByRole("button", { name: "Stable step identity", exact: true }).waitFor();
				}
			}
			expect(h.errors).toEqual([]);
		} finally {
			release();
			await h.close();
			await server.stop();
		}
	},
	30_000,
);

// Issue #146. The suite asks for the pages of its list one after another, and a change that arrives while it asks
// for the next page reads the pages again. When that lands in the same task as the request, the page never shows
// that it was waiting for one, and the list stopped where it was (500 of 1,001 here). The change is sent from the
// page's own `fetch`, as the request for the second page leaves, so the order is the same every time.
test.skipIf(!browserAvailable)(
	"a change that arrives as the list asks for its next page does not stop the list",
	async () => {
		const server = await startServer({ cases: 1001 });
		const h = await openPage(server, { path: "/p/scratch/queue" });
		try {
			const { page } = h;
			await page.addInitScript(() => {
				const streams: EventSource[] = [];
				const Native = window.EventSource;
				window.EventSource = class extends Native {
					constructor(url: string | URL, init?: EventSourceInit) {
						super(url, init);
						streams.push(this);
					}
				};
				const send = window.fetch.bind(window);
				let told = false;
				const sending = (input: RequestInfo | URL, init?: RequestInit) => {
					const asksForNextPage =
						String(input).endsWith("/find") && typeof init?.body === "string" && init.body.includes('"cursor"');
					if (asksForNextPage && !told) {
						told = true;
						for (const stream of streams)
							stream.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ op: "propose", touched: [] }) }));
					}
					return send(input, init);
				};
				window.fetch = Object.assign(sending, { preconnect: window.fetch.preconnect });
			});
			await page.goto(`${server.url}/p/scratch/suite`);
			await page.waitForFunction(
				() => Number(document.querySelector('[data-testid="case-list"]')?.getAttribute("data-total")) > 0,
			);
			await page.waitForFunction(() => {
				const list = document.querySelector('[data-testid="case-list"]');
				return list?.getAttribute("data-loaded") === list?.getAttribute("data-total");
			});
			expect(await page.locator('[data-testid="case-list"]').getAttribute("data-loaded")).toBe("1001");
			expect(h.errors).toEqual([]);
		} finally {
			await h.close();
			await server.stop();
		}
	},
	30_000,
);

(browserAvailable ? test : test.skip)(
	"a private draft timeline names its base after a newer version arrives",
	async () => {
		const server = await startServer();
		let view: Awaited<ReturnType<typeof openPage>> | null = null;
		try {
			await server.api("propose", { edits: [{ op: "create", outline: "Original title" }] });
			view = await openPage(server, { path: "/p/scratch/suite/c/1" });
			const { page } = view;
			await page.getByRole("button", { name: "Original title", exact: true }).waitFor();
			await page.keyboard.press("e");
			await page.getByRole("textbox", { name: "Case title", exact: true }).fill("Private title");
			await server.api("propose", {
				edits: [{ op: "edit", case: "C-1", base: 1, body: { pre: "A newer public precondition" } }],
			});
			await page.getByText("Others see version 2", { exact: true }).waitFor();
			expect(await page.locator(".timeline-block .ev.draft").innerText()).toContain(
				"Your private draft. Based on version 1.",
			);
			expect(await page.getByRole("textbox", { name: "Case title", exact: true }).inputValue()).toBe("Private title");
			expect(view.errors).toEqual([]);
		} finally {
			await view?.close();
			await server.stop();
		}
	},
	30000,
);
