// One live window owns a case's draft: the eighth review's first finding (R8-1).
import { expect, test } from "bun:test";
import type { Page } from "playwright-core";
import { z } from "zod";
import { browserAvailable, eventually, openPage, startServer } from "./support.ts";

const check = test.skipIf(!browserAvailable);
const title = (page: Page) => page.getByRole("textbox", { name: "Case title", exact: true });
const step = (page: Page) => page.getByRole("textbox", { name: "Step 2", exact: true });
const card = (page: Page) => page.locator(".conflict-card");
const takeover = (page: Page) => page.getByRole("button", { name: "Take over here", exact: true }).click();
const readOnly = (page: Page) => title(page).evaluate((el) => el instanceof HTMLTextAreaElement && el.readOnly);
const refused = (page: Page) =>
	page.locator("#bar").filter({ hasText: "This case is being edited in another window" }).waitFor();
const Stored = z.object({
	owner: z.string(),
	cmd: z.string(),
	body: z.object({ title: z.string(), steps: z.array(z.object({ action: z.string() })) }),
});
async function stored(page: Page) {
	return Stored.parse(
		await page.evaluate(() => {
			const key = Object.keys(localStorage).find((key) => key.includes(":draft:") && key.endsWith(":C-1"));
			return key ? JSON.parse(localStorage.getItem(key) ?? "null") : null;
		}),
	);
}
async function windows() {
	const server = await startServer();
	await server.api("propose", {
		edits: [{ op: "create", outline: "Coupon case\n  Open the cart\n  Apply the coupon" }],
	});
	const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
	const a = h.page;
	const b = await h.context.newPage();
	for (const page of [a, b]) page.setDefaultTimeout(5000);
	await b.goto(`${server.url}/p/scratch/suite/c/1`);
	for (const page of [a, b]) await page.getByRole("button", { name: "Coupon case", exact: true }).waitFor();
	return {
		server,
		h,
		a,
		b,
		close: async () => {
			await h.close();
			await server.stop();
		},
	};
}

check(
	"R8 ownership: opening, refusing a key, taking over and leaving the former owner",
	async () => {
		const w = await windows();
		try {
			const { a, b, server } = w;
			await a.keyboard.press("e");
			await title(a).fill("Coupon case mine");
			await step(a).fill("Apply the coupon typed in A");
			await b.keyboard.press("e");
			expect(await readOnly(b)).toBe(true);
			await step(b).click();
			await b.keyboard.type(" REFUSED");
			await refused(b);
			expect(await step(b).inputValue()).toBe("Apply the coupon typed in A");
			const first = await stored(a);
			await takeover(b);
			await eventually(() => readOnly(a), Boolean);
			await refused(a);
			expect(await step(b).inputValue()).toBe("Apply the coupon typed in A");
			expect((await stored(b)).owner).not.toBe(first.owner);
			expect((await stored(b)).cmd).not.toBe(first.cmd);
			let sent = 0;
			await a.route("**/propose", async (route) => {
				sent++;
				await route.continue();
			});
			await a.keyboard.press("Escape");
			expect(sent).toBe(0);
			await step(b).fill("Apply the coupon typed in A and B");
			await b.keyboard.press("Escape");
			const saved = await eventually(
				() => server.api("get", { refs: ["C-1"] }),
				(rows) => rows[0]?.version === 2,
			);
			expect(JSON.stringify(saved)).toContain("typed in A and B");
			expect(JSON.stringify(saved)).not.toContain("REFUSED");
		} finally {
			await w.close();
		}
	},
	30000,
);

for (const order of ["B types before A leaves", "A leaves before B types"])
	check(
		`R8-1 ${order}: the second window's key is visibly refused while the proposal reply is held`,
		async () => {
			const w = await windows();
			let release = () => {};
			const held = new Promise<void>((done) => {
				release = done;
			});
			try {
				const { a, b, server } = w;
				await a.keyboard.press("e");
				await title(a).fill("Coupon case mine");
				await b.keyboard.press("e");
				await server.api("propose", {
					edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Coupon case theirs" } }],
				});
				let received = false;
				await a.route("**/propose", async (route) => {
					const response = await route.fetch();
					received = true;
					await held;
					await route.fulfill({ response });
				});
				if (order.startsWith("A")) {
					await a.keyboard.press("Escape");
					await eventually(async () => received, Boolean);
				}
				expect(await readOnly(b)).toBe(true);
				await step(b).click();
				await b.keyboard.type(" typed in B");
				await refused(b);
				expect(await step(b).inputValue()).toBe("Apply the coupon");
				if (order.startsWith("B")) {
					await a.keyboard.press("Escape");
					await eventually(async () => received, Boolean);
				}
				release();
				await card(a).waitFor();
				await card(b).waitFor();
				expect(await b.getByRole("button", { name: "Resolve conflict", exact: true }).isDisabled()).toBe(true);
				await a.getByRole("button", { name: "Use all my changes", exact: true }).click();
				await a.getByRole("button", { name: "Resolve conflict", exact: true }).click();
				await card(b).waitFor({ state: "detached" });
				expect(JSON.stringify(await server.api("get", { refs: ["C-1"] }))).not.toContain("typed in B");
			} finally {
				release();
				await w.close();
			}
		},
		30000,
	);

check(
	"R8 simultaneous keys and sequential takeovers keep one owner and every accepted character",
	async () => {
		const w = await windows();
		try {
			const { a, b } = w;
			await a.keyboard.press("e");
			await title(a).fill("Coupon case mine");
			await b.keyboard.press("e");
			await Promise.all([title(a).press("End"), title(b).press("End")]);
			await Promise.all([a.keyboard.type(" A"), b.keyboard.type(" B")]);
			await refused(b);
			expect((await stored(a)).body.title).toBe("Coupon case mine A");
			await takeover(b);
			await eventually(() => readOnly(a), Boolean);
			await title(b).press("End");
			await b.keyboard.type(" B");
			await takeover(a);
			await eventually(() => readOnly(b), Boolean);
			expect((await stored(a)).owner).toBe(
				z.string().parse(await a.evaluate(() => sessionStorage.getItem("mainworthy:draft-window"))),
			);
			expect(await title(a).inputValue()).toBe("Coupon case mine A B");
			expect(await title(b).inputValue()).toBe("Coupon case mine A B");
		} finally {
			await w.close();
		}
	},
	30000,
);

check(
	"R8 a closed owner's mid-sentence draft is claimed on opening the editor",
	async () => {
		const w = await windows();
		try {
			const { a, b } = w;
			await a.route("**/propose", (route) => route.abort("failed"));
			await a.keyboard.press("e");
			await title(a).fill("Coupon case mid-sent");
			await a.close();
			await b.keyboard.press("e");
			expect(await readOnly(b)).toBe(false);
			expect(await title(b).inputValue()).toBe("Coupon case mid-sent");
			await title(b).press("End");
			await b.keyboard.type("ence");
			expect((await stored(b)).body.title).toBe("Coupon case mid-sentence");
		} finally {
			await w.close();
		}
	},
	30000,
);

check(
	"R8 conflict card follows the owner and refuses keys and resolution until takeover",
	async () => {
		const w = await windows();
		try {
			const { a, b, server } = w;
			await a.keyboard.press("e");
			await title(a).fill("Coupon case mine");
			await server.api("propose", {
				edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Coupon case theirs" } }],
			});
			await a.keyboard.press("Escape");
			await card(a).waitFor();
			await b.keyboard.press("e");
			await card(b).waitFor();
			const merged = (page: Page) => page.getByRole("textbox", { name: "Merged title", exact: true });
			expect(await merged(b).evaluate((el) => el instanceof HTMLTextAreaElement && el.readOnly)).toBe(true);
			await merged(b).click();
			await b.keyboard.type(" REFUSED");
			await refused(b);
			expect(await b.getByRole("button", { name: "Resolve conflict", exact: true }).isDisabled()).toBe(true);
			await takeover(b);
			await eventually(() => a.getByRole("button", { name: "Resolve conflict", exact: true }).isDisabled(), Boolean);
			await merged(b).fill("Merged by the new owner");
			await eventually(
				() => merged(a).inputValue(),
				(value) => value === "Merged by the new owner",
			);
			await b.getByRole("button", { name: "Resolve conflict", exact: true }).click();
			await card(a).waitFor({ state: "detached" });
			expect((await server.api("get", { refs: ["C-1"] }))[0]?.title).toBe("Merged by the new owner");
		} finally {
			await w.close();
		}
	},
	30000,
);

check(
	"R8 a stored takeover before its event guards input and seal at execution time",
	async () => {
		const w = await windows();
		try {
			const { a, b } = w;
			await a.keyboard.press("e");
			await title(a).fill("Coupon case kept");
			const bOwner = await b.evaluate(() => sessionStorage.getItem("mainworthy:draft-window"));
			await title(a).click();
			await a.evaluate((owner) => {
				const key = Object.keys(localStorage).find((key) => key.includes(":draft:") && key.endsWith(":C-1"));
				if (!key) throw Error("Missing draft");
				const draft = JSON.parse(localStorage.getItem(key) ?? "{}");
				draft.owner = owner;
				localStorage.setItem(key, JSON.stringify(draft));
			}, bOwner);
			await a.keyboard.insertText(" REFUSED BEFORE EVENT");
			await refused(a);
			expect(await title(a).inputValue()).toBe("Coupon case kept");
			expect((await stored(a)).body.title).toBe("Coupon case kept");
			let sent = 0;
			await a.route("**/propose", async (route) => {
				sent++;
				await route.continue();
			});
			await a.keyboard.press("Escape");
			expect(sent).toBe(0);
			expect(await readOnly(a)).toBe(true);
		} finally {
			await w.close();
		}
	},
	30000,
);

check(
	"R8 a late conflict reply cannot write over a draft taken over during the request",
	async () => {
		const w = await windows();
		let release = () => {};
		const held = new Promise<void>((done) => {
			release = done;
		});
		try {
			const { a, b, server } = w;
			await a.keyboard.press("e");
			await title(a).fill("Coupon case mine");
			await server.api("propose", {
				edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Coupon case theirs" } }],
			});
			let received = false;
			await a.route("**/propose", async (route) => {
				const response = await route.fetch();
				received = true;
				await held;
				await route.fulfill({ response });
			});
			await a.keyboard.press("Escape");
			await eventually(async () => received, Boolean);
			await b.keyboard.press("e");
			await takeover(b);
			await step(b).fill("Apply the coupon accepted in B");
			const before = await stored(b);
			release();
			await refused(a);
			expect(await stored(b)).toEqual(before);
			expect(await step(b).inputValue()).toBe("Apply the coupon accepted in B");
			await b.keyboard.press("Escape");
			await card(b).waitFor();
			expect(await step(b).inputValue()).toBe("Apply the coupon accepted in B");
			await b.getByRole("button", { name: "Use all my changes", exact: true }).click();
			await b.getByRole("button", { name: "Resolve conflict", exact: true }).click();
			await card(b).waitFor({ state: "detached" });
			expect(JSON.stringify(await server.api("get", { refs: ["C-1"] }))).toContain("accepted in B");
		} finally {
			release();
			await w.close();
		}
	},
	30000,
);

check(
	"R8 both clean editors racing their first key preserve the winning draft and visibly refuse the other",
	async () => {
		const w = await windows();
		try {
			const { a, b } = w;
			await a.keyboard.press("e");
			await b.keyboard.press("e");
			expect(await readOnly(a)).toBe(false);
			expect(await readOnly(b)).toBe(false);
			await Promise.all([title(a).press("End"), title(b).press("End")]);
			await Promise.all([a.keyboard.type("A"), b.keyboard.type("B")]);
			// Each window writes the draft when it has not yet seen the other's write, so both can write more than
			// once before the storage events arrive, and the last write wins. Who won is known only when every
			// event has landed: the window that does not own the stored draft shows the refusal and is read-only.
			const aId = await a.evaluate(() => sessionStorage.getItem("mainworthy:draft-window"));
			const settle = async () => {
				const draft = await stored(a);
				const winner = draft.owner === aId ? a : b;
				const other = winner === a ? b : a;
				const refusing =
					(await other.locator("#bar").filter({ hasText: "being edited in another window" }).count()) > 0;
				return { draft, winner, other, done: refusing && (await readOnly(other)) && !(await readOnly(winner)) };
			};
			const { draft, winner, other } = await eventually(settle, (state) => state.done);
			await refused(other);
			expect(await readOnly(winner)).toBe(false);
			expect(await readOnly(other)).toBe(true);
			expect(draft.body.title).toBe(`Coupon case${winner === a ? "A" : "B"}`);
			expect(await title(other).inputValue()).toBe(draft.body.title);
			// Nothing moves after that: the draft is still the winner's.
			await Promise.all([a, b].map((page) => page.evaluate(() => new Promise((done) => setTimeout(done, 300)))));
			expect((await stored(a)).owner).toBe(draft.owner);
			expect(await readOnly(winner)).toBe(false);
		} finally {
			await w.close();
		}
	},
	30000,
);

check(
	"R8 a takeover stored before its event guards a conflict-card change and merge",
	async () => {
		const w = await windows();
		try {
			const { a, b, server } = w;
			await a.keyboard.press("e");
			await title(a).fill("Coupon case mine");
			await server.api("propose", {
				edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Coupon case theirs" } }],
			});
			await a.keyboard.press("Escape");
			await card(a).waitFor();
			const merged = a.getByRole("textbox", { name: "Merged title", exact: true });
			await merged.fill("Owner's merged choice");
			const bId = await b.evaluate(() => sessionStorage.getItem("mainworthy:draft-window"));
			await merged.click();
			await a.evaluate((owner) => {
				const key = Object.keys(localStorage).find((key) => key.includes(":draft:") && key.endsWith(":C-1"));
				if (!key) throw Error("Missing draft");
				const draft = JSON.parse(localStorage.getItem(key) ?? "{}");
				draft.owner = owner;
				localStorage.setItem(key, JSON.stringify(draft));
			}, bId);
			await a.keyboard.insertText(" REFUSED BEFORE EVENT");
			await refused(a);
			expect(await merged.inputValue()).toBe("Owner's merged choice");
			expect(await a.getByRole("button", { name: "Resolve conflict", exact: true }).isDisabled()).toBe(true);
			expect((await server.api("get", { refs: ["C-1"] }))[0]?.version).toBe(2);
		} finally {
			await w.close();
		}
	},
	30000,
);

check(
	"R8 an empty merged step remains owned until a deliberate takeover",
	async () => {
		const w = await windows();
		try {
			const { a, b, server } = w;
			await a.keyboard.press("e");
			await title(a).fill("Coupon case mine");
			await step(a).fill("Apply coupon mine");
			const steps = z
				.array(z.object({ id: z.string(), action: z.string(), expected: z.string().nullable() }))
				.parse((await server.api("get", { refs: ["C-1"] }))[0]?.steps);
			await server.api("propose", {
				edits: [
					{
						op: "edit",
						case: "C-1",
						base: 1,
						body: {
							title: "Coupon case theirs",
							steps: steps.map((step, index) => (index === 1 ? { ...step, action: "Apply coupon theirs" } : step)),
						},
					},
				],
			});
			await a.keyboard.press("Escape");
			await card(a).waitFor();
			await b.keyboard.press("e");
			await card(b).waitFor();
			const mergedStep = (page: Page) => card(page).locator('textarea[aria-label^="Merged steps."]').last();
			await mergedStep(a).fill("");
			await takeover(b);
			expect(await mergedStep(b).inputValue()).toBe("");
			await mergedStep(b).fill("Typed after emptying the step");
			await eventually(() => readOnly(a), Boolean);
			await b.getByRole("button", { name: "Resolve conflict", exact: true }).click();
			await card(b).waitFor({ state: "detached" });
			expect(JSON.stringify(await server.api("get", { refs: ["C-1"] }))).toContain("Typed after emptying the step");
		} finally {
			await w.close();
		}
	},
	30000,
);
