import { expect, test } from "bun:test";
import { browserAvailable, eventually, openPage, type Server, startServer } from "./support.ts";

/** A server with the preset these tests ask for, on a port the helpers hand out. */
function fixture({
	preset = "standard",
	mode = "local",
}: {
	preset?: string;
	mode?: "local" | "server";
} = {}): Promise<Server> {
	// These tests answer questions about tests with no case, so the project asks them, as `strict` does.
	return startServer({
		mode,
		...(preset === "loose" ? {} : { preset, ...(preset === "strict" ? {} : { unlinked: "ask" as const }) }),
	});
}

import { z } from "zod";
import { ANSWER_HELP, ANSWER_KEYS, ANSWER_LABELS } from "../../src/core/kinds.ts";
import { assertionComparison } from "../../src/web/queue/evidence.tsx";

test("assertion comparison preserves values and falls back for other logs", () => {
	expect(assertionComparison("expected 90.00, got 100.00")).toEqual({ expected: "90.00", observed: "100.00" });
	expect(assertionComparison("expected red to equal green")).toEqual({ expected: "green", observed: "red" });
	expect(assertionComparison("actual !== intended")).toEqual({ expected: "intended", observed: "actual" });
	expect(assertionComparison("network disconnected")).toBeNull();
});

async function twentyQuestions(server: Server) {
	const created = await server.api("propose", {
		edits: Array.from({ length: 15 }, (_, index) => ({
			op: "create",
			outline: `Triage case ${index + 1}\n  Open the page > Ready`,
			folder: "checkout",
		})),
	});
	const token = z.object({ token: z.string() }).parse(
		await server.api("admin", {
			do: "token.create",
			actor: "reviewer",
			kind: "agent",
			can: ["read", "produce", "answer"],
			project: "scratch",
		}),
	).token;
	const colours = ["amber", "cedar", "fern", "lilac", "pearl"];
	for (let i = 0; i < 5; i++) {
		const failure = created.cases[i];
		const proposal = created.cases[i + 5];
		const finding = created.cases[i + 10];
		if (!failure || !proposal || !finding) throw new Error("Triage cases are missing");
		await server.api("report", {
			target: { session: `triage-${i}` },
			results: [
				{ test: { case: failure.ref }, outcome: "fail", failure: { message: `expected ${colours[i]}, got indigo` } },
			],
		});
		await server.api(
			"propose",
			{
				edits: [{ op: "edit", case: proposal.ref, base: 1, body: { title: `Agent improves ${proposal.ref}` } }],
				reason: "Name the expected result",
			},
			{ token },
		);
		await server.api(
			"claim",
			{
				lens: "browser-review",
				findings: [{ on: finding.ref, category: "ambiguous", note: `Specify the outcome for ${finding.ref}` }],
			},
			{ token },
		);
		await server.api("report", {
			target: { commit: `unlinked${i}`, branch: "main" },
			results: [
				{
					test: { key: `tests/unlinked-${i}.ts::works`, file: `tests/unlinked-${i}.ts`, name: `Unlinked ${i}` },
					outcome: "pass",
				},
			],
		});
	}
	return eventually(
		() => server.api("inbox", { limit: 100 }),
		(reply) => reply.items.length === 20,
	);
}

async function recordedDecisions(server: Server, ref: string) {
	const response = await fetch(`${server.url}/api/export`, { headers: { authorization: `Bearer ${server.token}` } });
	expect(response.status).toBe(200);
	const rows: unknown[] = (await response.text())
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	const project = rows
		.map((row) =>
			z.object({ t: z.literal("projects"), r: z.object({ id: z.number(), key: z.string() }) }).safeParse(row),
		)
		.find((row) => row.success && row.data.r.key === server.project);
	if (!project?.success) throw new Error("The exported project is missing");
	const question = rows
		.map((row) =>
			z
				.object({ t: z.literal("questions"), r: z.object({ id: z.number(), no: z.number(), project: z.number() }) })
				.safeParse(row),
		)
		.find((row) => row.success && row.data.r.project === project.data.r.id && row.data.r.no === Number(ref.slice(2)));
	if (!question?.success) throw new Error("The exported question is missing");
	const decision = z.object({
		t: z.literal("decisions"),
		r: z
			.object({ id: z.number(), question: z.number(), answer: z.string(), supersedes: z.number().nullable() })
			.passthrough(),
	});
	return rows
		.map((row) => decision.safeParse(row))
		.flatMap((row) => (row.success && row.data.r.question === question.data.r.id ? [row.data.r] : []))
		.sort((a, b) => a.id - b.id);
}

(browserAvailable ? test : test.skip)(
	"D2: twenty mixed one-key answers, real decisions and undo",
	async () => {
		const server = await fixture();
		let view: Awaited<ReturnType<typeof openPage>> | null = null;
		let release = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		try {
			const inbox = await twentyQuestions(server);
			expect(
				inbox.items.reduce<Record<string, number>>((counts, q) => {
					counts[q.kind] = (counts[q.kind] ?? 0) + 1;
					return counts;
				}, {}),
			).toEqual({ failure: 5, adopt: 5, finding: 5, map: 5 });
			view = await openPage(server, { path: "/p/scratch/queue" });
			const { page } = view;
			page.setDefaultTimeout(8000);
			await page.setViewportSize({ width: 1280, height: 800 });
			await page.waitForSelector("[data-current-question]");
			const firstRef = await page.locator("[data-current-question]").getAttribute("data-current-question");
			const first = inbox.items.find((q) => q.q === firstRef);
			if (!first) throw new Error("Current question missing from the server");
			for (const [key, is] of Object.entries(ANSWER_KEYS[first.kind])) {
				const button = page.getByRole("button", {
					name: `${key} ${ANSWER_LABELS[is]} ${Object.entries(ANSWER_HELP[first.kind]).find(([name]) => name === is)?.[1]}`,
					exact: true,
				});
				await button.waitFor();
				const bounds = await button.boundingBox();
				expect(bounds && bounds.y >= 0 && bounds.y + bounds.height <= 772).toBe(true);
			}
			await page.locator(".assertion-comparison").waitFor();
			// The count says how many failures wait to be explained and how many questions can wait, and the
			// sidebar is red only for the first.
			expect(await page.locator("#list .phead .dim").innerText()).toBe("5 failures to explain · 15 can wait");
			const badge = page.locator('#nav a[aria-label="Queue"] em');
			expect(await badge.getAttribute("class")).toBe("hot");
			expect(await badge.getAttribute("title")).toBe("5 failures to explain · 15 can wait");
			// Failures come first, and each says what leaving it costs. These were typed for a session, so they
			// name no run.
			expect(first.kind).toBe("failure");
			expect(await page.locator(".queue-stakes").innerText()).toBe(
				"While this is open, no gate that counts the unexplained failure passes.",
			);
			const loads = view.loads();
			await page.keyboard.press("g");
			await page.keyboard.press("q");
			await view.context.route("**/api/p/scratch/decide", async (route) => {
				await held;
				await route.continue();
			});
			let lastRef = "";
			const reserved = inbox.items.find((q) => q.kind === "map")?.q;
			let navigation = 2;
			for (let i = 0; i < 20; i++) {
				let ref = await page.locator("[data-current-question]").getAttribute("data-current-question");
				if (ref === reserved && i < 19) {
					await page.keyboard.press("j");
					navigation++;
					ref = await page.locator("[data-current-question]").getAttribute("data-current-question");
				}
				const question = inbox.items.find((q) => q.q === ref);
				if (!question) throw new Error("Question was not in the original server inbox");
				lastRef = question.q;
				const key =
					question.kind === "failure" ? "i" : question.kind === "adopt" ? "a" : question.kind === "finding" ? "z" : "t";
				if (question.kind === "adopt")
					await page.locator(`[data-proposal-evidence="${question.q}"][data-proposal-read="ready"]`).waitFor();
				await page.keyboard.press(key);
				await page.waitForFunction((ref) => document.querySelector(`[data-question="${ref}"]`) === null, question.q);
			}
			expect((await server.api("inbox", {})).counts.open).toBe(20);
			release();
			const settled = await eventually(
				() => server.api("inbox", { state: "decided", limit: 100 }),
				(reply) => inbox.items.every((question) => reply.items.some((q) => q.q === question.q)),
			);
			for (const question of inbox.items) {
				const decision = settled.items.find((q) => q.q === question.q)?.decision;
				expect(decision?.by).toEqual(["robin"]);
				expect(decision?.answer.is).toBe(
					question.kind === "failure"
						? "infra"
						: question.kind === "adopt"
							? "accept"
							: question.kind === "finding"
								? "defer"
								: "track",
				);
			}
			expect((await server.api("inbox", {})).counts.open).toBe(0);
			expect(
				(await server.api("inbox", { state: "decided", limit: 100 })).items.filter((q) =>
					inbox.items.some((item) => item.q === q.q),
				),
			).toHaveLength(20);
			const keys = await view.keys();
			expect(keys).toBe(20 + navigation);
			console.info(`D2: ${keys} keys, 20 answers + ${navigation} navigation; undo adds 1 key`);
			const beforeUndo = await recordedDecisions(server, lastRef);
			expect(beforeUndo).toHaveLength(1);
			const original = beforeUndo[0];
			if (!original) throw new Error("Recorded answer missing from the ledger");
			await page.keyboard.press("u");
			await page.locator(`[data-question="${lastRef}"]`).waitFor();
			const reopened = await eventually(
				() => server.api("inbox", { state: "open" }),
				(reply) => reply.items.some((q) => q.q === lastRef),
			);
			expect(reopened.items.find((q) => q.q === lastRef)?.decision).toBeNull();
			const afterUndo = await recordedDecisions(server, lastRef);
			expect(afterUndo).toHaveLength(2);
			expect(afterUndo[0]).toEqual(original);
			expect(afterUndo[1]?.supersedes).toBe(original.id);
			expect(z.object({ is: z.string() }).parse(JSON.parse(afterUndo[1]?.answer ?? "{}")).is).toBe("withdrawn");
			expect(view.loads()).toBe(loads);
			expect(view.dialogs).toEqual([]);
			expect(view.errors).toEqual([]);
		} finally {
			release();
			await view?.close();
			await server.stop();
		}
	},
	45000,
);

(browserAvailable ? test : test.skip)(
	"advice is taken with Enter and forbidden answers are disabled",
	async () => {
		const server = await fixture();
		let view: Awaited<ReturnType<typeof openPage>> | null = null;
		try {
			await server.api("propose", { edits: [{ op: "create", outline: "Checkout\n  Click > Ready" }] });
			const agent = z.object({ token: z.string() }).parse(
				await server.api("admin", {
					do: "token.create",
					actor: "reviewer",
					kind: "agent",
					can: ["read", "produce", "answer"],
					project: "scratch",
				}),
			).token;
			await server.api("report", {
				target: { session: "advice" },
				results: [{ test: { case: "C-1" }, outcome: "fail", note: "expected ready, got empty" }],
			});
			const question = (await server.api("inbox", { kind: "failure" })).items[0];
			if (!question) throw new Error("Missing failure");
			expect(
				(
					await server.api(
						"decide",
						{
							q: question.q,
							onEvidence: question.evidenceHash,
							answer: { is: "infra" },
							reason: "Runner is unavailable",
						},
						{ token: agent },
					)
				)[0]?.status,
			).toBe("advised");
			view = await openPage(server, { path: "/p/scratch/queue" });
			view.page.setDefaultTimeout(8000);
			await view.page.getByText("reviewer suggests infra", { exact: false }).waitFor();
			await view.page.evaluate(
				() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
			);
			await view.page.keyboard.press("Enter");
			const settled = await eventually(
				() => server.api("inbox", { state: "decided", kind: "failure" }),
				(reply) => reply.items.some((q) => q.q === question.q && q.kind === "failure"),
			);
			expect(settled.items.find((q) => q.q === question.q)?.decision?.answer.is).toBe("infra");
			expect(view.errors).toEqual([]);
			await view.close();
			view = null;
			const proposed = await server.api(
				"propose",
				{ edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Agent proposal" } }] },
				{ token: agent },
			);
			view = await openPage({ ...server, token: agent }, { path: `/p/scratch/queue/${proposed.question?.slice(2)}` });
			await view.page.getByText("You cannot settle this.", { exact: false }).waitFor();
			const buttons = view.page.locator(".queue-answers .ans");
			expect(await buttons.count()).toBe(2);
			for (const button of await buttons.all()) expect(await button.isDisabled()).toBe(true);
			await view.page.evaluate(() => {
				let writes = 0;
				const fetch = window.fetch.bind(window);
				window.fetch = Object.assign((input: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) => {
					const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.href;
					if (url.endsWith("/decide")) writes++;
					return fetch(input, options);
				}, window.fetch);
				Reflect.set(window, "forbiddenWrites", () => writes);
			});
			await view.page.keyboard.press("a");
			await view.page.evaluate(
				() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
			);
			expect(
				await view.page.evaluate(() => {
					const read: unknown = Reflect.get(window, "forbiddenWrites");
					return typeof read === "function" ? read() : -1;
				}),
			).toBe(0);
			expect((await server.api("get", { refs: ["C-1"] }))[0]?.version).toBe(1);
			expect((await server.api("inbox", { kind: "adopt" })).items[0]?.state).toBe("open");
			expect(view.errors).toEqual([]);
		} finally {
			await view?.close();
			await server.stop();
		}
	},
	30000,
);

(browserAvailable ? test : test.skip)(
	"bulk answers are one decide request and undo restores every question",
	async () => {
		const server = await fixture();
		let view: Awaited<ReturnType<typeof openPage>> | null = null;
		try {
			await server.api("propose", {
				edits: [
					{ op: "create", outline: "Amber" },
					{ op: "create", outline: "Cedar" },
				],
			});
			await server.api("report", {
				target: { session: "bulk" },
				results: [
					{ test: { case: "C-1" }, outcome: "fail", note: "expected amber, got green" },
					{ test: { case: "C-2" }, outcome: "fail", note: "expected cedar, got green" },
				],
			});
			view = await openPage(server, { path: "/p/scratch/queue" });
			view.page.setDefaultTimeout(8000);
			await view.page.waitForSelector("[data-current-question]");
			const submissions: unknown[] = [];
			view.page.on("request", (request) => {
				if (request.url().endsWith("/decide")) submissions.push(request.postDataJSON());
			});
			await view.page.keyboard.press("x");
			await view.page.keyboard.press("j");
			await view.page.keyboard.press("x");
			await view.page.keyboard.press("i");
			await eventually(
				() => server.api("inbox", {}),
				(reply) => reply.counts.open === 0,
			);
			expect(submissions).toHaveLength(1);
			expect(z.object({ all: z.array(z.unknown()) }).parse(submissions[0]).all).toHaveLength(2);
			await view.page.keyboard.press("u");
			await eventually(
				() => server.api("inbox", {}),
				(reply) => reply.items.filter((q) => q.kind === "failure").length === 2,
			);
			expect(view.errors).toEqual([]);
		} finally {
			await view?.close();
			await server.stop();
		}
	},
	25000,
);

(browserAvailable ? test : test.skip)(
	"a stale agent proposal comes back with the new evidence and preserves the person's version",
	async () => {
		const server = await fixture();
		let view: Awaited<ReturnType<typeof openPage>> | null = null;
		try {
			await server.api("propose", { edits: [{ op: "create", outline: "Original title\n  Open > Ready" }] });
			const token = z.object({ token: z.string() }).parse(
				await server.api("admin", {
					do: "token.create",
					actor: "writer",
					kind: "agent",
					can: ["read", "produce"],
					project: "scratch",
				}),
			).token;
			const proposed = await server.api(
				"propose",
				{ edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Agent title" } }] },
				{ token },
			);
			view = await openPage(server, { path: `/p/scratch/queue/${proposed.question?.slice(2)}` });
			view.page.setDefaultTimeout(8000);
			await view.page.locator(".diff").waitFor();
			await server.api("propose", {
				edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Person's newer title" } }],
			});
			await view.page.keyboard.press("a");
			// The answer is refused either way. The page refuses it itself while it reads the proposal again after the
			// change, or it sends it and the server refuses the old evidence: which depends on whether the change's event
			// arrived before the key.
			await view.page
				.locator(".queue-last")
				.getByText("The evidence changed.", { exact: false })
				.or(view.page.getByText("Still reading the proposal.", { exact: false }))
				.first()
				.waitFor();
			await view.page.locator(`[data-question="${proposed.question}"]`).waitFor();
			await view.page
				.locator(".queue-evidence .prop")
				.getByText("version 2 → proposed version 3", { exact: false })
				.waitFor();
			expect(
				await view.page
					.locator(".queue-evidence .prop .diff .chg > div")
					.first()
					.evaluate((row) => ({
						before: [...row.children]
							.filter((part) => !part.matches("ins"))
							.map((part) => part.textContent)
							.join(""),
						after: [...row.children]
							.filter((part) => !part.matches("del"))
							.map((part) => part.textContent)
							.join(""),
					})),
			).toEqual({ before: "Person's newer title", after: "Agent title" });
			expect((await server.api("get", { refs: ["C-1"] }))[0]).toMatchObject({
				title: "Person's newer title",
				version: 2,
			});
			expect((await server.api("inbox", { state: "open" })).items.some((q) => q.q === proposed.question)).toBe(true);
			expect(view.errors).toEqual([]);
		} finally {
			await view?.close();
			await server.stop();
		}
	},
	25000,
);

(browserAvailable ? test : test.skip)(
	"a refused session rolls back an optimistic answer and restores the question after sign-in",
	async () => {
		const server = await fixture({ mode: "server" });
		let view: Awaited<ReturnType<typeof openPage>> | null = null;
		try {
			await server.api("propose", { edits: [{ op: "create", outline: "Rollback case" }] });
			await server.api("report", {
				target: { session: "rollback" },
				results: [{ test: { case: "C-1" }, outcome: "fail", note: "expected content, got blank" }],
			});
			const token = z.object({ token: z.string() }).parse(
				await server.api("admin", {
					do: "token.create",
					actor: "triager",
					kind: "human",
					can: ["read", "produce", "answer"],
					project: "scratch",
				}),
			).token;
			view = await openPage({ ...server, token }, { path: "/p/scratch/queue" });
			view.page.setDefaultTimeout(8000);
			await view.page.waitForSelector("[data-current-question]");
			const q = (await server.api("inbox", {})).items[0];
			if (!q) throw new Error("Rollback question missing");
			const grant = z
				.array(z.object({ id: z.number(), actor: z.string() }))
				.parse(await server.api("admin", { do: "token.list" }))
				.find((entry) => entry.actor === "triager");
			if (!grant) throw new Error("Grant missing");
			await server.api("admin", { do: "token.revoke", id: grant.id });
			await view.page.keyboard.press("i");
			await view.page.locator("#token").waitFor();
			expect(await view.page.locator("#app").count()).toBe(0);
			expect(
				(await server.api("inbox", { state: "open" })).items.some((item) => item.q === q.q && item.decision === null),
			).toBe(true);
			expect((await server.api("inbox", { state: "decided" })).items.some((item) => item.q === q.q)).toBe(false);
			await view.page.getByRole("textbox", { name: "Sign in with your token" }).fill(server.token);
			await view.page.keyboard.press("Enter");
			await view.page.locator("#app").waitFor();
			await view.page.locator(`[data-question="${q.q}"]`).waitFor();
			expect(
				(await server.api("inbox", { state: "open" })).items.some((item) => item.q === q.q && item.decision === null),
			).toBe(true);
			expect((await server.api("inbox", { state: "decided" })).items.some((item) => item.q === q.q)).toBe(false);
			expect(view.loads()).toBe(1);
			expect(view.errors).toEqual([]);
		} finally {
			await view?.close();
			await server.stop();
		}
	},
	25000,
);

(browserAvailable ? test : test.skip)(
	"unlinked tests use the case picker and a settled question's URL restores the ledger",
	async () => {
		const server = await fixture();
		let view: Awaited<ReturnType<typeof openPage>> | null = null;
		try {
			await server.api("propose", {
				edits: [{ op: "create", body: { title: "Checkout", methods: ["human", "auto"] } }],
			});
			await server.api("report", {
				target: { commit: "picker001", branch: "main" },
				results: [
					{ test: { key: "checkout.ts::ready", file: "checkout.ts", name: "Checkout ready" }, outcome: "pass" },
				],
			});
			const map = (await server.api("inbox", {})).items.find((q) => q.kind === "map");
			if (!map) throw new Error("Map question missing");
			view = await openPage(server, { path: `/p/scratch/queue/${map.q.slice(2)}` });
			view.page.setDefaultTimeout(8000);
			await view.page.waitForSelector("[data-current-question]");
			// A test with no case holds nothing: the row says so, and the sidebar's count is not red.
			expect(await view.page.locator(".queue-stakes").innerText()).toStartWith("Blocks nothing. Left alone,");
			expect(await view.page.locator("#list .phead .dim").innerText()).toBe("1 can wait");
			expect(await view.page.locator('#nav a[aria-label="Queue"] em').getAttribute("class")).toBe("");
			await view.page.keyboard.press("l");
			await view.page.locator(".palette-input").waitFor();
			await view.page.keyboard.type("C-1");
			await view.page.keyboard.press("Enter");
			await eventually(
				() => server.api("get", { refs: ["T-1"] }),
				(rows) => rows[0]?.case === "C-1",
			);
			await view.page.reload();
			await view.page.getByRole("button", { name: "Settled", exact: true }).waitFor();
			await view.page.waitForFunction(
				() =>
					document.querySelector("[data-current-question]")?.getAttribute("data-current-question") !== null &&
					document.querySelector('.queue-state button[aria-pressed="true"]')?.textContent === "Settled",
			);
			expect(await view.page.locator(".queue-evidence").innerText()).toContain("Decided by robin");
			expect(view.errors).toEqual([]);
		} finally {
			await view?.close();
			await server.stop();
		}
	},
	25000,
);

(browserAvailable ? test : test.skip)(
	"an answer after undo leaves once, and repeated undo cannot hide the reopened question",
	async () => {
		const server = await fixture();
		let view: Awaited<ReturnType<typeof openPage>> | null = null;
		try {
			await server.api("propose", {
				edits: [
					{ op: "create", outline: "Retry amber" },
					{ op: "create", outline: "Retry cedar" },
				],
			});
			await server.api("report", {
				target: { session: "retry" },
				results: [
					{ test: { case: "C-1" }, outcome: "fail", note: "expected amber, got green" },
					{ test: { case: "C-2" }, outcome: "fail", note: "expected cedar, got green" },
				],
			});
			view = await openPage(server, { path: "/p/scratch/queue" });
			view.page.setDefaultTimeout(3000);
			await view.page.waitForSelector("[data-current-question]");
			const q = await view.page.locator("[data-current-question]").getAttribute("data-current-question");
			await view.page.keyboard.press("i");
			await eventually(
				() => server.api("inbox", {}),
				(reply) => reply.counts.open === 1,
			);
			await view.page.keyboard.press("u");
			await eventually(
				() => server.api("inbox", {}),
				(reply) => reply.counts.open === 2,
			);
			await view.page.keyboard.press("i");
			await eventually(
				() => server.api("inbox", {}),
				(reply) => reply.counts.open === 1,
			);
			await view.page.waitForFunction((ref) => !document.querySelector(`[data-question="${ref}"]`), q);
			const withdrawn: unknown[] = [];
			view.page.on("request", (request) => {
				if (request.url().endsWith("/decide") && "undo" in request.postDataJSON())
					withdrawn.push(request.postDataJSON());
			});
			await view.page.keyboard.press("u");
			await view.page.keyboard.press("u");
			await eventually(
				() => server.api("inbox", {}),
				(reply) => reply.counts.open === 2,
			);
			await view.page.waitForFunction(() => document.querySelectorAll("[data-question]").length === 2);
			expect(withdrawn).toHaveLength(1);
			expect(view.errors).toEqual([]);
		} finally {
			await view?.close();
			await server.stop();
		}
	},
	20000,
);

(browserAvailable ? test : test.skip)(
	"a settled answer's name, who gave it, the reason and the button to withdraw it stand apart",
	async () => {
		const server = await fixture();
		let view: Awaited<ReturnType<typeof openPage>> | null = null;
		try {
			await server.api("propose", { edits: [{ op: "create", outline: "Settled amber" }] });
			await server.api("report", {
				target: { session: "settled" },
				results: [{ test: { case: "C-1" }, outcome: "fail", note: "expected amber, got green" }],
			});
			const question = (await server.api("inbox", { kind: "failure" })).items[0];
			if (!question) throw new Error("Failure question missing");
			const reason =
				"The test is the one the tracker records as unreliable. The same tree passed it in the run before, and the change does not touch the editor. ".repeat(
					2,
				);
			const reply = await server.api("decide", {
				q: question.q,
				onEvidence: question.evidenceHash,
				answer: { is: "flaky" },
				reason,
			});
			expect(reply[0]?.status).toBe("decided");
			for (const device of ["desktop", "phone"] as const) {
				view = await openPage(server, { path: `/p/scratch/queue/${question.q.slice(2)}`, device });
				view.page.setDefaultTimeout(8000);
				await view.page.locator(".queue-decision").waitFor();
				// Where each part's text is drawn, which is not its box: text that does not fit a box runs out of it.
				const parts = await view.page.evaluate(() => {
					const block = document.querySelector(".queue-decision");
					if (!block) throw new Error("The settled answer is not shown");
					const frame = block.getBoundingClientRect();
					return {
						frame: { left: frame.left, right: frame.right },
						parts: [...block.children].map((part) => {
							const range = document.createRange();
							range.selectNodeContents(part);
							const drawn = range.getBoundingClientRect();
							return {
								text: (part.textContent ?? "").trim().slice(0, 24),
								left: drawn.left,
								right: drawn.right,
								top: drawn.top,
								bottom: drawn.bottom,
							};
						}),
					};
				});
				expect(parts.parts.map((part) => part.text)).toEqual([
					"Flaky",
					expect.stringContaining("Decided by robin"),
					reason.slice(0, 24),
					"u Withdraw answer",
				]);
				for (const [index, part] of parts.parts.entries()) {
					const inside = part.left >= parts.frame.left - 1 && part.right <= parts.frame.right + 1;
					expect({ device, part: part.text, inside }).toMatchObject({ inside: true });
					for (const other of parts.parts.slice(index + 1)) {
						const apart =
							part.bottom <= other.top + 1 ||
							other.bottom <= part.top + 1 ||
							part.right <= other.left + 1 ||
							other.right <= part.left + 1;
						expect({ device, part: part.text, other: other.text, apart }).toMatchObject({ apart: true });
					}
				}
				expect(view.errors).toEqual([]);
				await view.close();
				view = null;
			}
		} finally {
			await view?.close();
			await server.stop();
		}
	},
	25000,
);

(browserAvailable ? test : test.skip)(
	"same-code suggestions show their evidence and never excuse a failure",
	async () => {
		const server = await startServer();
		let view: Awaited<ReturnType<typeof openPage>> | null = null;
		try {
			for (const attempt of [1, 2, 3]) {
				await server.api("report", {
					target: { commit: "browser-flaky1", branch: "main" },
					job: "e2e",
					attempt,
					results: [
						{
							test: { key: "checkout.ts::coupon", name: "Coupon", file: "checkout.ts" },
							outcome: attempt === 2 ? "pass" : "fail",
							...(attempt === 2 ? {} : { failure: { message: "expected 1, got 2" } }),
						},
					],
				});
			}
			view = await openPage(server, { path: "/p/scratch/queue" });
			const { page } = view;
			page.setDefaultTimeout(8000);
			const signal = page.locator("#detail .same-code-evidence");
			await signal.waitFor();
			expect(await signal.locator("summary").innerText()).toContain(
				"Assertion: 2 same-code outcome changes in 14 days.",
			);
			expect(await signal.locator("summary").innerText()).toContain("Review for flakiness.");
			await signal.locator("summary").click();
			expect(await signal.locator("p").first().innerText()).toBe("expected 1, got 2");
			expect(await signal.innerText()).toContain("This evidence alone excuses no failure.");
			expect(await signal.innerText()).toContain("pass, attempt 2");
			expect(await signal.innerText()).toContain("fail, attempt 3");
			expect((await server.api("gate", { commit: "browser-flaky1" })).verdict).toBe("blocked");
			expect((await server.api("inbox", {})).items.filter((q) => q.kind === "failure")).toHaveLength(1);
			await page.goto(`${server.url}/p/scratch/settings`);
			await page.getByText(/Same-code detector: on/).waitFor();
			expect(await page.getByText(/Same-code detector: on/).innerText()).toContain(
				"2 outcome changes per test and failure cause in 14 days",
			);
			expect(view.errors).toEqual([]);
		} finally {
			await view?.close();
			await server.stop();
		}
	},
	25000,
);
