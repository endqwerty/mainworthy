import { expect, test } from "bun:test";
import { browserAvailable, devicePrefix, eventually, openPage, type Server, startServer } from "./support.ts";

/** A server with the preset these tests ask for, on a port the helpers hand out. */
function fixture({
	preset = "standard",
	mode = "local",
}: {
	preset?: string;
	mode?: "local" | "server";
} = {}): Promise<Server> {
	return startServer({ mode, ...(preset === "loose" ? {} : { preset }) });
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
	"a release cockpit names the build and records against its artifact",
	async () => {
		const server = await fixture();
		let view: Awaited<ReturnType<typeof openPage>> | null = null;
		try {
			await cases(server, 1);
			await server.api("announce", {
				deploy: "rc3",
				env: "staging",
				digest: `sha256:${"a".repeat(64)}`,
				code: [{ repo: "acme/web", commit: "1".repeat(40) }],
			});
			const planned = await server.api("plan", {
				name: "Release smoke",
				select: { cases: ["C-1"] },
				accepts: { build: "rc3", env: "staging" },
			});
			view = await openPage(server, { path: "/p/scratch/runs" });
			await view.page.getByText("Accepts results for build rc3 in staging.", { exact: true }).waitFor();
			await view.page.keyboard.press("Enter");
			await view.page.waitForURL(`**/runs/${planned.run.slice(2)}`);
			await view.page.getByText("Accepts results for build rc3 in staging.", { exact: true }).waitFor();
			await view.page.waitForSelector('[data-run-document="C-1"][data-ready="true"]');
			await view.page.keyboard.press("p");
			const gate = await eventually(
				() => server.api("gate", { run: planned.run }),
				(result) => result.verdict === "passed",
			);
			expect(gate).toMatchObject({ verdict: "passed", tally: { pass: 1, missing: 0 } });
			const deployments = await server.api("find", { in: "deployments" });
			expect(deployments.items).toMatchObject([{ build: "rc3", env: "staging" }]);
		} finally {
			await view?.close();
			await server.stop();
		}
	},
);

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
				by: "robin",
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
					can: ["read", "record"],
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
			const executorPrefix = await devicePrefix(server, token);
			view = await openPage({ ...server, token }, { path: `/p/scratch/runs/${planned.run.slice(2)}` });
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
			// Kept on the device under the person's id and the slot, until the server has it.
			const key = `${executorPrefix}run-note:scratch:${planned.run}:${first.id}`;
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
				(id) => document.querySelector(`[data-slot="${id}"]`)?.textContent?.includes("Available"),
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
		const failedReports = Promise.withResolvers<void>();
		try {
			const created = await cases(server, 3);
			const planned = await server.api("plan", {
				name: "Notes survive",
				select: { cases: created.cases.map((c) => c.ref) },
			});
			view = await openPage(server, { path: `/p/scratch/runs/${planned.run.slice(2)}` });
			const page = view.page;
			const note = page.getByRole("textbox", { name: "Result note" });
			await page.waitForSelector('[data-run-document="C-1"][data-active="true"][data-ready="true"]');

			// Typed and not yet recorded: a reload brings it back for the same slot.
			await page.keyboard.press("f");
			await page.keyboard.type("Unsaved failure detail");
			await page.reload();
			await page.waitForSelector('[data-run-document="C-1"][data-active="true"][data-ready="true"]');
			expect(await note.inputValue()).toBe("Unsaved failure detail");

			// Two results whose requests both fail: each slot keeps its own note.
			let reports = 0;
			await page.route("**/api/p/*/report", async (route) => {
				reports++;
				await failedReports.promise;
				await route.abort();
			});
			await page.keyboard.press("f");
			await note.fill("First failed note");
			await page.keyboard.press("Enter");
			await page.waitForSelector('[data-run-document="C-2"][data-active="true"]');
			await page.keyboard.press("f");
			await page.keyboard.type("Second failed note");
			await page.keyboard.press("Enter");
			await eventually(
				async () => reports,
				(n) => n === 2,
			);
			for (const ref of ["C-1", "C-2"])
				await page.getByRole("button", { name: new RegExp(`${ref}, failing`) }).waitFor();
			failedReports.resolve();
			for (const ref of ["C-1", "C-2"])
				await page.getByRole("button", { name: new RegExp(`${ref}, missing`) }).waitFor();
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

			// An uncertain failure keeps its original request and note. The next result key resolves that failure
			// before a later key can record a correction.
			await page.locator('[data-slot="2"]').click();
			expect(await note.inputValue()).toBe("Second failed note");
			await page.keyboard.press("p");
			const recovered = await eventually(
				async () => Slot.array().parse((await server.api("find", { in: "slots", run: planned.run })).items),
				(slots) => slots[1]?.fills[0]?.outcome === "fail",
			);
			expect(recovered[1]?.fills[0]?.note).toBe("Second failed note");
			await eventually(
				() => note.inputValue(),
				(text) => text === "",
			);
			await page.keyboard.press("p");
			const passed = await eventually(
				async () => Slot.array().parse((await server.api("find", { in: "slots", run: planned.run })).items),
				(slots) => slots[1]?.fills[0]?.outcome === "pass",
			);
			expect(passed[1]?.fills[0]?.note).toBeNull();
		} finally {
			failedReports.resolve();
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
			const ready = (page: typeof a, ref: string) =>
				page.waitForSelector(`[data-run-document="${ref}"][data-active="true"][data-ready="true"]`);
			await ready(a, "C-1");
			const b = await view.context.newPage();
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
			const answered = a.waitForResponse((response) => response.url().endsWith("/report"));
			release();
			await answered;
			await a.locator("#bar").filter({ hasText: "C-1 fail recorded on pinned version 1" }).waitFor();
			await eventually(
				async () => Slot.array().parse((await server.api("find", { in: "slots", run: planned.run })).items),
				(slots) => slots[0]?.fills[0]?.note === "Submitted first note",
			);
			await a.unroute("**/api/p/*/report");
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

(browserAvailable ? test : test.skip)(
	"the runs list shows change runs beside planned ones, filters them, and opens a change run's results",
	async () => {
		const server = await fixture();
		let view: Awaited<ReturnType<typeof openPage>> | null = null;
		try {
			await cases(server, 1);
			await server.api("plan", { name: "Smoke", select: { cases: ["C-1"] } });
			const file = "tests/cart.spec.ts";
			await server.api("report", {
				target: { commit: "feat0001feat0001", repo: "acme/web", branch: "feature", pr: 7 },
				job: "e2e",
				results: [
					{ test: { key: `${file}::adds`, name: "adds an item", file }, outcome: "pass" },
					{
						test: { key: `${file}::removes`, name: "removes an item", file },
						outcome: "fail",
						failure: { message: "expected 0 items" },
					},
				],
			});
			view = await openPage(server, { path: "/p/scratch/runs" });
			const list = view.page.getByRole("listbox", { name: "Runs", exact: true });
			const rows = () => list.getByRole("option").allInnerTexts();
			await list.getByRole("option").nth(1).waitFor();
			expect((await rows()).map((row) => row.split("\n")[0])).toEqual(["R-2", "R-1"]);
			await view.page.getByRole("group", { name: "Kind of run" }).getByRole("button", { name: "Planned" }).click();
			await eventually(rows, (texts) => texts.length === 1 && texts[0]?.startsWith("R-1") === true);
			await view.page.getByRole("group", { name: "Kind of run" }).getByRole("button", { name: "Change" }).click();
			await eventually(rows, (texts) => texts.length === 1 && texts[0]?.startsWith("R-2") === true);
			const detail = view.page.locator("#detail");
			await detail.getByRole("heading", { name: "pr:7", exact: true }).waitFor();
			await detail.getByText("feat0001feat", { exact: true }).waitFor();
			const results = detail.getByRole("list", { name: "Results the gate counted" });
			await results.getByText("removes an item").waitFor();
			await results.getByText("expected 0 items").waitFor();
			await view.page.getByRole("group", { name: "State of run" }).getByRole("button", { name: "Closed" }).click();
			await list.getByText("No run matches.").waitFor();

			// The address of a change run opens the list with it selected; its change is a key away.
			await view.page.goto(`${server.url}/p/scratch/runs/2`);
			await view.page.locator("#detail").getByRole("heading", { name: "pr:7", exact: true }).waitFor();
			await view.page.keyboard.press("Enter");
			await view.page.waitForURL(/\/p\/scratch\/changes\/pr(%3A|:)7$/);

			// A second push makes the change's second run; the change lists both, newest first, and each opens.
			await server.api("report", {
				target: { commit: "feat0002feat0002", repo: "acme/web", branch: "feature", pr: 7 },
				job: "e2e",
				results: [{ test: { key: `${file}::adds`, name: "adds an item", file }, outcome: "pass" }],
			});
			const history = view.page.getByRole("list", { name: "Runs of this change" });
			const pushes = () => history.getByRole("link").allInnerTexts();
			await eventually(pushes, (texts) => texts.length === 2);
			expect((await pushes()).map((text) => text.split(/\s+/).slice(0, 4))).toEqual([
				["R-3", "pr:7", "feat0002feat", "passed"],
				["R-2", "pr:7", "feat0001feat", "blocked"],
			]);
			await history.getByRole("link").nth(1).click();
			await view.page.waitForURL(/\/p\/scratch\/runs\/2$/);
			await view.page.locator("#detail").getByText("feat0001feat", { exact: true }).waitFor();

			// Jumping to another run and going Back shows the run the address names again.
			await view.page.keyboard.press("ControlOrMeta+k");
			await view.page.keyboard.type("R-3");
			await view.page.keyboard.press("Enter");
			await view.page.waitForURL(/\/p\/scratch\/runs\/3$/);
			await view.page.locator("#detail").getByText("feat0002feat", { exact: true }).waitFor();
			await view.page.goBack();
			await view.page.waitForURL(/\/p\/scratch\/runs\/2$/);
			await view.page.locator("#detail").getByText("feat0001feat", { exact: true }).waitFor();

			// A change with more runs than a page reads the rest on request: the reply is split in two here.
			let rest: unknown = null;
			await view.page.route("**/find", async (route) => {
				const input = z
					.object({ in: z.string(), change: z.string().optional(), cursor: z.string().optional() })
					.parse(route.request().postDataJSON());
				if (input.in !== "runs" || input.change !== "pr:7") return route.continue();
				if (input.cursor === "rest")
					return route.fulfill({ json: { ok: true, result: { count: null, items: [rest], cursor: null } } });
				const response = await route.fetch();
				const reply = z
					.object({ ok: z.literal(true), result: z.object({ items: z.array(z.unknown()) }).passthrough() })
					.passthrough()
					.parse(await response.json());
				rest = reply.result.items[1];
				return route.fulfill({
					response,
					json: { ...reply, result: { ...reply.result, items: reply.result.items.slice(0, 1), cursor: "rest" } },
				});
			});
			await view.page.goto(`${server.url}/p/scratch/changes/pr%3A7`);
			await eventually(pushes, (texts) => texts.length === 1);
			await view.page.getByRole("button", { name: "More runs" }).click();
			await eventually(pushes, (texts) => texts.length === 2);
			expect(view.errors).toEqual([]);
		} finally {
			await view?.close();
			await server.stop();
		}
	},
	30000,
);
