import { expect, test } from "bun:test";
import type { Page } from "playwright-core";
import { browserAvailable, eventually, openPage, startServer } from "./support.ts";

const palette = (page: Page) => page.getByRole("region", { name: "Command palette", exact: true });
const command = (page: Page, label: string) =>
	palette(page)
		.getByRole("option")
		.filter({ has: page.locator(".t", { hasText: new RegExp(`^${label}$`) }) });
const actions = async (page: Page) => {
	await page.getByRole("button", { name: "Actions", exact: true }).tap();
	await palette(page).waitFor();
};
const choose = async (page: Page, label: string) => {
	await actions(page);
	await page.locator(".palette-input").fill(label);
	await command(page, label).tap();
	await palette(page).waitFor({ state: "detached" });
};

test.skipIf(!browserAvailable)(
	"saved-case Actions offers one Edit case and no editor commands",
	async () => {
		const server = await startServer({ cases: 1 });
		const phone = await openPage(server, { device: "phone", path: "/p/scratch/suite/c/1" });
		try {
			const { page } = phone;
			await page.locator("#detail .ctitle").waitFor();
			await actions(page);
			expect(await command(page, "Edit case").count()).toBe(1);
			for (const label of [
				"Seal and leave editor",
				"Record version",
				"Next new case",
				"First step",
				"Next step",
				"Expected result",
			])
				expect([label, await command(page, label).count()]).toEqual([label, 0]);
			await command(page, "Edit case").tap();
			await page.getByRole("textbox", { name: "Case title", exact: true }).waitFor();
			expect(phone.errors).toEqual([]);
		} finally {
			await phone.close();
			await server.stop();
		}
	},
	30_000,
);

test.skipIf(!browserAvailable)(
	"editor-only shortcuts do nothing while reading a saved case",
	async () => {
		const server = await startServer({ cases: 1 });
		const phone = await openPage(server, { device: "phone", path: "/p/scratch/suite/c/1" });
		try {
			const { page } = phone;
			await page.locator("#detail .ctitle").waitFor();
			for (const key of ["ControlOrMeta+Enter", "Escape", "Shift+Enter"]) await page.keyboard.press(key);
			expect(new URL(page.url()).pathname).toBe("/p/scratch/suite/c/1");
			expect(await page.getByRole("textbox", { name: "Case title", exact: true }).count()).toBe(0);
			await page.keyboard.press("Enter");
			await page.getByRole("textbox", { name: "Case title", exact: true }).waitFor();
			expect(phone.errors).toEqual([]);
		} finally {
			await phone.close();
			await server.stop();
		}
	},
	30_000,
);

test.skipIf(!browserAvailable)(
	"editor Actions keeps applicable field commands when the palette takes focus",
	async () => {
		const server = await startServer();
		const phone = await openPage(server, { device: "phone" });
		try {
			const { page } = phone;
			await choose(page, "New case");
			const title = page.getByRole("textbox", { name: "Case title", exact: true });
			await title.fill("A case written through Actions");
			await actions(page);
			for (const label of ["First step", "Next new case", "Record version", "Seal and leave editor"])
				expect([label, await command(page, label).count()]).toEqual([label, 1]);
			for (const label of ["Edit case", "Next step", "Expected result"])
				expect([label, await command(page, label).count()]).toEqual([label, 0]);
			await command(page, "First step").tap();
			const step = page.getByRole("textbox", { name: "Step 1", exact: true });
			await step.fill("Open the case");
			await choose(page, "Expected result");
			await page.getByRole("textbox", { name: "Expected result 1", exact: true }).fill("The case is shown");
			await actions(page);
			expect(await command(page, "Expected result").count()).toBe(0);
			expect(await command(page, "Next step").count()).toBe(1);
			await command(page, "Next step").tap();
			await page.getByRole("textbox", { name: "Step 2", exact: true }).fill("Read the result");
			await choose(page, "Record version");
			await eventually(
				async () => (await server.api("find", { in: "cases", text: "A case written through Actions" })).items.length,
				(count) => count === 1,
			);
			await page.getByRole("textbox", { name: "Preconditions", exact: true }).fill("A saved case exists");
			await actions(page);
			for (const label of ["First step", "Next step", "Expected result"])
				expect([label, await command(page, label).count()]).toEqual([label, 0]);
			await page.keyboard.press("Escape");
			await title.fill("Another case through Actions");
			await choose(page, "Next new case");
			expect(await title.inputValue()).toBe("");
			expect(await page.getByRole("textbox", { name: "Step 1", exact: true }).count()).toBe(0);
			await title.fill("Leave this editor through Actions");
			await choose(page, "Seal and leave editor");
			await eventually(
				async () => (await server.api("find", { in: "cases", text: "Leave this editor through Actions" })).items.length,
				(count) => count === 1,
			);
			expect(phone.errors).toEqual([]);
		} finally {
			await phone.close();
			await server.stop();
		}
	},
	30_000,
);

test.skipIf(!browserAvailable)(
	"editor commands remain available while a version is being recorded",
	async () => {
		const server = await startServer({ cases: 1 });
		const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
		const sent = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		try {
			const { page } = h;
			await page.locator("#detail .ctitle").waitFor();
			await page.keyboard.press("e");
			const title = page.getByRole("textbox", { name: "Case title", exact: true });
			await title.fill("A recording still in flight");
			await page.route("**/propose", async (route) => {
				sent.resolve();
				await release.promise;
				await route.continue();
			});
			await page.keyboard.press("ControlOrMeta+Enter");
			await sent.promise;
			await title.fill("Text typed while recording");
			await page.keyboard.press("ControlOrMeta+k");
			await palette(page).waitFor();
			for (const label of ["Seal and leave editor", "Record version"])
				expect([label, await command(page, label).count()]).toEqual([label, 1]);
			await page.keyboard.press("Escape");
			await title.focus();
			await page.keyboard.press("Escape");
			expect(await title.evaluate((node) => node === document.activeElement)).toBe(false);
			release.resolve();
			await eventually(
				async () => (await server.api("find", { in: "cases", text: "Text typed while recording" })).items.length,
				(count) => count === 1,
			);
			expect(h.errors).toEqual([]);
		} finally {
			release.resolve();
			await h.close();
			await server.stop();
		}
	},
	30_000,
);
