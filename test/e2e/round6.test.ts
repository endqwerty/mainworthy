import { expect, test } from "bun:test";
import type { Page } from "playwright-core";
import { z } from "zod";
import { emptyBody } from "../../src/core/model.ts";
import { browserAvailable, eventually, openPage, type Server, startServer } from "./support.ts";

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
			const server = await startServer();
			await cases(server);
			const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
			try {
				const { page } = h;
				page.setDefaultTimeout(5000);
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

check(
	"R6-1 a held conflict reply includes every character typed before it arrives",
	async () => {
		const server = await startServer();
		await cases(server);
		const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
		const gate = latch();
		try {
			const { page } = h;
			page.setDefaultTimeout(5000);
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
		const server = await startServer();
		await cases(server);
		const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
		const gate = latch();
		try {
			const { page } = h;
			page.setDefaultTimeout(5000);
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
			const server = await startServer();
			await cases(server);
			const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
			try {
				let page = h.page;
				page.setDefaultTimeout(5000);
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
					page.setDefaultTimeout(5000);
					await page.goto(`${server.url}/p/scratch/suite/c/1`);
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
			const server = await startServer();
			await cases(server);
			const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
			try {
				const { page } = h;
				page.setDefaultTimeout(5000);
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
				returned.setDefaultTimeout(5000);
				await returned.goto(`${server.url}/p/scratch/suite/c/1`);
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
		const server = await startServer({ preset: "standard" });
		await cases(server, 3);
		const run = await server.api("plan", { name: "Marked correction", select: {} });
		const h = await openPage(server, { path: `/p/scratch/runs/${run.run.slice(2)}` });
		const gate = latch();
		try {
			const { page } = h;
			page.setDefaultTimeout(5000);
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
	"R5B-1 a failed note request behind a later write releases the note for the next shortcut",
	async () => {
		const server = await startServer({ preset: "standard" });
		await cases(server, 3);
		const run = await server.api("plan", { name: "Release note", select: {} });
		const h = await openPage(server, { path: `/p/scratch/runs/${run.run.slice(2)}` });
		const first = latch();
		const second = latch();
		try {
			const { page } = h;
			page.setDefaultTimeout(5000);
			await page.locator('[data-active="true"][data-ready="true"]').waitFor();
			const requests: unknown[] = [];
			await page.route("**/report", async (route) => {
				requests.push(route.request().postDataJSON());
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
			const notes = z.object({ results: z.array(z.object({ note: z.string().optional() })) });
			expect(notes.parse(requests[1]).results[0]?.note).toBeUndefined();
			expect(notes.parse(requests[2]).results[0]?.note).toBe("wrong total");
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
		const server = await startServer();
		await cases(server);
		const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
		const gate = latch();
		try {
			const { page } = h;
			page.setDefaultTimeout(5000);
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

for (const received of [false, true])
	check(
		`R6-2 a ${received ? "lost reply" : "failed merge request"} keeps the draft and card for retry`,
		async () => {
			const server = await startServer();
			await cases(server);
			const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
			const gate = latch();
			try {
				const { page } = h;
				page.setDefaultTimeout(5000);
				await conflict(server, page);
				await page.getByRole("textbox", { name: "Merged title", exact: true }).fill("Merge to retry");
				let sent = false;
				await page.route("**/decide", async (route) => {
					sent = true;
					if (received) await route.fetch();
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
				await page.waitForTimeout(300);
				expect(await page.locator(".conflict-card").count()).toBe(1);
				expect(await page.getByRole("textbox", { name: "Merged title", exact: true }).inputValue()).toBe(
					"Merge to retry after failure",
				);
				expect((await drafts(page)).join(" ")).toContain("Merge to retry");
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
		const server = await startServer();
		await cases(server);
		const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
		try {
			const first = h.page;
			first.setDefaultTimeout(5000);
			await conflict(server, first);
			await first.getByRole("button", { name: "Use my title", exact: true }).click();
			await first.close();
			const page = await h.context.newPage();
			page.setDefaultTimeout(5000);
			await page.goto(`${server.url}/p/scratch/suite/c/1`);
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
