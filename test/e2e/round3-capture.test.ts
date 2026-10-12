import { expect, test } from "bun:test";
import { z } from "zod";
import { browserAvailable, eventually, openPage, startServer } from "./support.ts";

const check = test.skipIf(!browserAvailable);
const titleOf = (page: Awaited<ReturnType<typeof openPage>>["page"]) =>
	page.getByRole("textbox", { name: "Case title", exact: true });

for (const kind of ["new", "edit"]) {
	check(
		`A-1 ${kind}: changed text after an applied request with a lost reply is recorded once`,
		async () => {
			const server = await startServer();
			await server.api("propose", { edits: [{ op: "create", outline: "Original\n  Open cart" }] });
			const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
			try {
				const { page } = h;
				page.setDefaultTimeout(5000);
				await page.getByRole("button", { name: "Original", exact: true }).waitFor();
				let first = true;
				const requests: { cmd: string; edits: unknown[] }[] = [];
				await page.route("**/propose", async (route) => {
					requests.push(
						z.object({ cmd: z.string(), edits: z.array(z.unknown()) }).parse(route.request().postDataJSON()),
					);
					if (first) {
						first = false;
						await route.fetch();
						await route.abort("failed");
					} else await route.continue();
				});
				await page.keyboard.press(kind === "new" ? "c" : "e");
				await titleOf(page).fill("Refund to the original pay");
				await page.keyboard.press("Escape");
				await page.waitForFunction(() => document.querySelector("#stat")?.textContent?.includes("kept on this device"));
				await titleOf(page).click();
				await page.keyboard.press("End");
				await page.keyboard.type("ment method");
				await page.keyboard.press("Escape");
				const ref = kind === "new" ? "C-2" : "C-1";
				await page.waitForFunction(() =>
					/Version|already used/.test(document.querySelector("#stat")?.textContent ?? ""),
				);
				const saved = await eventually(
					() => server.api("get", { refs: [ref] }),
					(rows) => rows[0]?.title === "Refund to the original payment method",
				);
				expect(saved[0]?.title).toBe("Refund to the original payment method");
				expect((await server.api("find", { in: "cases" })).items).toHaveLength(kind === "new" ? 2 : 1);
				expect(new Set(requests.map((request) => request.cmd)).size).toBe(2);
				for (const request of requests)
					expect(
						requests
							.filter((other) => other.cmd === request.cmd)
							.every((other) => JSON.stringify(other.edits) === JSON.stringify(request.edits)),
					).toBe(true);
			} finally {
				await h.close();
				await server.stop();
			}
		},
		30_000,
	);
}

for (const same of [false, true]) {
	check(
		`A-2 shared windows preserve ${same ? "conflicting" : "disjoint"} edits with separate command ids`,
		async () => {
			const server = await startServer();
			await server.api("propose", { edits: [{ op: "create", outline: "Shared case\n  Open cart" }] });
			const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
			try {
				const a = h.page;
				const b = await h.context.newPage();
				for (const p of [a, b]) p.setDefaultTimeout(5000);
				await b.goto(`${server.url}/p/scratch/suite/c/1`);
				for (const p of [a, b]) await p.getByRole("button", { name: "Shared case", exact: true }).waitFor();
				await a.keyboard.press("e");
				await titleOf(a).fill("Shared case from A");
				await b.keyboard.press("e");
				if (same) await titleOf(b).fill("Shared case from B");
				else await b.getByRole("textbox", { name: "Step 1", exact: true }).fill("Open cart from B");
				await a.keyboard.press("Escape");
				await a.waitForFunction(() => document.querySelector("#stat")?.textContent?.includes("Version 2"));
				await b.keyboard.press("Escape");
				if (same) {
					await b.locator(".conflict-card").waitFor();
					expect(await titleOf(b).inputValue()).toBe("Shared case from B");
					expect((await server.api("get", { refs: ["C-1"] }))[0]?.title).toBe("Shared case from A");
				} else {
					await b.waitForFunction(() => document.querySelector("#stat")?.textContent?.includes("Version 3"));
					expect((await server.api("get", { refs: ["C-1"] }))[0]).toMatchObject({
						title: "Shared case from A",
						steps: [{ action: "Open cart from B" }],
					});
				}
			} finally {
				await h.close();
				await server.stop();
			}
		},
		30_000,
	);
}

for (const dirty of [false, true]) {
	check(
		`A-3 ${dirty ? "dirty" : "clean"} drafts never restore another producer's removed tags or links`,
		async () => {
			const server = await startServer();
			await server.api("propose", {
				edits: [
					{ op: "create", outline: "Placement case\n  Open cart", tags: ["wip", "checkout"], covers: ["REQ-12"] },
					{ op: "create", outline: "Other" },
				],
			});
			const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
			try {
				const { page } = h;
				page.setDefaultTimeout(5000);
				await page.getByRole("button", { name: "Placement case", exact: true }).waitFor();
				await page.keyboard.press("e");
				if (dirty) await titleOf(page).fill("Placement case revised");
				else {
					await page.keyboard.press("Escape");
					await page.keyboard.press("j");
				}
				await server.api("propose", {
					edits: [
						{ op: "place", cases: ["C-1"], tags: { remove: ["wip"] } },
						{ op: "cover", case: "C-1", requirement: "REQ-12", on: false },
						...(!dirty ? [{ op: "edit" as const, case: "C-1", base: 1, body: { title: "Colleague's title" } }] : []),
					],
				});
				if (!dirty) {
					await page.keyboard.press("k");
					await page.getByRole("button", { name: "Colleague's title", exact: true }).waitFor();
					await page.keyboard.press("e");
					expect(await titleOf(page).inputValue()).toBe("Colleague's title");
					await titleOf(page).fill("Colleague's title revised");
				}
				await page.keyboard.press("Escape");
				await page.waitForFunction(() => document.querySelector("#stat")?.textContent?.includes("Version"));
				const row = (await server.api("get", { refs: ["C-1"] }))[0];
				expect(row?.tags).toEqual(["checkout"]);
				expect(row?.covers).toEqual([]);
			} finally {
				await h.close();
				await server.stop();
			}
		},
		30_000,
	);
}

check(
	"A-4 moving folders with a stored capture keeps read mode and navigation keys",
	async () => {
		const server = await startServer();
		await server.api("propose", { edits: [{ op: "create", outline: "Existing", folder: "Checkout" }] });
		const h = await openPage(server);
		try {
			const { page } = h;
			page.setDefaultTimeout(5000);
			await page.getByRole("button", { name: "Existing", exact: true }).waitFor();
			await page.route("**/propose", (route) =>
				route.fulfill({ json: { ok: false, error: { code: "internal", message: "Offline" } } }),
			);
			await page.keyboard.press("c");
			await page.keyboard.type("Unsaved capture");
			await page.keyboard.press("Escape");
			await page.waitForFunction(() => document.querySelector("#stat")?.textContent?.includes("Offline"));
			await page.keyboard.press("j");
			await page.keyboard.press("]");
			await page.waitForURL("**/suite?folder=Checkout");
			expect(await page.locator(".body-editor").count()).toBe(0);
			await page.keyboard.press("j");
			expect(await page.locator(".body-editor").count()).toBe(0);
		} finally {
			await h.close();
			await server.stop();
		}
	},
	30_000,
);

check(
	"A-5 external reports refresh the open case proof and timeline",
	async () => {
		const server = await startServer();
		await server.api("propose", { edits: [{ op: "create", outline: "Proof case\n  Open cart" }] });
		const run = await server.api("plan", { name: "Proof run", select: {} });
		await server.api("report", { run: run.run, results: [{ test: { case: "C-1" }, outcome: "pass" }] });
		const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
		try {
			const { page } = h;
			page.setDefaultTimeout(5000);
			await page.locator(".proof-block").getByText("person · pass", { exact: false }).waitFor();
			const second = await server.api("plan", { name: "Second proof", select: {} });
			await server.api("report", {
				run: second.run,
				results: [{ test: { case: "C-1" }, outcome: "fail", note: "External failure" }],
			});
			await page.locator(".proof-block").getByText("person · fail", { exact: false }).waitFor();
			expect(await page.locator(".timeline-block").innerText()).toContain("External failure");
		} finally {
			await h.close();
			await server.stop();
		}
	},
	30_000,
);

check(
	"A-6 an existing action delimiter is not split by ordinary typing",
	async () => {
		const server = await startServer();
		await server.api("propose", {
			edits: [
				{
					op: "create",
					body: { title: "Delimiter", steps: [{ id: "a1", action: "Open Settings > Billing", expected: null }] },
				},
			],
		});
		const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
		try {
			const { page } = h;
			page.setDefaultTimeout(5000);
			await page.getByRole("button", { name: "Open Settings > Billing", exact: true }).click();
			await page.keyboard.press("End");
			await page.keyboard.type("!");
			expect(await page.getByRole("textbox", { name: "Step 1", exact: true }).inputValue()).toBe(
				"Open Settings > Billing!",
			);
			expect(await page.getByRole("textbox", { name: "Expected result 1", exact: true }).count()).toBe(0);
			await page.keyboard.press("Escape");
			await eventually(
				() => server.api("get", { refs: ["C-1"] }),
				(rows) => rows[0]?.version === 2,
			);
			expect((await server.api("get", { refs: ["C-1"] }))[0]?.steps).toMatchObject([
				{ action: "Open Settings > Billing!", expected: null },
			]);
		} finally {
			await h.close();
			await server.stop();
		}
	},
	30_000,
);

check(
	"the version badge and both proof marks change together before a list refetch can repair them",
	async () => {
		const server = await startServer();
		await server.api("propose", { edits: [{ op: "create", outline: "Frame proof\n  Open cart" }] });
		const run = await server.api("plan", { name: "Frame evidence", select: {} });
		await server.api("report", { run: run.run, results: [{ test: { case: "C-1" }, outcome: "pass" }] });
		const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
		let release = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		try {
			const { page } = h;
			page.setDefaultTimeout(5000);
			await page
				.getByRole("option")
				.filter({ hasText: "C-1" })
				.locator(".pf")
				.first()
				.getByText("✓", { exact: false })
				.waitFor();
			await page.route("**/find", async (route) => {
				const input = z.object({ in: z.string() }).parse(route.request().postDataJSON());
				if (input.in === "cases") await held;
				await route.continue();
			});
			await page.evaluate(() => {
				const frames: { version: string; row: string; pane: string }[] = [];
				Reflect.set(window, "proofFrames", frames);
				const sample = () => {
					const version = document.querySelector(".cstate .chip")?.textContent ?? "";
					const row = document.querySelector('#list [aria-selected="true"] .pf')?.textContent ?? "";
					const pane = document.querySelector(".proof-block .prow .m")?.textContent ?? "";
					frames.push({ version, row, pane });
					if (version !== "v2") requestAnimationFrame(sample);
				};
				requestAnimationFrame(sample);
			});
			await page.keyboard.press("e");
			await titleOf(page).fill("Frame proof revised");
			await page.keyboard.press("Control+Enter");
			await page.waitForFunction(() => document.querySelector(".cstate .chip")?.textContent === "v2");
			await page.waitForFunction(() => {
				const value = Reflect.get(window, "proofFrames");
				return Array.isArray(value) && value.some((row) => row.version === "v2");
			});
			const frames = z
				.array(z.object({ version: z.string(), row: z.string(), pane: z.string() }))
				.parse(await page.evaluate(() => Reflect.get(window, "proofFrames")));
			expect(
				frames
					.filter((frame) => frame.version === "v2")
					.every((frame) => frame.row.includes("~") && frame.pane === "~"),
			).toBe(true);
			expect(await page.getByRole("option").filter({ hasText: "C-1" }).locator(".pf").first().textContent()).toContain(
				"~",
			);
		} finally {
			release();
			await h.close();
			await server.stop();
		}
	},
	30_000,
);

check(
	"A-2 a second window never treats another window's pending edit as its own retry",
	async () => {
		const server = await startServer();
		await server.api("propose", { edits: [{ op: "create", outline: "Pending windows\n  Open cart" }] });
		const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
		let release = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		try {
			const a = h.page;
			a.setDefaultTimeout(5000);
			const b = await h.context.newPage();
			b.setDefaultTimeout(5000);
			await b.goto(`${server.url}/p/scratch/suite/c/1`);
			for (const page of [a, b]) await page.getByRole("button", { name: "Pending windows", exact: true }).waitFor();
			let replies = 0;
			const ids: string[] = [];
			await a.route("**/propose", async (route) => {
				ids.push(z.object({ cmd: z.string() }).parse(route.request().postDataJSON()).cmd);
				const response = await route.fetch();
				replies++;
				await held;
				await route.fulfill({ response });
			});
			await b.route("**/propose", async (route) => {
				ids.push(z.object({ cmd: z.string() }).parse(route.request().postDataJSON()).cmd);
				await route.continue();
			});
			await a.keyboard.press("e");
			await titleOf(a).fill("Title from A");
			await a.keyboard.press("Control+Enter");
			await eventually(
				async () => replies,
				(n) => n === 1,
			);
			await b.keyboard.press("e");
			await titleOf(b).fill("Title from B");
			await b.keyboard.press("Escape");
			await b.locator(".conflict-card").waitFor();
			expect(new Set(ids).size).toBe(ids.length);
			expect(await titleOf(b).inputValue()).toBe("Title from B");
			expect((await server.api("get", { refs: ["C-1"] }))[0]?.title).toBe("Title from A");
		} finally {
			release();
			await h.close();
			await server.stop();
		}
	},
	30_000,
);
