import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { start } from "../../src/app/start.ts";
import type { Api, OpName } from "../../src/core/api.ts";
import { defaultConfig } from "../../src/server/kernel/app.ts";
import { removeProject } from "../../src/server/transfer/transfer.ts";
import ui from "../../src/web/index.html";
import { call } from "../../src/web/lib/api.ts";
import { testDatabase } from "../db.ts";
import { browserAvailable, openPage, type PageHarness, type Server, startServer } from "./support.ts";

const Request = z.object({ cmd: z.string().min(1), projectIdentity: z.string().min(1), edits: z.array(z.unknown()) });

async function twoVersions(server: Server) {
	await server.api("propose", { edits: [{ op: "create", body: { title: "First title" } }] });
	await server.api("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Second title" } }] });
}

async function begin(harness: PageHarness, action: "folder" | "restore") {
	await harness.page.getByRole("button", { name: "Second title", exact: true }).waitFor();
	if (action === "folder") {
		await harness.page.keyboard.type("nf");
		await harness.page.getByRole("textbox", { name: "New folder name" }).fill("New folder");
	}
}

async function submit(harness: PageHarness, action: "folder" | "restore") {
	await harness.page.keyboard.press(action === "folder" ? "Enter" : "u");
}

for (const action of ["folder", "restore"] as const) {
	test.skipIf(!browserAvailable)(`suite ${action} refuses a project replaced after the page loaded`, async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "mainworthy-suite-project-"));
		const database = await testDatabase();
		const token = crypto.randomUUID();
		const instance = await start(
			{
				...defaultConfig({}),
				databaseUrl: database.url,
				dataDir,
				port: 0,
				owner: "robin",
				ownerToken: token,
				mode: "local",
			},
			() => ({ ui }),
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
		let harness: PageHarness | null = null;
		try {
			await twoVersions(server);
			harness = await openPage(server, { path: "/p/scratch/suite/c/1" });
			await begin(harness, action);
			await instance.app.database.write(async (db) => {
				await db.transaction(async () => removeProject(db, "scratch"));
			});
			await server.api("admin", { do: "project.create", key: "scratch", preset: "loose" });
			await twoVersions(server);
			const reply = harness.page.waitForResponse((response) => response.url().endsWith("/propose"));
			await submit(harness, action);
			await reply;
			expect((await server.api("get", { refs: ["C-1"] }))[0]).toMatchObject({ title: "Second title", version: 2 });
			expect((await server.api("find", { in: "folders" })).items.map((folder) => folder.path)).toEqual(["Unsorted"]);
			await harness.page
				.locator("#stat")
				.filter({ hasText: /project was replaced.*Reload/i })
				.waitFor();
			const writes: string[] = [];
			harness.page.on("request", (request) => {
				if (request.url().endsWith("/propose")) writes.push(request.url());
			});
			if (action === "folder") await harness.page.keyboard.press("Escape");
			await harness.page.keyboard.press("u");
			await harness.page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
			expect(writes).toEqual([]);
		} finally {
			await harness?.close();
			await instance.stop();
			await database.close();
			await rm(dataDir, { recursive: true, force: true });
		}
	});

	for (const loss of ["reply", "unsent"] as const) {
		test.skipIf(!browserAvailable)(`suite ${action} recovers a lost ${loss} with its original command`, async () => {
			const server = await startServer();
			await twoVersions(server);
			const harness = await openPage(server, { path: "/p/scratch/suite/c/1" });
			try {
				const { page, context } = harness;
				await begin(harness, action);
				const requests: unknown[] = [];
				const commands: unknown[] = [];
				await context.route("**/api/p/scratch/command", async (route) => {
					commands.push(route.request().postDataJSON());
					await route.continue();
				});
				await context.route("**/api/p/scratch/propose", async (route) => {
					requests.push(route.request().postDataJSON());
					if (requests.length > 1) return route.continue();
					if (loss === "reply") await route.fetch();
					await route.abort("failed");
				});
				await submit(harness, action);
				await page
					.locator("#stat")
					.filter({ hasText: /fetch|failed|unknown/i })
					.waitFor();
				if (action === "restore" && loss === "reply") {
					await server.api("propose", {
						edits: [{ op: "edit", case: "C-1", base: 3, body: { title: "Colleague title" } }],
					});
					await page.getByRole("button", { name: "Colleague title", exact: true }).waitFor();
				}
				await submit(harness, action);
				if (action === "folder")
					await page.getByRole("textbox", { name: "New folder name" }).waitFor({ state: "hidden" });
				else await page.locator("#stat").filter({ hasText: "Previous version restored as a new version." }).waitFor();
				const original = Request.parse(requests[0]);
				expect(commands).toEqual([{ cmd: original.cmd }]);
				expect(requests).toEqual(loss === "reply" ? [original] : [original, original]);
				if (action === "folder") {
					expect((await server.api("find", { in: "folders" })).items.map((folder) => folder.path)).toEqual([
						"Unsorted",
						"New folder",
					]);
				} else {
					expect((await server.api("get", { refs: ["C-1"] }))[0]).toMatchObject(
						loss === "reply" ? { title: "Colleague title", version: 4 } : { title: "First title", version: 3 },
					);
				}
			} finally {
				await harness.close();
				await server.stop();
			}
		});
	}
}
