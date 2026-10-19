import { expect, test } from "bun:test";
import type { Page } from "playwright-core";
import { z } from "zod";
import { ciReport } from "../helpers.ts";
import { answer, browserAvailable, eventually, fetched, openPage, startServer } from "./support.ts";

async function holdReply(page: Page, pattern: string, matches: (input: unknown) => boolean = () => true) {
	const held = Promise.withResolvers<void>();
	const arrived = Promise.withResolvers<void>();
	await page.route(pattern, async (route) => {
		if (!matches(route.request().postDataJSON())) return route.continue();
		const reply = await fetched(route);
		if (!reply) return;
		arrived.resolve();
		await held.promise;
		await answer(route, { response: reply.response });
	});
	return { arrived: arrived.promise, release: () => held.resolve() };
}

test.skipIf(!browserAvailable)(
	"a late case save preserves the Suite list the person returned to",
	async () => {
		const server = await startServer({ cases: 2 });
		const browser = await openPage(server, { path: "/p/scratch/settings" });
		const held = Promise.withResolvers<void>();
		const reading = Promise.withResolvers<void>();
		try {
			const { page } = browser;
			await page.getByRole("option", { name: "Your home", exact: true }).click();
			await page.getByLabel("Home screen", { exact: true }).selectOption("queue");
			await page.getByRole("button", { name: "Save home", exact: true }).click();
			await page.getByRole("status").filter({ hasText: "Home saved" }).waitFor();
			await page.goto(`${server.url}/p/scratch/suite/c/1`);
			await page.locator(".ctitle").waitFor();
			await page.keyboard.press("e");
			await page.getByRole("textbox", { name: "Case title", exact: true }).fill("A late save stays here");
			await page.route("**/api/p/scratch/get", async (route) => {
				const input = route.request().postDataJSON();
				if (input.version === 2 && input.refs?.includes("C-1")) {
					const response = await route.fetch();
					reading.resolve();
					await held.promise;
					await route.fulfill({ response });
				} else await route.continue();
			});
			await page.keyboard.press("Control+k");
			await page.getByRole("textbox", { name: "Jump to or run" }).fill("Go home");
			await page.keyboard.press("Enter");
			await page.getByRole("listbox", { name: "Questions", exact: true }).waitFor();
			await reading.promise;
			await page.keyboard.type("gs");
			await page.getByRole("textbox", { name: "Filter cases", exact: true }).waitFor();
			expect(new URL(page.url()).pathname).toBe("/p/scratch/suite");
			held.resolve();
			await page.locator("#stat").filter({ hasText: "Version 2, by you, just now" }).waitFor();
			expect(new URL(page.url()).pathname).toBe("/p/scratch/suite");
			expect((await server.api("get", { refs: ["C-1"] }))[0]).toMatchObject({
				title: "A late save stays here",
				version: 2,
			});
			await eventually(
				() => page.getByRole("option").filter({ hasText: "A late save stays here" }).count(),
				(count) => count === 1,
			);
			expect(browser.errors).toEqual([]);
		} finally {
			held.resolve();
			await browser.close();
			await server.stop();
		}
	},
	30_000,
);

for (const leaving of [false, true]) {
	test.skipIf(!browserAvailable)(
		leaving
			? "a late new-case save removes its draft row from a remounted Suite"
			: "a query-only filter change keeps the pending new-case save's navigation",
		async () => {
			const server = await startServer();
			const h = await openPage(server, { path: "/p/scratch/suite" });
			let release = () => {};
			try {
				const { page } = h;
				await page.getByRole("textbox", { name: "Filter cases", exact: true }).waitFor();
				await page.keyboard.press("c");
				const title = page.getByRole("textbox", { name: "Case title", exact: true });
				await title.fill("Searchable new case");
				const pending = await holdReply(
					page,
					"**/api/p/scratch/get",
					(input) => z.object({ version: z.literal(1) }).safeParse(input).success,
				);
				release = pending.release;
				if (leaving) {
					await page.keyboard.press("Control+k");
					await page.getByRole("textbox", { name: "Jump to or run" }).fill("Reports");
					await page.keyboard.press("Enter");
					await eventually(
						async () => new URL(page.url()).pathname,
						(path) => path === "/p/scratch/reports",
					);
				} else await title.press("Control+Enter");
				await pending.arrived;
				if (leaving) {
					await page.keyboard.type("gs");
					await page.getByRole("textbox", { name: "Filter cases", exact: true }).waitFor();
				} else {
					await page.getByRole("textbox", { name: "Filter cases", exact: true }).fill("Searchable");
					await eventually(
						async () => new URL(page.url()).search,
						(search) => search === "?text=Searchable",
					);
				}
				release();
				await page.locator("#stat").filter({ hasText: "Version 1, by you, just now" }).waitFor();
				await page.getByRole("option").filter({ hasText: "C-1" }).waitFor();
				const refs = await page.getByRole("option").locator(".id").allTextContents();
				expect(refs).toEqual(["C-1"]);
				expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe(
					leaving ? "/p/scratch/suite" : "/p/scratch/suite/c/1?text=Searchable",
				);
				expect(await page.evaluate(() => Object.keys(localStorage).filter((key) => key.includes(":draft:")))).toEqual(
					[],
				);
				expect((await server.api("get", { refs: ["C-1"] }))[0]).toMatchObject({
					title: "Searchable new case",
					version: 1,
				});
				expect(h.errors).toEqual([]);
			} finally {
				release();
				await h.close();
				await server.stop();
			}
		},
		30_000,
	);
}

test.skipIf(!browserAvailable)(
	"a late run plan records its result without reopening the run",
	async () => {
		const server = await startServer({ cases: 2 });
		const browser = await openPage(server, { path: "/p/scratch/runs" });
		const reply = await holdReply(browser.page, "**/api/p/scratch/plan");
		try {
			const { page } = browser;
			await page.getByRole("listbox", { name: "Runs", exact: true }).waitFor();
			await page.keyboard.press("n");
			await page.getByLabel("Run name").fill("A late plan");
			await page.getByRole("button", { name: "Enter Plan run", exact: true }).click();
			await reply.arrived;
			await page.keyboard.type("gs");
			await page.getByRole("textbox", { name: "Filter cases", exact: true }).waitFor();
			reply.release();
			await page.locator("#stat").filter({ hasText: "planned with" }).waitFor();
			expect(new URL(page.url()).pathname).toBe("/p/scratch/suite");
			expect((await server.api("find", { in: "runs" })).items.find((run) => run.name === "A late plan")).toMatchObject({
				name: "A late plan",
				slots: 2,
			});
			expect(browser.errors).toEqual([]);
		} finally {
			reply.release();
			await browser.close();
			await server.stop();
		}
	},
	30_000,
);

test.skipIf(!browserAvailable)(
	"a late project creation records its result without switching projects",
	async () => {
		const server = await startServer({ cases: 2 });
		const browser = await openPage(server, { path: "/p/scratch/settings" });
		const reply = await holdReply(
			browser.page,
			"**/api/admin",
			(input) => z.object({ do: z.literal("project.create") }).safeParse(input).success,
		);
		try {
			const { page } = browser;
			await page.getByRole("option", { name: "Projects", exact: true }).click();
			await page.getByLabel("Project key", { exact: true }).fill("late-project");
			await page.getByRole("button", { name: "Create project", exact: true }).click();
			await reply.arrived;
			await page.keyboard.type("gs");
			await page.getByRole("textbox", { name: "Filter cases", exact: true }).waitFor();
			reply.release();
			await page.locator("#stat").filter({ hasText: "Project late-project created." }).waitFor();
			expect(new URL(page.url()).pathname).toBe("/p/scratch/suite");
			expect(await server.api("admin", { do: "project.list" })).toEqual(
				expect.arrayContaining([expect.objectContaining({ key: "late-project" })]),
			);
			expect(browser.errors).toEqual([]);
		} finally {
			reply.release();
			await browser.close();
			await server.stop();
		}
	},
	30_000,
);

test.skipIf(!browserAvailable)(
	"a late quarantine proposal records its question without reopening the queue",
	async () => {
		const server = await startServer({ cases: 2 });
		await server.api("report", ciReport({ commit: "aaaa0001", n: 1 }));
		const browser = await openPage(server, { path: "/p/scratch/settings" });
		const reply = await holdReply(browser.page, "**/api/p/scratch/propose");
		try {
			const { page } = browser;
			const panel = page.getByRole("region", { name: "Quarantined tests" });
			await panel.getByLabel("Test ref").fill("T-1");
			await panel.getByLabel("Quarantine reason").fill("A late quarantine proposal");
			await panel.getByRole("button", { name: "Propose quarantine", exact: true }).click();
			await reply.arrived;
			await page.keyboard.type("gs");
			await page.getByRole("textbox", { name: "Filter cases", exact: true }).waitFor();
			reply.release();
			await page.waitForFunction(
				() =>
					document.getElementById("stat")?.textContent?.includes("Quarantine proposal") ||
					location.pathname.startsWith("/p/scratch/queue/"),
			);
			expect(new URL(page.url()).pathname).toBe("/p/scratch/suite");
			expect(
				(await server.api("inbox", { kind: "adopt" })).items.find((question) => question.title === "Quarantine T-1"),
			).toMatchObject({ title: "Quarantine T-1", state: "open" });
			expect(browser.errors).toEqual([]);
		} finally {
			reply.release();
			await browser.close();
			await server.stop();
		}
	},
	30_000,
);

for (const choice of ["same address", "leave and return", "history"] as const) {
	test.skipIf(!browserAvailable)(
		`a late home lookup preserves a later ${choice} navigation`,
		async () => {
			const server = await startServer({ cases: 2 });
			const run = await server.api("plan", { name: "Home run", select: { cases: ["C-1"] } });
			const browser = await openPage(server, { path: "/p/scratch/settings" });
			const { page } = browser;
			const reply = await holdReply(
				page,
				"**/api/p/scratch/get",
				(input) => z.object({ refs: z.tuple([z.literal(run.run)]) }).safeParse(input).success,
			);
			try {
				await page.getByRole("option", { name: "Your home", exact: true }).click();
				await page.getByLabel("Home screen", { exact: true }).selectOption("run");
				await page.getByLabel("Home run", { exact: true }).fill(run.run);
				await page.getByRole("button", { name: "Save home", exact: true }).click();
				await page.getByRole("status").filter({ hasText: "Home saved" }).waitFor();
				await page.keyboard.type("gq");
				await page.getByRole("listbox", { name: "Questions", exact: true }).waitFor();
				await page.keyboard.type("gh");
				await reply.arrived;
				if (choice !== "same address") {
					await page.keyboard.type("gs");
					await page.getByRole("textbox", { name: "Filter cases", exact: true }).waitFor();
				}
				if (choice === "history") await page.goBack();
				else await page.keyboard.type("gq");
				await page.getByRole("listbox", { name: "Questions", exact: true }).waitFor();
				const answered = page.waitForResponse(
					(response) => response.url().endsWith("/get") && response.request().postDataJSON().refs?.[0] === run.run,
				);
				reply.release();
				await (await answered).finished();
				await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
				expect(new URL(page.url()).pathname).toBe("/p/scratch/queue");
				expect(await page.getByRole("listbox", { name: "Questions", exact: true }).isVisible()).toBe(true);
				expect(browser.errors).toEqual([]);
			} finally {
				reply.release();
				await browser.close();
				await server.stop();
			}
		},
		30_000,
	);
}
