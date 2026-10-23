import { expect, test } from "bun:test";
import { answer, browserAvailable, eventually, fetched, openPage, startServer } from "./support.ts";

for (const outcome of ["adopted", "failed"] as const) {
	test.skipIf(!browserAvailable)(
		`a stream refresh keeps a pending tag until its ${outcome} reply`,
		async () => {
			const server = await startServer();
			await server.api("propose", { edits: [{ op: "create", body: { title: "Pending tag" } }] });
			const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
			let release = () => {};
			try {
				const { page } = h;
				await page.getByRole("button", { name: "Pending tag", exact: true }).waitFor();
				const held = new Promise<void>((resolve) => {
					release = resolve;
				});
				await page.context().route("**/api/p/scratch/propose", async (route) => {
					await held;
					if (outcome === "adopted") await route.continue();
					else
						await route.fulfill({
							status: 500,
							contentType: "application/json",
							body: JSON.stringify({ ok: false, error: { code: "internal", message: "Tag refused" } }),
						});
				});
				await page.keyboard.press("t");
				await page.getByRole("textbox", { name: "Tag selected cases" }).fill("alpha");
				await page.keyboard.press("Enter");
				await page.waitForFunction(() => document.querySelector(".ctags")?.textContent?.includes("#alpha"));
				await server.api("propose", { edits: [{ op: "place", cases: ["C-1"], tags: { add: ["gamma"] } }] });
				await page.waitForFunction(() => document.querySelector(".ctags")?.textContent?.includes("#gamma"));
				expect(await page.locator(".ctags").textContent()).toContain("#alpha");
				await page.getByRole("option").filter({ hasText: "C-1" }).filter({ hasText: "#gamma" }).waitFor();
				expect(await page.getByRole("option").filter({ hasText: "C-1" }).textContent()).toContain("#gamma");
				release();
				await page.waitForFunction(() =>
					/changed\.|Tag refused/.test(document.querySelector("#stat")?.textContent ?? ""),
				);
				await eventually(
					async () => (await page.locator(".ctags").textContent()) ?? "",
					(text) =>
						text.includes("#gamma") && (outcome === "adopted" ? text.includes("#alpha") : !text.includes("#alpha")),
				);
				expect((await server.api("get", { refs: ["C-1"] }))[0]?.tags).toEqual(
					outcome === "adopted" ? ["alpha", "gamma"] : ["gamma"],
				);
				expect(h.errors).toEqual(
					outcome === "failed"
						? ["Failed to load resource: the server responded with a status of 500 (Internal Server Error)"]
						: [],
				);
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
	"a stream refresh keeps a pending move and receives another client's tag",
	async () => {
		const server = await startServer();
		await server.api("propose", {
			edits: [
				{ op: "create", folder: "Original", body: { title: "Pending move" } },
				{ op: "folder", name: "Destination" },
			],
		});
		const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
		let release = () => {};
		try {
			const { page } = h;
			await page.getByRole("button", { name: "Pending move", exact: true }).waitFor();
			const held = new Promise<void>((resolve) => {
				release = resolve;
			});
			await page.context().route("**/api/p/scratch/propose", async (route) => {
				await held;
				await route.continue();
			});
			await page.keyboard.press("m");
			await page.getByRole("textbox", { name: "Move selected cases to a folder" }).fill("Destination");
			await page.keyboard.press("Enter");
			await page.waitForFunction(() => document.querySelector(".cmeta .path")?.textContent === "Destination");
			await server.api("propose", { edits: [{ op: "place", cases: ["C-1"], tags: { add: ["gamma"] } }] });
			await page.waitForFunction(() => document.querySelector(".ctags")?.textContent?.includes("#gamma"));
			expect(await page.locator(".cmeta .path").textContent()).toBe("Destination");
			release();
			await page.waitForFunction(() => document.querySelector("#stat")?.textContent?.includes("changed."));
			expect((await server.api("get", { refs: ["C-1"] }))[0]?.folder).toMatchObject({ path: "Destination" });
			expect(h.errors).toEqual([]);
		} finally {
			release();
			await h.close();
			await server.stop();
		}
	},
	30_000,
);

test.skipIf(!browserAvailable)(
	"an open draft receives live tags and folder without losing its title or proposing placement",
	async () => {
		const server = await startServer();
		await server.api("propose", {
			edits: [
				{ op: "create", folder: "Original", body: { title: "Live placement" } },
				{ op: "folder", name: "Destination" },
			],
		});
		const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
		try {
			const { page } = h;
			await page.getByRole("button", { name: "Live placement", exact: true }).waitFor();
			await page.keyboard.press("e");
			const title = page.getByRole("textbox", { name: "Case title", exact: true });
			await title.fill("My unfinished title");
			await server.api("propose", {
				edits: [{ op: "place", cases: ["C-1"], folder: "Destination", tags: { add: ["beta"] } }],
			});
			await page.getByRole("option").filter({ hasText: "C-1" }).filter({ hasText: "#beta" }).waitFor();
			await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
			expect(await page.locator(".ctags").textContent()).toContain("#beta");
			expect(await page.locator(".cmeta .path").textContent()).toBe("Destination");
			expect(await title.inputValue()).toBe("My unfinished title");
			const proposal = page.waitForRequest((request) => request.url().endsWith("/propose"));
			await title.press("Escape");
			const request = await proposal;
			expect(request.postDataJSON().edits).toEqual([
				{
					op: "edit",
					case: "C-1",
					base: 1,
					body: { title: "My unfinished title", pre: "", steps: [], methods: ["human"], automate: "none" },
				},
			]);
			await eventually(
				() => server.api("get", { refs: ["C-1"] }),
				(rows) => rows[0]?.title === "My unfinished title",
			);
			expect((await server.api("get", { refs: ["C-1"] }))[0]?.tags).toEqual(["beta"]);
			expect(h.errors).toEqual([]);
		} finally {
			await h.close();
			await server.stop();
		}
	},
	30_000,
);

test.skipIf(!browserAvailable)(
	"draft tag additions preserve remote additions and removals while its folder follows the case",
	async () => {
		const server = await startServer();
		await server.api("propose", {
			edits: [
				{ op: "create", folder: "Original", tags: ["gone"], body: { title: "Owned tags" } },
				{ op: "folder", name: "Destination" },
			],
		});
		const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
		try {
			const { page } = h;
			await page.getByRole("button", { name: "Owned tags", exact: true }).waitFor();
			await page.keyboard.press("e");
			const title = page.getByRole("textbox", { name: "Case title", exact: true });
			await title.fill("My title #alpha");
			await title.press("Enter");
			await page.waitForFunction(() => document.querySelector(".ctags")?.textContent?.includes("#alpha"));
			await server.api("propose", {
				edits: [{ op: "place", cases: ["C-1"], folder: "Destination", tags: { add: ["beta"], remove: ["gone"] } }],
			});
			await page.getByRole("option").filter({ hasText: "C-1" }).filter({ hasText: "#beta" }).waitFor();
			await page.waitForFunction(() => document.querySelector(".cmeta .path")?.textContent === "Destination");
			expect(await title.inputValue()).toBe("My title");
			const shownTags = await page.locator(".ctags").textContent();
			const proposal = page.waitForRequest(
				(request) =>
					request.url().endsWith("/propose") &&
					request.postDataJSON().edits.some((edit: { op: string }) => edit.op === "place"),
			);
			await title.press("Control+Enter");
			expect((await proposal).postDataJSON().edits.filter((edit: { op: string }) => edit.op === "place")).toEqual([
				{ op: "place", cases: ["C-1"], tags: { add: ["alpha"], remove: [] } },
			]);
			expect(shownTags).toBe("#beta#alpha");
			const saved = await eventually(
				() => server.api("get", { refs: ["C-1"] }),
				(rows) => rows[0]?.title === "My title" && Array.isArray(rows[0]?.tags) && rows[0]?.tags.length === 2,
			);
			expect(saved[0]?.tags).toEqual(["alpha", "beta"]);
			expect(saved[0]?.folder).toMatchObject({ path: "Destination" });
			await page.locator(".cstate .chip.ver").filter({ hasText: /^v2$/ }).waitFor();
			await server.api("propose", { edits: [{ op: "place", cases: ["C-1"], tags: { add: ["later"] } }] });
			await page.waitForFunction(() => document.querySelector(".ctags")?.textContent?.includes("#later"));
			expect(await page.locator(".ctags").textContent()).toContain("#alpha");
			expect(h.errors).toEqual([]);
		} finally {
			await h.close();
			await server.stop();
		}
	},
	30_000,
);

test.skipIf(!browserAvailable)(
	"draft tags do not absorb a pending tag when the person adds another tag",
	async () => {
		const server = await startServer();
		await server.api("propose", { edits: [{ op: "create", body: { title: "Independent tags" } }] });
		const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
		let release = () => {};
		try {
			const { page } = h;
			await page.getByRole("button", { name: "Independent tags", exact: true }).waitFor();
			const held = new Promise<void>((resolve) => {
				release = resolve;
			});
			await page.context().route("**/api/p/scratch/propose", async (route) => {
				await held;
				await route.fulfill({
					status: 500,
					contentType: "application/json",
					body: JSON.stringify({ ok: false, error: { code: "internal", message: "Tag refused" } }),
				});
			});
			await page.keyboard.press("t");
			await page.getByRole("textbox", { name: "Tag selected cases" }).fill("alpha");
			await page.keyboard.press("Enter");
			await page.waitForFunction(() => document.querySelector(".ctags")?.textContent?.includes("#alpha"));
			await page.keyboard.press("e");
			const title = page.getByRole("textbox", { name: "Case title", exact: true });
			await title.fill("My title #beta");
			await title.press("Enter");
			expect(await page.locator(".ctags").textContent()).toContain("#alpha");
			expect(await page.locator(".ctags").textContent()).toContain("#beta");
			release();
			await page.waitForFunction(() => document.querySelector("#stat")?.textContent?.includes("Tag refused"));
			await page.waitForFunction(() => document.querySelector(".ctags")?.textContent === "#beta");
			expect(await title.inputValue()).toBe("My title");
			expect((await server.api("get", { refs: ["C-1"] }))[0]?.tags).toEqual([]);
		} finally {
			release();
			await h.close();
			await server.stop();
		}
	},
	30_000,
);

test.skipIf(!browserAvailable)(
	"draft tag additions preserve an adopted pending tag in the next save",
	async () => {
		const server = await startServer();
		await server.api("propose", { edits: [{ op: "create", body: { title: "Independent tags" } }] });
		const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
		let release = () => {};
		try {
			const { page } = h;
			await page.getByRole("button", { name: "Independent tags", exact: true }).waitFor();
			const held = new Promise<void>((resolve) => {
				release = resolve;
			});
			await page.context().route("**/api/p/scratch/propose", async (route) => {
				await held;
				await route.continue();
			});
			await page.keyboard.press("t");
			await page.getByRole("textbox", { name: "Tag selected cases" }).fill("alpha");
			await page.keyboard.press("Enter");
			await page.waitForFunction(() => document.querySelector(".ctags")?.textContent?.includes("#alpha"));
			await page.keyboard.press("e");
			const title = page.getByRole("textbox", { name: "Case title", exact: true });
			await title.fill("My title #beta");
			await title.press("Enter");
			expect(await page.locator(".ctags").textContent()).toContain("#alpha");
			expect(await page.locator(".ctags").textContent()).toContain("#beta");
			release();
			await page.waitForFunction(() => document.querySelector("#stat")?.textContent?.includes("changed."));
			const proposal = page.waitForRequest(
				(request) =>
					request.url().endsWith("/propose") &&
					request.postDataJSON().edits.some((edit: { op: string }) => edit.op === "place"),
			);
			await title.press("Control+Enter");
			expect((await proposal).postDataJSON().edits.filter((edit: { op: string }) => edit.op === "place")).toEqual([
				{ op: "place", cases: ["C-1"], tags: { add: ["beta"], remove: [] } },
			]);
			const saved = await eventually(
				() => server.api("get", { refs: ["C-1"] }),
				(rows) => rows[0]?.title === "My title" && Array.isArray(rows[0]?.tags) && rows[0]?.tags.length === 2,
			);
			expect(saved[0]?.tags).toEqual(["alpha", "beta"]);
			expect(h.errors).toEqual([]);
		} finally {
			release();
			await h.close();
			await server.stop();
		}
	},
	30_000,
);

test.skipIf(!browserAvailable)(
	"an adopted placement remains visible if its refresh fails",
	async () => {
		const server = await startServer();
		await server.api("propose", { edits: [{ op: "create", body: { title: "Confirmed tag" } }] });
		const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
		try {
			const { page } = h;
			await page.addInitScript(() => {
				Reflect.set(
					window,
					"EventSource",
					class {
						close(): void {}
					},
				);
			});
			await page.reload();
			await page.getByRole("button", { name: "Confirmed tag", exact: true }).waitFor();
			await page.locator(".ctags").waitFor({ state: "attached" });
			let failedDetails = 0;
			const refuse = {
				status: 500,
				contentType: "application/json",
				body: JSON.stringify({ ok: false, error: { code: "internal", message: "Read unavailable" } }),
			};
			await page.context().route("**/api/p/scratch/find", (route) => route.fulfill(refuse));
			await page.context().route("**/api/p/scratch/get", async (route) => {
				await route.fulfill(refuse);
				failedDetails += 1;
			});
			await page.keyboard.press("t");
			await page.getByRole("textbox", { name: "Tag selected cases" }).fill("alpha");
			await page.keyboard.press("Enter");
			await page.waitForFunction(() => document.querySelector("#stat")?.textContent?.includes("changed."));
			await page.locator("#list [role=status]").waitFor();
			await eventually(
				async () => failedDetails,
				(count) => count === 2,
			);
			await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
			expect(await page.locator(".ctags").textContent()).toBe("#alpha");
			expect(await page.getByRole("option").filter({ hasText: "C-1" }).textContent()).toContain("#alpha");
			expect((await server.api("get", { refs: ["C-1"] }))[0]?.tags).toEqual(["alpha"]);
		} finally {
			await h.close();
			await server.stop();
		}
	},
	30_000,
);

test.skipIf(!browserAvailable)(
	"older stored draft tag additions preserve remote tags after reload and save",
	async () => {
		const server = await startServer();
		await server.api("propose", { edits: [{ op: "create", body: { title: "Older draft" } }] });
		const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
		try {
			const { page } = h;
			await page.getByRole("button", { name: "Older draft", exact: true }).waitFor();
			await page.keyboard.press("e");
			const title = page.getByRole("textbox", { name: "Case title", exact: true });
			await title.fill("My older title");
			await page.addInitScript(() => {
				const key = Object.keys(localStorage).find((key) => /:draft:scratch:C-1$/.test(key));
				if (!key) throw new Error("Missing stored draft");
				const saved = JSON.parse(localStorage.getItem(key) ?? "null");
				delete saved.placement;
				delete saved.tagChanges;
				saved.tags = ["alpha"];
				saved.originalTags = [];
				localStorage.setItem(key, JSON.stringify(saved));
			});
			await server.api("propose", { edits: [{ op: "place", cases: ["C-1"], tags: { add: ["gamma"] } }] });
			await page.reload();
			await title.waitFor();
			await title.focus();
			await page.getByRole("option").filter({ hasText: "C-1" }).filter({ hasText: "#gamma" }).waitFor();
			const proposal = page.waitForRequest(
				(request) =>
					request.url().endsWith("/propose") &&
					request.postDataJSON().edits.some((edit: { op: string }) => edit.op === "place"),
			);
			const shownTags = await page.locator(".ctags").textContent();
			await title.press("Control+Enter");
			expect((await proposal).postDataJSON().edits.filter((edit: { op: string }) => edit.op === "place")).toEqual([
				{ op: "place", cases: ["C-1"], tags: { add: ["alpha"], remove: [] } },
			]);
			expect(shownTags).toBe("#gamma#alpha");
			const saved = await eventually(
				() => server.api("get", { refs: ["C-1"] }),
				(rows) => rows[0]?.title === "My older title",
			);
			expect(saved[0]?.tags).toEqual(["alpha", "gamma"]);
			expect(h.errors).toEqual([]);
		} finally {
			await h.close();
			await server.stop();
		}
	},
	30_000,
);

test.skipIf(!browserAvailable)(
	"an inline tag saved directly retires only its delta and keeps tags typed during the save",
	async () => {
		const server = await startServer();
		await server.api("propose", { edits: [{ op: "create", body: { title: "Later draft tags" } }] });
		const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
		let release = () => {};
		try {
			const { page } = h;
			await page.getByRole("button", { name: "Later draft tags", exact: true }).waitFor();
			const held = new Promise<void>((resolve) => {
				release = resolve;
			});
			const proposals: unknown[] = [];
			await page.context().route("**/api/p/scratch/propose", async (route) => {
				proposals.push(
					route
						.request()
						.postDataJSON()
						.edits.filter((edit: { op: string }) => edit.op === "place"),
				);
				if (proposals.length === 1) await held;
				await route.continue();
			});
			await page.keyboard.press("e");
			const title = page.getByRole("textbox", { name: "Case title", exact: true });
			await title.fill("My title #alpha");
			const first = page.waitForRequest((request) => request.url().endsWith("/propose"));
			await title.press("Control+Enter");
			await first;
			await title.fill("Later title #beta");
			await title.press("Enter");
			await server.api("propose", { edits: [{ op: "place", cases: ["C-1"], tags: { add: ["gamma"] } }] });
			await page.getByRole("option").filter({ hasText: "C-1" }).filter({ hasText: "#gamma" }).waitFor();
			release();
			const saved = await eventually(
				() => server.api("get", { refs: ["C-1"] }),
				(rows) => rows[0]?.title === "Later title" && Array.isArray(rows[0]?.tags) && rows[0]?.tags.includes("beta"),
			);
			expect(proposals).toEqual([
				[{ op: "place", cases: ["C-1"], tags: { add: ["alpha"], remove: [] } }],
				[{ op: "place", cases: ["C-1"], tags: { add: ["beta"], remove: [] } }],
			]);
			expect(saved[0]?.tags).toEqual(["alpha", "beta", "gamma"]);
			expect(h.errors).toEqual([]);
		} finally {
			release();
			await h.close();
			await server.stop();
		}
	},
	30_000,
);

test.skipIf(!browserAvailable)(
	"a late saved-version read keeps the newer case already shown",
	async () => {
		const server = await startServer();
		await server.api("propose", {
			edits: [{ op: "create", body: { title: "Original title", pre: "Original precondition" } }],
		});
		const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
		const held = Promise.withResolvers<void>();
		const arrived = Promise.withResolvers<void>();
		try {
			const { page } = h;
			await page.setViewportSize({ width: 1280, height: 800 });
			await page.getByRole("button", { name: "Original title", exact: true }).waitFor();
			let refuseReads = false;
			await page.route(/\/api\/p\/scratch\/(get|find)$/, async (route) => {
				const input = route.request().postDataJSON();
				if (!input.refs?.includes("C-1") && input.in !== "cases") return route.continue();
				if (refuseReads)
					return answer(route, {
						status: 500,
						contentType: "application/json",
						body: JSON.stringify({ ok: false, error: { code: "internal", message: "Read unavailable" } }),
					});
				if (input.version !== 2) return route.continue();
				const reply = await fetched(route);
				if (!reply) return;
				arrived.resolve();
				await held.promise;
				await answer(route, { response: reply.response });
			});
			await page.keyboard.press("e");
			const title = page.getByRole("textbox", { name: "Case title", exact: true });
			await title.fill("My saved title");
			await title.press("Control+Enter");
			await arrived.promise;
			const listed = page.waitForResponse(
				async (response) =>
					response.url().endsWith("/find") &&
					response.request().postDataJSON().in === "cases" &&
					(await response.text()).includes('"New remote title"'),
			);
			await server.api("propose", {
				edits: [
					{ op: "edit", case: "C-1", base: 2, body: { title: "New remote title", pre: "New remote precondition" } },
				],
			});
			await (await listed).finished();
			await page.getByText("Others see version 3", { exact: true }).waitFor();
			refuseReads = true;
			held.resolve();
			await page.locator("#stat").filter({ hasText: "Version 2, by you, just now" }).waitFor();
			await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
			if (process.env.MAINWORTHY_LATE_SAVE_SCREENSHOT)
				await page.screenshot({ path: process.env.MAINWORTHY_LATE_SAVE_SCREENSHOT });
			expect(await page.getByLabel("Preconditions", { exact: true }).inputValue()).toBe("New remote precondition");
			expect(await page.locator(".cstate .chip.ver").textContent()).toBe("v3");
			expect(await page.getByRole("option").filter({ hasText: "C-1" }).locator(".ti").textContent()).toBe(
				"New remote title",
			);
			expect((await server.api("get", { refs: ["C-1"] }))[0]).toMatchObject({
				version: 3,
				pre: "New remote precondition",
			});
			await page.keyboard.type("gs");
			await page.getByRole("button", { name: "New remote title", exact: true }).waitFor();
			expect(await page.getByRole("option").filter({ hasText: "C-1" }).locator(".ti").textContent()).toBe(
				"New remote title",
			);
			expect(
				h.errors.filter(
					(error) => !error.startsWith("Failed to load resource: the server responded with a status of 500"),
				),
			).toEqual([]);
		} finally {
			held.resolve();
			await h.close();
			await server.stop();
		}
	},
	30_000,
);

test.skipIf(!browserAvailable)(
	"a confirmed second move supersedes an earlier pending move",
	async () => {
		const server = await startServer();
		await server.api("propose", {
			edits: [
				{ op: "create", folder: "Original", body: { title: "Two moves" } },
				{ op: "folder", name: "First" },
				{ op: "folder", name: "Second" },
			],
		});
		const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
		const held = Promise.withResolvers<void>();
		const arrived = Promise.withResolvers<void>();
		const answered = Promise.withResolvers<void>();
		try {
			const { page } = h;
			await page.getByRole("button", { name: "Two moves", exact: true }).waitFor();
			let first = true;
			await page.route("**/api/p/scratch/propose", async (route) => {
				if (!first) return route.continue();
				first = false;
				const reply = await fetched(route);
				if (!reply) return;
				arrived.resolve();
				await held.promise;
				await answer(route, { response: reply.response });
				answered.resolve();
			});
			await page.keyboard.press("m");
			await page.getByRole("textbox", { name: "Move selected cases to a folder" }).fill("First");
			await page.keyboard.press("Enter");
			await arrived.promise;
			await page.keyboard.press("m");
			await page.getByRole("textbox", { name: "Move selected cases to a folder" }).fill("Second");
			await page.keyboard.press("Enter");
			await page.locator("#stat").filter({ hasText: "1 case changed." }).waitFor();
			expect(await page.locator(".cmeta .path").textContent()).toBe("Second");
			expect((await server.api("get", { refs: ["C-1"] }))[0]?.folder).toMatchObject({ path: "Second" });
			held.resolve();
			await answered.promise;
			await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
			expect(await page.locator(".cmeta .path").textContent()).toBe("Second");
			expect(h.errors).toEqual([]);
		} finally {
			held.resolve();
			await h.close();
			await server.stop();
		}
	},
	30_000,
);

test.skipIf(!browserAvailable)(
	"a tag typed in the editor survives refusal of the same pending tag",
	async () => {
		const server = await startServer();
		await server.api("propose", { edits: [{ op: "create", body: { title: "Independent tag intent" } }] });
		const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
		let release = () => {};
		try {
			const { page } = h;
			await page.getByRole("button", { name: "Independent tag intent", exact: true }).waitFor();
			const held = new Promise<void>((resolve) => {
				release = resolve;
			});
			let first = true;
			await page.context().route("**/api/p/scratch/propose", async (route) => {
				if (!first) return route.continue();
				first = false;
				await held;
				await route.fulfill({
					status: 403,
					contentType: "application/json",
					body: JSON.stringify({ ok: false, error: { code: "forbidden", message: "Tag refused" } }),
				});
			});
			await page.keyboard.press("t");
			await page.getByRole("textbox", { name: "Tag selected cases" }).fill("alpha");
			await page.keyboard.press("Enter");
			await page.waitForFunction(() => document.querySelector(".ctags")?.textContent?.includes("#alpha"));
			await page.keyboard.press("e");
			const title = page.getByRole("textbox", { name: "Case title", exact: true });
			await title.fill("My title #alpha");
			await title.press("Enter");
			release();
			await page.waitForFunction(() => document.querySelector("#stat")?.textContent?.includes("Tag refused"));
			await title.press("Control+Enter");
			await eventually(
				() => server.api("get", { refs: ["C-1"] }),
				(rows) => rows[0]?.title === "My title",
			);
			await page.waitForFunction(() => document.querySelector("#stat")?.textContent?.startsWith("Version 2,"));
			if (process.env.MAINWORTHY_TAG_SCREENSHOT) await page.screenshot({ path: process.env.MAINWORTHY_TAG_SCREENSHOT });
			const saved = (await server.api("get", { refs: ["C-1"] }))[0];
			expect(saved?.title).toBe("My title");
			expect(saved?.tags).toEqual(["alpha"]);
		} finally {
			release();
			await h.close();
			await server.stop();
		}
	},
	30_000,
);

for (const outcome of ["adopted", "refused"] as const) {
	test.skipIf(!browserAvailable)(
		`a typed tag stays visible and saves after its pending removal is ${outcome}`,
		async () => {
			const server = await startServer();
			await server.api("propose", { edits: [{ op: "create", body: { title: "Independent removal intent" } }] });
			const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
			let release = () => {};
			try {
				const { page } = h;
				await page.getByRole("button", { name: "Independent removal intent", exact: true }).waitFor();
				await page.keyboard.press("t");
				await page.getByRole("textbox", { name: "Tag selected cases" }).fill("alpha");
				await page.keyboard.press("Enter");
				await eventually(
					() => server.api("get", { refs: ["C-1"] }),
					(rows) => {
						const tags = rows[0]?.tags;
						return Array.isArray(tags) && tags.includes("alpha");
					},
				);
				await page.waitForFunction(() => document.querySelector("#stat")?.textContent?.includes("changed."));
				const held = new Promise<void>((resolve) => {
					release = resolve;
				});
				let first = true;
				await page.context().route("**/api/p/scratch/propose", async (route) => {
					if (!first) return route.continue();
					first = false;
					await held;
					if (outcome === "adopted") await route.continue();
					else
						await route.fulfill({
							status: 403,
							contentType: "application/json",
							body: JSON.stringify({ ok: false, error: { code: "forbidden", message: "Tag refused" } }),
						});
				});
				await page.keyboard.press("u");
				await page.waitForFunction(() => !document.querySelector(".ctags")?.textContent?.includes("#alpha"));
				await page.keyboard.press("e");
				const title = page.getByRole("textbox", { name: "Case title", exact: true });
				await title.fill("My title #alpha");
				await title.press("Enter");
				const shownWhileHeld = await page.locator(".ctags").textContent();
				if (outcome === "adopted" && process.env.MAINWORTHY_TAG_REMOVAL_SCREENSHOT)
					await page.screenshot({ path: process.env.MAINWORTHY_TAG_REMOVAL_SCREENSHOT });
				const reply = page.waitForResponse((response) => response.url().endsWith("/api/p/scratch/propose"));
				release();
				await reply;
				if (outcome === "adopted") {
					await page.waitForFunction(() => document.querySelector("#stat")?.textContent?.startsWith("Undone."));
					await eventually(
						() => server.api("get", { refs: ["C-1"] }),
						(rows) => {
							const tags = rows[0]?.tags;
							return Array.isArray(tags) && tags.length === 0;
						},
					);
				} else await page.waitForFunction(() => document.querySelector("#stat")?.textContent?.includes("Tag refused"));
				const shownAfter = await page.locator(".ctags").textContent();
				await title.press("Control+Enter");
				await eventually(
					() => server.api("get", { refs: ["C-1"] }),
					(rows) => rows[0]?.title === "My title",
				);
				await page.waitForFunction(() => document.querySelector("#stat")?.textContent?.startsWith("Version 2,"));
				const saved = (await server.api("get", { refs: ["C-1"] }))[0];
				expect(saved?.tags).toEqual(["alpha"]);
				expect(shownWhileHeld).toContain("#alpha");
				expect(shownAfter).toContain("#alpha");
				expect(await page.locator(".ctags").textContent()).toContain("#alpha");
			} finally {
				release();
				await h.close();
				await server.stop();
			}
		},
		30_000,
	);
}
