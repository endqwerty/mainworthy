import { expect, test } from "bun:test";
import { browserAvailable, eventually, openPage, type Server, startServer } from "./support.ts";

/** A server with the preset these tests ask for, on a port the helpers hand out. */
function fixture({
	preset = "standard",
	mode = "local",
}: {
	preset?: string;
	mode?: "local" | "server";
} = {}): Promise<Server> {
	return startServer({ mode, ...(preset === "loose" ? {} : { preset }) });
}

import { z } from "zod";

(browserAvailable ? test : test.skip)(
	"standard: a adopts the agent's real diff and preserves agent attribution",
	async () => {
		const server = await fixture();
		let view: Awaited<ReturnType<typeof openPage>> | null = null;
		let release = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		try {
			await server.api("propose", {
				edits: [{ op: "create", outline: "Coupon applies\n  Apply SAVE10 > Total updates" }],
			});
			const writer = z.object({ token: z.string() }).parse(
				await server.api("admin", {
					do: "token.create",
					actor: "writer",
					kind: "agent",
					can: ["read", "produce"],
					project: "scratch",
				}),
			).token;
			const body = (await server.api("get", { refs: ["C-1"] }))[0];
			const steps = z
				.array(z.object({ id: z.string(), action: z.string(), expected: z.string().nullable() }))
				.parse(body?.steps);
			const proposed = await server.api(
				"propose",
				{
					edits: [
						{
							op: "edit",
							case: "C-1",
							base: 1,
							body: { steps: steps.map((step) => ({ ...step, expected: "Total shows $90.00" })) },
						},
					],
					reason: "Give the coupon an exact assertion",
				},
				{ token: writer },
			);
			expect(proposed.status).toBe("open");
			view = await openPage(server, { path: `/p/scratch/queue/${proposed.question?.slice(2)}` });
			await view.page.locator(".prop .diff").waitFor();
			expect(await view.page.locator(".prop .diff").innerText()).toContain("$90.00");
			expect(await view.page.locator(".prop").innerText()).toContain("writer proposes");
			// The reply to the answer is held, so the server has the adopted version while the page has not yet
			// recorded its answer: the order in which a fast person presses u.
			await view.page.route("**/decide", async (route) => {
				const response = await route.fetch();
				await held;
				await route.fulfill({ response }).catch(() => {});
			});
			await view.page.keyboard.press("a");
			const current = await eventually(
				() => server.api("get", { refs: ["C-1"] }),
				(rows) => rows[0]?.version === 2,
			);
			expect(z.array(z.object({ expected: z.string().nullable() })).parse(current[0]?.steps)[0]?.expected).toBe(
				"Total shows $90.00",
			);
			const timeline = await server.api("timeline", { ref: "C-1" });
			expect(timeline.entries.find((entry) => entry.t === "version" && entry.version === 2)).toMatchObject({
				by: "writer",
				kind: "agent",
			});
			// Pressed before the page has its reply, u already says that an adopted edit stays. The pane's own
			// line is replaced by "recorded" when the reply lands, so this is read from the status bar, which stays.
			await view.page.keyboard.press("u");
			const status = view.page.locator("#bar").filter({ hasText: "An adopted edit stays in history." });
			await status.waitFor();
			release();
			await view.page.getByText(`${proposed.question} · Accept · recorded`, { exact: false }).waitFor();
			// Pressed once the page has recorded the answer, the pane says it too, and keeps saying it.
			await view.page.keyboard.press("u");
			await view.page.getByText("Proposal decisions cannot be withdrawn.", { exact: false }).waitFor();
			await status.waitFor();
			expect((await server.api("get", { refs: ["C-1"] }))[0]?.version).toBe(2);
			expect(view.errors).toEqual([]);
			expect(view.dialogs).toEqual([]);
		} finally {
			release();
			await view?.close();
			await server.stop();
		}
	},
	30000,
);

(browserAvailable ? test : test.skip)(
	"on a case page, a proposal below the edge of the pane is brought into view before a key answers it",
	async () => {
		const server = await fixture();
		let view: Awaited<ReturnType<typeof openPage>> | null = null;
		try {
			const steps = Array.from({ length: 6 }, (_, i) => `  Step ${i + 1} of the checkout > Result ${i + 1} is shown`);
			await server.api("propose", {
				edits: [{ op: "create", outline: ["Checkout with a coupon", ...steps].join("\n") }],
			});
			const writer = z.object({ token: z.string() }).parse(
				await server.api("admin", {
					do: "token.create",
					actor: "writer",
					kind: "agent",
					can: ["read", "produce"],
					project: "scratch",
				}),
			).token;
			const proposed = await server.api(
				"propose",
				{ edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Checkout with a percentage coupon" } }] },
				{ token: writer },
			);
			expect(proposed.status).toBe("open");
			view = await openPage(server, { path: "/p/scratch/suite/c/1" });
			await view.page.setViewportSize({ width: 1280, height: 800 });
			const card = view.page.locator(`[data-proposal="${proposed.question}"]`);
			await card.waitFor({ state: "attached" });
			await view.page.locator(".pane-scroll").evaluate((pane) => {
				pane.scrollTop = 0;
			});
			const inView = () =>
				card.evaluate((element) => {
					const box = element.getBoundingClientRect();
					const frame = element.closest(".pane-scroll")?.getBoundingClientRect();
					return frame !== undefined && box.top >= frame.top - 1 && box.bottom <= frame.bottom + 1;
				});
			// The whole of the proposal does not fit under six steps at 1280 by 800: the first press only shows it.
			expect(await inView()).toBe(false);
			await view.page.keyboard.press("a");
			await view.page.getByText("is now in view", { exact: false }).waitFor();
			expect(await inView()).toBe(true);
			expect((await server.api("get", { refs: ["C-1"] }))[0]?.version).toBe(1);
			expect((await server.api("inbox", { kind: "adopt" })).items.map((q) => q.q)).toEqual([proposed.question ?? ""]);
			// Now it is on the screen, and the same key answers it.
			await view.page.keyboard.press("a");
			const adopted = await eventually(
				() => server.api("get", { refs: ["C-1"] }),
				(rows) => rows[0]?.version === 2,
			);
			expect(adopted[0]?.title).toBe("Checkout with a percentage coupon");
			expect(view.errors).toEqual([]);
		} finally {
			await view?.close();
			await server.stop();
		}
	},
	30000,
);

(browserAvailable ? test : test.skip)(
	"a long proposal fits in the pane, and a key answers it only after its last change has been shown",
	async () => {
		const server = await fixture();
		let view: Awaited<ReturnType<typeof openPage>> | null = null;
		try {
			const steps = Array.from({ length: 6 }, (_, i) => `  Step ${i + 1} > Result ${i + 1}`);
			await server.api("propose", { edits: [{ op: "create", outline: ["Long checkout", ...steps].join("\n") }] });
			const writer = z.object({ token: z.string() }).parse(
				await server.api("admin", {
					do: "token.create",
					actor: "writer",
					kind: "agent",
					can: ["read", "produce"],
					project: "scratch",
				}),
			).token;
			const proposed = await server.api(
				"propose",
				{
					edits: [
						{
							op: "edit",
							case: "C-1",
							base: 1,
							body: {
								steps: Array.from({ length: 35 }, (_, i) => ({
									id: `n${i}`,
									action: `Rewritten step ${i + 1} of the long checkout`,
									expected: `Rewritten result ${i + 1}`,
								})),
							},
						},
					],
				},
				{ token: writer },
			);
			expect(proposed.status).toBe("open");
			for (const size of [
				{ width: 1280, height: 800 },
				{ width: 1440, height: 900 },
			]) {
				view = await openPage(server, { path: "/p/scratch/suite/c/1" });
				const page = view.page;
				await page.setViewportSize(size);
				const card = page.locator(`[data-proposal="${proposed.question}"]`);
				await card.waitFor({ state: "attached" });
				const state = () =>
					card.evaluate((element) => {
						const box = element.getBoundingClientRect();
						const frame = element.closest(".pane-scroll")?.getBoundingClientRect();
						const diff = element.querySelector(".diff");
						return {
							whole: frame !== undefined && box.top >= frame.top - 1 && box.bottom <= frame.bottom + 1,
							fits: frame !== undefined && box.height <= frame.height,
							atEnd: diff !== null && diff.scrollTop + diff.clientHeight >= diff.scrollHeight - 2,
						};
					});
				const open = async () => (await server.api("inbox", { kind: "adopt" })).items.map((q) => q.q);
				// Thirty-five changed steps: the card still fits in the pane, with the diff scrolling inside it.
				expect((await state()).fits).toBe(true);
				// Scrolled straight to the bottom of the pane, the key still does not answer: the end of the diff
				// has not been shown.
				await page.locator(".pane-scroll").evaluate((pane) => {
					pane.scrollTop = pane.scrollHeight;
				});
				let presses = 0;
				for (; presses < 40; presses++) {
					const before = await state();
					if (before.whole && before.atEnd) break;
					await page.keyboard.press("r");
					await page.waitForTimeout(60);
					expect(await open()).toEqual([proposed.question ?? ""]);
				}
				expect(presses).toBeGreaterThan(1);
				expect(await state()).toMatchObject({ whole: true, atEnd: true });
				if (size.width === 1440) {
					// Everything has been shown: now the key answers.
					await page.keyboard.press("r");
					await eventually(open, (items) => items.length === 0);
					expect((await server.api("get", { refs: ["C-1"] }))[0]?.version).toBe(1);
				}
				expect(view.errors).toEqual([]);
				await view.close();
				view = null;
			}
		} finally {
			await view?.close();
			await server.stop();
		}
	},
	60000,
);
