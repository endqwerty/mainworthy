import { expect, test } from "bun:test";
import { z } from "zod";
import { Slot } from "../../src/web/runs/models.ts";
import { browserAvailable, eventually, openPage, type Server, startServer } from "./support.ts";

const check = test.skipIf(!browserAvailable);
const latch = () => {
	let release = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { held, release };
};
async function cases(server: Server, count = 3) {
	await server.api("propose", {
		edits: Array.from({ length: count }, (_, i) => ({
			op: "create",
			body: {
				title: `Case ${i + 1}`,
				methods: ["human", "auto"],
				steps: [
					{ id: "s1", action: "Open the cart", expected: null },
					{ id: "s2", action: "Apply the coupon", expected: null },
				],
			},
		})),
	});
}
const title = (page: Awaited<ReturnType<typeof openPage>>["page"]) =>
	page.getByRole("textbox", { name: "Case title", exact: true });
async function conflict(server: Server, page: Awaited<ReturnType<typeof openPage>>["page"]) {
	await page.getByRole("button", { name: "Case 1", exact: true }).waitFor();
	await page.keyboard.press("e");
	await title(page).fill("My title");
	await server.api("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Their title" } }] });
	await page.keyboard.press("Escape");
	await page.locator(".conflict-card").waitFor();
}
for (const choice of ["current", "typed", "mine", "all"])
	check(
		`N-1 conflict preserves ${choice} choice while later editor input is refused`,
		async () => {
			const server = await startServer();
			await cases(server, 1);
			const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
			try {
				const { page } = h;
				page.setDefaultTimeout(5000);
				await conflict(server, page);
				const expected = choice === "typed" ? "Merged by hand" : choice === "mine" ? "My title" : "Their title";
				if (choice === "typed") await page.getByRole("textbox", { name: "Merged title", exact: true }).fill(expected);
				else
					await page
						.getByRole("button", {
							name: choice === "all" ? "Keep current version" : `Use ${choice === "mine" ? "my" : "current"} title`,
							exact: true,
						})
						.click();
				const step = page.getByRole("textbox", { name: "Step 2", exact: true });
				await step.click();
				await step.press("End");
				await page.keyboard.type(" SAVE10");
				expect(await step.inputValue()).toBe("Apply the coupon");
				await title(page).click();
				await title(page).press("End");
				await page.keyboard.type(" with later words");
				expect(await title(page).inputValue()).toBe("My title");
				await page.getByText("Resolve the conflict first", { exact: false }).first().waitFor();
				expect(await page.getByRole("textbox", { name: "Merged title", exact: true }).inputValue()).toBe(expected);
				await page.getByRole("button", { name: "Resolve conflict", exact: true }).click();
				const saved = await eventually(
					() => server.api("get", { refs: ["C-1"] }),
					(rows) => rows[0]?.version === (choice === "all" || choice === "current" ? 2 : 3),
				);
				await page.locator(".conflict-card").waitFor({ state: "detached" });
				expect(saved[0]?.title).toBe(expected);
				expect(z.array(z.object({ action: z.string() })).parse(saved[0]?.steps)[1]?.action).toBe("Apply the coupon");
			} finally {
				await h.close();
				await server.stop();
			}
		},
		30000,
	);

check(
	"N-2 leaving an open conflict sends no extra proposal",
	async () => {
		const server = await startServer();
		await cases(server, 1);
		const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
		try {
			const { page } = h;
			page.setDefaultTimeout(5000);
			await conflict(server, page);
			let sent = 0;
			await page.route("**/propose", async (route) => {
				sent++;
				await route.continue();
			});
			for (const text of ["Apply the coupon SAVE10", "Apply the coupon SAVE10 and check the total"]) {
				await page.getByRole("textbox", { name: "Step 2", exact: true }).click();
				await page.keyboard.type(text);
				expect(await page.getByRole("textbox", { name: "Step 2", exact: true }).inputValue()).toBe("Apply the coupon");
				await page.keyboard.press("Escape");
				await page.waitForTimeout(150);
			}
			expect(sent).toBe(0);
			await page.getByRole("button", { name: "Resolve conflict", exact: true }).click();
			await eventually(
				() => server.api("get", { refs: ["C-1"] }),
				(rows) => rows[0]?.version === 3,
			);
			expect((await server.api("inbox", { on: "C-1", kind: "adopt" })).items).toHaveLength(0);
		} finally {
			await h.close();
			await server.stop();
		}
	},
	30000,
);

check(
	"N-3 a new tab recovers a closed tab's existing-case request before continuing",
	async () => {
		const server = await startServer();
		await cases(server, 1);
		const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
		try {
			const a = h.page;
			a.setDefaultTimeout(5000);
			await a.getByRole("button", { name: "Case 1", exact: true }).waitFor();
			await a.keyboard.press("e");
			await title(a).fill("Case 1 for returning cust");
			const firstOwner = await a.evaluate(() => sessionStorage.getItem("mainworthy:draft-window"));
			await a.close({ runBeforeUnload: true });
			await eventually(
				() => server.api("get", { refs: ["C-1"] }),
				(rows) => rows[0]?.version === 2,
			);
			const b = await h.context.newPage();
			b.setDefaultTimeout(5000);
			await b.goto(`${server.url}/p/scratch/suite/c/1`);
			await title(b).waitFor();
			expect(await b.evaluate(() => sessionStorage.getItem("mainworthy:draft-window"))).not.toBe(firstOwner);
			await title(b).press("End");
			await b.keyboard.type("omers");
			await b.keyboard.press("Escape");
			const saved = await eventually(
				() => server.api("get", { refs: ["C-1"] }),
				(rows) => rows[0]?.title === "Case 1 for returning customers",
			);
			expect(saved[0]?.version).toBe(3);
			expect(await b.locator(".conflict-card").count()).toBe(0);
		} finally {
			await h.close();
			await server.stop();
		}
	},
	30000,
);

const ready = (page: Awaited<ReturnType<typeof openPage>>["page"]) =>
	page.locator('[data-active="true"][data-ready="true"]').waitFor();
const note = (page: Awaited<ReturnType<typeof openPage>>["page"]) => page.getByRole("textbox", { name: "Result note" });
for (const missingReply of [false, true])
	check(
		`R5B-1 Enter resends the visible note with ${missingReply ? "lost" : "slow"} earlier reply`,
		async () => {
			const server = await startServer({ preset: "standard" });
			await cases(server);
			const run = await server.api("plan", { name: "Note again", select: {} });
			const h = await openPage(server, { path: `/p/scratch/runs/${run.run.slice(2)}` });
			const gate = latch();
			try {
				const { page } = h;
				page.setDefaultTimeout(5000);
				await ready(page);
				let sent = 0;
				await page.route("**/report", async (route) => {
					if (++sent === 1) {
						await gate.held;
						if (missingReply) {
							await route.abort("failed");
							return;
						}
					}
					await route.continue();
				});
				await page.keyboard.press("f");
				await page.keyboard.type("wrong total");
				await page.keyboard.press("Enter");
				await eventually(
					async () => sent,
					(count) => count === 1,
				);
				if (missingReply) await page.keyboard.press("u");
				else await page.keyboard.press("k");
				await page.keyboard.press("2");
				await page.keyboard.press("f");
				expect(await note(page).inputValue()).toBe("wrong total");
				await page.keyboard.press("Enter");
				gate.release();
				await eventually(
					async () => sent,
					(count) => count === (missingReply ? 3 : 2),
				);
				const slots = await eventually(
					() => server.api("find", { in: "slots", run: run.run }),
					(rows) =>
						Slot.array().parse(rows.items)[0]?.fills[0]?.outcome === "fail" &&
						Slot.array().parse(rows.items)[0]?.fills[0]?.result !== undefined,
				);
				await eventually(
					() => server.api("timeline", { ref: "C-1" }),
					(row) => row.entries.filter((entry) => entry.t === "result").length === 2,
				);
				const final = Slot.array().parse((await server.api("find", { in: "slots", run: run.run })).items)[0]?.fills[0];
				expect(final?.note).toBe("wrong total");
				expect(Slot.array().parse(slots.items)[0]?.case).toBe("C-1");
			} finally {
				gate.release();
				await h.close();
				await server.stop();
			}
		},
		30000,
	);

check(
	"R5B-2 undo in a closed run says nothing was recorded",
	async () => {
		const server = await startServer({ preset: "standard" });
		await cases(server, 2);
		const run = await server.api("plan", { name: "Closed undo", select: {} });
		const h = await openPage(server, { path: `/p/scratch/runs/${run.run.slice(2)}` });
		try {
			const { page } = h;
			page.setDefaultTimeout(5000);
			await ready(page);
			await page.keyboard.press("p");
			await eventually(
				() => server.api("find", { in: "slots", run: run.run }),
				(rows) => Slot.array().parse(rows.items)[0]?.fills[0]?.outcome === "pass",
			);
			const tester = z.object({ token: z.string() }).parse(
				await server.api("admin", {
					do: "token.create",
					actor: "tester",
					kind: "human",
					can: ["read", "produce"],
					project: "scratch",
				}),
			).token;
			await server.api(
				"report",
				{ run: run.run, results: [{ test: { case: "C-2" }, outcome: "pass" }] },
				{ token: tester },
			);
			await page.getByText("Filled by person tester", { exact: false }).waitFor();
			let sent = 0;
			await page.route("**/report", async (route) => {
				sent++;
				await route.continue();
			});
			await page.keyboard.press("u");
			await page.getByText("This run is closed. No result was recorded", { exact: false }).first().waitFor();
			expect(sent).toBe(0);
			expect(
				Slot.array().parse((await server.api("find", { in: "slots", run: run.run })).items)[0]?.fills[0]?.outcome,
			).toBe("pass");
		} finally {
			await h.close();
			await server.stop();
		}
	},
	30000,
);

for (const key of ["Enter", "Escape"])
	check(
		`R5B-3 bulk reference prunes answered selection before ${key}`,
		async () => {
			const server = await startServer({ preset: "standard" });
			await cases(server);
			for (let i = 1; i <= 3; i++)
				await server.api("report", {
					target: { session: `r5-${i}` },
					results: [{ test: { case: `C-${i}` }, outcome: "fail", failure: { message: `Failure ${i}` } }],
				});
			const h = await openPage(server, { path: "/p/scratch/queue" });
			try {
				const { page } = h;
				page.setDefaultTimeout(5000);
				await page.locator("[data-current-question]").waitFor();
				const first = await page.locator("[data-current-question]").getAttribute("data-current-question");
				await page.keyboard.press("x");
				await page.keyboard.press("j");
				const second = await page.locator("[data-current-question]").getAttribute("data-current-question");
				if (!first || !second || first === second) throw Error("Missing bulk selection");
				await page.keyboard.press("x");
				await page.keyboard.press("k");
				await page.keyboard.press("d");
				await page.keyboard.type("BUG-7");
				const question = (await server.api("inbox", { kind: "failure" })).items.find((q) => q.q === second);
				if (!question) throw Error("Missing other question");
				await server.api("decide", { q: question.q, onEvidence: question.evidenceHash, answer: { is: "infra" } });
				await page.getByText(`${second} removed from the selection`, { exact: false }).waitFor();
				await page.keyboard.press(key);
				await page.locator(".queue-inline").waitFor({ state: "detached" });
				const answered = await eventually(
					() => server.api("get", { refs: [first] }),
					(rows) => rows[0]?.state === "decided",
				);
				const decision = z
					.object({ decision: z.object({ answer: z.object({ is: z.string(), ref: z.string().optional() }) }) })
					.parse(answered[0]).decision;
				expect(decision.answer.is).toBe("defect");
				expect(decision.answer.ref).toBe(key === "Enter" ? "BUG-7" : undefined);
			} finally {
				await h.close();
				await server.stop();
			}
		},
		30000,
	);

check(
	"R5B-4 undo restores the earlier failure's recorded step",
	async () => {
		const server = await startServer({ preset: "standard" });
		await cases(server);
		const run = await server.api("plan", { name: "Restore step", select: {} });
		const h = await openPage(server, { path: `/p/scratch/runs/${run.run.slice(2)}` });
		try {
			const { page } = h;
			page.setDefaultTimeout(5000);
			await ready(page);
			await page.keyboard.press("2");
			await page.keyboard.press("f");
			await page.keyboard.type("fails at two");
			await page.keyboard.press("Enter");
			await eventually(
				() => server.api("timeline", { ref: "C-1" }),
				(row) => row.entries.some((e) => e.t === "result" && e.atStep === "s2"),
			);
			await page.keyboard.press("k");
			await page.keyboard.press("p");
			await eventually(
				() => server.api("find", { in: "slots", run: run.run }),
				(rows) => Slot.array().parse(rows.items)[0]?.fills[0]?.outcome === "pass",
			);
			await page.keyboard.press("u");
			const restored = await eventually(
				() => server.api("timeline", { ref: "C-1" }),
				(row) => row.entries.filter((e) => e.t === "result").length === 3,
			);
			const result = restored.entries.find((e) => e.t === "result");
			expect(result?.outcome).toBe("fail");
			expect(result?.note).toBe("fails at two");
			expect(result?.atStep).toBe("s2");
		} finally {
			await h.close();
			await server.stop();
		}
	},
	30000,
);

check(
	"N-3 two live windows never share a pending existing-case request",
	async () => {
		const server = await startServer();
		await cases(server, 1);
		const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
		const gate = latch();
		try {
			const a = h.page;
			a.setDefaultTimeout(5000);
			await a.getByRole("button", { name: "Case 1", exact: true }).waitFor();
			let firstCommand: string | null = null;
			await a.route("**/propose", async (route) => {
				firstCommand = z.object({ cmd: z.string() }).parse(route.request().postDataJSON()).cmd;
				const response = await route.fetch();
				await gate.held;
				await route.fulfill({ response });
			});
			await a.keyboard.press("e");
			await title(a).fill("From the first live window");
			await a.keyboard.press("Escape");
			await eventually(
				() => server.api("get", { refs: ["C-1"] }),
				(rows) => rows[0]?.version === 2,
			);
			const b = await h.context.newPage();
			b.setDefaultTimeout(5000);
			await b.goto(`${server.url}/p/scratch/suite/c/1`);
			await title(b).waitFor();
			const secondCommands: string[] = [];
			await b.route("**/propose", async (route) => {
				secondCommands.push(z.object({ cmd: z.string() }).parse(route.request().postDataJSON()).cmd);
				await route.continue();
			});
			expect(await title(b).evaluate((el) => el instanceof HTMLTextAreaElement && el.readOnly)).toBe(true);
			await b.keyboard.press("Escape");
			expect(secondCommands).toHaveLength(0);
			gate.release();
			await a.getByText("Version 2, by you, just now", { exact: true }).waitFor();
			await b.getByRole("button", { name: "From the first live window", exact: true }).waitFor();
			await b.keyboard.press("e");
			await b.getByRole("textbox", { name: "Step 2", exact: true }).fill("From the second live window");
			await b.keyboard.press("Escape");
			const saved = await eventually(
				() => server.api("get", { refs: ["C-1"] }),
				(rows) => rows[0]?.version === 3,
			);
			expect(firstCommand).not.toBeNull();
			expect(secondCommands.length).toBeGreaterThan(0);
			for (const command of secondCommands) expect(command).not.toBe(firstCommand);
			expect(saved[0]?.title).toBe("From the first live window");
			expect(z.array(z.object({ action: z.string() })).parse(saved[0]?.steps)[1]?.action).toBe(
				"From the second live window",
			);
			expect(await b.locator(".conflict-card").count()).toBe(0);
		} finally {
			gate.release();
			await h.close();
			await server.stop();
		}
	},
	30000,
);
