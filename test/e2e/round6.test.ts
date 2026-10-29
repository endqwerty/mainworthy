import { afterAll, expect, test } from "bun:test";
import type { Page } from "playwright-core";
import { z } from "zod";
import { emptyBody } from "../../src/core/model.ts";
import { ReportInput } from "../../src/core/ops.ts";
import { call } from "../../src/web/lib/api.ts";
import { Slot } from "../../src/web/runs/models.ts";
import { browserAvailable, eventually, openPage, type Server, startServer } from "./support.ts";

let sharedServer: Promise<Server> | undefined;
let projectNumber = 0;
afterAll(async () => {
	if (sharedServer) await (await sharedServer).stop();
});
async function fixture({ preset = "loose" }: { preset?: string } = {}): Promise<Server> {
	sharedServer ??= startServer();
	const shared = await sharedServer;
	const project = `round-six-${++projectNumber}`;
	await shared.api("admin", { do: "project.create", key: project, preset });
	return {
		...shared,
		project,
		api: (op, input, options = {}) =>
			call(op, input, { url: shared.url, project, token: options.token ?? shared.token }),
		stop: async () => {},
	};
}

const check = test.skipIf(!browserAvailable);
const latch = () => {
	let release = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { held, release };
};
const title = (page: Page) => page.getByRole("textbox", { name: "Case title", exact: true });
const step = (page: Page) => page.getByRole("textbox", { name: "Step 2", exact: true });
const resolve = (page: Page) => page.getByRole("button", { name: "Resolve conflict", exact: true }).click();
const drafts = (page: Page) =>
	page.evaluate(() =>
		Object.entries(localStorage)
			.filter(([key]) => key.includes(":draft:"))
			.map(([, value]) => value),
	);
async function cases(server: Server, count = 1) {
	await server.api("propose", {
		edits: Array.from({ length: count }, (_, i) => ({
			op: "create",
			body: {
				title: `Case ${i + 1}`,
				methods: ["human"],
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
	await server.api("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Their title" } }] });
	await page.keyboard.press("Escape");
	await page.locator(".conflict-card").waitFor();
}
for (const choice of ["Use my title", "Use all my changes"])
	check(
		`R6-1 ${choice} refuses later editor input visibly without moving focus`,
		async () => {
			const server = await fixture();
			await cases(server);
			const h = await openPage(server, { path: `/p/${server.project}/suite/c/1` });
			try {
				const { page } = h;
				await conflict(server, page);
				await page.getByRole("button", { name: choice, exact: true }).click();
				const field = choice === "Use my title" ? title(page) : step(page);
				const before = await field.inputValue();
				await field.click();
				await field.press("End");
				await page.keyboard.type(" AND MORE");
				expect(await field.inputValue()).toBe(before);
				expect(await field.evaluate((element) => document.activeElement === element)).toBe(true);
				await page.getByText("Resolve the conflict first", { exact: false }).first().waitFor();
				await page.getByRole("textbox", { name: "Merged title", exact: true }).fill("My title from the card");
				await resolve(page);
				const saved = await eventually(
					() => server.api("get", { refs: ["C-1"] }),
					(rows) => rows[0]?.version === 3,
				);
				expect(saved[0]?.title).toBe("My title from the card");
				expect(JSON.stringify(saved)).not.toContain("AND MORE");
				await page.locator(".conflict-card").waitFor({ state: "detached" });
				await page.keyboard.press("e");
				await title(page).press("End");
				await page.keyboard.type(" after resolution");
				expect(await title(page).inputValue()).toBe("My title from the card after resolution");
			} finally {
				await h.close();
				await server.stop();
			}
		},
		30000,
	);

// Issue #94. The page read the case before the merge and reads it again after it. Until that second read is
// back, the case it holds is the colleague's version, and the editor must not open on it.
check(
	"R6-1 the editor opens on the version the merge recorded while the case is still being read again",
	async () => {
		const server = await fixture();
		await cases(server);
		const h = await openPage(server, { path: `/p/${server.project}/suite/c/1` });
		const gate = latch();
		try {
			const { page } = h;
			await conflict(server, page);
			await page.getByText("Others see version 2", { exact: true }).waitFor();
			await page.getByRole("textbox", { name: "Merged title", exact: true }).fill("Merged in the card");
			// From here a read of the case as it is now gets no reply. A read of one version of it does.
			await page.route("**/get", async (route) => {
				const input = z
					.object({ refs: z.array(z.string()), version: z.number().optional() })
					.parse(route.request().postDataJSON());
				if (input.refs.includes("C-1") && input.version === undefined) await gate.held;
				// The page gives up a read it has replaced, and such a request cannot be continued.
				await route.continue().catch(() => {});
			});
			await resolve(page);
			await eventually(
				() => server.api("get", { refs: ["C-1"] }),
				(rows) => rows[0]?.version === 3,
			);
			await page.locator(".conflict-card").waitFor({ state: "detached" });
			expect(await page.locator("#detail .ctitle").innerText()).toBe("Merged in the card");
			await page.keyboard.press("e");
			await title(page).press("End");
			await page.keyboard.type(" and more");
			expect(await title(page).inputValue()).toBe("Merged in the card and more");
			const kept = z.array(z.object({ base: z.number() })).parse((await drafts(page)).map((text) => JSON.parse(text)));
			expect(kept.map((draft) => draft.base)).toEqual([3]);
		} finally {
			gate.release();
			await h.close();
			await server.stop();
		}
	},
	30000,
);

check(
	"R6-1 a merge whose recorded version cannot be read keeps its card until resolving again reads it",
	async () => {
		const server = await fixture();
		await cases(server);
		const h = await openPage(server, { path: `/p/${server.project}/suite/c/1` });
		try {
			const { page } = h;
			await conflict(server, page);
			await page.getByRole("textbox", { name: "Merged title", exact: true }).fill("Merged in the card");
			let failing = true;
			await page.route("**/get", async (route) => {
				const input = z.object({ version: z.number().optional() }).parse(route.request().postDataJSON());
				if (failing && input.version !== undefined) await route.abort("failed");
				else await route.continue().catch(() => {});
			});
			await resolve(page);
			await page.getByText("Your draft and conflict card are kept", { exact: false }).first().waitFor();
			expect((await server.api("get", { refs: ["C-1"] }))[0]?.version).toBe(3);
			expect(await page.locator(".conflict-card").count()).toBe(1);
			expect(await title(page).inputValue()).toBe("My title");
			failing = false;
			await resolve(page);
			await page.locator(".conflict-card").waitFor({ state: "detached" });
			expect(await page.locator("#detail .ctitle").innerText()).toBe("Merged in the card");
			expect(await drafts(page)).toHaveLength(0);
			const saved = await server.api("get", { refs: ["C-1"] });
			expect(saved[0]?.version).toBe(3);
			expect(saved[0]?.title).toBe("Merged in the card");
		} finally {
			await h.close();
			await server.stop();
		}
	},
	30000,
);

check(
	"R6-1 a merge the head already holds keeps its card until the case is read again",
	async () => {
		const server = await fixture();
		await cases(server);
		const h = await openPage(server, { path: `/p/${server.project}/suite/c/1` });
		const gate = latch();
		try {
			const { page } = h;
			await conflict(server, page);
			await page.getByText("Others see version 2", { exact: true }).waitFor();
			let answered = false;
			let readSince = 0;
			await page.route("**/decide", async (route) => {
				const response = await route.fetch();
				answered = true;
				await route.fulfill({ response });
			});
			await page.route("**/get", async (route) => {
				const input = z
					.object({ refs: z.array(z.string()), version: z.number().optional() })
					.parse(route.request().postDataJSON());
				if (input.refs.includes("C-1") && input.version === undefined) {
					if (answered) readSince++;
					await gate.held;
				}
				await route.continue().catch(() => {});
			});
			// A colleague records the very text the person is about to merge. The page cannot read it yet.
			await server.api("propose", {
				edits: [{ op: "edit", case: "C-1", base: 2, body: { title: "Their second title" } }],
			});
			await page.getByRole("textbox", { name: "Merged title", exact: true }).fill("Their second title");
			await resolve(page);
			await eventually(
				async () => readSince,
				(n) => n > 0,
			);
			expect(await page.locator(".conflict-card").count()).toBe(1);
			gate.release();
			await page.locator(".conflict-card").waitFor({ state: "detached" });
			expect(await page.locator("#detail .ctitle").innerText()).toBe("Their second title");
			await page.getByText("The recorded version already holds this text", { exact: false }).first().waitFor();
			expect((await server.api("get", { refs: ["C-1"] }))[0]?.version).toBe(3);
		} finally {
			gate.release();
			await h.close();
			await server.stop();
		}
	},
	30000,
);

// Issue #94, a second tab of the same person. It shows the draft the first tab owns, and hears that the draft
// is gone before it has read what became of the case.
async function follower(server: Server, h: Awaited<ReturnType<typeof openPage>>): Promise<Page> {
	const page = await h.context.newPage();
	await page.goto(`${server.url}/p/${server.project}/suite/c/1`);
	await page.getByRole("button", { name: "Case 1", exact: true }).waitFor();
	await page.keyboard.press("e");
	return page;
}
const caseReads = z.object({ refs: z.array(z.string()) });
const leaveField = (page: Page) =>
	page.evaluate(() => {
		if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
	});
for (const first of ["resolves the conflict", "records the edit"])
	check(
		`R6-1 a second tab keeps the draft it shows until it has read the case, when the first ${first}`,
		async () => {
			const server = await fixture();
			await cases(server);
			const h = await openPage(server, { path: `/p/${server.project}/suite/c/1` });
			const gate = latch();
			try {
				const a = h.page;
				const b = await follower(server, h);
				const merge = first === "resolves the conflict";
				if (merge) {
					await conflict(server, a);
					await b.locator(".conflict-card").waitFor();
					await b.getByText("Others see version 2", { exact: true }).waitFor();
				} else {
					await a.getByRole("button", { name: "Case 1", exact: true }).waitFor();
					await a.keyboard.press("e");
					await title(a).fill("My title");
				}
				await eventually(
					() => title(b).inputValue(),
					(text) => text === "My title",
				);
				// From here the second tab gets no reply to a read of the case.
				await b.route("**/get", async (route) => {
					if (caseReads.parse(route.request().postDataJSON()).refs.includes("C-1")) await gate.held;
					await route.continue().catch(() => {});
				});
				if (merge) {
					await a.getByRole("textbox", { name: "Merged title", exact: true }).fill("Merged in the card");
					await resolve(a);
					await a.locator(".conflict-card").waitFor({ state: "detached" });
				} else await a.keyboard.press("Escape");
				const recorded = merge ? "Merged in the card" : "My title";
				await eventually(
					() => server.api("get", { refs: ["C-1"] }),
					(rows) => rows[0]?.title === recorded,
				);
				await b
					.getByText(/(resolved|ended) in another window/)
					.first()
					.waitFor();
				// Until it has read the case, the tab shows the draft as it was and nothing of the case from before.
				expect(await b.locator("#detail .read-body .ctitle").allInnerTexts()).toEqual([]);
				expect(await b.locator(".conflict-card").count()).toBe(merge ? 1 : 0);
				expect(await title(b).inputValue()).toBe("My title");
				// `e` opens no editor on the case meanwhile, and does not store the draft again as this tab's.
				await leaveField(b);
				await b.keyboard.press("e");
				expect(await drafts(b)).toHaveLength(0);
				expect(await b.locator("#detail .read-body .ctitle").count()).toBe(0);
				gate.release();
				expect(await b.locator("#detail .read-body .ctitle").innerText()).toBe(recorded);
				expect(await b.locator(".conflict-card").count()).toBe(0);
				await b.keyboard.press("e");
				expect(await title(b).inputValue()).toBe(recorded);
				expect(await drafts(b)).toHaveLength(0);
			} finally {
				gate.release();
				await h.close();
				await server.stop();
			}
		},
		30000,
	);

/**
 * What the page's reads of C-1 get from here on: no reply ("lost"), the server's answer ("answered"), or a
 * refusal that carries any other text as its message, so a test can tell one refused read from the next.
 */
async function unreadable(page: Page): Promise<{ reads: string; asked: number; release: () => void }> {
	const gate = latch();
	const state = { reads: "lost", asked: 0, release: gate.release };
	await page.route("**/get", async (route) => {
		const read = caseReads.parse(route.request().postDataJSON()).refs.includes("C-1");
		if (read) state.asked++;
		if (read && state.reads === "held") await gate.held;
		if (!read || state.reads === "answered" || state.reads === "held") await route.continue().catch(() => {});
		else if (state.reads === "lost") await route.abort("failed");
		else await route.fulfill({ json: { ok: false, error: { code: "internal", message: state.reads } } });
	});
	return state;
}
const editors = (page: Page) =>
	title(page).evaluateAll((fields) => fields.map((field) => (field instanceof HTMLTextAreaElement ? field.value : "")));

check(
	"R6-1 a second tab that cannot read the case keeps its card until a read of it succeeds",
	async () => {
		const server = await fixture();
		await cases(server);
		const h = await openPage(server, { path: `/p/${server.project}/suite/c/1` });
		try {
			const a = h.page;
			const b = await follower(server, h);
			await conflict(server, a);
			await b.locator(".conflict-card").waitFor();
			const get = await unreadable(b);
			await a.getByRole("textbox", { name: "Merged title", exact: true }).fill("Merged in the card");
			await resolve(a);
			await a.locator(".conflict-card").waitFor({ state: "detached" });
			await b.getByText("could not be read", { exact: false }).first().waitFor();
			expect(await b.locator(".conflict-card").count()).toBe(1);
			expect(await b.locator("#detail .read-body .ctitle").count()).toBe(0);
			// The pane says why nothing here can be typed into, and its button reads the case again. So does `e`.
			// A read that fails again changes nothing.
			expect(await b.locator("#detail").innerText()).not.toContain("being edited in another window");
			get.reads = "Refused the second time";
			await b.getByRole("button", { name: "Read the case again", exact: true }).click();
			await b.getByText("Refused the second time", { exact: false }).first().waitFor();
			expect(await b.locator(".conflict-card").count()).toBe(1);
			expect(await drafts(b)).toHaveLength(0);
			get.reads = "answered";
			await leaveField(b);
			await b.keyboard.press("e");
			await b.locator(".conflict-card").waitFor({ state: "detached" });
			expect(await b.locator("#detail .read-body .ctitle").innerText()).toBe("Merged in the card");
			await b.keyboard.press("e");
			expect(await title(b).inputValue()).toBe("Merged in the card");
			expect(await drafts(b)).toHaveLength(0);
		} finally {
			await h.close();
			await server.stop();
		}
	},
	30000,
);

check(
	"R6-1 a case left before the second tab could read it opens no editor until it is read",
	async () => {
		const server = await fixture();
		await cases(server, 2);
		const h = await openPage(server, { path: `/p/${server.project}/suite/c/1` });
		try {
			const a = h.page;
			const b = await follower(server, h);
			await conflict(server, a);
			await b.locator(".conflict-card").waitFor();
			const get = await unreadable(b);
			await a.getByRole("textbox", { name: "Merged title", exact: true }).fill("Merged in the card");
			await resolve(a);
			await a.locator(".conflict-card").waitFor({ state: "detached" });
			await b.getByText("could not be read", { exact: false }).first().waitFor();
			// The person selects another case and comes back. The removed draft and its card went with that, and
			// the case is shown as the page last read it.
			await b.getByRole("option", { name: /Case 2/ }).click();
			expect(await b.locator("#detail .read-body .ctitle").innerText()).toBe("Case 2");
			await b.getByRole("option", { name: /Merged in the card|Their title/ }).click();
			await b.locator("#detail .cid").filter({ hasText: "C-1" }).waitFor();
			// `e` reads the case first, and so does a click on the title. No editor opens on a read that is refused.
			get.reads = "Refused on return";
			await leaveField(b);
			await b.keyboard.press("e");
			expect(await editors(b)).toEqual([]);
			await b.getByText("Refused on return", { exact: false }).first().waitFor();
			get.reads = "Refused the click";
			await b.locator("#detail .read-body .ctitle").click();
			await b.getByText("Refused the click", { exact: false }).first().waitFor();
			expect(await editors(b)).toEqual([]);
			expect(await drafts(b)).toHaveLength(0);
			// Issue #135. While the read is on its way, a property changed in the read view and two presses of `e`
			// wait for that one read. It opens one editor, on the case as read. The property change is not made: the
			// person makes it again on the case as read (the issue's second limit, left as it is).
			get.reads = "held";
			get.asked = 0;
			await b.locator("#detail .case-properties summary").click();
			await b.getByRole("checkbox", { name: "Pipeline" }).click();
			await leaveField(b);
			await b.keyboard.press("e");
			await b.keyboard.press("e");
			await b.evaluate(() => undefined);
			expect(get.asked).toBe(1);
			get.release();
			await title(b).waitFor();
			expect(await editors(b)).toEqual(["Merged in the card"]);
			expect(await b.getByRole("checkbox", { name: "Pipeline" }).isChecked()).toBe(false);
			await title(b).press("Escape");
			await eventually(
				() => drafts(b),
				(rows) => rows.length === 0,
			);
		} finally {
			await h.close();
			await server.stop();
		}
	},
	30000,
);

check(
	"R6-1 a draft another window opens while the read waits keeps its line when the read comes back",
	async () => {
		const server = await fixture();
		await cases(server, 2);
		const h = await openPage(server, { path: `/p/${server.project}/suite/c/1` });
		try {
			const a = h.page;
			const b = await follower(server, h);
			await conflict(server, a);
			await b.locator(".conflict-card").waitFor();
			const get = await unreadable(b);
			await a.getByRole("textbox", { name: "Merged title", exact: true }).fill("Merged in the card");
			await resolve(a);
			await a.locator(".conflict-card").waitFor({ state: "detached" });
			await b.getByText("could not be read", { exact: false }).first().waitFor();
			await b.getByRole("option", { name: /Case 2/ }).click();
			await b.getByRole("option", { name: /Merged in the card|Their title/ }).click();
			await b.locator("#detail .cid").filter({ hasText: "C-1" }).waitFor();
			// Two presses of `e` wait on one read. Meanwhile the first window, which is live, opens a draft of the case.
			get.reads = "held";
			get.asked = 0;
			await leaveField(b);
			await b.keyboard.press("e");
			await b.keyboard.press("e");
			await eventually(
				async () => get.asked,
				(asked) => asked === 1,
			);
			await leaveField(a);
			await a.keyboard.press("e");
			await title(a).fill("Typed in the first window");
			const heldRead = b
				.waitForResponse(
					(response) => response.url().endsWith("/get") && Boolean(response.request().postData()?.includes('"C-1"')),
				)
				.then((response) => response.finished());
			get.release();
			// The second window shows that draft, and its line says whose it is, not that the case is as recorded.
			await eventually(
				() => title(b).inputValue(),
				(value) => value === "Typed in the first window",
			);
			await heldRead;
			await b.evaluate(
				() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
			);
			await b.locator("#stat").filter({ hasText: "being edited in another window" }).waitFor();
			const line = await b.locator("#stat").innerText();
			expect(line).not.toContain("as the server recorded it");
			expect(line).toContain("being edited in another window");
			expect(await title(b).evaluate((field) => field instanceof HTMLTextAreaElement && field.readOnly)).toBe(true);
		} finally {
			await h.close();
			await server.stop();
		}
	},
	30000,
);

check(
	"R6-1 a held conflict reply includes every character typed before it arrives",
	async () => {
		const server = await fixture();
		await cases(server);
		const h = await openPage(server, { path: `/p/${server.project}/suite/c/1` });
		const gate = latch();
		try {
			const { page } = h;
			await page.getByRole("button", { name: "Case 1", exact: true }).waitFor();
			await page.keyboard.press("e");
			await title(page).fill("My title");
			await server.api("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Their title" } }] });
			let replied = false;
			await page.route("**/propose", async (route) => {
				const response = await route.fetch();
				replied = true;
				await gate.held;
				await route.fulfill({ response });
			});
			await page.keyboard.press("Escape");
			await eventually(async () => replied, Boolean);
			await title(page).fill("My title completed while waiting");
			await step(page).fill("Apply the coupon SAVE10");
			gate.release();
			await page.locator(".conflict-card").waitFor();
			expect(await page.locator(".conflict-side").first().innerText()).toContain("My title completed while waiting");
			expect(await page.locator(".conflict-card .diff").innerText()).toContain("SAVE10");
			await page.getByRole("button", { name: "Use all my changes", exact: true }).click();
			await resolve(page);
			const saved = await eventually(
				() => server.api("get", { refs: ["C-1"] }),
				(rows) => rows[0]?.version === 3,
			);
			expect(saved[0]?.title).toBe("My title completed while waiting");
			expect(JSON.stringify(saved)).toContain("SAVE10");
		} finally {
			gate.release();
			await h.close();
			await server.stop();
		}
	},
	30000,
);

check(
	"R6-2 a merge meeting a newer head keeps the draft and opens the replacement card",
	async () => {
		const server = await fixture();
		await cases(server);
		const h = await openPage(server, { path: `/p/${server.project}/suite/c/1` });
		const gate = latch();
		try {
			const { page } = h;
			await conflict(server, page);
			const first = (await server.api("inbox", { on: "C-1", kind: "adopt" })).items[0];
			await server.api("propose", {
				edits: [{ op: "edit", case: "C-1", base: 2, body: { title: "Their title changed again" } }],
			});
			let answered = false;
			await page.route("**/decide", async (route) => {
				const response = await route.fetch();
				answered = true;
				await gate.held;
				await route.fulfill({ response });
			});
			await page.getByRole("textbox", { name: "Merged title", exact: true }).fill("My hand-written merge");
			await resolve(page);
			await eventually(async () => answered, Boolean);
			gate.release();
			await page.getByText("Their title changed again", { exact: true }).first().waitFor();
			await page.getByText("Nothing was adopted", { exact: false }).first().waitFor();
			expect(await title(page).inputValue()).toBe("My hand-written merge");
			expect((await drafts(page)).join(" ")).toContain("My hand-written merge");
			const next = (await server.api("inbox", { on: "C-1", kind: "adopt" })).items[0];
			expect(next?.q).not.toBe(first?.q);
			await page.getByRole("button", { name: "Use my title", exact: true }).click();
			await resolve(page);
			const saved = await eventually(
				() => server.api("get", { refs: ["C-1"] }),
				(rows) => rows[0]?.version === 4,
			);
			expect(saved[0]?.title).toBe("My hand-written merge");
			await page.locator(".conflict-card").waitFor({ state: "detached" });
			expect(await drafts(page)).toHaveLength(0);
			expect((await server.api("inbox", { on: "C-1", kind: "adopt" })).items).toHaveLength(0);
		} finally {
			gate.release();
			await h.close();
			await server.stop();
		}
	},
	30000,
);

for (const mode of ["reload", "new tab"])
	check(
		`R6-3 ${mode} restores the same conflict and its merged text without proposing again`,
		async () => {
			const server = await fixture();
			await cases(server);
			const h = await openPage(server, { path: `/p/${server.project}/suite/c/1` });
			try {
				let page = h.page;
				await conflict(server, page);
				const question = (await server.api("inbox", { on: "C-1", kind: "adopt" })).items[0];
				if (!question) throw Error("Missing conflict");
				await page.getByRole("textbox", { name: "Merged title", exact: true }).fill("Merge kept across windows");
				let sent = 0;
				await h.context.route("**/propose", async (route) => {
					sent++;
					await route.continue();
				});
				if (mode === "reload") await page.reload();
				else {
					page = await h.context.newPage();
					await page.goto(`${server.url}/p/${server.project}/suite/c/1`);
				}
				await title(page).waitFor();
				expect(await page.locator(".conflict-card").count()).toBe(1);
				expect(await page.getByRole("textbox", { name: "Merged title", exact: true }).inputValue()).toBe(
					"Merge kept across windows",
				);
				await title(page).click();
				await page.keyboard.type(" refused");
				expect(await title(page).inputValue()).toBe("My title");
				await page.keyboard.press("Escape");
				expect(sent).toBe(0);
				expect((await server.api("inbox", { on: "C-1", kind: "adopt" })).items.map((q) => q.q)).toEqual([question.q]);
				if (mode === "new tab") {
					expect(await page.getByRole("button", { name: "Resolve conflict", exact: true }).isDisabled()).toBe(true);
					await page.getByRole("button", { name: "Take over here", exact: true }).click();
				}
				await resolve(page);
				await page.locator(".conflict-card").waitFor({ state: "detached" });
				expect((await server.api("get", { refs: ["C-1"] }))[0]?.title).toBe("Merge kept across windows");
				expect((await server.api("inbox", { on: "C-1", kind: "adopt" })).items).toHaveLength(0);
			} finally {
				await h.close();
				await server.stop();
			}
		},
		30000,
	);

for (const answer of ["reject", "merge"] satisfies ("reject" | "merge")[])
	check(
		`R6-3 a stored conflict ${answer === "reject" ? "rejected" : "resolved"} elsewhere preserves hand-typed card text on return`,
		async () => {
			const server = await fixture();
			await cases(server);
			const h = await openPage(server, { path: `/p/${server.project}/suite/c/1` });
			try {
				const { page } = h;
				await conflict(server, page);
				const q = (await server.api("inbox", { on: "C-1", kind: "adopt" })).items[0];
				if (!q) throw Error("Missing conflict");
				await page.getByRole("textbox", { name: "Merged title", exact: true }).fill("Draft typed in the card");
				await page.close();
				const decision = await server.api("decide", {
					q: q.q,
					onEvidence: q.evidenceHash,
					answer: answer === "reject" ? { is: "reject" } : { is: "merge", body: emptyBody("Resolved elsewhere") },
				});
				expect(decision[0]?.status).toBe("decided");
				const returned = await h.context.newPage();
				await returned.goto(`${server.url}/p/${server.project}/suite/c/1`);
				await title(returned).waitFor();
				await returned.locator(".conflict-card").waitFor({ state: "detached" });
				// Either way the text was written against the version from before the answer, and is proposed on it:
				// it is not "later text" on the version somebody else's merge made (issue #81).
				await returned.getByText("typed merge is kept", { exact: false }).first().waitFor();
				expect(await title(returned).inputValue()).toBe("Draft typed in the card");
				await title(returned).press("End");
				await returned.keyboard.type(" still editable");
				expect(await title(returned).inputValue()).toBe("Draft typed in the card still editable");
			} finally {
				await h.close();
				await server.stop();
			}
		},
		30000,
	);

check(
	"R6-4 a step mark visible at Enter is sent behind a slow earlier pass",
	async () => {
		const server = await fixture({ preset: "standard" });
		await cases(server, 3);
		const run = await server.api("plan", { name: "Marked correction", select: {} });
		const h = await openPage(server, { path: `/p/${server.project}/runs/${run.run.slice(2)}` });
		const gate = latch();
		try {
			const { page } = h;
			await page.locator('[data-active="true"][data-ready="true"]').waitFor();
			const requests: unknown[] = [];
			await page.route("**/report", async (route) => {
				requests.push(route.request().postDataJSON());
				if (requests.length === 1) await gate.held;
				await route.continue();
			});
			await page.keyboard.press("2");
			await page.keyboard.press("p");
			await eventually(
				async () => requests.length,
				(n) => n === 1,
			);
			await page.keyboard.press("k");
			await page.keyboard.press("f");
			await page.keyboard.type("meant to fail at two");
			expect(await page.locator(".run-control-hint").innerText()).toContain("Step 2 marked.");
			await page.keyboard.press("Enter");
			gate.release();
			await eventually(
				async () => requests.length,
				(n) => n === 2,
			);
			const sent = z
				.object({ results: z.array(z.object({ note: z.string(), steps: z.array(z.object({ step: z.string() })) })) })
				.parse(requests[1]);
			expect(sent.results[0]?.note).toBe("meant to fail at two");
			expect(sent.results[0]?.steps[0]?.step).toBe("s2");
			const saved = await eventually(
				() => server.api("timeline", { ref: "C-1" }),
				(row) => row.entries.some((e) => e.t === "result" && e.outcome === "fail"),
			);
			expect(saved.entries.find((e) => e.t === "result" && e.outcome === "fail")?.atStep).toBe("s2");
		} finally {
			gate.release();
			await h.close();
			await server.stop();
		}
	},
	30000,
);

check(
	"R5B-1 a lost note request reconciles its note before the queued shortcut",
	async () => {
		const server = await startServer({ preset: "standard" });
		await cases(server, 3);
		const run = await server.api("plan", { name: "Release note", select: {} });
		const h = await openPage(server, { path: `/p/${server.project}/runs/${run.run.slice(2)}` });
		const first = latch();
		const second = latch();
		try {
			const { page } = h;
			await page.locator('[data-active="true"][data-ready="true"]').waitFor();
			const requests: z.infer<typeof ReportInput>[] = [];
			await page.route("**/report", async (route) => {
				requests.push(ReportInput.parse(route.request().postDataJSON()));
				if (requests.length === 1) {
					await first.held;
					await route.abort("failed");
				} else {
					if (requests.length === 2) await second.held;
					await route.continue();
				}
			});
			await page.keyboard.press("f");
			await page.keyboard.type("wrong total");
			await page.keyboard.press("Enter");
			await eventually(
				async () => requests.length,
				(n) => n === 1,
			);
			await page.keyboard.press("k");
			await page.keyboard.press("p");
			first.release();
			await eventually(
				async () => requests.length,
				(n) => n === 2,
			);
			await page.keyboard.press("k");
			expect(await page.getByRole("textbox", { name: "Result note" }).inputValue()).toBe("wrong total");
			await page.keyboard.press("p");
			second.release();
			await eventually(
				async () => requests.length,
				(n) => n === 3,
			);
			await eventually(
				() => page.locator("#stat").innerText(),
				(text) => text.includes("C-1 pass recorded"),
			);
			expect(requests.map((request) => request.results[0])).toEqual([
				{ test: { case: "C-1" }, outcome: "fail", note: "wrong total" },
				{ test: { case: "C-1" }, outcome: "fail", note: "wrong total" },
				{ test: { case: "C-1" }, outcome: "pass", corrects: 1 },
			]);
			const commands = requests.map((request) => request.cmd);
			expect(commands[0]).toBeTypeOf("string");
			expect(commands[1]).toBe(commands[0]);
			expect(commands[2]).toBeTypeOf("string");
			expect(commands[2]).not.toBe(commands[0]);
			const timeline = await server.api("timeline", { ref: "C-1" });
			expect(
				timeline.entries
					.filter((entry) => entry.t === "result")
					.reverse()
					.map(({ outcome, note, corrects }) => ({ outcome, note, corrects })),
			).toEqual([
				{ outcome: "fail", note: "wrong total", corrects: null },
				{ outcome: "pass", note: null, corrects: 1 },
			]);
			const slots = Slot.array().parse((await server.api("find", { in: "slots", run: run.run })).items);
			expect(slots[0]).toMatchObject({ case: "C-1", fills: [{ outcome: "pass", note: null }] });
		} finally {
			first.release();
			second.release();
			await h.close();
			await server.stop();
		}
	},
	30000,
);

check(
	"R6-1 a pending merge visibly refuses changes to its card until the reply arrives",
	async () => {
		const server = await fixture();
		await cases(server);
		const h = await openPage(server, { path: `/p/${server.project}/suite/c/1` });
		const gate = latch();
		try {
			const { page } = h;
			await conflict(server, page);
			await page.getByRole("button", { name: "Use my title", exact: true }).click();
			let sent = false;
			await page.route("**/decide", async (route) => {
				sent = true;
				await gate.held;
				await route.continue();
			});
			await resolve(page);
			await eventually(async () => sent, Boolean);
			const merged = page.getByRole("textbox", { name: "Merged title", exact: true });
			await merged.click();
			await merged.press("End");
			await page.keyboard.type(" typed during merge");
			expect(await merged.inputValue()).toBe("My title");
			await page.getByText("Wait for the merge reply", { exact: false }).first().waitFor();
			expect(await merged.evaluate((element) => document.activeElement === element)).toBe(true);
			gate.release();
			await page.locator(".conflict-card").waitFor({ state: "detached" });
			expect((await server.api("get", { refs: ["C-1"] }))[0]?.title).toBe("My title");
		} finally {
			gate.release();
			await h.close();
			await server.stop();
		}
	},
	30000,
);

check(
	"R6-2 a failed merge request keeps the draft and card for retry",
	async () => {
		const server = await fixture();
		await cases(server);
		const h = await openPage(server, { path: `/p/${server.project}/suite/c/1` });
		const gate = latch();
		try {
			const { page } = h;
			await conflict(server, page);
			await page.getByRole("textbox", { name: "Merged title", exact: true }).fill("Merge to retry");
			let sent = false;
			await page.route("**/decide", async (route) => {
				sent = true;
				await gate.held;
				await route.abort("failed");
			});
			await resolve(page);
			await eventually(async () => sent, Boolean);
			gate.release();
			await page.getByText("Your draft and conflict card are kept", { exact: false }).first().waitFor();
			const merged = page.getByRole("textbox", { name: "Merged title", exact: true });
			await merged.press("End");
			await page.keyboard.type(" after failure");
			await eventually(
				() => drafts(page),
				(rows) => rows.some((text) => text.includes("Merge to retry after failure")),
			);
			expect(await page.locator(".conflict-card").count()).toBe(1);
			expect(await page.getByRole("textbox", { name: "Merged title", exact: true }).inputValue()).toBe(
				"Merge to retry after failure",
			);
			expect((await drafts(page)).join(" ")).toContain("Merge to retry after failure");
		} finally {
			gate.release();
			await h.close();
			await server.stop();
		}
	},
	30000,
);

check(
	"R6-3 a replacement tab resolves a stored card without touching the editor or leaving a draft",
	async () => {
		const server = await fixture();
		await cases(server);
		const h = await openPage(server, { path: `/p/${server.project}/suite/c/1` });
		try {
			const first = h.page;
			await conflict(server, first);
			await first.getByRole("button", { name: "Use my title", exact: true }).click();
			await first.close();
			const page = await h.context.newPage();
			await page.goto(`${server.url}/p/${server.project}/suite/c/1`);
			await page.locator(".conflict-card").waitFor();
			await resolve(page);
			await page.locator(".conflict-card").waitFor({ state: "detached" });
			expect(await drafts(page)).toHaveLength(0);
			expect((await server.api("inbox", { on: "C-1", kind: "adopt" })).items).toHaveLength(0);
		} finally {
			await h.close();
			await server.stop();
		}
	},
	30000,
);
