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

test.skipIf(!browserAvailable)(
	"a failed tag leaves the tags the change stream showed, not the list from before the request",
	async () => {
		const server = await startServer();
		await server.api("propose", { edits: [{ op: "create", body: { title: "Tag then fail" } }] });
		const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
		let fail = () => {};
		try {
			const { page } = h;
			await page.getByRole("button", { name: "Tag then fail", exact: true }).waitFor();
			let started = false;
			const held = new Promise<void>((resolve) => {
				fail = resolve;
			});
			await page.context().route("**/api/p/scratch/propose", async (route) => {
				started = true;
				await held;
				await route.fulfill({
					status: 500,
					contentType: "application/json",
					body: JSON.stringify({ ok: false, error: { code: "internal", message: "The write failed" } }),
				});
			});
			await page.keyboard.press("t");
			await page.keyboard.type("alpha");
			await page.keyboard.press("Enter");
			await page.waitForFunction(() => document.querySelector(".ctags")?.textContent?.includes("#alpha"));
			await eventually(async () => started, Boolean);
			await server.api("propose", { edits: [{ op: "place", cases: ["C-1"], tags: { add: ["beta"] } }] });
			await eventually(
				async () => (await page.locator(".ctags").textContent()) ?? "",
				(text) => text.includes("#beta"),
			);
			fail();
			await page.waitForFunction(() => document.querySelector("#stat")?.textContent?.includes("The write failed"));
			await eventually(
				async () => (await page.locator(".ctags").textContent()) ?? "",
				(text) => !text.includes("#alpha") && text.includes("#beta"),
			);
			expect(await page.locator(".ctags").textContent()).toContain("#beta");
			expect(await page.locator(".ctags").textContent()).not.toContain("#alpha");
			expect((await server.api("get", { refs: ["C-1"] }))[0]?.tags).toEqual(["beta"]);
		} finally {
			fail();
			await h.close();
			await server.stop();
		}
	},
	30_000,
);
