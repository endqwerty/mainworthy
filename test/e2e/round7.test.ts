import { expect, test } from "bun:test";
import type { Page } from "playwright-core";
import { z } from "zod";
import { DraftConflict } from "../../src/web/lib/drafts.ts";
import { browserAvailable, eventually, openPage, type Server, startServer } from "./support.ts";

const check = test.skipIf(!browserAvailable);
const title = (page: Page) => page.getByRole("textbox", { name: "Case title", exact: true });
const step = (page: Page) => page.getByRole("textbox", { name: "Step 2", exact: true });
const card = (page: Page) => page.locator(".conflict-card");
const resolve = (page: Page) => page.getByRole("button", { name: "Resolve conflict", exact: true }).click();
const latch = () => {
	let release = () => {};
	const held = new Promise<void>((done) => {
		release = done;
	});
	return { held, release };
};
const Stored = z.object({
	base: z.number(),
	body: z.object({ title: z.string(), steps: z.array(z.object({ action: z.string() })) }),
	conflict: DraftConflict.optional(),
});
async function drafts(page: Page) {
	const raw = await page.evaluate(() =>
		Object.entries(localStorage)
			.filter(([key]) => key.includes(":draft:"))
			.map(([, value]) => JSON.parse(value)),
	);
	return z.array(Stored).parse(raw);
}
async function cases(server: Server) {
	await server.api("propose", {
		edits: [1, 2].map((n) => ({
			op: "create",
			body: {
				title: `Case ${n}`,
				steps: [
					{ id: "s1", action: "Open the cart", expected: null },
					{ id: "s2", action: "Apply the coupon", expected: null },
				],
			},
		})),
	});
}
async function conflict(server: Server, page: Page) {
	await page.getByRole("button", { name: "Case 1", exact: true }).waitFor();
	await page.keyboard.press("e");
	await title(page).fill("My title");
	await step(page).fill("Apply the coupon SAVE10");
	await server.api("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Their title" } }] });
	const gate = latch();
	let replied = false;
	await page.route("**/propose", async (route) => {
		const response = await route.fetch();
		replied = true;
		await gate.held;
		await route.fulfill({ response });
	});
	try {
		await page.keyboard.press("Escape");
		await eventually(async () => replied, Boolean);
		gate.release();
		await card(page).waitFor();
	} finally {
		gate.release();
		await page.unroute("**/propose");
	}
}
async function question(server: Server) {
	const q = (await server.api("inbox", { on: "C-1", kind: "adopt" })).items[0];
	if (!q) throw Error("Missing conflict question");
	return q;
}
async function laterStoredText(page: Page) {
	await page.evaluate(() => {
		const key = Object.keys(localStorage).find((key) => key.includes(":draft:") && key.endsWith(":C-1"));
		if (!key) throw Error("Missing stored draft");
		const draft = JSON.parse(localStorage.getItem(key) ?? "{}");
		draft.body.steps[1].action = "Later text kept on the device";
		localStorage.setItem(key, JSON.stringify(draft));
	});
}

for (const order of ["resolve then reload", "reload then resolve"])
	check(
		`R7-1 route A: an existing second window freezes and releases through storage, ${order}`,
		async () => {
			const server = await startServer();
			await cases(server);
			const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
			try {
				const a = h.page;
				const b = await h.context.newPage();
				a.setDefaultTimeout(5000);
				b.setDefaultTimeout(5000);
				await b.goto(`${server.url}/p/scratch/suite/c/1`);
				await b.getByRole("button", { name: "Case 1", exact: true }).waitFor();
				await conflict(server, a);
				await b.keyboard.press("e");
				await title(b).waitFor();
				expect(await card(b).count()).toBe(1);
				expect(await title(b).evaluate((el) => el instanceof HTMLTextAreaElement && el.readOnly)).toBe(true);
				await step(b).click();
				await b.keyboard.type(" REFUSED IN B");
				expect(await step(b).inputValue()).toBe("Apply the coupon SAVE10");
				await b.getByText("This case is being edited in another window", { exact: false }).first().waitFor();
				if (order === "reload then resolve") {
					await b.reload();
					await card(b).waitFor();
				}
				await a.getByRole("button", { name: "Use all my changes", exact: true }).click();
				await resolve(a);
				await card(a).waitFor({ state: "detached" });
				await card(b).waitFor({ state: "detached" });
				await b.getByText("Conflict resolved", { exact: false }).first().waitFor();
				expect(await drafts(b)).toHaveLength(0);
				const saved = await server.api("get", { refs: ["C-1"] });
				expect(saved[0]?.version).toBe(3);
				expect(JSON.stringify(saved)).toContain("SAVE10");
				expect(JSON.stringify(saved)).not.toContain("REFUSED");
				for (const page of order === "resolve then reload" ? [b, a] : [a, b]) {
					await page.reload();
					await page.getByRole("button", { name: "My title", exact: true }).waitFor();
					expect(await drafts(page)).toHaveLength(0);
				}
				await b.keyboard.press("e");
				expect(await title(b).evaluate((el) => el instanceof HTMLTextAreaElement && el.readOnly)).toBe(false);
			} finally {
				await h.close();
				await server.stop();
			}
		},
		30000,
	);

check(
	"R7-1 route B: rejection while opened on another case clears the stored conflict and preserves a later proposal",
	async () => {
		const server = await startServer();
		await cases(server);
		const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
		try {
			const { page } = h;
			page.setDefaultTimeout(5000);
			await conflict(server, page);
			const q = await question(server);
			await page.goto(`${server.url}/p/scratch/suite/c/2`);
			await page.getByRole("button", { name: "Case 2", exact: true }).waitFor();
			await server.api("decide", { q: q.q, onEvidence: q.evidenceHash, answer: { is: "reject" } });
			await page.locator('[data-testid="case-list"] [role="option"]').filter({ hasText: "C-1" }).click();
			await page.getByRole("button", { name: "Their title", exact: true }).waitFor();
			// The window that left the card is gone (the page was opened again, under a new window id), and no
			// other window exists. Coming to the case takes nothing, and the pane says only what this window can
			// tell: the draft's window is not answering, or has closed (review round 9, R9-2; issue #79). `e` goes
			// on with the draft here, and then the rejection is told.
			await page.getByRole("button", { name: "Take over here", exact: true }).waitFor();
			expect(await page.locator("#detail").innerText()).toContain(
				"held by a window that is not answering, or has closed",
			);
			expect(await page.getByText("This case is being edited in another window").count()).toBe(0);
			expect((await drafts(page))[0]?.conflict).toBeDefined();
			await page.keyboard.press("e");
			await page.locator("#stat").filter({ hasText: "The conflict proposal was rejected" }).waitFor();
			await eventually(
				() => drafts(page),
				(rows) => rows[0]?.conflict === undefined,
			);
			expect(await title(page).inputValue()).toBe("My title");
			await step(page).fill("Apply the coupon SAVE10 after rejection");
			await page.keyboard.press("Escape");
			await card(page).waitFor();
			expect((await drafts(page))[0]?.body.steps[1]?.action).toBe("Apply the coupon SAVE10 after rejection");
			await page.reload();
			await card(page).waitFor();
			expect(await step(page).inputValue()).toBe("Apply the coupon SAVE10 after rejection");
			await page.getByRole("button", { name: "Use all my changes", exact: true }).click();
			await resolve(page);
			await card(page).waitFor({ state: "detached" });
			expect(JSON.stringify(await server.api("get", { refs: ["C-1"] }))).toContain("after rejection");
		} finally {
			await h.close();
			await server.stop();
		}
	},
	30000,
);

check(
	"R7-1 storage freezes an already open editor and rejection releases it without a reload",
	async () => {
		const server = await startServer();
		await cases(server);
		const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
		try {
			const a = h.page;
			const b = await h.context.newPage();
			a.setDefaultTimeout(5000);
			b.setDefaultTimeout(5000);
			await b.goto(`${server.url}/p/scratch/suite/c/1`);
			await b.getByRole("button", { name: "Case 1", exact: true }).waitFor();
			await b.keyboard.press("e");
			expect(await title(b).evaluate((el) => el instanceof HTMLTextAreaElement && el.readOnly)).toBe(false);
			await conflict(server, a);
			await card(b).waitFor();
			expect(await title(b).evaluate((el) => el instanceof HTMLTextAreaElement && el.readOnly)).toBe(true);
			await b.getByText("This case is being edited in another window", { exact: false }).first().waitFor();
			const q = await question(server);
			await server.api("decide", { q: q.q, onEvidence: q.evidenceHash, answer: { is: "reject" } });
			await card(a).waitFor({ state: "detached" });
			await card(b).waitFor({ state: "detached" });
			expect(await title(b).evaluate((el) => el instanceof HTMLTextAreaElement && el.readOnly)).toBe(true);
			expect(await title(b).inputValue()).toBe("My title");
			await b.getByRole("button", { name: "Take over here", exact: true }).click();
			expect(await title(b).evaluate((el) => el instanceof HTMLTextAreaElement && el.readOnly)).toBe(false);
			await title(b).fill("My title editable after rejection");
			expect((await drafts(b))[0]?.body.title).toBe("My title editable after rejection");
		} finally {
			await h.close();
			await server.stop();
		}
	},
	30000,
);

for (const choice of ["Keep current version", "Use current title"])
	check(
		`R7-2 rejection preserves the draft after unconfirmed ${choice}`,
		async () => {
			const server = await startServer();
			await cases(server);
			const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
			try {
				const { page } = h;
				page.setDefaultTimeout(5000);
				await conflict(server, page);
				await page.getByRole("button", { name: choice, exact: true }).click();
				const q = await question(server);
				await page.close();
				await server.api("decide", { q: q.q, onEvidence: q.evidenceHash, answer: { is: "reject" } });
				const returned = await h.context.newPage();
				returned.setDefaultTimeout(5000);
				await returned.goto(`${server.url}/p/scratch/suite/c/1`);
				await title(returned).waitFor();
				await card(returned).waitFor({ state: "detached" });
				await returned.getByText("Your current draft is kept", { exact: false }).first().waitFor();
				expect(await title(returned).inputValue()).toBe("My title");
				expect(await step(returned).inputValue()).toBe("Apply the coupon SAVE10");
				expect((await drafts(returned))[0]?.conflict).toBeUndefined();
			} finally {
				await h.close();
				await server.stop();
			}
		},
		30000,
	);

check(
	"R7-3 a merge decided elsewhere drops already recorded text and shows the actual head",
	async () => {
		const server = await startServer();
		await cases(server);
		const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
		try {
			const { page } = h;
			page.setDefaultTimeout(5000);
			await conflict(server, page);
			const stored = (await drafts(page))[0]?.conflict;
			if (!stored) throw Error("Missing stored conflict");
			const q = await question(server);
			await page.close();
			await server.api("decide", { q: q.q, onEvidence: q.evidenceHash, answer: { is: "merge", body: stored.mine } });
			const returned = await h.context.newPage();
			returned.setDefaultTimeout(5000);
			let sent = 0;
			await returned.route("**/propose", async (route) => {
				sent++;
				await route.continue();
			});
			await returned.goto(`${server.url}/p/scratch/suite/c/1`);
			await eventually(
				() => drafts(returned),
				(rows) => rows.length === 0,
			);
			await returned.getByText("Conflict resolved", { exact: false }).first().waitFor();
			await returned.getByRole("button", { name: "My title", exact: true }).waitFor();
			await returned.keyboard.press("e");
			await returned.keyboard.press("Escape");
			expect(sent).toBe(0);
			expect(await returned.locator("#detail").innerText()).toContain("Version 3");
			expect((await server.api("get", { refs: ["C-1"] }))[0]?.version).toBe(3);
		} finally {
			await h.close();
			await server.stop();
		}
	},
	30000,
);

check(
	"R7-4 a second press after a lost merge reply releases the card without a reload",
	async () => {
		const server = await startServer();
		await cases(server);
		const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
		const gate = latch();
		try {
			const { page } = h;
			page.setDefaultTimeout(5000);
			await conflict(server, page);
			await page.getByRole("textbox", { name: "Merged title", exact: true }).fill("Recorded merge");
			let received = false;
			await page.route("**/decide", async (route) => {
				await route.fetch();
				received = true;
				await gate.held;
				await route.abort("failed");
			});
			await resolve(page);
			await eventually(async () => received, Boolean);
			gate.release();
			await page.getByText("Your draft and conflict card are kept", { exact: false }).first().waitFor();
			await page.unroute("**/decide");
			await resolve(page);
			await card(page).waitFor({ state: "detached" });
			await page.getByText("Conflict resolved", { exact: false }).first().waitFor();
			expect(await drafts(page)).toHaveLength(0);
			await page.keyboard.press("e");
			await title(page).fill("Recorded merge and later edit");
			await page.keyboard.press("Escape");
			const saved = await eventually(
				() => server.api("get", { refs: ["C-1"] }),
				(rows) => rows[0]?.version === 4,
			);
			expect(saved[0]?.title).toBe("Recorded merge and later edit");
		} finally {
			gate.release();
			await h.close();
			await server.stop();
		}
	},
	30000,
);

check(
	"R7 removal guard: a merge reply preserves a stored body that changed since mine",
	async () => {
		const server = await startServer();
		await cases(server);
		const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
		const gate = latch();
		try {
			const { page } = h;
			page.setDefaultTimeout(5000);
			await conflict(server, page);
			let received = false;
			await page.route("**/decide", async (route) => {
				const response = await route.fetch();
				received = true;
				await gate.held;
				await route.fulfill({ response });
			});
			await resolve(page);
			await eventually(async () => received, Boolean);
			await laterStoredText(page);
			gate.release();
			await card(page).waitFor({ state: "detached" });
			const kept = (await drafts(page))[0];
			expect(kept?.body.steps[1]?.action).toBe("Later text kept on the device");
			expect(kept?.base).toBe(3);
			expect(kept?.conflict).toBeUndefined();
			expect(await step(page).inputValue()).toBe("Later text kept on the device");
			await page.getByText("later text is kept", { exact: false }).first().waitFor();
			await page.reload();
			expect(await step(page).inputValue()).toBe("Later text kept on the device");
		} finally {
			gate.release();
			await h.close();
			await server.stop();
		}
	},
	30000,
);

check(
	"R7 write guard: a conflict stored before its event refuses input in an unfrozen editor",
	async () => {
		const server = await startServer();
		await cases(server);
		const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
		try {
			const { page } = h;
			page.setDefaultTimeout(5000);
			await conflict(server, page);
			const stored = (await drafts(page))[0]?.conflict;
			if (!stored) throw Error("Missing conflict");
			await page.goto(`${server.url}/p/scratch/suite/c/2`);
			await page.getByRole("button", { name: "Case 2", exact: true }).waitFor();
			await page.keyboard.press("e");
			await title(page).fill("Case 2 draft");
			expect(await title(page).evaluate((el) => el instanceof HTMLTextAreaElement && el.readOnly)).toBe(false);
			await title(page).click();
			await page.evaluate((conflict) => {
				const key = Object.keys(localStorage).find((key) => key.includes(":draft:") && key.endsWith(":C-2"));
				if (!key) throw Error("Missing second draft");
				const draft = JSON.parse(localStorage.getItem(key) ?? "{}");
				draft.conflict = { ...conflict, ref: "C-2", draftId: "C-2", mine: draft.body };
				localStorage.setItem(key, JSON.stringify(draft));
			}, stored);
			await page.keyboard.insertText(" REFUSED BEFORE EVENT");
			expect(await title(page).inputValue()).toBe("Case 2 draft");
			expect((await drafts(page)).find((draft) => draft.body.title.startsWith("Case 2"))?.body.title).toBe(
				"Case 2 draft",
			);
			await page.getByText("Resolve the conflict first", { exact: false }).first().waitFor();
			expect(await page.locator("#bar").innerText()).toContain("Resolve the conflict first");
			expect(await title(page).evaluate((el) => el instanceof HTMLTextAreaElement && el.readOnly)).toBe(true);
		} finally {
			await h.close();
			await server.stop();
		}
	},
	30000,
);

check(
	"R7 removal guard: a late merge reply keeps a fresh draft after another window released the conflict",
	async () => {
		const server = await startServer();
		await cases(server);
		const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
		const gate = latch();
		try {
			const a = h.page;
			a.setDefaultTimeout(5000);
			await conflict(server, a);
			const b = await h.context.newPage();
			b.setDefaultTimeout(5000);
			await b.goto(`${server.url}/p/scratch/suite/c/1`);
			await card(b).waitFor();
			await a.getByRole("textbox", { name: "Merged title", exact: true }).fill("Recorded choice");
			let received = false;
			await a.route("**/decide", async (route) => {
				const response = await route.fetch();
				received = true;
				await gate.held;
				await route.fulfill({ response });
			});
			await resolve(a);
			await eventually(async () => received, Boolean);
			await b.getByRole("button", { name: "Take over here", exact: true }).click();
			await card(b).waitFor({ state: "detached" });
			await b.getByRole("button", { name: "Recorded choice", exact: true }).waitFor();
			await b.keyboard.press("e");
			await title(b).fill("My title");
			expect((await drafts(b))[0]?.conflict).toBeUndefined();
			gate.release();
			await a.locator("#bar").filter({ hasText: "This case is being edited in another window" }).waitFor();
			await eventually(
				() => drafts(b),
				(rows) => rows[0]?.base === 3,
			);
			expect((await drafts(b))[0]?.body.title).toBe("My title");
			expect(await title(b).inputValue()).toBe("My title");
			expect((await server.api("get", { refs: ["C-1"] }))[0]?.title).toBe("Recorded choice");
		} finally {
			gate.release();
			await h.close();
			await server.stop();
		}
	},
	30000,
);

check(
	"R7-4 retry after a lost merge reply keeps text subsequently typed in the card",
	async () => {
		const server = await startServer();
		await cases(server);
		const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
		const gate = latch();
		try {
			const { page } = h;
			page.setDefaultTimeout(5000);
			await conflict(server, page);
			const merged = page.getByRole("textbox", { name: "Merged title", exact: true });
			await merged.fill("Recorded merge");
			let received = false;
			await page.route("**/decide", async (route) => {
				await route.fetch();
				received = true;
				await gate.held;
				await route.abort("failed");
			});
			await resolve(page);
			await eventually(async () => received, Boolean);
			gate.release();
			await page.getByText("Your draft and conflict card are kept", { exact: false }).first().waitFor();
			await page.unroute("**/decide");
			await merged.fill("Recorded merge and later card text");
			await resolve(page);
			await card(page).waitFor({ state: "detached" });
			await page.getByText("later text is kept", { exact: false }).first().waitFor();
			expect(await title(page).inputValue()).toBe("Recorded merge and later card text");
			expect((await drafts(page))[0]?.body.title).toBe("Recorded merge and later card text");
			expect((await server.api("get", { refs: ["C-1"] }))[0]?.title).toBe("Recorded merge");
			await page.keyboard.press("Escape");
			const saved = await eventually(
				() => server.api("get", { refs: ["C-1"] }),
				(rows) => rows[0]?.version === 4,
			);
			expect(saved[0]?.title).toBe("Recorded merge and later card text");
		} finally {
			gate.release();
			await h.close();
			await server.stop();
		}
	},
	30000,
);
