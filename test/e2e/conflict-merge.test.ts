// Found by the ninth independent review of the web UI (R9-1).
import { expect, test } from "bun:test";
import { z } from "zod";
import { browserAvailable, eventually, openPage, startServer } from "./support.ts";

const Head = z.object({
	version: z.number(),
	title: z.string(),
	pre: z.string(),
	methods: z.array(z.enum(["human", "auto", "agent"])),
	automate: z.enum(["none", "not-applicable", "wanted"]),
	steps: z.array(z.object({ id: z.string(), action: z.string(), expected: z.string().nullable() })),
});

test.skipIf(!browserAvailable)(
	"a merge typed by hand that the server combines with a colleague's newer change leaves no draft to undo it",
	async () => {
		const server = await startServer();
		await server.api("propose", {
			edits: [{ op: "create", outline: "Coupon case\n  Open the cart\n  Apply the coupon" }],
		});
		const head = async () => Head.parse((await server.api("get", { refs: ["C-1"] }))[0]);
		const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
		try {
			const { page } = h;
			page.setDefaultTimeout(5000);
			await page.getByRole("button", { name: "Coupon case", exact: true }).waitFor();
			await page.keyboard.press("e");
			await page.getByRole("textbox", { name: "Case title", exact: true }).fill("Coupon case mine");
			await page.getByRole("textbox", { name: "Step 2", exact: true }).fill("Apply the coupon SAVE10");
			// A colleague changes the title: leaving the editor meets a conflict.
			await server.api("propose", {
				edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Coupon case theirs" } }],
			});
			await page.keyboard.press("Escape");
			await page.locator(".conflict-card").waitFor();
			// While the card is open the colleague changes another field, the first step.
			const theirs = await head();
			await server.api("propose", {
				edits: [
					{
						op: "edit",
						case: "C-1",
						base: theirs.version,
						body: {
							title: theirs.title,
							pre: theirs.pre,
							methods: theirs.methods,
							automate: theirs.automate,
							steps: theirs.steps.map((step, index) =>
								index === 0 ? { ...step, action: "Open the cart, changed by a colleague" } : step,
							),
						},
					},
				],
			});
			await eventually(head, (value) => value.version === 3);
			await page.getByRole("textbox", { name: "Merged title", exact: true }).fill("Coupon case, merged by hand");
			await page.getByRole("button", { name: "Resolve conflict", exact: true }).click();
			// The server combines the merge with the colleague's step: version 4 has both.
			const merged = await eventually(head, (value) => value.version === 4);
			expect(merged.title).toBe("Coupon case, merged by hand");
			expect(merged.steps.map((step) => step.action)).toEqual([
				"Open the cart, changed by a colleague",
				"Apply the coupon SAVE10",
			]);
			await page.locator(".conflict-card").waitFor({ state: "detached" });
			// Nothing was typed after the merge, so nothing is left on the device to propose,
			const drafts = () =>
				page.evaluate(() => Object.keys(localStorage).filter((key) => key.includes(":draft:")).length);
			await eventually(drafts, (count) => count === 0);
			// and leaving the page's editor state records nothing over the colleague's change.
			await page.keyboard.press("Escape");
			await Bun.sleep(1500);
			const after = await head();
			expect(after.version).toBe(4);
			expect(after.steps[0]?.action).toBe("Open the cart, changed by a colleague");
			expect(h.errors).toEqual([]);
		} finally {
			await h.close();
			await server.stop();
		}
	},
	30_000,
);
