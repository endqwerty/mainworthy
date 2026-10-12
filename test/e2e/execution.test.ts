import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call } from "../../src/web/lib/api.ts";
import { browserAvailable, eventually, openPage, type Server } from "./support.ts";

/** Builder 2 has its own port range while Builder 1 uses the shared fixture. */
async function fixture({
	preset = "standard",
	mode = "local",
}: {
	preset?: string;
	mode?: "local" | "server";
} = {}): Promise<Server> {
	const directory = await mkdtemp(join(tmpdir(), "casebook-builder2-"));
	let port = 7461;
	for (; port <= 7499; port++) {
		try {
			const probe = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response() });
			await probe.stop(true);
			break;
		} catch {}
	}
	if (port > 7499) {
		await rm(directory, { recursive: true, force: true });
		throw new Error("No free Builder 2 port");
	}
	const token = crypto.randomUUID();
	const url = `http://127.0.0.1:${port}`;
	const child = Bun.spawn([process.execPath, "test/e2e/serve.ts"], {
		cwd: process.cwd(),
		env: {
			...process.env,
			NODE_ENV: "production",
			CASEBOOK_PORT: String(port),
			CASEBOOK_DATA: directory,
			CASEBOOK_MODE: mode,
			CASEBOOK_OWNER_TOKEN: token,
		},
		stdout: "ignore",
		stderr: "pipe",
	});
	const stop = async () => {
		child.kill("SIGTERM");
		await child.exited;
		await rm(directory, { recursive: true, force: true });
	};
	const api: Server["api"] = (op, input, options = {}) =>
		call(op, input, { url, project: "scratch", token: options.token ?? token });
	try {
		await eventually(async () => {
			if (child.exitCode !== null)
				throw new Error(`Builder 2 server exited before readiness: ${await new Response(child.stderr).text()}`);
			try {
				return (await fetch(`${url}/healthz`)).ok;
			} catch {
				return false;
			}
		}, Boolean);
		if (preset !== "loose") {
			const proposed = await api("propose", { edits: [{ op: "policy", preset }] });
			const q = (await api("inbox", { kind: "adopt" })).items.find((q) => q.q === proposed.question);
			if (!q) throw new Error("Preset proposal question is missing");
			const replies = await api("decide", {
				q: q.q,
				onEvidence: q.evidenceHash,
				answer: { is: "accept" },
				reason: "Configure the browser test preset",
			});
			if (replies[0]?.status !== "decided") throw new Error("Preset was not applied");
		}
		return { url, project: "scratch", token, api, seeded: null, stop };
	} catch (error) {
		await stop();
		throw error;
	}
}

import { z } from "zod";
import { Run, Slot } from "../../src/web/runs/models.ts";

async function cases(server: Server, count: number) {
	return server.api("propose", {
		edits: Array.from({ length: count }, (_, index) => ({
			op: "create",

			folder: "checkout",
			tags: ["regression"],
			body: {
				title: `Run case ${index + 1}`,
				methods: ["human", "auto", "agent"],
				steps: [
					{ id: "a1", action: "Open cart", expected: "Empty" },
					{ id: "a2", action: "Apply coupon", expected: "Total is 90" },
					{ id: "a3", action: "Reload", expected: "Coupon stays" },
				],
			},
		})),
	});
}

(browserAvailable ? test : test.skip)(
	"J5: keyboard execution, complete next DOM, fixed controls and real results",
	async () => {
		const server = await fixture();
		let view: Awaited<ReturnType<typeof openPage>> | null = null;
		let release = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		try {
			const created = await cases(server, 10);
			const planned = await server.api("plan", {
				name: "Keyboard regression",
				select: { cases: created.cases.map((c) => c.ref) },
			});
			expect(planned.slots).toBe(10);
			view = await openPage(server, { path: `/p/scratch/runs/${planned.run.slice(2)}` });
			const { page } = view;
			page.setDefaultTimeout(8000);
			await page.setViewportSize({ width: 1280, height: 800 });
			await page.waitForSelector('[data-run-document="C-2"][data-ready="true"]', { state: "attached" });
			await page.evaluate(() =>
				Reflect.set(window, "nextStep", document.querySelector('[data-run-document="C-2"] [data-step]')),
			);
			expect(await page.locator('[data-run-document="C-2"] [data-step]').count()).toBe(3);
			for (const element of await page.locator(".run-controls .out, .run-note").all()) {
				const bounds = await element.boundingBox();
				expect(bounds && bounds.y >= 0 && bounds.y + bounds.height <= 772).toBe(true);
			}
			await page.getByText("proves nothing about a build.", { exact: false }).waitFor();
			const loads = view.loads();
			const reports: unknown[] = [];
			page.on("request", (request) => {
				if (request.url().endsWith("/report")) reports.push(request.postDataJSON());
			});
			await view.context.route("**/api/p/scratch/report", async (route) => {
				await held;
				await route.continue();
			});
			for (let i = 0; i < 8; i++) {
				await page.keyboard.press("p");
				if (i === 0)
					await page.waitForFunction(
						() =>
							document.querySelector('[data-run-document="C-2"][data-active="true"] [data-step]') ===
							Reflect.get(window, "nextStep"),
					);
			}
			await page.keyboard.press("f");
			expect(
				await page
					.getByRole("textbox", { name: "Result note" })
					.evaluate((element) => element === document.activeElement),
			).toBe(true);
			await page.keyboard.type("Total is 100");
			await page.keyboard.press("Enter");
			await page.waitForSelector('[data-run-document="C-10"][data-active="true"]');
			await page.keyboard.press("b");
			expect(
				Slot.array()
					.parse((await server.api("find", { in: "slots", run: planned.run })).items)
					.every((slot) => slot.fills.length === 0),
			).toBe(true);
			release();
			const reply = await eventually(
				() => server.api("find", { in: "slots", run: planned.run }),
				(rows) =>
					Slot.array()
						.parse(rows.items)
						.every((slot) => slot.fills.length === 1),
			);
			const slots = Slot.array().parse(reply.items);
			expect(slots.slice(0, 8).every((slot) => slot.state === "satisfied" && slot.fills[0]?.outcome === "pass")).toBe(
				true,
			);
			expect(slots[8]?.fills[0]).toMatchObject({
				by: "daniel",
				outcome: "fail",
				note: "Total is 100",
				admitted: "exact",
			});
			expect(slots[9]?.fills[0]?.outcome).toBe("blocked");
			const gate = await server.api("gate", { run: planned.run });
			expect(gate.verdict).toBe("blocked");
			expect(gate.tally.pass).toBe(8);
			expect(gate.tally.unexplained).toBe(1);
			expect(gate.tally.missing).toBe(1);
			const keys = await view.keys();
			expect(keys).toBe(23);
			console.info(`J5: ${keys} keys, 11 controls + 12 note characters`);
			const failed = slots[8]?.fills[0];
			if (!failed) throw new Error("Failure result missing");
			await page.keyboard.press("k");
			await page.keyboard.press("p");
			await eventually(
				() => server.api("find", { in: "slots", run: planned.run }),
				(rows) => Slot.array().parse(rows.items)[8]?.fills[0]?.outcome === "pass",
			);
			const timeline = await server.api("timeline", { ref: "C-9" });
			expect(timeline.entries.find((entry) => entry.t === "result" && entry.outcome === "pass")?.corrects).toBe(
				failed.result,
			);
			expect(view.loads()).toBe(loads);
			expect(view.errors).toEqual([]);
			expect(view.dialogs).toEqual([]);
		} finally {
			release();
			await view?.close();
			await server.stop();
		}
	},
	35000,
);

(browserAvailable ? test : test.skip)(
	"pipeline and agent slots fill a commit run and the cursor skips them",
	async () => {
		const server = await fixture();
		let view: Awaited<ReturnType<typeof openPage>> | null = null;
		try {
			const created = await cases(server, 6);
			const pipeline = z.object({ token: z.string() }).parse(
				await server.api("admin", {
					do: "token.create",
					actor: "pipeline",
					kind: "ci",
					can: ["read", "produce"],
					project: "scratch",
				}),
			).token;
			const agent = z.object({ token: z.string() }).parse(
				await server.api("admin", {
					do: "token.create",
					actor: "explorer",
					kind: "agent",
					can: ["read", "produce"],
					project: "scratch",
				}),
			).token;
			const target = { commit: "cockpit123", branch: "main" };
			await server.api(
				"report",
				{
					target,
					results: [
						{
							test: { key: "tests/cart.ts::ready", file: "tests/cart.ts", name: "Cart ready" },
							annotation: { case: "C-1", version: 1 },
							outcome: "pass",
						},
						{
							test: { key: "tests/cart.ts::paid", file: "tests/cart.ts", name: "Cart paid" },
							annotation: { case: "C-4", version: 1 },
							outcome: "pass",
						},
					],
				},
				{ token: pipeline },
			);
			await server.api(
				"report",
				{ target, results: [{ test: { case: "C-3" }, annotation: { case: "C-3", version: 1 }, outcome: "pass" }] },
				{ token: agent },
			);
			const planned = await server.api("plan", {
				name: "Shared producers",
				select: { cases: created.cases.map((c) => c.ref) },
				accepts: { commit: "cockpit123" },
				require: [
					{ id: "exercise", kind: "exercise", methods: ["human", "auto", "agent"], minActors: 1, basis: "exact" },
				],
			});
			expect(planned.already).toBe(3);
			const before = Slot.array().parse((await server.api("find", { in: "slots", run: planned.run })).items);
			view = await openPage(server, { path: `/p/scratch/runs/${planned.run.slice(2)}` });
			await view.page.waitForSelector('[data-run-document="C-2"][data-active="true"][data-ready="true"]');
			await view.page.keyboard.press("p");
			await view.page.waitForSelector('[data-run-document="C-5"][data-active="true"]');
			await view.page.keyboard.press("p");
			await view.page.keyboard.press("p");
			const after = await eventually(
				() => server.api("find", { in: "slots", run: planned.run }),
				(reply) =>
					Slot.array()
						.parse(reply.items)
						.every((slot) => slot.state === "satisfied"),
			);
			const slots = Slot.array().parse(after.items);
			for (const ref of ["C-1", "C-3", "C-4"])
				expect(slots.find((slot) => slot.case === ref)?.fills).toEqual(before.find((slot) => slot.case === ref)?.fills);
			expect((await server.api("gate", { run: planned.run })).verdict).toBe("passed");
			await view.page.getByRole("option").filter({ hasText: "C-3" }).click();
			await view.page.getByText("Filled by agent explorer", { exact: false }).waitFor();
			for (const button of await view.page.locator(".run-controls .out").all())
				expect(await button.isDisabled()).toBe(true);
			expect(view.errors).toEqual([]);
		} finally {
			await view?.close();
			await server.stop();
		}
	},
	30000,
);

(browserAvailable ? test : test.skip)(
	"planning uses the selected folder and shows its live count",
	async () => {
		const server = await fixture();
		let view: Awaited<ReturnType<typeof openPage>> | null = null;
		try {
			await cases(server, 3);
			await server.api("propose", { edits: [{ op: "create", outline: "Unrelated", folder: "settings" }] });
			view = await openPage(server, { path: "/p/scratch/runs" });
			await view.page.keyboard.press("n");
			await view.page.getByLabel("Run name").fill("Checkout plan");
			await view.page.getByLabel("Cases", { exact: true }).selectOption("folder");
			await view.page.getByLabel("Folder", { exact: true }).selectOption("checkout");
			await view.page.getByText("3 matching cases", { exact: true }).waitFor();
			await view.page.getByRole("button", { name: "Enter Plan run", exact: true }).click();
			const runs = await eventually(
				() => server.api("find", { in: "runs" }),
				(reply) => reply.items.length === 1,
			);
			const run = Run.parse(runs.items[0]);
			expect(run.slots).toBe(3);
			expect(
				Slot.array()
					.parse((await server.api("find", { in: "slots", run: run.ref })).items)
					.map((slot) => slot.case),
			).toEqual(["C-1", "C-2", "C-3"]);
			expect(view.errors).toEqual([]);
		} finally {
			await view?.close();
			await server.stop();
		}
	},
	30000,
);

(browserAvailable ? test : test.skip)(
	"a pass pressed while the next pinned body is in flight is retained and checked before reporting",
	async () => {
		const server = await fixture();
		let view: Awaited<ReturnType<typeof openPage>> | null = null;
		let release = () => {};
		const waiting = new Promise<void>((resolve) => {
			release = resolve;
		});
		try {
			const created = await cases(server, 2);
			const planned = await server.api("plan", {
				name: "Delayed prefetch",
				select: { cases: created.cases.map((c) => c.ref) },
			});
			view = await openPage(server, { path: "/p/scratch/runs" });
			view.page.setDefaultTimeout(8000);
			await view.page.route("**/get", async (route) => {
				const input = z
					.object({ refs: z.array(z.string()), version: z.number().optional() })
					.parse(route.request().postDataJSON());
				if (input.refs[0] === "C-2" && input.version === 1) await waiting;
				await route.continue();
			});
			await view.page.getByRole("button", { name: "Enter Open cockpit", exact: true }).click();
			await view.page.waitForSelector('[data-run-document="C-1"][data-active="true"][data-ready="true"]');
			await view.page.keyboard.press("p");
			await view.page.waitForSelector('[data-run-document="C-2"][data-active="true"]');
			expect(await view.page.locator('[data-run-document="C-2"]').getAttribute("data-ready")).toBe("false");
			await view.page.keyboard.press("p");
			expect(
				Slot.array().parse((await server.api("find", { in: "slots", run: planned.run })).items)[1]?.fills,
			).toHaveLength(0);
			release();
			const result = await eventually(
				() => server.api("find", { in: "slots", run: planned.run }),
				(rows) =>
					Slot.array()
						.parse(rows.items)
						.every((slot) => slot.fills[0]?.outcome === "pass"),
			);
			expect(
				Slot.array()
					.parse(result.items)
					.every((slot) => slot.fills[0]?.admitted === "exact"),
			).toBe(true);
			expect(view.errors).toEqual([]);
		} finally {
			release();
			await view?.close();
			await server.stop();
		}
	},
	25000,
);

(browserAvailable ? test : test.skip)(
	"a refused session keeps the slot unrecorded and restores its note after sign-in",
	async () => {
		const server = await fixture({ mode: "server" });
		let view: Awaited<ReturnType<typeof openPage>> | null = null;
		try {
			const created = await cases(server, 4);
			const planned = await server.api("plan", {
				name: "Offline rollback",
				select: { cases: created.cases.map((c) => c.ref) },
			});
			const token = z.object({ token: z.string() }).parse(
				await server.api("admin", {
					do: "token.create",
					actor: "executor",
					kind: "human",
					can: ["read", "produce", "plan"],
					project: "scratch",
				}),
			).token;
			view = await openPage({ ...server, token }, { path: `/p/scratch/runs/${planned.run.slice(2)}` });
			view.page.setDefaultTimeout(3000);
			await view.page.waitForSelector('[data-run-document="C-1"][data-active="true"][data-ready="true"]');
			await view.page.keyboard.press("f");
			await view.page.keyboard.type("Keep this failure note");
			const grant = z
				.array(z.object({ id: z.number(), actor: z.string() }))
				.parse(await server.api("admin", { do: "token.list" }))
				.find((entry) => entry.actor === "executor");
			if (!grant) throw new Error("Executor token missing");
			await server.api("admin", { do: "token.revoke", id: grant.id });
			await view.page.keyboard.press("Enter");
			await view.page.locator("#token").waitFor();
			expect(await view.page.locator("#app").count()).toBe(0);
			const unrecorded = Slot.array().parse((await server.api("find", { in: "slots", run: planned.run })).items);
			expect(unrecorded.every((slot) => slot.state === "missing" && slot.fills.length === 0)).toBe(true);
			const first = unrecorded.find((slot) => slot.case === "C-1");
			if (!first) throw new Error("First pinned slot missing");
			// Kept on the device under the person's name and the slot, until the server has it.
			const key = `casebook:executor:run-note:scratch:${planned.run}:${first.id}`;
			expect(await view.page.evaluate((key) => localStorage.getItem(key), key)).toBe("Keep this failure note");
			// The same person signs in again, with a new token.
			const renewed = z.object({ token: z.string() }).parse(
				await server.api("admin", {
					do: "token.create",
					actor: "executor",
					kind: "human",
					can: ["read", "produce", "plan"],
					project: "scratch",
				}),
			).token;
			await view.page.getByRole("textbox", { name: "Sign in with your token" }).fill(renewed);
			await view.page.keyboard.press("Enter");
			await view.page.locator("#app").waitFor();
			await view.page.waitForSelector('[data-run-document="C-1"][data-active="true"][data-ready="true"]');
			await view.page.waitForFunction(
				(id) => document.querySelector(`[data-slot="${id}"]`)?.textContent?.includes("yours"),
				first.id,
			);
			expect(await view.page.getByRole("textbox", { name: "Result note" }).inputValue()).toBe("Keep this failure note");
			expect(
				Slot.array()
					.parse((await server.api("find", { in: "slots", run: planned.run })).items)
					.every((slot) => slot.state === "missing" && slot.fills.length === 0),
			).toBe(true);
			expect(await view.page.locator(".run-last").innerText()).not.toContain("C-1 · Fail");
			expect(view.loads()).toBe(1);
			expect(view.errors).toEqual([]);
		} finally {
			await view?.close();
			await server.stop();
		}
	},
	20000,
);

(browserAvailable ? test : test.skip)(
	"a failure note is kept on the device: through a reload, and one per slot when two requests fail",
	async () => {
		const server = await fixture();
		let view: Awaited<ReturnType<typeof openPage>> | null = null;
		try {
			const created = await cases(server, 3);
			const planned = await server.api("plan", {
				name: "Notes survive",
				select: { cases: created.cases.map((c) => c.ref) },
			});
			view = await openPage(server, { path: `/p/scratch/runs/${planned.run.slice(2)}` });
			const page = view.page;
			page.setDefaultTimeout(5000);
			const note = page.getByRole("textbox", { name: "Result note" });
			await page.waitForSelector('[data-run-document="C-1"][data-active="true"][data-ready="true"]');

			// Typed and not yet recorded: a reload brings it back for the same slot.
			await page.keyboard.press("f");
			await page.keyboard.type("Unsaved failure detail");
			await page.reload();
			await page.waitForSelector('[data-run-document="C-1"][data-active="true"][data-ready="true"]');
			expect(await note.inputValue()).toBe("Unsaved failure detail");

			// Two results whose requests both fail: each slot keeps its own note.
			await page.route("**/api/p/*/report", async (route) => {
				await new Promise((resolve) => setTimeout(resolve, 600));
				await route.abort();
			});
			await page.keyboard.press("f");
			await note.fill("First failed note");
			await page.keyboard.press("Enter");
			await page.waitForSelector('[data-run-document="C-2"][data-active="true"]');
			await page.keyboard.press("f");
			await page.keyboard.type("Second failed note");
			await page.keyboard.press("Enter");
			// Both requests are aborted after 600 ms; give both rollbacks time to land.
			await page.waitForTimeout(2500);
			await page.unroute("**/api/p/*/report");
			await page.locator('[data-slot="1"]').click();
			expect(await note.inputValue()).toBe("First failed note");
			await page.locator('[data-slot="2"]').click();
			expect(await note.inputValue()).toBe("Second failed note");
			expect(
				Slot.array()
					.parse((await server.api("find", { in: "slots", run: planned.run })).items)
					.every((slot) => slot.state === "missing"),
			).toBe(true);

			// Recorded at last, the note leaves the device.
			await page.locator('[data-slot="1"]').click();
			await page.keyboard.press("f");
			await page.keyboard.press("Enter");
			await eventually(
				async () => Slot.array().parse((await server.api("find", { in: "slots", run: planned.run })).items),
				(slots) => slots[0]?.state === "failing",
			);
			await page.locator('[data-slot="1"]').click();
			expect(await note.inputValue()).toBe("");
		} finally {
			await view?.close();
			await server.stop();
		}
	},
	30000,
);

(browserAvailable ? test : test.skip)(
	"two tabs on one run keep each other's notes, and a result that lands does not clear a newer note",
	async () => {
		const server = await fixture();
		let view: Awaited<ReturnType<typeof openPage>> | null = null;
		try {
			const created = await cases(server, 2);
			const planned = await server.api("plan", {
				name: "Two tabs",
				select: { cases: created.cases.map((c) => c.ref) },
			});
			const path = `/p/scratch/runs/${planned.run.slice(2)}`;
			view = await openPage(server, { path });
			const a = view.page;
			a.setDefaultTimeout(5000);
			const ready = (page: typeof a, ref: string) =>
				page.waitForSelector(`[data-run-document="${ref}"][data-active="true"][data-ready="true"]`);
			await ready(a, "C-1");
			const b = await view.context.newPage();
			b.setDefaultTimeout(5000);
			await b.goto(`${server.url}${path}`);
			await ready(b, "C-1");
			const noteOf = (page: typeof a) => page.getByRole("textbox", { name: "Result note" });

			// Tab A writes a note for the first slot, tab B one for the second. Neither wipes the other's.
			await a.keyboard.press("f");
			await a.keyboard.type("Tab A first-slot note");
			await b.locator('[data-slot="2"]').click();
			await ready(b, "C-2");
			await b.keyboard.press("f");
			await b.keyboard.type("Tab B second-slot note");
			await a.reload();
			await ready(a, "C-1");
			expect(await noteOf(a).inputValue()).toBe("Tab A first-slot note");
			await a.locator('[data-slot="2"]').click();
			await ready(a, "C-2");
			expect(await noteOf(a).inputValue()).toBe("Tab B second-slot note");
			await b.close();

			// A result is on its way with the first note; a newer note typed meanwhile is not cleared when it lands.
			await a.locator('[data-slot="1"]').click();
			await ready(a, "C-1");
			let release = (): void => {};
			const held = new Promise<void>((resolve) => {
				release = resolve;
			});
			await a.route("**/api/p/*/report", async (route) => {
				await held;
				await route.continue();
			});
			await a.keyboard.press("f");
			await noteOf(a).fill("Submitted first note");
			await a.keyboard.press("Enter");
			await a.locator('[data-slot="1"]').click();
			await ready(a, "C-1");
			await a.keyboard.press("f");
			await noteOf(a).fill("Newer note, not sent yet");
			release();
			await eventually(
				async () => Slot.array().parse((await server.api("find", { in: "slots", run: planned.run })).items),
				(slots) => slots[0]?.fills[0]?.note === "Submitted first note",
			);
			await a.unroute("**/api/p/*/report");
			await a.waitForTimeout(300);
			expect(await noteOf(a).inputValue()).toBe("Newer note, not sent yet");
			// And it is still on the device after a reload (the cursor now rests on the next slot that needs a result).
			await a.reload();
			await a.waitForSelector('[data-run-document][data-active="true"][data-ready="true"]');
			await a.locator('[data-slot="1"]').click();
			await ready(a, "C-1");
			await a.keyboard.press("f");
			expect(await noteOf(a).inputValue()).toBe("Newer note, not sent yet");
			expect(view.errors).toEqual([]);
		} finally {
			await view?.close();
			await server.stop();
		}
	},
	40000,
);
