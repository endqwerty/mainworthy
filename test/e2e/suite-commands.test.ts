import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { start } from "../../src/app/start.ts";
import type { Api, OpName } from "../../src/core/api.ts";
import { Policy } from "../../src/core/kinds.ts";
import { defaultConfig } from "../../src/server/kernel/app.ts";
import { lockNamedProject } from "../../src/server/kernel/ctx.ts";
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
			harness = await openPage(server, {
				path: "/p/scratch/suite/c/1",
				// Keep the old project loaded so the command, rather than a stream refresh, discovers replacement.
				setup: async (page) => {
					await page.addInitScript(() => {
						Reflect.set(
							window,
							"EventSource",
							class {
								close(): void {}
							},
						);
					});
				},
			});
			await begin(harness, action);
			if (action === "restore")
				await harness.page.locator("#detail .ctitle").filter({ hasText: "Second title" }).waitFor();
			await instance.app.database.write(async (db) => {
				await db.transaction(async () => {
					await lockNamedProject(db, "scratch");
					await removeProject(db, "scratch");
				});
			});
			await server.api("admin", { do: "project.create", key: "scratch", preset: "loose" });
			await twoVersions(server);
			// The page rereads after each write; act once it shows the second version, as a person would.
			await harness.page.getByRole("button", { name: "Second title", exact: true }).waitFor();
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

for (const loss of ["reply", "unsent"] as const) {
	test.skipIf(!browserAvailable)(`a retained restore settles when leaving its case after a lost ${loss}`, async () => {
		const server = await startServer();
		await twoVersions(server);
		await server.api("propose", { edits: [{ op: "create", body: { title: "Other first" } }] });
		await server.api("propose", { edits: [{ op: "edit", case: "C-2", base: 1, body: { title: "Other second" } }] });
		const harness = await openPage(server, { path: "/p/scratch/suite/c/1" });
		try {
			const { page, context } = harness;
			await begin(harness, "restore");
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
			await page.keyboard.press("u");
			await page
				.locator("#stat")
				.filter({ hasText: /check it and retry/ })
				.waitFor();
			await page.getByRole("option").filter({ hasText: "Other second" }).click();
			await page.locator("#detail .ctitle").filter({ hasText: "Other second" }).waitFor();
			await page
				.locator("#stat")
				.filter({ hasText: /C-1.*(recorded|not recorded)/ })
				.waitFor();
			const original = Request.parse(requests[0]);
			expect(commands).toEqual([{ cmd: original.cmd }]);
			expect(requests).toEqual([original]);
			await page.keyboard.press("u");
			await page.locator("#stat").filter({ hasText: "Previous version restored as a new version." }).waitFor();
			expect(Request.parse(requests[1]).edits).toEqual([{ op: "restore", case: "C-2", to: 1 }]);
			expect((await server.api("get", { refs: ["C-1"] }))[0]).toMatchObject(
				loss === "reply" ? { title: "First title", version: 3 } : { title: "Second title", version: 2 },
			);
			expect((await server.api("get", { refs: ["C-2"] }))[0]).toMatchObject({ title: "Other first", version: 3 });
		} finally {
			await harness.close();
			await server.stop();
		}
	});

	for (const leave of ["parent", "Escape"] as const) {
		test.skipIf(!browserAvailable)(`a retained folder settles on ${leave} after a lost ${loss}`, async () => {
			const server = await startServer();
			await server.api("propose", {
				edits: [
					{ op: "folder", name: "Left" },
					{ op: "folder", name: "Right" },
				],
			});
			const harness = await openPage(server, { path: "/p/scratch/suite?folder=Left" });
			try {
				const { page, context } = harness;
				await page.locator("#ltitle").filter({ hasText: "Left" }).waitFor();
				await page.keyboard.type("nf");
				const field = page.getByRole("textbox", { name: "New folder name" });
				await field.fill("Child");
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
				await page.keyboard.press("Enter");
				await page
					.locator("#stat")
					.filter({ hasText: /check it and retry/ })
					.waitFor();
				if (leave === "Escape") await page.keyboard.press("Escape");
				else await page.locator("#tree .fo").filter({ hasText: "Right" }).click();
				await page
					.locator("#stat")
					.filter({ hasText: /Left\/Child.*(recorded|not recorded)/ })
					.waitFor();
				const original = Request.parse(requests[0]);
				expect(commands).toEqual([{ cmd: original.cmd }]);
				expect(requests).toEqual([original]);
				await field.waitFor({ state: "hidden" });
				if (leave === "Escape") await page.locator("#tree .fo").filter({ hasText: "Right" }).click();
				await page.keyboard.type("nf");
				await field.fill("Fresh");
				await page.keyboard.press("Enter");
				await field.waitFor({ state: "hidden" });
				expect(Request.parse(requests[1]).edits).toEqual([{ op: "folder", name: "Fresh", parent: "Right" }]);
				expect((await server.api("find", { in: "folders" })).items.map((folder) => folder.path).sort()).toEqual(
					["Left", "Right", "Right/Fresh", ...(loss === "reply" ? ["Left/Child"] : [])].sort(),
				);
			} finally {
				await harness.close();
				await server.stop();
			}
		});
	}
}

for (const action of ["folder", "restore"] as const) {
	test.skipIf(!browserAvailable)(`a final ${action} refusal does not promise a retained retry`, async () => {
		const server = await startServer();
		await twoVersions(server);
		if (action === "folder") await server.api("propose", { edits: [{ op: "folder", name: "New folder" }] });
		else {
			const policy = Policy.extend({ version: z.number() }).parse(
				await server.api("admin", { do: "policy.show", project: "scratch" }),
			);
			const proposed = await server.api("propose", {
				edits: [
					{
						op: "policy",
						base: policy.version,
						settings: {
							...policy.settings,
							fields: { risk: { kind: "text", label: "Risk", required: true } },
						},
					},
				],
			});
			const question = (await server.api("inbox", { kind: "adopt" })).items.find((row) => row.q === proposed.question);
			if (!question) throw new Error("Policy question missing");
			await server.api("decide", { q: question.q, onEvidence: question.evidenceHash, answer: { is: "accept" } });
		}
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
				await route.continue();
			});
			for (let attempt = 0; attempt < 2; attempt++) {
				const response = page.waitForResponse((reply) => reply.url().endsWith("/propose"));
				await submit(harness, action);
				const refusal = z
					.object({ ok: z.literal(false), error: z.object({ message: z.string() }) })
					.parse(await (await response).json());
				await page.locator("#stat").filter({ hasText: refusal.error.message }).waitFor();
				expect(await page.locator("#stat").textContent()).toBe(refusal.error.message);
			}
			expect(commands).toEqual([]);
			expect(Request.parse(requests[1]).cmd).not.toBe(Request.parse(requests[0]).cmd);
		} finally {
			await harness.close();
			await server.stop();
		}
	});
}

for (const action of ["folder", "restore"] as const) {
	test.skipIf(!browserAvailable)(`a ${action} retry lookup cannot resend after leaving its context`, async () => {
		const server = await startServer();
		await twoVersions(server);
		await server.api("propose", {
			edits: [
				{ op: "folder", name: "Right" },
				{ op: "create", body: { title: "Other case" } },
			],
		});
		const harness = await openPage(server, { path: "/p/scratch/suite/c/1" });
		let release = () => {};
		try {
			const { page, context } = harness;
			await begin(harness, action);
			const requests: unknown[] = [];
			await context.route("**/api/p/scratch/propose", async (route) => {
				requests.push(route.request().postDataJSON());
				if (requests.length === 1) await route.abort("failed");
				else await route.continue();
			});
			let started = () => {};
			const held = new Promise<void>((resolve) => {
				started = resolve;
			});
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			let commands = 0;
			await context.route("**/api/p/scratch/command", async (route) => {
				if (++commands > 1) return route.continue();
				const response = await route.fetch();
				started();
				await gate;
				await route.fulfill({ response });
			});
			await submit(harness, action);
			await page
				.locator("#stat")
				.filter({ hasText: /check it and retry/ })
				.waitFor();
			await submit(harness, action);
			await held;
			if (action === "folder") await page.locator("#tree .fo").filter({ hasText: "Right" }).click();
			else await page.getByRole("option").filter({ hasText: "Other case" }).click();
			await page
				.locator("#stat")
				.filter({ hasText: /not recorded when checked/ })
				.waitFor();
			const response = page.waitForResponse((reply) => reply.url().endsWith("/command"));
			release();
			await response;
			await page.evaluate(
				() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
			);
			expect(commands).toBe(2);
			expect(requests).toHaveLength(1);
			expect((await server.api("get", { refs: ["C-1"] }))[0]).toMatchObject({ title: "Second title", version: 2 });
			expect((await server.api("find", { in: "folders" })).items.map((row) => row.path).sort()).toEqual([
				"Right",
				"Unsorted",
			]);
		} finally {
			release();
			await harness.close();
			await server.stop();
		}
	});
}

async function loseFirstReply(harness: PageHarness) {
	const requests: unknown[] = [];
	await harness.context.route("**/api/p/scratch/propose", async (route) => {
		requests.push(route.request().postDataJSON());
		if (requests.length > 1) return route.continue();
		await route.fetch();
		await route.abort("failed");
	});
	return requests;
}

async function holdCommand(harness: PageHarness) {
	let release = () => {};
	let started = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const ready = new Promise<void>((resolve) => {
		started = resolve;
	});
	const commands: unknown[] = [];
	await harness.context.route("**/api/p/scratch/command", async (route) => {
		commands.push(route.request().postDataJSON());
		const response = await route.fetch();
		started();
		await gate;
		await route.fulfill({ response });
	});
	return { ready, release, commands };
}

for (const move of ["twice", "back", "new action"] as const) {
	test.skipIf(!browserAvailable)(`a restore departure lookup survives moving ${move}`, async () => {
		const server = await startServer();
		for (let i = 1; i <= 5; i++) {
			await server.api("propose", { edits: [{ op: "create", body: { title: `Case ${i} one` } }] });
			await server.api("propose", {
				edits: [{ op: "edit", case: `C-${i}`, base: 1, body: { title: `Case ${i} two` } }],
			});
		}
		const harness = await openPage(server, { path: "/p/scratch/suite/c/2" });
		const held = await holdCommand(harness);
		try {
			const { page } = harness;
			await page.locator("#detail .ctitle").filter({ hasText: "Case 2 two" }).waitFor();
			const requests = await loseFirstReply(harness);
			await page.keyboard.press("u");
			await page
				.locator("#stat")
				.filter({ hasText: /check it and retry/ })
				.waitFor();
			await page.keyboard.type(move === "back" ? "j" : "jj");
			await held.ready;
			if (move === "back") await page.keyboard.press("k");
			await page
				.locator("#detail .ctitle")
				.filter({ hasText: move === "back" ? "Case 2 one" : "Case 4 two" })
				.waitFor();
			const pending = await page.locator("#stat").textContent();
			if (move === "new action") {
				await page.keyboard.press("u");
				await page.locator("#stat").filter({ hasText: "Previous version restored as a new version." }).waitFor();
			}
			const response = page.waitForResponse((reply) => reply.url().endsWith("/command"));
			held.release();
			await response;
			await page.locator("#stat").filter({ hasText: "Restore for C-2 was recorded." }).waitFor();
			if (move === "new action") {
				expect(await page.locator("#stat").textContent()).toBe(
					"Previous version restored as a new version. Restore for C-2 was recorded.",
				);
				expect(requests).toHaveLength(2);
			} else {
				expect(await page.locator("#stat").textContent()).toBe("Restore for C-2 was recorded.");
				expect(requests).toHaveLength(1);
			}
			expect(pending).toContain("C-2");
			expect(pending).not.toContain("check it and retry");
			expect(held.commands).toEqual([{ cmd: Request.parse(requests[0]).cmd }]);
			expect((await server.api("get", { refs: ["C-2"] }))[0]).toMatchObject({ title: "Case 2 one", version: 3 });
			expect((await server.api("get", { refs: ["C-4"] }))[0]).toMatchObject(
				move === "new action" ? { title: "Case 4 one", version: 3 } : { title: "Case 4 two", version: 2 },
			);
		} finally {
			held.release();
			await harness.close();
			await server.stop();
		}
	});
}

test.skipIf(!browserAvailable)("a folder departure lookup survives Escape then another parent", async () => {
	const server = await startServer();
	await server.api("propose", {
		edits: [
			{ op: "folder", name: "Left" },
			{ op: "folder", name: "Right" },
		],
	});
	const harness = await openPage(server, { path: "/p/scratch/suite?folder=Left" });
	const held = await holdCommand(harness);
	try {
		const { page } = harness;
		await page.locator("#ltitle").filter({ hasText: "Left" }).waitFor();
		const requests = await loseFirstReply(harness);
		await page.keyboard.type("nf");
		await page.getByRole("textbox", { name: "New folder name" }).fill("Child");
		await page.keyboard.press("Enter");
		await page
			.locator("#stat")
			.filter({ hasText: /check it and retry/ })
			.waitFor();
		await page.keyboard.press("Escape");
		await held.ready;
		await page.locator("#tree .fo").filter({ hasText: "Right" }).click();
		const pending = await page.locator("#stat").textContent();
		held.release();
		await page.locator("#stat").filter({ hasText: 'Folder "Left/Child" was recorded.' }).waitFor();
		expect(pending).toContain("Left/Child");
		expect(pending).not.toContain("check it and retry");
		expect(held.commands).toEqual([{ cmd: Request.parse(requests[0]).cmd }]);
		expect(requests).toHaveLength(1);
		expect((await server.api("find", { in: "folders" })).items.map((row) => row.path).sort()).toEqual([
			"Left",
			"Left/Child",
			"Right",
		]);
	} finally {
		held.release();
		await harness.close();
		await server.stop();
	}
});

test.skipIf(!browserAvailable)(
	"a restore departure lookup names a recorded no-op without claiming a change",
	async () => {
		const server = await startServer();
		await twoVersions(server);
		await server.api("propose", {
			edits: [
				{ op: "restore", case: "C-1", to: 1 },
				{ op: "create", body: { title: "Other case" } },
			],
		});
		const harness = await openPage(server, { path: "/p/scratch/suite/c/1" });
		try {
			const { page } = harness;
			await page.locator("#detail .ctitle").filter({ hasText: "First title" }).waitFor();
			const requests = await loseFirstReply(harness);
			await page.locator(".timeline-group summary").click();
			await page.locator('[data-version="2"]').focus();
			await page.keyboard.press("u");
			await page
				.locator("#stat")
				.filter({ hasText: /check it and retry/ })
				.waitFor();
			await page.getByRole("option").filter({ hasText: "Other case" }).click();
			await page
				.locator("#stat")
				.filter({ hasText: "C-1 already has that version's content. Nothing changed." })
				.waitFor();
			expect(requests).toHaveLength(1);
			expect((await server.api("get", { refs: ["C-1"] }))[0]).toMatchObject({ title: "First title", version: 3 });
		} finally {
			await harness.close();
			await server.stop();
		}
	},
);

for (const path of ["normal", "departure"] as const) {
	test.skipIf(!browserAvailable)(`the ${path} restore path describes a conflict in a sentence`, async () => {
		const server = await startServer();
		await twoVersions(server);
		await server.api("propose", { edits: [{ op: "create", body: { title: "Other case" } }] });
		const conflict = await server.api("propose", {
			edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Conflicting title" } }],
		});
		expect(conflict.status).toBe("conflict");
		const harness = await openPage(server, { path: "/p/scratch/suite/c/1" });
		try {
			const { page, context } = harness;
			await begin(harness, "restore");
			await context.route("**/api/p/scratch/propose", async (route) => {
				if (path === "departure") await route.abort("failed");
				else await route.fulfill({ json: { ok: true, result: conflict } });
			});
			await context.route("**/api/p/scratch/command", async (route) => {
				await route.fulfill({ json: { ok: true, result: { state: "done", op: "propose", seq: 1, reply: conflict } } });
			});
			await page.keyboard.press("u");
			if (path === "departure") {
				await page
					.locator("#stat")
					.filter({ hasText: /check it and retry/ })
					.waitFor();
				await page.getByRole("option").filter({ hasText: "Other case" }).click();
			}
			await page
				.locator("#stat")
				.filter({
					hasText: `${path === "departure" ? "Restore for C-1" : "The restore"} has a conflict. The case is unchanged.`,
				})
				.waitFor();
			expect((await server.api("get", { refs: ["C-1"] }))[0]).toMatchObject({ title: "Second title", version: 2 });
		} finally {
			await harness.close();
			await server.stop();
		}
	});
}

for (const [action, next] of [
	["restore", "tag"],
	["folder", "tag"],
	["restore", "runs"],
] as const) {
	test.skipIf(!browserAvailable)(`a ${action} departure outcome keeps a newer status after ${next}`, async () => {
		const server = await startServer();
		await twoVersions(server);
		await server.api("propose", { edits: [{ op: "create", body: { title: "Other case" } }] });
		const harness = await openPage(server, { path: "/p/scratch/suite/c/1" });
		const held = await holdCommand(harness);
		try {
			const { page } = harness;
			await begin(harness, action);
			if (action === "restore") await page.locator("#detail .ctitle").filter({ hasText: "Second title" }).waitFor();
			const requests = await loseFirstReply(harness);
			await submit(harness, action);
			await page
				.locator("#stat")
				.filter({ hasText: /check it and retry/ })
				.waitFor();
			if (action === "folder") await page.keyboard.press("Escape");
			if (next === "runs") await page.keyboard.type("gr");
			else await page.getByRole("option").filter({ hasText: "Other case" }).click();
			await held.ready;
			const outcome = action === "folder" ? 'Folder "New folder" was recorded.' : "Restore for C-1 was recorded.";
			if (next === "runs") {
				await page.waitForURL(/\/p\/scratch\/runs/);
				held.release();
				await page.locator("#stat").filter({ hasText: outcome }).waitFor();
				expect(await page.locator("#stat").textContent()).toBe(outcome);
			} else {
				await page.keyboard.press("t");
				await page.getByRole("textbox", { name: "Tag selected cases" }).fill("alpha");
				await page.keyboard.press("Enter");
				const tagged = "1 case changed. Press u to undo.";
				await page.locator("#stat").filter({ hasText: tagged }).waitFor();
				const response = page.waitForResponse((reply) => reply.url().endsWith("/command"));
				held.release();
				await response;
				await page.locator("#stat").filter({ hasText: outcome }).waitFor();
				expect(await page.locator("#stat").textContent()).toBe(`${tagged} ${outcome}`);
				expect((await server.api("get", { refs: ["C-2"] }))[0]?.tags).toEqual(["alpha"]);
				await page.keyboard.press("u");
				await page.locator("#stat").filter({ hasText: "Undone. The inverse is recorded." }).waitFor();
				expect((await server.api("get", { refs: ["C-2"] }))[0]?.tags).toEqual([]);
			}
			// The undo looks up its own command afterwards; the first lookup is the departed command's.
			expect(held.commands[0]).toEqual({ cmd: Request.parse(requests[0]).cmd });
		} finally {
			held.release();
			await harness.close();
			await server.stop();
		}
	});
}
