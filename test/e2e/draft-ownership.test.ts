// One live window owns a case's draft: the eighth review's first finding (R8-1).
import { expect, test } from "bun:test";
import type { Page } from "playwright-core";
import { z } from "zod";
import { browserAvailable, eventually, fetched, openPage, startServer } from "./support.ts";

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
	"ordinary takeovers and later edits leave no preserved copies",
	async () => {
		const w = await windows();
		try {
			const { a, b, server } = w;
			await a.keyboard.press("e");
			await title(a).fill("Coupon case ordinary A");
			await b.keyboard.press("e");
			await takeover(b);
			await eventually(() => readOnly(a), Boolean);
			await title(b).fill("Coupon case ordinary A and B");
			await takeover(a);
			await eventually(() => readOnly(b), Boolean);
			await title(a).fill("Coupon case ordinary A and B and A again");
			for (const page of [a, b]) expect(await page.locator(".preserved-draft").count()).toBe(0);
			await a.keyboard.press("Escape");
			await eventually(
				() => server.api("get", { refs: ["C-1"] }),
				(rows) => rows[0]?.version === 2,
			);
			for (const page of [a, b]) {
				await page.reload();
				await page.locator("#detail .ctitle").filter({ hasText: "Coupon case ordinary A and B and A again" }).waitFor();
				expect(await page.locator(".preserved-draft").count()).toBe(0);
			}
			expect(
				await a.evaluate(() => Object.keys(localStorage).filter((key) => key.includes(":draft-copy:")).length),
			).toBe(0);
		} finally {
			await w.close();
		}
	},
	30000,
);

check(
	"confirmed ownership adds no copy reads or writes per keystroke",
	async () => {
		const w = await windows();
		try {
			const { a, b } = w;
			await b.close();
			await a.keyboard.press("e");
			await title(a).fill("Coupon case warm");
			await a.waitForTimeout(50);
			await title(a).press("End");
			await a.evaluate(() => {
				for (let index = 0; index < 100; index++) localStorage.setItem(`unrelated:${index}`, "other data");
				const counts = { reads: 0, writes: 0, keys: 0, copyReads: 0, copyWrites: 0 };
				const get = Storage.prototype.getItem;
				const set = Storage.prototype.setItem;
				const keyAt = Storage.prototype.key;
				Storage.prototype.getItem = function (key) {
					if (this === localStorage) {
						counts.reads++;
						if (key.includes(":draft-copy:")) counts.copyReads++;
					}
					return get.call(this, key);
				};
				Storage.prototype.setItem = function (key, value) {
					if (this === localStorage) {
						counts.writes++;
						if (key.includes(":draft-copy:")) counts.copyWrites++;
					}
					set.call(this, key, value);
				};
				Storage.prototype.key = function (index) {
					if (this === localStorage) counts.keys++;
					return keyAt.call(this, index);
				};
				Object.assign(window, { draftStorageCounts: counts });
			});
			await a.keyboard.type("0123456789", { delay: 10 });
			expect(await title(a).inputValue()).toBe("Coupon case warm0123456789");
			const counts = z
				.object({
					reads: z.number(),
					writes: z.number(),
					keys: z.number(),
					copyReads: z.number(),
					copyWrites: z.number(),
				})
				.parse(await a.evaluate(() => Reflect.get(window, "draftStorageCounts")));
			console.log(`Draft storage operations for 10 accepted keys: ${JSON.stringify(counts)}`);
			expect((await stored(a)).body.title).toBe("Coupon case warm0123456789");
			expect(counts.copyWrites).toBe(0);
			expect(counts.copyReads).toBe(0);
			expect(counts.keys).toBe(0);
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

// The reviews of the change for issue #79 (F1 to F3). A window that comes to a case takes no draft by itself: an
// owner that does not answer may be busy, and hold text the device could not store. Here A owns a conflicted
// draft, holds text its storage refused (its storage refuses every write, as a full one does), and answers other
// windows late. B comes to the case from another one: it takes nothing, says that the owner is not answering, and
// A keeps its text and can still type.
check(
	"a window that answers late keeps its draft when another window comes to the case",
	async () => {
		const server = await startServer();
		await server.api("propose", {
			edits: [
				{ op: "create", outline: "Coupon case\n  Open the cart\n  Apply the coupon" },
				{ op: "create", outline: "Other case\n  A step" },
			],
		});
		const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
		try {
			const a = h.page;
			a.setDefaultTimeout(5000);
			await a.getByRole("button", { name: "Coupon case", exact: true }).waitFor();
			await a.keyboard.press("e");
			await title(a).fill("Coupon case mine");
			await server.api("propose", {
				edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Coupon case theirs" } }],
			});
			await a.keyboard.press("Escape");
			await card(a).waitFor();
			const merged = a.getByRole("textbox", { name: "Merged title", exact: true });
			await merged.fill("Stored merge");
			const owner = (await stored(a)).owner;
			await a.evaluate(() => {
				Storage.prototype.setItem = () => {
					throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
				};
				const post = BroadcastChannel.prototype.postMessage;
				BroadcastChannel.prototype.postMessage = function (message: unknown) {
					if ((message as { kind?: string }).kind === "present") setTimeout(() => post.call(this, message), 60_000);
					else post.call(this, message);
				};
			});
			await merged.fill("Typed where nothing could store it");
			await a.getByText("Device storage is full", { exact: false }).first().waitFor();
			const b = await h.context.newPage();
			b.setDefaultTimeout(5000);
			await b.goto(`${server.url}/p/scratch/suite/c/2`);
			await b.getByRole("button", { name: "Other case", exact: true }).waitFor();
			await b.locator('[data-testid="case-list"] [role="option"]').filter({ hasText: "C-1" }).click();
			await b.locator("#detail .cid").filter({ hasText: "C-1" }).waitFor();
			expect((await stored(b)).owner).toBe(owner);
			await b.getByRole("button", { name: "Take over here", exact: true }).waitFor();
			expect(await merged.inputValue()).toBe("Typed where nothing could store it");
			expect(await merged.evaluate((el) => el instanceof HTMLTextAreaElement && el.readOnly)).toBe(false);
			// A is open, so its lock says it is live however late it answers: B says so, and offers the take-over.
			expect(await b.locator("#detail").innerText()).toContain("This case is being edited in another window");
		} finally {
			await h.close();
			await server.stop();
		}
	},
	30000,
);

// Review round 9, R9-3. A window that only shows the case has no card on its screen. Taking the draft over there
// opens it, so the conflict the window now owns is where its status line says to resolve it.
check(
	"R9-3 taking over from a window that only shows the case puts the conflict card on its screen",
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
			expect(await card(b).count()).toBe(0);
			await takeover(b);
			const merged = b.getByRole("textbox", { name: "Merged title", exact: true });
			await merged.fill("Merged by the new owner");
			await eventually(() => a.getByRole("button", { name: "Resolve conflict", exact: true }).isDisabled(), Boolean);
			await b.getByRole("button", { name: "Resolve conflict", exact: true }).click();
			await card(b).waitFor({ state: "detached" });
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
		let reconcile = () => {};
		const reconciliation = new Promise<void>((done) => {
			reconcile = done;
		});
		try {
			const { a, b, server } = w;
			await b.route("**/command", async (route) => {
				await reconciliation;
				await route.continue();
			});
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
			reconcile();
			await card(b).waitFor();
			expect(await step(b).inputValue()).toBe("Apply the coupon accepted in B");
			await b.getByRole("button", { name: "Use all my changes", exact: true }).click();
			await b.getByRole("button", { name: "Resolve conflict", exact: true }).click();
			await card(b).waitFor({ state: "detached" });
			expect(JSON.stringify(await server.api("get", { refs: ["C-1"] }))).toContain("accepted in B");
		} finally {
			release();
			reconcile();
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

for (const beforeEvent of [false, true])
	check(
		`simultaneous first writes keep accepted text ${beforeEvent ? "when closed before the storage event" : "after reload and close"}`,
		async () => {
			const w = await windows();
			const debuggerSession = await w.h.context.newCDPSession(w.b);
			try {
				const { a, b, h, server } = w;
				if (beforeEvent) {
					await a.addInitScript(() => window.addEventListener("storage", (event) => event.stopImmediatePropagation()));
					await a.reload();
					await a.getByRole("button", { name: "Coupon case", exact: true }).waitFor();
				}
				await a.keyboard.press("e");
				await b.keyboard.press("e");
				await debuggerSession.send("Debugger.enable");
				await b.evaluate(() => {
					const set = Storage.prototype.setItem;
					Storage.prototype.setItem = function (key, value) {
						if (key.includes(":draft:") && key.endsWith(":C-1")) {
							Storage.prototype.setItem = set;
							// biome-ignore lint/suspicious/noDebugger: stop exactly between the ownership read and shared write.
							debugger;
						}
						set.call(this, key, value);
					};
				});
				const paused = new Promise<void>((resolve) => debuggerSession.once("Debugger.paused", () => resolve()));
				const typing = title(b).fill("Coupon case B");
				await paused;
				const accepted = "Coupon case A complete sentence accepted before B writes";
				await title(a).fill(accepted);
				expect((await stored(a)).body.title).toBe(accepted);
				await debuggerSession.send("Debugger.resume");
				await typing;
				const preserved = (page: Page) => page.getByRole("textbox", { name: "Preserved draft text", exact: true });
				if (beforeEvent) {
					expect(await title(a).inputValue()).toBe(accepted);
					await a.close();
					const c = await h.context.newPage();
					await c.goto(`${server.url}/p/scratch/suite/c/1`);
					await preserved(c).waitFor();
					expect(await preserved(c).inputValue()).toContain(accepted);
					expect((await stored(c)).body.title).toBe("Coupon case B");
					return;
				}
				await refused(a);
				expect(await readOnly(a)).toBe(true);
				expect((await stored(a)).body.title).toBe("Coupon case B");
				await preserved(a).waitFor();
				expect(await preserved(a).inputValue()).toContain(accepted);
				await a.reload();
				await preserved(a).waitFor();
				expect(await preserved(a).inputValue()).toContain(accepted);
				await a.close();
				const c = await h.context.newPage();
				await c.goto(`${server.url}/p/scratch/suite/c/1`);
				await preserved(c).waitFor();
				expect(await preserved(c).inputValue()).toContain(accepted);
				expect((await stored(c)).body.title).toBe("Coupon case B");
				expect((await server.api("get", { refs: ["C-1"] }))[0]?.version).toBe(1);
				await takeover(c);
				await title(c).fill(accepted);
				await c.keyboard.press("Escape");
				await eventually(
					() => server.api("get", { refs: ["C-1"] }),
					(rows) => rows[0]?.title === accepted,
				);
				await preserved(c).waitFor({ state: "detached" });
				expect(await c.locator(".preserved-draft").count()).toBe(0);
			} finally {
				await debuggerSession.send("Debugger.disable").catch(() => {});
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

for (const fate of ["recorded", "in flight", "lost reconciliation reply"]) {
	check(
		`takeover reconciles a new case's first save: ${fate}`,
		async () => {
			const server = await startServer();
			const h = await openPage(server, { path: "/p/scratch/suite" });
			let release = () => {};
			const held = new Promise<void>((resolve) => {
				release = resolve;
			});
			try {
				const a = h.page;
				a.setDefaultTimeout(5000);
				await a.locator("#list").waitFor();
				const requests: { cmd: string; edits: unknown[] }[] = [];
				let originalReady = false;
				let originalReturned = false;
				await a.route("**/propose", async (route) => {
					requests.push(
						z.object({ cmd: z.string(), edits: z.array(z.unknown()) }).parse(route.request().postDataJSON()),
					);
					const recorded = fate === "recorded" ? await fetched(route) : null;
					originalReady = true;
					await held;
					const response = recorded ?? (await fetched(route));
					if (response) await route.fulfill({ response: response.response });
					else await route.abort();
					originalReturned = true;
				});
				await a.keyboard.press("c");
				await title(a).fill("First phrase");
				await a.keyboard.press("Escape");
				await eventually(async () => originalReady, Boolean);
				await title(a).fill("First phrase with the rest");

				const b = await h.context.newPage();
				b.setDefaultTimeout(5000);
				let asked = 0;
				await b.route("**/command", async (route) => {
					asked++;
					if (fate === "lost reconciliation reply" && asked === 1) {
						await route.fetch();
						await route.abort("failed");
					} else await route.continue();
				});
				await b.route("**/propose", async (route) => {
					requests.push(
						z.object({ cmd: z.string(), edits: z.array(z.unknown()) }).parse(route.request().postDataJSON()),
					);
					await route.continue();
				});
				await b.goto(`${server.url}/p/scratch/suite`);
				await takeover(b);
				if (fate === "lost reconciliation reply") {
					await b.locator("#stat").filter({ hasText: "Your draft is kept on this device" }).waitFor();
					expect(requests).toHaveLength(1);
					const remembered = await b.evaluate(() => {
						const key = Object.keys(localStorage).find((key) => key.includes(":draft:"));
						return key ? JSON.parse(localStorage.getItem(key) ?? "null") : null;
					});
					expect(
						z.object({ sent: z.object({ input: z.object({ cmd: z.string() }) }) }).parse(remembered).sent.input.cmd,
					).toBe(requests[0]?.cmd ?? "");
				}
				await title(b).click();
				await b.keyboard.press("Escape");
				await eventually(
					() => server.api("get", { refs: ["C-1"] }).catch(() => []),
					(rows) => rows[0]?.title === "First phrase with the rest",
				);
				release();
				await eventually(async () => originalReturned, Boolean);
				expect((await server.api("find", { in: "cases" })).items).toHaveLength(1);
				expect((await server.api("get", { refs: ["C-1"] }))[0]).toMatchObject({
					title: "First phrase with the rest",
					version: 2,
				});
				expect((await server.api("get", { refs: ["C-1"], version: 1 }))[0]?.title).toBe("First phrase");
				expect((await server.api("inbox", { kind: "adopt" })).items).toHaveLength(0);
				expect(asked).toBe(fate === "lost reconciliation reply" ? 2 : 1);
				expect(requests).toHaveLength(fate === "recorded" ? 2 : 3);
				for (const replay of requests.filter((request) => request.cmd === requests[0]?.cmd))
					expect(replay.edits).toEqual(requests[0]?.edits ?? []);
				if (fate !== "recorded") expect(requests[1]).toEqual(requests[0]);
				expect(requests.at(-1)?.cmd).not.toBe(requests[0]?.cmd ?? "");
				expect(await title(b).inputValue()).toBe("First phrase with the rest");
			} finally {
				release();
				await h.close();
				await server.stop();
			}
		},
		30_000,
	);
}
