// A hand-typed merge and who may release it: the eighth review's second and third findings (R8-2, R8-3).
import { expect, test } from "bun:test";
import type { Page } from "playwright-core";
import { z } from "zod";
import { browserAvailable, eventually, openPage, startServer } from "./support.ts";

const check = test.skipIf(!browserAvailable);
const title = (page: Page) => page.getByRole("textbox", { name: "Case title", exact: true });
const step = (page: Page) => page.getByRole("textbox", { name: "Step 2", exact: true });
const card = (page: Page) => page.locator(".conflict-card");
const Stored = z.object({
	owner: z.string(),
	cmd: z.string(),
	body: z.object({ title: z.string(), steps: z.array(z.object({ action: z.string() })) }),
});
async function stored(page: Page) {
	return Stored.parse(
		await page.evaluate(() => {
			const key = Object.keys(localStorage).find((key) => key.includes(":draft:") && key.endsWith(":C-1"));
			return key ? JSON.parse(localStorage.getItem(key) ?? "null") : null;
		}),
	);
}
async function windows() {
	const server = await startServer();
	await server.api("propose", {
		edits: [{ op: "create", outline: "Coupon case\n  Open the cart\n  Apply the coupon" }],
	});
	const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
	const a = h.page;
	await a.getByRole("button", { name: "Coupon case", exact: true }).waitFor();
	return {
		server,
		h,
		a,
		openFollower: async () => {
			const b = await h.context.newPage();
			await b.goto(`${server.url}/p/scratch/suite/c/1`);
			await b.getByRole("button", { name: "Coupon case", exact: true }).waitFor();
			return b;
		},
		close: async () => {
			await h.close();
			await server.stop();
		},
	};
}

for (const end of ["rejection", "lost reply then reload"])
	for (const field of ["title", "step"])
		check(
			`R8-2 a hand-typed merged ${field} survives ${end}`,
			async () => {
				const w = await windows();
				let release = () => {};
				const held = new Promise<void>((done) => {
					release = done;
				});
				try {
					const { a, server } = w;
					await a.keyboard.press("e");
					await title(a).fill("Coupon case mine");
					await step(a).fill("Apply coupon mine");
					const steps = z
						.array(z.object({ id: z.string(), action: z.string(), expected: z.string().nullable() }))
						.parse((await server.api("get", { refs: ["C-1"] }))[0]?.steps);
					await server.api("propose", {
						edits: [
							{
								op: "edit",
								case: "C-1",
								base: 1,
								body: {
									title: "Coupon case theirs",
									steps: steps.map((step, index) => (index === 1 ? { ...step, action: "Apply coupon theirs" } : step)),
								},
							},
						],
					});
					await a.keyboard.press("Escape");
					await card(a).waitFor();
					if (end.startsWith("lost")) {
						let received = false;
						await a.route("**/decide", async (route) => {
							await route.fetch();
							received = true;
							await held;
							await route.abort("failed");
						});
						await a.getByRole("button", { name: "Resolve conflict", exact: true }).click();
						await eventually(async () => received, Boolean);
						release();
						await a.getByText("Your draft and conflict card are kept", { exact: false }).first().waitFor();
						await a.unroute("**/decide");
					}
					const edited =
						field === "title"
							? a.getByRole("textbox", { name: "Merged title", exact: true })
							: card(a).locator('textarea[aria-label^="Merged Step ^"]').last();
					await edited.fill("HAND TYPED TEXT");
					if (end === "rejection") {
						const question = (await server.api("inbox", { on: "C-1", kind: "adopt" })).items[0];
						if (!question) throw Error("Missing conflict question");
						await server.api("decide", { q: question.q, onEvidence: question.evidenceHash, answer: { is: "reject" } });
					} else await a.reload();
					await a
						.locator("#bar")
						.filter({ hasText: end === "rejection" ? "typed merge is kept" : "later text is kept" })
						.waitFor();
					await card(a).waitFor({ state: "detached" });
					const input = field === "title" ? title(a) : step(a);
					await input.waitFor();
					expect(await input.inputValue()).toBe("HAND TYPED TEXT");
					expect(JSON.stringify((await stored(a)).body)).toContain("HAND TYPED TEXT");
					await a.reload();
					expect(await input.inputValue()).toBe("HAND TYPED TEXT");
					await a.keyboard.press("Escape");
					if (end === "rejection") {
						await card(a).waitFor();
						await a.getByRole("button", { name: "Use all my changes", exact: true }).click();
						await a.getByRole("button", { name: "Resolve conflict", exact: true }).click();
					}
					await eventually(
						() => server.api("get", { refs: ["C-1"] }),
						(rows) => JSON.stringify(rows).includes("HAND TYPED TEXT"),
					);
				} finally {
					release();
					await w.close();
				}
			},
			30000,
		);

for (const editorOpen of [false, true])
	check(
		`R8-3 a nonowner ${editorOpen ? "in the editor" : "in read mode"} cannot release a merge while the owner's reply is held`,
		async () => {
			const w = await windows();
			let release = () => {};
			const held = new Promise<void>((done) => {
				release = done;
			});
			try {
				const { a, server } = w;
				const b = await w.openFollower();
				await a.keyboard.press("e");
				await title(a).fill("Coupon case mine");
				await server.api("propose", {
					edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Coupon case theirs" } }],
				});
				await a.keyboard.press("Escape");
				await card(a).waitFor();
				if (editorOpen) await b.keyboard.press("e");
				await server.api("propose", {
					edits: [{ op: "edit", case: "C-1", base: 2, body: { title: "Coupon case theirs again" } }],
				});
				await a.getByRole("textbox", { name: "Merged title", exact: true }).fill("Coupon case merged by hand");
				let received = false;
				await a.route("**/decide", async (route) => {
					const response = await route.fetch();
					received = true;
					await held;
					await route.fulfill({ response });
				});
				// Only the window that owns the draft settles its conflict. The other one sees the question answered
				// while the owner's reply is held, and does not ask what became of a merge it did not send.
				let asked = 0;
				b.on("request", (request) => {
					if (request.url().endsWith("/command")) asked++;
				});
				await a.getByRole("button", { name: "Resolve conflict", exact: true }).click();
				await eventually(async () => received, Boolean);
				await a.waitForTimeout(1500);
				expect(asked).toBe(0);
				release();
				await a.getByText("Nothing was adopted: the case changed again", { exact: false }).first().waitFor();
				await a.unroute("**/decide");
				expect(await title(a).inputValue()).toBe("Coupon case merged by hand");
				await a.getByRole("button", { name: "Resolve conflict", exact: true }).click();
				await card(a).waitFor({ state: "detached" });
				await card(b).waitFor({ state: "detached" });
				await a.keyboard.press("e");
				await a.keyboard.press("Escape");
				const saved = (await server.api("get", { refs: ["C-1"] }))[0];
				expect(saved?.title).toBe("Coupon case merged by hand");
				expect(saved?.version).toBe(4);
				expect(await a.evaluate(() => Object.keys(localStorage).filter((key) => key.includes(":draft:")))).toHaveLength(
					0,
				);
			} finally {
				release();
				await w.close();
			}
		},
		30000,
	);

check(
	"R8-2 choosing a side after replacing a hand-typed field keeps the original draft on rejection",
	async () => {
		const w = await windows();
		try {
			const { a, server } = w;
			await a.keyboard.press("e");
			await title(a).fill("Coupon case mine");
			await server.api("propose", {
				edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Coupon case theirs" } }],
			});
			await a.keyboard.press("Escape");
			await card(a).waitFor();
			await a
				.getByRole("textbox", { name: "Merged title", exact: true })
				.fill("Hand-typed title deliberately replaced");
			await a.getByRole("button", { name: "Use current title", exact: true }).click();
			const question = (await server.api("inbox", { on: "C-1", kind: "adopt" })).items[0];
			if (!question) throw Error("Missing conflict question");
			await server.api("decide", { q: question.q, onEvidence: question.evidenceHash, answer: { is: "reject" } });
			await a
				.locator("#bar")
				.filter({ hasText: /Your (current draft|typed merge) is kept/ })
				.waitFor();
			await card(a).waitFor({ state: "detached" });
			expect(await title(a).inputValue()).toBe("Coupon case mine");
			expect((await stored(a)).body.title).toBe("Coupon case mine");
		} finally {
			await w.close();
		}
	},
	30000,
);
