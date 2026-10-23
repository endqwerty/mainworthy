import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { start } from "../../src/app/start.ts";
import type { Api, OpName } from "../../src/core/api.ts";
import { CaseBody } from "../../src/core/model.ts";
import { defaultConfig } from "../../src/server/kernel/app.ts";
import { removeProject } from "../../src/server/transfer/transfer.ts";
import ui from "../../src/web/index.html";
import { call } from "../../src/web/lib/api.ts";
import { Draft } from "../../src/web/lib/drafts.ts";
import { browserAvailable, eventually, openPage, reservePort, type Server, startServer } from "./support.ts";

for (const stage of ["waiting for review", "before its first merge"] as const)
	test.skipIf(!browserAvailable)(
		`a restored conflict ${stage} cannot follow a replacement project's question`,
		async () => {
			const dataDir = await mkdtemp(join(tmpdir(), "mainworthy-draft-state-project-"));
			const port = await reservePort();
			const token = "draft-state-project-owner-token";
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
			try {
				const seed = () => server.api("propose", { edits: [{ op: "create", outline: "Coupon case\n  Open cart" }] });
				const edit = (title: string) =>
					server.api("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: { title } }] });
				const answer = async (q: string, is: "accept" | "reject") => {
					const question = (await server.api("inbox", { kind: "adopt" })).items.find((item) => item.q === q);
					if (!question) throw new Error(`Missing question ${q}`);
					await server.api("decide", {
						q,
						onEvidence: question.evidenceHash,
						answer: { is },
						reason: "Reviewed proposal",
					});
				};
				const strict = async () => {
					const policy = await server.api("propose", { edits: [{ op: "policy", preset: "strict" }] });
					if (!policy.question) throw new Error("Missing policy question");
					await answer(policy.question, "accept");
				};
				await seed();
				view = await openPage(server, { path: "/p/scratch/suite/c/1" });
				const { page } = view;
				const stored = async () =>
					Draft.parse(
						await page.evaluate(() => {
							const key = Object.keys(localStorage).find((key) => key.includes(":draft:") && key.endsWith(":C-1"));
							return key ? JSON.parse(localStorage.getItem(key) ?? "null") : null;
						}),
					);
				await page.getByRole("button", { name: "Coupon case", exact: true }).waitFor();
				await page.keyboard.press("e");
				await page.getByRole("textbox", { name: "Case title", exact: true }).fill("Original project's draft");
				await edit("Other person's title");
				await page.keyboard.press("Escape");
				await page.locator(".conflict-card").waitFor();
				await page.getByRole("textbox", { name: "Merged title", exact: true }).fill("Original project's merge");
				if (stage === "waiting for review") {
					await strict();
					await page.getByRole("button", { name: "Resolve conflict", exact: true }).click();
					await page.locator("#stat").filter({ hasText: "Your merge is proposed and waits for a person" }).waitFor();
				}
				const before = await stored();
				expect(before.sent).toBeNull();
				const question = before.submission.kind === "waiting" ? before.submission.question : before.conflict?.q;
				if (!question) throw new Error("Missing persisted question");
				if (stage === "waiting for review") expect(before.conflict).toBeUndefined();
				else expect(before.conflict?.sentMerges).toEqual([]);
				await page.goto("about:blank");
				removeProject(instance.app.db, "scratch");
				await server.api("admin", { do: "project.create", key: "scratch", preset: "loose" });
				await seed();
				if (stage === "waiting for review") {
					await strict();
					let collision: string | null = null;
					for (let index = 0; index < 10 && collision !== question; index++)
						collision = (await edit(`Replacement proposal ${index}`)).question;
					expect(collision).toBe(question);
					await answer(question, "reject");
				} else {
					await edit("Replacement current");
					expect((await edit("Replacement draft")).question).toBe(question);
				}
				const requests: string[] = [];
				page.on("request", (request) => {
					if (/\/(propose|decide|command)$/.test(request.url())) requests.push(request.url());
					if (
						request.url().endsWith("/get") &&
						z
							.object({ refs: z.array(z.string()) })
							.parse(request.postDataJSON())
							.refs.includes(question)
					)
						requests.push(`question ${question}`);
				});
				await page.goto(`${server.url}/p/scratch/suite/c/1`);
				await eventually(
					async () => ({ copied: await page.locator(".preserved-draft").count(), requests: requests.length }),
					(state) => state.copied > 0 || state.requests > 0,
				);
				expect(requests).toEqual([]);
				expect(await page.getByRole("textbox", { name: "Preserved draft text", exact: true }).inputValue()).toContain(
					before.body.title,
				);
				if (before.conflict)
					expect(await page.getByRole("textbox", { name: "Preserved merge text", exact: true }).inputValue()).toContain(
						before.conflict.merged.title,
					);
				expect((await server.api("get", { refs: ["C-1"] }))[0]?.title).toBe(
					stage === "waiting for review" ? "Coupon case" : "Replacement current",
				);
				await page.reload();
				await page.getByRole("textbox", { name: "Preserved draft text", exact: true }).waitFor();
				expect(requests).toEqual([]);
			} finally {
				await view?.close();
				await instance.stop();
				await port.release();
				await rm(dataDir, { recursive: true, force: true });
			}
		},
		30_000,
	);

for (const attempt of ["save", "merge"] as const)
	for (const project of ["replacement", "replacement after retry", "unbound"] as const)
		test.skipIf(!browserAvailable)(
			`a refused ${attempt} keeps a discardable copy and releases its case (${project})`,
			async () => {
				const dataDir = await mkdtemp(join(tmpdir(), "mainworthy-draft-project-"));
				const port = await reservePort();
				const token = "draft-project-test-owner-token";
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
				try {
					const seed = () => server.api("propose", { edits: [{ op: "create", outline: "Coupon case\n  Open cart" }] });
					const edit = (base: number, title: string) =>
						server.api("propose", { edits: [{ op: "edit", case: "C-1", base, body: { title } }] });
					await seed();
					view = await openPage(server, { path: "/p/scratch/suite/c/1" });
					const { page } = view;
					const saved = async () =>
						Draft.parse(
							await page.evaluate(() => {
								const key = Object.keys(localStorage).find((key) => key.includes(":draft:") && key.endsWith(":C-1"));
								return key ? JSON.parse(localStorage.getItem(key) ?? "null") : null;
							}),
						);
					await page.getByRole("button", { name: "Coupon case", exact: true }).waitFor();
					await page.keyboard.press("e");
					await page.getByRole("textbox", { name: "Case title", exact: true }).fill("Original project's draft");
					if (attempt === "merge") {
						await edit(1, "Other person's title");
						await page.keyboard.press("Escape");
						await page.locator(".conflict-card").waitFor();
						await page
							.getByRole("textbox", { name: "Merged title", exact: true })
							.fill("Original project's merge #retained @REQ-755");
					}
					const operation = attempt === "save" ? "propose" : "decide";
					const sent: unknown[] = [];
					await page.route(`**/${operation}`, async (route) => {
						sent.push(route.request().postDataJSON());
						const response = await route.fetch();
						expect(response.ok()).toBe(true);
						await route.abort();
					});
					if (attempt === "save") await page.keyboard.press("Escape");
					else await page.getByRole("button", { name: "Resolve conflict", exact: true }).click();
					await page
						.locator("#stat")
						.filter({ hasText: attempt === "save" ? "kept on this device" : "conflict card are kept" })
						.waitFor();
					const before = await saved();
					const command = z.object({ cmd: z.string(), projectIdentity: z.string() }).parse(sent[0]);
					expect(before.projectIdentity).toBe(command.projectIdentity);
					if (attempt === "save") expect(before.sent?.input).toMatchObject(command);
					else {
						const { answer } = z
							.object({ answer: z.object({ body: CaseBody, tags: z.array(z.string()), covers: z.array(z.string()) }) })
							.parse(sent[0]);
						expect(answer).toMatchObject({
							body: { title: "Original project's merge" },
							tags: ["retained"],
							covers: ["REQ-755"],
						});
						expect(before.conflict?.sentMerges).toEqual([{ cmd: command.cmd, ...answer }]);
					}
					const refusal =
						project === "replacement after retry"
							? page.waitForResponse(
									(response) =>
										response.url().endsWith(`/${attempt === "merge" ? "get" : operation}`) && response.status() === 409,
								)
							: null;
					if (project !== "unbound") {
						removeProject(instance.app.db, "scratch");
						await server.api("admin", { do: "project.create", key: "scratch", preset: "loose" });
						await seed();
						if (attempt === "merge") {
							await edit(1, "Other person's title");
							const conflict = await edit(1, "Original project's draft");
							expect(conflict.question).toBe(before.conflict?.q ?? null);
						}
						if (project === "replacement after retry") {
							await page.unroute(`**/${operation}`);
							if (attempt === "save") await page.keyboard.press("Control+Enter");
							if (!refusal) throw new Error("Missing obsolete-project refusal");
							expect(await (await refusal).json()).toMatchObject({
								ok: false,
								error: { details: { projectIdentity: "obsolete" } },
							});
							await page.locator(".preserved-draft").waitFor();
							expect(
								await page.evaluate(() => Object.keys(localStorage).filter((key) => key.includes(":draft:")).length),
							).toBe(0);
							await page
								.locator("#stat")
								.filter({ hasText: /obsolete project|cannot be retried here/ })
								.waitFor();
						}
					} else {
						// The recorded merge refreshes the draft's tags even when its reply is lost.
						// Let that write finish before replacing the live draft with an unbound fixture.
						if (attempt === "merge") await eventually(saved, (draft) => draft.originalTags.includes("retained"));
						await page.evaluate(() => {
							for (const key of Object.keys(localStorage)) {
								if (!key.includes(":draft:")) continue;
								const draft = JSON.parse(localStorage.getItem(key) ?? "null");
								for (const sent of draft.conflict?.sentMerges ?? []) sent.projectIdentity = draft.projectIdentity;
								delete draft.projectIdentity;
								localStorage.setItem(key, JSON.stringify(draft));
							}
						});
					}
					const head = await server.api("get", { refs: ["C-1"] });
					const recovery: string[] = [];
					page.on("request", (request) => {
						if (/\/(propose|decide|command)$/.test(request.url())) recovery.push(request.url());
					});
					await page.reload();
					const preserved = page.getByRole("textbox", { name: "Preserved draft text", exact: true });
					await preserved.waitFor();
					expect(await preserved.inputValue()).toContain(before.body.title);
					if (attempt === "merge")
						expect(
							await page.getByRole("textbox", { name: "Preserved merge text", exact: true }).inputValue(),
						).toContain(before.conflict?.merged.title ?? "missing");
					expect(await page.locator(".preserved-draft").textContent()).toContain("gone or cannot be identified");
					expect(await page.locator(".conflict-card").count()).toBe(0);
					expect(recovery).toEqual([]);
					expect(await server.api("get", { refs: ["C-1"] })).toEqual(head);
					expect(
						await page.evaluate(() => Object.keys(localStorage).filter((key) => key.includes(":draft:")).length),
					).toBe(0);
					const copies = await page.evaluate(() =>
						Object.keys(localStorage)
							.filter((key) => key.includes(":draft-copy:"))
							.map((key) => JSON.parse(localStorage.getItem(key) ?? "null")),
					);
					const copy = z.array(z.object({ draft: Draft })).parse(copies)[0]?.draft;
					expect(copy?.body).toEqual(before.body);
					expect(copy?.conflict?.merged).toEqual(before.conflict?.merged);
					expect(copy?.sent).toBeNull();
					if (copy?.conflict) expect(copy.conflict.sentMerges).toEqual([]);
					await page.reload();
					await preserved.waitFor();
					expect(await preserved.inputValue()).toContain(before.body.title);
					expect(recovery).toEqual([]);
					if (project === "unbound")
						await page.getByRole("button", { name: "Discard preserved copy", exact: true }).click();
					await page.unroute(`**/${operation}`);
					// The preserved copy can render before the current case has been read.
					await page.locator("#detail .read-body .ctitle").waitFor();
					await page.keyboard.press("e");
					await page.getByRole("textbox", { name: "Case title", exact: true }).fill("Current project's fresh edit");
					await page.keyboard.press("Escape");
					await eventually(
						() => server.api("get", { refs: ["C-1"] }),
						(rows) => rows[0]?.title === "Current project's fresh edit",
					);
					await page
						.locator("#stat")
						.filter({ hasText: /Version \d+, by you/ })
						.waitFor();
					expect(recovery).toHaveLength(1);
					expect(recovery[0]).toEndWith("/propose");
					if (project !== "unbound") {
						expect(await preserved.inputValue()).toContain(before.body.title);
						await page.getByRole("button", { name: "Discard preserved copy", exact: true }).click();
					}
					await page.reload();
					await page.getByRole("button", { name: "Current project's fresh edit", exact: true }).waitFor();
					expect(await page.locator(".preserved-draft").count()).toBe(0);
				} finally {
					await view?.close();
					await instance.stop();
					await port.release();
					await rm(dataDir, { recursive: true, force: true });
				}
			},
			30_000,
		);

test.skipIf(!browserAvailable)(
	"a refused new-case draft keeps a discardable copy after releasing its capture",
	async () => {
		const server = await startServer();
		const view = await openPage(server);
		try {
			const { page } = view;
			await page.route("**/propose", async (route) => {
				await route.fetch();
				await route.abort();
			});
			await page.route("**/command", (route) => route.abort());
			await page.keyboard.press("c");
			await page.keyboard.type("Original capture");
			await page.keyboard.press("Escape");
			await page.locator("#stat").filter({ hasText: "kept on this device" }).waitFor();
			const changed = await page.evaluate(() => {
				let changed = 0;
				for (const key of Object.keys(localStorage)) {
					if (!key.includes(":draft:")) continue;
					const draft = JSON.parse(localStorage.getItem(key) ?? "null");
					if (!draft.sent) continue;
					delete draft.projectIdentity;
					localStorage.setItem(key, JSON.stringify(draft));
					changed++;
				}
				return changed;
			});
			expect(changed).toBe(1);
			await page.reload();
			const preserved = page.getByRole("textbox", { name: "Preserved draft text", exact: true });
			await preserved.waitFor();
			expect(await preserved.inputValue()).toContain("Original capture");
			await page.reload();
			await preserved.waitFor();
			await page.unroute("**/propose");
			await page.unroute("**/command");
			await page.keyboard.press("c");
			await page.keyboard.type("Fresh capture");
			await page.keyboard.press("Enter");
			await page.keyboard.type("Fresh step");
			await page.keyboard.press("Escape");
			await page.waitForURL("**/suite/c/2");
			await page.goto(`${server.url}/p/scratch/suite`);
			await preserved.waitFor();
			expect(await preserved.inputValue()).toContain("Original capture");
			await page.getByRole("button", { name: "Discard preserved copy", exact: true }).click();
			expect(await page.locator(".preserved-draft").count()).toBe(0);
			expect((await server.api("find", { in: "cases" })).items).toHaveLength(2);
		} finally {
			await view.close();
			await server.stop();
		}
	},
	30_000,
);
