import { expect, test } from "bun:test";
import { browserAvailable, eventually, openPage, startServer } from "./support.ts";

test.skipIf(!browserAvailable)(
	"a disjoint merge remains in the draft baseline for the next edit",
	async () => {
		const server = await startServer();
		await server.api("propose", {
			edits: [
				{
					op: "create",
					body: {
						title: "Original title",
						pre: "Original prerequisite",
						steps: [{ id: "a1", action: "Open cart", expected: null }],
					},
				},
			],
		});
		const browser = await openPage(server, { path: "/p/scratch/suite/c/1" });
		try {
			const { page } = browser;
			await page.getByRole("button", { name: "Original title", exact: true }).waitFor();
			await page.keyboard.press("e");
			await page.getByRole("textbox", { name: "Case title", exact: true }).fill("My title");
			await server.api("propose", {
				edits: [{ op: "edit", case: "C-1", base: 1, body: { pre: "Remote prerequisite" } }],
			});
			await page.keyboard.press("Escape");
			await eventually(
				() => server.api("get", { refs: ["C-1"] }),
				(rows) => rows[0]?.version === 3,
			);
			await page.waitForFunction(() => document.querySelector(".cstate")?.textContent?.includes("v3"));
			await page.keyboard.press("e");
			await page.getByRole("textbox", { name: "Step 1", exact: true }).fill("Open cart and check quantity");
			await page.keyboard.press("Escape");
			const rows = await eventually(
				() => server.api("get", { refs: ["C-1"] }),
				(value) => value[0]?.version === 4,
			);
			expect(rows[0]?.pre).toBe("Remote prerequisite");
			expect(rows[0]?.title).toBe("My title");
			expect(rows[0]?.steps).toMatchObject([{ action: "Open cart and check quantity" }]);
			expect(browser.errors).toEqual([]);
		} finally {
			await browser.close();
			await server.stop();
		}
	},
	30_000,
);
