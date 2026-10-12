import { expect, test } from "bun:test";
import { z } from "zod";
import { browserAvailable, eventually, openPage, startServer } from "./support.ts";

async function holdPlacements(page: Awaited<ReturnType<typeof openPage>>["page"]) {
	let started = false;
	let release = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.context().route("**/api/p/scratch/propose", async (route) => {
		started = true;
		await held;
		await route.continue();
	});
	return { release, started: () => started };
}

test.skipIf(!browserAvailable)(
	"UI-5 one immediate undo is queued behind a pending tag write",
	async () => {
		const server = await startServer();
		await server.api("propose", { edits: [{ op: "create", body: { title: "Undo while saving" } }] });
		const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
		let release = () => {};
		try {
			const { page } = h;
			await page.getByRole("button", { name: "Undo while saving", exact: true }).waitFor();
			const held = await holdPlacements(page);
			release = held.release;
			await page.keyboard.press("t");
			await page.keyboard.type("earlyundo");
			await page.keyboard.press("Enter");
			await page.waitForFunction(() => document.querySelector(".ctags")?.textContent?.includes("#earlyundo"));
			expect(await page.locator(".ctags").textContent()).toContain("#earlyundo");
			await eventually(async () => held.started(), Boolean);
			expect((await server.api("get", { refs: ["C-1"] }))[0]?.tags).toEqual([]);
			await page.keyboard.press("u");
			expect(await page.locator(".ctags").textContent()).not.toContain("#earlyundo");
			await page.keyboard.press("u");
			await page.waitForFunction(() => document.querySelector("#stat")?.textContent?.includes("Undo queued."));
			release();
			const timeline = await eventually(
				() => server.api("timeline", { ref: "C-1" }),
				(reply) => reply.entries.filter((entry) => entry.t === "placement").length === 2,
			);
			const rows = await eventually(
				() => server.api("get", { refs: ["C-1"] }),
				(rows) => Array.isArray(rows[0]?.tags) && rows[0]?.tags.length === 0,
			);
			expect(rows[0]?.version).toBe(1);
			expect(timeline.entries.filter((entry) => entry.t === "placement")).toHaveLength(2);
			expect(h.errors).toEqual([]);
		} finally {
			release();
			await h.close();
			await server.stop();
		}
	},
	30_000,
);

for (const action of ["move", "archive"]) {
	test.skipIf(!browserAvailable)(
		`UI-5 immediate undo also waits for a pending ${action}`,
		async () => {
			const server = await startServer();
			await server.api("propose", {
				edits: [
					{ op: "create", folder: "Original", body: { title: "Placement undo case" } },
					{ op: "folder", name: "Destination" },
				],
			});
			const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
			let release = () => {};
			try {
				const { page } = h;
				await page.getByRole("button", { name: "Placement undo case", exact: true }).waitFor();
				const held = await holdPlacements(page);
				release = held.release;
				if (action === "move") {
					await page.keyboard.press("m");
					await page.getByRole("textbox", { name: "Move selected cases to a folder" }).fill("Destination");
					await page.keyboard.press("Enter");
					expect(await page.locator(".cmeta .path").textContent()).toBe("Destination");
				} else {
					await page.keyboard.press("#");
					expect(await page.getByRole("option").filter({ hasText: "Placement undo case" }).count()).toBe(0);
				}
				await eventually(async () => held.started(), Boolean);
				const before = (await server.api("get", { refs: ["C-1"] }))[0];
				if (action === "move") expect(z.object({ path: z.string() }).parse(before?.folder).path).toBe("Original");
				else expect(before?.state).toBe("active");
				await page.keyboard.press("u");
				if (action === "move") expect(await page.locator(".cmeta .path").textContent()).toBe("Original");
				else expect(await page.getByRole("option").filter({ hasText: "Placement undo case" }).count()).toBe(1);
				await page.waitForFunction(() => document.querySelector("#stat")?.textContent?.includes("Undo queued."));
				release();
				const timeline = await eventually(
					() => server.api("timeline", { ref: "C-1" }),
					(reply) => reply.entries.filter((entry) => entry.t === "placement").length === 2,
				);
				const rows = await eventually(
					() => server.api("get", { refs: ["C-1"] }),
					(rows) =>
						action === "move"
							? z.object({ path: z.string() }).parse(rows[0]?.folder).path === "Original"
							: rows[0]?.state === "active",
				);
				expect(rows[0]?.version).toBe(1);
				expect(timeline.entries.filter((entry) => entry.t === "placement")).toHaveLength(2);
				expect(h.errors).toEqual([]);
			} finally {
				release();
				await h.close();
				await server.stop();
			}
		},
		30_000,
	);
}

test.skipIf(!browserAvailable)(
	"tagging updates the case before its request finishes and undo records the inverse",
	async () => {
		const server = await startServer();
		await server.api("propose", { edits: [{ op: "create", body: { title: "Tag this case" } }] });
		const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
		let release = () => {};
		try {
			const { page } = h;
			await page.getByRole("button", { name: "Tag this case", exact: true }).waitFor();
			const held = await holdPlacements(page);
			release = held.release;
			await page.keyboard.press("t");
			await page.keyboard.type("checkout");
			await page.keyboard.press("Enter");
			await page.waitForFunction(() => document.querySelector(".ctags")?.textContent?.includes("#checkout"));
			expect(await page.locator(".ctags").textContent()).toContain("#checkout");
			await eventually(async () => held.started(), Boolean);
			expect((await server.api("get", { refs: ["C-1"] }))[0]?.tags).toEqual([]);
			release();
			await eventually(
				() => server.api("get", { refs: ["C-1"] }),
				(rows) => Array.isArray(rows[0]?.tags) && rows[0]?.tags.includes("checkout"),
			);
			await page.keyboard.press("u");
			await eventually(
				() => server.api("timeline", { ref: "C-1" }),
				(reply) => reply.entries.filter((entry) => entry.t === "placement").length === 2,
			);
			const undone = await eventually(
				() => server.api("get", { refs: ["C-1"] }),
				(rows) => Array.isArray(rows[0]?.tags) && rows[0]?.tags.length === 0,
			);
			expect(undone[0]?.version).toBe(1);
			expect(h.errors).toEqual([]);
		} finally {
			release();
			await h.close();
			await server.stop();
		}
	},
	30_000,
);
