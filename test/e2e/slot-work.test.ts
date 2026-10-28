import { expect, test } from "bun:test";
import { z } from "zod";
import { advanceClock, browserAvailable, eventually, openPage, startServer } from "./support.ts";

for (const scenario of ["all-held", "mixed-page", "own-page"] as const)
	test.skipIf(!browserAvailable)(
		scenario === "all-held"
			? "an all-held cockpit waits for expiry before selecting work"
			: `automatic cockpit paging searches beyond a ${scenario === "mixed-page" ? "mixed reported and held" : "reported"} page`,
		async () => {
			const count = scenario === "all-held" ? 1 : 201;
			const reported = scenario === "mixed-page" ? 1 : scenario === "own-page" ? 200 : 0;
			const server = await startServer({ seed: false });
			await server.api("propose", {
				edits: Array.from({ length: count }, (_, n) => ({ op: "create", body: { title: `Held page ${n + 1}` } })),
			});
			const planned = await server.api("plan", { name: "Held run", select: {} });
			const other = z.object({ token: z.string() }).parse(
				await server.api("admin", {
					do: "token.create",
					actor: "second-tester",
					kind: "human",
					can: ["read", "produce"],
					project: "scratch",
				}),
			).token;
			if (reported)
				await server.api("report", {
					run: planned.run,
					results: Array.from({ length: reported }, (_, n) => ({
						test: { case: `C-${n + 1}` },
						outcome: scenario === "own-page" ? "skip" : "pass",
					})),
				});
			for (let slot = reported + 1; slot <= Math.min(count, 200); slot++)
				await server.api(
					"work",
					{ do: "take", run: planned.run, slot, seconds: count === 1 ? 30 : 900 },
					{ token: other },
				);
			const h = await openPage(server, {
				path: `/p/scratch/runs/${planned.run.slice(2)}`,
				setup: async (page) => page.clock.install(),
			});
			try {
				await h.page.locator('[data-slot="1"]').waitFor();
				if (count === 1) {
					await h.page.locator('[data-slot="1"][data-working="true"]').waitFor();
					expect(await h.page.locator('[data-run-document][data-active="true"]').count()).toBe(0);
					expect(await h.page.getByRole("button", { name: "p Pass", exact: true }).isDisabled()).toBe(true);
					await h.page.keyboard.press("j");
					await h.page.locator('[data-run-document="C-1"][data-active="true"]').waitFor();
					expect(await h.page.getByRole("button", { name: "p Pass", exact: true }).isEnabled()).toBe(true);
					await h.page.reload();
					await h.page.locator('[data-slot="1"][data-working="true"]').waitFor();
					expect(await h.page.locator('[data-run-document][data-active="true"]').count()).toBe(0);
					await advanceClock(server, 30_000);
					await h.page.clock.fastForward(30_100);
					await h.page.locator('[data-run-document="C-1"][data-active="true"]').waitFor();
				} else {
					await h.page.locator('[data-slot="201"]').waitFor();
					if (process.env.MAINWORTHY_WORK_EVIDENCE)
						await h.page.screenshot({
							path: `${process.env.MAINWORTHY_WORK_EVIDENCE}/794-${scenario}-${process.env.MAINWORTHY_WORK_REVISION}.png`,
						});
					expect(
						await h.page.locator('[data-run-document][data-active="true"]').getAttribute("data-run-document"),
					).toBe("C-201");
					expect(await h.page.getByRole("complementary", { name: "Up next" }).count()).toBe(0);
					await h.page.keyboard.press("p");
					await eventually(
						() => server.api("find", { in: "slots", run: planned.run, limit: 500 }),
						(reply) => reply.items.some((slot) => slot.case === "C-201" && slot.state === "satisfied"),
					);
					await h.page.reload();
					await h.page.locator('[data-slot="201"]').waitFor();
					await h.page.locator('[data-run-document="C-1"][data-active="true"]').waitFor();
				}
				expect(h.errors).toEqual([]);
			} finally {
				await h.close();
				await server.stop();
			}
		},
		60_000,
	);

test.skipIf(!browserAvailable)(
	"automatic cockpit navigation skips another holder until expiry while deliberate selection stays advisory",
	async () => {
		const server = await startServer({ seed: false });
		await server.api("propose", {
			edits: [1, 2].map((n) => ({ op: "create", body: { title: `Shared case ${n}` } })),
		});
		const planned = await server.api("plan", { name: "Shared run", select: {} });
		const other = z.object({ token: z.string() }).parse(
			await server.api("admin", {
				do: "token.create",
				actor: "second-tester",
				kind: "human",
				can: ["read", "produce"],
				project: "scratch",
			}),
		).token;
		await server.api("work", { do: "take", run: planned.run, seconds: 30 }, { token: other });
		const h = await openPage(server, {
			path: `/p/scratch/runs/${planned.run.slice(2)}`,
			setup: async (page) => page.clock.install(),
		});
		const active = () => h.page.locator('[data-run-document][data-active="true"]').getAttribute("data-run-document");
		try {
			await h.page.getByText("In progress · second-tester", { exact: false }).waitFor();
			if (process.env.MAINWORTHY_WORK_EVIDENCE)
				await h.page.screenshot({
					path: `${process.env.MAINWORTHY_WORK_EVIDENCE}/794-${process.env.MAINWORTHY_WORK_REVISION}.png`,
				});
			expect(await active()).toBe("C-2");
			expect(await h.page.getByRole("complementary", { name: "Up next" }).count()).toBe(0);
			await h.page.keyboard.press("k");
			expect(await active()).toBe("C-1");
			expect(await h.page.getByRole("button", { name: "p Pass", exact: true }).isEnabled()).toBe(true);
			await h.page.getByRole("complementary", { name: "Up next" }).filter({ hasText: "C-2" }).waitFor();
			await h.page.keyboard.press("j");
			expect(await active()).toBe("C-2");
			await h.page.keyboard.press("p");
			await eventually(
				() => server.api("find", { in: "slots", run: planned.run }),
				(reply) => reply.items.some((slot) => slot.case === "C-2" && slot.state === "satisfied"),
			);
			expect(await active()).toBe("C-2");
			expect(await h.page.getByRole("complementary", { name: "Up next" }).count()).toBe(0);
			expect(await h.page.getByText("Nothing left for you to run", { exact: false }).count()).toBe(0);
			await advanceClock(server, 30_000);
			await h.page.clock.fastForward(30_100);
			await h.page.getByRole("complementary", { name: "Up next" }).filter({ hasText: "C-1" }).waitFor();
			await h.page.keyboard.press("p");
			expect(await active()).toBe("C-1");
			await h.page.reload();
			await h.page.locator('[data-run-document="C-1"][data-active="true"]').waitFor();
			await server.api("work", { do: "take", run: planned.run });
			await h.page.getByText("In progress · robin", { exact: false }).waitFor();
			await h.page.reload();
			await h.page.locator('[data-run-document="C-1"][data-active="true"]').waitFor();
			// A held slot can still be deliberately selected and reported over.
			await server.api("work", { do: "give-back", run: planned.run, slot: 1 });
			await server.api("work", { do: "take", run: planned.run, slot: 1 }, { token: other });
			await h.page.getByText("In progress · second-tester", { exact: false }).waitFor();
			await h.page.locator('[data-slot="1"] .row').click();
			await h.page.keyboard.press("p");
			await eventually(
				() => server.api("find", { in: "slots", run: planned.run }),
				(reply) => reply.items.every((slot) => slot.state === "satisfied"),
			);
			expect(h.errors).toEqual([]);
		} finally {
			await h.close();
			await server.stop();
		}
	},
	30_000,
);

test.skipIf(!browserAvailable)(
	"cockpit follows live takes and removes expired work without a write",
	async () => {
		const server = await startServer({ seed: false });
		await server.api("propose", { edits: [{ op: "create", body: { title: "Work together" } }] });
		const planned = await server.api("plan", { name: "Shared run", select: { cases: ["C-1"] } });
		const h = await openPage(server, { path: `/p/scratch/runs/${planned.run.slice(2)}` });
		try {
			await h.page.clock.install();
			await h.page.getByText("0 in progress", { exact: false }).waitFor();
			const taken = await server.api("work", { do: "take", run: planned.run, seconds: 30 });
			await h.page.getByText("In progress · robin", { exact: false }).waitFor();
			await h.page.locator(".phead").filter({ hasText: "1 in progress" }).waitFor();
			await advanceClock(server, 30_000);
			await h.page.clock.fastForward(30_100);
			await h.page.getByText("0 in progress", { exact: false }).waitFor();
			expect(await h.page.locator(".run-working").count()).toBe(0);
			expect(await server.api("work", { do: "take", run: planned.run, slot: taken.slot ?? 0 })).toMatchObject({
				case: "C-1",
				work: { kind: "held", actor: "robin" },
			});
			expect(h.errors).toEqual([]);
		} finally {
			await h.close();
			await server.stop();
		}
	},
	30_000,
);

for (const method of ["human", "agent"] as const)
	test.skipIf(!browserAvailable)(
		`cockpit selects only work admitted by pinned case and run for ${method} (987)`,
		async () => {
			const server = await startServer({ seed: false });
			const opposite = method === "human" ? "agent" : "human";
			await server.api("propose", {
				edits: ([opposite, method, opposite, method] as const).map((kind, index) => ({
					op: "create",
					body: { title: `Method case ${index + 1}`, methods: [kind] },
				})),
			});
			const planned = await server.api("plan", {
				name: "Mixed methods",
				select: {},
				require: [{ id: "exercise", kind: "exercise", methods: ["human", "agent"], minActors: 1, basis: "exact" }],
			});
			const restricted = await server.api("plan", {
				name: "Other method only",
				select: {},
				require: [{ id: "exercise", kind: "exercise", methods: [opposite], minActors: 1, basis: "exact" }],
			});
			const excludedCases = await server.api("plan", {
				name: "Other cases only",
				select: { cases: ["C-1", "C-3"] },
				require: [{ id: "exercise", kind: "exercise", methods: ["human", "agent"], minActors: 1, basis: "exact" }],
			});
			const token = z.object({ token: z.string() }).parse(
				await server.api("admin", {
					do: "token.create",
					actor: `method-${method}`,
					kind: method,
					can: ["read", "record"],
					project: "scratch",
				}),
			).token;
			const h = await openPage({ ...server, token }, { path: `/p/scratch/runs/${planned.run.slice(2)}` });
			try {
				await h.page.locator('[data-run-document][data-active="true"]').waitFor();
				expect(await h.page.locator('[data-run-document][data-active="true"]').getAttribute("data-run-document")).toBe(
					"C-2",
				);
				const next = h.page.getByRole("complementary", { name: "Up next" });
				expect(await next.innerText()).toContain("C-4");
				expect(await next.innerText()).not.toContain("C-1");
				expect(await next.innerText()).not.toContain("C-3");
				await h.page.keyboard.press("p");
				await h.page.locator('[data-run-document="C-4"][data-active="true"]').waitFor();
				await h.page.keyboard.press("p");
				await h.page.getByText("Nothing left for you to run.", { exact: false }).waitFor();
				expect(await next.count()).toBe(0);
				await h.page.goto(`${server.url}/p/scratch/runs/${excludedCases.run.slice(2)}`);
				await h.page.getByText("Nothing left for you to run.", { exact: false }).waitFor();
				expect(await next.count()).toBe(0);
				expect(await h.page.locator('[data-run-document][data-active="true"]').count()).toBe(0);
				await h.page.goto(`${server.url}/p/scratch/runs/${restricted.run.slice(2)}`);
				await h.page.getByText("Nothing left for you to run.", { exact: false }).waitFor();
				expect(await next.count()).toBe(0);
				expect(await h.page.getByRole("button", { name: "p Pass", exact: true }).isDisabled()).toBe(true);
				await server.api("propose", {
					edits: [{ op: "create", body: { title: "Both methods", methods: ["human", "agent"] } }],
				});
				for (const order of [
					[opposite, method],
					[method, opposite],
				] as const) {
					const separate = await server.api("plan", {
						name: `Separate ${order.join(",")}`,
						select: { cases: ["C-5"] },
						require: order.map((kind) => ({
							id: kind,
							kind: "exercise",
							methods: [kind],
							minActors: 1,
							basis: "exact",
						})),
					});
					await h.page.goto(`${server.url}/p/scratch/runs/${separate.run.slice(2)}`);
					await h.page.locator('[data-run-document="C-5"][data-active="true"]').waitFor();
					expect(await h.page.locator(".run-dot.on").getAttribute("aria-label")).toStartWith(
						`Slot ${order.indexOf(method) + 1}: C-5,`,
					);
					await h.page.keyboard.press("p");
					await h.page.getByText("Nothing left for you to run.", { exact: false }).waitFor();
				}
			} finally {
				await h.close();
				await server.stop();
			}
		},
	);
