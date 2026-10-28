import { expect, test } from "bun:test";
import { z } from "zod";
import { advanceClock, browserAvailable, eventually, openPage, startServer, subjectOf } from "./support.ts";

for (const surface of ["case draft", "run note"]) {
	test.skipIf(!browserAvailable)(
		`UI-4 a revoked session returns to sign-in, and the ${surface} comes back for the person who typed it and nobody else`,
		async () => {
			const server = await startServer({ mode: "server" });
			await server.api("propose", {
				edits: [
					{
						op: "create",
						body: { title: "Existing case", steps: [{ id: "aa", action: "Original step", expected: null }] },
					},
				],
			});
			const run = await server.api("plan", { name: "Re-authentication", select: { cases: ["C-1"] } });
			const issued = z.object({ token: z.string() }).parse(
				await server.api("admin", {
					do: "token.create",
					actor: "writer",
					kind: "human",
					can: ["read", "produce"],
					project: "scratch",
				}),
			);
			const tokens = z
				.array(z.object({ id: z.number(), actor: z.string() }))
				.parse(await server.api("admin", { do: "token.list" }));
			const tokenId = tokens.find((token) => token.actor === "writer")?.id;
			if (tokenId === undefined) throw new Error("Scoped grant missing");
			const browser = await openPage(server, {
				signedIn: false,
				path: surface === "case draft" ? "/p/scratch/suite/c/1" : `/p/scratch/runs/${run.run.slice(2)}`,
			});
			try {
				const { page } = browser;
				await page.getByRole("textbox", { name: "Sign in with your token" }).fill(issued.token);
				await page.keyboard.press("Enter");
				await page.locator("#app").waitFor();
				if (surface === "case draft") {
					await page.getByRole("button", { name: "Existing case", exact: true }).waitFor();
					await page.keyboard.press("e");
					await page.getByRole("textbox", { name: "Step 1", exact: true }).fill("Keep this private sentence");
				} else {
					await page.locator('.run-document[data-active="true"][data-ready="true"] .rsteps').waitFor();
					await page.keyboard.press("f");
					await page.keyboard.type("Keep this failure note");
				}
				await server.api("admin", { do: "token.revoke", id: tokenId });
				const refused = page.waitForResponse(
					(response) =>
						response.status() === 401 &&
						(response.url().endsWith("/session") ||
							response.url().endsWith(surface === "case draft" ? "/propose" : "/report")),
				);
				await page.keyboard.press(surface === "case draft" ? "Escape" : "Enter");
				await refused;
				await page.locator("#token").waitFor();
				expect(await page.locator("#app").count()).toBe(0);
				expect((await server.api("get", { refs: ["C-1"] }))[0]?.version).toBe(1);
				// Somebody else signs in on this browser. What the writer typed is not shown to them.
				await page.getByRole("textbox", { name: "Sign in with your token" }).fill(server.token);
				await page.keyboard.press("Enter");
				await page.locator("#app").waitFor();
				if (surface === "case draft") {
					await page.getByRole("button", { name: "Existing case", exact: true }).waitFor();
					expect(await page.getByRole("textbox", { name: "Step 1", exact: true }).count()).toBe(0);
				} else {
					await page.locator('.run-document[data-active="true"][data-ready="true"] .rsteps').waitFor();
					await page.keyboard.press("f");
					expect(await page.getByRole("textbox", { name: "Result note" }).inputValue()).toBe("");
					await page.keyboard.press("Escape");
				}
				expect(await page.getByText("Keep this", { exact: false }).count()).toBe(0);
				// The writer signs in again with a new token: it is all still there, and it is recorded as theirs.
				const again = z.object({ token: z.string() }).parse(
					await server.api("admin", {
						do: "token.create",
						actor: "writer",
						kind: "human",
						can: ["read", "produce"],
						project: "scratch",
					}),
				);
				await browser.context.clearCookies();
				await page.reload();
				await page.getByRole("textbox", { name: "Sign in with your token" }).fill(again.token);
				await page.keyboard.press("Enter");
				await page.locator("#app").waitFor();
				if (surface === "case draft") {
					const step = page.getByRole("textbox", { name: "Step 1", exact: true });
					expect(await step.inputValue()).toBe("Keep this private sentence");
					await page.keyboard.press("Control+Enter");
					const rows = await eventually(
						() => server.api("get", { refs: ["C-1"] }),
						(rows) => rows[0]?.version === 2,
					);
					expect(rows[0]?.steps).toMatchObject([{ action: "Keep this private sentence" }]);
					const timeline = await server.api("timeline", { ref: "C-1" });
					expect(timeline.entries.find((entry) => entry.t === "version" && entry.version === 2)).toMatchObject({
						by: "writer",
					});
				} else {
					await page.locator('.run-document[data-active="true"][data-ready="true"] .rsteps').waitFor();
					const note = page.getByRole("textbox", { name: "Result note" });
					expect(await note.inputValue()).toBe("Keep this failure note");
					await page.keyboard.press("f");
					await page.keyboard.press("Enter");
					const slots = await eventually(
						() => server.api("find", { in: "slots", run: run.run }),
						(reply) => reply.items.some((slot) => Array.isArray(slot.fills) && slot.fills.length > 0),
					);
					expect(slots.items[0]?.fills).toMatchObject([
						{ outcome: "fail", note: "Keep this failure note", by: "writer" },
					]);
				}
				expect(browser.errors).toEqual([]);
			} finally {
				await browser.close();
				await server.stop();
			}
		},
		30_000,
	);
}

test.skipIf(!browserAvailable)(
	"server sign-in rejects a wrong token and accepts the owner token",
	async () => {
		const server = await startServer({ mode: "server" });
		const browser = await openPage(server, { signedIn: false });
		try {
			const { page } = browser;
			const token = page.getByRole("textbox", { name: "Sign in with your token" });
			await token.fill("not-a-valid-owner-token");
			await page.keyboard.press("Enter");
			await page.getByRole("status").filter({ hasText: "not accepted" }).waitFor();
			expect(await page.locator("#app").count()).toBe(0);
			await token.fill(server.token);
			await page.keyboard.press("Enter");
			await page.locator("#app").waitFor();
			expect(await page.locator(".sfoot .me").textContent()).toContain("robin");
			expect(browser.errors).toEqual([]);
		} finally {
			await browser.close();
			await server.stop();
		}
	},
	30_000,
);

for (const request of ["session", "link"])
	test.skipIf(!browserAvailable)(
		`a late ${request} 401 cannot undo a newer sign-in (issue #447)`,
		async () => {
			const server = await startServer({ mode: "server", provider: true });
			const next = z.object({ token: z.string() }).parse(
				await server.api("admin", {
					do: "token.create",
					actor: "sam",
					kind: "human",
					can: ["read", "produce"],
					project: "scratch",
				}),
			);
			const browser = await openPage(server, { path: "/p/scratch/settings" });
			const arrived = Promise.withResolvers<number>();
			const held = Promise.withResolvers<void>();
			try {
				const { page } = browser;
				// A list of sessions is asked for as the person signed in; linking an identity begins as them.
				const path = request === "session" ? "/api/session" : "/api/login/oidc";
				await page.getByRole("option", { name: "Your sign-in", exact: true }).click();
				await page.getByRole("button", { name: "Link Example ID", exact: true }).waitFor();
				let intercepted = false;
				await page.route(`**${path}`, async (route) => {
					if (intercepted) return route.continue();
					intercepted = true;
					// Get a real expired-session refusal, then hold its reply while this tab signs in again.
					const response = await route.fetch({ headers: { ...route.request().headers(), cookie: "" } });
					arrived.resolve(response.status());
					await held.promise;
					await route.fulfill({ response });
				});
				if (request === "session") await page.getByRole("option", { name: "Your sessions", exact: true }).click();
				else await page.getByRole("button", { name: "Link Example ID", exact: true }).click();
				expect(await arrived.promise).toBe(401);
				await page.getByRole("button", { name: "Sign out", exact: true }).click();
				await page.getByRole("button", { name: "Sign out and keep drafts", exact: true }).click();
				await page.locator("#token").fill(request === "session" ? next.token : server.token);
				await page.keyboard.press("Enter");
				await page.locator("#app").waitFor();
				const actor = request === "session" ? "sam" : "robin";
				expect(await page.locator(".sfoot .me").textContent()).toContain(actor);
				// Count only sign-outs after the new session is established, including a same-actor re-sign-in.
				await page.evaluate(() => {
					Reflect.set(window, "late401SignOuts", 0);
					window.addEventListener("mainworthy:unauthenticated", () => {
						Reflect.set(window, "late401SignOuts", Number(Reflect.get(window, "late401SignOuts")) + 1);
					});
				});
				const completed = page.waitForEvent("requestfinished", {
					predicate: (sent) => sent.url().endsWith(path),
				});
				held.resolve();
				await completed;
				expect(await page.evaluate((): unknown => Reflect.get(window, "late401SignOuts"))).toBe(0);
				await page.getByRole("link", { name: "Suite", exact: true }).click();
				await page.keyboard.press("c");
				await page.getByRole("textbox", { name: "Case title", exact: true }).fill("Created after the late refusal");
				await page.keyboard.press("Control+Enter");
				const found = await eventually(
					() => server.api("find", { in: "cases" }),
					(result) => result.items.some((row) => row.title === "Created after the late refusal"),
				);
				expect(found.items).toHaveLength(1);
				expect((await server.api("timeline", { ref: "C-1" })).entries).toContainEqual(
					expect.objectContaining({ t: "version", version: 1, by: actor }),
				);
				expect(await page.locator("#app").count()).toBe(1);
				expect(browser.errors).toEqual([]);
			} finally {
				held.resolve();
				await browser.close();
				await server.stop();
			}
		},
		30_000,
	);

for (const request of ["session", "link", "operation", "round-trip", "different actor"] as const)
	test.skipIf(!browserAvailable)(
		`a cross-tab ${request} transition discards its late 401 and preserves actor privacy`,
		async () => {
			const server = await startServer({ mode: "server", provider: true });
			const browser = await openPage(server, { path: "/p/scratch/settings" });
			const arrived = Promise.withResolvers<number>();
			const held = Promise.withResolvers<void>();
			const otherChecks = Promise.withResolvers<void>();
			try {
				const { page, context } = browser;
				if (request === "round-trip" || request === "different actor") {
					await page.addInitScript(() => {
						window.addEventListener("storage", (event) => event.stopImmediatePropagation(), true);
					});
					await page.reload();
					await page.locator("#app").waitFor();
				}
				const info = z.object({ result: z.object({ session: z.number(), actorId: z.number() }) });
				const before = info.parse(await (await context.request.get(`${server.url}/api/session`)).json()).result;
				await page.getByRole("option", { name: "Your sign-in", exact: true }).click();
				await page.getByRole("button", { name: "Link Example ID", exact: true }).waitFor();
				const path =
					request === "operation"
						? "/api/p/scratch/find"
						: request === "link" || request === "round-trip"
							? "/api/login/oidc"
							: "/api/session";
				let intercepted = false;
				let released = false;
				await page.route(`**${path}`, async (route) => {
					if (intercepted) {
						if (request === "different actor" && !released) await otherChecks.promise;
						return route.continue();
					}
					intercepted = true;
					const response = await route.fetch({ headers: { ...route.request().headers(), cookie: "" } });
					arrived.resolve(response.status());
					await held.promise;
					await route.fulfill({ response });
				});
				if (request === "operation") await page.getByRole("link", { name: "Suite", exact: true }).click();
				else if (path === "/api/login/oidc")
					await page.getByRole("button", { name: "Link Example ID", exact: true }).click();
				else await page.getByRole("option", { name: "Your sessions", exact: true }).click();
				expect(await arrived.promise).toBe(401);
				const generation = await page.evaluate(() => localStorage.getItem("mainworthy:auth-generation"));
				const other = await context.newPage();
				await other.goto(`${server.url}/p/scratch/settings`);
				await other.locator("#app").waitFor();
				// A new tab and ordinary refresh must not publish a new authentication generation.
				expect(await other.evaluate(() => localStorage.getItem("mainworthy:auth-generation"))).toBe(generation);
				await other.reload();
				await other.locator("#app").waitFor();
				expect(await other.evaluate(() => localStorage.getItem("mainworthy:auth-generation"))).toBe(generation);
				const changesActor = request === "round-trip" || request === "different actor";
				const next = changesActor
					? z.object({ token: z.string() }).parse(
							await server.api("admin", {
								do: "token.create",
								actor: "sam",
								kind: "human",
								can: ["read", "produce"],
								project: "scratch",
							}),
						).token
					: server.token;
				if (request === "round-trip")
					await page.route("**/api/session", async (route) => {
						await otherChecks.promise;
						await route.continue();
					});
				await other.getByRole("button", { name: "Sign out", exact: true }).click();
				await other.getByRole("button", { name: "Sign out and keep drafts", exact: true }).click();
				await other.locator("#token").fill(next);
				await other.keyboard.press("Enter");
				await other.locator("#app").waitFor();
				if (request === "round-trip") {
					await other.getByRole("button", { name: "Sign out", exact: true }).click();
					await other.getByRole("button", { name: "Sign out and keep drafts", exact: true }).click();
					await other.locator("#token").fill(server.token);
					await other.keyboard.press("Enter");
					await other.locator("#app").waitFor();
				}
				if (request === "round-trip") otherChecks.resolve();
				const after = info.parse(await (await context.request.get(`${server.url}/api/session`)).json()).result;
				if (request === "different actor") expect(after.actorId).not.toBe(before.actorId);
				else expect(after.actorId).toBe(before.actorId);
				expect(after.session).not.toBe(before.session);
				const evidence = process.env.MAINWORTHY_CROSS_TAB_EVIDENCE;
				await page.bringToFront();
				if (evidence) await page.screenshot({ path: `${evidence}/cross-tab-${request}-held.png` });
				await page.evaluate(() => {
					Reflect.set(window, "crossTabSignOuts", 0);
					window.addEventListener("mainworthy:unauthenticated", () =>
						Reflect.set(window, "crossTabSignOuts", Number(Reflect.get(window, "crossTabSignOuts")) + 1),
					);
				});
				const completed = page.waitForEvent("requestfinished", { predicate: (sent) => sent.url().endsWith(path) });
				released = true;
				held.resolve();
				await completed;
				if (request === "different actor") {
					await page.locator("#token").waitFor();
					expect(await page.locator("#app").count()).toBe(0);
					return;
				}
				if (evidence) {
					await page.screenshot({ path: `${evidence}/cross-tab-${request}-released.png` });
					console.info(
						JSON.stringify({
							request,
							before: before.session,
							after: after.session,
							signOuts: await page.evaluate((): unknown => Reflect.get(window, "crossTabSignOuts")),
							app: await page.locator("#app").count(),
						}),
					);
				}
				await page.getByRole("link", { name: "Suite", exact: true }).click();
				await page.keyboard.press("c");
				await page.getByRole("textbox", { name: "Case title", exact: true }).fill("Created after cross-tab sign-in");
				await page.keyboard.press("Control+Enter");
				const found = await eventually(
					() => server.api("find", { in: "cases" }),
					(reply) => reply.items.length === 1,
				);
				expect(found.items[0]?.title).toBe("Created after cross-tab sign-in");
				expect((await server.api("timeline", { ref: "C-1" })).entries).toContainEqual(
					expect.objectContaining({ t: "version", version: 1, by: "robin" }),
				);
				expect(await page.evaluate((): unknown => Reflect.get(window, "crossTabSignOuts"))).toBe(0);
				expect(await page.locator("#app").count()).toBe(1);
				expect(browser.errors).toEqual([]);
			} finally {
				otherChecks.resolve();
				held.resolve();
				await browser.close();
				await server.stop();
			}
		},
		30_000,
	);

test.skipIf(!browserAvailable)(
	"a stale reconnect check preserves pending files and resumes live updates after same-actor sign-in",
	async () => {
		const server = await startServer({ mode: "server" });
		await server.api("propose", { edits: [{ op: "create", outline: "Pending evidence\n  Open > Visible" }] });
		const run = await server.api("plan", { name: "Cross-tab attachments", select: {} });
		const browser = await openPage(server, { path: `/p/scratch/runs/${run.run.slice(2)}` });
		const streamHeld = Promise.withResolvers<void>();
		const arrived = Promise.withResolvers<number>();
		const held = Promise.withResolvers<void>();
		try {
			const { page, context } = browser;
			const other = await context.newPage();
			await other.goto(`${server.url}/p/scratch/settings`);
			await other.locator("#app").waitFor();
			let streams = 0;
			await page.route("**/events", async (route) => {
				if (++streams === 1) {
					await streamHeld.promise;
					await route.fulfill({ status: 502, body: "Disconnected" });
				} else await route.continue();
			});
			await page.reload();
			const note = page.getByRole("textbox", { name: "Result note" });
			await note.fill("Keep the pending evidence");
			await page.getByLabel("Attach a file", { exact: true }).setInputFiles({
				name: "pending.txt",
				mimeType: "text/plain",
				buffer: Buffer.from("Preserved attachment bytes"),
			});
			await page.getByRole("button", { name: "Remove pending.txt" }).waitFor();
			let intercepted = false;
			await page.route("**/api/session", async (route) => {
				if (intercepted) return route.continue();
				intercepted = true;
				const response = await route.fetch({ headers: { ...route.request().headers(), cookie: "" } });
				arrived.resolve(response.status());
				await held.promise;
				await route.fulfill({ response });
			});
			streamHeld.resolve();
			expect(await arrived.promise).toBe(401);
			await other.getByRole("button", { name: "Sign out", exact: true }).click();
			await other.getByRole("button", { name: "Sign out and keep drafts", exact: true }).click();
			await other.locator("#token").fill(server.token);
			await other.keyboard.press("Enter");
			await other.locator("#app").waitFor();
			held.resolve();
			await page.getByText("Live updates reconnected.", { exact: true }).waitFor();
			expect(streams).toBe(2);
			expect(await note.inputValue()).toBe("Keep the pending evidence");
			await page.getByRole("button", { name: "Remove pending.txt" }).waitFor();
			await note.press("Enter");
			const entries = await eventually(
				async () => (await server.api("timeline", { ref: "C-1" })).entries.filter((entry) => entry.t === "result"),
				(items) => items.length === 1,
			);
			const recorded = entries[0];
			if (!recorded) throw new Error("The result was not recorded");
			expect(recorded).toMatchObject({ by: "robin", note: "Keep the pending evidence" });
			const files = await server.api("attachment", { result: recorded.id });
			if (files.kind !== "list" || !files.items[0]) throw new Error("The attachment was not recorded");
			expect(files.items.map((file) => file.name)).toEqual(["pending.txt"]);
			const file = await server.api("attachment", { result: recorded.id, id: files.items[0].id });
			expect(file.kind === "file" && atob(file.data)).toBe("Preserved attachment bytes");
		} finally {
			streamHeld.resolve();
			held.resolve();
			await browser.close();
			await server.stop();
		}
	},
	30_000,
);

for (const replacements of [1, 2])
	test.skipIf(!browserAvailable)(
		`startup recovers after ${replacements} authentication replacements with at most one automatic retry`,
		async () => {
			const server = await startServer({ mode: "server" });
			const browser = await openPage(server, { path: "/p/scratch/settings" });
			const gates = Array.from({ length: replacements }, () => ({
				arrived: Promise.withResolvers<number>(),
				held: Promise.withResolvers<void>(),
			}));
			try {
				const first = await browser.context.newPage();
				let reads = 0;
				await first.route("**/api/session", async (route) => {
					const gate = gates[reads++];
					if (!gate) return route.continue();
					const response = await route.fetch({ headers: { ...route.request().headers(), cookie: "" } });
					gate.arrived.resolve(response.status());
					await gate.held.promise;
					await route.fulfill({ response });
				});
				await first.goto(`${server.url}/p/scratch/suite`);
				for (const gate of gates) {
					expect(await gate.arrived.promise).toBe(401);
					await browser.page.getByRole("button", { name: "Sign out", exact: true }).click();
					await browser.page.getByRole("button", { name: "Sign out and keep drafts", exact: true }).click();
					await browser.page.locator("#token").fill(server.token);
					await browser.page.keyboard.press("Enter");
					await browser.page.locator("#app").waitFor();
					gate.held.resolve();
				}
				if (replacements === 2) {
					await first.getByText("Your session changed. Reconnect to continue.", { exact: true }).waitFor();
					expect(reads).toBe(2);
					await first.getByRole("button", { name: "Reconnect", exact: true }).click();
				}
				await first.locator("#app").waitFor();
				expect(await first.locator(".sfoot .me").textContent()).toContain("robin");
				expect(reads).toBe(replacements === 2 ? 3 : 2);
			} finally {
				for (const gate of gates) gate.held.resolve();
				await browser.close();
				await server.stop();
			}
		},
		30_000,
	);

test.skipIf(!browserAvailable)(
	"a held successful session reply cannot restore obsolete credentials after another tab signs in",
	async () => {
		const server = await startServer({ mode: "server", provider: true });
		const browser = await openPage(server, { path: "/p/scratch/settings" });
		const arrived = Promise.withResolvers<number>();
		const held = Promise.withResolvers<void>();
		try {
			const first = await browser.context.newPage();
			let intercepted = false;
			await first.route("**/api/session", async (route) => {
				if (intercepted) return route.continue();
				intercepted = true;
				const response = await route.fetch();
				arrived.resolve(response.status());
				await held.promise;
				await route.fulfill({ response });
			});
			await first.goto(`${server.url}/p/scratch/settings`);
			expect(await arrived.promise).toBe(200);
			const { page } = browser;
			// The other tab links the owner's first identity, through the provider and back.
			await page.getByRole("option", { name: "Your sign-in", exact: true }).click();
			server.idp?.next({ subject: subjectOf("robin") });
			await page.getByRole("button", { name: "Link Example ID", exact: true }).click();
			await page.getByRole("button", { name: "Link another Example ID identity", exact: true }).waitFor();
			await page.getByRole("button", { name: "Sign out", exact: true }).click();
			await page.getByRole("button", { name: "Sign out and keep drafts", exact: true }).click();
			await page.locator("#token").fill(server.token);
			await page.keyboard.press("Enter");
			await page.locator("#app").waitFor();
			held.resolve();
			await first.locator("#app").waitFor();
			// What the held reply said (no identity) is not what the tab acts on: once the token's proof has run
			// out, it offers to confirm with the identity linked meanwhile.
			await advanceClock(server, 10 * 60_000 + 1);
			await first.getByRole("option", { name: "Your sign-in", exact: true }).click();
			await first.getByRole("button", { name: "Link another Example ID identity", exact: true }).click();
			await first
				.getByRole("region", { name: "Confirm it is you", exact: true })
				.getByRole("button", { name: "Confirm with Example ID", exact: true })
				.waitFor();
			expect(browser.errors).toEqual([]);
		} finally {
			held.resolve();
			await browser.close();
			await server.stop();
		}
	},
	30_000,
);

for (const cookie of ["ended", "valid"] as const)
	test.skipIf(!browserAvailable)(
		`startup reconciles a clear missed before subscription when the cookie is ${cookie}`,
		async () => {
			const server = await startServer({ mode: "server" });
			await server.api("propose", { edits: [{ op: "create", outline: "Startup clear case\n  Original step" }] });
			const run = await server.api("plan", { name: "Startup clear", select: {} });
			const browser = await openPage(server, { path: `/p/scratch/runs/${run.run.slice(2)}` });
			try {
				const { page, context } = browser;
				await page.getByRole("textbox", { name: "Result note" }).fill("Discarded startup sentence");
				const { result } = z
					.object({ result: z.object({ actorId: z.number() }) })
					.parse(await (await context.request.get(`${server.url}/api/session`)).json());
				const prefix = `mainworthy:#${result.actorId}:`;
				if (cookie === "ended") await context.clearCookies();
				await page.addInitScript((prefix) => {
					let injected = false;
					window.addEventListener = new Proxy(window.addEventListener, {
						apply(target, receiver, args) {
							if (args[0] === "storage" && !injected) {
								injected = true;
								localStorage.setItem("mainworthy:device-clear", "clear-before-subscription");
								for (const key of Object.keys(localStorage)) if (key.startsWith(prefix)) localStorage.removeItem(key);
							}
							return Reflect.apply(target, receiver, args);
						},
					});
				}, prefix);
				const reply = page.waitForResponse((response) => response.url().endsWith("/api/session"));
				await page.reload();
				expect((await reply).status()).toBe(cookie === "ended" ? 401 : 200);
				try {
					await page.locator(cookie === "ended" ? "#token" : "#app").waitFor();
				} finally {
					const evidence = process.env.MAINWORTHY_STARTUP_CLEAR_EVIDENCE;
					if (evidence) await page.screenshot({ path: `${evidence}/startup-clear-${cookie}.png` });
				}
				if (cookie === "ended") {
					expect(await page.locator("#app").count()).toBe(0);
					await page.locator("#token").fill(server.token);
					await page.keyboard.press("Enter");
					await page.locator("#app").waitFor();
				}
				expect(await page.locator(".sfoot .me").textContent()).toContain("robin");
				expect(
					await page.evaluate(
						(prefix) =>
							Object.entries(localStorage)
								.filter(([key]) => key.startsWith(prefix))
								.some(([, value]) => value.includes("Discarded startup sentence")),
						prefix,
					),
				).toBe(false);
				const note = page.getByRole("textbox", { name: "Result note" });
				await note.waitFor();
				expect(await note.inputValue()).toBe("");
				await note.fill("Recorded after startup clear");
				await note.press("Enter");
				const entries = await eventually(
					async () => (await server.api("timeline", { ref: "C-1" })).entries.filter((entry) => entry.t === "result"),
					(items) => items.length === 1,
				);
				expect(entries[0]).toMatchObject({ note: "Recorded after startup clear", by: "robin" });
				expect((await server.api("get", { refs: ["C-1"] }))[0]).toMatchObject({
					version: 1,
					steps: [{ action: "Original step" }],
				});
				expect(browser.errors).toEqual([]);
			} finally {
				await browser.close();
				await server.stop();
			}
		},
		30_000,
	);
