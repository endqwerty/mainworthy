import { expect, test } from "bun:test";
import { browserAvailable, openPage, startServer } from "./support.ts";

const check = test.skipIf(!browserAvailable);

check(
	"the sidebar names the project and its button, or g p, picks another one and keeps the screen",
	async () => {
		const server = await startServer({ cases: 2 });
		await server.api("admin", { do: "project.create", key: "checkout", name: "Checkout", preset: "standard" });
		// A name far wider than the sidebar, and the same name twice: the key tells the two apart.
		await server.api("admin", {
			do: "project.create",
			key: "payments",
			name: "Payments platform and everything that settles money",
			preset: "loose",
		});
		await server.api("admin", { do: "project.create", key: "checkout-eu", name: "Checkout", preset: "loose" });
		const h = await openPage(server, { path: "/p/scratch/queue" });
		try {
			const { page } = h;
			page.setDefaultTimeout(5000);
			const button = page.getByRole("button", { name: "Project: scratch. Switch project", exact: true });
			const picker = page.getByRole("region", { name: "Switch project", exact: true });
			const projects = () => picker.getByRole("option").allInnerTexts();
			// The button is the width of the sidebar's other controls, above the search, and says the name in ink.
			const [box, search] = await Promise.all([button.boundingBox(), page.locator(".search").boundingBox()]);
			if (!box || !search) throw new Error("the sidebar has no project button or no search");
			expect(box.width).toBe(search.width);
			expect(box.y + box.height).toBeLessThanOrEqual(search.y);
			expect(await button.locator("b").innerText()).toBe("scratch");

			await button.click();
			// Every project the session names, in its order, with the one that is open marked. The choice starts
			// on the first other project, so the button and Enter go there.
			expect(await projects()).toEqual([
				expect.stringMatching(/scratch[\s\S]*Current · scratch · standard/),
				expect.stringMatching(/Checkout[\s\S]*checkout · standard/),
				expect.stringMatching(/Payments platform[\s\S]*payments · loose/),
				expect.stringMatching(/Checkout[\s\S]*checkout-eu · loose/),
			]);
			expect(await picker.getByRole("option", { selected: true }).innerText()).toContain("checkout · standard");
			// Escape changes nothing and gives the focus back to the button.
			await page.keyboard.press("Escape");
			expect(await picker.count()).toBe(0);
			expect(new URL(page.url()).pathname).toBe("/p/scratch/queue");
			expect(await button.evaluate((node) => node === document.activeElement)).toBe(true);

			// By the keyboard alone: g p, a word of the name or the key, Enter. The screen stays; what was
			// selected in the project left behind does not come along.
			await page.goto(`${server.url}/p/scratch/queue/1`);
			await page.locator("#app").waitFor();
			await page.keyboard.type("gp");
			// Only projects are offered here. A word that is in a case's title and in no project finds nothing,
			// and the cases are not asked for.
			const searches: string[] = [];
			page.on("request", (request) => {
				if (new URL(request.url()).pathname.endsWith("/find")) searches.push(request.postData() ?? "");
			});
			await picker.getByRole("textbox").fill("coupon");
			// The empty list says so and no more: here a case's ref finds nothing either.
			await picker.getByText("No matches.", { exact: true }).waitFor();
			await picker.getByRole("textbox").fill("eu");
			expect(await projects()).toEqual([expect.stringMatching(/Checkout[\s\S]*checkout-eu · loose/)]);
			expect(searches.filter((sent) => sent.includes("coupon"))).toEqual([]);
			await page.keyboard.press("Enter");
			await page.waitForURL("**/p/checkout-eu/queue");
			await page.getByRole("button", { name: "Project: Checkout. Switch project", exact: true }).waitFor();
			expect(h.loads()).toBe(2);
			// The focus is on nothing, so the next key is the screen's.
			await page.keyboard.type("gs");
			await page.waitForURL("**/p/checkout-eu/suite");
			await page.keyboard.press("c");
			expect(await page.getByRole("textbox", { name: "Case title", exact: true }).count()).toBe(1);
			await page.keyboard.press("Escape");

			// From a case, the other project opens at its Suite. Choosing the project that is open goes nowhere.
			await page.goto(`${server.url}/p/scratch/suite/c/1`);
			await page.locator("#app").waitFor();
			await page.keyboard.type("gp");
			await picker.getByRole("option", { name: /Current/ }).click();
			expect(await picker.count()).toBe(0);
			expect(new URL(page.url()).pathname).toBe("/p/scratch/suite/c/1");
			await page.keyboard.type("gp");
			await picker.getByRole("textbox").fill("payments");
			await page.keyboard.press("Enter");
			await page.waitForURL("**/p/payments/suite");
			// Back is the project and the case that were open.
			await page.goBack();
			await page.waitForURL("**/p/scratch/suite/c/1");

			// The palette finds a project by a word of its name, and does not offer the one that is open.
			await page.keyboard.press("Control+k");
			const palette = page.getByRole("region", { name: "Command palette", exact: true });
			await palette.getByRole("textbox").fill("project");
			await palette.getByRole("option", { name: /Switch project/ }).waitFor();
			const offered = (await palette.getByRole("option").allInnerTexts()).filter((text) => text.includes("Project: "));
			expect(offered).toEqual([
				expect.stringMatching(/Project: Checkout[\s\S]*checkout · standard$/),
				expect.stringMatching(/Project: Payments platform[\s\S]*payments · loose$/),
				expect.stringMatching(/Project: Checkout[\s\S]*checkout-eu · loose$/),
			]);
			// "Switch project", chosen in the palette, opens the picker with nothing typed in it.
			await palette.getByRole("textbox").fill("switch project");
			await page.keyboard.press("Enter");
			await picker.waitFor();
			expect(await picker.getByRole("textbox").inputValue()).toBe("");
			expect((await projects()).length).toBe(4);
			await page.keyboard.press("Escape");

			// The long name is cut short in the button, which stays inside the sidebar; the mark keeps its size.
			await page.goto(`${server.url}/p/payments/runs`);
			const long = page.getByRole("button", { name: /^Project: Payments platform/ });
			await long.waitFor();
			const wide = await long.boundingBox();
			expect(wide && wide.x + wide.width <= 236).toBe(true);
			expect(await page.locator(".brand .logo").evaluate((node) => node.getBoundingClientRect().width)).toBe(20);

			// Collapsed, the button is still there, inside the sidebar, and opens the same picker. It shows the
			// name's first letter as it is read: a flag is one letter, though it is two code points.
			await server.api("admin", { do: "project.create", key: "ca", name: "🇨🇦 Canada", preset: "loose" });
			// A name that shows nothing (the server takes one) is not what the line says: it says the key.
			await server.api("admin", { do: "project.create", key: "blank", name: " \u200b", preset: "loose" });
			await page.goto(`${server.url}/p/blank/runs`);
			const unnamed = page.getByRole("button", { name: "Project: blank. Switch project", exact: true });
			expect(await unnamed.locator("b").innerText()).toBe("blank");
			await unnamed.click();
			await picker.getByRole("option", { name: /blank[\s\S]*Current · blank · loose/ }).waitFor();
			await page.keyboard.press("Escape");
			await page.goto(`${server.url}/p/ca/runs`);
			const flagged = page.getByRole("button", { name: "Project: 🇨🇦 Canada. Switch project", exact: true });
			await flagged.waitFor();
			await page.keyboard.press("[");
			const small = await flagged.boundingBox();
			expect(small && small.width > 0 && small.x >= 0 && small.x + small.width <= 64).toBe(true);
			expect(await flagged.locator(".project-initial").innerText()).toBe("🇨🇦");
			await flagged.click();
			await picker.getByRole("textbox").fill("scratch");
			await page.keyboard.press("Enter");
			await page.waitForURL("**/p/scratch/runs");
			await page.keyboard.press("[");

			// In a narrow window too.
			await page.setViewportSize({ width: 700, height: 800 });
			const narrow = await button.boundingBox();
			expect(narrow && narrow.width > 0 && narrow.x + narrow.width <= 120).toBe(true);
			await button.click();
			await picker.waitFor();
			await page.keyboard.press("Escape");

			// The key is on the sheet of keys.
			await page.keyboard.press("?");
			expect(
				await page
					.getByRole("region", { name: "Keyboard shortcuts" })
					.locator(".hk")
					.filter({ hasText: "Switch project" })
					.innerText(),
			).toContain("g p");
			expect(h.dialogs).toEqual([]);
			expect(h.errors).toEqual([]);
		} finally {
			await h.close();
			await server.stop();
		}
	},
	45_000,
);

check(
	"with one project the sidebar names it and offers nothing to pick",
	async () => {
		const server = await startServer();
		const h = await openPage(server);
		try {
			const { page } = h;
			page.setDefaultTimeout(5000);
			expect(await page.locator(".project").innerText()).toMatch(/^Project\s+scratch$/i);
			expect(await page.getByRole("button", { name: /Switch project/ }).count()).toBe(0);
			// Collapsed, the line shows the first letter, and what is read out is still the whole name.
			await page.keyboard.press("[");
			expect(await page.locator(".project-initial").isVisible()).toBe(true);
			expect(await page.locator(".project").ariaSnapshot()).toContain("Project scratch");
			const line = await page.locator(".project").boundingBox();
			expect(line && line.x >= 0 && line.x + line.width <= 64).toBe(true);
			await page.keyboard.press("[");
			await page.keyboard.type("gp");
			expect(await page.locator("[data-overlay]").count()).toBe(0);
			await page.keyboard.press("Control+k");
			await page.getByRole("textbox", { name: "Jump to or run" }).fill("project");
			expect(
				await page
					.getByRole("option")
					.filter({ hasText: /Switch project|Project: / })
					.count(),
			).toBe(0);
			await page.keyboard.press("Escape");
			await page.keyboard.press("?");
			expect(await page.locator(".hk").filter({ hasText: "Switch project" }).count()).toBe(0);
			expect(h.errors).toEqual([]);
		} finally {
			await h.close();
			await server.stop();
		}
	},
	30_000,
);

check(
	"on a phone the project's line is in the drawer, a finger picks another project from it, and Actions offers the same",
	async () => {
		const server = await startServer({ cases: 2 });
		await server.api("admin", { do: "project.create", key: "checkout", name: "Checkout", preset: "standard" });
		const h = await openPage(server, { device: "phone", path: "/p/scratch/queue" });
		try {
			const { page } = h;
			page.setDefaultTimeout(5000);
			const button = page.getByRole("button", { name: "Project: scratch. Switch project", exact: true });
			const picker = page.getByRole("region", { name: "Switch project", exact: true });
			expect(await button.isVisible()).toBe(false);
			await page.getByRole("button", { name: "Menu", exact: true }).tap();
			// In the drawer the line is as wide as the search under it, tall enough for a thumb, and shows no key.
			const [box, search] = await Promise.all([button.boundingBox(), page.locator(".search").boundingBox()]);
			if (!box || !search) throw new Error("the drawer has no project button or no search");
			expect(box.width).toBe(search.width);
			expect(box.height).toBeGreaterThanOrEqual(40);
			expect(await button.locator("kbd").isVisible()).toBe(false);
			await button.tap();
			// The picker covers the drawer. Its field does not take the focus, so no keyboard comes up over the rows.
			await picker.waitFor();
			expect(await page.locator("#side").isVisible()).toBe(false);
			expect(await picker.getByRole("textbox").evaluate((node) => node === document.activeElement)).toBe(false);
			await picker.getByRole("option", { name: /Checkout[\s\S]*checkout · standard/ }).tap();
			await page.waitForURL("**/p/checkout/queue");
			expect(await picker.count()).toBe(0);
			expect(
				await page.evaluate(() => {
					const node = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
					return node?.closest("#list, #detail, #side")?.id;
				}),
			).toBe("list");
			// Actions offers it while the list is shown: it goes somewhere and records nothing about a row.
			await page.getByRole("button", { name: "Actions", exact: true }).tap();
			await page
				.locator("[data-overlay=palette]")
				.getByRole("option", { name: /Switch project/ })
				.tap();
			await picker.getByRole("option", { name: /scratch[\s\S]*scratch · standard/ }).tap();
			await page.waitForURL("**/p/scratch/queue");
			expect(h.loads()).toBe(1);
			expect(h.errors).toEqual([]);
		} finally {
			await h.close();
			await server.stop();
		}
	},
	30_000,
);
