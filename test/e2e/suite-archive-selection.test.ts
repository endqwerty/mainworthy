import { expect, test } from "bun:test";
import { z } from "zod";
import { browserAvailable, eventually, openPage, startServer } from "./support.ts";

for (const initial of ["active", "archived"] as const) {
	test.skipIf(!browserAvailable)(
		`archive shortcut reads ${initial} picks hidden by a filter`,
		async () => {
			const server = await startServer();
			await server.api("propose", {
				edits: [
					{ op: "create", outline: "Hidden selected" },
					{ op: "create", outline: "Visible selected" },
					{ op: "create", outline: "Visible untouched" },
				],
			});
			if (initial === "archived")
				await server.api("propose", { edits: [{ op: "state", cases: ["C-1", "C-2", "C-3"], to: initial }] });
			const h = await openPage(server, { path: `/p/scratch/suite/c/1?state=${initial}` });
			try {
				const { page } = h;
				await page.getByRole("button", { name: "Hidden selected", exact: true }).waitFor();
				await page.keyboard.press("x");
				await page.getByRole("option").filter({ hasText: "Visible selected" }).click();
				await page.keyboard.press("x");
				await page.getByRole("textbox", { name: "Filter cases" }).fill("Visible");
				await page.getByRole("option").filter({ hasText: "Hidden selected" }).waitFor({ state: "detached" });
				await page.getByRole("option").filter({ hasText: "Visible selected" }).click();
				expect(await page.locator(".bulk-indicator").textContent()).toBe("2 selected");
				await page.keyboard.press("ControlOrMeta+k");
				await page.getByRole("option", { name: /Archive or restore selected/ }).waitFor();
				await page.keyboard.press("Escape");
				await page.keyboard.press("#");
				try {
					await page.locator("#stat").filter({ hasText: "2 cases changed." }).waitFor();
				} catch (cause) {
					throw new Error(`Archive did not finish: ${await page.locator("#stat").textContent()}`, { cause });
				}
				const changed = initial === "active" ? "archived" : "active";
				expect(
					(
						await eventually(
							() => server.api("get", { refs: ["C-1", "C-2", "C-3"] }),
							(rows) => rows[0]?.state === changed && rows[1]?.state === changed,
						)
					).map((row) => row.state),
				).toEqual([changed, changed, initial]);
				expect(h.errors).toEqual([]);
			} finally {
				await h.close();
				await server.stop();
			}
		},
		20_000,
	);
}

test.skipIf(!browserAvailable)(
	"an unreadable hidden archive pick changes nothing and can be retried",
	async () => {
		const server = await startServer();
		await server.api("propose", {
			edits: [
				{ op: "create", outline: "Hidden selected" },
				{ op: "create", outline: "Visible selected" },
			],
		});
		const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
		try {
			const { page } = h;
			await page.getByRole("button", { name: "Hidden selected", exact: true }).waitFor();
			await page.keyboard.press("x");
			await page.getByRole("option").filter({ hasText: "Visible selected" }).click();
			await page.keyboard.press("x");
			await page.getByRole("textbox", { name: "Filter cases" }).fill("Visible");
			await page.getByRole("option").filter({ hasText: "Hidden selected" }).waitFor({ state: "detached" });
			await page.getByRole("option").filter({ hasText: "Visible selected" }).click();
			await page.context().route("**/api/p/scratch/get", async (route) => {
				const input = z.object({ refs: z.array(z.string()) }).parse(route.request().postDataJSON());
				if (!input.refs.includes("C-1")) return route.continue();
				await route.fulfill({
					status: 503,
					contentType: "application/json",
					body: JSON.stringify({ ok: false, error: { code: "internal", message: "Selected case unavailable" } }),
				});
			});
			await page.keyboard.press("#");
			await page.locator("#stat").filter({ hasText: "Selected case unavailable" }).waitFor();
			expect((await server.api("get", { refs: ["C-1", "C-2"] })).map((row) => row.state)).toEqual(["active", "active"]);
			expect(await page.locator(".bulk-indicator").textContent()).toBe("2 selected");
			await page.context().unroute("**/api/p/scratch/get");
			await page.keyboard.press("#");
			await page.locator("#stat").filter({ hasText: "2 cases changed." }).waitFor();
			expect((await server.api("get", { refs: ["C-1", "C-2"] })).map((row) => row.state)).toEqual([
				"archived",
				"archived",
			]);
			expect(h.errors).toEqual([
				"Failed to load resource: the server responded with a status of 503 (Service Unavailable)",
			]);
		} finally {
			await h.close();
			await server.stop();
		}
	},
	20_000,
);
