import { expect, test } from "bun:test";
import { z } from "zod";
import { browserAvailable, eventually, openPage, startServer } from "./support.ts";

for (const surface of ["case draft", "run note"]) {
	test.skipIf(!browserAvailable)(
		`UI-4 a revoked session returns to sign-in, and the ${surface} comes back for the person who typed it and nobody else`,
		async () => {
			const server = await startServer({ mode: "server" });
			await server.api("propose", {
				edits: [
					{
						op: "create",
						body: { title: "Existing case", steps: [{ id: "aa", action: "Original step", expected: null }] },
					},
				],
			});
			const run = await server.api("plan", { name: "Re-authentication", select: { cases: ["C-1"] } });
			const issued = z.object({ token: z.string() }).parse(
				await server.api("admin", {
					do: "token.create",
					actor: "writer",
					kind: "human",
					can: ["read", "produce"],
					project: "scratch",
				}),
			);
			const tokens = z
				.array(z.object({ id: z.number(), actor: z.string() }))
				.parse(await server.api("admin", { do: "token.list" }));
			const tokenId = tokens.find((token) => token.actor === "writer")?.id;
			if (tokenId === undefined) throw new Error("Scoped grant missing");
			const browser = await openPage(server, {
				signedIn: false,
				path: surface === "case draft" ? "/p/scratch/suite/c/1" : `/p/scratch/runs/${run.run.slice(2)}`,
			});
			try {
				const { page } = browser;
				await page.getByRole("textbox", { name: "Sign in with your token" }).fill(issued.token);
				await page.keyboard.press("Enter");
				await page.locator("#app").waitFor();
				if (surface === "case draft") {
					await page.getByRole("button", { name: "Existing case", exact: true }).waitFor();
					await page.keyboard.press("e");
					await page.getByRole("textbox", { name: "Step 1", exact: true }).fill("Keep this private sentence");
				} else {
					await page.locator('.run-document[data-active="true"][data-ready="true"] .rsteps').waitFor();
					await page.keyboard.press("f");
					await page.keyboard.type("Keep this failure note");
				}
				await server.api("admin", { do: "token.revoke", id: tokenId });
				const refused = page.waitForResponse(
					(response) =>
						response.status() === 401 &&
						(response.url().endsWith("/session") ||
							response.url().endsWith(surface === "case draft" ? "/propose" : "/report")),
				);
				await page.keyboard.press(surface === "case draft" ? "Escape" : "Enter");
				await refused;
				await page.locator("#token").waitFor({ timeout: 4000 });
				expect(await page.locator("#app").count()).toBe(0);
				expect((await server.api("get", { refs: ["C-1"] }))[0]?.version).toBe(1);
				// Somebody else signs in on this browser. What the writer typed is not shown to them.
				await page.getByRole("textbox", { name: "Sign in with your token" }).fill(server.token);
				await page.keyboard.press("Enter");
				await page.locator("#app").waitFor();
				if (surface === "case draft") {
					await page.getByRole("button", { name: "Existing case", exact: true }).waitFor();
					expect(await page.getByRole("textbox", { name: "Step 1", exact: true }).count()).toBe(0);
				} else {
					await page.locator('.run-document[data-active="true"][data-ready="true"] .rsteps').waitFor();
					await page.keyboard.press("f");
					expect(await page.getByRole("textbox", { name: "Result note" }).inputValue()).toBe("");
					await page.keyboard.press("Escape");
				}
				expect(await page.getByText("Keep this", { exact: false }).count()).toBe(0);
				// The writer signs in again with a new token: it is all still there, and it is recorded as theirs.
				const again = z.object({ token: z.string() }).parse(
					await server.api("admin", {
						do: "token.create",
						actor: "writer",
						kind: "human",
						can: ["read", "produce"],
						project: "scratch",
					}),
				);
				await browser.context.clearCookies();
				await page.reload();
				await page.getByRole("textbox", { name: "Sign in with your token" }).fill(again.token);
				await page.keyboard.press("Enter");
				await page.locator("#app").waitFor();
				if (surface === "case draft") {
					const step = page.getByRole("textbox", { name: "Step 1", exact: true });
					expect(await step.inputValue()).toBe("Keep this private sentence");
					await page.keyboard.press("Control+Enter");
					const rows = await eventually(
						() => server.api("get", { refs: ["C-1"] }),
						(rows) => rows[0]?.version === 2,
					);
					expect(rows[0]?.steps).toMatchObject([{ action: "Keep this private sentence" }]);
					const timeline = await server.api("timeline", { ref: "C-1" });
					expect(timeline.entries.find((entry) => entry.t === "version" && entry.version === 2)).toMatchObject({
						by: "writer",
					});
				} else {
					await page.locator('.run-document[data-active="true"][data-ready="true"] .rsteps').waitFor();
					const note = page.getByRole("textbox", { name: "Result note" });
					expect(await note.inputValue()).toBe("Keep this failure note");
					await page.keyboard.press("f");
					await page.keyboard.press("Enter");
					const slots = await eventually(
						() => server.api("find", { in: "slots", run: run.run }),
						(reply) => reply.items.some((slot) => Array.isArray(slot.fills) && slot.fills.length > 0),
					);
					expect(slots.items[0]?.fills).toMatchObject([
						{ outcome: "fail", note: "Keep this failure note", by: "writer" },
					]);
				}
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
	"server sign-in rejects a wrong token and accepts the owner token",
	async () => {
		const server = await startServer({ mode: "server" });
		const browser = await openPage(server, { signedIn: false });
		try {
			const { page } = browser;
			const token = page.getByRole("textbox", { name: "Sign in with your token" });
			await token.fill("not-a-valid-owner-token");
			await page.keyboard.press("Enter");
			await page.getByRole("status").filter({ hasText: "not accepted" }).waitFor();
			expect(await page.locator("#app").count()).toBe(0);
			await token.fill(server.token);
			await page.keyboard.press("Enter");
			await page.locator("#app").waitFor();
			expect(await page.locator(".sfoot .me").textContent()).toContain("robin");
			expect(browser.errors).toEqual([]);
		} finally {
			await browser.close();
			await server.stop();
		}
	},
	30_000,
);

for (const request of ["session", "password"])
	test.skipIf(!browserAvailable)(
		`a late ${request} 401 cannot undo a newer sign-in (issue #447)`,
		async () => {
			const server = await startServer({ mode: "server" });
			const next = z.object({ token: z.string() }).parse(
				await server.api("admin", {
					do: "token.create",
					actor: "sam",
					kind: "human",
					can: ["read", "produce"],
					project: "scratch",
				}),
			);
			const browser = await openPage(server, { path: "/p/scratch/settings" });
			const arrived = Promise.withResolvers<number>();
			const held = Promise.withResolvers<void>();
			try {
				const { page } = browser;
				page.setDefaultTimeout(5000);
				await page.getByRole("option", { name: "Your sign-in", exact: true }).click();
				await page.locator("#password-next").fill("a password for the old session");
				await page.locator("#password-again").fill("a password for the old session");
				let intercepted = false;
				await page.route(request === "session" ? "**/api/session" : "**/api/account/password", async (route) => {
					if (intercepted) return route.continue();
					intercepted = true;
					// Get a real expired-session refusal, then hold its reply while this tab signs in again.
					const response = await route.fetch({ headers: { ...route.request().headers(), cookie: "" } });
					arrived.resolve(response.status());
					await held.promise;
					await route.fulfill({ response });
				});
				await page.getByRole("button", { name: "Set password", exact: true }).click();
				expect(await arrived.promise).toBe(401);
				await page.getByRole("button", { name: "Sign out", exact: true }).click();
				await page.getByRole("button", { name: "Sign out and keep drafts", exact: true }).click();
				await page.locator("#token").fill(request === "session" ? next.token : server.token);
				await page.keyboard.press("Enter");
				await page.locator("#app").waitFor();
				const actor = request === "session" ? "sam" : "robin";
				expect(await page.locator(".sfoot .me").textContent()).toContain(actor);
				// Count only sign-outs after the new session is established, including a same-actor re-sign-in.
				await page.evaluate(() => {
					Reflect.set(window, "late401SignOuts", 0);
					window.addEventListener("mainworthy:unauthenticated", () => {
						Reflect.set(window, "late401SignOuts", Number(Reflect.get(window, "late401SignOuts")) + 1);
					});
				});
				const completed = page.waitForEvent("requestfinished", {
					predicate: (sent) => sent.url().endsWith(request === "session" ? "/api/session" : "/api/account/password"),
				});
				held.resolve();
				await completed;
				expect(await page.evaluate((): unknown => Reflect.get(window, "late401SignOuts"))).toBe(0);
				await page.getByRole("link", { name: "Suite", exact: true }).click();
				await page.keyboard.press("c");
				await page.getByRole("textbox", { name: "Case title", exact: true }).fill("Created after the late refusal");
				await page.keyboard.press("Control+Enter");
				const found = await eventually(
					() => server.api("find", { in: "cases" }),
					(result) => result.items.some((row) => row.title === "Created after the late refusal"),
				);
				expect(found.items).toHaveLength(1);
				expect((await server.api("timeline", { ref: "C-1" })).entries).toContainEqual(
					expect.objectContaining({ t: "version", version: 1, by: actor }),
				);
				expect(await page.locator("#app").count()).toBe(1);
				expect(browser.errors).toEqual([]);
			} finally {
				held.resolve();
				await browser.close();
				await server.stop();
			}
		},
		30_000,
	);
