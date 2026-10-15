import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { CaseView } from "../../src/web/suite/model.ts";
import { browserAvailable, eventually, openPage, startServer } from "./support.ts";

test.skipIf(!browserAvailable)(
	"insert a pinned fragment, read it inline, and update only selected users",
	async () => {
		const server = await startServer();
		await server.api("propose", {
			edits: [
				{
					op: "create",
					kind: "fragment",
					body: { title: "Sign in", steps: [{ id: "ab", action: "Enter a password", expected: "Signed in" }] },
				},
				{ op: "create", body: { title: "Checkout", steps: [{ id: "ef", action: "Pay", expected: "Receipt" }] } },
			],
		});
		const h = await openPage(server, { path: "/p/scratch/suite/c/2" });
		try {
			const { page } = h;
			page.setDefaultTimeout(3000);
			await page.getByRole("button", { name: "Checkout", exact: true }).click();
			await page.getByText("Insert fragment", { exact: true }).click();
			await page.getByLabel("Fragment ref", { exact: true }).fill("C-1");
			await page.getByRole("button", { name: "Insert pinned fragment" }).click();
			await page.getByRole("button", { name: "Remove fragment" }).waitFor();
			await page.getByLabel("Case title", { exact: true }).press("Escape");
			const saved = await eventually(
				async () => CaseView.parse((await server.api("get", { refs: ["C-2"] }))[0]),
				(view) => view.sourceSteps?.[1]?.use?.fragment === "C-1",
			);
			expect(saved.sourceSteps?.[1]?.use).toEqual({ fragment: "C-1", version: 1 });
			expect(saved.steps[1]?.action).toBe("Enter a password");
			await page.reload();
			await page.getByText(/^From C-1 v1(?: · Sign in)?$/).waitFor();
			await page.getByText("Enter a password").waitFor();
			const directory = process.env.MAINWORTHY_FRAGMENT_SCREENSHOT_DIR;
			if (directory) {
				await mkdir(directory, { recursive: true });
				await page.screenshot({ path: `${directory}/case-fragment.png`, fullPage: true });
			}
			const run = await server.api("plan", { name: "Pinned checkout", select: { cases: ["C-2"] } });
			await server.api("propose", {
				edits: [
					{ op: "create", body: { title: "Stay pinned", steps: [{ id: "cd", use: { fragment: "C-1", version: 1 } }] } },
					{
						op: "edit",
						case: "C-1",
						base: 1,
						body: { steps: [{ id: "ab", action: "Use a passkey", expected: "Signed in" }] },
					},
				],
			});
			await page.goto(`${server.url}/p/scratch/suite/c/1`);
			await page.getByLabel("Update C-2", { exact: true }).check();
			await page.getByRole("button", { name: "Update selected to v2" }).click();
			const views = await eventually(
				async () => (await server.api("get", { refs: ["C-2", "C-3"] })).map((view) => CaseView.parse(view)),
				(views) => views[0]?.steps[1]?.action === "Use a passkey",
			);
			expect(views[0]?.steps[1]?.action).toBe("Use a passkey");
			expect(views[1]?.steps[0]?.action).toBe("Enter a password");
			await page.goto(`${server.url}/p/scratch/runs/${run.run.slice(2)}`);
			const pinned = page.locator('[data-run-document="C-2"][data-active="true"][data-ready="true"]');
			await pinned.waitFor();
			expect(await pinned.textContent()).toContain("Enter a password");
			expect(await pinned.textContent()).toContain("From C-1 v1");
			expect(await pinned.textContent()).not.toContain("Use a passkey");
			expect(h.errors).toEqual([]);
		} finally {
			await h.close();
			await server.stop();
		}
	},
	30_000,
);

test.skipIf(!browserAvailable)(
	"a new fragment can be authored in the Suite editor",
	async () => {
		const server = await startServer();
		const h = await openPage(server);
		try {
			await h.page.getByTestId("case-list").waitFor();
			await h.page.keyboard.press("c");
			await h.page.getByLabel("Case kind", { exact: true }).selectOption("fragment", { timeout: 3000 });
			await h.page.getByLabel("Case title", { exact: true }).fill("Shared setup", { timeout: 3000 });
			await h.page.getByLabel("Case title", { exact: true }).press("Enter");
			await h.page.getByLabel("Step 1", { exact: true }).fill("Open the application", { timeout: 3000 });
			await h.page.getByLabel("Step 1", { exact: true }).press("Escape");
			const view = await eventually(
				async () => CaseView.safeParse((await server.api("get", { refs: ["C-1"] }))[0]),
				(parsed) => parsed.success,
			);
			expect(view).toMatchObject({
				success: true,
				data: { kind: "fragment", title: "Shared setup", steps: [{ action: "Open the application" }] },
			});
			expect(h.errors).toEqual([]);
		} finally {
			await h.close();
			await server.stop();
		}
	},
	30_000,
);

test.skipIf(!browserAvailable)(
	"fragment usage controls follow a new version while the fragment stays open",
	async () => {
		const server = await startServer();
		await server.api("propose", {
			edits: [
				{
					op: "create",
					kind: "fragment",
					body: { title: "Shared setup", steps: [{ id: "ab", action: "Open", expected: "Ready" }] },
				},
			],
		});
		await server.api("propose", {
			edits: [{ op: "create", body: { title: "User", steps: [{ id: "cd", use: { fragment: "C-1", version: 1 } }] } }],
		});
		const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
		try {
			h.page.setDefaultTimeout(3000);
			await h.page.getByRole("heading", { name: "Fragment users", exact: true }).waitFor();
			expect(await h.page.getByRole("button", { name: "Update selected to v2" }).count()).toBe(0);
			await server.api("propose", {
				edits: [
					{
						op: "edit",
						case: "C-1",
						base: 1,
						body: { steps: [{ id: "ab", action: "Open with a passkey", expected: "Ready" }] },
					},
				],
			});
			await h.page.getByRole("button", { name: "Update selected to v2" }).waitFor();
			await h.page.getByLabel("Update C-2", { exact: true }).check();
			await h.page.getByRole("button", { name: "Update selected to v2" }).click();
			const saved = await eventually(
				async () => CaseView.parse((await server.api("get", { refs: ["C-2"] }))[0]),
				(view) => view.version === 2,
			);
			expect(saved.steps[0]?.action).toBe("Open with a passkey");
		} finally {
			await h.close();
			await server.stop();
		}
	},
	15_000,
);
