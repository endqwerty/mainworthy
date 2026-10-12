import { expect, test } from "bun:test";
import { browserAvailable, eventually, openPage, startServer } from "./support.ts";

test.skipIf(!browserAvailable)(
	"same-field edits retain both sides until a merge decision makes the next version",
	async () => {
		const server = await startServer();
		await server.api("propose", {
			edits: [{ op: "create", outline: "Original title\n  Apply coupon > Coupon accepted" }],
		});
		const browser = await openPage(server, { path: "/p/scratch/suite/c/1" });
		try {
			const { page } = browser;
			await page.getByRole("button", { name: "Original title", exact: true }).waitFor();
			await page.keyboard.press("e");
			await page.getByRole("textbox", { name: "Case title", exact: true }).fill("My title");
			await server.api("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Their title" } }] });
			await page.keyboard.press("Escape");
			const conflict = page.getByRole("region", { name: "Edit conflict" });
			await conflict.waitFor();
			expect(await conflict.textContent()).toContain("My title");
			expect(await conflict.textContent()).toContain("Their title");
			const current = (await server.api("get", { refs: ["C-1"] }))[0];
			expect(current?.title).toBe("Their title");
			expect(current?.version).toBe(2);
			await conflict.getByRole("button", { name: "Use my title", exact: true }).click();
			await conflict.getByRole("button", { name: "Resolve conflict", exact: true }).click();
			const merged = await eventually(
				() => server.api("get", { refs: ["C-1"] }),
				(value) => value[0]?.version === 3,
			);
			expect(merged[0]?.title).toBe("My title");
			const history = await server.api("history", { ref: "C-1" });
			expect(Array.isArray(history.versions) ? history.versions.length : 0).toBe(3);
			expect(browser.errors).toEqual([]);
		} finally {
			await browser.close();
			await server.stop();
		}
	},
	30_000,
);
