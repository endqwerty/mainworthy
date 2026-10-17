// The session, opening keys and keepalive: the findings of the fourth review (R4C).
import { expect, test } from "bun:test";
import { z } from "zod";
import { Client } from "../../src/cli/client.ts";
import { Slot } from "../../src/web/runs/models.ts";
import { browserAvailable, devicePrefix, eventually, openPage, type Server, startServer } from "./support.ts";

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
				steps: Array.from({ length: 12 }, (_, n) => ({ id: `s${n + 1}`, action: `Step ${n + 1}`, expected: null })),
			},
		})),
	});
}
async function failures(server: Server, strict = false) {
	await cases(server);
	if (strict) {
		const proposed = await server.api("propose", { edits: [{ op: "policy", preset: "strict" }] });
		const q = (await server.api("inbox", { kind: "adopt" })).items.find((q) => q.q === proposed.question);
		if (q) await server.api("decide", { q: q.q, onEvidence: q.evidenceHash, answer: { is: "accept" } });
	}
	const producer = strict ? await grant(server, "pipeline", "ci") : server.token;
	for (let i = 1; i <= 3; i++)
		await server.api(
			"report",
			{
				target: { session: `r4-${i}` },
				results: [
					{
						test: { case: `C-${i}` },
						outcome: "fail",
						failure: {
							message: `${["Coupon failure", "Login failure", "Refund failure"][i - 1]}: expected ready, got broken`,
						},
					},
				],
			},
			{ token: producer },
		);
}
async function grant(server: Server, actor: string, kind: "human" | "ci" = "human") {
	return z.object({ token: z.string() }).parse(
		await server.api("admin", {
			do: "token.create",
			actor,
			kind,
			can: kind === "ci" ? ["read", "record"] : ["read", "produce", "answer"],
			project: "scratch",
		}),
	).token;
}
const title = (page: Awaited<ReturnType<typeof openPage>>["page"]) =>
	page.getByRole("textbox", { name: "Case title", exact: true });
const qref = (page: Awaited<ReturnType<typeof openPage>>["page"]) =>
	page.locator("[data-current-question]").getAttribute("data-current-question");
const ready = (page: Awaited<ReturnType<typeof openPage>>["page"]) =>
	page.locator('[data-active="true"][data-ready="true"]').waitFor();

for (const surface of ["case", "run", "queue"])
	check(
		`R4C-1 server rejects ${surface} write after shared cookie changes to a reused name without an extra session read`,
		async () => {
			const server = await startServer({ mode: "server", preset: "standard" });
			if (surface === "queue") await failures(server);
			else await cases(server);
			const run = await server.api("plan", { name: "Identity", select: {} });
			const alice = await grant(server, "alice");
			const { actorId: aliceId } = await new Client({
				url: server.url,
				project: server.project,
				token: alice,
			}).session();
			const alicePrefix = await devicePrefix(server, alice);
			const h = await openPage(
				{ ...server, token: alice },
				{
					path:
						surface === "case"
							? "/p/scratch/suite/c/1"
							: surface === "queue"
								? "/p/scratch/queue"
								: `/p/scratch/runs/${run.run.slice(2)}`,
				},
			);
			try {
				const { page } = h;
				page.setDefaultTimeout(5000);
				if (surface === "case") {
					await page.getByRole("button", { name: "Case 1", exact: true }).waitFor();
					await page.keyboard.press("e");
					await title(page).fill("Alice private draft");
				} else if (surface === "run") {
					await ready(page);
					await page.keyboard.press("f");
					await page.keyboard.type("Alice private note");
				} else await page.locator("[data-current-question]").waitFor();
				const q = surface === "queue" ? await qref(page) : null;
				const op = surface === "case" ? "propose" : surface === "run" ? "report" : "decide";
				let actor: string | undefined;
				let sessions = 0;
				page.on("request", (r) => {
					if (r.url().endsWith("/session")) sessions++;
				});
				await page.route(`**/${op}`, async (route) => {
					actor = route.request().headers()["x-mainworthy-as"];
					await server.api("admin", { do: "actor.forget", name: "alice" });
					const replacement = await grant(server, "alice");
					await h.context.request.post(`${server.url}/api/login`, { data: { token: replacement } });
					await route.continue();
				});
				const refusal = page.waitForResponse((response) => response.url().endsWith(`/${op}`));
				await page.keyboard.press(surface === "case" ? "Control+Enter" : surface === "run" ? "Enter" : "f");
				const response = await refusal;
				expect(response.status()).toBe(401);
				expect(await response.json()).toMatchObject({
					ok: false,
					error: { code: "unauthenticated", message: "the session now belongs to another person; sign in again" },
				});
				await page.locator("#token").waitFor();
				expect(actor).toBe(String(aliceId));
				expect(sessions).toBe(0);
				expect((await server.api("get", { refs: ["C-1"] }))[0]?.version).toBe(1);
				expect(
					Slot.array().parse((await server.api("find", { in: "slots", run: run.run })).items)[0]?.fills.length,
				).toBe(0);
				if (q) expect((await server.api("get", { refs: [q] }))[0]?.state).toBe("open");
				else
					expect(
						await page.evaluate(
							(prefix) =>
								Object.entries(localStorage)
									.filter(([k]) => k.startsWith(prefix))
									.map(([, v]) => v)
									.join(" "),
							alicePrefix,
						),
					).toContain(surface === "case" ? "Alice private draft" : "Alice private note");
			} finally {
				await h.close();
				await server.stop();
			}
		},
		30000,
	);

check(
	"R4C-2 strict withdrawal asks for and records its own reason",
	async () => {
		const server = await startServer({ preset: "standard" });
		await failures(server, true);
		const h = await openPage(server, { path: "/p/scratch/queue" });
		try {
			const { page } = h;
			page.setDefaultTimeout(5000);
			await page.locator("[data-current-question]").waitFor();
			const q = await qref(page);
			if (!q) throw Error("No question");
			await page.keyboard.press("i");
			await page.locator("#answer-extra").fill("The runner was down");
			await page.keyboard.press("Enter");
			await page.waitForFunction(() => document.querySelector(".queue-last")?.textContent?.includes("recorded"));
			await page.keyboard.press("u");
			await page.locator("#answer-extra").fill("The runner is healthy, I read the wrong log");
			await page.keyboard.press("Enter");
			await eventually(
				() => server.api("get", { refs: [q] }),
				(rows) => rows[0]?.state === "open",
			);
			expect(await page.locator("#answer-extra").count()).toBe(0);
		} finally {
			await h.close();
			await server.stop();
		}
	},
	30000,
);

for (const surface of ["capture", "edit", "run", "planner", "queue", "settings"])
	check(
		`R4C-3 ${surface} opening key repeats stay out of its field until keyup`,
		async () => {
			const server = await startServer({ preset: "standard" });
			await failures(server);
			const run = await server.api("plan", { name: "Repeats", select: {} });
			const path =
				surface === "run"
					? `/p/scratch/runs/${run.run.slice(2)}`
					: surface === "planner"
						? "/p/scratch/runs"
						: surface === "queue"
							? "/p/scratch/queue"
							: surface === "settings"
								? "/p/scratch/settings"
								: "/p/scratch/suite/c/1";
			const h = await openPage(server, { path });
			try {
				const { page } = h;
				page.setDefaultTimeout(5000);
				const key =
					surface === "capture"
						? "c"
						: surface === "edit"
							? "e"
							: surface === "run"
								? "f"
								: surface === "queue"
									? "d"
									: "n";
				let field = title(page);
				if (surface === "queue") {
					await page.locator("[data-current-question]").waitFor();
					field = page.locator("#answer-extra");
				} else if (surface === "run") {
					await ready(page);
					field = page.getByRole("textbox", { name: "Result note" });
				} else if (surface === "planner") field = page.locator("#run-name");
				else if (surface === "settings") {
					await page.getByRole("option", { name: "Tokens", exact: true }).click();
					field = page.locator("#token-actor");
				} else await page.getByRole("button", { name: "Case 1", exact: true }).waitFor();
				await page.keyboard.down(key);
				await field.waitFor();
				const before = await field.inputValue();
				for (let i = 0; i < 5; i++) await page.keyboard.down(key);
				await page.keyboard.up(key);
				expect(await field.inputValue()).toBe(before);
				await page.keyboard.down(key);
				await page.keyboard.down(key);
				await page.keyboard.up(key);
				expect(await field.inputValue()).toBe(before + key + key);
			} finally {
				await h.close();
				await server.stop();
			}
		},
		30000,
	);

for (const action of ["close", "reload"])
	check(
		`R4C-4 ${action} sends the keepalive capture and recovery creates no duplicate`,
		async () => {
			const server = await startServer();
			const h = await openPage(server);
			try {
				const { page } = h;
				page.setDefaultTimeout(5000);
				await page.keyboard.press("c");
				await title(page).fill("Closing capture");
				await page.keyboard.press("Enter");
				await page.keyboard.type("The complete step");
				if (action === "close") await page.close({ runBeforeUnload: true });
				else await page.reload();
				await eventually(
					() => server.api("find", { in: "cases" }),
					(rows) => rows.items.some((row) => row.title === "Closing capture"),
				);
				const returning = action === "close" ? await h.context.newPage() : page;
				returning.setDefaultTimeout(5000);
				if (action === "close") await returning.goto(`${server.url}/p/scratch/suite`);
				await returning.locator("#app").waitFor();
				await returning.keyboard.press("Control+Enter");
				// The page asks what became of the save the closing page sent (issue #71): "Your last save is recorded
				// as version 1", or, when it had not landed yet, "Version 1, by you" once it is sent again under its id.
				await eventually(
					async () => await returning.locator("#stat").textContent(),
					(text) => /[Vv]ersion 1\b/.test(text ?? ""),
				);
				expect((await server.api("find", { in: "cases" })).items).toHaveLength(1);
				expect((await server.api("get", { refs: ["C-1"] }))[0]).toMatchObject({ title: "Closing capture", version: 1 });
			} finally {
				await h.close();
				await server.stop();
			}
		},
		30000,
	);

for (const refusal of ["401", "502"])
	check(
		`R4C-5 an idle event stream's ${refusal} checks the session and recovers`,
		async () => {
			const server = await startServer({ mode: "server" });
			await cases(server, 1);
			const token = await grant(server, "reader");
			const h = await openPage({ ...server, token });
			const gate = latch();
			try {
				const { page } = h;
				page.setDefaultTimeout(5000);
				let streams = 0;
				await page.route("**/events", async (route) => {
					if (++streams === 1) {
						await gate.held;
						await route.fulfill({ status: Number(refusal), body: "Unavailable" });
					} else await route.continue();
				});
				await page.reload();
				await page.locator("#app").waitFor();
				await eventually(
					async () => streams,
					(n) => n === 1,
				);
				if (refusal === "401") {
					const row = z
						.array(z.object({ id: z.number(), actor: z.string() }))
						.parse(await server.api("admin", { do: "token.list" }))
						.find((row) => row.actor === "reader");
					if (!row) throw Error("No token");
					await server.api("admin", { do: "token.revoke", id: row.id });
				}
				gate.release();
				if (refusal === "401") await page.locator("#token").waitFor();
				else {
					await eventually(
						async () => streams,
						(n) => n > 1,
					);
					await server.api("propose", { edits: [{ op: "create", outline: "Arrived after reconnect" }] });
					await page.getByRole("option").filter({ hasText: "Arrived after reconnect" }).waitFor();
				}
			} finally {
				gate.release();
				await h.close();
				await server.stop();
			}
		},
		30000,
	);
