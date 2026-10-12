// Found by the ninth independent review of the web UI (R9-1) and by the check of its fix.
import { expect, test } from "bun:test";
import type { Page } from "playwright-core";
import { z } from "zod";
import { browserAvailable, eventually, openPage, type Server, startServer } from "./support.ts";

const Head = z.object({
	version: z.number(),
	title: z.string(),
	pre: z.string(),
	methods: z.array(z.enum(["human", "auto", "agent"])),
	automate: z.enum(["none", "not-applicable", "wanted"]),
	steps: z.array(z.object({ id: z.string(), action: z.string(), expected: z.string().nullable() })),
});
const head = async (server: Server) => Head.parse((await server.api("get", { refs: ["C-1"] }))[0]);
const drafts = (page: Page) =>
	page.evaluate(() => Object.keys(localStorage).filter((key) => key.includes(":draft:")).length);
const mergedTitle = (page: Page) => page.getByRole("textbox", { name: "Merged title", exact: true });
const resolve = (page: Page) => page.getByRole("button", { name: "Resolve conflict", exact: true }).click();
const COLLEAGUE = "Open the cart, changed by a colleague";

/**
 * A person edits the title and the second step. A colleague changes the title, so leaving the editor meets a
 * conflict. While the card is open the colleague changes another field, the first step. The person then types
 * the merged title by hand. A merge from here is recorded by the server together with the colleague's step.
 */
async function cardWithANewerChange() {
	const server = await startServer();
	await server.api("propose", {
		edits: [{ op: "create", outline: "Coupon case\n  Open the cart\n  Apply the coupon" }],
	});
	const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
	const { page } = h;
	page.setDefaultTimeout(5000);
	await page.getByRole("button", { name: "Coupon case", exact: true }).waitFor();
	await page.keyboard.press("e");
	await page.getByRole("textbox", { name: "Case title", exact: true }).fill("Coupon case mine");
	await page.getByRole("textbox", { name: "Step 2", exact: true }).fill("Apply the coupon SAVE10");
	await server.api("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Coupon case theirs" } }] });
	await page.keyboard.press("Escape");
	await page.locator(".conflict-card").waitFor();
	const theirs = await head(server);
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
					steps: theirs.steps.map((step, index) => (index === 0 ? { ...step, action: COLLEAGUE } : step)),
				},
			},
		],
	});
	await eventually(
		() => head(server),
		(value) => value.version === 3,
	);
	await mergedTitle(page).fill("Coupon case, merged by hand");
	return {
		server,
		h,
		page,
		close: async () => {
			await h.close();
			await server.stop();
		},
	};
}
/** The server records the merge and the page never hears: the reply to the next `decide` is dropped. */
async function loseTheNextMergeReply(page: Page) {
	let lost = false;
	await page.route("**/decide", async (route) => {
		if (lost) return route.continue();
		lost = true;
		await route.fetch();
		await route.abort("failed");
	});
	// A route is in force for the page a moment after it is installed: one round trip closes that window.
	await page.evaluate(() => undefined);
}
/** Version 4 holds the typed title, the person's step and the colleague's step, and stays the head. */
async function expectTheMergeToStand(server: Server, page: Page) {
	await eventually(
		() => drafts(page),
		(count) => count === 0,
	);
	await page.keyboard.press("Escape");
	await Bun.sleep(1500);
	const after = await head(server);
	expect(after.version).toBe(4);
	expect(after.title).toBe("Coupon case, merged by hand");
	expect(after.steps.map((step) => step.action)).toEqual([COLLEAGUE, "Apply the coupon SAVE10"]);
}

const check = test.skipIf(!browserAvailable);

check(
	"a merge typed by hand that the server combines with a colleague's newer change leaves no draft to undo it",
	async () => {
		const { server, h, page, close } = await cardWithANewerChange();
		try {
			await resolve(page);
			const merged = await eventually(
				() => head(server),
				(value) => value.version === 4,
			);
			expect(merged.steps.map((step) => step.action)).toEqual([COLLEAGUE, "Apply the coupon SAVE10"]);
			await page.locator(".conflict-card").waitFor({ state: "detached" });
			await expectTheMergeToStand(server, page);
			expect(h.errors).toEqual([]);
		} finally {
			await close();
		}
	},
	30_000,
);

for (const recovery of ["a second press", "a reload"]) {
	check(
		`such a merge whose reply was lost stands after ${recovery}`,
		async () => {
			const { server, page, close } = await cardWithANewerChange();
			try {
				await loseTheNextMergeReply(page);
				await resolve(page);
				await eventually(
					() => head(server),
					(value) => value.version === 4,
				);
				await page.getByText("Your draft and conflict card are kept", { exact: false }).first().waitFor();
				if (recovery === "a reload") await page.reload();
				else await resolve(page);
				await page.getByText("Conflict resolved", { exact: false }).first().waitFor();
				await page.locator(".conflict-card").waitFor({ state: "detached" });
				await expectTheMergeToStand(server, page);
			} finally {
				await close();
			}
		},
		30_000,
	);
}

check(
	"text typed in the card after a lost merge reply is kept on the recorded head, with the colleague's change",
	async () => {
		const { server, page, close } = await cardWithANewerChange();
		try {
			await loseTheNextMergeReply(page);
			await resolve(page);
			await eventually(
				() => head(server),
				(value) => value.version === 4,
			);
			await page.getByText("Your draft and conflict card are kept", { exact: false }).first().waitFor();
			await mergedTitle(page).fill("Coupon case, merged by hand, and later words");
			await resolve(page);
			await page.getByText("later text is kept", { exact: false }).first().waitFor();
			// The later words are a draft on version 4, and the draft has the colleague's step, not the old one.
			expect(await page.getByRole("textbox", { name: "Step 1", exact: true }).inputValue()).toBe(COLLEAGUE);
			await page.keyboard.press("Escape");
			const saved = await eventually(
				() => head(server),
				(value) => value.version === 5,
			);
			expect(saved.title).toBe("Coupon case, merged by hand, and later words");
			expect(saved.steps.map((step) => step.action)).toEqual([COLLEAGUE, "Apply the coupon SAVE10"]);
		} finally {
			await close();
		}
	},
	30_000,
);
