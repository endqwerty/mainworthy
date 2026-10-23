// The queue and runs: the findings of the fourth review (R4B).
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { start } from "../../src/app/start.ts";
import type { Api, OpName } from "../../src/core/api.ts";
import { ANSWER_KEYS, type Kind } from "../../src/core/kinds.ts";
import { defaultConfig } from "../../src/server/kernel/app.ts";
import { jiraPort } from "../../src/server/trackers/jira.ts";
import ui from "../../src/web/index.html";
import { call } from "../../src/web/lib/api.ts";
import { Slot } from "../../src/web/runs/models.ts";
import { ciReport } from "../helpers.ts";
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
async function grant(server: Server, actor: string, kind: "human" | "agent" | "ci" = "human") {
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

for (const is of ["accept", "reject"] as const)
	check(
		`Queue describes what ${is} did to a proposal`,
		async () => {
			const server = await startServer({ preset: "standard" });
			await server.api("propose", { edits: [{ op: "create", outline: "Original title" }] });
			const agent = await grant(server, "reviewer", "agent");
			const proposed = await server.api(
				"propose",
				{ edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Proposed title" } }] },
				{ token: agent },
			);
			if (!proposed.question || !proposed.proposal) throw new Error("Expected a waiting proposal");
			const h = await openPage(server, { path: "/p/scratch/queue" });
			try {
				const { page } = h;
				await answerWhenRead(page, proposed.question, is === "accept" ? "a" : "r");
				await page.locator(".queue-last").getByText("recorded", { exact: false }).waitFor();
				expect(await page.locator("#bar [role=status]").innerText()).toBe(
					`${proposed.question} · ${is === "accept" ? "Accept. The adopted version stays in history." : "Reject. The proposal stays in history; the case is unchanged."}`,
				);
				const [question, proposal, current] = await server.api("get", {
					refs: [proposed.question, proposed.proposal, "C-1"],
				});
				expect(question).toMatchObject({ state: "decided", decision: { answer: { is } } });
				expect(proposal).toMatchObject({ ref: proposed.proposal });
				expect(current).toMatchObject({
					head: is === "accept" ? 2 : 1,
					title: is === "accept" ? "Proposed title" : "Original title",
				});
				expect(h.errors).toEqual([]);
			} finally {
				await h.close();
				await server.stop();
			}
		},
		30000,
	);

check(
	"Settled keeps an answer and its recorded ending after the cause passes",
	async () => {
		const server = await startServer({ preset: "standard" });
		const h = await openPage(server, { path: "/p/scratch/queue" });
		try {
			await server.api("propose", { edits: [{ op: "create", outline: "Checkout total" }] });
			const report = (commit: string, fail: Record<number, string> = {}) => {
				const data = ciReport({ commit, branch: "fix", pr: 408, n: 1, fail });
				return {
					...data,
					target: { ...data.target, url: "https://github.example/shop/pull/408" },
					results: data.results.map((result) => ({ ...result, test: { case: "C-1" } })),
				};
			};
			await server.api("report", report("trace408a", { 0: "expected 90, got 100" }));
			const question = (await server.api("inbox", { kind: "failure" })).items[0];
			if (!question) throw new Error("expected a failure question");
			await server.api("decide", {
				q: question.q,
				onEvidence: question.evidenceHash,
				answer: { is: "test" },
				reason: "The assertion needs a fix.",
			});
			const { page } = h;
			await page.getByRole("button", { name: "Settled", exact: true }).click();
			await page.locator(`[data-question="${question.q}"]`).click();
			const decision = page.locator(".queue-decision");
			await decision.getByText("The test is wrong", { exact: true }).waitFor();
			await decision.getByText("Decided by robin", { exact: false }).waitFor();
			await decision.getByText("The assertion needs a fix.", { exact: true }).waitFor();
			expect(await page.locator("#hints").getByText("Undo answer", { exact: false }).count()).toBe(1);
			await page.keyboard.press("Control+k");
			const palette = page.locator("[data-overlay=palette]");
			await palette.waitFor();
			expect(await palette.getByRole("option", { name: /Undo answer/ }).count()).toBe(1);
			await page.keyboard.press("Escape");
			await server.api("report", report("trace408b"));
			await decision
				.getByText("Every test it named passed on trace408b where it had failed; the answer ended.", { exact: true })
				.waitFor();
			expect(await decision.getByRole("button", { name: "Withdraw answer" }).count()).toBe(0);
			expect(await page.locator(`[data-question="${question.q}"] .blk`).count()).toBe(0);
			expect(await page.locator(".queue-heading .blk").count()).toBe(0);
			const footerUndo = await page.locator("#hints").getByText("Undo answer", { exact: false }).count();
			await page.keyboard.press("Control+k");
			await palette.waitFor();
			expect([footerUndo, await palette.getByRole("option", { name: /Undo answer/ }).count()]).toEqual([0, 0]);
			await page.keyboard.press("Escape");
			await page.keyboard.press("u");
			expect((await server.api("get", { refs: [question.q] }))[0]).toMatchObject({ state: "dissolved" });
			await page.reload();
			await decision
				.getByText("Every test it named passed on trace408b where it had failed; the answer ended.", { exact: true })
				.waitFor();
			await decision.getByText("Fixed by another commit of pr:408", { exact: false }).waitFor();
			await page.goto(`${server.url}/p/scratch/changes/pr%3A408`);
			const onChange = page.locator(".change-decision").filter({ hasText: question.q });
			await onChange.getByText("The test is wrong", { exact: true }).waitFor();
			await onChange
				.getByText(
					"Fixed by another commit of pr:408 · Every test it named passed on trace408b where it had failed; the answer ended.",
					{ exact: true },
				)
				.waitFor();
			// The pull request's address is shown as itself, not behind the change's key: a report supplies it.
			const link = page.locator(".change-link");
			await link.getByText("github.example/shop/pull/408", { exact: true }).waitFor();
			expect(await link.getAttribute("href")).toBe("https://github.example/shop/pull/408");
			expect(await page.locator("#detail .phead a.ref").count()).toBe(0);
			// However long the host, all of it shows: a clipped "github.com.…" could hide whose site it is.
			const long = ciReport({ commit: "long410a", branch: "long", pr: 410, n: 1 });
			const host = `github.com.${"a-very-long-label.".repeat(8)}attacker.example`;
			await server.api("report", { ...long, target: { ...long.target, url: `https://${host}/pull/410` } });
			await page.setViewportSize({ width: 1000, height: 700 });
			await page.goto(`${server.url}/p/scratch/changes/pr%3A410`);
			const shown = page.locator(".change-link");
			await shown.getByText(`${host}/pull/410`, { exact: true }).waitFor();
			expect(
				await shown.evaluate((element) => {
					const pane = element.closest(".pane")?.getBoundingClientRect();
					const box = element.getBoundingClientRect();
					return element.scrollWidth <= element.clientWidth && !!pane && box.right <= pane.right;
				}),
			).toBe(true);
			// An address that only looks like one is left out, and the page still reads.
			const odd = ciReport({ commit: "odd409a", branch: "odd", pr: 409, n: 1 });
			await server.api("report", { ...odd, target: { ...odd.target, url: "https://", title: "Odd address" } });
			await page.goto(`${server.url}/p/scratch/changes/pr%3A409`);
			await page.locator("#detail .phead").getByText("Odd address", { exact: true }).waitFor();
			expect(await page.locator(".change-link").count()).toBe(0);
			await page.goto(`${server.url}/p/scratch/changes/pr%3A408`);
			await server.api("change", { change: "pr:408", state: "merged" });
			await page.reload();
			await onChange.getByText("Fixed by another commit of pr:408, which merged", { exact: false }).waitFor();
			await page.goto(`${server.url}/p/scratch/suite/c/1`);
			const onCase = page.locator(".question-card").filter({ hasText: question.q });
			await onCase.getByText("test by robin", { exact: false }).waitFor();
			await onCase
				.getByText(
					"Fixed by another commit of pr:408, which merged · Every test it named passed on trace408b where it had failed; the answer ended.",
					{ exact: true },
				)
				.waitFor();
			expect(h.errors).toEqual([]);
		} finally {
			await h.close();
			await server.stop();
		}
	},
	30000,
);
for (const mode of ["single", "bulk", "advice"])
	check(
		`an open Queue answer preserves a decision made while it was in flight: ${mode}`,
		async () => {
			const server = await startServer({ preset: "standard" });
			await cases(server);
			await server.api("report", {
				target: { commit: "queue544", branch: "main" },
				results: ["C-1", "C-2", "C-3"].map((ref) => ({
					test: { case: ref },
					outcome: "fail",
					failure: { message: `Expected ${ref}, got broken` },
				})),
			});
			const colleague = await grant(server, "colleague");
			if (mode === "advice") {
				const agent = z.object({ token: z.string() }).parse(
					await server.api("admin", {
						do: "token.create",
						actor: "reviewer",
						kind: "agent",
						can: ["read", "produce", "answer"],
						project: "scratch",
					}),
				).token;
				for (const q of (await server.api("inbox", { kind: "failure" })).items)
					await server.api("decide", { q: q.q, onEvidence: q.evidenceHash, answer: { is: "flaky" } }, { token: agent });
			}
			const h = await openPage(server, { path: "/p/scratch/queue" });
			const held = latch();
			const arrived = latch();
			let sent: unknown;
			try {
				const { page } = h;
				await page.locator("[data-current-question]").waitFor();
				const q = await qref(page);
				const question = (await server.api("inbox", { kind: "failure" })).items.find((one) => one.q === q);
				if (!question) throw Error("Missing the current failure");
				await page.route("**/decide", async (route) => {
					sent = route.request().postDataJSON();
					arrived.release();
					await held.held;
					await route.continue();
				});
				if (mode === "bulk") await page.keyboard.press("*");
				if (mode === "advice") await page.getByText("reviewer suggests flaky", { exact: false }).waitFor();
				const replied = page.waitForResponse((reply) => reply.url().endsWith("/decide"));
				await page.keyboard.press(mode === "advice" ? "Enter" : "f");
				await arrived.held;
				const decided = await server.api(
					"decide",
					{
						q: question.q,
						onEvidence: question.evidenceHash,
						answer: { is: "defect" },
					},
					{ token: colleague },
				);
				expect((await server.api("gate", { commit: "queue544" })).verdict).toBe("failed");
				held.release();
				await replied;
				expect((await server.api("get", { refs: [question.q] }))[0]?.decision).toMatchObject({
					id: decided[0]?.decision,
					answer: { is: "defect" },
					by: ["colleague"],
				});
				expect((await server.api("gate", { commit: "queue544" })).verdict).toBe("failed");
				await page.locator(".queue-last").getByText(`${question.q} was settled meanwhile`, { exact: false }).waitFor();
				await page.locator(`[data-current-question="${question.q}"]`).waitFor();
				await page.locator(".queue-decision").getByText("Defect in the product", { exact: true }).waitFor();
				await page.locator(".queue-decision").getByText("Decided by colleague", { exact: false }).waitFor();
				const member = z.object({ q: z.string(), ifOpen: z.literal(true) });
				const members = mode === "bulk" ? z.object({ all: z.array(member) }).parse(sent).all : [member.parse(sent)];
				expect(members).toHaveLength(mode === "bulk" ? 3 : 1);
				if (mode === "bulk") {
					const others = (await server.api("inbox", { kind: "failure", state: "decided" })).items.filter(
						(one) => one.q !== question.q,
					);
					expect(others.map((one) => one.decision?.answer.is)).toEqual(["flaky", "flaky"]);
				}
				expect(h.errors).toEqual([]);
			} finally {
				held.release();
				await h.close();
				await server.stop();
			}
		},
		30000,
	);

for (const outcome of [
	"confirmed",
	"refused",
	"lost reply",
	"moved by click",
	"moved by key",
	"moved within Settled",
	"moved within Settled without answer",
])
	check(
		`an answer typed during withdrawal stays with its question: ${outcome}`,
		async () => {
			const server = await startServer({ preset: "standard" });
			await failures(server);
			const h = await openPage(server, { path: "/p/scratch/queue" });
			const gate = latch();
			try {
				const { page } = h;
				await page.locator("[data-current-question]").waitFor();
				const q = await qref(page);
				if (!q) throw Error("No question");
				await page.keyboard.press("f");
				await page.locator(".queue-last").getByText("recorded", { exact: false }).waitFor();
				const fromSettled = outcome.startsWith("moved within Settled");
				const queuesAnswer = outcome !== "moved within Settled without answer";
				let settledDestination: string | null = null;
				if (fromSettled) {
					settledDestination = await qref(page);
					if (!settledDestination) throw Error("No second question");
					await page.keyboard.press("f");
					await page.locator(".queue-last").getByText("recorded", { exact: false }).waitFor();
					await page.getByRole("button", { name: "Settled", exact: true }).click();
					await page.locator(`[data-question="${q}"]`).click();
					await page.locator(".queue-decision").waitFor();
				}
				const sent: string[] = [];
				await page.route("**/decide", async (route) => {
					const input = route.request().postDataJSON();
					sent.push(`${input.undo ?? input.q}:${input.undo ? "undo" : input.answer.is}`);
					if (input.undo) {
						await gate.held;
						if (outcome === "lost reply") return route.abort();
						if (outcome === "refused") {
							const row = (await server.api("inbox", { state: "decided" })).items.find((row) => row.q === q);
							if (!row) throw Error("No decision");
							await server.api("decide", { q, onEvidence: row.evidenceHash, answer: { is: "defect" } });
						}
					}
					await route.continue();
				});
				await page.keyboard.press("u");
				await page.locator(".queue-last").getByText("withdrawing the answer", { exact: false }).waitFor();
				expect(await qref(page)).toBe(q);
				expect(await page.locator(`[data-question="${q}"]`).count()).toBe(fromSettled ? 1 : 0);
				if (queuesAnswer) {
					await page.keyboard.press("i");
					await page.getByText("Answer queued until the withdrawal is confirmed.", { exact: true }).waitFor();
				}
				let destination: string | null = null;
				if (outcome.startsWith("moved")) {
					if (fromSettled) {
						const read = page.waitForResponse(
							(reply) =>
								reply.url().endsWith("/get") && reply.request().postDataJSON().refs?.[0] === settledDestination,
						);
						await page.locator(`[data-question="${settledDestination}"]`).click();
						await (await read).finished();
						await page.evaluate(
							() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
						);
					} else if (outcome === "moved by click") await page.locator("[data-question]").last().click();
					else await page.keyboard.press("j");
					destination = await qref(page);
					expect(destination).not.toBe(q);
				}
				expect((await server.api("get", { refs: [q] }))[0]?.state).toBe("decided");
				gate.release();
				if (outcome.startsWith("moved")) {
					if (queuesAnswer)
						await page
							.getByText("Queued answer discarded. Read the question again before answering.", { exact: true })
							.or(page.locator(".queue-last").getByText("recorded", { exact: false }))
							.waitFor();
					else await page.locator(".queue-last").getByText("Answer withdrawn.", { exact: false }).waitFor();
					if (outcome === "moved within Settled" && process.env.MAINWORTHY_SETTLED_MOVE_SCREENSHOT)
						await page.screenshot({ path: process.env.MAINWORTHY_SETTLED_MOVE_SCREENSHOT });
					if (fromSettled) {
						expect(await page.getByRole("button", { name: "Settled", exact: true }).getAttribute("aria-pressed")).toBe(
							"true",
						);
						await page.locator(`[data-question="${q}"]`).waitFor({ state: "detached" });
						expect(await page.locator(`[data-question="${destination}"]`).count()).toBe(1);
						expect(
							await page.getByText("This question was settled elsewhere. Your note is kept.", { exact: true }).count(),
						).toBe(0);
					}
					if (outcome === "moved by click" && process.env.MAINWORTHY_QUEUED_SCREENSHOT)
						await page.screenshot({ path: process.env.MAINWORTHY_QUEUED_SCREENSHOT });
					expect(await qref(page)).toBe(destination);
					if (queuesAnswer)
						await page
							.getByText("Queued answer discarded. Read the question again before answering.", { exact: true })
							.waitFor();
					expect(sent).toEqual([`${q}:undo`]);
					expect((await server.api("get", { refs: [q] }))[0]).toMatchObject({ state: "open", decision: null });
				} else if (outcome === "confirmed") {
					await page.locator(".queue-last").getByText("recorded", { exact: false }).waitFor();
					expect(sent).toEqual([`${q}:undo`, `${q}:infra`]);
					expect((await server.api("get", { refs: [q] }))[0]?.decision).toMatchObject({ answer: { is: "infra" } });
				} else {
					await page.locator(".queue-last").getByText("Queued answer discarded.", { exact: false }).waitFor();
					if (outcome === "refused")
						expect(
							(await page.locator(".queue-last").textContent())?.match(/read the question again before withdrawing/gi),
						).toHaveLength(1);
					expect(sent).toEqual([`${q}:undo`]);
					expect((await server.api("get", { refs: [q] }))[0]?.decision).toMatchObject({
						answer: { is: outcome === "refused" ? "defect" : "flaky" },
					});
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
	"Settled u withdraws the shown question after another withdrawal loses its reply",
	async () => {
		const server = await startServer({ preset: "standard" });
		await failures(server);
		const h = await openPage(server, { path: "/p/scratch/queue" });
		try {
			const { page } = h;
			await page.locator("[data-current-question]").waitFor();
			const first = await qref(page);
			await page.keyboard.press("f");
			await page.locator(".queue-last").getByText("recorded", { exact: false }).waitFor();
			const second = await qref(page);
			if (!first || !second) throw Error("Two answered questions are required");
			await page.keyboard.press("f");
			await page.locator(".queue-last").getByText("recorded", { exact: false }).waitFor();
			const sent: string[] = [];
			await page.route("**/decide", async (route) => {
				sent.push(z.object({ undo: z.string() }).parse(route.request().postDataJSON()).undo);
				if (sent.length === 1) return route.abort();
				await route.continue();
			});
			await page.getByRole("button", { name: "Settled", exact: true }).click();
			await page.locator(`[data-question="${first}"]`).click();
			await page.getByRole("button", { name: "u Withdraw answer", exact: true }).click();
			await page.locator(".queue-last").getByText("the withdrawal failed", { exact: false }).waitFor();
			await page.locator(`[data-question="${second}"]`).click();
			expect(await qref(page)).toBe(second);
			await page.keyboard.press("u");
			await page.locator(".queue-last").getByText("Answer withdrawn.", { exact: false }).waitFor();
			expect(sent).toEqual([first, second]);
			expect((await server.api("get", { refs: [first, second] })).map((row) => row.state)).toEqual(["decided", "open"]);
		} finally {
			await h.close();
			await server.stop();
		}
	},
	30000,
);

for (const outcome of ["confirmed", "refused", "lost reply"])
	check(
		`Settled last-answer undo waits for the server: ${outcome}`,
		async () => {
			const server = await startServer({ preset: "standard" });
			await failures(server);
			const h = await openPage(server, { path: "/p/scratch/queue" });
			const gate = latch();
			try {
				const { page } = h;
				await page.setViewportSize({ width: 1280, height: 800 });
				await page.locator("[data-current-question]").waitFor();
				const q = await qref(page);
				if (!q) throw Error("No current question");
				await page.keyboard.press("f");
				await page.locator(".queue-last").getByText("recorded", { exact: false }).waitFor();
				const decided = z
					.object({ evidenceHash: z.string(), decision: z.object({ id: z.number() }) })
					.parse((await server.api("get", { refs: [q] }))[0]);
				const sent: { undo: string; ifDecision: number; cmd: string }[] = [];
				await page.route("**/decide", async (route) => {
					const input = z
						.object({ undo: z.string(), ifDecision: z.number(), cmd: z.string() })
						.parse(route.request().postDataJSON());
					sent.push(input);
					await gate.held;
					if (outcome === "refused" && sent.length === 1) {
						await server.api("decide", { q, onEvidence: decided.evidenceHash, answer: { is: "defect" } });
						await route.continue();
					} else if (outcome === "lost reply" && sent.length === 1) {
						await route.fetch();
						await route.abort();
					} else await route.continue();
				});
				await page.getByRole("button", { name: "Settled", exact: true }).click();
				await page.locator(`[data-question="${q}"]`).click();
				await page.locator(".queue-decision").waitFor();
				await page.locator(".queue-last").getByRole("button", { name: "u undo", exact: true }).click();
				await page.locator(".queue-last").getByText("withdrawing the answer", { exact: false }).waitFor();
				if (outcome === "confirmed" && process.env.MAINWORTHY_UNDO_SCREENSHOT)
					await page.screenshot({ path: process.env.MAINWORTHY_UNDO_SCREENSHOT });
				expect(await page.getByRole("button", { name: "Settled", exact: true }).getAttribute("aria-pressed")).toBe(
					"true",
				);
				expect((await server.api("get", { refs: [q] }))[0]).toMatchObject({
					state: "decided",
					decision: { id: decided.decision.id },
				});
				await eventually(
					() => Promise.resolve(sent.length),
					(count) => count === 1,
				);
				expect(sent[0]).toMatchObject({ undo: q, ifDecision: decided.decision.id });
				gate.release();
				if (outcome === "confirmed") {
					await page.locator(".queue-last").getByText("Answer withdrawn.", { exact: false }).waitFor();
					expect((await server.api("get", { refs: [q] }))[0]).toMatchObject({ state: "open", decision: null });
					expect(await page.getByRole("button", { name: "Open", exact: true }).getAttribute("aria-pressed")).toBe(
						"true",
					);
					await page.locator(`[data-question="${q}"]`).waitFor();
				} else {
					await page.locator(".queue-last").getByText("the withdrawal failed", { exact: false }).waitFor();
					expect(await page.getByRole("button", { name: "Settled", exact: true }).getAttribute("aria-pressed")).toBe(
						"true",
					);
					if (outcome === "refused") {
						expect(await page.locator(".queue-last").textContent()).toMatch(
							/read the question again before withdrawing/i,
						);
						expect(await page.locator(".queue-last").textContent()).not.toContain("Press u to retry");
						await page.getByRole("button", { name: "Open", exact: true }).click();
						await page.locator("[data-question]").first().waitFor();
						expect(await page.locator(`[data-question="${q}"]`).count()).toBe(0);
						expect((await server.api("get", { refs: [q] }))[0]).toMatchObject({
							state: "decided",
							decision: { answer: { is: "defect" } },
						});
					} else {
						expect(await page.locator(".queue-last").textContent()).toContain(". Press u to retry.");
						await page.keyboard.press("u");
						await eventually(
							() => Promise.resolve(sent.length),
							(count) => count === 2,
						);
						expect(sent[1]).toEqual(sent[0]);
						await page.locator(".queue-last").getByText("Answer withdrawn.", { exact: false }).waitFor();
						expect((await server.api("get", { refs: [q] }))[0]).toMatchObject({ state: "open", decision: null });
						await page.locator(`[data-question="${q}"]`).waitFor();
					}
				}
			} finally {
				gate.release();
				await h.close();
				await server.stop();
			}
		},
		30000,
	);

for (const scenario of [
	"single replacement",
	"settled replacement",
	"bulk replacement",
	"partial answer",
	"lost selection reply",
])
	check(
		`undo receipts preserve other answers and partial outcomes: ${scenario}`,
		async () => {
			const server = await startServer({ preset: "standard" });
			await failures(server);
			const h = await openPage(server, { path: "/p/scratch/queue" });
			try {
				const { page } = h;
				await page.locator("[data-current-question]").waitFor();
				const original = new Map<string, number>();
				const sent: { q: string; ifDecision: number }[] = [];
				const requests: unknown[] = [];
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
						requests.push(input);
						const parsed = z
							.union([
								z
									.object({ undo: z.string(), ifDecision: z.number() })
									.transform(({ undo, ifDecision }) => [{ q: undo, ifDecision }]),
								z
									.object({ undo: z.array(z.object({ q: z.string(), ifDecision: z.number() })) })
									.transform(({ undo }) => undo),
							])
							.parse(input);
						sent.push(...parsed);
						if (scenario === "settled replacement" && !changed) {
							changed = parsed[0]?.q;
							await replace();
						}
						if (scenario === "lost selection reply" && requests.length === 1) {
							await route.fetch();
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
				expect(requests).toHaveLength(1);
				if (scenario !== "partial answer")
					await page.locator(".queue-last").getByText("withdrawal failed", { exact: false }).waitFor();
				await eventually(
					() => server.api("inbox", { state: "decided" }),
					(reply) =>
						reply.items.filter((q) => q.kind === "failure").length ===
						(["partial answer", "lost selection reply"].includes(scenario) ? 0 : 1),
				);
				for (const input of sent) expect(original.get(input.q)).toBe(input.ifDecision);
				if (scenario.endsWith("replacement")) {
					expect(await page.locator(".queue-last").textContent()).toMatch(
						/read the question again before withdrawing/i,
					);
					expect(await page.locator(".queue-last").textContent()).not.toContain("Press u to retry");
					expect(await page.locator(".queue-last button").count()).toBe(0);
					const rows = await server.api("get", { refs: [changed ?? ""] });
					expect(rows[0]?.decision).toMatchObject({ id: replacement, answer: { is: "defect" } });
				}
				if (scenario === "lost selection reply") {
					await page.keyboard.press("u");
					await eventually(
						() => server.api("inbox", { state: "decided" }),
						(reply) => reply.items.filter((q) => q.kind === "failure").length === 0,
					);
					await page.locator(".queue-last").getByText("Answer withdrawn.", { exact: false }).waitFor();
					expect(requests).toHaveLength(2);
					expect(requests[1]).toEqual(requests[0]);
				}
				expect(h.errors).toEqual(
					scenario === "lost selection reply" ? ["Failed to load resource: net::ERR_FAILED"] : [],
				);
			} finally {
				await h.close();
				await server.stop();
			}
		},
		30000,
	);

for (const scenario of ["lost reply", "withdrawn by someone else"])
	check(
		`undo confirms an open question: ${scenario}`,
		async () => {
			const server = await startServer({ preset: "standard" });
			await failures(server);
			const colleague = scenario === "withdrawn by someone else" ? await grant(server, "colleague") : server.token;
			const h = await openPage(server, { path: "/p/scratch/queue" });
			try {
				const { page } = h;
				await page.locator("[data-current-question]").waitFor();
				const q = await qref(page);
				if (!q) throw Error("No current question");
				const sent: { cmd: string; ifDecision: number }[] = [];
				await page.route("**/decide", async (route) => {
					const input = route.request().postDataJSON();
					if (!("undo" in input)) return route.continue();
					sent.push(z.object({ cmd: z.string(), ifDecision: z.number() }).parse(input));
					if (scenario === "withdrawn by someone else")
						await server.api("decide", { undo: q, ifDecision: input.ifDecision }, { token: colleague });
					const response = await route.fetch();
					if (scenario === "lost reply" && sent.length === 1) await route.abort();
					else await route.fulfill({ response });
				});
				await page.keyboard.press("f");
				await page.locator(".queue-last").getByText("recorded", { exact: false }).waitFor();
				await page.keyboard.press("u");
				if (scenario === "lost reply") {
					await page.locator(".queue-last").getByText("withdrawal failed", { exact: false }).waitFor();
					await page.keyboard.press("u");
					await eventually(
						() => Promise.resolve(sent.length),
						(count) => count === 2,
					);
					expect(sent[1]).toEqual(sent[0]);
				}
				await page
					.locator(".queue-last")
					.getByText(
						scenario === "lost reply" ? "Answer withdrawn. Both decisions stay in the ledger." : `${q}: already open.`,
						{ exact: true },
					)
					.waitFor();
				expect((await server.api("get", { refs: [q] }))[0]).toMatchObject({ q, state: "open", decision: null });
				await page.locator(`[data-question="${q}"]`).click();
				await page.locator(`[data-current-question="${q}"]`).waitFor();
				expect(await qref(page)).toBe(q);
				await page.keyboard.press("f");
				await page.locator(".queue-last").getByText("recorded", { exact: false }).waitFor();
				expect((await server.api("get", { refs: [q] }))[0]).toMatchObject({ state: "decided" });
				expect(h.errors).toEqual(scenario === "lost reply" ? ["Failed to load resource: net::ERR_FAILED"] : []);
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
	"R4B-3 withdrawals follow held answers and reopen only when confirmed",
	async () => {
		const server = await startServer({ preset: "standard" });
		await failures(server);
		const h = await openPage(server, { path: "/p/scratch/queue" });
		const gate = latch();
		const secondAnswer = latch();
		const sync = latch();
		try {
			const { page } = h;
			await page.locator("[data-current-question]").waitFor();
			const q = await qref(page);
			if (!q) throw Error("No question");
			const withdrawing = page
				.locator(".queue-needs")
				.getByText("Withdrawing the answer. An answer key queues a replacement.", { exact: true });
			const sent: string[] = [];
			await page.route("**/inbox", async (route) => {
				const reply = await fetched(route);
				if (!reply) return;
				if (sent.includes(`${q}:undo`)) await sync.held;
				await answer(route, { response: reply.response });
			});
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
				if (raw.answer?.is === "infra") await secondAnswer.held;
				await route.continue();
			});
			await page.keyboard.press("f");
			await page.keyboard.press("u");
			await page.locator(".queue-last").getByText("withdrawing the answer", { exact: false }).waitFor();
			expect(await page.locator(`[data-question="${q}"]`).count()).toBe(0);
			gate.release();
			await page.locator(".queue-last").getByText("Answer withdrawn.", { exact: false }).waitFor();
			await withdrawing.waitFor();
			sync.release();
			await page.locator(`[data-question="${q}"]`).click();
			await page.locator(`[data-current-question="${q}"]`).waitFor();
			await withdrawing.waitFor({ state: "detached" });
			await page.keyboard.press("i");
			await page.keyboard.press("u");
			await page.locator(".queue-last").getByText("withdrawing the answer", { exact: false }).waitFor();
			expect(await page.locator(`[data-question="${q}"]`).count()).toBe(0);
			secondAnswer.release();
			await page.locator(".queue-last").getByText("Answer withdrawn.", { exact: false }).waitFor();
			await page.locator(`[data-question="${q}"]`).click();
			await page.locator(`[data-current-question="${q}"]`).waitFor();
			await withdrawing.waitFor({ state: "detached" });
			await page.keyboard.press("t");
			const saved = await eventually(
				() => server.api("get", { refs: [q] }),
				(rows) =>
					z.object({ answer: z.object({ is: z.string() }) }).safeParse(rows[0]?.decision).data?.answer.is === "test",
			);
			expect(saved[0]?.state).toBe("decided");
			expect(sent).toEqual([`${q}:flaky`, `${q}:undo`, `${q}:infra`, `${q}:undo`, `${q}:test`]);
		} finally {
			gate.release();
			secondAnswer.release();
			sync.release();
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

check(
	"a 158-case run shows every progress dot without scrolling on desktop",
	async () => {
		const server = await startServer();
		await cases(server, 158);
		const run = await server.api("plan", { name: "Large run", select: {} });
		const h = await openPage(server, { path: `/p/scratch/runs/${run.run.slice(2)}` });
		try {
			const { page } = h;
			await ready(page);
			expect(page.viewportSize()).toEqual({ width: 1440, height: 900 });
			const strip = await page.locator(".run-strip").evaluate((node) => {
				const box = node.getBoundingClientRect();
				const dots = [...node.querySelectorAll(".run-dot")];
				const top = box.top + node.clientTop;
				return {
					dots: dots.length,
					dotHeight: Math.max(...dots.map((dot) => dot.getBoundingClientRect().height)),
					clientHeight: node.clientHeight,
					scrollHeight: node.scrollHeight,
					visible: dots.filter((dot) => {
						const rect = dot.getBoundingClientRect();
						return rect.top >= top && rect.bottom <= top + node.clientHeight;
					}).length,
				};
			});
			console.info(`STRIP ${JSON.stringify(strip)}`);
			expect(strip.scrollHeight).toBe(strip.clientHeight);
			expect(strip).toMatchObject({ dots: 158, visible: 158 });
			// The dots stay under the 24 px target size: at that size a larger run scrolls again (they are exempt).
			expect(strip.dotHeight).toBeLessThan(24);
			await page.locator(".run-dot").last().click();
			const slots = page.getByRole("listbox", { name: "Run slots", exact: true });
			expect(await slots.getByRole("option", { selected: true }).locator(".ref").innerText()).toBe("C-158");
			const first = slots.getByRole("option").first();
			const target = await first.boundingBox();
			expect(target?.width).toBeGreaterThanOrEqual(24);
			expect(target?.height).toBeGreaterThanOrEqual(24);
			await first.click();
			expect(await page.locator(".run-dot.on").getAttribute("aria-label")).toBe("Slot 1: C-1, missing");
			expect(h.errors).toEqual([]);
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
				await ready(page);
				if (action === "pause") await page.clock.install();
				await page.keyboard.press("2");
				if (action === "pause") {
					await page.clock.fastForward(800);
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
		const gate = latch();
		try {
			const { page } = h;
			await ready(page);
			await page.route("**/report", async (route) => {
				await gate.held;
				await route.continue();
			});
			await page.keyboard.press("p");
			await page.keyboard.press("f");
			await page.keyboard.type("Private note");
			await server.api(
				"report",
				{ run: run.run, results: [{ test: { case: "C-2" }, outcome: "pass" }] },
				{ token: tester },
			);
			await page.getByText("Filled by person tester", { exact: false }).waitFor();
			gate.release();
			// Standard closes a passing run in the same write. Slot fills alone can arrive before this read.
			await page.locator(".run-summary").getByText("passed: 2 results proven", { exact: true }).waitFor();
			await page.keyboard.press("Enter");
			await page.getByText("This run is closed", { exact: false }).first().waitFor();
			expect(await page.getByRole("textbox", { name: "Result note" }).inputValue()).toBe("Private note");
		} finally {
			gate.release();
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

for (const kind of ["failure", "finding", "map", "signoff", "adopt"] satisfies Kind[])
	check(
		`R4B-1 unread ${kind} evidence refuses keys and buttons`,
		async () => {
			const server = await startServer({ preset: "standard" });
			await failures(server);
			let reads = 0;
			const h = await openPage(server, {
				path: "/p/scratch/queue",
				setup: async (page) => {
					await page.route("**/inbox", async (route) => {
						reads++;
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
						if (first) raw.result.items = [{ ...first, kind, evidence: {}, answers: Object.values(ANSWER_KEYS[kind]) }];
						await answer(route, { json: raw });
					});
				},
			});
			try {
				const { page } = h;
				await eventually(
					async () => reads,
					(n) => n > 0,
				);
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
		await cases(server, 1);
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
			const dispute = (await server.api("inbox", { kind: "failure" })).items.find((q) =>
				q.title.startsWith(`Disputed C-1 in ${run.run}:`),
			);
			if (!dispute) throw new Error("No slot dispute");
			await page.locator(`[data-question="${dispute.q}"]`).click();
			await page.getByText("A counted pass and fail disagree.", { exact: false }).waitFor();
			expect(await page.locator(".queue-log").textContent()).toContain("expected 10, got 12");
			await h.context.request.post(`${server.url}/api/login`, { data: { token: tester } });
			await page.reload();
			await page.getByText("You cannot settle this.", { exact: false }).waitFor();
			expect(await page.locator(".queue-answers button:enabled").count()).toBe(0);
			await h.context.request.post(`${server.url}/api/login`, { data: { token: server.token } });
			await page.reload();
			await page.locator(".queue-answers button:enabled").first().waitFor();
			await page.keyboard.press("f");
			await eventually(
				() => server.api("get", { refs: [dispute.q] }),
				(rows) => rows[0]?.state === "decided",
			);
			expect(await server.api("gate", { run: run.run })).toMatchObject({
				verdict: "passed",
				tally: { pass: 1, disputed: 0 },
			});
			expect(h.errors).toEqual([]);
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
		let reads = 0;
		const h = await openPage(server, {
			path: "/p/scratch/queue",
			setup: async (page) => {
				await page.route("**/inbox", async (route) => {
					reads++;
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
			},
		});
		try {
			const { page } = h;
			await eventually(
				async () => reads,
				(n) => n > 0,
			);
			await page.locator("[data-current-question]").waitFor();
			const q = await page.locator("[data-current-question]").getAttribute("data-current-question");
			if (!q) throw new Error("Missing failure question");
			expect(await page.getByRole("heading", { level: 2 }).innerText()).toBe(
				"Refund failure: expected ready, got broken",
			);
			expect(await page.locator(".queue-log").innerText()).toBe("Refund failure: expected ready, got broken");
			expect(await page.locator(".queue-answers button:enabled b").allInnerTexts()).toEqual([
				"Defect in the product",
				"The test is wrong",
				"Expected: behaviour changed",
				"Flaky",
				"Infrastructure",
			]);
			await page.getByRole("button", { name: /Infrastructure/ }).click();
			const settled = await eventually(
				() => server.api("get", { refs: [q] }),
				(rows) => rows[0]?.state === "decided",
			);
			expect(settled[0]?.decision).toMatchObject({ answer: { is: "infra" } });
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
			let reads = 0;
			const gate = latch();
			const h = await openPage(server, {
				path: "/p/scratch/queue",
				setup: async (page) => {
					await page.route("**/get", async (route) => {
						const input = z.object({ refs: z.array(z.string()) }).parse(route.request().postDataJSON());
						if (input.refs.includes("C-1")) {
							reads++;
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
				},
			});
			try {
				const { page } = h;
				await eventually(
					async () => reads,
					(n) => n > 0,
				);
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

check(
	"unreadable defect holds appear on the queue decision and the failure's case history",
	async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "mainworthy-tracker-ui-"));
		const token = "tracker-browser-owner-token-1234";
		const jira = {
			project: "scratch",
			site: "https://example.atlassian.net",
			projectKey: "QA",
			issueType: "Bug",
			email: "robin@example.com",
			token: "tracker-private-test-token",
		};
		const request: typeof fetch = Object.assign(async () => new Response(jira.token, { status: 401 }), {
			preconnect: fetch.preconnect,
		});
		const instance = await start(
			{ ...defaultConfig({}), owner: "robin", dataDir, port: 0, ownerToken: token, jira },
			() => ({ ui }),
			{ readers: 0, trackerPort: jiraPort(jira, request) },
		);
		const server: Server = {
			url: instance.url,
			project: "scratch",
			token,
			seeded: null,
			stop: instance.stop,
			api: <O extends OpName>(op: O, input: Api[O]["input"]) =>
				call(op, input, { url: instance.url, project: "scratch", token }),
		};
		try {
			await server.api("propose", { edits: [{ op: "create", outline: "Tracker failure" }] });
			await server.api("report", {
				target: { session: "tracker-ui" },
				results: [{ test: { case: "C-1" }, outcome: "fail", failure: { message: "Expected ready" } }],
			});
			const question = (await server.api("inbox", { kind: "failure" })).items[0];
			if (!question) throw new Error("No failure question");
			await server.api("decide", {
				q: question.q,
				onEvidence: question.evidenceHash,
				answer: { is: "defect", ref: `${jira.site}/browse/QA-42` },
			});
			const h = await openPage(server, { path: `/p/scratch/queue/${question.q.replace(/^Q-/, "")}` });
			try {
				await h.page.locator(".queue-decision").waitFor();
				await instance.minute();
				await h.page
					.locator(".queue-decision")
					.getByText(/The tracker could not be read since .*Renew the tracker token/)
					.waitFor();
				expect(await h.page.locator("body").innerText()).not.toContain(jira.token);
				await h.page.goto(`${server.url}/p/scratch/suite/c/1`);
				await h.page
					.locator(".question-card")
					.getByText(/The tracker could not be read since .*Renew the tracker token/)
					.waitFor();
				expect(await h.page.locator("body").innerText()).not.toContain(jira.token);
				expect(h.errors).toEqual([]);
			} finally {
				await h.close();
			}
		} finally {
			await instance.stop();
			await rm(dataDir, { recursive: true, force: true });
		}
	},
	20_000,
);
