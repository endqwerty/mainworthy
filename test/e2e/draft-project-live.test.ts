import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start } from "../../src/app/start.ts";
import type { Api, OpName } from "../../src/core/api.ts";
import { defaultConfig } from "../../src/server/kernel/app.ts";
import { removeProject } from "../../src/server/transfer/transfer.ts";
import ui from "../../src/web/index.html";
import { call } from "../../src/web/lib/api.ts";
import { Draft } from "../../src/web/lib/drafts.ts";
import { browserAvailable, openPage, type Server } from "./support.ts";

test.skipIf(!browserAvailable)(
	"an open tab preserves a waiting capture when its project is replaced and its question collides",
	async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "mainworthy-draft-project-live-"));
		const token = "draft-project-live-owner-token";
		const instance = start(
			{ ...defaultConfig({}), dataDir, port: 0, owner: "robin", ownerToken: token, mode: "local" },
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
			const prepare = async () => {
				await server.api("propose", { edits: [{ op: "create", outline: "Existing case\n  Open cart" }] });
				const policy = await server.api("propose", { edits: [{ op: "policy", preset: "strict" }] });
				if (!policy.question) throw new Error("Missing policy question");
				await answer(policy.question, "accept");
			};
			await prepare();
			view = await openPage(server);
			const { page } = view;
			await page.keyboard.press("c");
			await page.keyboard.type("Original project's waiting capture");
			await page.keyboard.press("Enter");
			await page.keyboard.type("Original step");
			await page.keyboard.press("Escape");
			await page.locator("#stat").filter({ hasText: "Proposed, waiting for a person" }).waitFor();
			const drafts = () =>
				page.evaluate(() =>
					Object.keys(localStorage)
						.filter((key) => /^mainworthy:#\d+:draft:/.test(key))
						.map((key) => JSON.parse(localStorage.getItem(key) ?? "null")),
				);
			const before = Draft.parse((await drafts())[0]);
			expect(before.submission).toMatchObject({ kind: "waiting", question: "Q-3" });
			const writes: string[] = [];
			page.on("request", (request) => {
				if (/\/(propose|decide)$/.test(request.url())) writes.push(request.url());
			});
			removeProject(instance.app.db, "scratch");
			await server.api("admin", { do: "project.create", key: "scratch", preset: "loose" });
			await prepare();
			const replacement = await server.api("propose", {
				edits: [{ op: "create", outline: "Replacement project's case\n  Replacement step" }],
			});
			expect(replacement.question).toBe("Q-3");
			await answer("Q-3", "accept");
			// The draft leaves device storage just before its preserved copy renders, so wait for the copy itself (#896).
			await page.getByRole("textbox", { name: "Preserved draft text", exact: true }).waitFor();
			expect(await drafts()).toEqual([]);
			expect(await page.getByRole("textbox", { name: "Preserved draft text", exact: true }).count()).toBe(1);
			expect(await page.getByRole("textbox", { name: "Preserved draft text", exact: true }).inputValue()).toContain(
				before.body.title,
			);
			expect(writes).toEqual([]);
			expect(page.url()).not.toContain("/suite/c/2");
			expect((await server.api("get", { refs: ["C-2"] }))[0]?.title).toBe("Replacement project's case");
			await page.reload();
			const preserved = page.getByRole("textbox", { name: "Preserved draft text", exact: true });
			await preserved.waitFor();
			expect(await preserved.inputValue()).toContain("Original step");
			expect(writes).toEqual([]);
			await page.getByRole("button", { name: "Discard preserved copy", exact: true }).click();
			expect(await preserved.count()).toBe(0);
		} finally {
			await view?.close();
			await instance.stop();
			await rm(dataDir, { recursive: true, force: true });
		}
	},
	30_000,
);

for (const action of ["placement", "undo"] as const) {
	test.skipIf(!browserAvailable)(
		`an open tab refuses ${action} after its project is replaced`,
		async () => {
			const dataDir = await mkdtemp(join(tmpdir(), "mainworthy-placement-project-"));
			const token = "placement-project-owner-token";
			const instance = start(
				{ ...defaultConfig({}), dataDir, port: 0, owner: "robin", ownerToken: token, mode: "local" },
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
				await server.api("propose", { edits: [{ op: "create", body: { title: "Original project case" } }] });
				view = await openPage(server, { path: "/p/scratch/suite/c/1" });
				const { page } = view;
				await page.getByRole("button", { name: "Original project case", exact: true }).waitFor();
				if (action === "undo") {
					await page.keyboard.press("#");
					await page.locator("#stat").filter({ hasText: "1 case changed" }).waitFor();
				}
				removeProject(instance.app.db, "scratch");
				await server.api("admin", { do: "project.create", key: "scratch", preset: "loose" });
				await server.api("propose", { edits: [{ op: "create", body: { title: "Replacement project case" } }] });
				if (action === "undo")
					await server.api("propose", { edits: [{ op: "state", cases: ["C-1"], to: "archived" }] });
				await page.keyboard.press(action === "undo" ? "u" : "#");
				await page.waitForFunction(
					() =>
						!document.querySelector("#stat")?.textContent?.includes("queued") &&
						!document.querySelector("#stat")?.textContent?.includes("Changing cases"),
				);
				if (action === "undo" && process.env.MAINWORTHY_PROJECT_UNDO_SCREENSHOT)
					await page.screenshot({ path: process.env.MAINWORTHY_PROJECT_UNDO_SCREENSHOT });
				expect((await server.api("get", { refs: ["C-1"] }))[0]?.state).toBe(action === "undo" ? "archived" : "active");
				await page
					.locator("#stat")
					.filter({ hasText: "The project was replaced. Undo discarded. Reload before changing cases." })
					.waitFor();
				const writes: string[] = [];
				page.on("request", (request) => {
					if (request.url().endsWith("/propose")) writes.push(request.url());
				});
				await page.keyboard.press("u");
				await page.keyboard.press("u");
				await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
				expect(writes).toEqual([]);
			} finally {
				await view?.close();
				await instance.stop();
				await rm(dataDir, { recursive: true, force: true });
			}
		},
		30_000,
	);
}
