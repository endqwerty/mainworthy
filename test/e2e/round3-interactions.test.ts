import { expect, test } from "bun:test";
import { z } from "zod";
import { Slot } from "../../src/web/runs/models.ts";
import {
	answer,
	answerWhenRead,
	browserAvailable,
	eventually,
	fetched,
	openPage,
	type Server,
	startServer,
} from "./support.ts";

const check = test.skipIf(!browserAvailable);
const setupCases = (server: Server, count = 3) =>
	server.api("propose", {
		edits: Array.from({ length: count }, (_, i) => ({
			op: "create",
			outline: `Case ${i + 1}\n  Open cart > Ready\n  Apply coupon > Discount`,
		})),
	});
const failure = (server: Server, n: number) =>
	server.api("report", {
		target: { session: `failure-${n}` },
		results: [{ test: { case: `C-${n}` }, outcome: "fail", failure: { message: `expected ${n}, got 0` } }],
	});
const currentQ = (page: Awaited<ReturnType<typeof openPage>>["page"]) =>
	page.locator("[data-current-question]").getAttribute("data-current-question");
const latch = () => {
	let release = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { held, release };
};

check(
	"R3B-1 answer, undo, answer waits for the undo before sending the next answer",
	async () => {
		const server = await startServer({ preset: "standard" });
		await setupCases(server);
		await failure(server, 1);
		await failure(server, 2);
		const h = await openPage(server, { path: "/p/scratch/queue" });
		const gate = latch();
		try {
			const { page } = h;
			page.setDefaultTimeout(5000);
			await page.locator("[data-current-question]").waitFor();
			const q = await currentQ(page);
			if (!q) throw new Error("No question");
			const sent: string[] = [];
			await page.route("**/decide", async (route) => {
				const raw = z
					.object({ undo: z.string().optional(), answer: z.object({ is: z.string() }).optional() })
					.parse(route.request().postDataJSON());
				sent.push(raw.undo ? "undo" : (raw.answer?.is ?? ""));
				if (sent.length === 1) await gate.held;
				await route.continue();
			});
			await page.keyboard.press("f");
			await page.keyboard.press("u");
			await page.keyboard.press("i");
			await eventually(
				async () => sent.length,
				(n) => n > 0,
			);
			expect(sent).toEqual(["flaky"]);
			gate.release();
			await page.waitForFunction(() => document.querySelector(".queue-last")?.textContent?.includes("recorded"));
			const reply = (await server.api("get", { refs: [q] }))[0];
			expect(reply?.state).toBe("decided");
			expect(reply?.decision).toMatchObject({ answer: { is: "infra" } });
			expect(sent).toEqual(["flaky", "undo", "infra"]);
		} finally {
			gate.release();
			await h.close();
			await server.stop();
		}
	},
	30_000,
);

check(
	"R3B-2 the first queue cursor survives a new question and settlement elsewhere",
	async () => {
		const server = await startServer({ preset: "standard" });
		await setupCases(server);
		await failure(server, 1);
		const h = await openPage(server, { path: "/p/scratch/queue" });
		try {
			const { page } = h;
			page.setDefaultTimeout(5000);
			await page.locator("[data-current-question]").waitFor();
			const q = await currentQ(page);
			if (!q) throw new Error("No question");
			await failure(server, 2);
			const all = (await server.api("inbox", { kind: "failure" })).items;
			const other = all.find((row) => row.q !== q);
			if (!other) throw new Error("Second question missing");
			await page.locator(`[data-question="${other.q}"]`).waitFor();
			expect(await currentQ(page)).toBe(q);
			const original = all.find((row) => row.q === q);
			if (!original) throw new Error("Original missing");
			await page.keyboard.press("d");
			await page.locator("#answer-extra").fill("BUG-12");
			await server.api("decide", { q, onEvidence: original.evidenceHash, answer: { is: "infra" } });
			await page.waitForFunction(() => document.querySelector("#detail")?.textContent?.includes("settled"));
			expect(await currentQ(page)).toBe(q);
			expect(await page.locator("#answer-extra").inputValue()).toBe("BUG-12");
			await page.keyboard.type("34");
			expect(await page.locator("#answer-extra").inputValue()).toBe("BUG-1234");
			await page.keyboard.press("Enter");
			await page.keyboard.press("Escape");
			expect((await server.api("get", { refs: [q] }))[0]?.decision).toMatchObject({ answer: { is: "infra" } });
			expect((await server.api("get", { refs: [other.q] }))[0]?.state).toBe("open");
		} finally {
			await h.close();
			await server.stop();
		}
	},
	30_000,
);

// Issue #87. The test above failed in about one check of three on a 10-thread Mac and passed alone: the queue
// first reads a question when an answer to it is begun, and now and then the settlement fell between the
// server's reading and the page's receiving it. The page took that reply as the question's state and never said
// "settled". This is that order every time: the first read is held on its way back until the settlement is told.
check(
	"R3B-2 a question settled elsewhere while the queue first reads it is read again and shown as settled",
	async () => {
		const server = await startServer({ preset: "standard" });
		await setupCases(server);
		await failure(server, 1);
		const h = await openPage(server, { path: "/p/scratch/queue" });
		const read = latch();
		const told = latch();
		try {
			const { page } = h;
			page.setDefaultTimeout(5000);
			await page.locator("[data-current-question]").waitFor();
			const q = await currentQ(page);
			if (!q) throw new Error("No question");
			const original = (await server.api("inbox", { kind: "failure" })).items.find((row) => row.q === q);
			if (!original) throw new Error("Original missing");
			const states: string[] = [];
			await page.route("**/api/p/scratch/get", async (route) => {
				if (!route.request().postData()?.includes(`"${q}"`)) return route.continue();
				const reply = await fetched(route);
				if (!reply) return;
				const first = states.length === 0;
				states.push(
					z.object({ result: z.array(z.object({ state: z.string() })) }).parse(reply.json).result[0]?.state ?? "",
				);
				if (first) {
					read.release();
					await told.held;
				}
				await answer(route, { response: reply.response });
			});
			await page.keyboard.press("d");
			await page.locator("#answer-extra").fill("BUG-12");
			await read.held;
			// The page reads the inbox again when the settlement is told: that reply is the sign that it was.
			const inbox = page.waitForResponse((response) => response.url().endsWith("/api/p/scratch/inbox"));
			await server.api("decide", { q, onEvidence: original.evidenceHash, answer: { is: "infra" } });
			await inbox;
			// Enter while the page is still reading says so, and says what it knows once the read comes back.
			await page.locator(`[data-question="${q}"]`).waitFor({ state: "detached" });
			await page.keyboard.press("Enter");
			await page.getByText("Reading this question before answering. Your note is kept.").waitFor();
			told.release();
			await page.waitForFunction(() => document.querySelector("#detail")?.textContent?.includes("settled"));
			await page.waitForFunction(() =>
				document.querySelector("#stat")?.textContent?.includes("This question was settled elsewhere."),
			);
			expect(states).toEqual(["open", "decided"]);
			expect(await page.locator("#answer-extra").inputValue()).toBe("BUG-12");
			expect(h.errors).toEqual([]);
		} finally {
			read.release();
			told.release();
			await h.close();
			await server.stop();
		}
	},
	30_000,
);

check(
	"R3B-2 a slot filled elsewhere keeps its first cursor, note, focus and remaining sentence",
	async () => {
		const server = await startServer();
		await setupCases(server);
		const run = await server.api("plan", { name: "External", select: {} });
		const tester = z.object({ token: z.string() }).parse(
			await server.api("admin", {
				do: "token.create",
				actor: "tester",
				kind: "human",
				can: ["read", "produce"],
				project: "scratch",
			}),
		).token;
		const h = await openPage(server, { path: `/p/scratch/runs/${run.run.slice(2)}` });
		try {
			const { page } = h;
			page.setDefaultTimeout(5000);
			await page.locator('[data-run-document="C-1"][data-active="true"][data-ready="true"]').waitFor();
			await page.keyboard.press("f");
			await page.keyboard.type("The total is wr");
			await server.api(
				"report",
				{ run: run.run, results: [{ test: { case: "C-1" }, outcome: "pass" }] },
				{ token: tester },
			);
			await page.getByText("Filled by person tester", { exact: false }).waitFor();
			expect(await page.locator('[data-run-document][data-active="true"]').getAttribute("data-run-document")).toBe(
				"C-1",
			);
			const note = page.getByRole("textbox", { name: "Result note" });
			expect(await note.isEnabled()).toBe(true);
			expect(await note.evaluate((e) => e === document.activeElement)).toBe(true);
			await page.keyboard.type("ong by two cents");
			expect(await note.inputValue()).toBe("The total is wrong by two cents");
			await page.keyboard.press("Enter");
			expect(
				Slot.array()
					.parse((await server.api("find", { in: "slots", run: run.run })).items)
					.map((slot) => slot.fills.length),
			).toEqual([1, 0, 0]);
		} finally {
			await h.close();
			await server.stop();
		}
	},
	30_000,
);

check(
	"R3B-3 undo moves immediately and a late reply never moves a newer note",
	async () => {
		const server = await startServer();
		await setupCases(server);
		const run = await server.api("plan", { name: "Undo", select: {} });
		const h = await openPage(server, { path: `/p/scratch/runs/${run.run.slice(2)}` });
		const gate = latch();
		try {
			const { page } = h;
			page.setDefaultTimeout(5000);
			await page.locator('[data-run-document="C-1"][data-active="true"][data-ready="true"]').waitFor();
			let count = 0;
			await page.route("**/report", async (route) => {
				if (++count === 1) await gate.held;
				await route.continue();
			});
			await page.keyboard.press("p");
			await page.keyboard.press("u");
			expect(await page.locator('[data-active="true"]').getAttribute("data-run-document")).toBe("C-1");
			await page.keyboard.press("j");
			await page.keyboard.press("f");
			await page.keyboard.type("Wrong total");
			const note = page.getByRole("textbox", { name: "Result note" });
			gate.release();
			await eventually(
				async () => count,
				(n) => n === 2,
			);
			await eventually(
				async () => Slot.array().parse((await server.api("find", { in: "slots", run: run.run })).items),
				(rows) => rows[0]?.fills[0]?.outcome === "skip",
			);
			expect(await page.locator('[data-active="true"]').getAttribute("data-run-document")).toBe("C-2");
			expect(await note.evaluate((e) => e === document.activeElement)).toBe(true);
			await page.keyboard.type(" at checkout");
			await page.keyboard.press("Enter");
			const slots = await eventually(
				async () => Slot.array().parse((await server.api("find", { in: "slots", run: run.run })).items),
				(rows) => rows[1]?.fills[0]?.outcome === "fail",
			);
			expect(slots[1]?.fills[0]?.note).toBe("Wrong total at checkout");
		} finally {
			gate.release();
			await h.close();
			await server.stop();
		}
	},
	30_000,
);

check(
	"R3B-4 a failed step-two failure keeps its step for the retry and reload",
	async () => {
		const server = await startServer();
		await setupCases(server);
		const run = await server.api("plan", { name: "Step retry", select: {} });
		const h = await openPage(server, { path: `/p/scratch/runs/${run.run.slice(2)}` });
		try {
			const { page } = h;
			page.setDefaultTimeout(5000);
			await page.locator('[data-active="true"][data-ready="true"]').waitFor();
			let refuse = true;
			await page.route("**/report", async (route) => {
				if (refuse)
					await route.fulfill({ json: { ok: false, error: { code: "internal", message: "Result unavailable" } } });
				else await route.continue();
			});
			await page.keyboard.press("2");
			await page.keyboard.press("f");
			await page.keyboard.type("Fails at step two");
			await page.keyboard.press("Enter");
			await page.waitForFunction(() => document.querySelector("#stat")?.textContent?.includes("Result unavailable"));
			await page.reload();
			await page.locator('[data-active="true"][data-ready="true"]').waitFor();
			expect(await page.locator('[data-active="true"] .mark').count()).toBe(1);
			refuse = false;
			await page.keyboard.press("f");
			await page.keyboard.press("Enter");
			await eventually(
				async () => Slot.array().parse((await server.api("find", { in: "slots", run: run.run })).items),
				(rows) => rows[0]?.fills[0]?.outcome === "fail",
			);
			expect((await server.api("timeline", { ref: "C-1" })).entries.find((entry) => entry.t === "result")?.atStep).toBe(
				z.array(z.object({ id: z.string() })).parse((await server.api("get", { refs: ["C-1"] }))[0]?.steps)[1]?.id,
			);
		} finally {
			await h.close();
			await server.stop();
		}
	},
	30_000,
);

for (const surface of ["case", "run", "queue"])
	for (const close of ["Escape", "Control+k"]) {
		check(
			`R3C-2 ${surface} palette restores the field and caret after ${close}`,
			async () => {
				const server = await startServer(surface === "queue" ? { preset: "standard" } : {});
				await setupCases(server);
				const run = await server.api("plan", { name: "Palette", select: {} });
				if (surface === "queue") await failure(server, 1);
				const h = await openPage(server, {
					path:
						surface === "run"
							? `/p/scratch/runs/${run.run.slice(2)}`
							: surface === "queue"
								? "/p/scratch/queue"
								: "/p/scratch/suite/c/1",
				});
				try {
					const { page } = h;
					page.setDefaultTimeout(5000);
					let field = page.locator("#answer-extra");
					if (surface === "case") {
						await page.getByRole("button", { name: "Case 1", exact: true }).waitFor();
						await page.keyboard.press("e");
						field = page.getByRole("textbox", { name: "Step 1", exact: true });
					} else if (surface === "run") {
						await page.locator('[data-active="true"][data-ready="true"]').waitFor();
						await page.keyboard.press("f");
						field = page.getByRole("textbox", { name: "Result note" });
					} else {
						await page.locator("[data-current-question]").waitFor();
						await page.keyboard.press("d");
						field = page.locator("#answer-extra");
					}
					await field.fill("First half");
					await page.keyboard.press("Control+k");
					await page.locator(".palette-input").waitFor();
					await page.keyboard.press(close);
					expect(await field.evaluate((e) => e === document.activeElement)).toBe(true);
					await page.keyboard.type(" and second half");
					expect(await field.inputValue()).toBe("First half and second half");
				} finally {
					await h.close();
					await server.stop();
				}
			},
			30_000,
		);
	}

for (const surface of ["case", "queue"])
	for (const read of ["slow", "failed"])
		for (const answer of ["a", "r"]) {
			check(
				`R3C-1 ${surface} ${answer} and buttons wait for a ${read} proposal read`,
				async () => {
					const server = await startServer({ preset: "standard" });
					await setupCases(server, 1);
					const agent = z.object({ token: z.string() }).parse(
						await server.api("admin", {
							do: "token.create",
							actor: "reviewer",
							kind: "agent",
							can: ["read", "produce"],
							project: "scratch",
						}),
					).token;
					const proposed = await server.api(
						"propose",
						{ edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Proposed title" } }] },
						{ token: agent },
					);
					if (!proposed.question || !proposed.proposal) throw new Error("Missing proposal");
					const h = await openPage(server);
					const gate = latch();
					try {
						const { page } = h;
						page.setDefaultTimeout(5000);
						let reads = 0;
						await page.route("**/get", async (route) => {
							const input = z.object({ refs: z.array(z.string()) }).parse(route.request().postDataJSON());
							if (input.refs.includes(proposed.proposal ?? "")) {
								reads++;
								if (read === "slow") await gate.held;
								else {
									await route.fulfill({
										json: { ok: false, error: { code: "internal", message: "Proposal read failed" } },
									});
									return;
								}
							}
							await route.continue();
						});
						await page.goto(`${server.url}${surface === "case" ? "/p/scratch/suite/c/1" : "/p/scratch/queue"}`);
						await page
							.locator(surface === "case" ? `[data-proposal="${proposed.question}"]` : "[data-current-question]")
							.waitFor();
						await eventually(
							async () => reads,
							(n) => n > 0,
						);
						if (read === "failed") await page.getByText("Proposal read failed", { exact: false }).waitFor();
						let decides = 0;
						page.on("request", (request) => {
							if (request.url().endsWith("/decide")) decides++;
						});
						await page.keyboard.press(answer);
						await page.keyboard.press(answer);
						expect(decides).toBe(0);
						const button = page
							.locator(surface === "case" ? ".pbtn button" : ".queue-answers button")
							.filter({ hasText: answer === "a" ? "Accept" : "Reject" })
							.first();
						if (await button.isEnabled()) await button.click();
						expect(decides).toBe(0);
						expect((await server.api("get", { refs: [proposed.question] }))[0]?.state).toBe("open");
						gate.release();
						if (read === "slow") {
							await answerWhenRead(page, proposed.question, answer);
							await eventually(
								() => server.api("get", { refs: [proposed.question ?? ""] }),
								(rows) => rows[0]?.state === "decided",
							);
						}
					} finally {
						gate.release();
						await h.close();
						await server.stop();
					}
				},
				30_000,
			);
		}

check(
	"R3C-4 held outcome and undo keys record once while held navigation still moves",
	async () => {
		const server = await startServer();
		await setupCases(server, 5);
		const run = await server.api("plan", { name: "Held key", select: {} });
		const h = await openPage(server, { path: `/p/scratch/runs/${run.run.slice(2)}` });
		try {
			const { page } = h;
			page.setDefaultTimeout(5000);
			await page.locator('[data-active="true"][data-ready="true"]').waitFor();
			await page.keyboard.down("p");
			for (let i = 0; i < 3; i++) await page.keyboard.down("p");
			await page.keyboard.up("p");
			expect(await page.locator('[data-active="true"]').getAttribute("data-run-document")).toBe("C-2");
			await page.keyboard.down("j");
			await page.keyboard.down("j");
			await page.keyboard.up("j");
			expect(await page.locator('[data-active="true"]').getAttribute("data-run-document")).toBe("C-4");
			await eventually(
				async () => Slot.array().parse((await server.api("find", { in: "slots", run: run.run })).items),
				(rows) => rows[0]?.fills.length === 1,
			);
			expect(
				Slot.array()
					.parse((await server.api("find", { in: "slots", run: run.run })).items)
					.filter((s) => s.fills.length),
			).toHaveLength(1);
		} finally {
			await h.close();
			await server.stop();
		}
	},
	30_000,
);

check(
	"R3C-4 held proposal answers cannot page or accept, and held letters still type in a field",
	async () => {
		const server = await startServer({ preset: "standard" });
		await setupCases(server, 1);
		const agent = z.object({ token: z.string() }).parse(
			await server.api("admin", {
				do: "token.create",
				actor: "reviewer",
				kind: "agent",
				can: ["read", "produce"],
				project: "scratch",
			}),
		).token;
		const proposed = await server.api(
			"propose",
			{
				edits: [
					{
						op: "edit",
						case: "C-1",
						base: 1,
						body: {
							steps: Array.from({ length: 35 }, (_, i) => ({
								id: `s${i.toString(36)}`,
								action: `Proposed step ${i}`,
								expected: "Ready",
							})),
						},
					},
				],
			},
			{ token: agent },
		);
		if (!proposed.question) throw new Error("Question missing");
		const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
		try {
			const { page } = h;
			page.setDefaultTimeout(5000);
			await page.setViewportSize({ width: 1280, height: 800 });
			const edits = page.locator(`[data-proposal-evidence="${proposed.question}"][data-proposal-read="ready"]`);
			await edits.waitFor();
			await page.keyboard.down("a");
			const position = await edits.evaluate((e) => e.scrollTop);
			for (let i = 0; i < 20; i++) await page.keyboard.down("a");
			await page.keyboard.up("a");
			expect(await edits.evaluate((e) => e.scrollTop)).toBe(position);
			expect((await server.api("get", { refs: [proposed.question] }))[0]?.state).toBe("open");
			await page.keyboard.press("e");
			const title = page.getByRole("textbox", { name: "Case title", exact: true });
			await title.fill("");
			await page.keyboard.down("p");
			await page.keyboard.down("p");
			await page.keyboard.up("p");
			expect(await title.inputValue()).toBe("pp");
		} finally {
			await h.close();
			await server.stop();
		}
	},
	30_000,
);

check(
	"a button in a list pane that is not a row takes its own Enter and Space when Tab reached it",
	async () => {
		const server = await startServer({ cases: 2 });
		await server.api("plan", { name: "Existing run", select: {} });
		const h = await openPage(server, { path: "/p/scratch/runs" });
		try {
			const { page } = h;
			page.setDefaultTimeout(5000);
			await page.getByRole("option").first().waitFor();
			const plan = page.locator(".run-plan-button");
			const name = page.locator("#run-name");
			// The screen's Enter opens the cockpit of the run that is selected, and a row has it from the key
			// whether or not it holds the focus. The button beside the rows is a button: it opens the planner.
			for (const key of ["Enter", "Space"]) {
				await plan.focus();
				await page.keyboard.press(key);
				await name.waitFor();
				expect(new URL(page.url()).pathname).toBe("/p/scratch/runs");
				await page.keyboard.press("Escape");
				await name.waitFor({ state: "detached" });
			}
			await page.getByRole("option").first().focus();
			await page.keyboard.press("Enter");
			await page.waitForURL(/\/p\/scratch\/runs\/\d+$/);
			expect(h.errors).toEqual([]);
		} finally {
			await h.close();
			await server.stop();
		}
	},
	30_000,
);
