import { expect, test } from "bun:test";
import { z } from "zod";
import { Slot } from "../../src/web/runs/models.ts";
import { browserAvailable, eventually, openPage, type Server, startServer } from "./support.ts";

const check = test.skipIf(!browserAvailable);
async function grant(server: Server, actor: string, admin = false) {
	return z.object({ token: z.string() }).parse(
		await server.api("admin", {
			do: "token.create",
			actor,
			kind: "human",
			can: admin ? ["read", "produce", "answer", "plan", "admin"] : ["read", "produce"],
			project: "scratch",
		}),
	).token;
}
async function revoke(server: Server, actor: string) {
	const row = z
		.array(z.object({ id: z.number(), actor: z.string() }))
		.parse(await server.api("admin", { do: "token.list" }))
		.find((t) => t.actor === actor);
	if (!row) throw new Error("Token missing");
	await server.api("admin", { do: "token.revoke", id: row.id });
}
async function signIn(page: Awaited<ReturnType<typeof openPage>>["page"], token: string) {
	await page.locator("#token").fill(token);
	await page.keyboard.press("Enter");
	await page.locator("#app").waitFor();
}

check(
	"R3-1 an old seal reply never retries as the next person or clears their draft",
	async () => {
		const server = await startServer({ mode: "server" });
		await server.api("propose", { edits: [{ op: "create", outline: "Pending case\n  Original step" }] });
		const alice = await grant(server, "alice"),
			bob = await grant(server, "bob");
		const h = await openPage({ ...server, token: alice }, { path: "/p/scratch/suite/c/1" });
		let release = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let revoked = () => {};
		const afterRevocation = new Promise<void>((resolve) => {
			revoked = resolve;
		});
		try {
			const { page } = h;
			page.setDefaultTimeout(5000);
			await page.getByRole("button", { name: "Pending case", exact: true }).waitFor();
			await page.keyboard.press("e");
			const step = page.getByRole("textbox", { name: "Step 1", exact: true });
			await step.fill("Alice submitted text");
			// The proposal sent below makes the page read again. Those reads are held until alice's token is revoked,
			// so the server refuses them first: a slow machine can bring that about too, and then the sign-in page
			// replaces the app before the click below can reach the link.
			await page.route(/\/api\/p\/scratch\/(?!propose|events)/, async (route) => {
				await afterRevocation;
				await route.continue().catch(() => {});
			});
			let replies = 0;
			await page.route("**/propose", async (route) => {
				const response = await route.fetch();
				replies++;
				await held;
				await route.fulfill({ response });
			});
			await page.keyboard.press("Control+Enter");
			await eventually(
				async () => replies,
				(n) => n === 1,
			);
			await step.fill("Alice newer private text");
			await revoke(server, "alice");
			revoked();
			// The page goes back to sign-in when a request of alice's is refused: the click's, or a read already on
			// its way. Whichever is first, what a person sees is the sign-in page. The click is made in one step on
			// the link if it is still there, and waits for nothing: a click that waited for a link could find
			// the next person's "Runs" after they sign in.
			await page.evaluate(() => document.querySelector<HTMLElement>('a[aria-label="Runs"]')?.click());
			await page.locator("#token").waitFor();
			await signIn(page, bob);
			await page.getByRole("link", { name: "Suite", exact: true }).click();
			await page.getByRole("option").filter({ hasText: "C-1" }).click();
			await page.getByRole("button", { name: "Pending case", exact: true }).waitFor();
			await page.keyboard.press("e");
			await step.fill("Bob private text");
			release();
			await page.waitForTimeout(500);
			expect((await server.api("get", { refs: ["C-1"] }))[0]?.version).toBe(2);
			expect(
				await page.evaluate(
					() => JSON.parse(localStorage.getItem("mainworthy:bob:draft:scratch:C-1") ?? "null")?.body.steps[0].action,
				),
			).toBe("Bob private text");
			expect(
				await page.evaluate(
					() => JSON.parse(localStorage.getItem("mainworthy:alice:draft:scratch:C-1") ?? "null")?.body.steps[0].action,
				),
			).toBe("Alice newer private text");
			expect(await step.inputValue()).toBe("Bob private text");
		} finally {
			revoked();
			release();
			await h.close();
			await server.stop();
		}
	},
	30_000,
);

for (const surface of ["case", "run"]) {
	check(
		`R3-2 another tab changing person blocks an old ${surface} write and retains private input`,
		async () => {
			const server = await startServer({ mode: "server" });
			await server.api("propose", { edits: [{ op: "create", outline: "Identity case\n  Original step" }] });
			const run = await server.api("plan", { name: "Identity run", select: {} });
			const alice = await grant(server, "alice"),
				bob = await grant(server, "bob");
			const h = await openPage(
				{ ...server, token: alice },
				{ path: surface === "case" ? "/p/scratch/suite/c/1" : `/p/scratch/runs/${run.run.slice(2)}` },
			);
			try {
				const a = h.page;
				a.setDefaultTimeout(5000);
				if (surface === "case") {
					await a.getByRole("button", { name: "Identity case", exact: true }).waitFor();
					await a.keyboard.press("e");
					await a.getByRole("textbox", { name: "Step 1", exact: true }).fill("Alice private case");
				} else {
					await a.locator('[data-active="true"][data-ready="true"]').waitFor();
					await a.getByRole("textbox", { name: "Result note" }).fill("Alice private note");
				}
				const b = await h.context.newPage();
				b.setDefaultTimeout(5000);
				await b.goto(`${server.url}/p/scratch/queue`);
				await b.locator("#app").waitFor();
				await revoke(server, "alice");
				await b.evaluate(() =>
					fetch("/api/session").then(() =>
						fetch("/api/p/scratch/get", {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({ refs: ["C-1"] }),
						}),
					),
				);
				await b.reload();
				await signIn(b, bob);
				await a.bringToFront();
				await a.keyboard.press(surface === "case" ? "Control+Enter" : "Enter");
				await a.locator("#token").waitFor();
				expect((await server.api("get", { refs: ["C-1"] }))[0]?.version).toBe(1);
				expect(
					Slot.array().parse((await server.api("find", { in: "slots", run: run.run })).items)[0]?.fills,
				).toHaveLength(0);
				const kept = await a.evaluate(() =>
					Object.entries(localStorage)
						.filter(([k]) => k.startsWith("mainworthy:alice:"))
						.map(([, v]) => v)
						.join(" "),
				);
				expect(kept).toContain(surface === "case" ? "Alice private case" : "Alice private note");
			} finally {
				await h.close();
				await server.stop();
			}
		},
		30_000,
	);
}

check(
	"R3C-3 a project admin can change policy but cannot create instance tokens or projects",
	async () => {
		const server = await startServer({ mode: "server" });
		const token = await grant(server, "padmin", true);
		const h = await openPage({ ...server, token }, { path: "/p/scratch/settings" });
		try {
			const { page } = h;
			page.setDefaultTimeout(5000);
			expect(await page.getByLabel("Policy preset").isEnabled()).toBe(true);
			await page.getByLabel("Policy preset").selectOption("standard");
			await page.getByText("standard is in force.", { exact: false }).waitFor();
			await page.getByRole("option", { name: "Tokens", exact: true }).click();
			expect(await page.getByLabel("Token actor").count()).toBe(0);
			await page.getByRole("option", { name: "Projects", exact: true }).click();
			expect(await page.getByRole("button", { name: "Create project", exact: true }).count()).toBe(0);
		} finally {
			await h.close();
			await server.stop();
		}
	},
	30_000,
);

check(
	"R3C-5 the project picker and the preset select give focus back so the next shortcut works",
	async () => {
		const server = await startServer();
		await server.api("admin", { do: "project.create", key: "second", name: "Second", preset: "loose" });
		const h = await openPage(server);
		try {
			const { page } = h;
			page.setDefaultTimeout(5000);
			await page.getByRole("button", { name: "Project: scratch. Switch project", exact: true }).click();
			await page.getByRole("option", { name: /Second/ }).click();
			await page.waitForURL("**/p/second/suite");
			await page.keyboard.press("c");
			expect(await page.getByRole("textbox", { name: "Case title", exact: true }).count()).toBe(1);
			await page.getByRole("link", { name: "Settings", exact: true }).click();
			await page.getByLabel("Policy preset").focus();
			await page.getByLabel("Policy preset").selectOption("standard");
			await page.getByText("standard is in force.", { exact: false }).waitFor();
			await page.keyboard.press("j");
			expect(await page.locator("#detail .phead").innerText()).toContain("Tokens");
		} finally {
			await h.close();
			await server.stop();
		}
	},
	30_000,
);

check(
	"R3C-6 inaccessible projects never show a guessed policy or a pending empty suite",
	async () => {
		const server = await startServer({ mode: "server" });
		await server.api("admin", { do: "project.create", key: "second", name: "Second", preset: "strict" });
		const token = await grant(server, "reader");
		const h = await openPage({ ...server, token });
		let release = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		try {
			const { page } = h;
			page.setDefaultTimeout(5000);
			await page.route("**/api/p/second/find", async (route) => {
				await held;
				await route.continue();
			});
			await page.goto(`${server.url}/p/second/suite`);
			await page.locator("#app").waitFor();
			expect(await page.locator("#list").innerText()).not.toContain("No cases yet");
			expect(await page.locator("#list").innerText()).not.toContain("0 cases");
			release();
			await page.getByText("Cases unavailable", { exact: true }).waitFor();
			await page.getByRole("link", { name: "Settings", exact: true }).click();
			expect(await page.locator("#detail").innerText()).not.toContain("loose");
			await page.getByText("Your session may not read this project.", { exact: false }).first().waitFor();
		} finally {
			release();
			await h.close();
			await server.stop();
		}
	},
	30_000,
);
