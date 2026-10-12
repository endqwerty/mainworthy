import { expect, test } from "bun:test";
import { browserAvailable, eventually, openPage, startServer } from "./support.ts";

test.skipIf(!browserAvailable)(
	"tagging updates the case before its request finishes and undo records the inverse",
	async () => {
		const server = await startServer();
		await server.api("propose", { edits: [{ op: "create", body: { title: "Tag this case" } }] });
		const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
		try {
			const { page } = h;
			await page.getByRole("button", { name: "Tag this case", exact: true }).waitFor();
			await page.route("**/api/p/scratch/propose", async (route) => {
				await Bun.sleep(300);
				await route.continue();
			});
			await page.keyboard.press("t");
			await page.keyboard.type("checkout");
			await page.keyboard.press("Enter");
			expect(await page.locator(".ctags").textContent()).toContain("#checkout");
			expect((await server.api("get", { refs: ["C-1"] }))[0]?.tags).toEqual([]);
			await eventually(
				() => server.api("get", { refs: ["C-1"] }),
				(rows) => Array.isArray(rows[0]?.tags) && rows[0]?.tags.includes("checkout"),
			);
			await page.keyboard.press("u");
			const undone = await eventually(
				() => server.api("get", { refs: ["C-1"] }),
				(rows) => Array.isArray(rows[0]?.tags) && rows[0]?.tags.length === 0,
			);
			expect(undone[0]?.version).toBe(1);
			expect(h.errors).toEqual([]);
		} finally {
			await h.close();
			await server.stop();
		}
	},
	30_000,
);
