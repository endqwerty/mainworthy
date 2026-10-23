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
import { browserAvailable, eventually, openPage, reservePort, type Server } from "./support.ts";

for (const attempt of ["save", "merge"] as const)
	for (const project of ["replacement", "replacement after retry", "unbound"] as const)
		test.skipIf(!browserAvailable)(
			`a lost ${attempt} reply cannot recover into a ${project} project after reload`,
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
						expect(before.conflict?.sentMerges).toEqual([{ ...command, ...answer }]);
					}
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
							else await page.getByRole("button", { name: "Resolve conflict", exact: true }).click();
							await page
								.locator("#stat")
								.filter({ hasText: /obsolete project|cannot be retried here/ })
								.waitFor();
						}
					} else {
						await page.evaluate(() => {
							for (const key of Object.keys(localStorage)) {
								if (!key.includes(":draft:")) continue;
								const draft = JSON.parse(localStorage.getItem(key) ?? "null");
								if (draft.sent) delete draft.sent.input.projectIdentity;
								for (const sent of draft.conflict?.sentMerges ?? []) delete sent.projectIdentity;
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
					await eventually(
						() => page.locator("#stat").textContent(),
						(status) => recovery.length > 0 || Boolean(status?.includes("cannot be retried here")),
					);
					expect(recovery).toEqual([]);
					if (attempt === "save") {
						expect(await page.getByRole("textbox", { name: "Case title", exact: true }).inputValue()).toBe(
							before.body.title,
						);
						await page.keyboard.press("Control+Enter");
					} else {
						expect(await page.getByRole("textbox", { name: "Merged title", exact: true }).inputValue()).toBe(
							before.conflict?.merged.title ?? "missing",
						);
						await page.getByRole("button", { name: "Resolve conflict", exact: true }).click();
					}
					await page.locator("#stat").filter({ hasText: "cannot be retried here" }).waitFor();
					expect(recovery).toEqual([]);
					expect(await server.api("get", { refs: ["C-1"] })).toEqual(head);
					const after = await saved();
					expect(after.body).toEqual(before.body);
					expect(after.conflict?.merged).toEqual(before.conflict?.merged);
					if (attempt === "merge") {
						const first = before.conflict?.sentMerges[0];
						if (!first) throw new Error("Missing saved merge attempt");
						const { projectIdentity, ...unbound } = first;
						expect(after.conflict?.sentMerges[0]).toEqual(
							project === "unbound" ? unbound : { ...unbound, projectIdentity },
						);
					}
				} finally {
					await view?.close();
					await instance.stop();
					await port.release();
					await rm(dataDir, { recursive: true, force: true });
				}
			},
			30_000,
		);
