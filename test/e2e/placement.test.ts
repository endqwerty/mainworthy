import { expect, test } from "bun:test";
import { z } from "zod";
import { browserAvailable, eventually, openPage, startServer } from "./support.ts";

test.skipIf(!browserAvailable)(
	"UI-5 one immediate undo is queued behind a pending tag write",
	async () => {
		const server = await startServer();
		await server.api("propose", { edits: [{ op: "create", body: { title: "Undo while saving" } }] });
		const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
		try {
			const { page } = h;
			await page.getByRole("button", { name: "Undo while saving", exact: true }).waitFor();
			let writes = 0;
			await page.route("**/api/p/scratch/propose", async (route) => {
				writes++;
				await Bun.sleep(500);
				await route.continue();
			});
			await page.keyboard.press("t");
			await page.keyboard.type("earlyundo");
			await page.keyboard.press("Enter");
			expect(await page.locator(".ctags").textContent()).toContain("#earlyundo");
			await page.keyboard.press("u");
			expect(await page.locator(".ctags").textContent()).not.toContain("#earlyundo");
			await page.keyboard.press("u");
			await eventually(
				async () => writes,
				(count) => count === 2,
			);
			const rows = await eventually(
				() => server.api("get", { refs: ["C-1"] }),
				(rows) => Array.isArray(rows[0]?.tags) && rows[0]?.tags.length === 0,
			);
			expect(rows[0]?.version).toBe(1);
			const timeline = await server.api("timeline", { ref: "C-1" });
			expect(timeline.entries.filter((entry) => entry.t === "placement")).toHaveLength(2);
			expect(h.errors).toEqual([]);
		} finally {
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
			try {
				const { page } = h;
				await page.getByRole("button", { name: "Placement undo case", exact: true }).waitFor();
				let writes = 0;
				await page.route("**/api/p/scratch/propose", async (route) => {
					writes++;
					await Bun.sleep(500);
					await route.continue();
				});
				if (action === "move") {
					await page.keyboard.press("m");
					await page.getByRole("textbox", { name: "Move selected cases to a folder" }).fill("Destination");
					await page.keyboard.press("Enter");
					expect(await page.locator(".cmeta .path").textContent()).toBe("Destination");
				} else {
					await page.keyboard.press("#");
					expect(await page.getByRole("option").filter({ hasText: "Placement undo case" }).count()).toBe(0);
				}
				await page.keyboard.press("u");
				if (action === "move") expect(await page.locator(".cmeta .path").textContent()).toBe("Original");
				else expect(await page.getByRole("option").filter({ hasText: "Placement undo case" }).count()).toBe(1);
				await eventually(
					async () => writes,
					(count) => count === 2,
				);
				const rows = await eventually(
					() => server.api("get", { refs: ["C-1"] }),
					(rows) =>
						action === "move"
							? z.object({ path: z.string() }).parse(rows[0]?.folder).path === "Original"
							: rows[0]?.state === "active",
				);
				expect(rows[0]?.version).toBe(1);
				const timeline = await server.api("timeline", { ref: "C-1" });
				expect(timeline.entries.filter((entry) => entry.t === "placement")).toHaveLength(2);
				expect(h.errors).toEqual([]);
			} finally {
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
		try {
			const { page } = h;
			await page.getByRole("button", { name: "Tag this case", exact: true }).waitFor();
			await page.route("**/api/p/scratch/propose", async (route) => {
				await Bun.sleep(300);
				await route.continue();
			});
			await page.keyboard.press("t");
			await page.keyboard.type("checkout");
			await page.keyboard.press("Enter");
			expect(await page.locator(".ctags").textContent()).toContain("#checkout");
			expect((await server.api("get", { refs: ["C-1"] }))[0]?.tags).toEqual([]);
			await eventually(
				() => server.api("get", { refs: ["C-1"] }),
				(rows) => Array.isArray(rows[0]?.tags) && rows[0]?.tags.includes("checkout"),
			);
			await page.keyboard.press("u");
			const undone = await eventually(
				() => server.api("get", { refs: ["C-1"] }),
				(rows) => Array.isArray(rows[0]?.tags) && rows[0]?.tags.length === 0,
			);
			expect(undone[0]?.version).toBe(1);
			expect(h.errors).toEqual([]);
		} finally {
			await h.close();
			await server.stop();
		}
	},
	30_000,
);
