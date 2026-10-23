// A merge the server combined with a colleague's newer change, and every way its reply can be lost: the ninth
// independent review of the web UI (R9-1) and the two checks of its fixes (issue #81).
import { expect, test } from "bun:test";
import type { Page } from "playwright-core";
import { z } from "zod";
import type { Edit } from "../../src/core/ops.ts";
import { PRESETS } from "../../src/core/presets.ts";
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
	covers = [],
	tags = [],
	theirs = () => ({ title: "Coupon case theirs" }),
	alsoTyped = async () => {},
}: {
	covers?: string[];
	tags?: string[];
	theirs?: (body: Head) => Partial<Head>;
	alsoTyped?: (page: Page) => Promise<void>;
} = {}) {
	const server = await startServer();
	await server.api("propose", {
		edits: [{ op: "create", outline: "Coupon case\n  Open the cart\n  Apply the coupon", covers, tags }],
	});
	const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
	const { page } = h;
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

for (const [boundary, space] of [
	["NBSP", "\u00a0"],
	["U+3000", "\u3000"],
] as const) {
	check(
		`conflict-card step actions and expected results capture ${boundary} inline metadata`,
		async () => {
			const { server, page, close } = await card1({
				alsoTyped: async (page) => {
					await page.getByRole("textbox", { name: "Step 2", exact: true }).press("Tab");
					await page.getByRole("textbox", { name: "Expected result 2", exact: true }).fill("Mine expected");
				},
				theirs: (body) => ({
					title: "Coupon case theirs",
					steps: body.steps.map((step, index) =>
						index === 1 ? { ...step, action: "Their coupon action", expected: "Their expected" } : step,
					),
				}),
			});
			try {
				const step = (await head(server)).steps[1];
				if (!step) throw Error("Missing coupon step");
				await mergedTitle(page).fill(MERGED);
				await page
					.getByRole("textbox", { name: `Merged Step ^${step.id} action`, exact: true })
					.fill(`${space}#smoke${space}#critical Apply the coupon${space}@REQ-101`);
				await page
					.getByRole("textbox", { name: `Merged Step ^${step.id} expected`, exact: true })
					.fill(`${space}#expected Total is correct\n${space}#critical${space}@REQ-102`);
				const replied = page.waitForResponse((response) => response.url().endsWith("/decide"));
				await resolve(page);
				const reply = (await (await replied).json()).result[0];
				if (process.env.MAINWORTHY_STEP_INLINE_SCREENSHOT)
					await page.screenshot({ path: `${process.env.MAINWORTHY_STEP_INLINE_SCREENSHOT}-${boundary}.png` });
				expect(reply).toMatchObject({ status: "decided", effects: { status: "adopted" } });
				await card(page).waitFor({ state: "detached" });
				const saved = Head.extend({ tags: z.array(z.string()), covers: z.array(z.string()) }).parse(
					(await server.api("get", { refs: ["C-1"] }))[0],
				);
				expect(saved).toMatchObject({ title: MERGED, covers: ["REQ-101", "REQ-102"] });
				expect(saved.tags.toSorted()).toEqual(["critical", "expected", "smoke"]);
				expect(saved.steps[1]).toMatchObject({ action: "Apply the coupon", expected: "Total is correct" });
				await expectNothingLeftToPropose(page);
			} finally {
				await close();
			}
		},
		30_000,
	);
}

async function criticalReview(server: Server): Promise<void> {
	const policy = await server.api("propose", {
		edits: [
			{
				op: "policy",
				base: z
					.object({ version: z.number() })
					.parse(await server.api("admin", { do: "policy.show", project: "scratch" })).version,
				clauses: PRESETS.loose.clauses.flatMap((clause) =>
					clause.id === "adopt-any"
						? [
								{
									id: "critical-agent",
									kind: "adopt" as const,
									when: ["author:agent", "tag:critical"],
									ask: {
										who: "member" as const,
										agents: "none" as const,
										notProducer: false,
										reason: "optional" as const,
									},
									blocks: "nothing" as const,
								},
								clause,
							]
						: [
								{
									...clause,
									ask: clause.id === "adopt-conflict" ? { ...clause.ask, agents: "answer" as const } : clause.ask,
								},
							],
				),
			},
		],
	});
	const policyQuestion = (await server.api("inbox", { kind: "adopt" })).items.find((q) => q.q === policy.question);
	if (!policyQuestion) throw Error("Missing policy question");
	await server.api("decide", {
		q: policyQuestion.q,
		onEvidence: policyQuestion.evidenceHash,
		answer: { is: "accept" },
	});
}

check(
	"keeping the current literal title records no version or metadata",
	async () => {
		const literal = "Enter #critical in the filter @REQ-101";
		const { server, page, close } = await card1({ theirs: () => ({ title: literal }) });
		try {
			await page.getByRole("button", { name: "Keep current version", exact: true }).click();
			const replied = page.waitForResponse((response) => response.url().endsWith("/decide"));
			await resolve(page);
			const reply = await (await replied).json();
			await card(page).waitFor({ state: "detached" });
			if (process.env.MAINWORTHY_LITERAL_SCREENSHOT)
				await page.screenshot({ path: process.env.MAINWORTHY_LITERAL_SCREENSHOT });
			expect(reply.result[0]).toMatchObject({ status: "decided", effects: { status: "unchanged", cases: [] } });
			const saved = (await server.api("get", { refs: ["C-1"] }))[0];
			expect(saved).toMatchObject({ version: 2, title: literal, tags: [], covers: [] });
			await expectNothingLeftToPropose(page);
		} finally {
			await close();
		}
	},
	30_000,
);

for (const answer of ["accept", "reject"] as const) {
	check(
		`a body adding a protected inline tag stays unchanged until review chooses ${answer}`,
		async () => {
			const server = await startServer();
			await server.api("propose", { edits: [{ op: "create", body: { title: "Unreviewed original" } }] });
			await criticalReview(server);
			const agent = z.object({ token: z.string() }).parse(
				await server.api("admin", {
					do: "token.create",
					actor: "case-writer",
					kind: "agent",
					can: ["read", "produce", "answer"],
				}),
			);
			const h = await openPage({ ...server, token: agent.token }, { path: "/p/scratch/suite/c/1" });
			try {
				const { page } = h;
				await page.getByRole("button", { name: "Unreviewed original", exact: true }).waitFor();
				await page.keyboard.press("e");
				await caseTitle(page).fill("Protected body #critical");
				await caseTitle(page).press("Control+Enter");
				await page.waitForFunction(() =>
					document.querySelector("#stat")?.textContent?.includes("waiting for a person"),
				);
				const before = (await server.api("get", { refs: ["C-1"] }))[0];
				if (answer === "accept" && process.env.MAINWORTHY_SCOPE_SCREENSHOT)
					await page.screenshot({ path: process.env.MAINWORTHY_SCOPE_SCREENSHOT });
				const questions = (await server.api("inbox", { kind: "adopt", on: "C-1" })).items;
				expect(questions).toHaveLength(1);
				const question = questions[0];
				if (!question) throw Error("Missing protected proposal");
				await server.api("decide", { q: question.q, onEvidence: question.evidenceHash, answer: { is: answer } });
				const after = (await server.api("get", { refs: ["C-1"] }))[0];
				expect(before?.title).toBe("Unreviewed original");
				expect(before?.tags).toEqual([]);
				expect(after?.title).toBe(answer === "accept" ? "Protected body" : "Unreviewed original");
				expect(after?.tags).toEqual(answer === "accept" ? ["critical"] : []);
			} finally {
				await h.close();
				await server.stop();
			}
		},
		30_000,
	);
}

for (const [boundary, space, answer] of [
	["space", " ", "accept"],
	["space", " ", "reject"],
	["NBSP", "\u00a0", "accept"],
	["NBSP", "\u00a0", "reject"],
	["U+3000", "\u3000", "accept"],
	["U+3000", "\u3000", "reject"],
] as const) {
	check(
		`conflict-card ${boundary === "space" ? "" : `${boundary} `}inline tags and links wait for protected review before ${answer}`,
		async () => {
			const server = await startServer();
			await server.api("propose", { edits: [{ op: "create", body: { title: "Base" } }] });
			await criticalReview(server);
			const agent = z.object({ token: z.string() }).parse(
				await server.api("admin", {
					do: "token.create",
					actor: "merge-writer",
					kind: "agent",
					can: ["read", "produce", "answer"],
				}),
			);
			const h = await openPage({ ...server, token: agent.token }, { path: "/p/scratch/suite/c/1" });
			try {
				const { page } = h;
				await page.getByRole("button", { name: "Base", exact: true }).waitFor();
				await page.keyboard.press("e");
				await caseTitle(page).fill("Mine");
				await colleagueEdits(server, () => ({ title: "Theirs" }));
				await page.keyboard.press("Escape");
				await card(page).waitFor();
				await mergedTitle(page).fill(`Protected body${space}#critical${space}@REQ-101`);
				const replied = page.waitForResponse((response) => response.url().endsWith("/decide"));
				await resolve(page);
				const reply = (await (await replied).json()).result[0];
				if (boundary === "NBSP" && answer === "accept" && process.env.MAINWORTHY_UNICODE_SCREENSHOT)
					await page.screenshot({ path: process.env.MAINWORTHY_UNICODE_SCREENSHOT });
				expect(reply).toMatchObject({
					status: "decided",
					effects: { status: "open" },
				});
				if (answer === "accept" && process.env.MAINWORTHY_INLINE_SCREENSHOT)
					await page.screenshot({ path: process.env.MAINWORTHY_INLINE_SCREENSHOT });
				const beforeImmediate = (await server.api("get", { refs: ["C-1"] }))[0];
				expect(beforeImmediate?.title).toBe("Theirs");
				await eventually(
					() => storedDrafts(page),
					(rows) => rows.every((row) => !JSON.parse(row).conflict),
				);
				if (answer === "accept" && process.env.MAINWORTHY_INLINE_SCREENSHOT)
					await page.screenshot({ path: process.env.MAINWORTHY_INLINE_SCREENSHOT });
				const before = (await server.api("get", { refs: ["C-1"] }))[0];
				expect(before?.title).toBe("Theirs");
				expect(before?.tags).toEqual([]);
				expect(before?.covers).toEqual([]);
				const questions = (await server.api("inbox", { kind: "adopt", on: "C-1" })).items;
				expect(questions).toHaveLength(1);
				const question = questions[0];
				if (!question) throw Error("Missing protected merge proposal");
				expect(question.evidence).toMatchObject({ author: "merge-writer" });
				await server.api("decide", { q: question.q, onEvidence: question.evidenceHash, answer: { is: answer } });
				const after = (await server.api("get", { refs: ["C-1"] }))[0];
				expect(after?.title).toBe(answer === "accept" ? "Protected body" : "Theirs");
				expect(after?.tags).toEqual(answer === "accept" ? ["critical"] : []);
				expect(after?.covers).toEqual(answer === "accept" ? ["REQ-101"] : []);
			} finally {
				await h.close();
				await server.stop();
			}
		},
		30_000,
	);
}

check(
	"an in-flight conflict merge preserves a decision from another client",
	async () => {
		const { server, page, close } = await cardWithANewerChange();
		try {
			const question = (await server.api("inbox", { kind: "adopt" })).items[0];
			if (!question) throw Error("Missing conflict question");
			await page.route("**/decide", async (route) => {
				await server.api("decide", { q: question.q, onEvidence: question.evidenceHash, answer: { is: "reject" } });
				await route.continue();
			});
			const replied = page.waitForResponse((response) => response.url().endsWith("/decide"));
			await resolve(page);
			await replied;
			expect((await server.api("get", { refs: [question.q] }))[0]?.decision).toMatchObject({
				answer: { is: "reject" },
			});
			expect((await head(server)).version).toBe(3);
			await page.getByText("typed merge is kept", { exact: false }).first().waitFor();
			expect(await caseTitle(page).inputValue()).toBe(MERGED);
		} finally {
			await close();
		}
	},
	30000,
);

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

for (const inline of [false, true])
	check(
		`later card text and ${inline ? "inline metadata" : "steps"} survive recovery of the winning merge`,
		async () => {
			const { server, page, close } = await cardWithANewerChange();
			try {
				if (inline) await mergedTitle(page).fill(`${MERGED} #smoke @REQ-101`);
				await failTheNextMerge(page, { reaches: true });
				await resolve(page);
				await kept(page);
				await mergedTitle(page).fill(`${MERGED}, and later words${inline ? " #later @REQ-102" : ""}`);
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
				if (inline) {
					const row = (await server.api("get", { refs: ["C-1"] }))[0];
					expect(row?.tags).toEqual(["later"]);
					expect(row?.covers).toEqual(["REQ-102"]);
				}
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
for (const inline of [false, true])
	check(
		`a lost reply holding a new conflict keeps text and ${inline ? "inline metadata" : "steps"}`,
		async () => {
			const { server, page, close } = await cardWithANewerChange();
			try {
				if (inline) await mergedTitle(page).fill(`${MERGED} #smoke @REQ-12`);
				await colleagueEdits(server, () => ({ title: "Colleague title BEFORE merge" }));
				await failTheNextMerge(page, { reaches: true });
				await resolve(page);
				await kept(page);
				await mergedTitle(page).fill(`${MERGED}, and later words${inline ? " #smoke @REQ-12" : ""}`);
				await resolve(page);
				await page.getByText("Nothing was adopted: the case changed again", { exact: false }).first().waitFor();
				expect(await card(page).count()).toBe(1);
				const asked = await head(server);
				expect(asked.version).toBe(4);
				expect(asked.title).toBe("Colleague title BEFORE merge");
				expect((await storedDrafts(page)).join(" ")).toContain(MINE);
				expect(await mergedTitle(page).inputValue()).toBe(
					`${MERGED}, and later words${inline ? " #smoke @REQ-12" : ""}`,
				);
				await resolve(page);
				const saved = await eventually(
					() => head(server),
					(value) => value.version === 5,
				);
				expect(saved.title).toBe(`${MERGED}, and later words`);
				expect(actions(saved)).toEqual([COLLEAGUE, MINE]);
				if (inline) {
					const row = (await server.api("get", { refs: ["C-1"] }))[0];
					expect(row?.tags).toEqual(["smoke"]);
					expect(row?.covers).toEqual(["REQ-12"]);
				}
				await card(page).waitFor({ state: "detached" });
				await expectNothingLeftToPropose(page);
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
					Object.entries(first.headers).filter(([name]) =>
						["content-type", "cookie", "x-mainworthy-as"].includes(name),
					),
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
					const unfinished = page.getByRole("textbox", { name: "Expected result 3", exact: true });
					expect(await unfinished.inputValue()).toBe("UNRECORDED EXPECTATION");
					// Leaving the editor then proposes nothing, and the step is still on the device (issue #86).
					let proposals = 0;
					page.on("request", (request) => {
						if (request.url().endsWith("/propose")) proposals++;
					});
					await unfinished.press("Escape");
					await page.evaluate(() => undefined);
					expect(proposals).toBe(0);
					expect((await storedDrafts(page)).join(" ")).toContain("UNRECORDED EXPECTATION");
				} else expect((await storedDrafts(page)).join(" ")).toContain(MINE);
			} finally {
				await close();
			}
		},
		30_000,
	);

check(
	"an overlapping title resolves atomically with its typed tag",
	async () => {
		const { server, page, close } = await card1({
			alsoTyped: (page) => caseTitle(page).fill("Coupon case mine #smoke"),
		});
		try {
			expect((await server.api("get", { refs: ["C-1"] }))[0]?.tags).toEqual([]);
			expect(await card(page).textContent()).toContain("add tags #smoke");
			await page.getByRole("button", { name: "Use my title", exact: true }).click();
			const decided = page.waitForResponse((response) => response.url().endsWith("/decide"));
			await resolve(page);
			await decided;
			await page.waitForFunction(() =>
				/Conflict resolved|Your merge was not adopted/.test(document.querySelector("#stat")?.textContent ?? ""),
			);
			if (process.env.MAINWORTHY_CONFLICT_SCREENSHOT)
				await page.screenshot({ path: process.env.MAINWORTHY_CONFLICT_SCREENSHOT });
			const saved = (await server.api("get", { refs: ["C-1"] }))[0];
			expect(saved?.title).toBe("Coupon case mine");
			await eventually(
				() => server.api("get", { refs: ["C-1"] }),
				(rows) => Array.isArray(rows[0]?.tags) && rows[0]?.tags.includes("smoke"),
			);
			expect((await server.api("get", { refs: ["C-1"] }))[0]?.tags).toEqual(["smoke"]);
			await card(page).waitFor({ state: "detached" });
			await expectNothingLeftToPropose(page);
		} finally {
			await close();
		}
	},
	30_000,
);

for (const source of ["editor", "card"] as const)
	check(
		`keeping the current body still records the tag typed in the ${source}`,
		async () => {
			const { server, page, close } = await card1({
				alsoTyped: (page) => caseTitle(page).fill(source === "editor" ? "Coupon case mine #smoke" : "Coupon case mine"),
			});
			try {
				await page.getByRole("button", { name: "Keep current version", exact: true }).click();
				if (source === "card") await mergedTitle(page).fill("Coupon case theirs #smoke");
				await resolve(page);
				await card(page).waitFor({ state: "detached" });
				const rows = await eventually(
					() => server.api("get", { refs: ["C-1"] }),
					(rows) => Array.isArray(rows[0]?.tags) && rows[0]?.tags.includes("smoke"),
				);
				expect(rows[0]?.title).toBe("Coupon case theirs");
				expect(rows[0]?.version).toBe(2);
				await expectNothingLeftToPropose(page);
			} finally {
				await close();
			}
		},
		30_000,
	);

for (const source of ["editor", "card"] as const)
	check(
		`tags and requirement links typed in the ${source} survive a lost reply and reload`,
		async () => {
			const { server, page, close } = await card1({
				alsoTyped: (page) =>
					caseTitle(page).fill(source === "editor" ? "Coupon case mine #smoke @REQ-12" : "Coupon case mine"),
			});
			try {
				await page.getByRole("button", { name: "Use my title", exact: true }).click();
				if (source === "card") await mergedTitle(page).fill("Coupon case mine #smoke @REQ-12");
				await failTheNextMerge(page, { reaches: true });
				await resolve(page);
				await kept(page);
				expect((await server.api("get", { refs: ["C-1"] }))[0]?.tags).toEqual(["smoke"]);
				expect((await server.api("get", { refs: ["C-1"] }))[0]?.covers).toEqual(["REQ-12"]);
				await page.reload();
				const rows = await eventually(
					() => server.api("get", { refs: ["C-1"] }),
					(rows) => Array.isArray(rows[0]?.tags) && rows[0]?.tags.includes("smoke"),
				);
				expect(rows[0]?.title).toBe("Coupon case mine");
				expect(rows[0]?.covers).toEqual(["REQ-12"]);
				await expectNothingLeftToPropose(page);
			} finally {
				await close();
			}
		},
		30_000,
	);

for (const source of ["editor", "card"] as const)
	check(
		`a refused atomic merge keeps the ${source} body and tag for retry after reload`,
		async () => {
			const { server, page, close } = await card1({
				alsoTyped: (page) => caseTitle(page).fill(source === "editor" ? "Coupon case mine #smoke" : "Coupon case mine"),
			});
			try {
				await page.getByRole("button", { name: "Use my title", exact: true }).click();
				if (source === "card") await mergedTitle(page).fill("Coupon case mine #smoke");
				await page.route("**/decide", async (route) =>
					route.fulfill({
						status: 403,
						contentType: "application/json",
						body: JSON.stringify({ ok: false, error: { code: "forbidden", message: "Metadata refused" } }),
					}),
				);
				await resolve(page);
				await page.waitForFunction(() => document.querySelector("#stat")?.textContent?.includes("Metadata refused"));
				const before = (await server.api("get", { refs: ["C-1"] }))[0];
				expect(before?.title).toBe("Coupon case theirs");
				expect(before?.tags).toEqual([]);
				await page.unroute("**/decide");
				await page.reload();
				await card(page).waitFor();
				await resolve(page);
				await eventually(
					() => server.api("get", { refs: ["C-1"] }),
					(rows) => Array.isArray(rows[0]?.tags) && rows[0]?.tags.includes("smoke"),
				);
				await expectNothingLeftToPropose(page);
			} finally {
				await close();
			}
		},
		30_000,
	);

for (const choice of ["my body", "current body"] as const)
	check(
		`the resolved ${choice} and its tags wait together for one policy review`,
		async () => {
			const { server, page, close } = await card1({
				alsoTyped: (page) => caseTitle(page).fill("Coupon case mine #smoke"),
			});
			const accept = async (q: string) => {
				const question = (await server.api("inbox", { kind: "adopt" })).items.find((item) => item.q === q);
				if (!question) throw Error("Missing adoption question");
				await server.api("decide", {
					q,
					onEvidence: question.evidenceHash,
					answer: { is: "accept" },
					reason: "Reviewed this proposal",
				});
			};
			try {
				const policy = await server.api("propose", { edits: [{ op: "policy", preset: "strict" }] });
				if (!policy.question) throw Error("Missing policy question");
				await accept(policy.question);
				await page
					.getByRole("button", { name: choice === "my body" ? "Use my title" : "Keep current version", exact: true })
					.click();
				await resolve(page);
				await card(page).waitFor({ state: "detached" });
				const waiting = (await server.api("inbox", { kind: "adopt", on: "C-1" })).items;
				expect(waiting).toHaveLength(1);
				await caseTitle(page).press("Control+Enter");
				expect((await server.api("inbox", { kind: "adopt", on: "C-1" })).items.map((item) => item.q)).toEqual(
					waiting.map((item) => item.q),
				);
				expect((await server.api("get", { refs: ["C-1"] }))[0]?.tags).toEqual([]);
				const bodyQuestion = waiting[0];
				if (!bodyQuestion) throw Error("Missing body question");
				await accept(bodyQuestion.q);
				await caseTitle(page).press("Control+Enter");
				expect((await server.api("get", { refs: ["C-1"] }))[0]?.title).toBe(
					choice === "my body" ? "Coupon case mine" : "Coupon case theirs",
				);
				expect((await server.api("inbox", { kind: "adopt", on: "C-1" })).items).toEqual([]);
				await expectNothingLeftToPropose(page);
				expect((await server.api("get", { refs: ["C-1"] }))[0]?.tags).toEqual(["smoke"]);
			} finally {
				await close();
			}
		},
		30_000,
	);

// The second independent check of this change (N2). The recorded version can hold a colleague's text in the
// very field the person types in afterwards: they took the current title, and the colleague changed it again
// before the merge arrived. The typed title was not written on that version, so it is not carried onto it.
check(
	"later card text in a field the recorded merge took from a colleague stays on the draft's own version and asks",
	async () => {
		const { server, page, close } = await card1();
		try {
			await page.getByRole("button", { name: "Use current title", exact: true }).click();
			await colleagueEdits(server, () => ({ title: "Colleague title, changed again" }));
			await failTheNextMerge(page, { reaches: true });
			await resolve(page);
			await kept(page);
			const merged = await head(server);
			expect(merged.version).toBe(4);
			expect(merged.title).toBe("Colleague title, changed again");
			expect(actions(merged)).toEqual(["Open the cart", MINE]);
			await mergedTitle(page).fill("Title typed after the merge");
			await resolve(page);
			await page.getByText("later text is kept", { exact: false }).first().waitFor();
			await card(page).waitFor({ state: "detached" });
			expect(await caseTitle(page).inputValue()).toBe("Title typed after the merge");
			await page.keyboard.press("Escape");
			await card(page).waitFor();
			expect(await head(server)).toEqual(merged);
			await resolve(page);
			const saved = await eventually(
				() => head(server),
				(value) => value.version === 5,
			);
			expect(saved.title).toBe("Title typed after the merge");
			expect(actions(saved)).toEqual(["Open the cart", MINE]);
		} finally {
			await close();
		}
	},
	30_000,
);

for (const resolution of ["adopted", "unchanged"]) {
	for (const remote of ["addition", "removal"]) {
		check(
			`an ${resolution} body resolution preserves concurrent requirement ${remote}s`,
			async () => {
				const { server, h, page, close } = await card1({
					covers: remote === "removal" ? ["REQ-100"] : [],
					alsoTyped: (page) => caseTitle(page).fill("Coupon case mine @REQ-101"),
				});
				try {
					await server.api("propose", {
						edits: [
							{ op: "cover", case: "C-1", requirement: "REQ-102", on: true },
							...(remote === "removal"
								? [{ op: "cover", case: "C-1", requirement: "REQ-100", on: false } satisfies Edit]
								: []),
						],
					});
					await page
						.getByRole("button", {
							name: resolution === "adopted" ? "Use all my changes" : "Keep current version",
							exact: true,
						})
						.click();
					await resolve(page);
					await card(page).waitFor({ state: "detached" });
					await expectNothingLeftToPropose(page);
					const saved = (await server.api("get", { refs: ["C-1"] }))[0];
					if (resolution === "adopted" && remote === "addition" && process.env.MAINWORTHY_LINK_SCREENSHOT)
						await page.screenshot({ path: process.env.MAINWORTHY_LINK_SCREENSHOT });
					expect(saved?.covers).toEqual(["REQ-101", "REQ-102"]);
					expect(saved?.title).toBe(resolution === "adopted" ? "Coupon case mine" : "Coupon case theirs");
					expect(h.errors).toEqual([]);
				} finally {
					await close();
				}
			},
			30_000,
		);
	}
	check(
		`an ${resolution} body resolution applies only the draft's tag delta over concurrent tag changes`,
		async () => {
			const { server, h, page, close } = await card1({
				tags: ["old"],
				alsoTyped: (page) => caseTitle(page).fill("Coupon case mine #mine"),
			});
			try {
				await server.api("propose", {
					edits: [{ op: "place", cases: ["C-1"], tags: { add: ["theirs"], remove: ["old"] } }],
				});
				await page
					.getByRole("button", {
						name: resolution === "adopted" ? "Use all my changes" : "Keep current version",
						exact: true,
					})
					.click();
				await resolve(page);
				await card(page).waitFor({ state: "detached" });
				await expectNothingLeftToPropose(page);
				expect((await server.api("get", { refs: ["C-1"] }))[0]?.tags).toEqual(["mine", "theirs"]);
				expect(h.errors).toEqual([]);
			} finally {
				await close();
			}
		},
		30_000,
	);
}
