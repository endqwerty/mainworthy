import { expect, test } from "bun:test";
import { z } from "zod";
import { API_VERSION, API_VERSION_HEADER } from "../../src/core/version.ts";
import { browserAvailable, eventually, openPage, startServer } from "./support.ts";

const legacyBundle = process.env.MAINWORTHY_LEGACY_BUNDLE;
for (const contract of ["missing", "mismatch", ...(legacyBundle ? ["historical"] : [])]) {
	test.skipIf(!browserAvailable)(
		`an open ${contract} browser cannot archive after an API upgrade and asks for a reload`,
		async () => {
			const server = await startServer();
			await server.api("propose", { edits: [{ op: "create", body: { title: "Old tab" } }] });
			let upgraded = false;
			let servedLegacy = false;
			const refused: number[] = [];
			const h = await openPage(server, {
				path: "/p/scratch/suite/c/1",
				setup: async (page, context) => {
					if (contract === "historical" && legacyBundle) {
						const body = await Bun.file(legacyBundle).text();
						await context.route(/\/(?:chunk-[^/]+|main)\.js(?:\?.*)?$/, (route) => {
							servedLegacy = true;
							return route.fulfill({ contentType: "application/javascript", body });
						});
					}
					await context.route("**/api/**", async (route) => {
						const request = route.request();
						const headers = { ...request.headers() };
						if (!upgraded) {
							// Load the old page as before the upgrade; its real requests run unchanged afterwards.
							headers[API_VERSION_HEADER] = String(API_VERSION);
						} else if (contract === "missing") delete headers[API_VERSION_HEADER];
						else if (contract === "mismatch") headers[API_VERSION_HEADER] = String(API_VERSION - 1);
						await route.continue({ headers });
					});
					page.on("response", (response) => {
						if (response.url().endsWith("/propose")) refused.push(response.status());
					});
				},
			});
			try {
				await h.page.getByRole("button", { name: "Old tab", exact: true }).waitFor();
				if (contract === "historical") expect(servedLegacy).toBe(true);
				await server.api("propose", { edits: [{ op: "state", cases: ["C-1"], to: "archived" }] });
				const before = await server.api("get", { refs: ["C-1"] });
				const timeline = await server.api("timeline", { ref: "C-1" });
				upgraded = true;
				await h.page.keyboard.press("#");
				await h.page.locator("#stat").filter({ hasText: "Reload before trying again." }).waitFor();
				expect(refused).toContain(409);
				expect(await server.api("get", { refs: ["C-1"] })).toEqual(before);
				expect(await server.api("timeline", { ref: "C-1" })).toEqual(timeline);
				if (process.env.MAINWORTHY_VERSION_SCREENSHOT)
					await h.page.screenshot({ path: `${process.env.MAINWORTHY_VERSION_SCREENSHOT}-${contract}.png` });
				expect(h.errors.filter((error) => !error.includes("409 (Conflict)"))).toEqual([]);
			} finally {
				await h.close();
				await server.stop();
			}
		},
		30_000,
	);
}

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

for (const folders of ["failed", "slow"] as const) {
	test.skipIf(!browserAvailable)(
		`server-filtered cases stay visible when the folders read is ${folders}`,
		async () => {
			const server = await startServer();
			await server.api("propose", {
				edits: [{ op: "create", folder: "Original", body: { title: "Waiting for folders" } }],
			});
			let release = () => {};
			const held = new Promise<void>((resolve) => {
				release = resolve;
			});
			let requested = false;
			const h = await openPage(server, {
				path: "/p/scratch/suite?folder=Original",
				setup: async (_page, context) => {
					await context.route("**/api/p/scratch/find", async (route) => {
						if (!z.object({ in: z.literal("folders") }).safeParse(route.request().postDataJSON()).success)
							return route.continue();
						requested = true;
						if (folders === "slow") {
							await held;
							await route.continue();
						} else
							await route.fulfill({
								status: 500,
								contentType: "application/json",
								body: JSON.stringify({ ok: false, error: { code: "internal", message: "Folders unavailable" } }),
							});
					});
				},
			});
			try {
				const { page } = h;
				await eventually(async () => requested, Boolean);
				await page.locator("#lcount").filter({ hasText: "1 cases" }).waitFor();
				await page.getByRole("button", { name: "Waiting for folders", exact: true }).waitFor();
				if (folders === "slow" && process.env.MAINWORTHY_FOLDER_READ_SCREENSHOT)
					await page.screenshot({ path: process.env.MAINWORTHY_FOLDER_READ_SCREENSHOT });
				expect(await page.getByRole("option").filter({ hasText: "C-1" }).count()).toBe(1);
				if (folders === "slow") {
					release();
					await page.locator("button.fo").filter({ hasText: "Original" }).waitFor();
					expect(await page.getByRole("option").filter({ hasText: "C-1" }).count()).toBe(1);
					expect(h.errors).toEqual([]);
				}
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

async function twoVersions(server: Awaited<ReturnType<typeof startServer>>) {
	await server.api("propose", { edits: [{ op: "create", body: { title: "First title" } }] });
	await server.api("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Second title" } }] });
}

test.skipIf(!browserAvailable)(
	"u restores the version before as a new version when the policy adopts it",
	async () => {
		const server = await startServer();
		await twoVersions(server);
		const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
		try {
			const { page } = h;
			await page.getByRole("button", { name: "Second title", exact: true }).waitFor();
			await page.keyboard.press("u");
			await page.waitForFunction(() =>
				document.querySelector("#stat")?.textContent?.includes("Previous version restored as a new version."),
			);
			const row = (await server.api("get", { refs: ["C-1"] }))[0];
			expect(row?.version).toBe(3);
			expect(row?.title).toBe("First title");
			expect(h.errors).toEqual([]);
		} finally {
			await h.close();
			await server.stop();
		}
	},
	30_000,
);

test.skipIf(!browserAvailable)(
	"u says nothing changed when the version it restores is already the case's content",
	async () => {
		const server = await startServer();
		await twoVersions(server);
		await server.api("propose", { edits: [{ op: "restore", case: "C-1", to: 1 }] });
		const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
		try {
			const { page } = h;
			await page.getByRole("button", { name: "First title", exact: true }).waitFor();
			// Focused on version 2, u restores its predecessor, version 1, whose content version 3 already has.
			await page.locator(".timeline-group summary").click();
			await page.locator('[data-version="2"]').focus();
			await page.keyboard.press("u");
			await page.waitForFunction(() => document.querySelector("#stat")?.textContent?.includes("Nothing changed."));
			expect(await page.locator("#stat").textContent()).toBe(
				"The case already has that version's content. Nothing changed.",
			);
			expect((await server.api("get", { refs: ["C-1"] }))[0]?.version).toBe(3);
			expect(h.errors).toEqual([]);
		} finally {
			await h.close();
			await server.stop();
		}
	},
	30_000,
);

test.skipIf(!browserAvailable)(
	"u under strict says the restore is proposed, names its question and leaves the case at its version",
	async () => {
		const server = await startServer();
		await twoVersions(server);
		const policy = await server.api("propose", { edits: [{ op: "policy", preset: "strict" }] });
		const asked = (await server.api("inbox", { kind: "adopt" })).items.find((item) => item.q === policy.question);
		if (!asked) throw new Error("No policy question");
		await server.api("decide", { q: asked.q, onEvidence: asked.evidenceHash, answer: { is: "accept" } });
		const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
		try {
			const { page } = h;
			await page.getByRole("button", { name: "Second title", exact: true }).waitFor();
			await page.keyboard.press("u");
			await page.waitForFunction(() => document.querySelector("#stat")?.textContent?.includes("waiting for a person"));
			const status = (await page.locator("#stat").textContent()) ?? "";
			const open = (await server.api("inbox", { kind: "adopt" })).items.filter((item) => status.includes(item.q));
			expect(status).toMatch(/^Restore proposed, waiting for a person · Q-\d+$/);
			expect(open).toHaveLength(1);
			expect(status).not.toContain("restored as a new version");
			const row = (await server.api("get", { refs: ["C-1"] }))[0];
			expect(row?.version).toBe(2);
			expect(row?.title).toBe("Second title");
			expect(await page.getByRole("button", { name: "Second title", exact: true }).count()).toBeGreaterThan(0);
			expect(h.errors).toEqual([]);
		} finally {
			await h.close();
			await server.stop();
		}
	},
	30_000,
);

function pending() {
	let settle = () => {};
	const promise = new Promise<void>((resolve) => {
		settle = resolve;
	});
	return { promise, settle };
}
const failedReply = (message: string) => ({
	status: 500,
	contentType: "application/json",
	body: JSON.stringify({ ok: false, error: { code: "internal", message } }),
});
async function tagSelected(page: Awaited<ReturnType<typeof openPage>>["page"], text: string): Promise<void> {
	await page.keyboard.press("t");
	await page.getByRole("textbox", { name: "Tag selected cases" }).fill(text);
	await page.keyboard.press("Enter");
}
const ctags = async (page: Awaited<ReturnType<typeof openPage>>["page"]): Promise<string> =>
	(await page.locator(".ctags").textContent()) ?? "";

test.skipIf(!browserAvailable)(
	"a failed tag leaves a second tag still on its way on the page",
	async () => {
		const server = await startServer();
		await server.api("propose", { edits: [{ op: "create", body: { title: "Two tags" } }] });
		const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
		const first = pending();
		const second = pending();
		try {
			const { page } = h;
			await page.getByRole("button", { name: "Two tags", exact: true }).waitFor();
			let seen = 0;
			await page.context().route("**/api/p/scratch/propose", async (route) => {
				seen += 1;
				if (seen === 1) {
					await first.promise;
					await route.fulfill(failedReply("The first write failed"));
				} else {
					await second.promise;
					await route.continue();
				}
			});
			await tagSelected(page, "alpha");
			await eventually(
				async () => seen,
				(count) => count === 1,
			);
			await tagSelected(page, "beta");
			await eventually(
				async () => seen,
				(count) => count === 2,
			);
			await eventually(
				() => ctags(page),
				(text) => text.includes("#beta"),
			);
			first.settle();
			await page.waitForFunction(() =>
				document.querySelector("#stat")?.textContent?.includes("The first write failed"),
			);
			await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
			expect(await ctags(page)).toContain("#beta");
			expect(await ctags(page)).not.toContain("#alpha");
			expect((await server.api("get", { refs: ["C-1"] }))[0]?.tags).toEqual([]);
			second.settle();
			await eventually(
				async () => (await server.api("get", { refs: ["C-1"] }))[0]?.tags,
				(tags) => Array.isArray(tags) && tags.join() === "beta",
			);
			await eventually(
				() => ctags(page),
				(text) => text.includes("#beta") && !text.includes("#alpha"),
			);
		} finally {
			first.settle();
			second.settle();
			await h.close();
			await server.stop();
		}
	},
	30_000,
);

test.skipIf(!browserAvailable)(
	"a failed tag leaves the editor opened while it was on its way showing the server's tags",
	async () => {
		const server = await startServer();
		await server.api("propose", { edits: [{ op: "create", body: { title: "Edit while tagging" } }] });
		const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
		const fail = pending();
		try {
			const { page } = h;
			await page.getByRole("button", { name: "Edit while tagging", exact: true }).waitFor();
			let started = false;
			await page.context().route("**/api/p/scratch/propose", async (route) => {
				started = true;
				await fail.promise;
				await route.fulfill(failedReply("The tag failed"));
			});
			await tagSelected(page, "alpha");
			await eventually(async () => started, Boolean);
			await page.keyboard.press("e");
			await page.getByRole("textbox", { name: "Case title", exact: true }).waitFor();
			expect(await ctags(page)).toContain("#alpha");
			let reread = false;
			page.on("response", (response) => {
				if (response.url().endsWith("/get")) reread = true;
			});
			fail.settle();
			await eventually(async () => reread, Boolean);
			await page.waitForFunction(() => document.querySelector("#stat")?.textContent?.includes("The tag failed"));
			await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
			expect(await ctags(page)).not.toContain("#alpha");
			expect((await server.api("get", { refs: ["C-1"] }))[0]?.tags).toEqual([]);
		} finally {
			fail.settle();
			await h.close();
			await server.stop();
		}
	},
	30_000,
);

test.skipIf(!browserAvailable)(
	"an undo queued behind a tag is not erased by a read an earlier failure owes",
	async () => {
		const server = await startServer();
		await server.api("propose", { edits: [{ op: "create", body: { title: "Undo behind a tag" } }] });
		const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
		const first = pending();
		const second = pending();
		const inverse = pending();
		try {
			const { page } = h;
			// The change stream reads the project too; without it, every read here is the placements' own.
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
			await page.getByRole("button", { name: "Undo behind a tag", exact: true }).waitFor();
			let seen = 0;
			await page.context().route("**/api/p/scratch/propose", async (route) => {
				seen += 1;
				const turn = seen;
				await (turn === 1 ? first : turn === 2 ? second : inverse).promise;
				if (turn === 1) await route.fulfill(failedReply("The first write failed"));
				else await route.continue();
			});
			await tagSelected(page, "alpha");
			await eventually(
				async () => seen,
				(count) => count === 1,
			);
			await tagSelected(page, "beta");
			await eventually(
				async () => seen,
				(count) => count === 2,
			);
			first.settle();
			await page.waitForFunction(() =>
				document.querySelector("#stat")?.textContent?.includes("The first write failed"),
			);
			// Undo beta while it is on its way: the inverse participates in refreshed rows before it can be sent.
			await page.keyboard.press("u");
			await page.waitForFunction(() => document.querySelector("#stat")?.textContent?.includes("Undo queued"));
			second.settle();
			await eventually(
				async () => seen,
				(count) => count === 3,
			);
			await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
			expect(await ctags(page)).not.toContain("#beta");
			inverse.settle();
			await page.waitForFunction(() => document.querySelector("#stat")?.textContent?.includes("Undone."));
			await eventually(
				() => ctags(page),
				(text) => !text.includes("#alpha") && !text.includes("#beta"),
			);
			expect((await server.api("get", { refs: ["C-1"] }))[0]?.tags).toEqual([]);
		} finally {
			first.settle();
			second.settle();
			inverse.settle();
			await h.close();
			await server.stop();
		}
	},
	30_000,
);

for (const queryFolder of ["Original", "original"]) {
	test.skipIf(!browserAvailable)(
		`a moved case appears when its destination folder is opened without reloading from ${queryFolder}`,
		async () => {
			const server = await startServer();
			await server.api("propose", {
				edits: [
					{ op: "create", folder: "Original", body: { title: "Moved case" } },
					{ op: "folder", name: "Destination" },
				],
			});
			const h = await openPage(server, { path: `/p/scratch/suite/c/1?folder=${queryFolder}` });
			try {
				const { page } = h;
				await page.getByRole("button", { name: "Moved case", exact: true }).waitFor();
				expect(await page.getByRole("option").filter({ hasText: "C-1" }).count()).toBe(1);
				await page.keyboard.press("m");
				await page.getByRole("textbox", { name: "Move selected cases to a folder" }).fill("Destination");
				await page.keyboard.press("Enter");
				await page.waitForFunction(() => document.querySelector("#stat")?.textContent?.includes("changed."));
				await page.locator("button.fo").filter({ hasText: "Destination" }).click();
				await page.waitForFunction(
					() =>
						document.querySelector("#ltitle")?.textContent === "Destination" &&
						document.querySelector("#lcount")?.textContent?.trim() === "1 cases",
				);
				if (queryFolder === "Original" && process.env.MAINWORTHY_PLACEMENT_SCREENSHOT)
					await page.screenshot({ path: process.env.MAINWORTHY_PLACEMENT_SCREENSHOT });
				expect(await page.getByRole("option").filter({ hasText: "C-1" }).count()).toBe(1);
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
	"an archived case can be found and restored after reloading",
	async () => {
		const server = await startServer();
		await server.api("propose", {
			edits: [{ op: "create", folder: "Original", tags: ["recover"], body: { title: "Recover this case" } }],
		});
		const h = await openPage(server, { path: "/p/scratch/suite/c/1?folder=Original" });
		try {
			const { page } = h;
			await page.locator(".ctitle").waitFor();
			await page.keyboard.press("#");
			await eventually(
				() => server.api("get", { refs: ["C-1"] }),
				(rows) => rows[0]?.state === "archived",
			);
			await page.reload();
			await page.locator("#lcount").filter({ hasText: "0 cases" }).waitFor();
			expect(await page.locator("#list").getByRole("option").count()).toBe(0);
			await page.locator("#detail .chip").filter({ hasText: "Archived" }).waitFor();
			if (process.env.MAINWORTHY_ARCHIVE_SCREENSHOT)
				await page.screenshot({ path: process.env.MAINWORTHY_ARCHIVE_SCREENSHOT });
			await page.getByRole("button", { name: "Archived", exact: true }).click();
			await page.getByRole("textbox", { name: "Filter cases", exact: true }).fill("Recover");
			await page.waitForURL("**state=archived*text=Recover");
			await page.getByRole("option").filter({ hasText: "C-1" }).click();
			await page.locator("#detail .chip").filter({ hasText: "Archived" }).waitFor();
			await page.reload();
			await page.locator("#detail .chip").filter({ hasText: "Archived" }).waitFor();
			await page.keyboard.press("ControlOrMeta+k");
			await page.getByRole("option", { name: /Restore selected/ }).click();
			await eventually(
				() => server.api("get", { refs: ["C-1"] }),
				(rows) => rows[0]?.state === "active",
			);
			await page.reload();
			await page.getByRole("button", { name: /All cases/ }).click();
			await page.locator("button.fo").filter({ hasText: "Original" }).click();
			await page.getByRole("option").filter({ hasText: "C-1" }).waitFor();
			expect(await page.locator("#detail .chip").filter({ hasText: "Archived" }).count()).toBe(0);
			const [restored] = await server.api("get", { refs: ["C-1"] });
			expect(restored?.version).toBe(1);
			expect(restored?.folder).toMatchObject({ path: "Original" });
			expect(restored?.tags).toEqual(["recover"]);
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

test.skipIf(!browserAvailable)(
	"a phone restores an archived case from its old URL through Actions",
	async () => {
		const server = await startServer();
		await server.api("propose", { edits: [{ op: "create", body: { title: "Phone recovery" } }] });
		await server.api("propose", { edits: [{ op: "state", cases: ["C-1"], to: "archived" }] });
		const h = await openPage(server, { device: "phone", path: "/p/scratch/suite/c/1" });
		try {
			const { page } = h;
			await page.locator("#detail .chip").filter({ hasText: "Archived" }).waitFor();
			if (process.env.MAINWORTHY_ARCHIVE_PHONE_SCREENSHOT)
				await page.screenshot({ path: process.env.MAINWORTHY_ARCHIVE_PHONE_SCREENSHOT });
			await page.getByRole("button", { name: "Actions", exact: true }).tap();
			expect(await page.getByRole("option", { name: /Archive selected/ }).count()).toBe(0);
			await page.getByRole("option", { name: /Restore selected/ }).tap();
			await eventually(
				() => server.api("get", { refs: ["C-1"] }),
				(rows) => rows[0]?.state === "active",
			);
			await page.reload();
			await page.locator(".ctitle").waitFor();
			expect(await page.locator("#detail .chip").filter({ hasText: "Archived" }).count()).toBe(0);
			await page.getByRole("button", { name: "Menu", exact: true }).tap();
			await page.getByRole("button", { name: "Archived", exact: true }).tap();
			await page.getByText("No archived cases match this view.", { exact: true }).waitFor();
			await page.getByRole("button", { name: "Actions", exact: true }).tap();
			expect(await page.getByRole("option", { name: /Restore selected/ }).count()).toBe(0);
			expect(h.errors).toEqual([]);
		} finally {
			await h.close();
			await server.stop();
		}
	},
	30_000,
);

test.skipIf(!browserAvailable)(
	"picking an archived case at its old URL keeps Restore selected",
	async () => {
		const server = await startServer();
		await server.api("propose", { edits: [{ op: "create", body: { title: "Picked archive" } }] });
		await server.api("propose", { edits: [{ op: "state", cases: ["C-1"], to: "archived" }] });
		const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
		try {
			const { page } = h;
			await page.locator("#detail .chip").filter({ hasText: "Archived" }).waitFor();
			await page.keyboard.press("x");
			await page.keyboard.press("ControlOrMeta+k");
			if (process.env.MAINWORTHY_PICKED_ARCHIVE_SCREENSHOT) {
				await page.getByRole("option", { name: /Archive selected|Restore selected/ }).scrollIntoViewIfNeeded();
				await page.screenshot({ path: process.env.MAINWORTHY_PICKED_ARCHIVE_SCREENSHOT });
			}
			await page.getByRole("option", { name: /Restore selected/ }).waitFor();
			expect(await page.getByRole("option", { name: /Archive selected/ }).count()).toBe(0);
			await page.keyboard.press("Escape");
			await page.keyboard.press("#");
			await eventually(
				() => server.api("get", { refs: ["C-1"] }),
				(rows) => rows[0]?.state === "active",
			);
			await page.reload();
			await page.locator(".ctitle").waitFor();
			expect(await page.locator("#detail .chip").filter({ hasText: "Archived" }).count()).toBe(0);
			expect(
				(await server.api("timeline", { ref: "C-1" })).entries.filter((entry) => entry.t === "placement"),
			).toHaveLength(2);
			expect(h.errors).toEqual([]);
		} finally {
			await h.close();
			await server.stop();
		}
	},
	30_000,
);

test.skipIf(!browserAvailable)(
	"mixed archive states refuse and an unread pick must be opened before restoring",
	async () => {
		const server = await startServer();
		await server.api("propose", {
			edits: [
				{ op: "create", body: { title: "Archived pick" } },
				{ op: "create", body: { title: "Active pick" } },
			],
		});
		await server.api("propose", { edits: [{ op: "state", cases: ["C-1"], to: "archived" }] });
		const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
		try {
			const { page } = h;
			await page.locator("#detail .chip").filter({ hasText: "Archived" }).waitFor();
			await page.keyboard.press("x");
			await page.locator("#list").getByRole("option").filter({ hasText: "C-2" }).click();
			await page.getByRole("button", { name: "Active pick", exact: true }).waitFor();
			await page.keyboard.press("x");
			await page.goBack();
			await page.locator("#detail .chip").filter({ hasText: "Archived" }).waitFor();
			await page.keyboard.press("ControlOrMeta+k");
			await page.getByRole("option", { name: /Archive\/restore unavailable/ }).waitFor();
			await page.keyboard.press("Escape");
			await page.keyboard.press("#");
			await page.locator("#stat").filter({ hasText: "Select only active or only archived cases." }).waitFor();
			const states = await server.api("get", { refs: ["C-1", "C-2"] });
			expect(states.map((row) => row.state)).toEqual(["archived", "active"]);
			expect(
				(await server.api("timeline", { ref: "C-1" })).entries.filter((entry) => entry.t === "placement"),
			).toHaveLength(1);
			expect(
				(await server.api("timeline", { ref: "C-2" })).entries.filter((entry) => entry.t === "placement"),
			).toHaveLength(0);
			await page.locator("#list").getByRole("option").filter({ hasText: "C-2" }).click();
			await page.getByRole("button", { name: "Active pick", exact: true }).waitFor();
			await page.keyboard.press("x");
			await page.keyboard.press("#");
			await page.locator("#stat").filter({ hasText: "Open selected cases and wait for their state." }).waitFor();
			expect((await server.api("get", { refs: ["C-1"] }))[0]?.state).toBe("archived");
			await page.goBack();
			await page.locator("#detail .chip").filter({ hasText: "Archived" }).waitFor();
			await page.keyboard.press("#");
			await eventually(
				() => server.api("get", { refs: ["C-1", "C-2"] }),
				(rows) => rows.every((row) => row.state === "active"),
			);
			expect(
				(await server.api("timeline", { ref: "C-1" })).entries.filter((entry) => entry.t === "placement"),
			).toHaveLength(2);
			expect(h.errors).toEqual([]);
		} finally {
			await h.close();
			await server.stop();
		}
	},
	30_000,
);

test.skipIf(!browserAvailable)(
	"an off-list pick cannot undo another person's restore using its saved state",
	async () => {
		const server = await startServer();
		await server.api("propose", {
			edits: [
				{ op: "create", folder: "A", body: { title: "Picked in A" } },
				{ op: "create", folder: "B", body: { title: "Reading in B" } },
			],
		});
		await server.api("propose", { edits: [{ op: "state", cases: ["C-1"], to: "archived" }] });
		const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
		try {
			const { page } = h;
			await page.locator("#detail .chip").filter({ hasText: "Archived" }).waitFor();
			await page.keyboard.press("x");
			await page.locator("button.fo").filter({ hasText: "B" }).click();
			await page.locator("#list").getByRole("option").filter({ hasText: "C-2" }).click();
			await page.getByRole("button", { name: "Reading in B", exact: true }).waitFor();
			await server.api("propose", { edits: [{ op: "state", cases: ["C-1"], to: "active" }] });
			await page.keyboard.press("ControlOrMeta+k");
			if (process.env.MAINWORTHY_PICKED_UNREAD_SCREENSHOT) {
				await page
					.getByRole("option", { name: /Archive selected|Restore selected|unavailable/ })
					.scrollIntoViewIfNeeded();
				await page.screenshot({ path: process.env.MAINWORTHY_PICKED_UNREAD_SCREENSHOT });
			}
			await page.getByRole("option", { name: /Archive\/restore unavailable/ }).waitFor();
			await page.keyboard.press("Escape");
			await page.keyboard.press("#");
			await page.locator("#stat").filter({ hasText: "Open selected cases and wait for their state." }).waitFor();
			expect((await server.api("get", { refs: ["C-1"] }))[0]?.state).toBe("active");
			expect(
				(await server.api("timeline", { ref: "C-1" })).entries.filter((entry) => entry.t === "placement"),
			).toHaveLength(2);
			await page.keyboard.press("u");
			expect((await server.api("get", { refs: ["C-1"] }))[0]?.state).toBe("active");
			expect(
				(await server.api("timeline", { ref: "C-1" })).entries.filter((entry) => entry.t === "placement"),
			).toHaveLength(2);
			expect(h.errors).toEqual([]);
		} finally {
			await h.close();
			await server.stop();
		}
	},
	30_000,
);

test.skipIf(!browserAvailable)(
	"a case picked before its detail loads asks to wait rather than claiming a mixed selection",
	async () => {
		const server = await startServer();
		await server.api("propose", {
			edits: [
				{ op: "create", folder: "A", body: { title: "Waiting in A" } },
				{ op: "create", folder: "B", body: { title: "Loaded in B" } },
			],
		});
		await server.api("propose", { edits: [{ op: "state", cases: ["C-1"], to: "archived" }] });
		let release = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let requested = false;
		const h = await openPage(server, {
			path: "/p/scratch/suite/c/1?folder=B",
			setup: async (_page, context) => {
				await context.route("**/api/p/scratch/get", async (route) => {
					const input = z.object({ refs: z.array(z.string()) }).parse(route.request().postDataJSON());
					if (input.refs.includes("C-1")) {
						requested = true;
						await held;
					}
					await route.continue();
				});
			},
		});
		try {
			const { page } = h;
			await page.locator("#list").getByRole("option").filter({ hasText: "C-2" }).waitFor();
			await eventually(async () => requested, Boolean);
			await page.keyboard.press("x");
			await page.keyboard.press("#");
			await page.locator("#stat").filter({ hasText: "Open selected cases and wait for their state." }).waitFor();
			expect((await server.api("get", { refs: ["C-1"] }))[0]?.state).toBe("archived");
			release();
			await page.locator("#detail .chip").filter({ hasText: "Archived" }).waitFor();
			await page.keyboard.press("#");
			await eventually(
				() => server.api("get", { refs: ["C-1"] }),
				(rows) => rows[0]?.state === "active",
			);
			expect(
				(await server.api("timeline", { ref: "C-1" })).entries.filter((entry) => entry.t === "placement"),
			).toHaveLength(2);
			expect(h.errors).toEqual([]);
		} finally {
			release();
			await h.close();
			await server.stop();
		}
	},
	30_000,
);

for (const initial of ["active", "archived"] as const) {
	for (const count of [1, 2]) {
		test.skipIf(!browserAvailable)(
			`a stale ${initial} selection counts actual changes and undo leaves another client's change alone (${count} selected)`,
			async () => {
				const server = await startServer();
				await server.api("propose", {
					edits: [
						{ op: "create", body: { title: "Other client's case" } },
						{ op: "create", body: { title: "This client's case" } },
					],
				});
				if (initial === "archived")
					await server.api("propose", { edits: [{ op: "state", cases: ["C-1", "C-2"], to: "archived" }] });
				const changed = initial === "active" ? "archived" : "active";
				const h = await openPage(server, {
					path: `/p/scratch/suite/c/1${initial === "archived" ? "?state=archived" : ""}`,
					setup: async (page) => {
						await page.addInitScript(() => {
							Reflect.set(
								window,
								"EventSource",
								class {
									close(): void {}
								},
							);
						});
					},
				});
				try {
					const { page } = h;
					await page.getByRole("button", { name: "Other client's case", exact: true }).waitFor();
					await page.keyboard.press("x");
					if (count === 2) {
						await page.locator("#list").getByRole("option").filter({ hasText: "C-2" }).click();
						await page.getByRole("button", { name: "This client's case", exact: true }).waitFor();
						await page.keyboard.press("x");
					}
					await server.api("propose", { edits: [{ op: "state", cases: ["C-1"], to: changed }] });
					expect(await page.locator("#list").getByRole("option").filter({ hasText: "C-1" }).count()).toBe(1);
					await page.keyboard.press("#");
					await page
						.locator("#stat")
						.filter({ hasText: /changed\./ })
						.waitFor();
					const countText = await page.locator("#stat").textContent();
					if (process.env.MAINWORTHY_PLACEMENT_EFFECTS_SCREENSHOT && initial === "active" && count === 1) {
						await page.locator("#detail .chip").filter({ hasText: "Archived" }).waitFor();
						await page.screenshot({ path: process.env.MAINWORTHY_PLACEMENT_EFFECTS_SCREENSHOT });
					}
					await page.keyboard.press("u");
					await page
						.locator("#stat")
						.filter({ hasText: /No cases changed\.|Undone\./ })
						.waitFor();
					const rows = await server.api("get", { refs: ["C-1", "C-2"] });
					expect(rows.map((row) => row.state)).toEqual([changed, initial]);
					expect(countText).toContain(count === 1 ? "No cases changed." : "1 case changed.");
					expect(
						(await server.api("timeline", { ref: "C-1" })).entries.filter((entry) => entry.t === "placement"),
					).toHaveLength(initial === "active" ? 1 : 2);
					expect(
						(await server.api("timeline", { ref: "C-2" })).entries.filter((entry) => entry.t === "placement"),
					).toHaveLength((initial === "active" ? 0 : 1) + (count === 2 ? 2 : 0));
					expect(h.errors).toEqual([]);
				} finally {
					await h.close();
					await server.stop();
				}
			},
			30_000,
		);
	}
}

test.skipIf(!browserAvailable)(
	"undo queued behind an adopted no-op sends no inverse write",
	async () => {
		const server = await startServer();
		await server.api("propose", { edits: [{ op: "create", body: { title: "Queued no-op" } }] });
		const h = await openPage(server, {
			path: "/p/scratch/suite/c/1",
			setup: async (page) => {
				await page.addInitScript(() => {
					Reflect.set(
						window,
						"EventSource",
						class {
							close(): void {}
						},
					);
				});
			},
		});
		let release = () => {};
		try {
			const { page } = h;
			await page.getByRole("button", { name: "Queued no-op", exact: true }).waitFor();
			const held = await holdPlacements(page);
			release = held.release;
			await server.api("propose", { edits: [{ op: "state", cases: ["C-1"], to: "archived" }] });
			await page.keyboard.press("#");
			await eventually(async () => held.started(), Boolean);
			await page.keyboard.press("u");
			release();
			await page.locator("#stat").filter({ hasText: "No cases changed." }).waitFor();
			expect((await server.api("get", { refs: ["C-1"] }))[0]?.state).toBe("archived");
			expect(
				(await server.api("timeline", { ref: "C-1" })).entries.filter((entry) => entry.t === "placement"),
			).toHaveLength(1);
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
	"a no-op undo step never undoes the preceding tag action",
	async () => {
		const server = await startServer();
		await server.api("propose", { edits: [{ op: "create", body: { title: "Keep earlier tag" } }] });
		const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
		try {
			const { page } = h;
			await page.getByRole("button", { name: "Keep earlier tag", exact: true }).waitFor();
			await tagSelected(page, "kept");
			await page.locator("#stat").filter({ hasText: "1 case changed." }).waitFor();
			await tagSelected(page, "kept");
			await page.locator("#stat").filter({ hasText: "No cases changed." }).waitFor();
			if (process.env.MAINWORTHY_PLACEMENT_NOOP_SCREENSHOT)
				await page.screenshot({ path: process.env.MAINWORTHY_PLACEMENT_NOOP_SCREENSHOT });
			await page.keyboard.press("u");
			await page.locator("#stat").filter({ hasText: "Nothing to undo." }).waitFor();
			expect((await server.api("get", { refs: ["C-1"] }))[0]?.tags).toEqual(["kept"]);
			expect(
				(await server.api("timeline", { ref: "C-1" })).entries.filter((entry) => entry.t === "placement"),
			).toHaveLength(1);
			expect(h.errors).toEqual([]);
		} finally {
			await h.close();
			await server.stop();
		}
	},
	30_000,
);

test.skipIf(!browserAvailable)(
	"an undo that becomes a no-op does not fall through to body restoration",
	async () => {
		const server = await startServer();
		await server.api("propose", { edits: [{ op: "create", body: { title: "Keep current body" } }] });
		await server.api("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: { pre: "Keep this content" } }] });
		const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
		try {
			const { page } = h;
			await page.getByRole("button", { name: "Keep current body", exact: true }).waitFor();
			await tagSelected(page, "removed-elsewhere");
			await page.locator("#stat").filter({ hasText: "1 case changed." }).waitFor();
			await server.api("propose", {
				edits: [{ op: "place", cases: ["C-1"], tags: { remove: ["removed-elsewhere"] } }],
			});
			await page.keyboard.press("u");
			await page.locator("#stat").filter({ hasText: "Nothing to undo." }).waitFor();
			const read = page.waitForResponse((response) => response.url().endsWith("/api/p/scratch/get"));
			await page.keyboard.press("u");
			await page.keyboard.press("v");
			await read;
			expect((await server.api("get", { refs: ["C-1"] }))[0]?.version).toBe(2);
			expect(
				(await server.api("timeline", { ref: "C-1" })).entries.filter((entry) => entry.t === "placement"),
			).toHaveLength(2);
			expect(h.errors).toEqual([]);
		} finally {
			await h.close();
			await server.stop();
		}
	},
	30_000,
);

for (const lost of ["placement", "undo"] as const) {
	test.skipIf(!browserAvailable)(
		lost === "undo"
			? "retrying a lost Undo reply preserves a colleague's later move"
			: "a lost placement reply still lets Undo record its original inverse",
		async () => {
			const server = await startServer();
			await server.api("propose", {
				edits: [
					{ op: "create", folder: "Original", body: { title: "Lost placement reply" } },
					{ op: "folder", name: "Destination" },
					{ op: "folder", name: "Colleague" },
				],
			});
			const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
			try {
				const { page, context } = h;
				await page.getByRole("button", { name: "Lost placement reply", exact: true }).waitFor();
				const dropReply = async () => {
					let dropped = false;
					await context.route("**/api/p/scratch/propose", async (route) => {
						if (dropped) return route.continue();
						dropped = true;
						await route.fetch();
						await route.abort("failed");
					});
				};
				if (lost === "placement") await dropReply();
				await page.keyboard.press("m");
				await page.getByRole("textbox", { name: "Move selected cases to a folder" }).fill("Destination");
				await page.keyboard.press("Enter");
				if (lost === "undo") {
					await page.locator("#stat").filter({ hasText: "1 case changed" }).waitFor();
					await dropReply();
					await page.keyboard.press("u");
				}
				await page
					.locator("#stat")
					.filter({ hasText: /fetch|failed|unknown/i })
					.waitFor();
				const before = (await server.api("get", { refs: ["C-1"] }))[0];
				expect(z.object({ path: z.string() }).parse(before?.folder).path).toBe(
					lost === "undo" ? "Original" : "Destination",
				);
				await server.api("propose", { edits: [{ op: "place", cases: ["C-1"], folder: "Colleague" }] });
				await page.keyboard.press("u");
				// Retrying the original placement recovers its inverse, which Undo may then apply once.
				// Retrying an already-recorded Undo must preserve the colleague's move.
				await page.locator("#stat").filter({ hasText: "Undone" }).waitFor();
				if (lost === "undo" && process.env.MAINWORTHY_UNDO_LOSS_SCREENSHOT)
					await page.screenshot({ path: process.env.MAINWORTHY_UNDO_LOSS_SCREENSHOT });
				const after = (await server.api("get", { refs: ["C-1"] }))[0];
				expect(z.object({ path: z.string() }).parse(after?.folder).path).toBe(
					lost === "undo" ? "Colleague" : "Original",
				);
				const timeline = await server.api("timeline", { ref: "C-1" });
				expect(timeline.entries.filter((entry) => entry.t === "placement")).toHaveLength(3);
				await eventually(
					() => page.locator(".cmeta .path").textContent(),
					(folder) => folder === (lost === "undo" ? "Colleague" : "Original"),
				);
			} finally {
				await h.close();
				await server.stop();
			}
		},
		30_000,
	);
}
