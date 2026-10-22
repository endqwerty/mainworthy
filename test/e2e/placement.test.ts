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
