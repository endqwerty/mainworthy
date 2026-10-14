import { expect, test } from "bun:test";
import type { Locator } from "playwright-core";
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
	"R3C-5 a select changes once, when the choice is made from its open list, and gives the focus back then",
	async () => {
		const server = await startServer({ mode: "server", cases: 2 });
		const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
		try {
			const { page } = h;
			page.setDefaultTimeout(5000);
			let policyWrites = 0;
			page.on("request", (request) => {
				if (request.method() === "POST" && request.postData()?.includes('"op":"policy"')) policyWrites++;
			});
			const has = (select: Locator) => select.evaluate((node) => node === document.activeElement);
			// A plain key is the shell's when nothing holds the focus: `?` opens the list of keys, Escape closes it.
			const shell = async () => {
				await page.keyboard.press("?");
				await page.locator("[data-overlay]").waitFor();
				await page.keyboard.press("Escape");
				await page.locator("[data-overlay]").waitFor({ state: "detached" });
			};
			/**
			 * One select, by every way a person chooses. A key that would change a closed select opens its list
			 * and changes nothing; the arrows and Enter in the list are one change, two options on, and the
			 * focus is back with the screen at that change. A pick with the pointer is a change with no key
			 * before it, which `selectOption` makes (headless Chromium cannot make a real pick from a native
			 * list). `behind` is true while the screen's own state stands. `policy` is a select that records a
			 * policy: it writes once for a choice, and never on the way to it.
			 */
			const rule = async (
				select: Locator,
				options: { behind: () => Promise<boolean>; reset?: boolean; policy?: boolean },
			) => {
				const values = await select.evaluate((node) =>
					Array.from((node as HTMLSelectElement).options, (option) => option.value),
				);
				await select.evaluate((node) => {
					node.dataset.changes = "0";
					node.addEventListener("change", () => {
						node.dataset.changes = String(Number(node.dataset.changes) + 1);
					});
				});
				const changes = async () => Number(await select.getAttribute("data-changes"));
				const settled = async () =>
					page.waitForFunction((node) => !node?.hasAttribute("disabled"), await select.elementHandle());
				const first = values[0];
				if (first === undefined) throw new Error("A select with no option");
				// By the pointer: one change, and the focus is back with no key pressed.
				const pick = async () => {
					const seen = await changes();
					await select.focus();
					await select.selectOption(first);
					expect(await changes()).toBe(seen + 1);
					expect(await has(select)).toBe(false);
					expect(await options.behind()).toBe(true);
					await shell();
					await settled();
				};
				if (options.reset) await pick();
				// By the keyboard: a key that would change a closed select opens its list, and the list chooses.
				for (const opener of options.policy ? ["ArrowDown"] : ["ArrowDown", "Space", "Alt+ArrowDown", "Enter"]) {
					const from = await select.inputValue();
					const start = values.indexOf(from);
					const target = values[start + 2];
					if (target === undefined) throw new Error(`${opener}: no option two on from ${start}`);
					const seen = await changes();
					const written = policyWrites;
					await select.focus();
					await page.keyboard.press(opener);
					expect(await select.inputValue()).toBe(from);
					expect(await changes()).toBe(seen);
					expect(await has(select)).toBe(true);
					await page.keyboard.press("ArrowDown");
					await page.keyboard.press("ArrowDown");
					await page.keyboard.press("Enter");
					expect(await select.inputValue()).toBe(target);
					expect(await changes()).toBe(seen + 1);
					expect(await has(select)).toBe(false);
					expect(await options.behind()).toBe(true);
					await shell();
					if (options.policy) {
						await settled();
						expect(policyWrites).toBe(written + 1);
					} else if (opener !== "Enter") await pick();
				}
				// Enter on the closed select opens the list; Escape closes it and leaves the select the focus, and
				// Escape again gives it back. None of it reaches the screen behind, or changes anything.
				const seen = await changes();
				const value = await select.inputValue();
				await select.focus();
				await page.keyboard.press("Enter");
				await page.keyboard.press("Escape");
				expect(await has(select)).toBe(true);
				await page.keyboard.press("Escape");
				expect(await has(select)).toBe(false);
				expect(await options.behind()).toBe(true);
				expect(await changes()).toBe(seen);
				expect(await select.inputValue()).toBe(value);
				await shell();
			};

			// The case pane. Escape on the select does not leave the editor, which would record a version; Escape in the title does.
			await page.locator("#detail .cid", { hasText: "C-1" }).waitFor();
			await page.keyboard.press("e");
			const version = page.locator(".cstate .chip");
			await page.locator(".body-editor").waitFor();
			await page.getByText("Can be exercised by", { exact: false }).click();
			await rule(page.getByLabel("Automation"), {
				reset: true,
				behind: async () => (await version.innerText()) === "Draft",
			});
			await page.getByRole("textbox", { name: "Case title", exact: true }).focus();
			await page.keyboard.press("Escape");
			await page.waitForFunction(() => document.querySelector(".cstate .chip")?.textContent === "v2");

			// A Settings select, the invitation's expiry, and the two that record a policy.
			await page.goto(`${server.url}/p/scratch/settings`);
			await page.getByRole("option", { name: "Tokens", exact: true }).click();
			const section = async () => (await page.locator("#detail .phead").innerText()).trim();
			await rule(page.locator("#token-kind"), {
				reset: true,
				behind: async () => (await section()).includes("Tokens"),
			});
			// Where the browser cannot open the list (no `showPicker`, or one that throws), an arrow key changes the
			// select by one as it does natively, and that change gives the focus back.
			const kind = page.locator("#token-kind");
			for (const picker of ["missing", "throws"]) {
				await page.evaluate((how) => {
					Reflect.set(
						HTMLSelectElement.prototype,
						"showPicker",
						how === "missing"
							? undefined
							: () => {
									throw new DOMException("no gesture", "NotAllowedError");
								},
					);
				}, picker);
				await kind.selectOption("agent");
				await kind.focus();
				await page.keyboard.press("ArrowDown");
				expect(await kind.inputValue()).toBe("ci");
				expect(await has(kind)).toBe(false);
				await shell();
			}
			await page.reload();
			await page.getByRole("option", { name: "People", exact: true }).click();
			await rule(page.locator("#invite-expires"), {
				reset: true,
				behind: async () => (await section()).includes("People"),
			});
			await page.getByRole("option", { name: "Policy", exact: true }).click();
			const inPolicy = async () => (await section()).includes("Policy");
			// Ask, track, create: the walk from ask to create passes track, which is not recorded.
			await rule(page.getByLabel("Tests with no case"), { reset: true, behind: inPolicy, policy: true });
			expect(await page.getByLabel("Tests with no case").inputValue()).toBe("create");
			// Loose, standard, strict: the walk from loose to strict passes standard.
			await rule(page.getByLabel("Policy preset"), { reset: true, behind: inPolicy, policy: true });
			expect(await page.getByLabel("Policy preset").inputValue()).toBe("strict");

			// The run planner. Escape on the select does not close the form; Escape in its name does.
			await page.keyboard.type("gr");
			await page.keyboard.press("n");
			const name = page.locator("#run-name");
			await name.waitFor();
			await rule(page.locator("#run-selection"), { reset: true, behind: async () => (await name.count()) === 1 });
			await name.focus();
			await page.keyboard.press("Escape");
			await name.waitFor({ state: "detached" });
			expect(h.errors).toEqual([]);
		} finally {
			await h.close();
			await server.stop();
		}
	},
	60_000,
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
