import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start } from "../../src/app/start.ts";
import type { Api, OpName } from "../../src/core/api.ts";
import { defaultConfig } from "../../src/server/kernel/app.ts";
import { removeProject } from "../../src/server/transfer/transfer.ts";
import ui from "../../src/web/index.html";
import { call } from "../../src/web/lib/api.ts";
import { Run, Slot } from "../../src/web/runs/models.ts";
import {
	browserAvailable,
	devicePrefix,
	eventually,
	openPage,
	reservePort,
	type Server,
	startServer,
} from "./support.ts";

const check = browserAvailable ? test : test.skip;

for (const failure of ["lost reply", "repeated lost replies", "unreadable reply", "invalid JSON", "not sent"])
	check(
		`retrying a plan preserves its command after ${failure}`,
		async () => {
			const server = await startServer();
			let view: Awaited<ReturnType<typeof openPage>> | null = null;
			try {
				await server.api("propose", {
					edits: [
						{ op: "create", folder: "checkout", outline: "Checkout opens\n  Open checkout > Ready" },
						{ op: "create", folder: "checkout", outline: "Coupon applies\n  Apply coupon > Discount" },
						{ op: "create", folder: "settings", outline: "Settings opens\n  Open settings > Ready" },
					],
				});
				view = await openPage(server, { path: "/p/scratch/runs" });
				const { page } = view;
				const sent: Api["plan"]["input"][] = [];
				const losses = failure === "repeated lost replies" ? 2 : 1;
				await page.route("**/plan", async (route) => {
					sent.push(route.request().postDataJSON());
					if (sent.length > losses) return route.continue();
					if (failure === "not sent") return route.abort();
					const response = await route.fetch();
					expect(response.ok()).toBe(true);
					if (failure === "lost reply" || failure === "repeated lost replies") await route.abort();
					else
						await route.fulfill({
							status: 200,
							contentType: "application/json",
							body: failure === "invalid JSON" ? "{" : JSON.stringify({ ok: true, result: { run: "R-1" } }),
						});
				});
				await page.keyboard.press("n");
				await page.getByLabel("Run name").fill("Retry smoke");
				await page.getByLabel("Cases", { exact: true }).selectOption("folder");
				await page.getByLabel("Folder", { exact: true }).selectOption("checkout");
				await page.getByRole("radio", { name: "Accept results for a commit" }).check();
				await page.getByLabel("Commit", { exact: true }).fill("a".repeat(40));
				const submit = page.locator('.run-planner button[type="submit"]');
				await submit.click();
				await eventually(
					() => submit.isEnabled(),
					(enabled) => enabled && sent.length === 1,
				);
				expect((await server.api("find", { in: "runs", origin: "planned" })).items).toHaveLength(
					failure === "not sent" ? 0 : 1,
				);
				expect(await page.getByLabel("Run name").isEditable()).toBe(false);
				expect(await page.getByLabel("Cases", { exact: true }).isDisabled()).toBe(true);
				expect(await page.getByLabel("Folder", { exact: true }).isDisabled()).toBe(true);
				expect(await page.getByLabel("Commit", { exact: true }).isEditable()).toBe(false);
				for (const field of await page.locator(".run-planner .form-input").all())
					expect(await field.evaluate((element) => getComputedStyle(element).opacity)).toBe("0.7");
				for (const radio of await page.getByRole("radio").all()) expect(await radio.isDisabled()).toBe(true);
				expect(await page.getByRole("button", { name: "Enter Retry plan", exact: true }).isEnabled()).toBe(true);
				expect(await page.locator("#stat").textContent()).toBe(
					"The run's outcome is unknown. Retry plan sends the same request; your submitted choices are kept.",
				);
				if (losses === 2) {
					await submit.click();
					await eventually(
						() => submit.isEnabled(),
						(enabled) => enabled && sent.length === 2,
					);
				}
				await submit.click();
				await page.waitForURL(/\/runs\/\d+$/);
				const runs = Run.array().parse((await server.api("find", { in: "runs", origin: "planned" })).items);
				expect(runs.map(({ ref, name, slots }) => ({ ref, name, slots }))).toEqual([
					{ ref: "R-1", name: "Retry smoke", slots: 2 },
				]);
				expect(sent).toHaveLength(losses + 1);
				const original = sent[0];
				if (!original) throw new Error("No plan was submitted");
				for (const input of sent) expect(input).toEqual(original);
				expect(
					Slot.array()
						.parse((await server.api("find", { in: "slots", run: "R-1" })).items)
						.map((slot) => slot.case),
				).toEqual(["C-1", "C-2"]);
				expect(view.errors).toEqual(
					failure === "lost reply" || failure === "not sent" || failure === "repeated lost replies"
						? Array.from({ length: losses }, () => "Failed to load resource: net::ERR_FAILED")
						: [],
				);
			} finally {
				await view?.close();
				await server.stop();
			}
		},
		30000,
	);

check(
	"a refused plan can be corrected and submitted as a new command",
	async () => {
		const server = await startServer();
		let view: Awaited<ReturnType<typeof openPage>> | null = null;
		try {
			await server.api("propose", { edits: [{ op: "create", outline: "Checkout opens\n  Open checkout > Ready" }] });
			view = await openPage(server, { path: "/p/scratch/runs" });
			const { page } = view;
			const sent: Api["plan"]["input"][] = [];
			page.on("request", (request) => {
				if (request.url().endsWith("/plan")) sent.push(request.postDataJSON());
			});
			await page.keyboard.press("n");
			await page.getByLabel("Run name").fill("Corrected plan");
			await page.getByLabel("Cases", { exact: true }).selectOption("text");
			await page.getByLabel("Search cases", { exact: true }).fill("No matching case");
			const submit = page.locator('.run-planner button[type="submit"]');
			const refused = page.waitForResponse((response) => response.url().endsWith("/plan"));
			await submit.click();
			expect((await refused).status()).toBe(400);
			await eventually(
				() => submit.isEnabled(),
				(enabled) => enabled,
			);
			await page.getByLabel("Search cases", { exact: true }).fill("Checkout");
			await submit.click();
			await page.waitForURL("**/runs/1");
			expect(Run.array().parse((await server.api("find", { in: "runs", origin: "planned" })).items)).toMatchObject([
				{ ref: "R-1", name: "Corrected plan", slots: 1 },
			]);
			expect(sent).toHaveLength(2);
			expect(sent[1]?.cmd).not.toBe(sent[0]?.cmd);
		} finally {
			await view?.close();
			await server.stop();
		}
	},
	30000,
);

for (const control of ["name", "radio", "submit"])
	check(
		`a lost plan reply keeps Enter and Escape working after submitting from ${control}`,
		async () => {
			const server = await startServer();
			let view: Awaited<ReturnType<typeof openPage>> | null = null;
			try {
				await server.api("propose", { edits: [{ op: "create", outline: "Checkout opens\n  Open checkout > Ready" }] });
				view = await openPage(server, { path: "/p/scratch/runs" });
				const { page } = view;
				const sent: Api["plan"]["input"][] = [];
				await page.route("**/plan", async (route) => {
					sent.push(route.request().postDataJSON());
					const response = await route.fetch();
					expect(response.ok()).toBe(true);
					await route.abort();
				});
				await page.keyboard.press("n");
				await page.getByLabel("Run name").waitFor();
				await page.keyboard.type("Keyboard plan");
				if (control !== "name") {
					await page.keyboard.press("Tab");
					await page.keyboard.press("Tab");
					if (control === "submit") await page.keyboard.press("Tab");
				}
				expect(
					await page.evaluate(() => {
						const focused = document.activeElement;
						return focused instanceof HTMLInputElement ? focused.type : focused?.tagName.toLowerCase();
					}),
				).toBe(control === "name" ? "text" : control === "radio" ? "radio" : "button");
				await page.keyboard.press("Enter");
				await page.getByRole("button", { name: "Enter Retry plan", exact: true }).waitFor();
				expect(await page.locator(".run-planner :focus").count()).toBe(1);
				await page.keyboard.press("Enter");
				await eventually(
					async () => [sent.length, await page.getByRole("button", { name: "Enter Retry plan", exact: true }).count()],
					([requests, retries]) => requests === 2 && retries === 1,
				);
				expect(sent).toHaveLength(2);
				expect(sent[1]).toEqual(sent[0]);
				expect(
					Run.array()
						.parse((await server.api("find", { in: "runs", origin: "planned" })).items)
						.map(({ ref, name, slots }) => ({ ref, name, slots })),
				).toEqual([{ ref: "R-1", name: "Keyboard plan", slots: 1 }]);
				await page.keyboard.press("Escape");
				await page.locator(".run-planner").waitFor({ state: "detached" });
				expect(await page.getByRole("listbox", { name: "Runs", exact: true }).count()).toBe(1);
			} finally {
				await view?.close();
				await server.stop();
			}
		},
		30000,
	);

for (const leaving of ["Cancel", "Escape", "another screen", "another project", "reload"])
	check(
		`reopening the planner after ${leaving} retries one uncertain plan`,
		async () => {
			const server = await startServer();
			let view: Awaited<ReturnType<typeof openPage>> | null = null;
			try {
				await server.api("propose", { edits: [{ op: "create", outline: "Checkout opens\n  Open checkout > Ready" }] });
				view = await openPage(server, { path: "/p/scratch/runs" });
				const { page } = view;
				await page.setViewportSize({ width: 1280, height: 800 });
				const sent: Api["plan"]["input"][] = [];
				await page.route("**/plan", async (route) => {
					sent.push(route.request().postDataJSON());
					if (sent.length > 1) return route.continue();
					const response = await route.fetch();
					expect(response.ok()).toBe(true);
					await route.abort();
				});
				await page.keyboard.press("n");
				await page.getByLabel("Run name").fill("Recovered plan");
				await page.getByLabel("Cases", { exact: true }).selectOption("text");
				await page.getByLabel("Search cases", { exact: true }).fill("Checkout");
				await page.getByRole("radio", { name: "Accept results for a commit" }).check();
				await page.getByLabel("Commit", { exact: true }).fill("a".repeat(40));
				await page.locator('.run-planner button[type="submit"]').click();
				await page.getByRole("button", { name: "Enter Retry plan", exact: true }).waitFor();
				expect((await server.api("find", { in: "runs", origin: "planned" })).items).toHaveLength(1);
				if (leaving === "another project") {
					await server.api("admin", { do: "project.create", key: "other", preset: "loose" });
					await page.goto(`${server.url}/p/other/runs`);
					await page.getByRole("listbox", { name: "Runs", exact: true }).waitFor();
					await page.keyboard.press("n");
					expect(await page.getByLabel("Run name").inputValue()).toBe("");
					await page.goto(`${server.url}/p/scratch/runs`);
				} else if (leaving === "Cancel") await page.getByRole("button", { name: "Cancel Esc", exact: true }).click();
				else if (leaving === "Escape") await page.keyboard.press("Escape");
				else if (leaving === "another screen") {
					await page.keyboard.press("g");
					await page.keyboard.press("s");
					await page.waitForURL("**/suite");
					await page.keyboard.press("g");
					await page.keyboard.press("r");
				} else await page.reload();
				await page.locator(".run-planner").waitFor({ state: "detached" });
				await page.getByRole("listbox", { name: "Runs", exact: true }).waitFor();
				await page.keyboard.press("n");
				await page.getByLabel("Run name").waitFor();
				if (leaving === "Cancel" && process.env.MAINWORTHY_PLANNER_SCREENSHOT)
					await page.screenshot({ path: process.env.MAINWORTHY_PLANNER_SCREENSHOT });
				const reopened = {
					name: await page.getByLabel("Run name").inputValue(),
					selection: await page.getByLabel("Cases", { exact: true }).inputValue(),
					retry: await page.getByRole("button", { name: "Enter Retry plan", exact: true }).count(),
					editable: await page.getByLabel("Run name").isEditable(),
				};
				if (reopened.editable) {
					await page.getByLabel("Run name").fill("Recovered plan");
					await page.getByLabel("Cases", { exact: true }).selectOption("text");
					await page.getByLabel("Search cases", { exact: true }).fill("Checkout");
					await page.getByRole("radio", { name: "Accept results for a commit" }).check();
					await page.getByLabel("Commit", { exact: true }).fill("a".repeat(40));
				}
				await page.locator('.run-planner button[type="submit"]').click();
				await page.waitForURL(/\/runs\/\d+$/);
				expect((await server.api("find", { in: "runs", origin: "planned" })).items).toHaveLength(1);
				expect(sent).toHaveLength(2);
				expect(sent[1]).toEqual(sent[0]);
				expect(reopened).toEqual({ name: "Recovered plan", selection: "text", retry: 1, editable: false });
				await page.goto(`${server.url}/p/scratch/runs`);
				await page.getByRole("listbox", { name: "Runs", exact: true }).waitFor();
				await page.keyboard.press("n");
				expect(await page.getByLabel("Run name").inputValue()).toBe("");
			} finally {
				await view?.close();
				await server.stop();
			}
		},
		30000,
	);

check(
	"two synchronous clicks send one plan command",
	async () => {
		const server = await startServer();
		let view: Awaited<ReturnType<typeof openPage>> | null = null;
		try {
			await server.api("propose", { edits: [{ op: "create", outline: "Checkout opens\n  Open checkout > Ready" }] });
			view = await openPage(server, { path: "/p/scratch/runs" });
			const { page } = view;
			const sent: Api["plan"]["input"][] = [];
			page.on("request", (request) => {
				if (request.url().endsWith("/plan")) sent.push(request.postDataJSON());
			});
			await page.keyboard.press("n");
			await page.getByLabel("Run name").fill("One planning action");
			await page.locator('.run-planner button[type="submit"]').evaluate((button) => {
				if (!(button instanceof HTMLButtonElement)) throw new Error("Not a button");
				button.click();
				button.click();
			});
			await page.waitForURL(/\/runs\/\d+$/);
			expect((await server.api("find", { in: "runs", origin: "planned" })).items).toHaveLength(1);
			expect(sent).toHaveLength(1);
		} finally {
			await view?.close();
			await server.stop();
		}
	},
	30000,
);

check(
	"a planner closed while sending keeps its command before the reply is lost",
	async () => {
		const server = await startServer();
		let view: Awaited<ReturnType<typeof openPage>> | null = null;
		const arrived = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		try {
			await server.api("propose", { edits: [{ op: "create", outline: "Checkout opens\n  Open checkout > Ready" }] });
			view = await openPage(server, { path: "/p/scratch/runs" });
			const { page } = view;
			const sent: Api["plan"]["input"][] = [];
			await page.route("**/plan", async (route) => {
				sent.push(route.request().postDataJSON());
				if (sent.length > 1) return route.continue();
				const response = await route.fetch();
				expect(response.ok()).toBe(true);
				arrived.resolve();
				await released.promise;
				await route.abort();
			});
			await page.keyboard.press("n");
			await page.getByLabel("Run name").fill("Still sending");
			await page.locator('.run-planner button[type="submit"]').click();
			await arrived.promise;
			await page.keyboard.press("Escape");
			await page.locator(".run-planner").waitFor({ state: "detached" });
			await page.keyboard.press("n");
			await page.getByRole("button", { name: "Enter Retry plan", exact: true }).waitFor();
			expect(await page.getByLabel("Run name").inputValue()).toBe("Still sending");
			expect(await page.getByLabel("Run name").isEditable()).toBe(false);
			released.resolve();
			await page.locator("#stat").filter({ hasText: "The run's outcome is unknown." }).waitFor();
			await page.locator('.run-planner button[type="submit"]').click();
			await page.waitForURL("**/runs/1");
			expect((await server.api("find", { in: "runs", origin: "planned" })).items).toHaveLength(1);
			expect(sent).toHaveLength(2);
			expect(sent[1]).toEqual(sent[0]);
		} finally {
			released.resolve();
			await view?.close();
			await server.stop();
		}
	},
	30000,
);

check(
	"a planner writes nothing until the browser can keep its command",
	async () => {
		const server = await startServer();
		let view: Awaited<ReturnType<typeof openPage>> | null = null;
		try {
			await server.api("propose", { edits: [{ op: "create", outline: "Checkout opens\n  Open checkout > Ready" }] });
			view = await openPage(server, { path: "/p/scratch/runs" });
			const { page } = view;
			const sent: Api["plan"]["input"][] = [];
			page.on("request", (request) => {
				if (request.url().endsWith("/plan")) sent.push(request.postDataJSON());
			});
			await page.evaluate(() => {
				const original = Storage.prototype.setItem;
				Storage.prototype.setItem = function (key, value) {
					if (key.includes(":run-plan:")) throw new DOMException("Storage full", "QuotaExceededError");
					original.call(this, key, value);
				};
			});
			await page.keyboard.press("n");
			await page.getByLabel("Run name").fill("Needs storage");
			await page.locator('.run-planner button[type="submit"]').click();
			await page.locator("#stat").filter({ hasText: "Enable device storage before planning a run." }).waitFor();
			expect((await server.api("find", { in: "runs", origin: "planned" })).items).toHaveLength(0);
			expect(sent).toHaveLength(0);
			await page.reload();
			await page.getByRole("listbox", { name: "Runs", exact: true }).waitFor();
			await page.keyboard.press("n");
			await page.getByLabel("Run name").fill("Needs storage");
			await page.locator('.run-planner button[type="submit"]').click();
			await page.waitForURL("**/runs/1");
			expect((await server.api("find", { in: "runs", origin: "planned" })).items).toHaveLength(1);
			expect(sent).toHaveLength(1);
		} finally {
			await view?.close();
			await server.stop();
		}
	},
	30000,
);

for (const failure of ["internal", "session change", "refused retry", "missing grant", "missing route", "limited"])
	check(
		`reopening a plan after ${failure} reuses its recorded command`,
		async () => {
			const server = await startServer({ mode: "server" });
			let view: Awaited<ReturnType<typeof openPage>> | null = null;
			try {
				await server.api("propose", { edits: [{ op: "create", outline: "Checkout opens\n  Open checkout > Ready" }] });
				view = await openPage(server, { path: "/p/scratch/runs" });
				const { page, context } = view;
				const other = failure === "session change" ? await context.newPage() : null;
				if (other) {
					await other.route("**/api/session", (route) =>
						route.fulfill({
							status: 401,
							json: { ok: false, error: { code: "unauthenticated", message: "Sign in" } },
						}),
					);
					await other.goto(`${server.url}/p/scratch/runs`);
					await other.locator("#token").waitFor();
					await other.unroute("**/api/session");
				}
				const sent: Api["plan"]["input"][] = [];
				const retryRefusal = failure !== "internal" && failure !== "session change";
				await page.route("**/plan", async (route) => {
					sent.push(route.request().postDataJSON());
					if (retryRefusal && sent.length === 2)
						return route.fulfill({
							status: failure === "limited" ? 429 : failure === "refused retry" ? 403 : 404,
							json: {
								ok: false,
								error:
									failure === "missing grant"
										? { code: "not_found", message: "no project named scratch, or no grant on it" }
										: failure === "missing route"
											? { code: "not_found", message: "no such route" }
											: failure === "limited"
												? { code: "limited", message: "Try later" }
												: { code: "forbidden", message: "Permission changed" },
							},
						});
					if (sent.length > 1) return route.continue();
					const response = await route.fetch();
					expect(response.ok()).toBe(true);
					if (other) {
						await other.locator("#token").fill(server.token);
						await other.keyboard.press("Enter");
						await other.locator("#app").waitFor();
						await route.fulfill({ response });
					} else if (retryRefusal) await route.abort();
					else
						await route.fulfill({
							status: 500,
							json: { ok: false, error: { code: "internal", message: "Plan interrupted" } },
						});
				});
				await page.bringToFront();
				await page.keyboard.press("n");
				await page.getByLabel("Run name").fill("Kept for its author");
				await page.locator('.run-planner button[type="submit"]').click();
				await page.getByRole("button", { name: "Enter Retry plan", exact: true }).waitFor();
				if (retryRefusal) {
					await page.getByRole("button", { name: "Enter Retry plan", exact: true }).click();
					await eventually(
						async () => [
							sent.length,
							await page.getByRole("button", { name: "Enter Retry plan", exact: true }).count(),
						],
						([requests, retries]) => requests === 2 && retries === 1,
					);
				}
				await page.reload();
				await page.getByRole("listbox", { name: "Runs", exact: true }).waitFor();
				await page.keyboard.press("n");
				await page.getByRole("button", { name: "Enter Retry plan", exact: true }).click();
				await page.waitForURL("**/runs/1");
				expect((await server.api("find", { in: "runs", origin: "planned" })).items).toHaveLength(1);
				expect(sent).toHaveLength(retryRefusal ? 3 : 2);
				const original = sent[0];
				if (!original) throw new Error("No plan was submitted");
				for (const input of sent) expect(input).toEqual(original);
			} finally {
				await view?.close();
				await server.stop();
			}
		},
		30000,
	);

for (const stored of [
	'{"name":"Old","select":{},"cmd":"legacy-plan-command"}',
	"{",
	'{"name":"Old","select":{}}',
	'{"name":"Old","select":{"text":5},"cmd":"x"}',
	"null",
	"[]",
])
	check(
		`an invalid saved plan ${stored} does not block planning`,
		async () => {
			const server = await startServer();
			const view = await openPage(server, { path: "/p/scratch/runs" });
			try {
				await server.api("propose", { edits: [{ op: "create", outline: "Checkout opens\n  Open checkout > Ready" }] });
				const { page } = view;
				const prefix = await devicePrefix(server, server.token);
				const key = `${prefix}run-plan:scratch`;
				await page.evaluate(([key, stored]) => localStorage.setItem(key ?? "", stored ?? ""), [key, stored]);
				await page.keyboard.press("n");
				await page.getByLabel("Run name").fill("Fresh plan");
				await page.locator('.run-planner button[type="submit"]').click();
				await eventually(
					async () => (await server.api("find", { in: "runs", origin: "planned" })).items.length,
					(count) => count === 1,
				);
				await page.waitForURL("**/runs/1");
				expect(Run.array().parse((await server.api("find", { in: "runs", origin: "planned" })).items)).toMatchObject([
					{ name: "Fresh plan", slots: 1 },
				]);
				expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBeNull();
			} finally {
				await view.close();
				await server.stop();
			}
		},
		30000,
	);

check(
	"a retry refused by the operation releases the plan for correction",
	async () => {
		const server = await startServer();
		const view = await openPage(server, { path: "/p/scratch/runs" });
		try {
			await server.api("propose", { edits: [{ op: "create", outline: "Zebra case\n  Open it > Ready" }] });
			const { page } = view;
			const sent: Api["plan"]["input"][] = [];
			await page.route("**/plan", (route) => {
				sent.push(route.request().postDataJSON());
				return sent.length === 1 ? route.abort() : route.continue();
			});
			await page.keyboard.press("n");
			await page.getByLabel("Run name").fill("Never recorded");
			await page.getByLabel("Cases", { exact: true }).selectOption("text");
			await page.getByLabel("Search cases", { exact: true }).fill("Zebra");
			await page.locator('.run-planner button[type="submit"]').click();
			await page.getByRole("button", { name: "Enter Retry plan", exact: true }).waitFor();
			await server.api("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Lion case" } }] });
			await page.getByRole("button", { name: "Enter Retry plan", exact: true }).click();
			await eventually(
				() => page.locator("#stat").textContent(),
				(text) => text === "the selection matches no active case",
			);
			expect(await page.getByLabel("Run name").isEditable()).toBe(true);
			expect(sent[1]).toEqual(sent[0]);
			await page.keyboard.press("Escape");
			await page.keyboard.press("n");
			await page.getByLabel("Run name").fill("Corrected plan");
			await page.locator('.run-planner button[type="submit"]').click();
			await page.waitForURL("**/runs/1");
			expect(sent[2]?.cmd).not.toBe(sent[0]?.cmd);
			expect(Run.array().parse((await server.api("find", { in: "runs", origin: "planned" })).items)).toMatchObject([
				{ name: "Corrected plan", slots: 1 },
			]);
		} finally {
			await view.close();
			await server.stop();
		}
	},
	30000,
);

check(
	"another tab's pending plan is shown before this tab sends it",
	async () => {
		const server = await startServer();
		const view = await openPage(server, { path: "/p/scratch/runs" });
		try {
			await server.api("propose", { edits: [{ op: "create", outline: "Checkout opens\n  Open checkout > Ready" }] });
			const { page, context } = view;
			await page.keyboard.press("n");
			await page.getByLabel("Run name").fill("Typed in the early tab");
			const other = await context.newPage();
			await other.goto(`${server.url}/p/scratch/runs`);
			await other.getByRole("listbox", { name: "Runs", exact: true }).waitFor();
			await other.route("**/plan", (route) => route.abort());
			await other.keyboard.press("n");
			await other.getByLabel("Run name").fill("Pending in the other tab");
			await other.locator('.run-planner button[type="submit"]').click();
			await other.getByRole("button", { name: "Enter Retry plan", exact: true }).waitFor();
			const sent: Api["plan"]["input"][] = [];
			page.on("request", (request) => {
				if (request.url().endsWith("/plan")) sent.push(request.postDataJSON());
			});
			await page.bringToFront();
			await page.locator('.run-planner button[type="submit"]').click();
			await eventually(
				() => page.locator("#stat").textContent(),
				(text) => text === "Another tab's plan is waiting; Retry plan sends it.",
			);
			expect(sent).toHaveLength(0);
			expect(await page.getByLabel("Run name").inputValue()).toBe("Pending in the other tab");
			await page.getByRole("button", { name: "Enter Retry plan", exact: true }).click();
			await page.waitForURL("**/runs/1");
			expect(sent.map((input) => input.name)).toEqual(["Pending in the other tab"]);
		} finally {
			await view.close();
			await server.stop();
		}
	},
	30000,
);

check(
	"discarding an uncertain plan unlocks planning without undoing a recorded run",
	async () => {
		const server = await startServer();
		const view = await openPage(server, { path: "/p/scratch/runs" });
		try {
			await server.api("propose", { edits: [{ op: "create", outline: "Checkout opens\n  Open checkout > Ready" }] });
			const { page } = view;
			await page.route("**/plan", async (route) => {
				const response = await route.fetch();
				expect(response.ok()).toBe(true);
				await route.abort();
			});
			await page.keyboard.press("n");
			await page.getByLabel("Run name").fill("Recorded plan");
			await page.locator('.run-planner button[type="submit"]').click();
			await page.getByRole("button", { name: "Enter Retry plan", exact: true }).waitFor();
			expect(await page.locator(".run-planner").textContent()).toContain(
				"This plan may already have been recorded. Discarding it does not undo a run.",
			);
			await page.getByRole("button", { name: "Discard this plan", exact: true }).click();
			expect(await page.getByLabel("Run name").isEditable()).toBe(true);
			await page.reload();
			await page.getByRole("listbox", { name: "Runs", exact: true }).waitFor();
			await page.keyboard.press("n");
			expect(await page.getByLabel("Run name").inputValue()).toBe("");
			expect(Run.array().parse((await server.api("find", { in: "runs", origin: "planned" })).items)).toMatchObject([
				{ name: "Recorded plan", slots: 1 },
			]);
		} finally {
			await view.close();
			await server.stop();
		}
	},
	30000,
);

for (const reload of [false, true])
	check(
		`an uncertain plan cannot write into a replacement project${reload ? " after reload" : " while open"}`,
		async () => {
			const dataDir = await mkdtemp(join(tmpdir(), "mainworthy-planner-identity-"));
			const port = await reservePort();
			const token = "planner-identity-test-owner-token";
			const instance = start(
				{ ...defaultConfig({}), dataDir, port: port.port, owner: "robin", ownerToken: token, mode: "local" },
				() => ({ ui }),
				{ readers: 0 },
			);
			const server: Server = {
				url: instance.url,
				project: "scratch",
				token,
				seeded: null,
				stop: instance.stop,
				api: <O extends OpName>(op: O, input: Api[O]["input"]) =>
					call(op, input, { url: instance.url, project: "scratch", token }),
			};
			let view: Awaited<ReturnType<typeof openPage>> | null = null;
			try {
				const seed = () =>
					server.api("propose", { edits: [{ op: "create", outline: "Checkout opens\n  Open checkout > Ready" }] });
				await seed();
				view = await openPage(server, { path: "/p/scratch/runs" });
				const { page } = view;
				const sent: Api["plan"]["input"][] = [];
				await page.route("**/plan", (route) => {
					sent.push(route.request().postDataJSON());
					return sent.length === 1 ? route.abort() : route.continue();
				});
				await page.keyboard.press("n");
				await page.getByLabel("Run name").fill("Original project's plan");
				await page.locator('.run-planner button[type="submit"]').click();
				await page.getByRole("button", { name: "Enter Retry plan", exact: true }).waitFor();
				removeProject(instance.app.db, "scratch");
				await server.api("admin", { do: "project.create", key: "scratch", preset: "loose" });
				await seed();
				if (reload) {
					await page.reload();
					await page.getByRole("listbox", { name: "Runs", exact: true }).waitFor();
					await page.keyboard.press("n");
				}
				await page.getByRole("button", { name: "Enter Retry plan", exact: true }).click();
				await eventually(
					async () => ({
						runs: (await server.api("find", { in: "runs", origin: "planned" })).items,
						status: await page.locator("#stat").textContent(),
					}),
					({ runs, status }) => runs.length > 0 || /belongs to an (earlier|obsolete) project/.test(status ?? ""),
				);
				expect((await server.api("find", { in: "runs", origin: "planned" })).items).toHaveLength(0);
				expect(await page.locator("#stat").textContent()).toMatch(/belongs to an (earlier|obsolete) project/);
				const original = sent[0];
				expect(original?.projectIdentity).toBeString();
				if (reload) {
					expect(sent).toHaveLength(1);
					expect(await page.getByLabel("Run name").isEditable()).toBe(false);
					await page.getByRole("button", { name: "Discard this plan", exact: true }).click();
				} else {
					expect(sent).toHaveLength(2);
					expect(sent[1]).toEqual(original);
					await page.reload();
					await page.getByRole("listbox", { name: "Runs", exact: true }).waitFor();
					await page.keyboard.press("n");
				}
				await page.getByLabel("Run name").fill("New project's plan");
				await page.locator('.run-planner button[type="submit"]').click();
				await page.waitForURL("**/runs/1");
				expect(sent.at(-1)?.projectIdentity).toBeString();
				expect(sent.at(-1)?.projectIdentity).not.toBe(original?.projectIdentity);
				expect((await server.api("find", { in: "runs", origin: "planned" })).items).toMatchObject([
					{ name: "New project's plan" },
				]);
			} finally {
				await view?.close();
				await instance.stop();
				await port.release();
				await rm(dataDir, { recursive: true, force: true });
			}
		},
		30_000,
	);

check(
	"a stale tab's retry preserves another tab's newer uncertain plan",
	async () => {
		const server = await startServer();
		const view = await openPage(server, { path: "/p/scratch/runs" });
		try {
			await server.api("propose", { edits: [{ op: "create", outline: "Checkout opens\n  Open checkout > Ready" }] });
			const { page, context } = view;
			const key = `${await devicePrefix(server, server.token)}run-plan:scratch`;
			const first: Api["plan"]["input"][] = [];
			await page.route("**/plan", async (route) => {
				first.push(route.request().postDataJSON());
				if (first.length > 1) return route.continue();
				const response = await route.fetch();
				expect(response.ok()).toBe(true);
				await route.abort();
			});
			await page.evaluate(() => {
				window.addEventListener("storage", (event) => event.stopImmediatePropagation(), true);
			});
			await page.keyboard.press("n");
			await page.getByLabel("Run name").fill("Plan X");
			await page.locator('.run-planner button[type="submit"]').click();
			await page.getByRole("button", { name: "Enter Retry plan", exact: true }).waitFor();
			const other = await context.newPage();
			await other.goto(`${server.url}/p/scratch/runs`);
			await other.getByRole("listbox", { name: "Runs", exact: true }).waitFor();
			await other.keyboard.press("n");
			await other.getByRole("button", { name: "Discard this plan", exact: true }).click();
			const second: Api["plan"]["input"][] = [];
			await other.route("**/plan", async (route) => {
				second.push(route.request().postDataJSON());
				if (second.length > 1) return route.continue();
				const response = await route.fetch();
				expect(response.ok()).toBe(true);
				await route.abort();
			});
			await other.getByLabel("Run name").fill("Plan Y");
			await other.locator('.run-planner button[type="submit"]').click();
			await other.getByRole("button", { name: "Enter Retry plan", exact: true }).waitFor();
			await page.bringToFront();
			await page.locator('.run-planner button[type="submit"]').click();
			await eventually(
				async () => ({ status: await page.locator("#stat").textContent(), url: page.url() }),
				({ status, url }) =>
					status === "Another tab's plan is waiting; Retry plan sends it." || url.endsWith("/runs/1"),
			);
			expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), key)).toEqual(second[0]);
			expect(first).toHaveLength(1);
			expect(await page.getByLabel("Run name").inputValue()).toBe("Plan Y");
			expect(await page.getByLabel("Run name").isEditable()).toBe(false);
			await other.bringToFront();
			await other.keyboard.press("Escape");
			await other.keyboard.press("n");
			expect(await other.getByLabel("Run name").inputValue()).toBe("Plan Y");
			await other.getByRole("button", { name: "Enter Retry plan", exact: true }).click();
			await other.waitForURL("**/runs/2");
			expect(second).toHaveLength(2);
			expect(second[1]).toEqual(second[0]);
			expect(
				Run.array()
					.parse((await server.api("find", { in: "runs", origin: "planned" })).items)
					.map((run) => run.name)
					.sort(),
			).toEqual(["Plan X", "Plan Y"]);
		} finally {
			await view.close();
			await server.stop();
		}
	},
	30_000,
);

check(
	"a recorded plan's changed-request conflict keeps its saved command and explains recovery",
	async () => {
		const server = await startServer();
		const view = await openPage(server, { path: "/p/scratch/runs" });
		try {
			await server.api("propose", { edits: [{ op: "create", outline: "Checkout opens\n  Open checkout > Ready" }] });
			const { page } = view;
			const key = `${await devicePrefix(server, server.token)}run-plan:scratch`;
			const sent: Api["plan"]["input"][] = [];
			await page.route("**/plan", async (route) => {
				const input: Api["plan"]["input"] = route.request().postDataJSON();
				sent.push(input);
				const response = await route.fetch(
					sent.length > 1 ? { postData: JSON.stringify({ ...input, require: [] }) } : {},
				);
				if (sent.length === 1) {
					expect(response.ok()).toBe(true);
					return route.abort();
				}
				expect(response.status()).toBe(409);
				expect(await response.json()).toMatchObject({
					ok: false,
					error: {
						code: "conflict",
						message: "this command id was already used for another request; send new content under a new id",
					},
				});
				await route.fulfill({ response });
			});
			await page.keyboard.press("n");
			await page.getByLabel("Run name").fill("Recorded before the format change");
			await page.locator('.run-planner button[type="submit"]').click();
			await page.getByRole("button", { name: "Enter Retry plan", exact: true }).waitFor();
			await page.getByRole("button", { name: "Enter Retry plan", exact: true }).click();
			await eventually(
				() => page.locator("#stat").textContent(),
				(status) => Boolean(status?.includes("Check Runs") || status?.startsWith("this command id was already used")),
			);
			const original = sent[0];
			if (!original) throw new Error("No plan was submitted");
			expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), key)).toEqual(original);
			expect(await page.getByLabel("Run name").isEditable()).toBe(false);
			expect(await page.locator("#stat").textContent()).toContain("A run may already exist. Check Runs");
			await page.reload();
			await page.getByRole("listbox", { name: "Runs", exact: true }).waitFor();
			await page.keyboard.press("n");
			expect(await page.getByLabel("Run name").inputValue()).toBe("Recorded before the format change");
			await page.getByRole("button", { name: "Enter Retry plan", exact: true }).click();
			await eventually(
				() => page.locator("#stat").textContent(),
				(status) => Boolean(status?.includes("Check Runs")),
			);
			expect(sent).toHaveLength(3);
			for (const input of sent) expect(input).toEqual(original);
			expect((await server.api("find", { in: "runs", origin: "planned" })).items).toHaveLength(1);
		} finally {
			await view.close();
			await server.stop();
		}
	},
	30_000,
);

for (const path of ["storage event", "late failure", "retry"] as const)
	check(
		`another tab's discard prevents resurrection through ${path}`,
		async () => {
			const server = await startServer();
			const view = await openPage(server, { path: "/p/scratch/runs" });
			const arrived = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			try {
				await server.api("propose", { edits: [{ op: "create", outline: "Checkout opens\n  Open checkout > Ready" }] });
				const { page, context } = view;
				const key = `${await devicePrefix(server, server.token)}run-plan:scratch`;
				const sent: Api["plan"]["input"][] = [];
				await page.route("**/plan", async (route) => {
					sent.push(route.request().postDataJSON());
					if (sent.length > 1) return route.continue();
					arrived.resolve();
					await release.promise;
					await route.abort().catch(() => {});
				});
				if (path !== "storage event")
					await page.evaluate(() => {
						window.addEventListener("storage", (event) => event.stopImmediatePropagation(), true);
					});
				await page.keyboard.press("n");
				await page.getByLabel("Run name").fill("Discarded plan X");
				await page.locator('.run-planner button[type="submit"]').click();
				await arrived.promise;
				if (path === "retry") {
					release.resolve();
					await page.getByRole("button", { name: "Enter Retry plan", exact: true }).waitFor();
				}
				const other = await context.newPage();
				await other.goto(`${server.url}/p/scratch/runs`);
				await other.getByRole("listbox", { name: "Runs", exact: true }).waitFor();
				await other.keyboard.press("n");
				await other.getByRole("button", { name: "Discard this plan", exact: true }).click();
				expect(await other.evaluate((key) => localStorage.getItem(key), key)).toBeNull();
				if (path === "storage event") await eventually(() => page.getByLabel("Run name").isEditable(), Boolean);
				const failed =
					path === "retry" ? null : page.waitForEvent("requestfailed", (request) => request.url().endsWith("/plan"));
				await page.bringToFront();
				if (path === "retry") await page.getByRole("button", { name: "Enter Retry plan", exact: true }).click();
				else release.resolve();
				if (failed) {
					await failed;
					await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
				}
				await eventually(
					async () => ({ status: await page.locator("#stat").textContent(), url: page.url() }),
					({ status, url }) =>
						Boolean(
							status?.includes("no longer saved") || url.endsWith("/runs/1") || status?.includes("outcome is unknown"),
						),
				);
				expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBeNull();
				expect(await page.getByLabel("Run name").isEditable()).toBe(true);
				expect(await page.getByRole("button", { name: "Enter Retry plan", exact: true }).count()).toBe(0);
				expect(await page.locator("#stat").textContent()).toContain("no longer saved");
				expect(sent).toHaveLength(1);
				expect((await server.api("find", { in: "runs", origin: "planned" })).items).toHaveLength(0);
			} finally {
				release.resolve();
				await view.close();
				await server.stop();
			}
		},
		30_000,
	);

check(
	"an unreadable saved plan is retained until storage can confirm the retry",
	async () => {
		const server = await startServer();
		const view = await openPage(server, { path: "/p/scratch/runs" });
		try {
			await server.api("propose", { edits: [{ op: "create", outline: "Checkout opens\n  Open checkout > Ready" }] });
			const { page } = view;
			const key = `${await devicePrefix(server, server.token)}run-plan:scratch`;
			const sent: Api["plan"]["input"][] = [];
			await page.route("**/plan", async (route) => {
				sent.push(route.request().postDataJSON());
				if (sent.length === 1) return route.abort();
				await route.continue();
			});
			await page.keyboard.press("n");
			await page.getByLabel("Run name").fill("Keep until readable");
			await page.locator('.run-planner button[type="submit"]').click();
			await page.getByRole("button", { name: "Enter Retry plan", exact: true }).waitFor();
			await page.evaluate((key) => {
				const read = Storage.prototype.getItem;
				Storage.prototype.getItem = function (entry) {
					if (entry === key) throw new Error("Storage temporarily unreadable");
					return read.call(this, entry);
				};
				window.addEventListener(
					"restore-plan-storage",
					() => {
						Storage.prototype.getItem = read;
					},
					{ once: true },
				);
			}, key);
			await page.getByRole("button", { name: "Enter Retry plan", exact: true }).click();
			await eventually(
				() => page.locator("#stat").textContent(),
				(status) => Boolean(status?.includes("could not confirm")),
			);
			await page.evaluate(() => {
				window.dispatchEvent(new Event("restore-plan-storage"));
			});
			expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), key)).toEqual(sent[0]);
			expect(await page.getByLabel("Run name").isEditable()).toBe(false);
			expect(sent).toHaveLength(1);
			await page.getByRole("button", { name: "Enter Retry plan", exact: true }).click();
			await page.waitForURL("**/runs/1");
			expect(sent).toHaveLength(2);
			expect(sent[1]).toEqual(sent[0]);
			expect((await server.api("find", { in: "runs", origin: "planned" })).items).toHaveLength(1);
		} finally {
			await view.close();
			await server.stop();
		}
	},
	30_000,
);

for (const failure of ["read", "removal"] as const)
	check(
		`a storage ${failure} failure during Discard keeps the saved plan locked and reports failure`,
		async () => {
			const server = await startServer();
			const view = await openPage(server, { path: "/p/scratch/runs" });
			try {
				await server.api("propose", { edits: [{ op: "create", outline: "Checkout opens\n  Open checkout > Ready" }] });
				const { page } = view;
				const key = `${await devicePrefix(server, server.token)}run-plan:scratch`;
				const sent: Api["plan"]["input"][] = [];
				await page.route("**/plan", async (route) => {
					sent.push(route.request().postDataJSON());
					if (sent.length > 1) return route.continue();
					const response = await route.fetch();
					expect(response.ok()).toBe(true);
					await route.abort();
				});
				await page.keyboard.press("n");
				await page.getByLabel("Run name").fill("Plan X");
				await page.locator('.run-planner button[type="submit"]').click();
				await page.getByRole("button", { name: "Enter Retry plan", exact: true }).waitFor();
				await page.evaluate(
					({ key, failure }) => {
						const read = Storage.prototype.getItem;
						const remove = Storage.prototype.removeItem;
						Storage.prototype.getItem = function (entry) {
							if (failure === "read" && entry === key) throw new Error("Device storage unreadable");
							return read.call(this, entry);
						};
						Storage.prototype.removeItem = function (entry) {
							if (failure === "removal" && entry === key) throw new Error("Device storage removal unavailable");
							return remove.call(this, entry);
						};
						window.addEventListener(
							"restore-plan-storage",
							() => {
								Storage.prototype.getItem = read;
								Storage.prototype.removeItem = remove;
							},
							{ once: true },
						);
					},
					{ key, failure },
				);
				await page.getByRole("button", { name: "Discard this plan", exact: true }).click();
				expect(await page.locator("#stat").textContent()).toContain("could not discard the saved plan");
				expect(await page.getByLabel("Run name").isEditable()).toBe(false);
				expect(await page.getByRole("button", { name: "Enter Retry plan", exact: true }).count()).toBe(1);
				expect(sent).toHaveLength(1);
				await page.evaluate(() => {
					window.dispatchEvent(new Event("restore-plan-storage"));
				});
				const original = sent[0];
				if (!original) throw new Error("No plan was submitted");
				expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), key)).toEqual(original);
				await page.reload();
				await page.getByRole("listbox", { name: "Runs", exact: true }).waitFor();
				await page.keyboard.press("n");
				expect(await page.getByLabel("Run name").inputValue()).toBe("Plan X");
				expect(await page.getByLabel("Run name").isEditable()).toBe(false);
				await page.getByRole("button", { name: "Enter Retry plan", exact: true }).click();
				await page.waitForURL("**/runs/1");
				expect(sent).toHaveLength(2);
				expect(sent[1]).toEqual(original);
				expect((await server.api("find", { in: "runs", origin: "planned" })).items).toHaveLength(1);
			} finally {
				await view.close();
				await server.stop();
			}
		},
		30_000,
	);

for (let repeat = 1; repeat <= 10; repeat++)
	check(
		`two tabs retry one plan simultaneously without a fresh duplicate (${repeat}/10)`,
		async () => {
			const server = await startServer();
			const view = await openPage(server, { path: "/p/scratch/runs" });
			try {
				await server.api("propose", { edits: [{ op: "create", outline: "Checkout opens\n  Open checkout > Ready" }] });
				const { page, context } = view;
				const sent: Api["plan"]["input"][] = [];
				await page.route("**/plan", async (route) => {
					sent.push(route.request().postDataJSON());
					if (sent.length > 1) return route.continue();
					const response = await route.fetch();
					expect(response.ok()).toBe(true);
					await route.abort();
				});
				await page.keyboard.press("n");
				await page.getByLabel("Run name").fill("Plan X");
				await page.locator('.run-planner button[type="submit"]').click();
				await page.getByRole("button", { name: "Enter Retry plan", exact: true }).waitFor();
				const other = await context.newPage();
				other.on("request", (request) => {
					if (request.url().endsWith("/plan")) sent.push(request.postDataJSON());
				});
				await other.goto(`${server.url}/p/scratch/runs`);
				await other.getByRole("listbox", { name: "Runs", exact: true }).waitFor();
				await other.keyboard.press("n");
				await other.getByRole("button", { name: "Enter Retry plan", exact: true }).waitFor();
				const original = sent[0];
				if (!original) throw new Error("No plan was submitted");
				await Promise.all([
					page.locator('.run-planner button[type="submit"]').click({ force: true }),
					other.locator('.run-planner button[type="submit"]').click({ force: true, delay: 50 }),
				]);
				for (const tab of [page, other])
					await eventually(
						() =>
							tab.evaluate(() => ({
								path: location.pathname,
								name: document.querySelector<HTMLInputElement>("#run-name")?.value,
								editable: document.querySelector<HTMLInputElement>("#run-name")?.readOnly === false,
							})),
						({ path, editable }) => /\/runs\/\d+$/.test(path) || editable,
					);
				for (const tab of [page, other])
					expect(await tab.evaluate(() => document.querySelector<HTMLInputElement>("#run-name")?.value ?? "")).toBe("");
				expect(
					Run.array()
						.parse((await server.api("find", { in: "runs", origin: "planned" })).items)
						.map((run) => run.name),
				).toEqual(["Plan X"]);
				for (const input of sent) expect(input).toEqual(original);
			} finally {
				await view.close();
				await server.stop();
			}
		},
		30_000,
	);

for (const trigger of ["click", "Enter", "queued submit"] as const)
	check(
		`another tab completing a plan clears every choice before a stale ${trigger}`,
		async () => {
			const server = await startServer();
			const view = await openPage(server, { path: "/p/scratch/runs" });
			try {
				await server.api("propose", {
					edits: [{ op: "create", folder: "checkout", outline: "Checkout opens\n  Open checkout > Ready" }],
				});
				const { page, context } = view;
				let original: Api["plan"]["input"] | undefined;
				await page.route("**/plan", async (route) => {
					if (original) return route.continue();
					original = route.request().postDataJSON();
					const response = await route.fetch();
					expect(response.ok()).toBe(true);
					await route.abort();
				});
				await page.keyboard.press("n");
				await page.getByLabel("Run name").fill("Plan X");
				await page.getByLabel("Cases", { exact: true }).selectOption("folder");
				await page.getByLabel("Folder", { exact: true }).selectOption("checkout");
				await page.getByRole("radio", { name: "Accept results for a commit" }).check();
				await page.getByLabel("Commit", { exact: true }).fill("a".repeat(40));
				await page.locator('.run-planner button[type="submit"]').click();
				await page.getByRole("button", { name: "Enter Retry plan", exact: true }).waitFor();
				const other = await context.newPage();
				const sent: Api["plan"]["input"][] = [];
				other.on("request", (request) => {
					if (request.url().endsWith("/plan")) sent.push(request.postDataJSON());
				});
				await other.goto(`${server.url}/p/scratch/runs`);
				await other.getByRole("listbox", { name: "Runs", exact: true }).waitFor();
				await other.keyboard.press("n");
				await other.getByRole("button", { name: "Enter Retry plan", exact: true }).waitFor();
				if (trigger === "queued submit") {
					const key = `${await devicePrefix(server, server.token)}run-plan:scratch`;
					await other.evaluate((key) => {
						window.addEventListener("storage", (event) => {
							if (event.key === key && event.newValue === null)
								document
									.querySelector(".run-planner")
									?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
						});
					}, key);
				}
				await page.locator('.run-planner button[type="submit"]').click();
				await page.waitForURL("**/runs/1");
				await other.bringToFront();
				if (trigger !== "queued submit") await eventually(() => other.getByLabel("Run name").isEditable(), Boolean);
				if (trigger === "click") await other.locator('.run-planner button[type="submit"]').click({ force: true });
				else if (trigger === "Enter") await other.keyboard.press("Enter");
				await eventually(
					() =>
						other.evaluate(() => ({
							path: location.pathname,
							name: document.querySelector<HTMLInputElement>("#run-name")?.value,
						})),
					({ path, name }) => /\/runs\/\d+$/.test(path) || name === "",
				);
				expect((await server.api("find", { in: "runs", origin: "planned" })).items).toHaveLength(1);
				expect(sent).toHaveLength(0);
				expect(await other.getByLabel("Run name").inputValue()).toBe("");
				expect(await other.getByLabel("Cases", { exact: true }).inputValue()).toBe("all");
				expect(await other.getByLabel("Folder", { exact: true }).count()).toBe(0);
				expect(await other.getByLabel("Commit", { exact: true }).count()).toBe(0);
				expect(await other.getByRole("radio", { name: "Count only results recorded in this run" }).isChecked()).toBe(
					true,
				);
				expect(await other.locator("#stat").textContent()).toContain("Check Runs before planning again");
				await other.getByLabel("Run name").fill("Intentional new plan");
				await other.locator('.run-planner button[type="submit"]').click();
				await other.waitForURL("**/runs/2");
				expect(sent).toHaveLength(1);
				expect(sent[0]).toMatchObject({ name: "Intentional new plan", select: {} });
				expect(sent[0]?.accepts).toBeUndefined();
				expect(sent[0]?.cmd).not.toBe(original?.cmd);
			} finally {
				await view.close();
				await server.stop();
			}
		},
		30_000,
	);
