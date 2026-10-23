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
import {
	answer,
	browserAvailable,
	eventually,
	fetched,
	openPage,
	reservePort,
	type Server,
	startServer,
} from "./support.ts";

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

for (const restricted of ["produce only", "human approval"] as const)
	check(
		`a closed run with ${restricted} links to its settled sign-off instead of correction (793)`,
		async () => {
			const { server, run, path } = await fixture(1, 1, restricted === "produce only" ? "loose" : "strict");
			let view: Awaited<ReturnType<typeof openPage>> | null = null;
			try {
				const { token } = z.object({ token: z.string() }).parse(
					await server.api("admin", {
						do: "token.create",
						actor: "runner",
						kind: "human",
						can: ["read", "produce"],
						project: "scratch",
					}),
				);
				view = await openPage(restricted === "produce only" ? { ...server, token } : server, { path });
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
				expect(await link.getAttribute("href")).toBe(`/p/scratch/queue/${signoff.q.slice(2)}`);
				expect(await page.locator(".run-last").getByRole("button").count()).toBe(0);
				expect(await page.locator("#hints").innerText()).not.toContain("Correct last result");
				let sent = 0;
				await page.route("**/report", async (route) => {
					sent++;
					await route.continue();
				});
				await page.keyboard.press("u");
				expect((await slots(server, run))[0]?.fills).toMatchObject([{ outcome: "pass" }]);
				expect((await server.api("get", { refs: [run] }))[0]).toMatchObject({ state: "closed" });
				expect(sent).toBe(0);
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
			const port = await reservePort();
			const token = "cockpit-identity-test-owner-token";
			const instance = start(
				{ ...defaultConfig({}), dataDir, port: port.port, owner: "robin", ownerToken: token, mode: "local" },
				() => ({ ui }),
				{ readers: 0 },
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
			let view: Awaited<ReturnType<typeof openPage>> | null = null;
			const held = Promise.withResolvers<void>();
			const sent = Promise.withResolvers<void>();
			try {
				const seed = async () => {
					await server.api("propose", {
						edits: [1, 2].map((index) => ({ op: "create", outline: `Correction case ${index}\n  Open > Ready` })),
					});
					return server.api("plan", { name: "Cockpit corrections", select: {} });
				};
				const original = await seed();
				const Projects = z.array(z.object({ key: z.string(), identity: z.string() }));
				const originalProject = Projects.parse(await server.api("admin", { do: "project.list" })).find(
					(entry) => entry.key === "scratch",
				);
				expect(originalProject?.identity).toBeString();
				view = await openPage(server, { path: `/p/scratch/runs/${original.run.slice(2)}` });
				const { page } = view;
				await ready(page);
				const reports: Api["report"]["input"][] = [];
				await page.route("**/report", async (route) => {
					reports.push(route.request().postDataJSON());
					if (reports.length === 1) {
						sent.resolve();
						if (!delayed) return route.abort();
						await held.promise;
					}
					await route.continue();
				});
				if (!delayed) await page.route("**/command", (route) => route.abort());
				await page.keyboard.press("p");
				await sent.promise;
				if (delayed) {
					await page.locator('[data-slot="1"]').click();
					await page.keyboard.press("b");
				} else {
					await page
						.locator("#stat")
						.filter({ hasText: "check the same request before recording another result" })
						.waitFor();
				}
				await page.locator("#list").getByRole("link", { name: "Runs", exact: true }).click();
				removeProject(instance.app.db, "scratch");
				await server.api("admin", { do: "project.create", key: "scratch", preset: "loose" });
				const replacement = await seed();
				expect(replacement.run).toBe(original.run);
				const replacementProject = Projects.parse(await server.api("admin", { do: "project.list" })).find(
					(entry) => entry.key === "scratch",
				);
				expect(replacementProject?.identity).not.toBe(originalProject?.identity);
				const refresh = async () => {
					await page.keyboard.type("g,");
					await page.getByRole("option", { name: "Projects", exact: true }).click();
					await page.getByLabel("Project key", { exact: true }).fill("refresh-project");
					await page.getByRole("button", { name: "Create project", exact: true }).click();
					await page.locator("#stat").filter({ hasText: "Project refresh-project created." }).waitFor();
					await page.keyboard.type("gp");
					await page
						.getByRole("region", { name: "Switch project", exact: true })
						.getByRole("option")
						.filter({ hasText: "scratch" })
						.click();
					await page.keyboard.type("gr");
				};
				if (scenario === "fresh session" || scenario === "retired reports") await refresh();
				await page.getByRole("option").filter({ hasText: "Cockpit corrections" }).click();
				await page.keyboard.press("Enter");
				await page.locator('[data-slot="1"]').click();
				await ready(page);
				if (scenario === "retired reports") {
					const refused = page.waitForResponse((response) => response.url().endsWith("/report"));
					held.resolve();
					expect((await refused).status()).toBe(409);
					expect((await slots(server, replacement.run))[0]?.fills).toHaveLength(0);
					await page.keyboard.press("b");
				} else if (scenario === "delayed reports") held.resolve();
				else {
					await page.unroute("**/command");
					await page.keyboard.press("b");
				}
				await eventually(
					() => page.locator("#stat").innerText(),
					(text) => text.includes("recorded") || text.includes("obsolete project"),
				);
				const rows = await slots(server, replacement.run);
				if (scenario === "fresh session" || scenario === "retired reports")
					expect(rows[0]?.fills).toMatchObject([{ outcome: "blocked" }]);
				else expect(rows[0]?.fills).toHaveLength(0);
				expect(rows[1]?.state).toBe("missing");
				expect((await server.api("gate", { run: replacement.run })).verdict).toBe("pending");
				expect(reports[0]?.projectIdentity).toBe(originalProject?.identity);
				if (scenario === "fresh session" || scenario === "retired reports") {
					expect(reports).toHaveLength(2);
					expect(reports[1]?.projectIdentity).toBe(replacementProject?.identity);
					expect(reports[1]?.cmd).not.toBe(reports[0]?.cmd);
				} else {
					expect(reports[1]?.projectIdentity).toBe(originalProject?.identity);
					if (scenario === "stale session") expect(reports[1]).toEqual(reports[0]);
					await refresh();
					await page.getByRole("option").filter({ hasText: "Cockpit corrections" }).click();
					await page.keyboard.press("Enter");
					await page.locator('[data-slot="1"]').click();
					await ready(page);
					await page.keyboard.press("b");
					await page.locator("#stat").filter({ hasText: "C-1 blocked recorded" }).waitFor();
					expect((await slots(server, replacement.run))[0]?.fills).toMatchObject([{ outcome: "blocked" }]);
					expect(reports.at(-1)?.projectIdentity).toBe(replacementProject?.identity);
				}
				expect(view.loads()).toBe(1);
			} finally {
				held.resolve();
				await view?.close();
				await instance.stop();
				await port.release();
				await rm(dataDir, { recursive: true, force: true });
			}
		},
		30_000,
	);

check(
	"reopening the cockpit keeps a pending failure before its later pass (632)",
	async () => {
		const { server, run, path } = await fixture(2);
		let view: Awaited<ReturnType<typeof openPage>> | null = null;
		const held = Promise.withResolvers<void>();
		const sent = Promise.withResolvers<void>();
		const passed = Promise.withResolvers<void>();
		const delivered = Promise.withResolvers<void>();
		const Reported = z.object({ outcome: z.string(), corrects: z.number().optional() });
		const reports: z.infer<typeof Reported>[] = [];
		try {
			view = await openPage(server, { path });
			const { page } = view;
			await ready(page);
			await page.route("**/report", async (route) => {
				const input = z.object({ results: Reported.array() }).parse(route.request().postDataJSON());
				const result = input.results[0];
				if (!result) throw new Error("Missing report result");
				reports.push(result);
				if (reports.length === 1) {
					sent.resolve();
					await held.promise;
				}
				const response = await fetched(route);
				if (!response) return;
				await answer(route, { response: response.response });
				if (result.outcome === "pass") passed.resolve();
				else delivered.resolve();
			});
			await fail(page, "Older failure");
			await sent.promise;
			await page.locator("#list").getByRole("link", { name: "Runs", exact: true }).click();
			await page.getByRole("option").filter({ hasText: "Cockpit corrections" }).click();
			await page.keyboard.press("Enter");
			await page.locator('[data-slot="1"]').click();
			await ready(page);
			await page.keyboard.press("p");
			// A broken queue sends the pass first. A preserved queue waits for the held failure.
			await Promise.race([passed.promise, Bun.sleep(1000)]);
			held.resolve();
			await Promise.all([passed.promise, delivered.promise]);
			const rows = await slots(server, run);
			const gate = await server.api("gate", { run });
			await page.locator(".run-verdict").filter({ hasText: gate.reason }).waitFor();
			await screenshot(page, 632);
			expect(rows[0]?.state).toBe("satisfied");
			expect(rows[0]?.fills).toMatchObject([{ outcome: "pass", note: null }]);
			expect(rows[0]?.fills).toHaveLength(1);
			expect(rows[1]?.state).toBe("missing");
			expect((await server.api("gate", { run })).verdict).toBe("pending");
			const history = (await server.api("timeline", { ref: "C-1" })).entries.filter((entry) => entry.t === "result");
			expect(history.map((entry) => entry.outcome)).toEqual(["pass", "fail"]);
			expect(reports).toEqual([{ outcome: "fail" }, { outcome: "pass", corrects: history[1]?.id }]);
		} finally {
			held.resolve();
			await view?.close();
			await server.stop();
		}
	},
	30_000,
);

check(
	"reopening the cockpit resolves its uncertain report before a correction (632)",
	async () => {
		const { server, run, path } = await fixture(2);
		let view: Awaited<ReturnType<typeof openPage>> | null = null;
		try {
			view = await openPage(server, { path });
			const { page } = view;
			await ready(page);
			const reports: unknown[] = [];
			await page.route("**/report", (route) => {
				reports.push(route.request().postDataJSON());
				return reports.length === 1 ? route.abort() : route.continue();
			});
			await page.route("**/command", (route) => route.abort());
			await fail(page, "Uncertain failure");
			await page
				.locator("#stat")
				.filter({ hasText: "check the same request before recording another result" })
				.waitFor();
			await page.locator("#list").getByRole("link", { name: "Runs", exact: true }).click();
			await page.getByRole("option").filter({ hasText: "Cockpit corrections" }).click();
			await page.keyboard.press("Enter");
			await page.locator('[data-slot="1"]').click();
			await ready(page);
			await page.unroute("**/command");
			await page.keyboard.press("p");
			await page.locator("#stat").filter({ hasText: "C-1 fail recorded" }).waitFor();
			expect(reports).toHaveLength(2);
			expect(reports[1]).toEqual(reports[0]);
			const recovered = (await slots(server, run))[0]?.fills[0];
			expect(recovered).toMatchObject({ outcome: "fail", note: "Uncertain failure" });
			expect(await page.getByRole("textbox", { name: "Result note" }).inputValue()).toBe("");
			await page.keyboard.press("p");
			await page.locator("#stat").filter({ hasText: "C-1 pass recorded" }).waitFor();
			const rows = await slots(server, run);
			expect(rows[0]?.fills).toMatchObject([{ outcome: "pass", note: null }]);
			expect(rows[0]?.fills).toHaveLength(1);
			expect(rows[0]?.state).toBe("satisfied");
			expect((await server.api("gate", { run })).verdict).toBe("pending");
			expect(reports[2]).toMatchObject({ results: [{ outcome: "pass", corrects: recovered?.result }] });
		} finally {
			await view?.close();
			await server.stop();
		}
	},
	30_000,
);

check(
	"undo refuses a correction that moved after its client check (611)",
	async () => {
		const { server, run, path } = await fixture();
		let view: Awaited<ReturnType<typeof openPage>> | null = null;
		const held = Promise.withResolvers<void>();
		const sent = Promise.withResolvers<number>();
		try {
			view = await openPage(server, { path });
			const { page } = view;
			await ready(page);
			await page.keyboard.press("p");
			await page.locator("#stat").filter({ hasText: "C-1 pass recorded" }).waitFor();
			await fail(page, "First failure");
			await page.locator("#stat").filter({ hasText: "C-1 fail recorded" }).waitFor();
			await page.route("**/report", async (route) => {
				const input = z
					.object({ results: z.array(z.object({ corrects: z.number() })) })
					.parse(route.request().postDataJSON());
				const result = input.results[0];
				if (!result) throw new Error("Undo sent no result");
				sent.resolve(result.corrects);
				await held.promise;
				await route.continue();
			});
			await page.keyboard.press("u");
			const corrects = await sent.promise;
			await server.api("report", {
				run,
				results: [{ test: { case: "C-1" }, outcome: "fail", note: "Newer failure", corrects }],
			});
			const reply = page.waitForResponse((response) => response.url().endsWith("/report"));
			held.resolve();
			expect((await reply).status()).toBe(409);
			await page.locator("#stat").filter({ hasText: "was already corrected" }).waitFor();
			await page.locator(".run-evidence").filter({ hasText: "Newer failure" }).waitFor();
			expect((await slots(server, run))[0]?.fills).toMatchObject([{ outcome: "fail", note: "Newer failure" }]);
			expect((await slots(server, run))[0]?.fills).toHaveLength(1);
			expect((await server.api("gate", { run })).verdict).toBe("blocked");
			expect(
				(await server.api("timeline", { ref: "C-1" })).entries.filter((entry) => entry.t === "result"),
			).toHaveLength(3);
		} finally {
			held.resolve();
			await view?.close();
			await server.stop();
		}
	},
	30_000,
);

check(
	"undo preserves a newer failure recorded in another tab (542)",
	async () => {
		const { server, run, path } = await fixture();
		let view: Awaited<ReturnType<typeof openPage>> | null = null;
		try {
			view = await openPage(server, { path });
			const { page, context } = view;
			await ready(page);
			await page.keyboard.press("p");
			await page.locator("#stat").filter({ hasText: "C-1 pass recorded" }).waitFor();
			await fail(page, "First tab failure");
			await page.locator("#stat").filter({ hasText: "C-1 fail recorded" }).waitFor();
			const other = await context.newPage();
			await other.goto(`${server.url}${path}`);
			await other.locator('[data-slot="1"]').click();
			await ready(other);
			await fail(other, "Second tab new failure");
			await other.locator("#stat").filter({ hasText: "C-1 fail recorded" }).waitFor();
			await page.locator(".run-evidence").filter({ hasText: "Second tab new failure" }).waitFor();
			await page.bringToFront();
			await page.keyboard.press("u");
			await eventually(
				async () => ({ status: await page.locator("#stat").innerText(), rows: await slots(server, run) }),
				({ status, rows }) => status.includes("changed since") || rows[0]?.fills[0]?.outcome === "pass",
			);
			await screenshot(page, 542);
			expect((await server.api("gate", { run })).verdict).toBe("blocked");
			expect((await slots(server, run))[0]?.fills).toMatchObject([{ outcome: "fail", note: "Second tab new failure" }]);
			expect(
				(await server.api("timeline", { ref: "C-1" })).entries.filter((entry) => entry.t === "result"),
			).toHaveLength(3);
		} finally {
			await view?.close();
			await server.stop();
		}
	},
	30_000,
);

check(
	"undo restores confirmed evidence after a queued predecessor is refused (543)",
	async () => {
		const { server, run, path } = await fixture();
		let view: Awaited<ReturnType<typeof openPage>> | null = null;
		const held = Promise.withResolvers<void>();
		const sent = Promise.withResolvers<void>();
		try {
			view = await openPage(server, { path });
			const { page } = view;
			await ready(page);
			let attempts = 0;
			await page.route("**/report", async (route) => {
				const input = z
					.object({ results: z.array(z.object({ outcome: z.string() })) })
					.parse(route.request().postDataJSON());
				if (input.results[0]?.outcome !== "pass") return route.continue();
				if (++attempts > 2) return route.continue();
				if (attempts === 1) {
					sent.resolve();
					await held.promise;
					return route.abort();
				}
				return route.fulfill({ status: 400, json: { ok: false, error: { code: "invalid", message: "Pass refused" } } });
			});
			await page.keyboard.press("p");
			await sent.promise;
			await fail(page, "Actually fails");
			held.resolve();
			await page.locator("#stat").filter({ hasText: "C-1 fail recorded" }).waitFor();
			expect(
				(await server.api("timeline", { ref: "C-1" })).entries.filter((entry) => entry.t === "result"),
			).toMatchObject([{ outcome: "fail", note: "Actually fails" }]);
			await page.keyboard.press("u");
			const history = await eventually(
				() => server.api("timeline", { ref: "C-1" }),
				(row) => row.entries.filter((entry) => entry.t === "result").length === 2,
			);
			await eventually(
				() => page.locator(".run-evidence").innerText(),
				(text) => text.includes("Withdrawn by the author"),
			);
			const gate = await server.api("gate", { run });
			await page.locator(".run-verdict").filter({ hasText: gate.reason }).waitFor();
			await screenshot(page, 543);
			expect(history.entries.filter((entry) => entry.t === "result").map((entry) => entry.outcome)).toEqual([
				"skip",
				"fail",
			]);
			expect(gate).toMatchObject({ verdict: "pending", tally: { pass: 0 } });
		} finally {
			held.resolve();
			await view?.close();
			await server.stop();
		}
	},
	30_000,
);

for (const outcome of ["pass", "skip", "blocked"] as const)
	check(
		`a second required person can navigate to and fill another person's ${outcome} slot (612)`,
		async () => {
			const { server, run, path } = await fixture(2, 2);
			let view: Awaited<ReturnType<typeof openPage>> | null = null;
			try {
				await server.api("report", { run, results: [{ test: { case: "C-1" }, outcome }] });
				const { token } = z.object({ token: z.string() }).parse(
					await server.api("admin", {
						do: "token.create",
						actor: "second-person",
						kind: "human",
						can: ["read", "produce"],
						project: "scratch",
					}),
				);
				view = await openPage({ ...server, token }, { path });
				const { page } = view;
				await page.locator('[data-slot="1"]').click();
				await ready(page);
				if (outcome === "skip") await screenshot(page, 612);
				expect(await page.getByRole("button", { name: "p Pass", exact: true }).isEnabled()).toBe(true);
				await page.getByRole("option").filter({ hasText: "C-2" }).click();
				await page.keyboard.press("k");
				expect(await page.locator('[data-run-document][data-active="true"]').getAttribute("data-run-document")).toBe(
					"C-1",
				);
				await page.keyboard.press("p");
				const rows = await eventually(
					() => slots(server, run),
					(rows) => rows[0]?.fills.some((fill) => fill.by === "second-person") === true,
				);
				expect(rows[0]?.fills.map(({ by, outcome }) => ({ by, outcome }))).toEqual([
					{ by: "robin", outcome },
					{ by: "second-person", outcome: "pass" },
				]);
				expect(rows[0]?.state).toBe(outcome === "pass" ? "satisfied" : "missing");
				if (outcome !== "pass") {
					expect((await server.api("gate", { run })).tally.missing).toBe(2);
					expect((await server.api("inbox", { kind: "signoff" })).items).toHaveLength(0);
					await server.api("report", {
						run,
						results: [{ test: { case: "C-1" }, outcome: "pass", corrects: rows[0]?.fills[0]?.result }],
					});
					expect((await slots(server, run))[0]?.state).toBe("satisfied");
				}
			} finally {
				await view?.close();
				await server.stop();
			}
		},
		30_000,
	);

check(
	"undo restores an earlier failure's attachments and step (548)",
	async () => {
		const { server, run, path } = await fixture(2);
		let view: Awaited<ReturnType<typeof openPage>> | null = null;
		try {
			view = await openPage(server, { path });
			const { page } = view;
			await ready(page);
			await page
				.getByLabel("Attach a file")
				.setInputFiles({ name: "proof.txt", mimeType: "text/plain", buffer: Buffer.from("Original failure proof") });
			await page.getByRole("button", { name: "Remove proof.txt" }).waitFor();
			await page.keyboard.press("1");
			await fail(page, "Original failure");
			await page.locator("#stat").filter({ hasText: "C-1 fail recorded" }).waitFor();
			await page.keyboard.press("k");
			await page.getByRole("button", { name: "Download proof.txt" }).waitFor();
			await page.keyboard.press("p");
			await page.locator("#stat").filter({ hasText: "C-1 pass recorded" }).waitFor();
			await page.keyboard.press("u");
			const rows = await eventually(
				() => slots(server, run),
				(rows) => rows[0]?.fills[0]?.outcome === "fail",
			);
			const restored = rows[0]?.fills[0];
			if (!restored) throw new Error("Restored result missing");
			await page.locator(".run-evidence").filter({ hasText: "Original failure" }).waitFor();
			const listed = AttachmentReply.parse(await server.api("attachment", { result: restored.result }));
			if (listed.kind === "list" && listed.items.length)
				await page.getByRole("button", { name: "Download proof.txt" }).waitFor();
			await screenshot(page, 548);
			expect(listed).toMatchObject({ kind: "list", items: [{ name: "proof.txt", at: "open" }] });
			if (listed.kind !== "list" || !listed.items[0]) throw new Error("Restored attachment missing");
			expect(
				AttachmentReply.parse(await server.api("attachment", { result: restored.result, id: listed.items[0].id })),
			).toMatchObject({ kind: "file", data: Buffer.from("Original failure proof").toString("base64") });
			expect(restored).toMatchObject({ outcome: "fail", note: "Original failure", atStep: "open" });
			await page.getByRole("button", { name: "Download proof.txt" }).waitFor();
		} finally {
			await view?.close();
			await server.stop();
		}
	},
	30_000,
);

for (const fault of ["list", "file"] as const)
	check(
		`undo remains available after an attachment ${fault} read fails (612)`,
		async () => {
			const { server, run, path } = await fixture(2);
			let view: Awaited<ReturnType<typeof openPage>> | null = null;
			try {
				view = await openPage(server, { path });
				const { page } = view;
				await ready(page);
				await page.getByLabel("Attach a file").setInputFiles({
					name: "proof.txt",
					mimeType: "text/plain",
					buffer: Buffer.from("Original failure proof"),
				});
				await page.getByRole("button", { name: "Remove proof.txt" }).waitFor();
				await page.keyboard.press("1");
				await fail(page, "Original failure");
				await page.locator("#stat").filter({ hasText: "C-1 fail recorded" }).waitFor();
				await page.keyboard.press("k");
				await page.keyboard.press("p");
				await page.locator("#stat").filter({ hasText: "C-1 pass recorded" }).waitFor();
				const before = (await server.api("timeline", { ref: "C-1" })).entries.filter((entry) => entry.t === "result");
				let reports = 0;
				await page.route("**/report", (route) => {
					reports++;
					return route.continue();
				});
				await page.route("**/attachment", (route) => {
					const input = z.object({ id: z.number().optional() }).parse(route.request().postDataJSON());
					if (fault === "file" && !input.id) return route.continue();
					return route.fulfill({
						status: fault === "file" ? 404 : 500,
						json: {
							ok: false,
							error: { code: fault === "file" ? "not_found" : "internal", message: "Earlier attachment unavailable" },
						},
					});
				});
				await page.keyboard.press("u");
				await page.locator("#stat").filter({ hasText: "Earlier attachment unavailable" }).waitFor();
				expect(reports).toBe(0);
				expect((await server.api("timeline", { ref: "C-1" })).entries.filter((entry) => entry.t === "result")).toEqual(
					before,
				);
				if (fault === "file") await screenshot(page, 6120);
				await page.unroute("**/attachment");
				expect(await page.getByRole("button", { name: "u correct", exact: true }).count()).toBe(1);
				await page.keyboard.press("u");
				await page.locator("#stat").filter({ hasText: "C-1 fail recorded" }).waitFor();
				const restored = (await slots(server, run))[0]?.fills[0];
				if (!restored) throw new Error("Restored failure missing");
				expect(restored).toMatchObject({ outcome: "fail", note: "Original failure", atStep: "open" });
				expect(reports).toBe(1);
				const listed = AttachmentReply.parse(await server.api("attachment", { result: restored.result }));
				expect(listed).toMatchObject({ kind: "list", items: [{ name: "proof.txt", at: "open" }] });
				if (listed.kind !== "list" || !listed.items[0]) throw new Error("Restored attachment missing");
				expect(
					AttachmentReply.parse(await server.api("attachment", { result: restored.result, id: listed.items[0].id })),
				).toMatchObject({ kind: "file", data: Buffer.from("Original failure proof").toString("base64") });
				expect(
					(await server.api("timeline", { ref: "C-1" })).entries.filter((entry) => entry.t === "result"),
				).toHaveLength(3);
			} finally {
				await view?.close();
				await server.stop();
			}
		},
		30_000,
	);

check(
	"a pending undo suppresses duplicates and keeps a newer result available to undo (612)",
	async () => {
		const { server, run, path } = await fixture(2);
		let view: Awaited<ReturnType<typeof openPage>> | null = null;
		const held = Promise.withResolvers<void>();
		const sent = Promise.withResolvers<void>();
		try {
			view = await openPage(server, { path });
			const { page } = view;
			await ready(page);
			await page.keyboard.press("p");
			await page.locator("#stat").filter({ hasText: "C-1 pass recorded" }).waitFor();
			let corrections = 0;
			await page.route("**/report", async (route) => {
				const input = z
					.object({ results: z.array(z.object({ corrects: z.number().optional() })) })
					.parse(route.request().postDataJSON());
				if (input.results[0]?.corrects && ++corrections === 1) {
					sent.resolve();
					await held.promise;
				}
				await route.continue();
			});
			await page.keyboard.press("u");
			await sent.promise;
			await page.keyboard.press("u");
			await page.locator('[data-slot="2"]').click();
			await page.keyboard.press("p");
			await page.locator("#stat").filter({ hasText: "C-2 pass recorded" }).waitFor();
			held.resolve();
			await page.locator("#stat").filter({ hasText: "C-1 skip recorded" }).waitFor();
			expect(corrections).toBe(1);
			await page.keyboard.press("u");
			await page.locator("#stat").filter({ hasText: "C-2 skip recorded" }).waitFor();
			expect(corrections).toBe(2);
			expect((await slots(server, run)).map((slot) => slot.fills.map((fill) => fill.outcome))).toEqual([
				["skip"],
				["skip"],
			]);
			for (const ref of ["C-1", "C-2"])
				expect((await server.api("timeline", { ref })).entries.filter((entry) => entry.t === "result")).toHaveLength(2);
			expect(await page.getByRole("button", { name: "u correct", exact: true }).count()).toBe(0);
		} finally {
			held.resolve();
			await view?.close();
			await server.stop();
		}
	},
	30_000,
);

for (const outcome of ["skip", "blocked"] as const)
	check(
		`automatic navigation leaves one's own ${outcome} recorded while the run still needs proof (612)`,
		async () => {
			const { server, run, path } = await fixture(3);
			let view: Awaited<ReturnType<typeof openPage>> | null = null;
			const staleRead = Promise.withResolvers<void>();
			const freshRead = Promise.withResolvers<void>();
			try {
				view = await openPage(server, { path });
				const { page } = view;
				await ready(page);
				// A delayed slot read can predate a report whose receipt has already arrived.
				let stale: Api["find"]["reply"] | null = null;
				let served = false;
				await page.route("**/find", async (route) => {
					const input = z.object({ in: z.string() }).parse(route.request().postDataJSON());
					if (input.in === "slots" && stale) {
						if (!served) {
							served = true;
							await answer(route, { json: { ok: true, result: stale } });
							staleRead.resolve();
							return;
						}
						// Later reads must return current server state, not replay the old snapshot.
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
						await staleRead.promise;
						if (reply) await answer(route, { response: reply.response });
					} else {
						stale = null;
						if (input.results[0]?.test.case === "C-3") freshRead.resolve();
						await route.continue();
					}
				});
				await page.keyboard.press(outcome === "skip" ? "s" : "b");
				await page
					.locator("#stat")
					.filter({ hasText: `C-1 ${outcome} recorded` })
					.waitFor();
				await page.locator('[data-run-document="C-2"][data-active="true"][data-ready="true"]').waitFor();
				await page.keyboard.press("p");
				await page.locator("#stat").filter({ hasText: "C-2 pass recorded" }).waitFor();
				await page.locator('[data-run-document="C-3"][data-active="true"][data-ready="true"]').waitFor();
				await page.keyboard.press("p");
				await page.locator("#stat").filter({ hasText: "C-3 pass recorded" }).waitFor();
				await page
					.getByText("Nothing left for you to run. The server verdict is shown above.", { exact: true })
					.waitFor();
				if (outcome === "skip") await screenshot(page, 6121);
				expect(await page.locator('[data-run-document][data-active="true"]').getAttribute("data-run-document")).toBe(
					"C-3",
				);
				expect(await page.locator("#list .phead").innerText()).toContain("1 left in run");
				expect(await page.getByRole("complementary", { name: "Up next" }).count()).toBe(0);
				expect(await server.api("gate", { run })).toMatchObject({ verdict: "pending", tally: { missing: 1 } });
				expect((await slots(server, run)).map((slot) => slot.fills.map((fill) => fill.outcome))).toEqual([
					[outcome],
					["pass"],
					["pass"],
				]);
				await page.keyboard.press("k");
				await page.keyboard.press("k");
				expect(await page.locator('[data-run-document][data-active="true"]').getAttribute("data-run-document")).toBe(
					"C-1",
				);
				expect(await page.getByRole("button", { name: "p Pass", exact: true }).isEnabled()).toBe(true);
				await page.keyboard.press("j");
				expect(await page.locator('[data-run-document][data-active="true"]').getAttribute("data-run-document")).toBe(
					"C-2",
				);
				await page.keyboard.press("k");
				expect(await page.locator('[data-run-document][data-active="true"]').getAttribute("data-run-document")).toBe(
					"C-1",
				);
				await page.locator('[data-slot="3"]').click();
				await page.locator('[data-slot="1"]').click();
				expect(await page.locator('[data-run-document][data-active="true"]').getAttribute("data-run-document")).toBe(
					"C-1",
				);
				await page.locator("#list").getByRole("link", { name: "Runs", exact: true }).click();
				await page.getByRole("option").filter({ hasText: "Cockpit corrections" }).click();
				await page.keyboard.press("Enter");
				await page
					.getByText("Nothing left for you to run. The server verdict is shown above.", { exact: true })
					.waitFor();
				expect(await page.locator('[data-run-document][data-active="true"]').getAttribute("data-run-document")).toBe(
					"C-1",
				);
				await ready(page);
				await page.keyboard.press("j");
				expect(await page.locator('[data-run-document][data-active="true"]').getAttribute("data-run-document")).toBe(
					"C-2",
				);
				await page.keyboard.press("k");
				expect(await page.locator('[data-run-document][data-active="true"]').getAttribute("data-run-document")).toBe(
					"C-1",
				);
				expect(await page.locator("#list .phead").innerText()).toContain("1 left in run");
			} finally {
				staleRead.resolve();
				freshRead.resolve();
				await view?.close();
				await server.stop();
			}
		},
		30_000,
	);

for (const outcome of ["skip", "blocked", "pass"] as const)
	check(
		`opening the cockpit skips one's own ${outcome} when proof is unfinished (612)`,
		async () => {
			const { server, run, path } = await fixture(3, 2);
			let view: Awaited<ReturnType<typeof openPage>> | null = null;
			try {
				await server.api("report", { run, results: [{ test: { case: "C-1" }, outcome }] });
				view = await openPage(server, { path });
				const { page } = view;
				await page.locator('[data-run-document][data-active="true"][data-ready="true"]').waitFor();
				expect(await page.locator('[data-run-document][data-active="true"]').getAttribute("data-run-document")).toBe(
					"C-2",
				);
				await page.keyboard.press("k");
				expect(await page.locator('[data-run-document][data-active="true"]').getAttribute("data-run-document")).toBe(
					"C-1",
				);
			} finally {
				await view?.close();
				await server.stop();
			}
		},
		30_000,
	);

for (const mode of ["open", "closed", "read-only"] as const)
	check(
		`a fully reported ${mode} run opens a ready document for reading (612)`,
		async () => {
			const { server, run, path } = await fixture(3);
			let view: Awaited<ReturnType<typeof openPage>> | null = null;
			try {
				await server.api("report", {
					run,
					results: [1, 2, 3].map((id) => ({ test: { case: `C-${id}` }, outcome: "pass" })),
				});
				if (mode === "closed") {
					const signoff = (await server.api("inbox", { kind: "signoff" })).items[0];
					if (!signoff) throw new Error("Missing sign-off");
					await server.api("decide", {
						q: signoff.q,
						onEvidence: signoff.evidenceHash,
						answer: { is: "approve" },
						reason: "All three cases passed.",
					});
					expect(z.object({ state: z.string() }).parse((await server.api("get", { refs: [run] }))[0]).state).toBe(
						"closed",
					);
				}
				const token =
					mode === "read-only"
						? z.object({ token: z.string() }).parse(
								await server.api("admin", {
									do: "token.create",
									actor: "viewer",
									kind: "human",
									can: ["read"],
									project: "scratch",
								}),
							).token
						: server.token;
				view = await openPage({ ...server, token }, { path });
				const { page } = view;
				await page.getByRole("option").filter({ hasText: "C-1" }).waitFor();
				expect(await page.locator('[data-run-document][data-active="true"]').count()).toBe(1);
				await ready(page);
				if (mode === "open" && process.env.MAINWORTHY_COCKPIT_EVIDENCE) {
					await page.setViewportSize({ width: 1600, height: 900 });
					await screenshot(page, 6122);
				}
				expect(await page.getByText("Select a run slot to start.", { exact: true }).count()).toBe(0);
				if (mode === "read-only") {
					expect(await page.getByRole("button", { name: "p Pass", exact: true }).isDisabled()).toBe(true);
				} else {
					await page.keyboard.press("j");
					expect(await page.locator('[data-run-document][data-active="true"]').getAttribute("data-run-document")).toBe(
						"C-2",
					);
					await page.keyboard.press("k");
					expect(await page.locator('[data-run-document][data-active="true"]').getAttribute("data-run-document")).toBe(
						"C-1",
					);
					expect(await page.getByRole("button", { name: "p Pass", exact: true }).isEnabled()).toBe(mode === "open");
				}
				expect((await slots(server, run)).map((slot) => slot.fills.map((fill) => fill.outcome))).toEqual([
					["pass"],
					["pass"],
					["pass"],
				]);
			} finally {
				await view?.close();
				await server.stop();
			}
		},
		30_000,
	);
