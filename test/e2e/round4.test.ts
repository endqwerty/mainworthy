import { expect, test } from "bun:test";
import { z } from "zod";
import { Slot } from "../../src/web/runs/models.ts";
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
async function failures(server: Server, strict = false) {
	await cases(server);
	if (strict) {
		const proposed = await server.api("propose", { edits: [{ op: "policy", preset: "strict" }] });
		const q = (await server.api("inbox", { kind: "adopt" })).items.find((q) => q.q === proposed.question);
		if (q) await server.api("decide", { q: q.q, onEvidence: q.evidenceHash, answer: { is: "accept" } });
	}
	const producer = strict ? await grant(server, "pipeline", "ci") : server.token;
	for (let i = 1; i <= 3; i++)
		await server.api(
			"report",
			{
				target: { session: `r4-${i}` },
				results: [
					{
						test: { case: `C-${i}` },
						outcome: "fail",
						failure: {
							message: `${["Coupon failure", "Login failure", "Refund failure"][i - 1]}: expected ready, got broken`,
						},
					},
				],
			},
			{ token: producer },
		);
}
async function grant(server: Server, actor: string, kind: "human" | "ci" = "human") {
	return z.object({ token: z.string() }).parse(
		await server.api("admin", {
			do: "token.create",
			actor,
			kind,
			can: ["read", "produce", "answer"],
			project: "scratch",
		}),
	).token;
}
const title = (page: Awaited<ReturnType<typeof openPage>>["page"]) =>
	page.getByRole("textbox", { name: "Case title", exact: true });
const qref = (page: Awaited<ReturnType<typeof openPage>>["page"]) =>
	page.locator("[data-current-question]").getAttribute("data-current-question");
const ready = (page: Awaited<ReturnType<typeof openPage>>["page"]) =>
	page.locator('[data-active="true"][data-ready="true"]').waitFor();

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
			`R4A-1 conflict keeps later ${same ? "title" : "step"} text with seal ${seal}`,
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
					await (same ? title(page) : page.getByRole("textbox", { name: "Step 2", exact: true })).fill(
						same ? "My newer title" : "Step 2 with more words",
					);
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
					const expected = same ? "My newer title" : "Step 2 with more words";
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
	"R4A-2 duplicated tabs have distinct owners and both edits can record",
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
			expect(await a.evaluate(() => sessionStorage.getItem("casebook:draft-window"))).not.toBe(
				await b.evaluate(() => sessionStorage.getItem("casebook:draft-window")),
			);
			await b.getByRole("textbox", { name: "Step 1", exact: true }).fill("From B");
			await a.keyboard.press("Escape");
			await eventually(
				() => server.api("get", { refs: ["C-1"] }),
				(rows) => rows[0]?.version === 2,
			);
			await b.keyboard.press("Escape");
			const saved = await eventually(
				() => server.api("get", { refs: ["C-1"] }),
				(rows) => rows[0]?.version === 3,
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

for (const field of ["ref", "reason"])
	for (const leave of ["row", "kind", "state"])
		check(
			`R4B-4 ${field} closes and retains text on ${leave}`,
			async () => {
				const server = await startServer({ preset: "standard" });
				await failures(server, field === "reason");
				const h = await openPage(server, { path: "/p/scratch/queue" });
				try {
					const { page } = h;
					page.setDefaultTimeout(5000);
					await page.locator("[data-current-question]").waitFor();
					const q = await qref(page);
					if (!q) throw Error("No question");
					const qs = (await server.api("inbox", { kind: "failure" })).items;
					const other = qs.find((item) => item.q !== q);
					if (!other) throw Error("No other question");
					await page.keyboard.press(field === "ref" ? "d" : "f");
					await page.locator("#answer-extra").fill("Kept for this question");
					if (leave === "row") await page.locator(`[data-question="${other.q}"]`).click();
					else
						await page
							.getByRole("button", { name: leave === "kind" ? "Findings" : "Settled", exact: leave !== "kind" })
							.click();
					expect(await page.locator("#answer-extra").count()).toBe(0);
					expect((await server.api("get", { refs: [q] }))[0]?.state).toBe("open");
					expect(
						await page.evaluate(() =>
							Object.entries(localStorage)
								.filter(([k]) => k.includes(":queue-input:"))
								.map(([, v]) => v),
						),
					).toContain("Kept for this question");
					await page.getByRole("button", { name: "Open", exact: true }).click();
					await page.getByRole("button", { name: "All", exact: true }).click();
					await page.locator(`[data-question="${q}"]`).click();
					await page.keyboard.press(field === "ref" ? "d" : "f");
					expect(await page.locator("#answer-extra").inputValue()).toBe("Kept for this question");
				} finally {
					await h.close();
					await server.stop();
				}
			},
			30000,
		);

check(
	"R4B-3 each withdrawal follows its answer even while the first is held",
	async () => {
		const server = await startServer({ preset: "standard" });
		await failures(server);
		const h = await openPage(server, { path: "/p/scratch/queue" });
		const gate = latch();
		try {
			const { page } = h;
			page.setDefaultTimeout(5000);
			await page.locator("[data-current-question]").waitFor();
			const q = await qref(page);
			if (!q) throw Error("No question");
			const sent: string[] = [];
			await page.route("**/decide", async (route) => {
				const raw = z
					.object({
						q: z.string().optional(),
						undo: z.string().optional(),
						answer: z.object({ is: z.string() }).optional(),
					})
					.parse(route.request().postDataJSON());
				sent.push(`${raw.undo ?? raw.q}:${raw.undo ? "undo" : raw.answer?.is}`);
				if (sent.length === 1) await gate.held;
				await route.continue();
			});
			for (const key of ["f", "u", "i", "u", "t"]) await page.keyboard.press(key);
			gate.release();
			const saved = await eventually(
				() => server.api("get", { refs: [q] }),
				(rows) =>
					z.object({ answer: z.object({ is: z.string() }) }).safeParse(rows[0]?.decision).data?.answer.is === "test",
			);
			expect(saved[0]?.state).toBe("decided");
			expect(sent).toEqual([`${q}:flaky`, `${q}:undo`, `${q}:infra`, `${q}:undo`, `${q}:test`]);
		} finally {
			gate.release();
			await h.close();
			await server.stop();
		}
	},
	30000,
);

check(
	"R4B-5 disappeared bulk selections are removed with a message",
	async () => {
		const server = await startServer({ preset: "standard" });
		await failures(server);
		const h = await openPage(server, { path: "/p/scratch/queue" });
		try {
			const { page } = h;
			page.setDefaultTimeout(5000);
			await page.locator("[data-current-question]").waitFor();
			const q = await qref(page);
			const qs = (await server.api("inbox", { kind: "failure" })).items;
			const first = qs.find((item) => item.q === q),
				other = qs.find((item) => item.q !== q);
			if (!first || !other) throw Error("Missing questions");
			await page.keyboard.press("x");
			await server.api("decide", { q: first.q, onEvidence: first.evidenceHash, answer: { is: "infra" } });
			await page.locator(`[data-question="${first.q}"]`).waitFor({ state: "detached" });
			await page.getByText("removed from the selection", { exact: false }).waitFor();
			await page.locator(`[data-question="${other.q}"]`).click();
			await page.keyboard.press("i");
			await eventually(
				() => server.api("get", { refs: [other.q] }),
				(rows) => rows[0]?.state === "decided",
			);
		} finally {
			await h.close();
			await server.stop();
		}
	},
	30000,
);

check(
	"R4B-6 a failed withdrawal says what failed and can be retried",
	async () => {
		const server = await startServer({ preset: "standard" });
		await failures(server);
		const h = await openPage(server, { path: "/p/scratch/queue" });
		try {
			const { page } = h;
			page.setDefaultTimeout(5000);
			await page.locator("[data-current-question]").waitFor();
			const q = await qref(page);
			if (!q) throw Error("No question");
			await page.keyboard.press("f");
			await page.waitForFunction(() => document.querySelector(".queue-last")?.textContent?.includes("recorded"));
			let fail = true;
			await page.route("**/decide", async (route) => {
				if (fail && "undo" in route.request().postDataJSON()) {
					fail = false;
					await route.abort();
				} else await route.continue();
			});
			await page.keyboard.press("u");
			await page.getByText("the withdrawal failed", { exact: false }).first().waitFor();
			await page.keyboard.press("u");
			await eventually(
				() => server.api("get", { refs: [q] }),
				(rows) => rows[0]?.state === "open",
			);
		} finally {
			await h.close();
			await server.stop();
		}
	},
	30000,
);

for (const action of ["Escape", "Backspace", "pause", "key", "pass", "invalid"])
	check(
		`R4B-2 step mark can recover after ${action}`,
		async () => {
			const server = await startServer({ preset: "standard" });
			await cases(server);
			const run = await server.api("plan", { name: "Marks", select: {} });
			const h = await openPage(server, { path: `/p/scratch/runs/${run.run.slice(2)}` });
			try {
				const { page } = h;
				page.setDefaultTimeout(5000);
				await ready(page);
				await page.keyboard.press("2");
				if (action === "pause") {
					await page.waitForTimeout(800);
					await page.keyboard.press("3");
				} else if (action === "key") {
					await page.keyboard.press("j");
					await page.keyboard.press("k");
					await page.keyboard.press("3");
				} else if (action === "pass") {
					await page.keyboard.press("p");
					await eventually(
						() => server.api("find", { in: "slots", run: run.run }),
						(rows) => Slot.array().parse(rows.items)[0]?.fills[0]?.outcome === "pass",
					);
					await page.locator(".run-dot").first().click();
				} else if (action === "invalid") {
					await page.keyboard.press("9");
					await page.keyboard.press("f");
					await page.keyboard.type("Bad mark");
					await page.keyboard.press("Enter");
					await page.getByText("no step 29", { exact: false }).first().waitFor();
					await page.locator(".run-dot").first().click();
				} else await page.keyboard.press(action);
				const expected = ["pause", "key"].includes(action) ? "3" : "";
				expect(
					await page.evaluate(() =>
						Object.entries(localStorage)
							.filter(([k]) => k.includes(":run-step:"))
							.map(([, v]) => v),
					),
				).toEqual(expected ? [expected] : []);
				await page.keyboard.press("f");
				await page.getByRole("textbox", { name: "Result note" }).fill("Current failure");
				await page.keyboard.press("Enter");
				await eventually(
					() => server.api("find", { in: "slots", run: run.run }),
					(rows) => Slot.array().parse(rows.items)[0]?.fills[0]?.outcome === "fail",
				);
				expect((await server.api("timeline", { ref: "C-1" })).entries.find((e) => e.t === "result")?.atStep).toBe(
					expected ? "s3" : null,
				);
			} finally {
				await h.close();
				await server.stop();
			}
		},
		30000,
	);

check(
	"R4B-2 rapid digits still mark step twelve",
	async () => {
		const server = await startServer();
		await cases(server);
		const run = await server.api("plan", { name: "Twelve", select: {} });
		const h = await openPage(server, { path: `/p/scratch/runs/${run.run.slice(2)}` });
		try {
			await ready(h.page);
			await h.page.keyboard.press("1");
			await h.page.keyboard.press("2");
			expect(await h.page.locator('[data-active="true"] .mark').getAttribute("data-step")).toBe("s12");
		} finally {
			await h.close();
			await server.stop();
		}
	},
	30000,
);

check(
	"R4B-7 closed run explains Enter and retains the note",
	async () => {
		const server = await startServer({ preset: "standard" });
		await cases(server, 2);
		const run = await server.api("plan", { name: "Closing", select: {} });
		const tester = await grant(server, "tester");
		const h = await openPage(server, { path: `/p/scratch/runs/${run.run.slice(2)}` });
		try {
			const { page } = h;
			page.setDefaultTimeout(5000);
			await ready(page);
			await page.keyboard.press("p");
			await page.keyboard.press("f");
			await page.keyboard.type("Private note");
			await server.api(
				"report",
				{ run: run.run, results: [{ test: { case: "C-2" }, outcome: "pass" }] },
				{ token: tester },
			);
			await page.getByText("Filled by person tester", { exact: false }).waitFor();
			await page.keyboard.press("Enter");
			await page.getByText("This run is closed", { exact: false }).first().waitFor();
			expect(await page.getByRole("textbox", { name: "Result note" }).inputValue()).toBe("Private note");
		} finally {
			await h.close();
			await server.stop();
		}
	},
	30000,
);

check(
	"R4B-8 a pending failure note is not used by a later pass",
	async () => {
		const server = await startServer();
		await cases(server);
		const run = await server.api("plan", { name: "Correction", select: {} });
		const h = await openPage(server, { path: `/p/scratch/runs/${run.run.slice(2)}` });
		const gate = latch();
		try {
			const { page } = h;
			page.setDefaultTimeout(5000);
			await ready(page);
			let reports = 0;
			await page.route("**/report", async (route) => {
				if (++reports === 1) await gate.held;
				await route.continue();
			});
			await page.keyboard.press("f");
			await page.keyboard.type("wrong total");
			for (const key of ["Enter", "u", "u", "p"]) await page.keyboard.press(key);
			gate.release();
			const slots = await eventually(
				() => server.api("find", { in: "slots", run: run.run }),
				(rows) => Slot.array().parse(rows.items)[0]?.fills[0]?.outcome === "pass",
			);
			expect(Slot.array().parse(slots.items)[0]?.fills[0]?.note).toBeNull();
		} finally {
			gate.release();
			await h.close();
			await server.stop();
		}
	},
	30000,
);

for (const kind of ["failure", "finding", "map", "signoff", "adopt"])
	check(
		`R4B-1 unread ${kind} evidence refuses keys and buttons`,
		async () => {
			const server = await startServer({ preset: "standard" });
			await failures(server);
			const h = await openPage(server);
			try {
				const { page } = h;
				page.setDefaultTimeout(5000);
				await page.route("**/inbox", async (route) => {
					const response = await route.fetch();
					const raw = z
						.object({
							ok: z.literal(true),
							result: z.object({ items: z.array(z.record(z.string(), z.unknown())) }).passthrough(),
						})
						.parse(await response.json());
					const first = raw.result.items[0];
					if (first) raw.result.items = [{ ...first, kind, evidence: {}, answers: undefined }];
					await route.fulfill({ json: raw });
				});
				await page.goto(`${server.url}/p/scratch/queue`);
				await page.locator("[data-current-question]").waitFor();
				let calls = 0;
				page.on("request", (r) => {
					if (r.url().endsWith("/decide")) calls++;
				});
				for (const key of ["f", "i", "a", "r", "t", "m"]) await page.keyboard.press(key);
				expect(calls).toBe(0);
				expect(await page.locator(".queue-answers button:enabled").count()).toBe(0);
				expect(await page.locator("#stat").textContent()).toContain("could not be read");
			} finally {
				await h.close();
				await server.stop();
			}
		},
		30000,
	);

check(
	"R4B-1 late dispute preserves evidence and shows fresh permissions",
	async () => {
		const server = await startServer({ preset: "standard" });
		await cases(server, 2);
		const tester = await grant(server, "tester"),
			ci = await grant(server, "pipeline", "ci");
		const run = await server.api("plan", { name: "Dispute", select: {}, accepts: { commit: "rc4000010000" } });
		await server.api(
			"report",
			{
				run: run.run,
				results: [{ test: { case: "C-1" }, outcome: "fail", failure: { message: "expected 10, got 12" } }],
			},
			{ token: tester },
		);
		const h = await openPage(server, { path: "/p/scratch/queue" });
		try {
			const { page } = h;
			page.setDefaultTimeout(5000);
			await page.getByText("expected 10, got 12", { exact: true }).first().waitFor();
			await server.api(
				"report",
				{
					target: { commit: "rc4000010000", branch: "main" },
					results: [
						{
							test: { key: "tests/disputed", name: "Disputed", file: "tests/d.spec.ts" },
							outcome: "pass",
							annotation: { case: "C-1", version: 1 },
						},
					],
				},
				{ token: ci },
			);
			await page.getByText("A counted pass and fail disagree.", { exact: false }).waitFor();
			expect(await page.locator(".queue-log").textContent()).toContain("expected 10, got 12");
			await h.context.request.post(`${server.url}/api/login`, { data: { token: tester } });
			await page.reload();
			await page.getByText("You cannot settle this.", { exact: false }).waitFor();
			expect(await page.locator(".queue-answers button:enabled").count()).toBe(0);
		} finally {
			await h.close();
			await server.stop();
		}
	},
	30000,
);

check(
	"R4B-1 nullable failure message and sample remain readable",
	async () => {
		const server = await startServer({ preset: "standard" });
		await failures(server);
		const h = await openPage(server);
		try {
			const { page } = h;
			page.setDefaultTimeout(5000);
			await page.route("**/inbox", async (route) => {
				const response = await route.fetch();
				const raw = z
					.object({
						ok: z.literal(true),
						result: z
							.object({ items: z.array(z.object({ evidence: z.record(z.string(), z.unknown()) }).passthrough()) })
							.passthrough(),
					})
					.parse(await response.json());
				for (const item of raw.result.items) {
					item.evidence.message = null;
					item.evidence.sample = null;
				}
				await route.fulfill({ json: raw });
			});
			await page.goto(`${server.url}/p/scratch/queue`);
			await page.locator("[data-current-question]").waitFor();
			expect(await page.locator(".queue-evidence").textContent()).not.toContain("could not be read");
			expect(await page.locator(".queue-answers button:enabled").count()).toBeGreaterThan(0);
		} finally {
			await h.close();
			await server.stop();
		}
	},
	30000,
);

for (const surface of ["case", "run", "queue"])
	check(
		`R4C-1 server rejects ${surface} write after shared cookie changes without an extra session read`,
		async () => {
			const server = await startServer({ mode: "server", preset: "standard" });
			if (surface === "queue") await failures(server);
			else await cases(server);
			const run = await server.api("plan", { name: "Identity", select: {} });
			const alice = await grant(server, "alice"),
				bob = await grant(server, "bob");
			const h = await openPage(
				{ ...server, token: alice },
				{
					path:
						surface === "case"
							? "/p/scratch/suite/c/1"
							: surface === "queue"
								? "/p/scratch/queue"
								: `/p/scratch/runs/${run.run.slice(2)}`,
				},
			);
			try {
				const { page } = h;
				page.setDefaultTimeout(5000);
				if (surface === "case") {
					await page.getByRole("button", { name: "Case 1", exact: true }).waitFor();
					await page.keyboard.press("e");
					await title(page).fill("Alice private draft");
				} else if (surface === "run") {
					await ready(page);
					await page.keyboard.press("f");
					await page.keyboard.type("Alice private note");
				} else await page.locator("[data-current-question]").waitFor();
				const q = surface === "queue" ? await qref(page) : null;
				const op = surface === "case" ? "propose" : surface === "run" ? "report" : "decide";
				let actor: string | undefined;
				let sessions = 0;
				page.on("request", (r) => {
					if (r.url().endsWith("/session")) sessions++;
				});
				await page.route(`**/${op}`, async (route) => {
					actor = route.request().headers()["x-casebook-as"];
					await h.context.request.post(`${server.url}/api/login`, { data: { token: bob } });
					await route.continue();
				});
				await page.keyboard.press(surface === "case" ? "Control+Enter" : surface === "run" ? "Enter" : "f");
				await page.locator("#token").waitFor();
				expect(actor).toBe("alice");
				expect(sessions).toBe(0);
				expect((await server.api("get", { refs: ["C-1"] }))[0]?.version).toBe(1);
				expect(
					Slot.array().parse((await server.api("find", { in: "slots", run: run.run })).items)[0]?.fills.length,
				).toBe(0);
				if (q) expect((await server.api("get", { refs: [q] }))[0]?.state).toBe("open");
				else
					expect(
						await page.evaluate(() =>
							Object.entries(localStorage)
								.filter(([k]) => k.startsWith("casebook:alice:"))
								.map(([, v]) => v)
								.join(" "),
						),
					).toContain(surface === "case" ? "Alice private draft" : "Alice private note");
			} finally {
				await h.close();
				await server.stop();
			}
		},
		30000,
	);

check(
	"R4C-2 strict withdrawal asks for and records its own reason",
	async () => {
		const server = await startServer({ preset: "standard" });
		await failures(server, true);
		const h = await openPage(server, { path: "/p/scratch/queue" });
		try {
			const { page } = h;
			page.setDefaultTimeout(5000);
			await page.locator("[data-current-question]").waitFor();
			const q = await qref(page);
			if (!q) throw Error("No question");
			await page.keyboard.press("i");
			await page.locator("#answer-extra").fill("The runner was down");
			await page.keyboard.press("Enter");
			await page.waitForFunction(() => document.querySelector(".queue-last")?.textContent?.includes("recorded"));
			await page.keyboard.press("u");
			await page.locator("#answer-extra").fill("The runner is healthy, I read the wrong log");
			await page.keyboard.press("Enter");
			await eventually(
				() => server.api("get", { refs: [q] }),
				(rows) => rows[0]?.state === "open",
			);
			expect(await page.locator("#answer-extra").count()).toBe(0);
		} finally {
			await h.close();
			await server.stop();
		}
	},
	30000,
);
for (const surface of ["capture", "edit", "run", "planner", "queue", "settings"])
	check(
		`R4C-3 ${surface} opening key repeats stay out of its field until keyup`,
		async () => {
			const server = await startServer({ preset: "standard" });
			await failures(server);
			const run = await server.api("plan", { name: "Repeats", select: {} });
			const path =
				surface === "run"
					? `/p/scratch/runs/${run.run.slice(2)}`
					: surface === "planner"
						? "/p/scratch/runs"
						: surface === "queue"
							? "/p/scratch/queue"
							: surface === "settings"
								? "/p/scratch/settings"
								: "/p/scratch/suite/c/1";
			const h = await openPage(server, { path });
			try {
				const { page } = h;
				page.setDefaultTimeout(5000);
				const key =
					surface === "capture"
						? "c"
						: surface === "edit"
							? "e"
							: surface === "run"
								? "f"
								: surface === "queue"
									? "d"
									: "n";
				let field = title(page);
				if (surface === "queue") {
					await page.locator("[data-current-question]").waitFor();
					field = page.locator("#answer-extra");
				} else if (surface === "run") {
					await ready(page);
					field = page.getByRole("textbox", { name: "Result note" });
				} else if (surface === "planner") field = page.locator("#run-name");
				else if (surface === "settings") {
					await page.getByRole("option", { name: "Tokens", exact: true }).click();
					field = page.locator("#token-actor");
				} else await page.getByRole("button", { name: "Case 1", exact: true }).waitFor();
				await page.keyboard.down(key);
				await field.waitFor();
				const before = await field.inputValue();
				for (let i = 0; i < 5; i++) await page.keyboard.down(key);
				await page.keyboard.up(key);
				expect(await field.inputValue()).toBe(before);
				await page.keyboard.down(key);
				await page.keyboard.down(key);
				await page.keyboard.up(key);
				expect(await field.inputValue()).toBe(before + key + key);
			} finally {
				await h.close();
				await server.stop();
			}
		},
		30000,
	);

check(
	"R4A-5 a live window's unfinished capture is not opened by another window",
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
			expect(await title(b).count()).toBe(0);
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

for (const action of ["close", "reload"])
	check(
		`R4C-4 ${action} sends the keepalive capture and recovery creates no duplicate`,
		async () => {
			const server = await startServer();
			const h = await openPage(server);
			try {
				const { page } = h;
				page.setDefaultTimeout(5000);
				await page.keyboard.press("c");
				await title(page).fill("Closing capture");
				await page.keyboard.press("Enter");
				await page.keyboard.type("The complete step");
				if (action === "close") await page.close({ runBeforeUnload: true });
				else await page.reload();
				await eventually(
					() => server.api("find", { in: "cases" }),
					(rows) => rows.items.some((row) => row.title === "Closing capture"),
				);
				const returning = action === "close" ? await h.context.newPage() : page;
				returning.setDefaultTimeout(5000);
				if (action === "close") await returning.goto(`${server.url}/p/scratch/suite`);
				await returning.locator("#app").waitFor();
				await returning.keyboard.press("Control+Enter");
				await eventually(
					async () => await returning.locator("#stat").textContent(),
					(text) => Boolean(text?.includes("Version")),
				);
				expect((await server.api("find", { in: "cases" })).items).toHaveLength(1);
				expect((await server.api("get", { refs: ["C-1"] }))[0]).toMatchObject({ title: "Closing capture", version: 1 });
			} finally {
				await h.close();
				await server.stop();
			}
		},
		30000,
	);

for (const refusal of ["401", "502"])
	check(
		`R4C-5 an idle event stream's ${refusal} checks the session and recovers`,
		async () => {
			const server = await startServer({ mode: "server" });
			await cases(server, 1);
			const token = await grant(server, "reader");
			const h = await openPage({ ...server, token });
			const gate = latch();
			try {
				const { page } = h;
				page.setDefaultTimeout(5000);
				let streams = 0;
				await page.route("**/events", async (route) => {
					if (++streams === 1) {
						await gate.held;
						await route.fulfill({ status: Number(refusal), body: "Unavailable" });
					} else await route.continue();
				});
				await page.reload();
				await page.locator("#app").waitFor();
				await eventually(
					async () => streams,
					(n) => n === 1,
				);
				if (refusal === "401") {
					const row = z
						.array(z.object({ id: z.number(), actor: z.string() }))
						.parse(await server.api("admin", { do: "token.list" }))
						.find((row) => row.actor === "reader");
					if (!row) throw Error("No token");
					await server.api("admin", { do: "token.revoke", id: row.id });
				}
				gate.release();
				if (refusal === "401") await page.locator("#token").waitFor();
				else {
					await eventually(
						async () => streams,
						(n) => n > 1,
					);
					await server.api("propose", { edits: [{ op: "create", outline: "Arrived after reconnect" }] });
					await page.getByRole("option").filter({ hasText: "Arrived after reconnect" }).waitFor();
				}
			} finally {
				gate.release();
				await h.close();
				await server.stop();
			}
		},
		30000,
	);

for (const read of ["held", "failed"])
	check(
		`R4B-1 finding answers wait for a ${read} suggested-edit read`,
		async () => {
			const server = await startServer({ preset: "standard" });
			await cases(server, 1);
			await server.api("claim", {
				lens: "browser-regression",
				findings: [
					{
						on: "C-1#s2",
						category: "ambiguous",
						note: "Name the expected message",
						suggest: { step: "s2", expected: "Coupon accepted" },
					},
				],
			});
			const h = await openPage(server);
			const gate = latch();
			try {
				const { page } = h;
				page.setDefaultTimeout(5000);
				await page.route("**/get", async (route) => {
					const input = z.object({ refs: z.array(z.string()) }).parse(route.request().postDataJSON());
					if (input.refs.includes("C-1")) {
						if (read === "held") await gate.held;
						else {
							await route.fulfill({
								json: { ok: false, error: { code: "internal", message: "Suggested edit read failed" } },
							});
							return;
						}
					}
					await route.continue();
				});
				await page.goto(`${server.url}/p/scratch/queue`);
				await page.locator("[data-current-question]").waitFor();
				if (read === "failed") await page.getByText("Suggested edit read failed", { exact: false }).waitFor();
				let writes = 0;
				page.on("request", (r) => {
					if (r.url().endsWith("/decide")) writes++;
				});
				await page.keyboard.press("a");
				await page.keyboard.press("r");
				const buttons = page.locator(".queue-answers button");
				for (let i = 0; i < (await buttons.count()); i++)
					if (await buttons.nth(i).isEnabled()) await buttons.nth(i).click();
				expect(writes).toBe(0);
				gate.release();
				if (read === "held") {
					await page.locator(".queue-evidence .diff").waitFor();
					await page.keyboard.press("a");
					await eventually(
						() => server.api("inbox", { state: "decided", kind: "finding" }),
						(reply) => reply.items.length === 1,
					);
				}
			} finally {
				gate.release();
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
