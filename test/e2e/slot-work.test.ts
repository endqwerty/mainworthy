import { expect, test } from "bun:test";
import { advanceClock, browserAvailable, openPage, startServer } from "./support.ts";

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
			expect(await h.page.locator(".phead").innerText()).toContain("1 in progress");
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
