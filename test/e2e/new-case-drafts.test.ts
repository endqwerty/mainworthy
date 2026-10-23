import { expect, test } from "bun:test";
import { z } from "zod";
import { browserAvailable, eventually, openPage, type Server, startServer } from "./support.ts";

const check = test.skipIf(!browserAvailable);

async function accept(server: Server): Promise<void> {
	const question = (await server.api("inbox", { kind: "adopt" })).items[0];
	if (!question) throw new Error("Adoption question missing");
	const [reply] = await server.api("decide", {
		q: question.q,
		onEvidence: question.evidenceHash,
		answer: { is: "accept" },
		reason: "Reviewed the case",
	});
	expect(reply?.status).toBe("decided");
}

for (const leave of ["navigate", "start another case"]) {
	check(
		`a new case holding only an expected result survives ${leave} and reloading`,
		async () => {
			const server = await startServer();
			const browser = await openPage(server);
			try {
				const { page } = browser;
				await page.keyboard.press("c");
				await page.keyboard.press("Enter");
				await page.keyboard.press("Tab");
				const input = page.getByRole("textbox", { name: "Expected result 1", exact: true });
				await input.fill("The purchase is confirmed");
				expect(await input.inputValue()).toBe("The purchase is confirmed");
				if (leave === "start another case") {
					await page.keyboard.press("Shift+Enter");
					await page.getByRole("option").filter({ hasText: "draft" }).first().click();
				} else await page.getByRole("link", { name: "Runs", exact: true }).click();
				await page.reload();
				const drafts = await page.evaluate(() =>
					Object.keys(localStorage)
						.filter((key) => key.includes(":draft:"))
						.map((key) => localStorage.getItem(key)),
				);
				expect(JSON.stringify(drafts)).toContain("The purchase is confirmed");
				await page.goto(`${server.url}/p/scratch/suite`);
				await input.waitFor();
				expect(await input.inputValue()).toBe("The purchase is confirmed");
				expect((await server.api("get", { refs: ["C-1"] }))[0]).toMatchObject({ title: "", steps: [], version: 1 });
				await page.getByRole("textbox", { name: "Step 1", exact: true }).fill("Complete the purchase");
				await page.keyboard.press("Escape");
				const recorded = await eventually(
					() => server.api("get", { refs: ["C-1"] }),
					(rows) => rows[0]?.version === 2,
				);
				expect(recorded[0]?.steps).toMatchObject([
					{ action: "Complete the purchase", expected: "The purchase is confirmed" },
				]);
				expect(browser.errors).toEqual([]);
			} finally {
				await browser.close();
				await server.stop();
			}
		},
		30_000,
	);
}

for (const when of ["after reply", "before reply", "after reload", "with an older stored draft"]) {
	check(
		`continuing a new-case proposal accepted ${when} edits the created case`,
		async () => {
			const server = await startServer({ preset: "strict" });
			const browser = await openPage(server);
			try {
				const { page } = browser;
				if (when === "before reply") {
					let first = true;
					await page.route("**/propose", async (route) => {
						const response = await route.fetch();
						if (first) {
							first = false;
							await accept(server);
						}
						await route.fulfill({ response });
					});
				}
				await page.keyboard.press("c");
				await page.keyboard.type("Proposed case");
				await page.keyboard.press("Escape");
				if (when !== "before reply") {
					await page.locator("#stat").filter({ hasText: "Proposed, waiting for a person" }).waitFor();
					if (when === "after reload" || when === "with an older stored draft") {
						// End the Suite document while the question is open. A client-side departure can still
						// settle its save after acceptance and remove the draft this reload needs to recover.
						await page.goto(`${server.url}/p/scratch/runs`);
						await page.getByRole("listbox", { name: "Runs", exact: true }).waitFor();
						if (when === "with an older stored draft") {
							const changed = await page.evaluate(() => {
								let changed = 0;
								for (const key of Object.keys(localStorage)) {
									if (!key.includes(":draft:")) continue;
									const draft = JSON.parse(localStorage.getItem(key) ?? "null");
									if (draft?.submission?.kind === "waiting") {
										localStorage.setItem(key, JSON.stringify({ ...draft, sent: null }));
										changed++;
									}
								}
								return changed;
							});
							expect(changed).toBe(1);
						}
						await accept(server);
						await page.goto(`${server.url}/p/scratch/suite`);
					} else await accept(server);
				}
				await page.getByRole("option").filter({ hasText: "C-1" }).waitFor();
				const title = page.getByRole("textbox", { name: "Case title", exact: true });
				await title.fill("Proposed case continued");
				await title.press("Escape");
				await eventually(
					() => server.api("inbox", { kind: "adopt" }),
					(reply) => reply.items.length === 1,
				);
				await accept(server);
				const cases = await server.api("find", { in: "cases" });
				expect(cases.items.map(({ ref, title }) => ({ ref, title }))).toEqual([
					{ ref: "C-1", title: "Proposed case continued" },
				]);
				await eventually(
					() => page.locator(".cstate").textContent(),
					(text) => text?.includes("v2") === true,
				);
				expect(await page.locator(".cstate").textContent()).not.toContain("Private");
				expect(await page.locator("#stat").textContent()).not.toContain("waiting for a person");
				expect(z.number().parse((await server.api("get", { refs: ["C-1"] }))[0]?.version)).toBe(2);
				expect(browser.errors).toEqual([]);
			} finally {
				await browser.close();
				await server.stop();
			}
		},
		30_000,
	);
}

check(
	"text and tags typed while approval waits stay on the accepted case's draft",
	async () => {
		const server = await startServer({ preset: "strict" });
		const browser = await openPage(server);
		try {
			const { page } = browser;
			await page.keyboard.press("c");
			await page.keyboard.type("Proposed case #first");
			await page.keyboard.press("Escape");
			await page.locator("#stat").filter({ hasText: "Proposed, waiting for a person" }).waitFor();
			const title = page.getByRole("textbox", { name: "Case title", exact: true });
			await title.fill("Continued case #later");
			await title.press("Enter");
			await page.keyboard.press("Tab");
			const expected = page.getByRole("textbox", { name: "Expected result 1", exact: true });
			await expected.fill("The purchase is confirmed");
			await expected.press("Escape");
			expect((await server.api("inbox", { kind: "adopt" })).items.map(({ title }) => title)).toEqual([
				"New case: Proposed case",
			]);
			await accept(server);
			await eventually(
				() => page.locator(".cstate").textContent(),
				(text) => text?.includes("version 1") === true,
			);
			expect(await title.inputValue()).toBe("Continued case");
			expect(await expected.inputValue()).toBe("The purchase is confirmed");
			expect((await server.api("get", { refs: ["C-1"] }))[0]).toMatchObject({
				title: "Proposed case",
				tags: ["first"],
				version: 1,
			});
			await title.press("Escape");
			await eventually(
				() => server.api("inbox", { kind: "adopt" }),
				(reply) => reply.items.length === 1,
			);
			await accept(server);
			await eventually(
				() => page.locator(".cstate").textContent(),
				(text) => text?.includes("version 2") === true,
			);
			expect((await server.api("get", { refs: ["C-1"] }))[0]).toMatchObject({
				title: "Continued case",
				tags: ["first", "later"],
				version: 2,
			});
			const placed = await eventually(
				() => server.api("find", { in: "cases" }),
				(reply) => reply.items.some((row) => Array.isArray(row.tags) && row.tags.includes("later")),
			);
			expect(placed.items.map(({ ref, title, tags }) => ({ ref, title, tags }))).toEqual([
				{ ref: "C-1", title: "Continued case", tags: ["first", "later"] },
			]);
			expect((await server.api("get", { refs: ["C-1"] }))[0]?.version).toBe(2);
			expect(await expected.inputValue()).toBe("The purchase is confirmed");
			expect(browser.errors).toEqual([]);
		} finally {
			await browser.close();
			await server.stop();
		}
	},
	30_000,
);

for (const [status, code] of [
	[500, "internal"],
	[429, "limited"],
	[403, "forbidden"],
] as const) {
	check(
		`a ${status} read of the waiting question keeps the link to the proposal`,
		async () => {
			const server = await startServer({ preset: "strict" });
			const browser = await openPage(server);
			try {
				const { page } = browser;
				const stored = async () =>
					z
						.array(
							z.object({
								submission: z.object({ kind: z.string(), question: z.string().optional() }),
								sent: z.unknown(),
							}),
						)
						.parse(
							await page.evaluate(() =>
								Object.keys(localStorage)
									.filter((key) => key.includes(":draft:"))
									.map((key) => JSON.parse(localStorage.getItem(key) ?? "null")),
							),
						);
				await page.keyboard.press("c");
				await page.keyboard.type("Proposed case");
				await page.keyboard.press("Escape");
				await page.locator("#stat").filter({ hasText: "Proposed, waiting for a person" }).waitFor();
				const before = await stored();
				expect(before).toMatchObject([
					{
						submission: { kind: "waiting", question: (await server.api("inbox", { kind: "adopt" })).items[0]?.q },
						sent: { input: { edits: [{ op: "create" }] } },
					},
				]);
				let failing = true;
				await page.route("**/get", async (route) => {
					if (failing && (route.request().postData() ?? "").includes('"Q-')) {
						await route.fulfill({
							status,
							contentType: "application/json",
							body: JSON.stringify({ ok: false, error: { code, message: "Question read refused" } }),
						});
						return;
					}
					await route.fallback();
				});
				const title = page.getByRole("textbox", { name: "Case title", exact: true });
				await title.fill("Proposed case more");
				await title.press("Escape");
				await page.locator("#stat").filter({ hasText: "Question read refused" }).waitFor();
				expect(await stored()).toEqual(before);
				expect(await title.inputValue()).toBe("Proposed case more");
				failing = false;
				await accept(server);
				await page.getByRole("option").filter({ hasText: "C-1" }).waitFor();
				await title.fill("Proposed case more again");
				await title.press("Escape");
				await eventually(
					() => server.api("inbox", { kind: "adopt" }),
					(reply) => reply.items.length === 1,
				);
				await accept(server);
				expect((await server.api("find", { in: "cases" })).items.map(({ ref, title }) => ({ ref, title }))).toEqual([
					{ ref: "C-1", title: "Proposed case more again" },
				]);
				expect((await server.api("get", { refs: ["C-1"] }))[0]?.version).toBe(2);
			} finally {
				await browser.close();
				await server.stop();
			}
		},
		30_000,
	);
}
