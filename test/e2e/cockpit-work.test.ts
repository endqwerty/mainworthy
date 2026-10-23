import { expect, test } from "bun:test";
import { z } from "zod";
import { answer, browserAvailable, eventually, openPage, startServer } from "./support.ts";

const check = test.skipIf(!browserAvailable);

check(
	"two testers explicitly claim and release available cockpit work",
	async () => {
		const server = await startServer({ seed: false });
		let a: Awaited<ReturnType<typeof openPage>> | undefined;
		let b: Awaited<ReturnType<typeof openPage>> | undefined;
		try {
			await server.api("propose", {
				edits: [1, 2, 3].map((n) => ({ op: "create", body: { title: `Shared case ${n}` } })),
			});
			const { run } = await server.api("plan", { name: "Claim together", select: {} });
			const { token } = z.object({ token: z.string() }).parse(
				await server.api("admin", {
					do: "token.create",
					actor: "second-tester",
					kind: "human",
					can: ["read", "produce"],
					project: "scratch",
				}),
			);
			const path = `/p/scratch/runs/${run.slice(2)}`;
			a = await openPage(server, { path });
			b = await openPage({ ...server, token }, { path, device: "phone" });
			await a.page.locator('[data-slot="1"]').waitFor();
			await b.page.locator('[data-slot="1"]').waitFor();
			if (process.env.MAINWORTHY_COCKPIT_EVIDENCE)
				await a.page.screenshot({
					path: `${process.env.MAINWORTHY_COCKPIT_EVIDENCE}/claims-${process.env.MAINWORTHY_COCKPIT_REVISION}.png`,
				});
			expect(await a.page.locator('[data-slot="1"]').innerText()).toContain("Available");
			expect(await b.page.locator('[data-slot="1"]').innerText()).toContain("Available");
			await a.page.keyboard.press("t");
			await a.page
				.locator('[data-slot="1"]')
				.getByText(/In progress · robin/)
				.waitFor();
			await b.page
				.locator('[data-slot="1"]')
				.getByText(/In progress · robin/)
				.waitFor();
			expect(await b.page.locator('[data-slot="1"]').innerText()).not.toContain("yours");
			await b.page.reload();
			await b.page.locator('[data-run-document="C-2"][data-active="true"]').waitFor();
			expect(await b.page.getByRole("complementary", { name: "Up next" }).innerText()).not.toContain("C-1");
			await a.page.keyboard.press("r");
			await b.page.locator('[data-slot="1"]').getByText("Available", { exact: true }).waitFor();
			// Row actions belong to the visible detail, never the phone's list.
			await b.page.getByRole("button", { name: "Back to the list", exact: true }).tap();
			await b.page.getByRole("button", { name: "Actions", exact: true }).tap();
			expect(
				await b.page
					.locator('[data-overlay="palette"]')
					.getByRole("option", { name: /Claim slot/ })
					.count(),
			).toBe(0);
			await b.page.keyboard.press("Escape");
			await b.page.locator('[data-slot="1"] .row').tap();
			await b.page.getByRole("button", { name: "Actions", exact: true }).tap();
			await b.page
				.locator('[data-overlay="palette"]')
				.getByRole("option", { name: /Claim slot/ })
				.tap();
			await b.page
				.locator('[data-slot="1"]')
				.getByText(/In progress · second-tester/)
				.waitFor();
			await a.page
				.locator('[data-slot="1"]')
				.getByText(/In progress · second-tester/)
				.waitFor();
			await b.page.getByRole("button", { name: "Actions", exact: true }).tap();
			await b.page
				.locator('[data-overlay="palette"]')
				.getByRole("option", { name: /Release slot/ })
				.tap();
			await a.page.locator('[data-slot="1"]').getByText("Available", { exact: true }).waitFor();
			expect(a.errors).toEqual([]);
			expect(b.errors).toEqual([]);
		} finally {
			await a?.close();
			await b?.close();
			await server.stop();
		}
	},
	30_000,
);

check(
	"a failed next cockpit page stops requesting and More slots retries",
	async () => {
		const server = await startServer({ seed: false });
		let view: Awaited<ReturnType<typeof openPage>> | undefined;
		let calls = 0;
		let fail = true;
		try {
			await server.api("propose", {
				edits: Array.from({ length: 201 }, (_, n) => ({ op: "create", body: { title: `Page case ${n + 1}` } })),
			});
			const { run } = await server.api("plan", { name: "Page failure", select: {} });
			await server.api("report", {
				run,
				results: Array.from({ length: 200 }, (_, n) => ({ test: { case: `C-${n + 1}` }, outcome: "skip" })),
			});
			view = await openPage(server, {
				path: `/p/scratch/runs/${run.slice(2)}`,
				setup: async (page) => {
					await page.route("**/api/p/scratch/find", async (route) => {
						const input = z.object({ cursor: z.string().optional() }).parse(route.request().postDataJSON());
						if (!input.cursor) return route.continue();
						calls++;
						if (!fail) return route.continue();
						await answer(route, {
							status: 500,
							contentType: "application/json",
							body: JSON.stringify({ ok: false, error: { code: "internal", message: "Page two unavailable" } }),
						});
					});
				},
			});
			const { page } = view;
			await page.getByRole("button", { name: "More slots", exact: true }).waitFor();
			if (process.env.MAINWORTHY_COCKPIT_EVIDENCE) {
				await page.waitForTimeout(1500);
				await page.getByRole("button", { name: "More slots", exact: true }).scrollIntoViewIfNeeded();
				await page.screenshot({
					path: `${process.env.MAINWORTHY_COCKPIT_EVIDENCE}/paging-${process.env.MAINWORTHY_COCKPIT_REVISION}.png`,
				});
			}
			await page.getByRole("alert").filter({ hasText: "Page two unavailable" }).waitFor();
			const stopped = calls;
			expect(stopped).toBeGreaterThan(0);
			expect(stopped).toBeLessThanOrEqual(2);
			await page.waitForTimeout(2200);
			expect(calls).toBe(stopped);
			// A retry can fail again, then a later explicit retry recovers the page.
			await page.getByRole("button", { name: "More slots", exact: true }).click();
			await eventually(
				async () => calls,
				(n) => n > stopped,
			);
			await page.getByRole("alert").filter({ hasText: "Page two unavailable" }).waitFor();
			await page.waitForTimeout(2200);
			const retried = calls;
			expect(retried).toBeLessThanOrEqual(stopped + 2);
			fail = false;
			await page.getByRole("button", { name: "More slots", exact: true }).click();
			await page.locator('[data-run-document="C-201"][data-active="true"]').waitFor();
			expect(calls).toBe(retried + 1);
			if (process.env.MAINWORTHY_COCKPIT_EVIDENCE)
				console.info(
					`Page-two requests: initial failure ${stopped}, explicit failed retry ${retried - stopped}, successful retry ${calls - retried}`,
				);
			expect(await page.getByRole("alert").count()).toBe(0);
			expect(
				view.errors.every((error) => /Failed to load resource: the server responded with a status of 500/.test(error)),
			).toBe(true);
		} finally {
			await view?.close();
			await server.stop();
		}
	},
	30_000,
);
