import { expect, test } from "bun:test";
import { z } from "zod";
import { Slot } from "../../src/web/runs/models.ts";
import { browserAvailable, eventually, launchBrowser, openPage, startServer } from "./support.ts";

for (const refusal of ["request", "changed evidence"]) {
	test.skipIf(!browserAvailable)(
		`a late queue ${refusal} refusal keeps the next question selected for its answer key`,
		async () => {
			const server = await startServer({ preset: "standard" });
			let browser: Awaited<ReturnType<typeof openPage>> | null = null;
			let release = () => {};
			const held = new Promise<void>((resolve) => {
				release = resolve;
			});
			try {
				await server.api("propose", { edits: [{ op: "create", outline: "Case 1\n  Click > Ready" }] });
				if (refusal === "request")
					await server.api("report", {
						target: { session: "failure" },
						results: [{ test: { case: "C-1" }, outcome: "fail", failure: { message: "expected ready, got loading" } }],
					});
				else {
					const writer = z.object({ token: z.string() }).parse(
						await server.api("admin", {
							do: "token.create",
							actor: "writer",
							kind: "agent",
							can: ["read", "produce"],
							project: "scratch",
						}),
					).token;
					await server.api(
						"propose",
						{ edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Proposed title" } }] },
						{ token: writer },
					);
				}
				await server.api("report", {
					target: { commit: "unlinked123", branch: "main" },
					results: [{ test: { key: "unlinked::works", file: "unlinked.ts", name: "Unlinked" }, outcome: "pass" }],
				});
				const inbox = await server.api("inbox", {});
				const first = inbox.items.find((q) => q.kind === (refusal === "request" ? "failure" : "adopt"));
				const next = inbox.items.find((q) => q.kind === "map");
				if (!first || !next) throw new Error("Queue questions missing");
				browser = await openPage(server, { path: `/p/scratch/queue/${first.q.slice(2)}` });
				const { page } = browser;
				page.setDefaultTimeout(5000);
				await page.locator(`[data-current-question="${first.q}"]`).waitFor();
				let requests = 0;
				await browser.context.route("**/api/p/scratch/decide", async (route) => {
					if (++requests === 1) {
						await held;
						if (refusal === "request") {
							await route.fulfill({ json: { ok: false, error: { code: "internal", message: "Queue unavailable" } } });
							return;
						}
					}
					await route.continue();
				});
				await page.keyboard.press(refusal === "request" ? "i" : "a");
				await page.locator(`[data-current-question="${next.q}"]`).waitFor();
				await eventually(
					async () => requests,
					(count) => count === 1,
				);
				expect((await server.api("get", { refs: [first.q] }))[0]?.state).toBe("open");
				if (refusal === "changed evidence")
					await server.api("propose", {
						edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Person's title" } }],
					});
				release();
				await page.waitForFunction(
					(text) => document.querySelector("#stat")?.textContent?.includes(text),
					refusal === "request" ? "Queue unavailable" : "The evidence changed",
				);
				expect(await page.locator("[data-current-question]").getAttribute("data-current-question")).toBe(next.q);
				await page.keyboard.press("t");
				const rows = await eventually(
					() => server.api("inbox", { state: "decided" }),
					(reply) => reply.items.some((q) => q.q === next.q),
				);
				expect(rows.items.find((q) => q.q === next.q)?.decision?.answer.is).toBe("track");
				expect((await server.api("get", { refs: [first.q] }))[0]?.state).toBe("open");
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

test.skipIf(!browserAvailable)(
	"plain HTTP hostname supports capture, edits, queue answers, run planning and recording, and policy changes",
	async () => {
		const server = await startServer({ mode: "server" });
		const chromium = await launchBrowser({ args: ["--host-resolver-rules=MAP casebook.test 127.0.0.1"] });
		let browser: Awaited<ReturnType<typeof openPage>> | null = null;
		try {
			await server.api("propose", {
				edits: [{ op: "create", outline: "Existing\n  Open page > Ready", folder: "HTTP cases" }],
			});
			browser = await openPage(server, { browser: chromium });
			const { page } = browser;
			page.setDefaultTimeout(5000);
			const origin = server.url.replace("127.0.0.1", "casebook.test");
			await page.goto(`${origin}/p/scratch/suite`);
			await page.locator("#token").fill(server.token);
			await page.keyboard.press("Enter");
			await page.getByRole("button", { name: "Existing", exact: true }).waitFor();
			expect(await page.evaluate(() => ({ secure: isSecureContext, uuid: typeof crypto.randomUUID }))).toEqual({
				secure: false,
				uuid: "undefined",
			});
			await page.keyboard.press("c");
			expect(await page.getByRole("textbox", { name: "Case title", exact: true }).count()).toBe(1);
			await page.keyboard.type("HTTP capture");
			await page.keyboard.press("Enter");
			await page.keyboard.type("HTTP step");
			await page.keyboard.press("Escape");
			await page.waitForURL("**/suite/c/2");
			await page.keyboard.press("e");
			await page.getByRole("textbox", { name: "Case title", exact: true }).fill("HTTP capture revised");
			await page.keyboard.press("Escape");
			await eventually(
				() => server.api("get", { refs: ["C-2"] }),
				(rows) => rows[0]?.version === 2,
			);
			await server.api("report", {
				target: { session: "http failure" },
				results: [{ test: { case: "C-1" }, outcome: "fail", failure: { message: "expected ready, got loading" } }],
			});
			await page.getByRole("link", { name: "Queue", exact: true }).click();
			await page.locator("[data-current-question]").waitFor();
			const q = await page.locator("[data-current-question]").getAttribute("data-current-question");
			if (!q) throw new Error("Failure question missing");
			await page.keyboard.press("i");
			await eventually(
				() => server.api("get", { refs: [q] }),
				(rows) => rows[0]?.state === "decided",
			);
			await page.keyboard.press("u");
			await eventually(
				() => server.api("get", { refs: [q] }),
				(rows) => rows[0]?.state === "open",
			);
			await page.getByRole("link", { name: "Runs", exact: true }).click();
			await page.keyboard.press("n");
			await page.getByLabel("Run name").fill("HTTP plan");
			await page.getByLabel("Cases", { exact: true }).selectOption("folder");
			await page.getByLabel("Folder", { exact: true }).selectOption("HTTP cases");
			await page.getByText("2 matching cases", { exact: true }).waitFor();
			await page.getByRole("button", { name: "Enter Plan run", exact: true }).click();
			const planned = await eventually(
				() => server.api("find", { in: "runs" }),
				(rows) => rows.items.length === 1,
			);
			const run = z.object({ ref: z.string() }).parse(planned.items[0]).ref;
			await page.waitForSelector('[data-run-document="C-1"][data-active="true"][data-ready="true"]');
			await page.keyboard.press("p");
			await page.waitForSelector('[data-run-document="C-2"][data-active="true"][data-ready="true"]');
			await page.keyboard.press("p");
			await eventually(
				async () => Slot.array().parse((await server.api("find", { in: "slots", run })).items),
				(slots) => slots.every((slot) => slot.fills[0]?.outcome === "pass"),
			);
			await page.getByRole("link", { name: "Settings", exact: true }).click();
			await page.getByLabel("Policy preset").selectOption("standard");
			await page.getByText("standard is in force.", { exact: false }).waitFor();
			expect(browser.errors).toEqual([]);
		} finally {
			await browser?.close();
			await chromium.close();
			await server.stop();
		}
	},
	45_000,
);

test.skipIf(!browserAvailable)(
	"Copy token works on a plain HTTP hostname and keeps the token field masked",
	async () => {
		const server = await startServer({ mode: "server" });
		const chromium = await launchBrowser({ args: ["--host-resolver-rules=MAP casebook.test 127.0.0.1"] });
		let browser: Awaited<ReturnType<typeof openPage>> | null = null;
		try {
			browser = await openPage(server, { browser: chromium });
			const { page, context } = browser;
			page.setDefaultTimeout(5000);
			await page.goto(`${server.url.replace("127.0.0.1", "casebook.test")}/p/scratch/settings`);
			await page.locator("#token").fill(server.token);
			await page.keyboard.press("Enter");
			await page.getByRole("option", { name: "Tokens", exact: true }).click();
			await page.getByLabel("Token actor").fill("http-reader");
			await page.getByRole("button", { name: "Create token", exact: true }).click();
			const token = page.getByLabel("New token", { exact: true });
			await token.waitFor();
			const value = await token.inputValue();
			expect(await page.evaluate(() => typeof navigator.clipboard)).toBe("undefined");
			await page.getByRole("button", { name: "Copy token", exact: true }).click();
			await page.waitForFunction(() => document.querySelector("#stat")?.textContent?.includes("Token copied."));
			expect(await token.getAttribute("type")).toBe("password");
			await context.grantPermissions(["clipboard-read"], { origin: server.url });
			const reader = await context.newPage();
			await reader.goto(`${server.url}/healthz`);
			expect((await reader.evaluate(() => navigator.clipboard.readText())) === value).toBe(true);
			expect(browser.errors).toEqual([]);
		} finally {
			await browser?.close();
			await chromium.close();
			await server.stop();
		}
	},
	30_000,
);

test.skipIf(!browserAvailable)(
	"walking the list through a stored draft keeps navigation keys out of its text and retains its conflict",
	async () => {
		const server = await startServer();
		await server.api("propose", { edits: [1, 2, 3].map((n) => ({ op: "create", outline: `Case ${n}` })) });
		const browser = await openPage(server, { path: "/p/scratch/suite/c/2" });
		try {
			const { page } = browser;
			page.setDefaultTimeout(5000);
			await page.getByRole("button", { name: "Case 2", exact: true }).waitFor();
			await page.keyboard.press("e");
			await page.getByRole("textbox", { name: "Case title", exact: true }).fill("Case 2, my wording");
			await server.api("propose", {
				edits: [{ op: "edit", case: "C-2", base: 1, body: { title: "Case 2, their wording" } }],
			});
			await page.keyboard.press("Escape");
			await page.getByRole("region", { name: "Edit conflict" }).waitFor();
			await page.keyboard.press("k");
			await page.waitForURL("**/suite/c/1");
			await page.keyboard.press("j");
			await page.waitForURL("**/suite/c/2");
			expect(await page.locator(".body-editor").count()).toBe(0);
			expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("TEXTAREA");
			await page.keyboard.press("j");
			await page.waitForURL("**/suite/c/3");
			await page.keyboard.press("k");
			await page.waitForURL("**/suite/c/2");
			expect(await page.locator(".body-editor").count()).toBe(0);
			expect(await page.getByRole("option").filter({ hasText: "C-2" }).locator(".dr").innerText()).toBe("draft");
			await page.keyboard.press("e");
			expect(await page.getByRole("textbox", { name: "Case title", exact: true }).inputValue()).toBe(
				"Case 2, my wording",
			);
			expect(await page.getByRole("region", { name: "Edit conflict" }).count()).toBe(1);
			expect((await server.api("get", { refs: ["C-2"] }))[0]?.title).toBe("Case 2, their wording");
			expect(browser.errors).toEqual([]);
		} finally {
			await browser.close();
			await server.stop();
		}
	},
	30_000,
);

test.skipIf(!browserAvailable)(
	"a late conflict stays on its case, marks its draft row and is available on return",
	async () => {
		const server = await startServer();
		await server.api("propose", { edits: [1, 2].map((n) => ({ op: "create", outline: `Case ${n}` })) });
		const browser = await openPage(server, { path: "/p/scratch/suite/c/1" });
		let release = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		try {
			const { page } = browser;
			page.setDefaultTimeout(5000);
			await page.getByRole("button", { name: "Case 1", exact: true }).waitFor();
			await page.keyboard.press("e");
			await page.getByRole("textbox", { name: "Case title", exact: true }).fill("Case 1, my wording");
			await server.api("propose", {
				edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Case 1, their wording" } }],
			});
			await browser.context.route("**/api/p/scratch/propose", async (route) => {
				await held;
				await route.continue();
			});
			await page.keyboard.press("Escape");
			await page.keyboard.press("j");
			await page.waitForURL("**/suite/c/2");
			release();
			await page.waitForFunction(() => document.querySelector("#stat")?.textContent?.includes("conflict"));
			expect(await page.locator("#detail .cid").innerText()).toBe("C-2");
			expect(await page.getByRole("region", { name: "Edit conflict" }).count()).toBe(0);
			expect(await page.getByRole("option").filter({ hasText: "C-1" }).locator(".dr").innerText()).toBe("draft");
			await page.keyboard.press("k");
			await page.waitForURL("**/suite/c/1");
			expect(await page.locator(".body-editor").count()).toBe(0);
			await page.keyboard.press("e");
			expect(await page.getByRole("region", { name: "Edit conflict" }).count()).toBe(1);
			expect(await page.getByRole("textbox", { name: "Case title", exact: true }).inputValue()).toBe(
				"Case 1, my wording",
			);
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
	"a refused project read shows the refusal instead of an empty suite",
	async () => {
		const server = await startServer({ mode: "server" });
		await server.api("admin", { do: "project.create", key: "second", name: "Second" });
		const token = z.object({ token: z.string() }).parse(
			await server.api("admin", {
				do: "token.create",
				actor: "scoped-reader",
				kind: "human",
				can: ["read"],
				project: "scratch",
			}),
		).token;
		const browser = await openPage({ ...server, token }, { path: "/p/second/suite" });
		try {
			const { page, context } = browser;
			page.setDefaultTimeout(5000);
			const reply = await context.request.post(`${server.url}/api/p/second/find`, { data: { in: "cases" } });
			const error = z
				.object({ ok: z.literal(false), error: z.object({ message: z.string() }) })
				.parse(await reply.json());
			await page.waitForFunction(
				(message) => document.querySelector("#list [role=status]")?.textContent?.includes(message),
				error.error.message,
			);
			expect(await page.locator("#list").innerText()).not.toContain("No cases yet");
			expect(await page.locator("#list").innerText()).toContain("Your session may not read this project.");
			expect(await page.locator("#lcount").innerText()).not.toBe("0 cases");
			expect(await page.locator("#app").count()).toBe(1);
		} finally {
			await browser.close();
			await server.stop();
		}
	},
	30_000,
);
