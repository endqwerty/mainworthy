// A phone gets one pane at a time, the sidebar as a drawer and every action under one button (decision 0018).
// A browser worked with a mouse gets none of it, at any width.
import { expect, test } from "bun:test";
import type { Page } from "playwright-core";
import { z } from "zod";
import { browserAvailable, eventually, openPage, startServer } from "./support.ts";

/** What a person sees in the middle of the window: one of the two panes, the sidebar, or an overlay. */
const inView = (page: Page): Promise<string> =>
	page.evaluate(() => {
		const node = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
		return node?.closest("#list, #detail, #side")?.id ?? (node?.closest("[data-overlay]") ? "overlay" : "nothing");
	});
/** How far the page is wider than the window. A phone cannot show what is beside it. */
const overflow = (page: Page): Promise<number> =>
	page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
const width = (page: Page, selector: string): Promise<number> =>
	page.locator(selector).evaluate((node) => node.getBoundingClientRect().width);
/** The fields iOS would zoom the page for: those whose text is smaller than 16px. */
const smallFields = (page: Page): Promise<string[]> =>
	page.evaluate(() =>
		[...document.querySelectorAll("input, textarea, select")]
			.filter((node) => Number.parseFloat(getComputedStyle(node).fontSize) < 16)
			.map((node) => `${node.tagName.toLowerCase()}#${node.id}.${node.className}`),
	);
/** The results of a run that are not wholly inside the window. A thumb cannot press what is beside or under it. */
const outside = (page: Page): Promise<string[]> =>
	page.evaluate(() =>
		[...document.querySelectorAll(".run-controls .out")]
			.filter((node) => {
				const box = node.getBoundingClientRect();
				return box.width === 0 || box.left < 0 || box.top < 0 || box.right > innerWidth || box.bottom > innerHeight;
			})
			.map((node) => node.textContent ?? ""),
	);
/** Two frames of the page: a media query that changed with a resize has told its listeners by then. */
const frames = (page: Page): Promise<void> =>
	page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
/** The pane the focus is in, or "elsewhere": the bar, the sidebar, an overlay or nothing. */
const focusIn = (page: Page): Promise<string> =>
	page.evaluate(() => document.activeElement?.closest("#list, #detail")?.id ?? "elsewhere");
const back = (page: Page) => page.getByRole("button", { name: "Back to the list", exact: true });
const actions = (page: Page) => page.getByRole("button", { name: "Actions", exact: true });

test.skipIf(!browserAvailable)(
	"a preserved copy in Suite has a phone-sized Discard button",
	async () => {
		const server = await startServer({ cases: 1 });
		const phone = await openPage(server, { device: "phone", path: "/p/scratch/suite/c/1" });
		try {
			const { page } = phone;
			await page.locator(".ctitle").waitFor();
			await page.keyboard.press("e");
			await page.locator("[data-field=title]").fill("Draft held in this window");
			await page.evaluate(() => {
				const key = Object.keys(localStorage).find((key) => key.includes(":draft:") && key.endsWith(":C-1"));
				if (!key) throw new Error("Missing Suite draft");
				const draft = JSON.parse(localStorage.getItem(key) ?? "null");
				draft.owner = "closed-window";
				draft.body.title = "Text preserved from the other window";
				localStorage.setItem(
					`${key.replace(":draft:", ":draft-copy:")}:closed-window:copy`,
					JSON.stringify({ draft, state: "lost" }),
				);
			});
			await page.reload();
			const preserved = page.getByRole("textbox", { name: "Preserved draft text", exact: true });
			await preserved.waitFor();
			expect(await preserved.inputValue()).toContain("Text preserved from the other window");
			const discard = page.getByRole("button", { name: "Discard preserved copy", exact: true });
			const target = await discard.boundingBox();
			expect(target?.height).toBeGreaterThanOrEqual(44);
			await discard.tap();
			await preserved.waitFor({ state: "detached" });
			expect(await page.locator("[data-field=title]").inputValue()).toBe("Draft held in this window");
		} finally {
			await phone.close();
			await server.stop();
		}
	},
	30000,
);

test.skipIf(!browserAvailable)(
	"on a phone every screen shows its list, a row opens the detail, and Back returns",
	async () => {
		const server = await startServer({ cases: 40 });
		const phone = await openPage(server, { device: "phone" });
		try {
			const { page } = phone;
			expect(await page.locator("html").getAttribute("data-layout")).toBe("phone");
			for (const screen of ["suite", "queue", "runs", "changes", "settings"]) {
				await page.goto(`${server.url}/p/scratch/${screen}`);
				await page.locator("#list [role=option]").first().waitFor();
				// The list has the whole width, and nothing is beside the window.
				expect([screen, await inView(page)]).toEqual([screen, "list"]);
				expect([screen, await width(page, "#list")]).toEqual([screen, 390]);
				expect([screen, await overflow(page)]).toEqual([screen, 0]);
				expect(await back(page).count()).toBe(0);
				await page.locator("#list [role=option]").first().tap();
				await eventually(
					() => inView(page),
					(pane) => pane === "detail",
				);
				expect([screen, await width(page, "#detail")]).toEqual([screen, 390]);
				expect([screen, await overflow(page)]).toEqual([screen, 0]);
				expect([screen, await smallFields(page)]).toEqual([screen, []]);
				await back(page).tap();
				expect([screen, await inView(page)]).toEqual([screen, "list"]);
				// The same row again: the address did not change, and the detail still opens.
				await page.locator("#list [role=option]").first().tap();
				expect([screen, await inView(page)]).toEqual([screen, "detail"]);
			}
			// A link to one thing opens on that thing, and the browser's own Back leaves it.
			await page.goto(`${server.url}/p/scratch/suite`);
			await page.getByRole("option", { name: /^C-2 / }).tap();
			await page.waitForURL("**/suite/c/2");
			expect(await inView(page)).toBe("detail");
			await page.goBack();
			await page.waitForURL("**/p/scratch/suite");
			expect(await inView(page)).toBe("list");
			await page.goto(`${server.url}/p/scratch/suite/c/3`);
			await page.locator("#detail .ctitle").waitFor();
			expect(await inView(page)).toBe("detail");
			// After Back the address still names the case. Asking the palette for that case opens it again.
			await back(page).tap();
			expect(await inView(page)).toBe("list");
			await actions(page).tap();
			await page.locator(".palette-input").fill("C-3");
			await page
				.locator("[data-overlay=palette]")
				.getByRole("option", { name: /Go to C-3/ })
				.tap();
			await eventually(
				() => inView(page),
				(pane) => pane === "detail",
			);
			// The browser's Back out of an editor shows the list its address names, whatever had the focus.
			await page.goto(`${server.url}/p/scratch/suite`);
			await page.getByRole("option", { name: /^C-2 / }).tap();
			await page.waitForURL("**/suite/c/2");
			await actions(page).tap();
			await page
				.locator("[data-overlay=palette]")
				.getByRole("option", { name: /Edit case/ })
				.first()
				.tap();
			await eventually(
				() => page.evaluate(() => document.activeElement?.getAttribute("data-field")),
				(field) => field === "title",
			);
			await page.keyboard.type("x");
			await page.goBack();
			await page.waitForURL("**/p/scratch/suite");
			await frames(page);
			expect(await inView(page)).toBe("list");
			await page.goForward();
			await page.waitForURL("**/suite/c/2");
			await frames(page);
			expect(await inView(page)).toBe("detail");
			await page.goto(`${server.url}/p/scratch/suite/c/3`);
			await page.locator("#detail .ctitle").waitFor();
			// The footer's hints name keys, and a phone has none. What the page says is still there.
			expect(await page.locator("#hints").isVisible()).toBe(false);
			expect(await page.locator("#stat").isVisible()).toBe(true);
			// The filter is sized by its id, and still is not a field iOS zooms the page for. Its hint fits in it.
			expect(await page.locator("#filter").evaluate((node) => getComputedStyle(node).fontSize)).toBe("16px");
			const hint = await page.locator("#filter").evaluate((node) => {
				const pen = document.createElement("canvas").getContext("2d");
				if (!(node instanceof HTMLInputElement) || !pen) return null;
				pen.font = getComputedStyle(node).font;
				return { text: pen.measureText(node.placeholder).width, field: node.clientWidth };
			});
			expect(hint !== null && hint.text <= hint.field).toBe(true);
			expect(phone.errors).toEqual([]);
		} finally {
			await phone.close();
			await server.stop();
		}
	},
	60_000,
);

test.skipIf(!browserAvailable)(
	"closing the phone drawer with its keyboard button returns focus to Menu",
	async () => {
		const server = await startServer({ cases: 1 });
		const phone = await openPage(server, { device: "phone" });
		try {
			const { page } = phone;
			const menu = page.getByRole("button", { name: "Menu", exact: true });
			const close = page.locator("#side").getByRole("button", { name: "Close menu", exact: true });
			await menu.focus();
			await page.keyboard.press("Enter");
			await page.locator('#app[data-menu="open"]').waitFor();
			expect(await close.evaluate((node) => node === document.activeElement)).toBe(true);
			await page.keyboard.press("Enter");
			await page.locator('#app[data-menu="closed"]').waitFor();
			expect(await menu.evaluate((node) => node === document.activeElement)).toBe(true);
			await page.keyboard.press("Tab");
			expect(await actions(page).evaluate((node) => node === document.activeElement)).toBe(true);
			expect(phone.errors).toEqual([]);
		} finally {
			await phone.close();
			await server.stop();
		}
	},
	30000,
);

test.skipIf(!browserAvailable)(
	"on a phone the sidebar is a drawer, and Actions offers the actions of what is shown",
	async () => {
		const server = await startServer({ cases: 40 });
		const phone = await openPage(server, { device: "phone" });
		try {
			const { page } = phone;
			const menu = page.getByRole("button", { name: "Menu", exact: true });
			const side = page.locator("#side");
			expect(await side.isVisible()).toBe(false);
			await menu.tap();
			expect(await side.isVisible()).toBe(true);
			expect(await menu.getAttribute("aria-expanded")).toBe("true");
			// The drawer says the product's name beside the mark, as the desktop's sidebar does.
			expect(await side.locator(".brand b").isVisible()).toBe(true);
			expect(await side.locator(".brand b").innerText()).toBe("Mainworthy");
			// The folders are in it, and choosing one closes it.
			await side.getByRole("button", { name: /^Accounts/ }).tap();
			await page.waitForURL("**/suite?folder=Accounts");
			expect(await side.isVisible()).toBe(false);
			expect(await page.locator("#ltitle").innerText()).toBe("Accounts");
			await menu.tap();
			await page.locator(".menu-backdrop").tap({ position: { x: 380, y: 400 } });
			expect(await side.isVisible()).toBe(false);
			// Settings is in the sidebar's footer, and a finger reaches it there.
			await menu.tap();
			await side.getByRole("link", { name: "Settings", exact: true }).tap();
			await page.waitForURL("**/p/scratch/settings");
			expect(await side.isVisible()).toBe(false);
			expect(await page.locator("#top b").innerText()).toBe("Settings");
			await menu.tap();
			await side.getByRole("link", { name: "Queue", exact: true }).tap();
			await page.waitForURL("**/p/scratch/queue");
			expect(await side.isVisible()).toBe(false);
			expect(await inView(page)).toBe("list");

			// A question is selected in the list and its evidence is not shown: nothing answers it from here. The
			// palette offers what belongs to the list, and the answers once the question is open.
			const question = (await server.api("inbox", { kind: "failure" })).items[0];
			if (!question) throw new Error("The seed has no failure to answer");
			const offered = (name: RegExp) => page.locator("[data-overlay=palette]").getByRole("option", { name }).count();
			const closePalette = () =>
				page.locator("[data-overlay=palette] .overlay-backdrop").tap({ position: { x: 4, y: 20 } });
			await page.locator("#list [role=option]").first().waitFor();
			await actions(page).tap();
			expect(await offered(/Go to Suite/)).toBe(1);
			expect([await offered(/Flaky/), await offered(/Defect in the product/), await offered(/question/)]).toEqual([
				0, 0, 0,
			]);
			await closePalette();
			await page.locator(`[data-question="${question.q}"] [role=option]`).tap();
			await page.locator(`[data-current-question="${question.q}"]`).waitFor();
			await actions(page).tap();
			expect([await offered(/Flaky/), await offered(/Defect in the product/)]).toEqual([1, 1]);
			await closePalette();
			// An answer is also a button, so a finger gives it. The server has the decision.
			await page
				.locator("#detail")
				.getByRole("button", { name: /^Flaky/ })
				.tap();
			await eventually(
				async () => (await server.api("inbox", { kind: "failure" })).items.map((item) => item.q),
				(open) => !open.includes(question.q),
			);
			expect(await inView(page)).toBe("detail");

			// The palette opens with no keyboard over it, and lists what the keys of the screen do.
			await page.goto(`${server.url}/p/scratch/suite`);
			await page.locator("#list [role=option]").first().waitFor();
			await actions(page).tap();
			expect(await inView(page)).toBe("overlay");
			expect(await page.evaluate(() => document.activeElement?.className)).not.toBe("palette-input");
			expect(await offered(/Collapse/)).toBe(0);
			expect(await page.getByRole("button", { name: /sidebar/i }).count()).toBe(0);
			// Over the list of cases: New case and the filter, and nothing that acts on the case not shown.
			expect([await offered(/New case/), await offered(/Filter/)]).toEqual([1, 1]);
			expect([await offered(/Edit case/), await offered(/Archive selected/), await offered(/Accept proposal/)]).toEqual(
				[0, 0, 0],
			);
			// The palette is already open, and a sheet of keys is no use without a keyboard: neither is offered.
			expect([await offered(/Jump to or run/), await offered(/All keys/)]).toEqual([0, 0]);
			// New case: the editor is in the detail, so the detail is shown and the title has the caret.
			await page
				.getByRole("option", { name: /New case/ })
				.first()
				.tap();
			await eventually(
				() => inView(page),
				(pane) => pane === "detail",
			);
			expect(await page.evaluate(() => document.activeElement?.getAttribute("data-field"))).toBe("title");
			expect(await page.evaluate(() => getComputedStyle(document.activeElement ?? document.body).fontSize)).toBe(
				"21px",
			);
			await page.keyboard.type("Written on a phone");
			await page.keyboard.press("Enter");
			await page.keyboard.type("Tap Pay");
			expect(await page.evaluate(() => getComputedStyle(document.activeElement ?? document.body).fontSize)).toBe(
				"16px",
			);
			await actions(page).tap();
			await page.getByRole("option", { name: /Seal and leave editor/ }).tap();
			const written = await eventually(
				async () =>
					(await server.api("find", { in: "cases", text: "Written on a phone" })).items.map((item) => item.title),
				(titles) => titles.length === 1,
			);
			expect(written).toEqual(["Written on a phone"]);

			// New folder: its form is in the sidebar, which the phone keeps closed. The sidebar opens with the form
			// in it and the field has the focus, from Actions over the list and from the keys over an open case.
			const folderField = page.getByRole("textbox", { name: "New folder name", exact: true });
			const folders = async () => (await server.api("find", { in: "folders" })).items.map((item) => item.path);
			await back(page).tap();
			await frames(page);
			expect([await side.isVisible(), await offered(/New folder/)]).toEqual([false, 0]);
			await actions(page).tap();
			expect(await offered(/New folder/)).toBe(1);
			await page
				.locator("[data-overlay=palette]")
				.getByRole("option", { name: /New folder/ })
				.tap();
			await folderField.waitFor();
			expect(await side.isVisible()).toBe(true);
			await eventually(
				() => page.evaluate(() => document.activeElement?.getAttribute("aria-label")),
				(label) => label === "New folder name",
			);
			await page.keyboard.type("Made on a phone");
			await page.keyboard.press("Enter");
			await eventually(folders, (paths) => paths.includes("Made on a phone"));
			await page.locator(".menu-backdrop").tap({ position: { x: 380, y: 400 } });
			expect(await side.isVisible()).toBe(false);
			// With a keyboard attached the key does the same, over the list as over an open case.
			await page.keyboard.type("nf");
			await folderField.waitFor();
			expect(await side.isVisible()).toBe(true);
			expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("New folder name");
			await page.keyboard.press("Escape");
			await page.locator(".menu-backdrop").tap({ position: { x: 380, y: 400 } });
			expect(await folderField.count()).toBe(0);
			expect(phone.errors).toEqual([]);
		} finally {
			await phone.close();
			await server.stop();
		}
	},
	60_000,
);

test.skipIf(!browserAvailable)(
	"on a phone a run is recorded with a thumb: the results stay under the case",
	async () => {
		const server = await startServer({ cases: 40 });
		const phone = await openPage(server, { device: "phone", path: "/p/scratch/runs" });
		try {
			const { page } = phone;
			const run = server.seeded?.run;
			if (!run) throw new Error("The seed has no run");
			await page.getByRole("option", { name: new RegExp(run) }).tap();
			await page.getByRole("button", { name: "Open cockpit" }).tap();
			await page.waitForURL(`**/runs/${run.slice(2)}`);
			expect(await inView(page)).toBe("detail");
			const pass = page.getByRole("button", { name: "Pass", exact: true });
			expect(await outside(page)).toEqual([]);
			const filled = async () =>
				(await server.api("find", { in: "slots", run })).items.reduce(
					(count, slot) => count + (Array.isArray(slot.fills) ? slot.fills.length : 0),
					0,
				);
			const before = await filled();
			await pass.tap();
			await eventually(filled, (count) => count === before + 1);
			// The next case is shown where the last one was: the phone stays on the detail.
			expect(await inView(page)).toBe("detail");
			await back(page).tap();
			expect(await inView(page)).toBe("list");
			expect(await overflow(page)).toBe(0);
			// Over the list of slots the case is covered, and no result is offered for it.
			await actions(page).tap();
			const offered = (name: RegExp) => page.locator("[data-overlay=palette]").getByRole("option", { name }).count();
			expect(await offered(/Go to Suite/)).toBe(1);
			expect([await offered(/Pass/), await offered(/Fail/), await offered(/Blocked/), await offered(/Skip/)]).toEqual([
				0, 0, 0, 0,
			]);
			await page.locator("[data-overlay=palette] .overlay-backdrop").tap({ position: { x: 4, y: 20 } });
			// A case far longer than the window: the four results are still inside it, upright. On its side the
			// phone has no height to pin them in, and they are inside the window at the end of the case.
			const long = await server.api("propose", {
				edits: [
					{
						op: "create",
						folder: "checkout",
						tags: [],
						body: {
							title: "A case of eighty steps",
							methods: ["human"],
							steps: Array.from({ length: 80 }, (_, index) => ({
								id: `s${index}`,
								action: `Step ${index + 1}: open the order, read every line of it and compare it with the invoice`,
								expected: "The two agree, line by line",
							})),
						},
					},
				],
			});
			const planned = await server.api("plan", {
				name: "One long case",
				select: { cases: long.cases.map((made) => made.ref) },
			});
			await page.goto(`${server.url}/p/scratch/runs/${planned.run.slice(2)}`);
			await page.locator('.run-document[data-active="true"][data-ready="true"]').waitFor();
			expect(await inView(page)).toBe("detail");
			expect(await page.locator(".run-documents").evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
			expect(await outside(page)).toEqual([]);
			await page.setViewportSize({ width: 844, height: 390 });
			await eventually(
				() => page.locator("#detail").evaluate((node) => node.scrollHeight > node.clientHeight),
				(scrolls) => scrolls,
			);
			await page.locator("#detail").evaluate((node) => node.scrollTo(0, node.scrollHeight));
			expect(await outside(page)).toEqual([]);
			expect(await overflow(page)).toBe(0);
			await page.setViewportSize({ width: 390, height: 844 });
			// Planning a run: the form is in the detail and its first field takes the caret.
			await page.goto(`${server.url}/p/scratch/runs`);
			await page.getByRole("button", { name: "Plan run" }).tap();
			await eventually(
				() => inView(page),
				(pane) => pane === "detail",
			);
			expect(phone.errors).toEqual([]);
		} finally {
			await phone.close();
			await server.stop();
		}
	},
	60_000,
);

test.skipIf(!browserAvailable)(
	"on a phone with a keyboard attached, the answer, result and archive keys and Tab record nothing about a covered row",
	async () => {
		const server = await startServer({ cases: 40 });
		const phone = await openPage(server, { device: "phone", path: "/p/scratch/queue" });
		try {
			const { page } = phone;
			// Every write the page sends, by the operation's name. A read is not in it.
			const writes: string[] = [];
			page.on("request", (request) => {
				const op = new URL(request.url()).pathname.split("/").pop() ?? "";
				if (["decide", "report", "propose", "plan"].includes(op)) writes.push(op);
			});
			/** A key, and the time a page needs to send what the key made it send. */
			const press = async (key: string) => {
				await page.keyboard.press(key);
				await frames(page);
			};
			await page.locator("#list [role=option]").first().waitFor();
			// The Queue's list: a question is selected, its evidence is under the list. Its answer keys do nothing.
			for (const key of ["f", "d", "t", "i", "u", "Enter"]) await press(key);
			expect(writes).toEqual([]);
			expect(await inView(page)).toBe("list");
			// Tab goes on into the detail. What takes the focus there is shown before Enter can press it.
			for (let tabs = 0; tabs < 40 && (await inView(page)) === "list"; tabs++) await press("Tab");
			expect(await inView(page)).toBe("detail");
			expect(await focusIn(page)).toBe("detail");
			expect(writes).toEqual([]);
			// A button of the detail has the focus. A tap moves the focus to what is tapped in this browser and
			// not in Safari on a phone, so Back and Menu are pressed here without moving it. Covered, the button
			// gives the focus up, and Enter and Space press nothing under what is shown.
			const pressUnfocused = (selector: string) =>
				page.evaluate((found) => document.querySelector<HTMLElement>(found)?.click(), selector);
			await pressUnfocused(".top-back");
			await frames(page);
			expect([await inView(page), await focusIn(page)]).toEqual(["list", "elsewhere"]);
			for (const key of ["Enter", "Space"]) await press(key);
			for (let tabs = 0; tabs < 40 && (await inView(page)) === "list"; tabs++) await press("Tab");
			expect(await focusIn(page)).toBe("detail");
			await pressUnfocused(".top-menu");
			await frames(page);
			expect([await page.locator("#side").isVisible(), await focusIn(page)]).toEqual([true, "elsewhere"]);
			for (const key of ["Enter", "Space"]) await press(key);
			await page.locator(".menu-backdrop").tap({ position: { x: 380, y: 400 } });
			expect(writes).toEqual([]);
			// With the question open, its keys are its keys, as on the desktop.
			const open = async () => (await server.api("inbox", {})).items.map((item) => item.q);
			const shown = await page.locator("[data-current-question]").getAttribute("data-current-question");
			await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : null));
			await press("f");
			await eventually(open, (questions) => shown !== null && !questions.includes(shown));
			expect(writes).toEqual(["decide"]);
			// The sidebar over the open question covers it: its keys do nothing until the sidebar is gone.
			await page.getByRole("button", { name: "Menu", exact: true }).tap();
			expect(await page.locator("#side").isVisible()).toBe(true);
			for (const key of ["f", "d", "t", "u"]) await press(key);
			expect(writes).toEqual(["decide"]);
			// Tab leaves the sidebar for the pane, and the sidebar closes: what has the focus is not under it.
			for (let tabs = 0; tabs < 60 && (await page.locator("#side").isVisible()); tabs++) await press("Tab");
			expect(await page.locator("#side").isVisible()).toBe(false);
			expect(await focusIn(page)).toBe(await inView(page));
			expect(writes).toEqual(["decide"]);

			// The Suite's list: the selected case is not archived, its proposal neither accepted nor rejected.
			await page.goto(`${server.url}/p/scratch/suite`);
			await page.locator("#list [role=option]").first().waitFor();
			writes.length = 0;
			for (const key of ["#", "a", "r", "e", "x", "m"]) await press(key);
			expect(writes).toEqual([]);
			expect(await inView(page)).toBe("list");
			// The keys of the list are still keys: the filter, and the way to another screen.
			await press("/");
			expect(await page.evaluate(() => document.activeElement?.id)).toBe("filter");
			await press("Escape");
			await page.keyboard.type("gr");
			await page.waitForURL("**/p/scratch/runs");

			// A run's list of slots, after Back: no result is recorded for the case under it.
			const run = server.seeded?.run;
			if (!run) throw new Error("The seed has no run");
			await page.goto(`${server.url}/p/scratch/runs/${run.slice(2)}`);
			await page.getByRole("button", { name: "Pass", exact: true }).waitFor();
			writes.length = 0;
			await page.getByRole("button", { name: "Pass", exact: true }).tap();
			await eventually(
				async () => writes.join(),
				(sent) => sent === "report",
			);
			// The button that was pressed has the focus, and Back covers it: it gives the focus up.
			await back(page).tap();
			expect(await inView(page)).toBe("list");
			expect(await focusIn(page)).not.toBe("detail");
			// No result is recorded for the case under the list, and the one just recorded is not taken back.
			for (const key of ["p", "s", "b", "f", "u", "Enter", "Space"]) await press(key);
			expect(writes).toEqual(["report"]);
			expect(await inView(page)).toBe("list");
			expect(phone.errors).toEqual([]);
		} finally {
			await phone.close();
			await server.stop();
		}
	},
	60_000,
);

test.skipIf(!browserAvailable)(
	"on a phone nothing under the palette or the sheet of keys takes the focus, and Back leaves an editor",
	async () => {
		const server = await startServer({ cases: 40 });
		const phone = await openPage(server, { device: "phone", path: "/p/scratch/queue" });
		try {
			const { page } = phone;
			const writes: string[] = [];
			page.on("request", (request) => {
				const op = new URL(request.url()).pathname.split("/").pop() ?? "";
				if (["decide", "report", "propose", "plan"].includes(op)) writes.push(op);
			});
			const inert = () => page.locator("#app").evaluate((node) => node.hasAttribute("inert"));
			/** Tab, many times over: where the focus went that was inside the app. */
			const tabThrough = async (times: number) => {
				const reached = new Set<string>();
				for (let tabs = 0; tabs < times; tabs++) {
					await page.keyboard.press("Tab");
					const where = await page.evaluate(() => {
						const node = document.activeElement;
						return node?.closest("#app") ? `${node.tagName.toLowerCase()} ${node.textContent?.slice(0, 20)}` : null;
					});
					if (where) reached.add(where);
				}
				return [...reached];
			};
			await page.locator("#list [role=option]").first().waitFor();
			expect(await inert()).toBe(false);
			// The palette: the app under it is inert, the palette has the focus, and Tab stays out of the app.
			await actions(page).tap();
			expect(await inert()).toBe(true);
			expect(await page.evaluate(() => document.activeElement?.closest("[data-overlay=palette]") !== null)).toBe(true);
			expect(await tabThrough(45)).toEqual([]);
			await page.locator("[data-overlay=palette] .overlay-backdrop").tap({ position: { x: 4, y: 20 } });
			expect(await inert()).toBe(false);
			// The sheet of keys, the same.
			await page.keyboard.press("?");
			await page.getByRole("region", { name: "Keyboard shortcuts" }).waitFor();
			expect(await inert()).toBe(true);
			expect(await tabThrough(45)).toEqual([]);
			await page.locator(".help-close").tap();
			expect(await inert()).toBe(false);
			expect(writes).toEqual([]);
			// The palette opened by its key while the sidebar is open: the sidebar is not left open under it.
			await page.getByRole("button", { name: "Menu", exact: true }).tap();
			expect(await page.locator("#side").isVisible()).toBe(true);
			await page.keyboard.press("Control+k");
			await page.locator("[data-overlay=palette]").waitFor();
			await page.locator("[data-overlay=palette] .overlay-backdrop").tap({ position: { x: 4, y: 20 } });
			expect(await page.locator("#side").isVisible()).toBe(false);

			// Back leaves an editor as going elsewhere does: what was typed is recorded, and nothing is left
			// open under the list for a later action to record.
			await page.goto(`${server.url}/p/scratch/suite/c/3`);
			await page.locator("#detail .ctitle").waitFor();
			await actions(page).tap();
			await page
				.locator("[data-overlay=palette]")
				.getByRole("option", { name: /Edit case/ })
				.first()
				.tap();
			await eventually(
				() => page.evaluate(() => document.activeElement?.getAttribute("data-field")),
				(field) => field === "title",
			);
			await page.keyboard.press("End");
			await page.keyboard.type(" edited on a phone");
			await back(page).tap();
			expect(await inView(page)).toBe("list");
			await eventually(
				async () => (await server.api("find", { in: "cases", text: "edited on a phone" })).items.length,
				(found) => found === 1,
			);
			expect(writes).toEqual(["propose"]);
			// Back from a new case with a title and nothing else: it is recorded once, and the list stays. The
			// address the recorded case then gets is not somebody opening it.
			writes.length = 0;
			await actions(page).tap();
			await page
				.locator("[data-overlay=palette]")
				.getByRole("option", { name: /New case/ })
				.first()
				.tap();
			await eventually(
				() => page.evaluate(() => document.activeElement?.getAttribute("data-field")),
				(field) => field === "title",
			);
			await page.keyboard.type("A title and nothing else");
			// Pressed without moving the focus, as Safari on a phone presses it.
			await page.evaluate(() => document.querySelector<HTMLElement>(".top-back")?.click());
			await eventually(
				async () => (await server.api("find", { in: "cases", text: "A title and nothing else" })).items.length,
				(found) => found === 1,
			);
			await page.waitForURL(/\/suite\/c\/\d+/);
			await frames(page);
			expect(await inView(page)).toBe("list");
			expect(writes).toEqual(["propose"]);
			// Back from a new case with nothing typed records nothing.
			writes.length = 0;
			await actions(page).tap();
			await page
				.locator("[data-overlay=palette]")
				.getByRole("option", { name: /New case/ })
				.first()
				.tap();
			await eventually(
				() => inView(page),
				(pane) => pane === "detail",
			);
			await back(page).tap();
			await frames(page);
			expect([await inView(page), writes]).toEqual(["list", []]);
			expect(phone.errors).toEqual([]);
		} finally {
			await phone.close();
			await server.stop();
		}
	},
	60_000,
);

test.skipIf(!browserAvailable)(
	"a mouse keeps the desktop layout at a phone's width, and a wide touch screen is not a phone",
	async () => {
		const server = await startServer({ cases: 5 });
		const desktop = await openPage(server);
		const phone = await openPage(server, { device: "phone" });
		try {
			// A narrow desktop window: the sidebar, and both panes one over the other, as before.
			const { page } = desktop;
			await page.setViewportSize({ width: 390, height: 844 });
			// The page hears of a resize with the next frame. Two frames on, it has answered: what is found then is
			// what a narrow desktop window gets, not what it had a moment before.
			await frames(page);
			expect(await page.locator("html").getAttribute("data-layout")).toBeNull();
			expect(await page.locator("#top").count()).toBe(0);
			expect(await page.locator("#app").getAttribute("data-pane")).toBeNull();
			expect(await width(page, "#side")).toBe(120);
			const panes = await page.evaluate(() =>
				["#list", "#detail"].map((selector) => {
					const box = document.querySelector(selector)?.getBoundingClientRect();
					return box ? [box.x, box.width, box.y < 100] : null;
				}),
			);
			expect(panes).toEqual([
				[120, 270, true],
				[120, 270, false],
			]);
			await page.setViewportSize({ width: 1440, height: 900 });
			expect(await width(page, "#side")).toBe(236);
			await page.keyboard.press("[");
			expect(await width(page, "#side")).toBe(64);

			// A tablet on its side has room for the three columns. Turned upright it is a phone again.
			await phone.page.setViewportSize({ width: 1180, height: 820 });
			await eventually(
				() => phone.page.locator("html").getAttribute("data-layout"),
				(layout) => layout === null,
			);
			expect(await phone.page.locator("#top").count()).toBe(0);
			expect(await width(phone.page, "#side")).toBe(236);
			await phone.page.setViewportSize({ width: 820, height: 1180 });
			await eventually(
				() => phone.page.locator("html").getAttribute("data-layout"),
				(layout) => layout === "phone",
			);
			expect(await width(phone.page, "#list")).toBe(820);
			// A question opened while the tablet lay on its side is the one shown when it is turned upright.
			await phone.page.setViewportSize({ width: 1180, height: 820 });
			await phone.page.goto(`${server.url}/p/scratch/queue`);
			await phone.page.locator("#list [role=option]").nth(1).tap();
			await phone.page.waitForURL(/\/queue\/\d+/);
			await phone.page.setViewportSize({ width: 820, height: 1180 });
			await eventually(
				() => phone.page.locator("html").getAttribute("data-layout"),
				(layout) => layout === "phone",
			);
			await frames(phone.page);
			expect(await inView(phone.page)).toBe("detail");
			// A phone on its side is wide and low. It is still a phone.
			await phone.page.setViewportSize({ width: 932, height: 430 });
			expect(await phone.page.locator("html").getAttribute("data-layout")).toBe("phone");
			expect(await overflow(phone.page)).toBe(0);
			expect([...desktop.errors, ...phone.errors]).toEqual([]);
		} finally {
			await desktop.close();
			await phone.close();
			await server.stop();
		}
	},
	60_000,
);

test.skipIf(!browserAvailable)(
	"on a phone with a keyboard the palette takes the arrows and Enter without the field having the focus",
	async () => {
		const server = await startServer({ cases: 2 });
		await server.api("admin", { do: "project.create", key: "checkout", name: "Checkout", preset: "standard" });
		await server.api("admin", { do: "project.create", key: "payments", name: "Payments", preset: "loose" });
		const phone = await openPage(server, { device: "phone", path: "/p/checkout/suite" });
		try {
			const { page } = phone;
			const palette = page.locator("[data-overlay=palette]");
			const fieldHasFocus = () => page.evaluate(() => document.activeElement?.className === "palette-input");
			// g p lists the projects and starts on the first other one: scratch, from checkout.
			await page.keyboard.type("gp");
			await palette.waitFor();
			expect(await fieldHasFocus()).toBe(false);
			await page.keyboard.press("Enter");
			await page.waitForURL("**/p/scratch/suite");
			// From scratch the choice starts on checkout; one ArrowDown moves it to payments.
			await page.locator("#app").waitFor();
			await page.keyboard.type("gp");
			await palette.waitFor();
			await page.keyboard.press("ArrowDown");
			expect(await palette.getByRole("option", { selected: true }).innerText()).toContain("payments");
			expect(await fieldHasFocus()).toBe(false);
			await page.keyboard.press("Enter");
			await page.waitForURL("**/p/payments/suite");

			// The palette that the key and the Actions button open: the arrows move the choice, Enter runs it,
			// Escape closes it. A letter typed there changes nothing, and the field keeps the keyboard off.
			await page.locator("#app").waitFor();
			await page.keyboard.press("Control+k");
			await palette.waitFor();
			const names = await palette.getByRole("option").allInnerTexts();
			const queue = names.findIndex((name) => name.includes("Go to Queue"));
			expect(queue).toBeGreaterThan(0);
			await page.keyboard.type("zz");
			expect(await palette.locator(".palette-input").inputValue()).toBe("");
			for (let i = 0; i < queue; i++) await page.keyboard.press("ArrowDown");
			expect(await palette.getByRole("option", { selected: true }).innerText()).toContain("Go to Queue");
			expect(await fieldHasFocus()).toBe(false);
			await page.keyboard.press("Enter");
			await page.waitForURL("**/p/payments/queue");
			expect(await palette.count()).toBe(0);

			await actions(page).tap();
			await palette.waitFor();
			await page.keyboard.press("ArrowDown");
			expect(
				await palette.getByRole("option").evaluateAll((rows) => rows.findIndex((row) => row.ariaSelected === "true")),
			).toBe(1);
			await page.keyboard.press("Escape");
			expect(await palette.count()).toBe(0);
			expect(phone.errors).toEqual([]);
		} finally {
			await phone.close();
			await server.stop();
		}
	},
	60_000,
);

test.skipIf(!browserAvailable)(
	"the sign-in page fits a phone",
	async () => {
		const server = await startServer({ mode: "server" });
		const phone = await openPage(server, { device: "phone", signedIn: false, path: "/" });
		try {
			const { page } = phone;
			expect(await overflow(page)).toBe(0);
			const fields = await page
				.locator("input")
				.evaluateAll((nodes) =>
					nodes.map((node) => [getComputedStyle(node).fontSize, node.getBoundingClientRect().right <= innerWidth]),
				);
			expect(fields.length).toBeGreaterThan(1);
			expect(fields.filter(([size, inside]) => size !== "16px" || !inside)).toEqual([]);
			await page.locator("#token").fill(server.token);
			await page.getByRole("button", { name: "Sign in with the token" }).tap();
			await page.locator("#top").waitFor();
			expect(await inView(page)).toBe("list");
		} finally {
			await phone.close();
			await server.stop();
		}
	},
	60_000,
);

test.skipIf(!browserAvailable)(
	"on a phone the palette lists Cancel for a form that closes only with Escape",
	async () => {
		const server = await startServer({ cases: 3, preset: "standard" });
		// The page starts on another screen: a screen reached by navigation registers its keys after the shell's,
		// and its Escape must still not take the palette's (review of #218).
		const phone = await openPage(server, { device: "phone", path: "/p/scratch/runs" });
		try {
			const { page } = phone;
			await page.locator("#list").waitFor();
			await page.keyboard.type("gs");
			await page.waitForURL("**/p/scratch/suite");
			const palette = page.locator("[data-overlay=palette]");
			/** With a keyboard attached: ⌘K over the open form, then Escape closes the palette and keeps the form. */
			const escapeClosesPaletteOnly = async (field: ReturnType<typeof page.locator>) => {
				await page.keyboard.press("ControlOrMeta+k");
				await palette.waitFor();
				await page.keyboard.press("Escape");
				await palette.waitFor({ state: "detached" });
				expect(await field.count()).toBe(1);
			};
			const offered = async (name: RegExp) => {
				await actions(page).tap();
				const count = await palette.getByRole("option", { name }).count();
				return count;
			};
			const choose = (name: RegExp) => palette.getByRole("option", { name }).tap();
			const closePalette = () => palette.locator(".overlay-backdrop").tap({ position: { x: 4, y: 20 } });
			await page.locator("#list [role=option]").first().waitFor();

			// New folder. Closing the menu leaves the form open, and only Escape closed it: the palette has Cancel.
			expect(await offered(/Cancel new folder/)).toBe(0);
			await choose(/New folder/);
			const folderField = page.getByRole("textbox", { name: "New folder name", exact: true });
			await folderField.waitFor();
			await page.keyboard.type("Never made");
			await page.locator(".menu-backdrop").tap({ position: { x: 380, y: 400 } });
			expect(await offered(/Cancel new folder/)).toBe(1);
			await choose(/Cancel new folder/);
			expect(await folderField.count()).toBe(0);
			expect(await offered(/Cancel new folder/)).toBe(0);
			await closePalette();

			// Tag selected, from an open case.
			await page.locator("#list [role=option]").first().tap();
			await frames(page);
			expect(await offered(/Cancel tag/)).toBe(0);
			await choose(/Tag selected/);
			const tagField = page.getByRole("textbox", { name: "Tag selected cases", exact: true });
			await tagField.waitFor();
			await escapeClosesPaletteOnly(tagField);
			expect(await offered(/Cancel tag/)).toBe(1);
			await choose(/Cancel tag/);
			expect(await tagField.count()).toBe(0);

			// The Queue's reason, which the strict policy asks for before a failure is excused.
			const proposed = await server.api("propose", { edits: [{ op: "policy", preset: "strict" }] });
			const adopt = (await server.api("inbox", { kind: "adopt" })).items.find((q) => q.q === proposed.question);
			if (!adopt) throw new Error("No question to adopt the policy");
			await server.api("decide", { q: adopt.q, onEvidence: adopt.evidenceHash, answer: { is: "accept" } });
			const ci = z.object({ token: z.string() }).parse(
				await server.api("admin", {
					do: "token.create",
					actor: "pipeline",
					kind: "ci",
					can: ["read", "record"],
					project: "scratch",
				}),
			);
			await server.api(
				"report",
				{
					target: { session: "phone-cancel" },
					results: [{ test: { case: "C-1" }, outcome: "fail", failure: { message: "Coupon failure" } }],
				},
				{ token: ci.token },
			);
			const writes: string[] = [];
			page.on("request", (request) => {
				if (new URL(request.url()).pathname.endsWith("/decide")) writes.push("decide");
			});
			await page.goto(`${server.url}/p/scratch/runs`);
			await page.locator("#list").waitFor();
			await page.keyboard.type("gq");
			await page.waitForURL("**/p/scratch/queue**");
			await page.locator("#list [role=option]").first().tap();
			await frames(page);
			await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : null));
			await page.keyboard.press("f");
			const reason = page.locator("#answer-extra");
			await reason.waitFor();
			expect(await page.locator("label[for=answer-extra]").innerText()).toBe("Reason required by policy");
			await escapeClosesPaletteOnly(reason);
			expect(await offered(/Cancel\b/)).toBe(1);
			await choose(/Cancel\b/);
			expect(await reason.count()).toBe(0);
			expect(writes).toEqual([]);
			expect(phone.errors).toEqual([]);
		} finally {
			await phone.close();
			await server.stop();
		}
	},
	60_000,
);
