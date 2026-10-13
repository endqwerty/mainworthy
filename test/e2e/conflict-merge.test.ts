// A merge the server combined with a colleague's newer change, and every way its reply can be lost: the ninth
// independent review of the web UI (R9-1) and the two checks of its fixes (issue #81).
import { expect, test } from "bun:test";
import type { Page } from "playwright-core";
import { z } from "zod";
import { browserAvailable, eventually, openPage, type Server, startServer } from "./support.ts";

const Head = z.object({
	version: z.number(),
	title: z.string(),
	pre: z.string(),
	methods: z.array(z.enum(["human", "auto", "agent"])),
	automate: z.enum(["none", "not-applicable", "wanted"]),
	steps: z.array(z.object({ id: z.string(), action: z.string(), expected: z.string().nullable() })),
});
type Head = z.infer<typeof Head>;
const head = async (server: Server) => Head.parse((await server.api("get", { refs: ["C-1"] }))[0]);
const actions = (value: Head) => value.steps.map((step) => step.action);
const storedDrafts = (page: Page) =>
	page.evaluate(() =>
		Object.keys(localStorage)
			.filter((key) => key.includes(":draft:"))
			.map((key) => localStorage.getItem(key) ?? ""),
	);
const card = (page: Page) => page.locator(".conflict-card");
const caseTitle = (page: Page) => page.getByRole("textbox", { name: "Case title", exact: true });
const mergedTitle = (page: Page) => page.getByRole("textbox", { name: "Merged title", exact: true });
const resolve = (page: Page) => page.getByRole("button", { name: "Resolve conflict", exact: true }).click();
const kept = (page: Page) =>
	page.getByText("Your draft and conflict card are kept", { exact: false }).first().waitFor();
const MERGED = "Coupon case, merged by hand";
const COLLEAGUE = "Open the cart, changed by a colleague";
const MINE = "Apply the coupon SAVE10";

/** A colleague records the head again with these fields changed. */
async function colleagueEdits(server: Server, change: (body: Head) => Partial<Head>): Promise<Head> {
	const before = await head(server);
	const { version, ...body } = before;
	await server.api("propose", {
		edits: [{ op: "edit", case: "C-1", base: version, body: { ...body, ...change(before) } }],
	});
	return eventually(
		() => head(server),
		(value) => value.version === version + 1,
	);
}
/**
 * A person edits the title and the second step. A colleague records a version that changes the title too, so
 * leaving the editor meets a conflict and the card opens.
 */
async function card1({
	theirs = () => ({ title: "Coupon case theirs" }),
	alsoTyped = async () => {},
}: {
	theirs?: (body: Head) => Partial<Head>;
	alsoTyped?: (page: Page) => Promise<void>;
} = {}) {
	const server = await startServer();
	await server.api("propose", {
		edits: [{ op: "create", outline: "Coupon case\n  Open the cart\n  Apply the coupon" }],
	});
	const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
	const { page } = h;
	page.setDefaultTimeout(5000);
	await page.getByRole("button", { name: "Coupon case", exact: true }).waitFor();
	await page.keyboard.press("e");
	await caseTitle(page).fill("Coupon case mine");
	await page.getByRole("textbox", { name: "Step 2", exact: true }).fill(MINE);
	await alsoTyped(page);
	await colleagueEdits(server, theirs);
	await page.keyboard.press("Escape");
	await card(page).waitFor();
	return {
		server,
		h,
		page,
		close: async () => {
			await h.close();
			await server.stop();
		},
	};
}
const firstStep = (action: string) => (body: Head) => ({
	steps: body.steps.map((step, index) => (index === 0 ? { ...step, action } : step)),
});
/**
 * While the card is open the colleague changes another field, the first step. The person then types the merged
 * title by hand. A merge from here is recorded by the server together with the colleague's step.
 */
async function cardWithANewerChange() {
	const opened = await card1();
	await colleagueEdits(opened.server, firstStep(COLLEAGUE));
	await mergedTitle(opened.page).fill(MERGED);
	return opened;
}
/**
 * The next `decide` fails in the page. `reaches: true`: the server records it and the reply is dropped.
 * `reaches: false`: the request never arrives. The page cannot tell the two apart.
 */
async function failTheNextMerge(page: Page, { reaches }: { reaches: boolean }) {
	let failed = false;
	await page.route("**/decide", async (route) => {
		if (failed) return route.continue();
		failed = true;
		if (reaches) await route.fetch();
		await route.abort("failed");
	});
}
/** The same person answers the open conflict from another client, with a body of their own. */
async function mergeFromAnotherClient(server: Server, change: (body: Head) => Partial<Head>): Promise<Head> {
	const question = (await server.api("inbox", { on: "C-1", kind: "adopt" })).items[0];
	if (!question) throw Error("Missing conflict question");
	const { version, ...body } = await head(server);
	const reply = await server.api("decide", {
		q: question.q,
		onEvidence: question.evidenceHash,
		answer: { is: "merge", body: { ...body, fields: {}, ...change({ version, ...body }) } },
	});
	expect(reply[0]?.status).toBe("decided");
	return eventually(
		() => head(server),
		(value) => value.version === version + 1,
	);
}
/** No draft is left on the device, and leaving the editor proposes nothing. */
async function expectNothingLeftToPropose(page: Page) {
	await eventually(
		() => storedDrafts(page),
		(rows) => rows.length === 0,
	);
	let proposals = 0;
	page.on("request", (request) => {
		if (request.url().endsWith("/propose")) proposals++;
	});
	// Leaving sends a draft's proposal before the key handler returns, so one trip to the page is enough.
	await page.keyboard.press("Escape");
	await page.evaluate(() => undefined);
	expect(proposals).toBe(0);
}
/** Version 4 holds the typed title, the person's step and the colleague's step, and stays the head. */
async function expectTheMergeToStand(server: Server, page: Page) {
	await expectNothingLeftToPropose(page);
	const after = await head(server);
	expect(after.version).toBe(4);
	expect(after.title).toBe(MERGED);
	expect(actions(after)).toEqual([COLLEAGUE, MINE]);
}

const check = test.skipIf(!browserAvailable);

check(
	"a merge typed by hand that the server combines with a colleague's newer change leaves no draft to undo it",
	async () => {
		const { server, h, page, close } = await cardWithANewerChange();
		try {
			await resolve(page);
			const merged = await eventually(
				() => head(server),
				(value) => value.version === 4,
			);
			expect(actions(merged)).toEqual([COLLEAGUE, MINE]);
			await card(page).waitFor({ state: "detached" });
			await expectTheMergeToStand(server, page);
			expect(h.errors).toEqual([]);
		} finally {
			await close();
		}
	},
	30_000,
);

for (const recovery of ["a second press", "a reload"])
	check(
		`such a merge whose reply was lost stands after ${recovery}`,
		async () => {
			const { server, page, close } = await cardWithANewerChange();
			try {
				await failTheNextMerge(page, { reaches: true });
				await resolve(page);
				await kept(page);
				expect((await head(server)).version).toBe(4);
				if (recovery === "a reload") await page.reload();
				else await resolve(page);
				await page.getByText("Conflict resolved", { exact: false }).first().waitFor();
				await card(page).waitFor({ state: "detached" });
				await expectTheMergeToStand(server, page);
			} finally {
				await close();
			}
		},
		30_000,
	);

check(
	"text typed in the card after a lost merge reply is kept on the recorded version, with the colleague's change",
	async () => {
		const { server, page, close } = await cardWithANewerChange();
		try {
			await failTheNextMerge(page, { reaches: true });
			await resolve(page);
			await kept(page);
			await mergedTitle(page).fill(`${MERGED}, and later words`);
			await resolve(page);
			await page.getByText("later text is kept", { exact: false }).first().waitFor();
			// The later words are a draft on version 4, and the draft has the colleague's step, not the old one.
			expect(await page.getByRole("textbox", { name: "Step 1", exact: true }).inputValue()).toBe(COLLEAGUE);
			await page.keyboard.press("Escape");
			const saved = await eventually(
				() => head(server),
				(value) => value.version === 5,
			);
			expect(saved.title).toBe(`${MERGED}, and later words`);
			expect(actions(saved)).toEqual([COLLEAGUE, MINE]);
		} finally {
			await close();
		}
	},
	30_000,
);

// The second check's `same-after` (F2): the later words meet a change the person never saw.
check(
	"later card text that meets a colleague's change made after the lost merge shows a conflict, and records nothing over it",
	async () => {
		const { server, page, close } = await cardWithANewerChange();
		try {
			await failTheNextMerge(page, { reaches: true });
			await resolve(page);
			await kept(page);
			await colleagueEdits(server, () => ({ title: "Colleague title AFTER merge" }));
			await mergedTitle(page).fill(`${MERGED} PLUS LATER`);
			await resolve(page);
			await page.getByText("later text is kept", { exact: false }).first().waitFor();
			await card(page).waitFor({ state: "detached" });
			await page.keyboard.press("Escape");
			// The later words were written on version 4. Version 5 changed the same field, so the server asks.
			await card(page).waitFor();
			const asked = await head(server);
			expect(asked.version).toBe(5);
			expect(asked.title).toBe("Colleague title AFTER merge");
			expect(await mergedTitle(page).inputValue()).toBe(`${MERGED} PLUS LATER`);
			await resolve(page);
			const saved = await eventually(
				() => head(server),
				(value) => value.version === 6,
			);
			expect(saved.title).toBe(`${MERGED} PLUS LATER`);
			expect(actions(saved)).toEqual([COLLEAGUE, MINE]);
		} finally {
			await close();
		}
	},
	30_000,
);

// The second check's `same-before` (F2): the lost reply said that nothing was adopted and named a new question.
check(
	"a lost reply that held a new conflict brings the new card, with nothing recorded and nothing dropped",
	async () => {
		const { server, page, close } = await cardWithANewerChange();
		try {
			await colleagueEdits(server, () => ({ title: "Colleague title BEFORE merge" }));
			await failTheNextMerge(page, { reaches: true });
			await resolve(page);
			await kept(page);
			await mergedTitle(page).fill(`${MERGED}, and later words`);
			await resolve(page);
			await page.getByText("Nothing was adopted: the case changed again", { exact: false }).first().waitFor();
			expect(await card(page).count()).toBe(1);
			const asked = await head(server);
			expect(asked.version).toBe(4);
			expect(asked.title).toBe("Colleague title BEFORE merge");
			expect((await storedDrafts(page)).join(" ")).toContain(MINE);
			expect(await mergedTitle(page).inputValue()).toBe(`${MERGED}, and later words`);
			await resolve(page);
			const saved = await eventually(
				() => head(server),
				(value) => value.version === 5,
			);
			expect(saved.title).toBe(`${MERGED}, and later words`);
			expect(actions(saved)).toEqual([COLLEAGUE, MINE]);
			await card(page).waitFor({ state: "detached" });
			expect(await storedDrafts(page)).toHaveLength(0);
			expect((await server.api("inbox", { on: "C-1", kind: "adopt" })).items).toHaveLength(0);
		} finally {
			await close();
		}
	},
	30_000,
);

// A request the page gave up can still arrive. Here it arrives while a second attempt, with later words, is on
// its way: the server records the first and refuses the second, and the command ids say which.
check(
	"a merge that arrives after the page gave it up is the one recorded, and a later attempt's words stay a draft on it",
	async () => {
		const { server, page, close } = await cardWithANewerChange();
		let release = () => {};
		const arrived = new Promise<void>((done) => {
			release = done;
		});
		try {
			const requests: { url: string; body: string; headers: Record<string, string> }[] = [];
			await page.route("**/decide", async (route) => {
				const request = route.request();
				requests.push({ url: request.url(), body: request.postData() ?? "", headers: await request.allHeaders() });
				if (requests.length === 1) return route.abort("failed");
				await arrived;
				return route.continue();
			});
			await resolve(page);
			await kept(page);
			await mergedTitle(page).fill(`${MERGED}, and later words`);
			await resolve(page);
			const [first] = await eventually(
				async () => requests,
				(seen) => seen.length === 2,
			);
			if (!first) throw Error("Missing the first merge request");
			const late = await fetch(first.url, {
				method: "POST",
				headers: Object.fromEntries(
					Object.entries(first.headers).filter(([name]) => ["content-type", "cookie", "x-casebook-as"].includes(name)),
				),
				body: first.body,
			});
			expect(await late.json()).toMatchObject({ ok: true, result: [{ status: "decided" }] });
			expect((await head(server)).title).toBe(MERGED);
			release();
			await page.getByText("later text is kept", { exact: false }).first().waitFor();
			await card(page).waitFor({ state: "detached" });
			expect(await page.getByRole("textbox", { name: "Step 1", exact: true }).inputValue()).toBe(COLLEAGUE);
			expect((await head(server)).version).toBe(4);
			await page.keyboard.press("Escape");
			const saved = await eventually(
				() => head(server),
				(value) => value.version === 5,
			);
			expect(saved.title).toBe(`${MERGED}, and later words`);
			expect(actions(saved)).toEqual([COLLEAGUE, MINE]);
		} finally {
			release();
			await close();
		}
	},
	30_000,
);

// The second check's `again-title` (F3): the merge was recorded, and the head moved on before the page asked.
check(
	"a recorded merge whose reply was lost stands when a colleague changes the same field before the reload",
	async () => {
		const { server, page, close } = await cardWithANewerChange();
		try {
			await failTheNextMerge(page, { reaches: true });
			await resolve(page);
			await kept(page);
			await colleagueEdits(server, () => ({ title: "Colleague title AFTER merge" }));
			await page.reload();
			await page.getByText("Conflict resolved", { exact: false }).first().waitFor();
			await card(page).waitFor({ state: "detached" });
			await expectNothingLeftToPropose(page);
			const after = await head(server);
			expect(after.version).toBe(5);
			expect(after.title).toBe("Colleague title AFTER merge");
			expect(actions(after)).toEqual([COLLEAGUE, MINE]);
		} finally {
			await close();
		}
	},
	30_000,
);

// The second check's `api-different-title` (F3) and `api-different-step` (F4): the page's merge never arrived,
// and the same person answered the question from another client with a body that differs in one field.
for (const differs of ["title", "step"])
	check(
		`a merge that never arrived, answered elsewhere with another ${differs}, keeps the card's text and asks before recording it`,
		async () => {
			const { server, page, close } = await cardWithANewerChange();
			try {
				await failTheNextMerge(page, { reaches: false });
				await resolve(page);
				await kept(page);
				expect((await head(server)).version).toBe(3);
				const elsewhere = await mergeFromAnotherClient(server, (body) =>
					differs === "title"
						? { title: "Different API title" }
						: {
								title: MERGED,
								steps: body.steps.map((step, index) =>
									index === 1 ? { ...step, action: "Different API step" } : step,
								),
							},
				);
				expect(actions(elsewhere)).toEqual([
					COLLEAGUE,
					differs === "title" ? "Apply the coupon" : "Different API step",
				]);
				await resolve(page);
				await page.getByText("typed merge is kept", { exact: false }).first().waitFor();
				await card(page).waitFor({ state: "detached" });
				// Nothing the person typed is gone, and none of it was recorded.
				expect(await caseTitle(page).inputValue()).toBe(MERGED);
				expect(await page.getByRole("textbox", { name: "Step 2", exact: true }).inputValue()).toBe(MINE);
				expect((await storedDrafts(page)).join(" ")).toContain(MINE);
				expect(await head(server)).toEqual(elsewhere);
				// Leaving proposes it. The field the other client recorded differently is asked about, not replaced.
				await page.keyboard.press("Escape");
				await card(page).waitFor();
				expect(await head(server)).toEqual(elsewhere);
				expect((await storedDrafts(page)).join(" ")).toContain(MINE);
				await resolve(page);
				const saved = await eventually(
					() => head(server),
					(value) => value.version === 5,
				);
				expect(saved.title).toBe(MERGED);
				expect(actions(saved)).toEqual([COLLEAGUE, MINE]);
			} finally {
				await close();
			}
		},
		30_000,
	);

// The card's merged body also holds what the colleague's version changed in fields the person left alone. A
// draft made of the card must not claim those: proposed on the draft's base they would come back after an undo.
check(
	"a typed merge kept after a rejection does not put back a colleague's change that was undone since",
	async () => {
		const { server, page, close } = await card1({
			theirs: (body) => ({ title: "Coupon case theirs", ...firstStep(COLLEAGUE)(body) }),
		});
		try {
			await mergedTitle(page).fill(MERGED);
			const question = (await server.api("inbox", { on: "C-1", kind: "adopt" })).items[0];
			if (!question) throw Error("Missing conflict question");
			await server.api("decide", { q: question.q, onEvidence: question.evidenceHash, answer: { is: "reject" } });
			await page.getByText("typed merge is kept", { exact: false }).first().waitFor();
			await card(page).waitFor({ state: "detached" });
			expect(await caseTitle(page).inputValue()).toBe(MERGED);
			await colleagueEdits(server, firstStep("Open the cart"));
			await page.keyboard.press("Escape");
			await card(page).waitFor();
			await resolve(page);
			const saved = await eventually(
				() => head(server),
				(value) => value.version === 4,
			);
			expect(saved.title).toBe(MERGED);
			expect(actions(saved)).toEqual(["Open the cart", MINE]);
		} finally {
			await close();
		}
	},
	30_000,
);

// The first independent check of this change (V1). A step with an expected result and no action yet cannot be
// recorded, so no merge holds it: it has to stay on the device when the card ends, and when the card moves.
for (const outcome of ["is recorded", "meets a new conflict"])
	check(
		`a step still being typed, with an expected result and no action, stays on the device when the merge ${outcome}`,
		async () => {
			const { server, page, close } = await card1({
				alsoTyped: async (page) => {
					await page.getByRole("textbox", { name: "Step 2", exact: true }).press("End");
					await page.keyboard.press("Enter");
					await page.getByRole("textbox", { name: "Step 3", exact: true }).press("Tab");
					await page.getByRole("textbox", { name: "Expected result 3", exact: true }).fill("UNRECORDED EXPECTATION");
				},
			});
			try {
				await mergedTitle(page).fill(MERGED);
				if (outcome === "meets a new conflict")
					await colleagueEdits(server, () => ({ title: "Colleague title again" }));
				await resolve(page);
				await page
					.getByText(outcome === "is recorded" ? "Conflict resolved" : "Nothing was adopted", { exact: false })
					.first()
					.waitFor();
				expect(JSON.stringify(await head(server))).not.toContain("UNRECORDED EXPECTATION");
				expect((await storedDrafts(page)).join(" ")).toContain("UNRECORDED EXPECTATION");
				if (outcome === "is recorded") {
					const merged = await head(server);
					expect(merged.title).toBe(MERGED);
					expect(actions(merged)).toEqual(["Open the cart", MINE]);
					// The step is in the editor again, on the recorded version, for the person to finish.
					await card(page).waitFor({ state: "detached" });
					expect(await page.getByRole("textbox", { name: "Expected result 3", exact: true }).inputValue()).toBe(
						"UNRECORDED EXPECTATION",
					);
				} else expect((await storedDrafts(page)).join(" ")).toContain(MINE);
			} finally {
				await close();
			}
		},
		30_000,
	);
