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
	let port = 7451;
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
			if (child.exitCode !== null) throw new Error("Builder 2 server exited before readiness");
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

(browserAvailable ? test : test.skip)(
	"D2: twenty mixed one-key answers, real decisions and undo",
	async () => {
		const server = await fixture();
		let view: Awaited<ReturnType<typeof openPage>> | null = null;
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
			const loads = view.loads();
			await page.keyboard.press("g");
			await page.keyboard.press("q");
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
				await page.keyboard.press(key);
				await page.waitForFunction((ref) => document.querySelector(`[data-question="${ref}"]`) === null, question.q);
				const settled = await eventually(
					() => server.api("inbox", { state: "decided", limit: 100 }),
					(reply) => reply.items.some((q) => q.q === question.q),
				);
				expect(settled.items.find((q) => q.q === question.q)?.decision?.by).toEqual(["daniel"]);
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
			await page.keyboard.press("u");
			await page.locator(`[data-question="${lastRef}"]`).waitFor();
			const reopened = await eventually(
				() => server.api("inbox", { state: "open" }),
				(reply) => reply.items.some((q) => q.q === lastRef),
			);
			expect(reopened.items.find((q) => q.q === lastRef)?.decision).toBeNull();
			expect(view.loads()).toBe(loads);
			expect(view.dialogs).toEqual([]);
			expect(view.errors).toEqual([]);
		} finally {
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
			await view.page.waitForFunction(() => document.querySelector("#hints")?.textContent?.includes("Take advice"));
			await view.page.keyboard.press("Enter");
			console.info("decided probe", await server.api("inbox", {state:"decided",kind:"failure"}));
			console.info("advice probe", await view.page.locator(".queue-last").innerText(), (await server.api("inbox", {kind:"failure"})).items.map(q=>({q:q.q, hash:q.evidenceHash, advice:q.advice})));
			const settled = await eventually(
				() => server.api("inbox", { state: "decided", kind: "failure" }),
				(reply) => reply.items.length === 1,
			);
			expect(settled.items[0]?.decision?.answer.is).toBe("infra");
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
			await view.page.keyboard.press("a");
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
