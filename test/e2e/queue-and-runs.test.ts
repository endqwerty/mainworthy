// The queue and runs: the findings of the fourth review (R4B).
import { expect, test } from "bun:test";
import { z } from "zod";
import { Slot } from "../../src/web/runs/models.ts";
import { answer, browserAvailable, eventually, fetched, openPage, type Server, startServer } from "./support.ts";

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
			can: kind === "ci" ? ["read", "record"] : ["read", "produce", "answer"],
			project: "scratch",
		}),
	).token;
}
const qref = (page: Awaited<ReturnType<typeof openPage>>["page"]) =>
	page.locator("[data-current-question]").getAttribute("data-current-question");
const ready = (page: Awaited<ReturnType<typeof openPage>>["page"]) =>
	page.locator('[data-active="true"][data-ready="true"]').waitFor();

for (const scenario of [
	"single replacement",
	"settled replacement",
	"bulk replacement",
	"partial answer",
	"partial withdrawal",
])
	check(
		`undo receipts preserve other answers and partial outcomes: ${scenario}`,
		async () => {
			const server = await startServer({ preset: "standard" });
			await failures(server);
			const h = await openPage(server, { path: "/p/scratch/queue" });
			try {
				const { page } = h;
				page.setDefaultTimeout(5000);
				await page.locator("[data-current-question]").waitFor();
				const original = new Map<string, number>();
				const sent: { undo: string; ifDecision?: number | undefined }[] = [];
				let changed: string | undefined;
				let replacement: number | null = null;
				await page.route("**/decide", async (route) => {
					const input = route.request().postDataJSON();
					const replace = async () => {
						const q = (await server.api("inbox", { state: "decided" })).items.find((q) => q.q === changed);
						if (!q) throw Error("No decided question");
						replacement =
							(await server.api("decide", { q: q.q, onEvidence: q.evidenceHash, answer: { is: "defect" } }))[0]
								?.decision ?? null;
					};
					if ("undo" in input) {
						sent.push(z.object({ undo: z.string(), ifDecision: z.number().optional() }).parse(input));
						if (scenario === "settled replacement" && !changed) {
							changed = input.undo;
							await replace();
						}
						if (scenario === "partial withdrawal" && sent.length === 1) {
							changed = input.undo;
							await route.abort();
						} else await route.continue();
						return;
					}
					if (scenario === "partial answer") input.all[0].onEvidence = "stale";
					const response = await route.fetch({ postData: JSON.stringify(input) });
					const reply = z
						.object({ result: z.array(z.object({ q: z.string(), decision: z.number().nullable() })) })
						.parse(await response.json());
					for (const receipt of reply.result) if (receipt.decision !== null) original.set(receipt.q, receipt.decision);
					if (scenario.endsWith("replacement") && scenario !== "settled replacement") {
						changed = reply.result[0]?.q;
						await replace();
					}
					await route.fulfill({ response });
				});
				if (scenario !== "single replacement" && scenario !== "settled replacement") await page.keyboard.press("*");
				await page.keyboard.press("f");
				await page
					.locator(".queue-last")
					.getByText(scenario === "partial answer" ? "evidence changed" : "recorded", { exact: false })
					.waitFor();
				if (scenario === "settled replacement") {
					await page.getByRole("button", { name: "Settled", exact: true }).click();
					await page.locator(`[data-question="${[...original.keys()][0]}"]`).click();
					await page.locator(".queue-decision").waitFor();
				}
				await page.keyboard.press("u");
				await eventually(
					() => Promise.resolve(sent.length),
					(count) => count === original.size,
				);
				if (scenario !== "partial answer")
					await page.locator(".queue-last").getByText("withdrawal failed", { exact: false }).waitFor();
				await eventually(
					() => server.api("inbox", { state: "decided" }),
					(reply) => reply.items.filter((q) => q.kind === "failure").length === (scenario === "partial answer" ? 0 : 1),
				);
				for (const input of sent) expect(input.ifDecision).toBe(original.get(input.undo));
				if (scenario.endsWith("replacement")) {
					await page.keyboard.press("u");
					await eventually(
						() => Promise.resolve(sent.length),
						(count) => count === original.size + 1,
					);
					expect(sent.at(-1)?.undo).toBe(changed);
					expect(sent.at(-1)?.ifDecision).toBe(original.get(changed ?? ""));
					const rows = await server.api("get", { refs: [changed ?? ""] });
					expect(rows[0]?.decision).toMatchObject({ id: replacement, answer: { is: "defect" } });
				}
				if (scenario === "partial withdrawal") {
					await page.keyboard.press("u");
					await eventually(
						() => server.api("inbox", { state: "decided" }),
						(reply) => reply.items.filter((q) => q.kind === "failure").length === 0,
					);
					expect(sent).toHaveLength(original.size + 1);
					expect(sent.at(-1)?.undo).toBe(changed);
					expect(sent.at(-1)?.ifDecision).toBe(original.get(changed ?? ""));
				}
				expect(h.errors).toEqual(scenario === "partial withdrawal" ? ["Failed to load resource: net::ERR_FAILED"] : []);
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
					// The page asks for the inbox again by itself. One such request can be here when the test closes it.
					const reply = await fetched(route);
					if (!reply) return;
					const raw = z
						.object({
							ok: z.literal(true),
							result: z.object({ items: z.array(z.record(z.string(), z.unknown())) }).passthrough(),
						})
						.parse(reply.json);
					const first = raw.result.items[0];
					if (first) raw.result.items = [{ ...first, kind, evidence: {}, answers: undefined }];
					await answer(route, { json: raw });
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
				// The page asks for the inbox again by itself. One such request can be here when the test closes it.
				const reply = await fetched(route);
				if (!reply) return;
				const raw = z
					.object({
						ok: z.literal(true),
						result: z
							.object({ items: z.array(z.object({ evidence: z.record(z.string(), z.unknown()) }).passthrough()) })
							.passthrough(),
					})
					.parse(reply.json);
				for (const item of raw.result.items) {
					item.evidence.message = null;
					item.evidence.sample = null;
				}
				await answer(route, { json: raw });
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

check("a broad assertion shows its file split in the queue", async () => {
	const server = await startServer({ unlinked: "track" });
	try {
		const receipt = await server.api("report", {
			target: { commit: "broad-ui-01", branch: "main" },
			results: Array.from({ length: 60 }, (_, i) => ({
				test: { key: `file-${i % 6}.test.ts::test ${i}`, file: `file-${i % 6}.test.ts` },
				outcome: "fail",
				failure: { message: "assertion failed" },
			})),
		});
		expect(receipt.questions).toHaveLength(6);
		const h = await openPage(server, { path: "/p/scratch/queue" });
		try {
			h.page.setDefaultTimeout(5000);
			await h.page.locator("[data-current-question]").waitFor();
			expect(await h.page.locator(".queue-pane h2").textContent()).toMatch(
				/^Split by file \(file-[0-5]\.test\.ts\): assertion failed$/,
			);
			expect(await h.page.locator(".queue-title").allTextContents()).toHaveLength(6);
			expect(await h.page.locator(".queue-log").textContent()).toBe("assertion failed");
			expect(await h.page.locator("#detail").textContent()).toContain("10 tests share this cause");
		} finally {
			await h.close();
		}
	} finally {
		await server.stop();
	}
});
