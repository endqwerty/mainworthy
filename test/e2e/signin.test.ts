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
						response.status() === 401 && response.url().endsWith(surface === "case draft" ? "/propose" : "/report"),
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
			expect(await page.locator(".sfoot .me").textContent()).toContain("daniel");
			expect(browser.errors).toEqual([]);
		} finally {
			await browser.close();
			await server.stop();
		}
	},
	30_000,
);
