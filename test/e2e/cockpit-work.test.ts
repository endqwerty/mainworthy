import { expect, test } from "bun:test";
import { z } from "zod";
import { AttachmentReply } from "../../src/core/attachments.ts";
import { Slot } from "../../src/web/runs/models.ts";
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
		// A read of the first page clears the paging error, and the cockpit asks for the next page again (#888). So
		// each read, like each click on More slots, starts at most a try and the one retry `retry: 1` gives.
		const events: ("read" | "click" | "page")[] = [];
		// The sequence when a burst has more, so a failure shows it.
		const beyondRetry = () =>
			events
				.join(" ")
				.split(/read|click/)
				.some((burst) => burst.split("page").length - 1 > 2)
				? events.join(" ")
				: "";
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
						const input = z
							.object({ in: z.string(), cursor: z.string().optional() })
							.parse(route.request().postDataJSON());
						if (!input.cursor) {
							if (input.in === "slots") events.push("read");
							return route.continue();
						}
						calls++;
						events.push("page");
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
			// A try started before the alert can still retry after it; then the requests stop.
			await page.waitForTimeout(2200);
			const stopped = calls;
			expect(stopped).toBeGreaterThan(0);
			expect(beyondRetry()).toBe("");
			// A retry can fail again, then a later explicit retry recovers the page.
			events.push("click");
			await page.getByRole("button", { name: "More slots", exact: true }).click();
			await eventually(
				async () => calls,
				(n) => n > stopped,
			);
			await page.getByRole("alert").filter({ hasText: "Page two unavailable" }).waitFor();
			await page.waitForTimeout(2200);
			const retried = calls;
			expect(beyondRetry()).toBe("");
			fail = false;
			events.push("click");
			await page.getByRole("button", { name: "More slots", exact: true }).click();
			await page.locator('[data-run-document="C-201"][data-active="true"]').waitFor();
			expect(calls).toBeGreaterThan(retried);
			expect(beyondRetry()).toBe("");
			if (process.env.MAINWORTHY_COCKPIT_EVIDENCE)
				console.info(
					`Page-two requests: initial failure ${stopped}, explicit failed retry ${retried - stopped}, successful retry ${calls - retried}; ${events.join(" ")}`,
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

check(
	"a read,record person claims, records every outcome and attaches evidence (880)",
	async () => {
		const server = await startServer({ seed: false, mode: "server" });
		let view: Awaited<ReturnType<typeof openPage>> | undefined;
		try {
			await server.api("propose", {
				edits: [1, 2, 3, 4].map((n) => ({
					op: "create",
					body: { title: `Record-only case ${n}`, methods: ["human"] },
				})),
			});
			const { run } = await server.api("plan", { name: "Record-only tester", select: {} });
			const { token } = z.object({ token: z.string() }).parse(
				await server.api("admin", {
					do: "token.create",
					actor: "tester",
					kind: "human",
					can: ["read", "record"],
					project: "scratch",
				}),
			);
			view = await openPage({ ...server, token }, { path: `/p/scratch/runs/${run.slice(2)}` });
			const { page } = view;
			const session = await page.request.get(`${server.url}/api/session`);
			const account = z
				.object({ result: z.object({ projects: z.array(z.object({ key: z.string(), can: z.array(z.string()) })) }) })
				.parse(await session.json());
			expect(account.result.projects.find((project) => project.key === "scratch")?.can.sort()).toEqual([
				"read",
				"record",
			]);
			await page.locator('[data-run-document="C-1"][data-active="true"][data-ready="true"]').waitFor();
			await page.keyboard.press("t");
			await page
				.locator('[data-slot="1"]')
				.getByText(/In progress · tester/)
				.waitFor();
			if (process.env.MAINWORTHY_COCKPIT_EVIDENCE)
				await page.screenshot({
					path: `${process.env.MAINWORTHY_COCKPIT_EVIDENCE}/880-${process.env.MAINWORTHY_COCKPIT_REVISION}.png`,
				});
			for (const [index, outcome] of (["pass", "fail", "blocked", "skip"] as const).entries()) {
				const ref = `C-${index + 1}`;
				await page.locator(`[data-run-document="${ref}"][data-active="true"][data-ready="true"]`).waitFor();
				for (const label of ["Pass", "Fail", "Blocked", "Skip"])
					expect(await page.getByRole("button", { name: new RegExp(label) }).isEnabled()).toBe(true);
				expect(await page.getByLabel("Attach a file").isEnabled()).toBe(true);
				await page.getByLabel("Attach a file").setInputFiles({
					name: `${outcome}.txt`,
					mimeType: "text/plain",
					buffer: Buffer.from(`${outcome} evidence`),
				});
				await page.getByRole("button", { name: `Remove ${outcome}.txt` }).waitFor();
				await page
					.locator(".outs")
					.getByRole("button", { name: new RegExp(outcome, "i") })
					.click();
				if (outcome === "fail") {
					await page.getByRole("textbox", { name: "Result note" }).fill("Observed failure");
					await page.getByRole("textbox", { name: "Result note" }).press("Enter");
				}
				await page
					.locator("#stat")
					.filter({ hasText: `${ref} ${outcome} recorded` })
					.waitFor();
				const slots = await eventually(
					async () => (await server.api("find", { in: "slots", run })).items.map((item) => Slot.parse(item)),
					(items) => items[index]?.fills[0]?.outcome === outcome,
				);
				const fill = slots[index]?.fills[0];
				expect(fill).toMatchObject({ by: "tester", outcome });
				if (!fill) throw new Error("Recorded result missing");
				const listed = AttachmentReply.parse(await server.api("attachment", { result: fill.result }, { token }));
				expect(listed).toMatchObject({ kind: "list", items: [{ name: `${outcome}.txt` }] });
				if (listed.kind !== "list" || !listed.items[0]) throw new Error("Attachment missing");
				expect(
					await server.api("attachment", { result: fill.result, id: listed.items[0].id }, { token }),
				).toMatchObject({ kind: "file", data: Buffer.from(`${outcome} evidence`).toString("base64") });
			}
			expect(view.errors).toEqual([]);
		} finally {
			await view?.close();
			await server.stop();
		}
	},
	30_000,
);
