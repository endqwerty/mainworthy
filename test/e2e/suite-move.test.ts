import { expect, test } from "bun:test";
import { z } from "zod";
import { browserAvailable, eventually, openPage, type Server, startServer } from "./support.ts";

const folders = async (server: Server) =>
	z
		.array(z.object({ folder: z.object({ path: z.string() }), version: z.number() }))
		.parse(await server.api("get", { refs: ["C-1", "C-2", "C-3"] }))
		.map((row) => ({ folder: row.folder.path, version: row.version }));

async function move(page: Awaited<ReturnType<typeof openPage>>["page"]) {
	await page.keyboard.press("m");
	await page.getByRole("textbox", { name: "Move selected cases to a folder" }).fill("Destination");
	await page.keyboard.press("Enter");
}

for (const unreadable of [false, true]) {
	test.skipIf(!browserAvailable)(
		unreadable
			? "moving an unreadable hidden selection changes nothing and can be retried"
			: "move undo restores visible and hidden selected cases to their own folders",
		async () => {
			const server = await startServer();
			await server.api("propose", {
				edits: [
					{ op: "create", outline: "Hidden original", folder: "Original" },
					{ op: "create", outline: "Hidden unsorted" },
					{ op: "create", outline: "Visible case", folder: "Other" },
					{ op: "folder", name: "Destination" },
				],
			});
			const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
			try {
				const { page } = h;
				await page.getByRole("button", { name: "Hidden original", exact: true }).waitFor();
				for (const title of ["Hidden original", "Hidden unsorted", "Visible case"]) {
					await page.getByRole("option").filter({ hasText: title }).click();
					await page.keyboard.press("x");
				}
				await page.getByRole("textbox", { name: "Filter cases" }).fill("Visible");
				await page.getByRole("option").filter({ hasText: "Hidden" }).first().waitFor({ state: "detached" });
				await page.getByRole("option").filter({ hasText: "Visible case" }).click();
				expect(await page.locator(".bulk-indicator").textContent()).toBe("3 selected");
				if (unreadable) {
					await page.context().route("**/api/p/scratch/get", async (route) => {
						const input = z.object({ refs: z.array(z.string()) }).parse(route.request().postDataJSON());
						if (!input.refs.includes("C-1")) return route.continue();
						await route.fulfill({
							status: 503,
							contentType: "application/json",
							body: JSON.stringify({ ok: false, error: { code: "internal", message: "Selected case unavailable" } }),
						});
					});
					await move(page);
					await page.locator("#stat").filter({ hasText: "Selected case unavailable" }).waitFor();
					expect((await folders(server)).map((row) => row.folder)).toEqual(["Original", "Unsorted", "Other"]);
					expect(await page.locator(".bulk-indicator").textContent()).toBe("3 selected");
					await page.context().unroute("**/api/p/scratch/get");
				}
				await move(page);
				await eventually(
					() => folders(server),
					(rows) => rows.every((row) => row.folder === "Destination"),
				);
				await page.locator("#stat").filter({ hasText: "3 cases changed." }).waitFor();
				await page.keyboard.press("u");
				await page.locator("#stat").filter({ hasText: "Undone." }).waitFor();
				await page.getByRole("textbox", { name: "Filter cases" }).fill("");
				await page.getByRole("option").filter({ hasText: "Hidden original" }).waitFor();
				await page.getByRole("option").filter({ hasText: "Hidden original" }).click();
				if (!unreadable && process.env.MAINWORTHY_MOVE_SCREENSHOT)
					await page.screenshot({ path: process.env.MAINWORTHY_MOVE_SCREENSHOT });
				expect(await folders(server)).toEqual([
					{ folder: "Original", version: 1 },
					{ folder: "Unsorted", version: 1 },
					{ folder: "Other", version: 1 },
				]);
				expect(h.errors).toEqual(
					unreadable
						? ["Failed to load resource: the server responded with a status of 503 (Service Unavailable)"]
						: [],
				);
			} finally {
				await h.close();
				await server.stop();
			}
		},
		30_000,
	);
}

test.skipIf(!browserAvailable)(
	"dragging an unpicked case moves and undoes that case rather than the picked selection",
	async () => {
		const server = await startServer();
		await server.api("propose", {
			edits: [
				{ op: "create", outline: "Visible picked", folder: "Original" },
				{ op: "create", outline: "Dragged case", folder: "Other" },
				{ op: "create", outline: "Visible untouched" },
				{ op: "folder", name: "Destination" },
			],
		});
		const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
		try {
			const { page } = h;
			await page.getByRole("button", { name: "Visible picked", exact: true }).waitFor();
			await page.keyboard.press("x");
			await page
				.getByRole("option")
				.filter({ hasText: "Dragged case" })
				.dragTo(page.locator("button.fo").filter({ hasText: "Destination" }));
			expect(
				await eventually(
					() => folders(server),
					(rows) => rows[1]?.folder === "Destination",
				),
			).toEqual([
				{ folder: "Original", version: 1 },
				{ folder: "Destination", version: 1 },
				{ folder: "Unsorted", version: 1 },
			]);
			await page.locator("#stat").filter({ hasText: "changed." }).waitFor();
			await page.keyboard.press("u");
			await page.locator("#stat").filter({ hasText: "Undone." }).waitFor();
			expect(await folders(server)).toEqual([
				{ folder: "Original", version: 1 },
				{ folder: "Other", version: 1 },
				{ folder: "Unsorted", version: 1 },
			]);
			expect(h.errors).toEqual([]);
		} finally {
			await h.close();
			await server.stop();
		}
	},
	30_000,
);
