import { expect, test } from "bun:test";
import type { Api } from "../../src/core/api.ts";
import { Run, Slot } from "../../src/web/runs/models.ts";
import { browserAvailable, eventually, openPage, startServer } from "./support.ts";

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
