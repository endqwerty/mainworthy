import { expect, test } from "bun:test";
import { z } from "zod";
import type { CommandFate } from "../../src/core/ops.ts";
import { Slot } from "../../src/web/runs/models.ts";
import { browserAvailable, eventually, launchBrowser, openPage, startServer } from "./support.ts";

test.skipIf(!browserAvailable)(
	"an unreadable operation reply shows a reload message instead of an empty suite",
	async () => {
		const server = await startServer();
		let browser: Awaited<ReturnType<typeof openPage>> | null = null;
		try {
			browser = await openPage(server, {
				path: "/p/scratch/suite",
				setup: async (page) => {
					await page.route("**/api/p/scratch/find", (route) =>
						route.fulfill({ json: { ok: true, result: { items: [], cursor: null }, seq: null } }),
					);
				},
			});
			const { page } = browser;
			const text = await eventually(
				() => page.getByTestId("case-list").innerText(),
				(text) => text.includes("The server answered something this page cannot read; reload."),
			);
			expect(text).toContain("The server answered something this page cannot read; reload.");
			expect(text).not.toContain("No cases yet.");
			expect(browser.errors).toEqual([]);
		} finally {
			await browser?.close();
			await server.stop();
		}
	},
	30_000,
);

test.skipIf(!browserAvailable)(
	"an unreadable save reply keeps its command so retry does not create a second case",
	async () => {
		const server = await startServer();
		const browser = await openPage(server);
		try {
			const { page } = browser;
			const commands: string[] = [];
			const lookups: string[] = [];
			await browser.context.route("**/api/p/scratch/propose", async (route) => {
				commands.push(z.object({ cmd: z.string() }).parse(route.request().postDataJSON()).cmd);
				if (commands.length === 1) {
					const response = await route.fetch();
					await route.fulfill({ response, json: { ok: true, result: {}, seq: null } });
				} else await route.continue();
			});
			await browser.context.route("**/api/p/scratch/command", async (route) => {
				lookups.push(z.object({ cmd: z.string() }).parse(route.request().postDataJSON()).cmd);
				await route.continue();
			});
			await page.keyboard.press("c");
			await page.keyboard.type("Recorded once despite unreadable reply");
			await page.keyboard.press("Enter");
			await page.keyboard.type("Read the saved case");
			await page.keyboard.press("Escape");
			await page.waitForFunction(() => document.getElementById("stat")?.textContent?.includes("reload."));
			expect((await server.api("find", { in: "cases" })).count).toBe(1);
			await page.keyboard.press("Control+Enter");
			await page.waitForURL("**/suite/c/*");
			expect((await server.api("find", { in: "cases" })).count).toBe(1);
			expect(page.url()).toEndWith("/suite/c/1");
			expect(commands).toHaveLength(1);
			expect(lookups).toEqual(commands);
			expect(browser.errors).toEqual([]);
		} finally {
			await browser.close();
			await server.stop();
		}
	},
	30_000,
);

test.skipIf(!browserAvailable)(
	"an unreadable settings list shows the reload message",
	async () => {
		const server = await startServer();
		const browser = await openPage(server, {
			path: "/p/scratch/settings",
			setup: async (page) => {
				await page.route("**/api/credential", (route) => {
					if (route.request().postDataJSON().do !== "list") return route.continue();
					return route.fulfill({ json: { ok: true, result: null } });
				});
			},
		});
		try {
			await browser.page.getByRole("option", { name: "Your sign-in", exact: true }).click();
			await browser.page
				.getByRole("status")
				.filter({ hasText: "The server answered something this page cannot read; reload." })
				.waitFor({ timeout: 5000 });
			expect(await browser.page.locator("#detail").innerText()).not.toContain("Check the connection");
			expect(browser.errors).toEqual([]);
		} finally {
			await browser.close();
			await server.stop();
		}
	},
	30_000,
);

for (const reply of ["missing gate", "unreadable", "lost", "unsent"]) {
	test.skipIf(!browserAvailable)(
		`a ${reply} report reply reconciles its command before another result`,
		async () => {
			const server = await startServer();
			let browser: Awaited<ReturnType<typeof openPage>> | null = null;
			try {
				await server.api("propose", { edits: [{ op: "create", outline: "Review case\n  Open > Ready" }] });
				const plan = await server.api("plan", { name: "Review run", select: {} });
				browser = await openPage(server, { path: `/p/scratch/runs/${plan.run.slice(2)}` });
				const { page } = browser;
				const commands: string[] = [];
				const lookups: string[] = [];
				let readable = false;
				await page.waitForSelector('[data-run-document="C-1"][data-active="true"][data-ready="true"]');
				await browser.context.route("**/api/p/scratch/report", async (route) => {
					commands.push(z.object({ cmd: z.string() }).parse(route.request().postDataJSON()).cmd);
					if (reply === "unsent") return commands.length === 1 ? route.abort() : route.continue();
					const response = await route.fetch();
					if (reply === "lost") return route.abort();
					const envelope = z
						.object({ result: z.record(z.string(), z.unknown()) })
						.passthrough()
						.parse(await response.json());
					if (reply === "missing gate") delete envelope.result.gate;
					else envelope.result = {};
					await route.fulfill({ response, json: envelope });
				});
				await browser.context.route("**/api/p/scratch/command", async (route) => {
					lookups.push(z.object({ cmd: z.string() }).parse(route.request().postDataJSON()).cmd);
					if (!readable) return route.abort();
					await route.continue();
				});
				await page.keyboard.press("p");
				await eventually(
					() => page.locator("#stat").innerText(),
					(text) => text.includes("Its note is kept."),
				);
				const status = await page.locator("#stat").innerText();
				expect(status).toContain("C-1's outcome is unknown");
				expect(status).not.toContain("was not recorded");
				if (reply !== "lost" && reply !== "unsent") expect(status).toContain("reload.");
				else expect(status).toContain("Failed to fetch. Its note is kept.");
				expect(
					(await server.api("timeline", { ref: "C-1" })).entries.filter((entry) => entry.t === "result"),
				).toHaveLength(reply === "unsent" ? 0 : 1);
				readable = true;
				await page.keyboard.press("p");
				await eventually(
					() => page.locator("#stat").innerText(),
					(text) => text.includes("C-1 pass recorded"),
				);
				expect(commands).toHaveLength(reply === "unsent" ? 2 : 1);
				expect(new Set([...commands, ...lookups]).size).toBe(1);
				expect(lookups).toHaveLength(2);
				expect(
					(await server.api("timeline", { ref: "C-1" })).entries.filter((entry) => entry.t === "result"),
				).toHaveLength(1);
				expect(browser.errors).toEqual(
					Array.from(
						{ length: reply === "lost" || reply === "unsent" ? 2 : 1 },
						() => "Failed to load resource: net::ERR_FAILED",
					),
				);
			} finally {
				await browser?.close();
				await server.stop();
			}
		},
		30_000,
	);
}

for (const failure of ["internal", "session change", "begun"] as const) {
	for (const stage of failure === "begun" ? ["first send"] : ["first send", "replay"]) {
		test.skipIf(!browserAvailable)(
			`a report recovers after ${failure} on ${stage} without a second result`,
			async () => {
				const server = await startServer({ mode: "server" });
				let browser: Awaited<ReturnType<typeof openPage>> | null = null;
				try {
					await server.api("propose", { edits: [{ op: "create", outline: "Review case\n  Open > Ready" }] });
					const plan = await server.api("plan", { name: "Report recovery", select: {} });
					browser = await openPage(server, { path: `/p/scratch/runs/${plan.run.slice(2)}` });
					const { page, context } = browser;
					await page.setViewportSize({ width: 1280, height: 800 });
					page.setDefaultTimeout(5000);
					await page.waitForSelector('[data-run-document="C-1"][data-active="true"][data-ready="true"]');
					const other = failure === "session change" ? await context.newPage() : null;
					if (other) {
						await other.route("**/api/session", (route) =>
							route.fulfill({
								status: 401,
								json: { ok: false, error: { code: "unauthenticated", message: "Sign in" } },
							}),
						);
						await other.goto(`${server.url}/p/scratch/settings`);
						await other.locator("#token").waitFor();
						await other.unroute("**/api/session");
					}
					const requests: unknown[] = [];
					const commands: string[] = [];
					const lookups: string[] = [];
					let readable = false;
					await context.route("**/api/p/scratch/report", async (route) => {
						const input: unknown = route.request().postDataJSON();
						requests.push(input);
						commands.push(z.object({ cmd: z.string() }).parse(input).cmd);
						if (stage === "replay" && requests.length === 1) return route.fulfill({ json: { ok: true, result: {} } });
						const response = await route.fetch();
						if (requests.length === (stage === "replay" ? 2 : 1)) {
							if (other) {
								await other.locator("#token").fill(server.token);
								await other.keyboard.press("Enter");
								await other.locator("#app").waitFor();
								await route.fulfill({ response });
							} else if (failure === "internal")
								await route.fulfill({
									status: 500,
									json: { ok: false, error: { code: "internal", message: "Report interrupted" } },
								});
							else await route.fulfill({ response, json: { ok: true, result: {} } });
						} else await route.fulfill({ response });
					});
					await context.route("**/api/p/scratch/command", async (route) => {
						lookups.push(z.object({ cmd: z.string() }).parse(route.request().postDataJSON()).cmd);
						if (stage === "replay" && lookups.length === 1) return route.continue();
						if (failure === "begun")
							return route.fulfill({
								json: { ok: true, result: { state: "begun", op: "report" } satisfies CommandFate },
							});
						if (!readable)
							return route.fulfill({
								status: 503,
								json: { ok: false, error: { code: "internal", message: "Lookup unavailable" } },
							});
						await route.continue();
					});
					await page.bringToFront();
					await page.getByRole("textbox", { name: "Result note" }).fill("Keep this evidence");
					await page.keyboard.press("Escape");
					await page.keyboard.press("p");
					await eventually(
						() => page.locator("#stat").innerText(),
						(text) => text.includes("Its note is kept.") || text.includes("C-1 pass recorded"),
					);
					const evidence = process.env.MAINWORTHY_RUN_RECOVERY_EVIDENCE;
					if (evidence && stage === "first send" && failure !== "session change")
						await page.screenshot({
							path: `${evidence}/${failure === "begun" ? "536" : "578"}-${process.env.MAINWORTHY_RUN_RECOVERY_REVISION}.png`,
						});
					if (failure !== "begun") {
						const status = await page.locator("#stat").innerText();
						expect(status).toContain("C-1's outcome is unknown.");
						expect(status).not.toContain("was not recorded");
						expect(await page.getByRole("textbox", { name: "Result note" }).inputValue()).toBe("Keep this evidence");
						readable = true;
						await page.keyboard.press("p");
					}
					const status = await eventually(
						() => page.locator("#stat").innerText(),
						(text) => text.includes("C-1 pass recorded on pinned version 1."),
					);
					expect(status).toContain("C-1 pass recorded on pinned version 1.");
					expect(requests).toHaveLength(failure === "begun" || stage === "replay" ? 2 : 1);
					for (const input of requests) expect(input).toEqual(requests[0]);
					expect(new Set([...commands, ...lookups]).size).toBe(1);
					const results = (await server.api("timeline", { ref: "C-1" })).entries.filter(
						(entry) => entry.t === "result",
					);
					expect(results).toHaveLength(1);
					expect(Slot.array().parse((await server.api("find", { in: "slots", run: plan.run })).items)[0]).toMatchObject(
						{
							case: "C-1",
							state: "satisfied",
							fills: [{ outcome: "pass", note: "Keep this evidence" }],
						},
					);
					expect(await page.getByRole("textbox", { name: "Result note" }).inputValue()).toBe("");
				} finally {
					await browser?.close();
					await server.stop();
				}
			},
			30_000,
		);
	}
}

test.skipIf(!browserAvailable)(
	"a refused report replay releases the slot and keeps its note for a fresh result",
	async () => {
		const server = await startServer();
		let browser: Awaited<ReturnType<typeof openPage>> | null = null;
		try {
			await server.api("propose", {
				edits: [1, 2].map((n) => ({ op: "create", outline: `Replay case ${n}\n  Open > Ready` })),
			});
			const plan = await server.api("plan", { name: "Refused replay", select: {} });
			browser = await openPage(server, { path: `/p/scratch/runs/${plan.run.slice(2)}` });
			const { page } = browser;
			page.setDefaultTimeout(5000);
			const commands: string[] = [];
			let readable = false;
			await page.waitForSelector('[data-run-document="C-1"][data-active="true"][data-ready="true"]');
			await browser.context.route("**/api/p/scratch/report", async (route) => {
				commands.push(z.object({ cmd: z.string() }).parse(route.request().postDataJSON()).cmd);
				if (commands.length === 1) return route.abort();
				if (commands.length === 2)
					return route.fulfill({
						status: 409,
						json: { ok: false, error: { code: "conflict", message: "The result needs a fresh request" } },
					});
				await route.continue();
			});
			await browser.context.route("**/api/p/scratch/command", (route) => (readable ? route.continue() : route.abort()));
			await page.keyboard.press("f");
			await page.keyboard.type("wrong total");
			await page.keyboard.press("Enter");
			await eventually(
				() => page.locator("#stat").innerText(),
				(text) => text.includes("C-1's outcome is unknown.") && text.includes("Its note is kept."),
			);
			await page.getByRole("button", { name: "Slot 1: C-1, missing", exact: true }).click();
			readable = true;
			await page.keyboard.press("p");
			const refused = await eventually(
				() => page.locator("#stat").innerText(),
				(text) => text.includes("C-1 was not recorded: The result needs a fresh request."),
			);
			expect(refused).toContain("Its note is kept.");
			expect(commands).toHaveLength(2);
			expect(commands[1]).toBe(commands[0]);
			expect((await server.api("timeline", { ref: "C-1" })).entries.filter((entry) => entry.t === "result")).toEqual(
				[],
			);
			expect(await page.getByRole("textbox", { name: "Result note" }).inputValue()).toBe("wrong total");
			await page.keyboard.press("p");
			await eventually(
				() => page.locator("#stat").innerText(),
				(text) => text.includes("C-1 pass recorded"),
			);
			expect(commands).toHaveLength(3);
			expect(commands[2]).not.toBe(commands[0]);
			const slots = Slot.array().parse((await server.api("find", { in: "slots", run: plan.run })).items);
			expect(slots[0]).toMatchObject({ case: "C-1", fills: [{ outcome: "pass", note: "wrong total" }] });
			expect(
				(await server.api("timeline", { ref: "C-1" })).entries.filter((entry) => entry.t === "result"),
			).toHaveLength(1);
		} finally {
			await browser?.close();
			await server.stop();
		}
	},
	30_000,
);

for (const first of ["fail", "pass"]) {
	test.skipIf(!browserAvailable)(
		`a late ${first} result failure keeps the next slot's note, cursor and caret`,
		async () => {
			const server = await startServer();
			let browser: Awaited<ReturnType<typeof openPage>> | null = null;
			let release = () => {};
			const held = new Promise<void>((resolve) => {
				release = resolve;
			});
			try {
				await server.api("propose", {
					edits: [1, 2, 3].map((n) => ({ op: "create", outline: `Run case ${n}\n  Open the page > Ready` })),
				});
				const plan = await server.api("plan", { name: "Late refusal", select: {} });
				browser = await openPage(server, { path: `/p/scratch/runs/${plan.run.slice(2)}` });
				const { page } = browser;
				page.setDefaultTimeout(5000);
				await page.waitForSelector('[data-run-document="C-1"][data-active="true"][data-ready="true"]');
				let requests = 0;
				await browser.context.route("**/api/p/scratch/report", async (route) => {
					if (++requests === 1) {
						await held;
						await route.fulfill({
							json: { ok: false, error: { code: "conflict", message: "First result was not recorded" } },
						});
					} else await route.continue();
				});
				if (first === "fail") {
					await page.keyboard.press("f");
					await page.keyboard.type("First note");
					await page.keyboard.press("Enter");
				} else await page.keyboard.press("p");
				await page.waitForSelector('[data-run-document="C-2"][data-active="true"][data-ready="true"]');
				await page.keyboard.press("f");
				await page.keyboard.type("Second note typ");
				const note = page.getByRole("textbox", { name: "Result note" });
				await eventually(
					async () => requests,
					(count) => count === 1,
				);
				release();
				await page.waitForFunction(() => document.querySelector("#stat")?.textContent?.includes("not recorded"));
				await page.getByRole("button", { name: "Slot 1: C-1, missing", exact: true }).waitFor();
				expect(await page.locator("#stat").innerText()).toContain("C-1 was not recorded");
				expect(await page.locator('[data-active="true"]').getAttribute("data-run-document")).toBe("C-2");
				expect(await note.inputValue()).toBe("Second note typ");
				expect(
					await note.evaluate((node) =>
						node instanceof HTMLInputElement
							? { focused: node === document.activeElement, start: node.selectionStart, end: node.selectionEnd }
							: null,
					),
				).toEqual({ focused: true, start: 15, end: 15 });
				await page.keyboard.type("ed at a walk");
				await page.keyboard.press("Enter");
				const slots = await eventually(
					async () => Slot.array().parse((await server.api("find", { in: "slots", run: plan.run })).items),
					(slots) => slots[1]?.fills[0]?.outcome === "fail",
				);
				expect(slots[0]).toMatchObject({ state: "missing", fills: [] });
				expect(slots[1]?.fills[0]?.note).toBe("Second note typed at a walk");
				await page.locator(`[data-slot="${slots[0]?.id}"]`).click();
				expect(await note.inputValue()).toBe(first === "fail" ? "First note" : "");
				expect(await page.locator("#stat").innerText()).toContain("C-2 fail recorded");
				expect(browser.errors).toEqual([]);
			} finally {
				release();
				await browser?.close();
				await server.stop();
			}
		},
		30_000,
	);
}

for (const field of ["title", "step"]) {
	test.skipIf(!browserAvailable)(
		`an idle new case keeps its ${field} editor and caret while sealing`,
		async () => {
			const server = await startServer();
			if (field === "step") await server.api("propose", { edits: [{ op: "folder", name: "Accounts" }] });
			const browser = await openPage(server, {
				path: field === "step" ? "/p/scratch/suite?folder=Accounts" : "/p/scratch/suite",
			});
			try {
				const { page } = browser;
				page.setDefaultTimeout(5000);
				await page.clock.install();
				await page.keyboard.press("c");
				await page.keyboard.type("Idle capture");
				if (field === "step") {
					await page.keyboard.press("Enter");
					await page.keyboard.type("Step before the pause");
				}
				const input = page.getByRole("textbox", { name: field === "title" ? "Case title" : "Step 1", exact: true });
				const text = await input.inputValue();
				await page.keyboard.press("ArrowLeft");
				await input.evaluate((node) => Reflect.set(window, "typingField", node));
				await page.clock.fastForward(30_000);
				await page.waitForFunction(() => document.querySelector(".cstate .chip")?.textContent === "v1");
				expect(await input.count()).toBe(1);
				expect(
					await input.evaluate((node) =>
						node instanceof HTMLTextAreaElement
							? {
									focused: document.activeElement === node,
									sameNode: Reflect.get(window, "typingField") === node,
									start: node.selectionStart,
									end: node.selectionEnd,
								}
							: null,
					),
				).toEqual({ focused: true, sameNode: true, start: text.length - 1, end: text.length - 1 });
				await page.keyboard.type(" continued");
				await page.keyboard.press("Escape");
				const rows = await eventually(
					() => server.api("get", { refs: ["C-1"] }),
					(rows) => rows[0]?.version === 2,
				);
				const continued = `${text.slice(0, -1)} continued${text.slice(-1)}`;
				if (field === "title") expect(rows[0]?.title).toBe(continued);
				else expect(rows[0]?.steps).toMatchObject([{ action: continued }]);
				expect((await server.api("find", { in: "cases" })).count).toBe(1);
				expect(browser.errors).toEqual([]);
			} finally {
				await browser.close();
				await server.stop();
			}
		},
		30_000,
	);
}

test.skipIf(!browserAvailable)(
	"reload offers every unsaved new case and each can be sent once",
	async () => {
		const server = await startServer();
		const browser = await openPage(server);
		try {
			const { page } = browser;
			page.setDefaultTimeout(5000);
			await browser.context.route("**/api/p/scratch/propose", (route) =>
				route.fulfill({ json: { ok: false, error: { code: "internal", message: "Capture unavailable" } } }),
			);
			for (const ordinal of ["First", "Second"]) {
				await page.keyboard.press("c");
				await page.keyboard.type(`${ordinal} unsaved case`);
				await page.keyboard.press("Enter");
				await page.keyboard.type(`${ordinal} unsaved step`);
				await page.keyboard.press("Escape");
				await page.waitForFunction(() => document.querySelector("#stat")?.textContent?.includes("Capture unavailable"));
			}
			await page.reload();
			await page.locator("#app").waitFor();
			const rows = page.locator('[data-testid="case-list"]').getByRole("option");
			expect(await rows.filter({ hasText: "First unsaved case" }).count()).toBe(1);
			// The browser may deliver the active draft's keepalive request during reload, before its acknowledgement.
			expect(await rows.filter({ hasText: "Second unsaved case" }).count()).toBeGreaterThan(0);
			await browser.context.unroute("**/api/p/scratch/propose");
			// A save that went out as the page reloaded has no reply. The page asks what became of a capture's save
			// when the capture is in the pane (issue #71): one the server recorded is a case, and is not sent again.
			const settled = (title: string) =>
				eventually(
					() =>
						page.evaluate(
							(title) =>
								Object.keys(localStorage)
									.filter((key) => key.includes(":draft:") && !key.includes(":steps:"))
									.map((key) => JSON.parse(localStorage.getItem(key) ?? "{}"))
									.every((draft) => draft.body?.title !== title || !draft.sent),
							title,
						),
					Boolean,
				);
			for (const ordinal of ["First", "Second"]) {
				// The capture's own row, not a case its save made.
				const capture = rows.filter({ hasText: `${ordinal} unsaved case` }).filter({ hasText: /^new/ });
				if ((await capture.count()) === 0) continue;
				await capture.first().click();
				await settled(`${ordinal} unsaved case`);
				if ((await page.locator("#detail .cid").innerText()) !== "New case") continue;
				expect(await page.locator("#detail .cid").innerText()).toBe("New case");
				expect(new URL(page.url()).pathname).toBe("/p/scratch/suite");
				expect(await page.locator('#list [role="option"][aria-selected="true"]').count()).toBe(1);
				expect(await page.getByRole("textbox", { name: "Step 1", exact: true }).inputValue()).toBe(
					`${ordinal} unsaved step`,
				);
				await page.keyboard.press("Control+Enter");
				await page.waitForFunction(() => document.querySelector(".cstate .chip")?.textContent === "v1");
			}
			const cases = await eventually(
				() => server.api("find", { in: "cases" }),
				(reply) => reply.count === 2,
			);
			expect(cases.items.map((row) => row.title).sort()).toEqual(["First unsaved case", "Second unsaved case"]);
			const refs = z
				.array(z.object({ ref: z.string() }))
				.parse(cases.items)
				.map((row) => row.ref);
			expect((await server.api("get", { refs })).every((row) => row.version === 1)).toBe(true);
			await page.reload();
			await rows.first().waitFor();
			expect(await rows.count()).toBe(2);
			expect(await page.locator("#list .dr").count()).toBe(0);
			expect(browser.errors).toEqual([]);
		} finally {
			await browser.close();
			await server.stop();
		}
	},
	30_000,
);

test.skipIf(!browserAvailable)(
	"case selection and sealed capture keep the folder and tags through reload and history",
	async () => {
		const server = await startServer();
		await server.api("propose", {
			edits: [
				{ op: "create", outline: "First account", folder: "Accounts", tags: ["smoke", "fast"] },
				{ op: "create", outline: "Second account", folder: "Accounts", tags: ["smoke", "fast"] },
				{ op: "create", outline: "Other tag", folder: "Accounts", tags: ["slow"] },
				{ op: "create", outline: "Other folder", folder: "Checkout", tags: ["smoke", "fast"] },
			],
		});
		const browser = await openPage(server, { path: "/p/scratch/suite?folder=Accounts&tag=smoke&tag=fast" });
		try {
			const { page } = browser;
			page.setDefaultTimeout(5000);
			const selection = () => page.locator('#list [role="option"][aria-selected="true"] .id').textContent();
			const checkContext = async (count = 2) => {
				const url = new URL(page.url());
				expect(url.searchParams.get("folder")).toBe("Accounts");
				expect(url.searchParams.getAll("tag")).toEqual(["smoke", "fast"]);
				expect(await page.locator("#ltitle").innerText()).toBe("Accounts");
				await page.waitForFunction(
					(count) => document.querySelector("#lcount")?.textContent === `${count} cases`,
					count,
				);
				expect(await page.locator("#list").innerText()).not.toContain("Other");
			};
			await page.getByRole("option").filter({ hasText: "First account" }).waitFor();
			await page.keyboard.press("j");
			await page.waitForURL("**/suite/c/2*");
			await checkContext();
			expect(await selection()).toBe("C-2");
			await page.keyboard.press("k");
			await page.waitForURL("**/suite/c/1*");
			await checkContext();
			await page.getByRole("option").filter({ hasText: "Second account" }).click();
			await page.waitForURL("**/suite/c/2*");
			await checkContext();
			await page.reload();
			await page.getByRole("option").filter({ hasText: "Second account" }).waitFor();
			await checkContext();
			expect(await selection()).toBe("C-2");
			await page.goBack();
			await page.waitForURL("**/suite/c/1*");
			await checkContext();
			expect(await selection()).toBe("C-1");
			await page.goForward();
			await page.waitForURL("**/suite/c/2*");
			await checkContext();
			expect(await selection()).toBe("C-2");
			await page.keyboard.press("c");
			await page.keyboard.type("Captured account");
			await page.keyboard.press("Escape");
			await page.waitForURL("**/suite/c/5*");
			await checkContext(3);
			expect((await server.api("get", { refs: ["C-5"] }))[0]?.tags).toEqual(["fast", "smoke"]);
			expect(browser.errors).toEqual([]);
		} finally {
			await browser.close();
			await server.stop();
		}
	},
	30_000,
);

test.skipIf(!browserAvailable)(
	"typing a menu path in a step keeps its existing expected result",
	async () => {
		const server = await startServer();
		await server.api("propose", {
			edits: [
				{
					op: "create",
					body: {
						title: "Menu case",
						steps: [{ id: "aa", action: "Open billing", expected: "The invoice list is shown" }],
					},
				},
			],
		});
		const browser = await openPage(server, { path: "/p/scratch/suite/c/1" });
		try {
			const { page } = browser;
			page.setDefaultTimeout(5000);
			await page.getByRole("button", { name: "Open billing", exact: true }).click();
			await page.keyboard.press("End");
			await page.keyboard.type(" from Settings > Billing");
			expect(await page.getByRole("textbox", { name: "Step 1", exact: true }).inputValue()).toBe(
				"Open billing from Settings > Billing",
			);
			expect(await page.getByRole("textbox", { name: "Expected result 1", exact: true }).inputValue()).toBe(
				"The invoice list is shown",
			);
			await page.keyboard.press("Escape");
			const rows = await eventually(
				() => server.api("get", { refs: ["C-1"] }),
				(rows) => rows[0]?.version === 2,
			);
			expect(rows[0]?.steps).toMatchObject([
				{ id: "aa", action: "Open billing from Settings > Billing", expected: "The invoice list is shown" },
			]);
			expect(browser.errors).toEqual([]);
		} finally {
			await browser.close();
			await server.stop();
		}
	},
	30_000,
);

for (const preset of ["strict", "standard"]) {
	test.skipIf(!browserAvailable)(
		`a queue ${preset === "strict" ? "reason" : "defect reference"} survives a failed answer and reload`,
		async () => {
			const server = await startServer({ preset });
			let browser: Awaited<ReturnType<typeof openPage>> | null = null;
			try {
				await server.api("propose", { edits: [{ op: "create", outline: "Triage case\n  Open page > Ready" }] });
				const pipeline = z.object({ token: z.string() }).parse(
					await server.api("admin", {
						do: "token.create",
						actor: "pipeline",
						kind: "ci",
						can: ["read", "record"],
						project: "scratch",
					}),
				).token;
				await server.api(
					"report",
					{
						target: { commit: "queue123", branch: "main" },
						results: [
							{
								test: { key: "page::opens", file: "page.ts", name: "opens" },
								annotation: { case: "C-1", version: 1 },
								outcome: "fail",
								failure: { message: "expected ready, got loading" },
							},
						],
					},
					{ token: pipeline },
				);
				const question = (await server.api("inbox", { kind: "failure" })).items[0];
				if (!question) throw new Error("Failure question missing");
				browser = await openPage(server, { path: `/p/scratch/queue/${question.q.slice(2)}` });
				const { page } = browser;
				page.setDefaultTimeout(5000);
				await page.locator(`[data-current-question="${question.q}"]`).waitFor();
				const key = preset === "strict" ? "f" : "d";
				const text = preset === "strict" ? "Known flaky on the staging runner, see BUG-77" : "BUG-1234";
				await page.keyboard.press(key);
				const input = page.locator("#answer-extra");
				await input.fill(text);
				await browser.context.route("**/api/p/scratch/decide", (route) =>
					route.fulfill({ json: { ok: false, error: { code: "internal", message: "Answer unavailable" } } }),
				);
				await page.keyboard.press("Enter");
				await page.waitForFunction(() => document.querySelector("#stat")?.textContent?.includes("Answer unavailable"));
				await page.locator(`[data-question="${question.q}"]`).getByRole("option").click();
				await page.locator(`[data-current-question="${question.q}"]`).waitFor();
				await page.keyboard.press(key);
				expect(await input.inputValue()).toBe(text);
				await input.fill(`${text} continued`);
				await page.reload();
				await page.locator(`[data-current-question="${question.q}"]`).waitFor();
				await page.keyboard.press(key);
				expect(await input.inputValue()).toBe(`${text} continued`);
				await browser.context.unroute("**/api/p/scratch/decide");
				await page.keyboard.press("Enter");
				const settled = await eventually(
					() => server.api("inbox", { state: "decided", kind: "failure" }),
					(reply) => reply.items.some((q) => q.q === question.q),
				);
				const decision = settled.items.find((q) => q.q === question.q)?.decision;
				if (preset === "strict") expect(decision?.reason).toBe(`${text} continued`);
				else expect(decision?.answer.ref).toBe(`${text} continued`);
				await page.waitForFunction(() => document.querySelector(".queue-last")?.textContent?.includes("· recorded"));
				await page.locator("#answer-extra").waitFor({ state: "detached" });
				await page.keyboard.press("u");
				if (preset === "strict") {
					await input.fill("Read the newer evidence and withdraw the earlier answer");
					await page.keyboard.press("Enter");
					await eventually(
						() => server.api("get", { refs: [question.q] }),
						(rows) => rows[0]?.state === "open",
					);
					await input.waitFor({ state: "detached" });
				}
				await page.locator(`[data-current-question="${question.q}"]`).waitFor();
				await page.keyboard.press(key);
				expect(await input.inputValue()).toBe("");
				expect(browser.errors).toEqual([]);
			} finally {
				await browser?.close();
				await server.stop();
			}
		},
		30_000,
	);
}

for (const editing of [false, true]) {
	test.skipIf(!browserAvailable)(
		`a proposal arriving on an open case appears ${editing ? "without disturbing its draft" : "without navigation"}`,
		async () => {
			const server = await startServer({ preset: "standard" });
			let browser: Awaited<ReturnType<typeof openPage>> | null = null;
			try {
				await server.api("propose", {
					edits: [{ op: "create", outline: "Coupon case\n  Apply coupon > Total changes" }],
				});
				const writer = z.object({ token: z.string() }).parse(
					await server.api("admin", {
						do: "token.create",
						actor: "reviewer",
						kind: "agent",
						can: ["read", "produce"],
						project: "scratch",
					}),
				).token;
				browser = await openPage(server, { path: "/p/scratch/suite/c/1" });
				const { page } = browser;
				page.setDefaultTimeout(5000);
				await page.locator('[data-version="1"]').waitFor();
				if (editing) {
					await page.keyboard.press("e");
					await page.keyboard.type(" unfinished");
				}
				const proposed = await server.api(
					"propose",
					{ edits: [{ op: "edit", case: "C-1", base: 1, body: { pre: "Use an account with a coupon" } }] },
					{ token: writer },
				);
				await page.locator('#nav a[aria-label="Queue"] em').filter({ hasText: "1" }).waitFor();
				const card = page.locator(`[data-proposal="${proposed.question}"]`);
				await card.waitFor({ state: "attached" });
				if (editing) {
					const title = page.getByRole("textbox", { name: "Case title", exact: true });
					expect(await title.inputValue()).toBe("Coupon case unfinished");
					expect(await title.evaluate((node) => document.activeElement === node)).toBe(true);
				} else {
					await card.scrollIntoViewIfNeeded();
					await page.keyboard.press("a");
					const rows = await eventually(
						() => server.api("get", { refs: ["C-1"] }),
						(rows) => rows[0]?.version === 2,
					);
					expect(rows[0]?.pre).toBe("Use an account with a coupon");
				}
				expect(browser.loads()).toBe(1);
				expect(browser.errors).toEqual([]);
			} finally {
				await browser?.close();
				await server.stop();
			}
		},
		30_000,
	);
}

test.skipIf(!browserAvailable)(
	"Back then Forward restores an unfinished new case without reloading",
	async () => {
		const server = await startServer();
		await server.api("propose", { edits: [{ op: "create", outline: "Existing\n  Keep original" }] });
		const browser = await openPage(server, { path: "/p/scratch/suite/c/1" });
		try {
			const { page } = browser;
			page.setDefaultTimeout(5000);
			await page.getByRole("button", { name: "Existing", exact: true }).waitFor();
			await page.keyboard.press("c");
			await page.keyboard.type("Back navigation draft");
			await page.keyboard.press("Enter");
			await page.keyboard.type("Back navigation step");
			await page.goBack();
			await page.getByRole("button", { name: "Existing", exact: true }).waitFor();
			await page.goForward();
			await page.waitForURL("**/p/scratch/suite");
			expect(await page.getByRole("option").filter({ hasText: "Back navigation draft" }).count()).toBe(1);
			expect(await page.getByRole("textbox", { name: "Step 1", exact: true }).inputValue()).toBe(
				"Back navigation step",
			);
			await page.keyboard.type(" continued");
			await page.keyboard.press("Escape");
			await eventually(
				() => server.api("find", { in: "cases" }),
				(rows) => rows.items.some((row) => row.ref === "C-2"),
			);
			const rows = await server.api("get", { refs: ["C-2"] });
			expect(rows[0]?.steps).toMatchObject([{ action: "Back navigation step continued" }]);
			expect((await server.api("get", { refs: ["C-1"] }))[0]).toMatchObject({ title: "Existing", version: 1 });
			expect(browser.loads()).toBe(1);
			expect(browser.errors).toEqual([]);
		} finally {
			await browser.close();
			await server.stop();
		}
	},
	30_000,
);

test.skipIf(!browserAvailable)(
	"rapid trusted navigation settles warmed case state",
	async () => {
		const server = await startServer({ cases: 2, days: 0 });
		let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined;
		let harness: Awaited<ReturnType<typeof openPage>> | undefined;
		try {
			browser = await launchBrowser();
			harness = await openPage(server, { browser });
			const { page, context } = harness;
			await page.waitForFunction(
				() => Number(document.querySelector('[data-testid="case-list"]')?.getAttribute("data-loaded")) === 2,
			);
			await page.keyboard.press("j");
			await page.waitForFunction(() => document.querySelector("#detail .cid")?.textContent === "C-2");
			await page.keyboard.press("k");
			await page.waitForFunction(() => document.querySelector("#detail .cid")?.textContent === "C-1");
			const cdp = await context.newCDPSession(page);
			const sent: Promise<unknown>[] = [];
			for (let index = 0; index < 128; index++) {
				const key = index % 2 ? "k" : "j";
				const code = key === "j" ? "KeyJ" : "KeyK";
				const virtualKeyCode = key === "j" ? 74 : 75;
				for (const type of ["keyDown", "keyUp"] as const) {
					sent.push(
						cdp.send("Input.dispatchKeyEvent", {
							type,
							key,
							code,
							windowsVirtualKeyCode: virtualKeyCode,
							nativeVirtualKeyCode: virtualKeyCode,
						}),
					);
				}
			}
			await Promise.all(sent);
			await page.evaluate(
				() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
			);
			expect(harness.errors).toEqual([]);
			expect(await page.locator('#list [role="option"][aria-selected="true"] .id').textContent()).toBe("C-1");
			expect(await page.locator("#detail .cid").textContent()).toBe("C-1");
			await cdp.detach();
		} finally {
			await harness?.close();
			await browser?.close();
			await server.stop();
		}
	},
	30_000,
);
