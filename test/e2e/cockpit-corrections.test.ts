import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { z } from "zod";
import { start } from "../../src/app/start.ts";
import type { Api, OpName } from "../../src/core/api.ts";
import { AttachmentReply } from "../../src/core/attachments.ts";
import { defaultConfig } from "../../src/server/kernel/app.ts";
import { removeProject } from "../../src/server/transfer/transfer.ts";
import ui from "../../src/web/index.html";
import { call } from "../../src/web/lib/api.ts";
import { Slot } from "../../src/web/runs/models.ts";
import { answer, browserAvailable, eventually, fetched, openPage, type Server, startServer } from "./support.ts";

const check = browserAvailable ? test : test.skip;

async function fixture(count = 1, minActors: 1 | 2 = 1, preset: "strict" | "loose" = "strict") {
	const server = await startServer({ mode: "server" });
	try {
		await server.api("propose", {
			edits: Array.from({ length: count }, (_, index) => ({
				op: "create",
				body: {
					title: `Correction case ${index + 1}`,
					methods: ["human"],
					steps: [{ id: "open", action: "Open cart", expected: "Ready" }],
				},
			})),
		});
		const policy = await server.api("propose", { edits: [{ op: "policy", preset }] });
		const question = (await server.api("inbox", { kind: "adopt" })).items.find((item) => item.q === policy.question);
		if (question)
			await server.api("decide", { q: question.q, onEvidence: question.evidenceHash, answer: { is: "accept" } });
		const plan = await server.api("plan", {
			name: "Cockpit corrections",
			select: {},
			require: [{ id: "exercise", kind: "exercise", methods: ["human"], minActors, basis: "exact" }],
		});
		return { server, run: plan.run, path: `/p/scratch/runs/${plan.run.slice(2)}` };
	} catch (error) {
		await server.stop();
		throw error;
	}
}

async function ready(page: Page) {
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.locator('[data-run-document="C-1"][data-active="true"][data-ready="true"]').waitFor();
}

async function screenshot(page: Page, issue: number) {
	const evidence = process.env.MAINWORTHY_COCKPIT_EVIDENCE;
	if (evidence) await page.screenshot({ path: `${evidence}/${issue}-${process.env.MAINWORTHY_COCKPIT_REVISION}.png` });
}

async function fail(page: Page, note: string) {
	await page.keyboard.press("f");
	await page.getByRole("textbox", { name: "Result note" }).fill(note);
	await page.keyboard.press("Enter");
}

async function slots(server: Server, run: string) {
	return Slot.array().parse((await server.api("find", { in: "slots", run })).items);
}

// The read number is taken when a slot read starts, not when it answers: a read that started while the report
// was in flight, and returns the old snapshot after the receipt, must not hide the result (#872, verifier R3-1).
check(
	"a slot read that started before a receipt and returns after it keeps the reported slot (#872)",
	async () => {
		const { server, run, path } = await fixture(3);
		let view: Awaited<ReturnType<typeof openPage>> | null = null;
		const readStarted = Promise.withResolvers<void>();
		const accepted = Promise.withResolvers<void>();
		const freshRead = Promise.withResolvers<void>();
		let staleArrived = false;
		try {
			view = await openPage(server, { path });
			const { page } = view;
			await ready(page);
			let stale: Api["find"]["reply"] | null = null;
			let served = false;
			await page.route("**/find", async (route) => {
				const input = z.object({ in: z.string() }).parse(route.request().postDataJSON());
				if (input.in === "slots" && stale) {
					if (!served) {
						served = true;
						const snapshot = stale;
						readStarted.resolve();
						await accepted.promise;
						await answer(route, { json: { ok: true, result: snapshot } });
						staleArrived = true;
						return;
					}
					await freshRead.promise;
				}
				await route.continue();
			});
			await page.route("**/report", async (route) => {
				const input = z
					.object({ results: z.array(z.object({ test: z.object({ case: z.string() }) })) })
					.parse(route.request().postDataJSON());
				if (input.results[0]?.test.case === "C-2") {
					stale = await server.api("find", { in: "slots", run });
					const reply = await fetched(route);
					await readStarted.promise;
					if (reply) await answer(route, { response: reply.response });
				} else {
					if (input.results[0]?.test.case === "C-3") freshRead.resolve();
					await route.continue();
				}
			});
			await page.keyboard.press("p");
			await page.locator("#stat").filter({ hasText: "C-1 pass recorded" }).waitFor();
			await page.locator('[data-run-document="C-2"][data-active="true"][data-ready="true"]').waitFor();
			await page.keyboard.press("p");
			await page.locator("#stat").filter({ hasText: "C-2 pass recorded" }).waitFor();
			// The receipt is accepted; only now does the read that started before it return the old snapshot.
			accepted.resolve();
			await eventually(
				async () => staleArrived,
				(value) => value,
			);
			expect(staleArrived).toBe(true);
			await page.locator('[data-run-document="C-3"][data-active="true"][data-ready="true"]').waitFor();
			await page.keyboard.press("p");
			await page.locator("#stat").filter({ hasText: "C-3 pass recorded" }).waitFor();
			await page
				.getByText("Nothing left for you to run. The server verdict is shown above.", { exact: true })
				.waitFor();
			expect(await page.locator('[data-run-document][data-active="true"]').getAttribute("data-run-document")).toBe(
				"C-3",
			);
		} finally {
			readStarted.resolve();
			accepted.resolve();
			freshRead.resolve();
			await view?.close();
			await server.stop();
		}
	},
	30_000,
);

for (const timing of ["after slot refresh", "before slot refresh"] as const)
	check(
		`a mistaken dispute ${timing} releases confirmed local evidence and lets its author report again (872)`,
		async () => {
			const { server, run, path } = await fixture(1, 2);
			let view: Awaited<ReturnType<typeof openPage>> | null = null;
			const held = Promise.withResolvers<void>();
			const reading = Promise.withResolvers<void>();
			try {
				const second = z.object({ token: z.string() }).parse(
					await server.api("admin", {
						do: "token.create",
						actor: "second-person",
						kind: "human",
						can: ["read", "produce"],
						project: "scratch",
					}),
				);
				const lead = z.object({ token: z.string() }).parse(
					await server.api("admin", {
						do: "token.create",
						actor: "lead",
						kind: "human",
						can: ["read", "produce", "answer"],
						project: "scratch",
					}),
				);
				await server.api("report", { run, results: [{ test: { case: "C-1" }, outcome: "pass" }] }, second);
				view = await openPage(server, { path });
				const { page } = view;
				await ready(page);
				if (timing === "before slot refresh")
					await page.route("**/find", async (route) => {
						const input = z.object({ in: z.string() }).parse(route.request().postDataJSON());
						if (input.in === "slots") {
							reading.resolve();
							await held.promise;
						}
						await route.continue();
					});
				await fail(page, "Mistaken observation");
				await page.locator("#stat").filter({ hasText: "C-1 fail recorded" }).waitFor();
				if (timing === "before slot refresh") await reading.promise;
				else await page.getByRole("button", { name: "Slot 1: C-1, disputed by robin", exact: true }).waitFor();
				const receiptQuestion = await page.locator('[data-slot="1"] .run-question').first().innerText();
				const dispute = (await server.api("inbox", { kind: "failure" })).items.find((item) =>
					item.title.startsWith(`Disputed C-1 in ${run}:`),
				);
				if (!dispute) throw new Error("Slot dispute missing");
				expect(
					await server.api(
						"decide",
						{
							q: dispute.q,
							onEvidence: dispute.evidenceHash,
							answer: { is: "mistaken" },
							reason: "The failure was an observation error",
						},
						lead,
					),
				).toMatchObject([{ status: "decided" }]);
				held.resolve();
				expect((await slots(server, run))[0]).toMatchObject({
					state: "missing",
					fills: [{ by: "second-person", outcome: "pass" }],
				});
				const gate = await server.api("gate", { run });
				await page.locator(".run-verdict").filter({ hasText: gate.reason }).waitFor();
				try {
					await page.getByRole("button", { name: "Slot 1: C-1, missing by second-person", exact: true }).waitFor();
				} finally {
					await screenshot(page, timing === "before slot refresh" ? 8742 : 8741);
				}
				await page.locator('[data-slot="1"]').getByRole("link", { name: receiptQuestion, exact: true }).waitFor();
				await page
					.getByText("Nothing left for you to run. The server verdict is shown above.", { exact: true })
					.waitFor({
						state: "hidden",
					});
				await page.keyboard.press("p");
				await page.locator("#stat").filter({ hasText: "C-1 pass recorded" }).waitFor();
				expect((await slots(server, run))[0]).toMatchObject({
					state: "satisfied",
					fills: [
						{ by: "second-person", outcome: "pass" },
						{ by: "robin", outcome: "pass" },
					],
				});
			} finally {
				held.resolve();
				await view?.close();
				await server.stop();
			}
		},
		30_000,
	);

check(
	"undo reopens an automatically closed run before correcting its last result (793)",
	async () => {
		const { server, run, path } = await fixture(1, 1, "loose");
		let view: Awaited<ReturnType<typeof openPage>> | null = null;
		try {
			view = await openPage(server, { path });
			const { page } = view;
			await ready(page);
			await page.keyboard.press("p");
			await page.locator("#stat").filter({ hasText: "C-1 pass recorded" }).waitFor();
			const signoff = (await server.api("inbox", { on: run, kind: "signoff", state: "decided" })).items[0];
			expect(signoff?.decision?.rule).toBeTruthy();
			await page.locator(".run-controls").filter({ hasText: "u reopens this run" }).waitFor();
			await screenshot(page, 793);
			await page.keyboard.press("u");
			await page.locator("#stat").filter({ hasText: "Run reopened. C-1 skip recorded" }).waitFor();
			expect((await server.api("get", { refs: [run] }))[0]).toMatchObject({ state: "open" });
			expect((await slots(server, run))[0]?.fills).toMatchObject([{ outcome: "skip" }]);
			expect((await server.api("gate", { run })).verdict).toBe("pending");
			const question = (await server.api("get", { refs: [signoff?.q ?? ""] }))[0];
			expect(question).toMatchObject({ state: "dissolved", decision: null });
			const history = (await server.api("timeline", { ref: "C-1" })).entries.filter((entry) => entry.t === "result");
			expect(history).toMatchObject([{ outcome: "skip", corrects: history[1]?.id }, { outcome: "pass" }]);
		} finally {
			await view?.close();
			await server.stop();
		}
	},
	30_000,
);

for (const scenario of ["pending pass", "replaced approval", "refused correction", "lost withdrawal reply"] as const)
	check(
		`closed-run correction handles ${scenario} (793)`,
		async () => {
			const { server, run, path } = await fixture(1, 1, "loose");
			let view: Awaited<ReturnType<typeof openPage>> | null = null;
			const held = Promise.withResolvers<void>();
			const sent = Promise.withResolvers<void>();
			try {
				view = await openPage(server, { path });
				const { page } = view;
				await ready(page);
				if (scenario === "pending pass")
					await page.route("**/report", async (route) => {
						if (
							z.object({ results: z.array(z.object({ outcome: z.string() })) }).parse(route.request().postDataJSON())
								.results[0]?.outcome === "pass"
						) {
							sent.resolve();
							await held.promise;
						}
						await route.continue();
					});
				await page.keyboard.press("p");
				if (scenario === "pending pass") await sent.promise;
				else {
					await page.locator("#stat").filter({ hasText: "C-1 pass recorded" }).waitFor();
					await page.locator(".run-controls").filter({ hasText: "u reopens this run" }).waitFor();
				}
				if (scenario === "refused correction")
					await page.route("**/report", (route) =>
						route.fulfill({
							status: 400,
							json: { ok: false, error: { code: "invalid", message: "Correction refused" } },
						}),
					);
				if (scenario === "replaced approval" || scenario === "lost withdrawal reply")
					await page.route("**/decide", async (route) => {
						if (scenario === "lost withdrawal reply") {
							await fetched(route);
							await route.abort();
							return;
						}
						const input = z.object({ undo: z.string(), ifDecision: z.number() }).parse(route.request().postDataJSON());
						await server.api("decide", input);
						const question = (await server.api("inbox", { on: run, kind: "signoff" })).items[0];
						if (!question) throw new Error("Reopened sign-off missing");
						await server.api("decide", { q: question.q, onEvidence: question.evidenceHash, answer: { is: "approve" } });
						await route.continue();
					});
				await page.keyboard.press("u");
				held.resolve();
				if (scenario === "pending pass") {
					await page.locator("#stat").filter({ hasText: "Run reopened. C-1 skip recorded" }).waitFor();
					expect((await slots(server, run))[0]?.fills).toMatchObject([{ outcome: "skip" }]);
				} else {
					const message =
						scenario === "replaced approval"
							? "the decision changed"
							: scenario === "refused correction"
								? "Run reopened, but the correction was not recorded"
								: "withdrawal was not confirmed";
					await page.locator("#stat").filter({ hasText: message }).waitFor();
					expect((await slots(server, run))[0]?.fills).toMatchObject([{ outcome: "pass" }]);
					expect(
						(await server.api("timeline", { ref: "C-1" })).entries.filter((entry) => entry.t === "result"),
					).toHaveLength(1);
				}
				expect((await server.api("get", { refs: [run] }))[0]).toMatchObject({
					state: scenario === "replaced approval" ? "closed" : "open",
				});
			} finally {
				held.resolve();
				await view?.close();
				await server.stop();
			}
		},
		30_000,
	);

for (const restricted of ["produce only", "record and answer", "human approval"] as const)
	check(
		`a closed run with ${restricted} links to its settled sign-off instead of correction (793)`,
		async () => {
			const { server, run, path } = await fixture(1, 1, restricted === "human approval" ? "strict" : "loose");
			let view: Awaited<ReturnType<typeof openPage>> | null = null;
			try {
				const { token } = z.object({ token: z.string() }).parse(
					await server.api("admin", {
						do: "token.create",
						actor: "runner",
						kind: "human",
						can: restricted === "record and answer" ? ["read", "record", "answer"] : ["read", "produce"],
						project: "scratch",
					}),
				);
				view = await openPage(restricted === "human approval" ? server : { ...server, token }, { path });
				const { page } = view;
				await ready(page);
				await page.keyboard.press("p");
				await page.locator("#stat").filter({ hasText: "C-1 pass recorded" }).waitFor();
				if (restricted === "human approval") {
					const question = (await server.api("inbox", { on: run, kind: "signoff" })).items[0];
					if (!question) throw new Error("Sign-off missing");
					await server.api("decide", {
						q: question.q,
						onEvidence: question.evidenceHash,
						answer: { is: "approve" },
						reason: "Reviewed run",
					});
				}
				const signoff = (await server.api("inbox", { on: run, kind: "signoff", state: "decided" })).items[0];
				if (!signoff) throw new Error("Settled sign-off missing");
				const link = page.locator(".run-controls").getByRole("link", { name: "Queue > Settled" });
				await link.waitFor();
				if (restricted === "record and answer") await screenshot(page, 885);
				expect(await page.locator(".run-controls").innerText()).toContain(
					"Run closed. To reopen, withdraw the sign-off in Queue > Settled",
				);
				expect(await link.getAttribute("href")).toBe(`/p/scratch/queue/${signoff.q.slice(2)}`);
				expect(await page.locator(".run-last").getByRole("button").count()).toBe(0);
				expect(await page.locator("#hints").innerText()).not.toContain("Correct last result");
				let decisions = 0;
				await page.route("**/decide", async (route) => {
					decisions++;
					await route.continue();
				});
				let sent = 0;
				await page.route("**/report", async (route) => {
					sent++;
					await route.continue();
				});
				await page.keyboard.press("u");
				expect((await slots(server, run))[0]?.fills).toMatchObject([{ outcome: "pass" }]);
				expect((await server.api("get", { refs: [run] }))[0]).toMatchObject({ state: "closed" });
				expect(sent).toBe(0);
				expect(decisions).toBe(0);
				await link.click();
				await page.getByRole("option").filter({ hasText: "Close R-1" }).waitFor();
				expect(await page.locator("[data-current-question]").getAttribute("data-current-question")).toBe(signoff.q);
				expect(view.loads()).toBe(1);
			} finally {
				await view?.close();
				await server.stop();
			}
		},
		30_000,
	);

for (const scenario of ["fresh session", "stale session", "delayed reports", "retired reports"] as const)
	check(
		`retained cockpit reports cannot write into a replacement project with ${scenario}`,
		async () => {
			const delayed = scenario === "delayed reports" || scenario === "retired reports";
			const dataDir = await mkdtemp(join(tmpdir(), "mainworthy-cockpit-identity-"));
			const token = "cockpit-identity-test-owner-token";
			const instance = await start(
				{ ...defaultConfig({}), dataDir, port: 0, owner: "robin", ownerToken: token, mode: "local" },
