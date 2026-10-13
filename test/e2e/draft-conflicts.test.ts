// Drafts and conflicts in the case editor: the findings of the fourth review (R4A).
import { expect, test } from "bun:test";
import { z } from "zod";
import { browserAvailable, eventually, openPage, type Server, startServer } from "./support.ts";

const check = test.skipIf(!browserAvailable);
const latch = () => {
	let release = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { held, release };
};
async function cases(server: Server, count = 3) {
	await server.api("propose", {
		edits: Array.from({ length: count }, (_, i) => ({
			op: "create",
			body: {
				title: `Case ${i + 1}`,
				methods: ["human", "auto"],
				steps: Array.from({ length: 12 }, (_, n) => ({ id: `s${n + 1}`, action: `Step ${n + 1}`, expected: null })),
			},
		})),
	});
}
const title = (page: Awaited<ReturnType<typeof openPage>>["page"]) =>
	page.getByRole("textbox", { name: "Case title", exact: true });

for (const kind of ["edit", "new"])
	for (const leave of ["click", "j", "route", "capture", "idle"])
		check(
			`R4A-3 ${kind} text typed during a held seal survives ${leave}`,
			async () => {
				const server = await startServer();
				await cases(server);
				const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
				const gate = latch();
				try {
					const { page } = h;
					page.setDefaultTimeout(5000);
					await page.getByRole("button", { name: "Case 1", exact: true }).waitFor();
					let seen = 0;
					await page.route("**/propose", async (route) => {
						const response = await route.fetch();
						if (++seen === 1) await gate.held;
						await route.fulfill({ response });
					});
					if (leave === "idle") await page.clock.install();
					await page.keyboard.press(kind === "edit" ? "e" : "c");
					await title(page).fill("Draft first");
					if (leave === "idle") await page.clock.fastForward(30_001);
					else await page.keyboard.press("Escape");
					await eventually(
						async () => seen,
						(n) => n === 1,
					);
					await title(page).fill("Draft first with more words");
					if (leave === "click") await page.getByRole("option").filter({ hasText: "C-2" }).click();
					else if (leave === "capture") {
						await page.keyboard.press("Shift+Enter");
						await title(page).fill("Next capture");
					} else if (leave === "j" || leave === "idle") {
						await page.keyboard.press("Escape");
						await page.keyboard.press("j");
					} else await page.getByRole("link", { name: "Runs", exact: true }).click();
					gate.release();
					const ref = kind === "edit" ? "C-1" : "C-4";
					const saved = await eventually(
						() => server.api("get", { refs: [ref] }),
						(rows) => rows[0]?.title === "Draft first with more words",
					);
					expect(saved[0]?.version).toBe(kind === "edit" ? 3 : 2);
					if (leave === "capture") expect(await title(page).inputValue()).toBe("Next capture");
					else expect(await page.locator("#detail [data-field=title]").count()).toBe(0);
				} finally {
					gate.release();
					await h.close();
					await server.stop();
				}
			},
			30000,
		);

for (const same of [false, true])
	for (const seal of [false, true])
		check(
			`R4A-1 conflict visibly refuses later ${same ? "title" : "step"} input with seal ${seal}`,
			async () => {
				const server = await startServer();
				await cases(server, 1);
				const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
				try {
					const { page } = h;
					page.setDefaultTimeout(5000);
					await page.getByRole("button", { name: "Case 1", exact: true }).waitFor();
					await page.keyboard.press("e");
					await title(page).fill("My title");
					await server.api("propose", {
						edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Their title" } }],
					});
					await page.keyboard.press("Escape");
					await page.locator(".conflict-card").waitFor();
					const field = same ? title(page) : page.getByRole("textbox", { name: "Step 2", exact: true });
					await field.click();
					await field.press("End");
					await page.keyboard.type(" with more words");
					expect(await field.inputValue()).toBe(same ? "My title" : "Step 2");
					await page.getByText("Resolve the conflict first", { exact: false }).first().waitFor();
					if (seal) {
						await page.keyboard.press("Escape");
						await page.waitForTimeout(200);
					}
					await page.getByRole("button", { name: "Use my title", exact: true }).click();
					await page.getByRole("button", { name: "Resolve conflict", exact: true }).click();
					await eventually(
						() => server.api("get", { refs: ["C-1"] }),
						(rows) => rows[0]?.version === 3,
					);
					const expected = same ? "My title" : "Step 2";
					const held = await page.evaluate(() =>
						Object.entries(localStorage)
							.filter(([k]) => k.includes(":draft:"))
							.map(([, v]) => v)
							.join(" "),
					);
					const saved = (await server.api("get", { refs: ["C-1"] }))[0];
					expect(JSON.stringify(saved).includes(expected) || held.includes(expected)).toBe(true);
					if (held.includes(expected)) {
						await page.keyboard.press("Escape");
						await eventually(
							() => server.api("get", { refs: ["C-1"] }),
							(rows) => JSON.stringify(rows).includes(expected),
						);
					}
				} finally {
					await h.close();
					await server.stop();
				}
			},
			30000,
		);

check(
	"R4A-2 duplicated tabs have distinct owners and transfer the complete draft deliberately",
	async () => {
		const server = await startServer();
		await cases(server, 1);
		const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
		try {
			const a = h.page;
			a.setDefaultTimeout(5000);
			await a.getByRole("button", { name: "Case 1", exact: true }).waitFor();
			await a.keyboard.press("e");
			await title(a).fill("From A");
			const [b] = await Promise.all([
				h.context.waitForEvent("page"),
				a.evaluate(() => void window.open(location.href)),
			]);
			b.setDefaultTimeout(5000);
			await title(b).waitFor();
			expect(await a.evaluate(() => sessionStorage.getItem("mainworthy:draft-window"))).not.toBe(
				await b.evaluate(() => sessionStorage.getItem("mainworthy:draft-window")),
			);
			expect(await title(b).evaluate((el) => el instanceof HTMLTextAreaElement && el.readOnly)).toBe(true);
			await title(b).press("X");
			await b.locator("#bar").filter({ hasText: "This case is being edited in another window" }).waitFor();
			await b.getByRole("button", { name: "Take over here", exact: true }).click();
			await eventually(() => title(a).evaluate((el) => el instanceof HTMLTextAreaElement && el.readOnly), Boolean);
			await b.getByRole("textbox", { name: "Step 1", exact: true }).fill("From B");
			await a.keyboard.press("Escape");
			expect((await server.api("get", { refs: ["C-1"] }))[0]?.version).toBe(1);
			await b.keyboard.press("Escape");
			const saved = await eventually(
				() => server.api("get", { refs: ["C-1"] }),
				(rows) => rows[0]?.version === 2,
			);
			expect(saved[0]?.title).toBe("From A");
			expect(z.array(z.object({ action: z.string() })).parse(saved[0]?.steps)[0]?.action).toBe("From B");
		} finally {
			await h.close();
			await server.stop();
		}
	},
	30000,
);

check(
	"R4A-2 a refused command retries current text under a fresh command",
	async () => {
		const server = await startServer();
		await cases(server, 1);
		const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
		try {
			const { page } = h;
			page.setDefaultTimeout(5000);
			await page.getByRole("button", { name: "Case 1", exact: true }).waitFor();
			const sent: { cmd: string; edits: unknown[] }[] = [];
			await page.route("**/propose", async (route) => {
				sent.push(z.object({ cmd: z.string(), edits: z.array(z.unknown()) }).parse(route.request().postDataJSON()));
				if (sent.length === 1)
					await route.fulfill({
						json: {
							ok: false,
							error: { code: "conflict", message: "this command id was already used for another request" },
						},
					});
				else await route.continue();
			});
			await page.keyboard.press("e");
			await title(page).fill("Refused title");
			await page.keyboard.press("Escape");
			await page.getByText("this command id was already used", { exact: false }).waitFor();
			await title(page).fill("Current title");
			await page.keyboard.press("Escape");
			await eventually(
				() => server.api("get", { refs: ["C-1"] }),
				(rows) => rows[0]?.title === "Current title",
			);
			expect(sent[0]?.cmd).not.toBe(sent[1]?.cmd);
		} finally {
			await h.close();
			await server.stop();
		}
	},
	30000,
);

check(
	"R4A-5 a live window's unfinished capture is read-only in another window",
	async () => {
		const server = await startServer();
		await cases(server, 1);
		const h = await openPage(server);
		try {
			const a = h.page;
			a.setDefaultTimeout(5000);
			await a.keyboard.press("c");
			await title(a).fill("Refund to the original pay");
			const b = await h.context.newPage();
			b.setDefaultTimeout(5000);
			await b.goto(`${server.url}/p/scratch/suite`);
			await b.locator("#app").waitFor();
			await title(b).waitFor();
			expect(await title(b).evaluate((el) => el instanceof HTMLTextAreaElement && el.readOnly)).toBe(true);
			await title(b).press("X");
			await b.locator("#bar").filter({ hasText: "This case is being edited in another window" }).waitFor();
			await b.keyboard.press("Escape");
			await title(a).click();
			await a.keyboard.press("End");
			await a.keyboard.type("ment method");
			await a.keyboard.press("Escape");
			await eventually(
				() => server.api("find", { in: "cases" }),
				(rows) => rows.items.some((row) => row.title === "Refund to the original payment method"),
			);
			expect((await server.api("find", { in: "cases" })).items.map((row) => row.title).sort()).toEqual([
				"Case 1",
				"Refund to the original payment method",
			]);
		} finally {
			await h.close();
			await server.stop();
		}
	},
	30000,
);

check(
	"R4A-1 a conflict after a missing reply shows the current draft, not the earlier send",
	async () => {
		const server = await startServer();
		await cases(server, 1);
		const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
		try {
			const { page } = h;
			page.setDefaultTimeout(5000);
			await page.getByRole("button", { name: "Case 1", exact: true }).waitFor();
			let fail = true;
			await page.route("**/propose", async (route) => {
				if (fail) {
					fail = false;
					await route.abort();
				} else await route.continue();
			});
			await page.keyboard.press("e");
			await title(page).fill("My first text");
			await page.keyboard.press("Escape");
			await page.getByText("kept on this device", { exact: false }).waitFor();
			await server.api("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Their title" } }] });
			await title(page).fill("My complete current text");
			await page.keyboard.press("Escape");
			await page.locator(".conflict-card").waitFor();
			expect(await page.locator(".conflict-side").first().innerText()).toContain("My complete current text");
			await page.getByRole("button", { name: "Use my title", exact: true }).click();
			await page.getByRole("button", { name: "Resolve conflict", exact: true }).click();
			await eventually(
				() => server.api("get", { refs: ["C-1"] }),
				(rows) => rows[0]?.title === "My complete current text",
			);
		} finally {
			await h.close();
			await server.stop();
		}
	},
	30000,
);

for (const rejection of ["API", "UI"])
	check(
		`R4A-2 a conflict rejected through ${rejection} releases its card and draft for fresh editing`,
		async () => {
			const server = await startServer();
			await cases(server, 1);
			const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
			try {
				const { page } = h;
				page.setDefaultTimeout(5000);
				await page.getByRole("button", { name: "Case 1", exact: true }).waitFor();
				await page.keyboard.press("e");
				await title(page).fill("My title");
				await server.api("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Their title" } }] });
				await page.keyboard.press("Escape");
				await page.locator(".conflict-card").waitFor();
				const q = (await server.api("inbox", { kind: "adopt" })).items[0];
				if (!q) throw Error("No conflict question");
				if (rejection === "API")
					await server.api("decide", { q: q.q, onEvidence: q.evidenceHash, answer: { is: "reject" } });
				else {
					await page.locator(`[data-proposal="${q.q}"][data-proposal-read="ready"]`).waitFor();
					await page.keyboard.press("r");
					await page.keyboard.press("r");
				}
				await page.locator(".conflict-card").waitFor({ state: "detached" });
				await page.getByRole("textbox", { name: "Step 2", exact: true }).fill("My fresh step");
				await page.keyboard.press("Escape");
				await page.locator(".conflict-card").waitFor();
				const next = (await server.api("inbox", { kind: "adopt" })).items[0];
				expect(next?.q).not.toBe(q.q);
				await page.getByRole("button", { name: "Use my title", exact: true }).click();
				await page.getByRole("button", { name: "Resolve conflict", exact: true }).click();
				const saved = await eventually(
					() => server.api("get", { refs: ["C-1"] }),
					(rows) => rows[0]?.version === 3,
				);
				expect(z.array(z.object({ action: z.string() })).parse(saved[0]?.steps)[1]?.action).toBe("My fresh step");
			} finally {
				await h.close();
				await server.stop();
			}
		},
		30000,
	);
