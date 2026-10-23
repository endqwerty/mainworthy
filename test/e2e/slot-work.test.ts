import { expect, test } from "bun:test";
import { z } from "zod";
import { advanceClock, browserAvailable, eventually, openPage, startServer } from "./support.ts";

for (const count of [1, 201])
	test.skipIf(!browserAvailable)(
		count === 1
			? "an all-held cockpit waits for expiry before selecting work"
			: "automatic cockpit paging searches beyond a held page",
		async () => {
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
			await Promise.all(
				Array.from({ length: Math.min(count, 200) }, (_, i) =>
					server.api("work", { do: "take", run: planned.run, slot: i + 1, seconds: 30 }, { token: other }),
				),
			);
			const h = await openPage(server, {
				path: `/p/scratch/runs/${planned.run.slice(2)}`,
				setup: async (page) => page.clock.install(),
			});
			try {
				await h.page.locator('[data-slot="1"][data-working="true"]').waitFor();
				if (count === 1) {
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
					await h.page.locator('[data-run-document="C-201"][data-active="true"]').waitFor();
					expect(await h.page.getByRole("complementary", { name: "Up next" }).count()).toBe(0);
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
