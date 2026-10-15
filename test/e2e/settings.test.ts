import { expect, test } from "bun:test";
import type { Api, OpName } from "../../src/core/api.ts";
import { call } from "../../src/web/lib/api.ts";
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
import { Policy, UNLINKED_HELP, UNLINKED_LABELS } from "../../src/core/kinds.ts";
import { PRESET_GUIDE, PRESET_SUMMARY } from "../../src/core/policy-guide.ts";
import { PRESETS } from "../../src/core/presets.ts";

(browserAvailable ? test : test.skip)(
	"policy clause drafts validate and preview without writing, then record an accepting decision",
	async () => {
		const server = await fixture({ preset: "loose", mode: "server" });
		let view: Awaited<ReturnType<typeof openPage>> | null = null;
		try {
			await server.api("report", {
				target: { commit: "abcdef01", branch: "main" },
				results: [
					{
						test: { key: "tests/cart.ts::total", file: "tests/cart.ts" },
						outcome: "fail",
						failure: { message: "wrong total" },
					},
				],
			});
			const before = Policy.parse(await server.api("admin", { do: "policy.show", project: "scratch" }));
			view = await openPage(server, { path: "/p/scratch/settings" });
			const { page } = view;
			page.setDefaultTimeout(3000);
			await page.getByRole("button", { name: "Edit clauses", exact: true }).click();
			const mapTrack = page.getByRole("row", { name: "Clause map-track", exact: true });
			await mapTrack.getByLabel("Rule answer").fill("{");
			await page.getByText('Rule answers must be valid JSON, for example {"is":"accept"}.', { exact: true }).waitFor();
			await mapTrack.getByLabel("Rule answer").fill('{"is":"approve"}');
			await page.getByText("Clause map-track needs a valid map rule answer.", { exact: true }).waitFor();
			await mapTrack.getByLabel("Rule answer").fill('{"is":"track"}');
			const failure = page.getByRole("row", { name: "Clause failure-any", exact: true });
			await failure.getByLabel("Conditions").fill("scope:change");
			await page
				.getByText("every kind must end with a clause that always matches; missing for: failure", { exact: true })
				.waitFor();
			expect(await page.getByRole("button", { name: "Preview recent questions" }).isDisabled()).toBe(true);
			expect(await page.getByRole("button", { name: "Apply policy" }).isDisabled()).toBe(true);
			await failure.getByLabel("Conditions").fill("always");
			await failure.getByLabel("Who answers").selectOption("admin");
			await failure.getByLabel("Reason").selectOption("required");
			await page.getByRole("button", { name: "Add clause", exact: true }).click();
			const added = page.getByRole("row", { name: `Clause clause-${before.clauses.length + 1}`, exact: true });
			await added.getByLabel("Clause id").fill("failure-flaky");
			const flaky = page.getByRole("row", { name: "Clause failure-flaky", exact: true });
			await flaky.getByLabel("Conditions").fill("answer:flaky");
			await flaky.getByLabel("Exclude producer").check();
			const beforeFailure = before.clauses.findIndex((clause) => clause.id === "failure-any");
			for (let i = beforeFailure; i < before.clauses.length; i++)
				await flaky.getByRole("button", { name: "Move up", exact: true }).click();
			await page.getByLabel("Flaky hold in days").fill("7");
			await page.getByLabel("Policy change reason").fill("Admins explain failures with a reason.");
			await page.getByRole("button", { name: "Preview recent questions" }).click();
			const preview = page.getByRole("table", { name: "Policy preview" });
			await preview
				.getByRole("cell", {
					name: "failure-any: An admin, with a reason; agents advise · lists release runs",
					exact: true,
				})
				.first()
				.waitFor();
			await preview
				.getByRole("cell", { name: "failure-flaky: A person who did not report it · lists no runs", exact: true })
				.waitFor();
			await preview
				.getByRole("cell", {
					name: 'map-track: By rule: Track without a case {"is":"track"} · lists no runs',
					exact: true,
				})
				.first()
				.waitFor();
			await page.setViewportSize({ width: 390, height: 844 });
			expect(
				await page.locator("#detail .pane-scroll").evaluate((element) => element.scrollWidth - element.clientWidth),
			).toBe(0);
			await page
				.getByRole("heading", { name: "Edit clauses · first match wins", exact: true })
				.scrollIntoViewIfNeeded();
			await page.setViewportSize({ width: 1440, height: 900 });
			await page
				.getByRole("heading", { name: "Edit clauses · first match wins", exact: true })
				.scrollIntoViewIfNeeded();
			expect(Policy.parse(await server.api("admin", { do: "policy.show", project: "scratch" }))).toEqual(before);
			expect((await server.api("inbox", { state: "decided", kind: "adopt" })).items).toEqual([]);
			let firstProposal = true;
			await page.route("**/api/p/scratch/propose", async (route) => {
				const response = await route.fetch();
				if (!firstProposal) return route.fulfill({ response });
				firstProposal = false;
				return route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify({ ok: false, error: { code: "invalid", message: "Proposal reply was unavailable" } }),
				});
			});
			await page.getByRole("button", { name: "Apply policy" }).click();
			await page.locator("#detail").getByText("Proposal reply was unavailable", { exact: true }).waitFor();
			expect(await page.getByLabel("Flaky hold in days").inputValue()).toBe("7");
			expect((await server.api("inbox", { kind: "adopt" })).items).toHaveLength(1);
			await page.getByRole("button", { name: "Apply policy" }).click();
			await page.getByText("Custom policy is in force.", { exact: false }).waitFor();
			await page.unroute("**/api/p/scratch/propose");
			const after = Policy.parse(await server.api("admin", { do: "policy.show", project: "scratch" }));
			expect(after.clauses.find((clause) => clause.id === "failure-any")?.ask).toEqual({
				who: "admin",
				agents: "advise",
				notProducer: false,
				reason: "required",
			});
			expect(after.settings).toEqual({ ...before.settings, holds: { ...before.settings.holds, flakyDays: 7 } });
			expect(after.clauses[beforeFailure]).toMatchObject({
				id: "failure-flaky",
				when: ["answer:flaky"],
				ask: { notProducer: true },
			});
			const decision = (await server.api("inbox", { state: "decided", kind: "adopt" })).items[0]?.decision;
			expect((await server.api("inbox", { kind: "adopt" })).items).toHaveLength(0);
			expect(decision).toMatchObject({
				by: ["robin"],
				answer: { is: "accept" },
				reason: "Admins explain failures with a reason.",
			});
			// A policy changed in another window must not be silently replaced by an older whole-table draft.
			await page.getByRole("button", { name: "Edit clauses", exact: true }).click();
			await page.getByLabel("Flaky hold in days").fill("8");
			await page.getByLabel("Policy change reason").fill("Keep this draft.");
			await page.route("**/api/p/scratch/inbox", (route) =>
				route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify({ ok: false, error: { code: "invalid", message: "Preview temporarily unavailable" } }),
				}),
			);
			await page.getByRole("button", { name: "Preview recent questions" }).click();
			await page.getByText("Preview temporarily unavailable", { exact: true }).waitFor();
			expect(await page.getByLabel("Flaky hold in days").inputValue()).toBe("8");
			await page.unroute("**/api/p/scratch/inbox");
			const changed = await server.api("propose", { edits: [{ op: "policy", preset: "standard" }] });
			const q = (await server.api("inbox", { kind: "adopt" })).items.find((item) => item.q === changed.question);
			if (!q) throw new Error("Policy review missing");
			await server.api("decide", { q: q.q, onEvidence: q.evidenceHash, answer: { is: "accept" } });
			await page
				.getByText(
					"The policy changed while you edited. Your draft is kept. Cancel and reopen the editor to start from the current policy.",
					{ exact: true },
				)
				.waitFor();
			await page.getByRole("button", { name: "Apply policy" }).click();
			await page
				.locator("#detail .settings-message")
				.getByText("The policy changed while you edited.", { exact: false })
				.waitFor();
			expect(await page.getByLabel("Flaky hold in days").inputValue()).toBe("8");
			expect(Policy.parse(await server.api("admin", { do: "policy.show", project: "scratch" })).preset).toBe(
				"standard",
			);
			expect(view.errors).toEqual(["Failed to load resource: the server responded with a status of 409 (Conflict)"]);
		} finally {
			await view?.close();
			await server.stop();
		}
	},
	30000,
);

(browserAvailable ? test : test.skip)(
	"policy edits preserve named role selectors",
	async () => {
		const server = await fixture({ preset: "loose", mode: "server" });
		let view: Awaited<ReturnType<typeof openPage>> | null = null;
		try {
			await server.api("admin", {
				do: "token.create",
				actor: "role-reviewer",
				kind: "human",
				can: ["read", "produce", "answer"],
			});
			await server.api("admin", {
				do: "grant.set",
				actor: "role-reviewer",
				can: ["read", "produce", "answer"],
				roles: ["approver"],
			});
			const before = Policy.extend({ version: z.number() }).parse(
				await server.api("admin", { do: "policy.show", project: "scratch" }),
			);
			const clauses = before.clauses.map((clause): Policy["clauses"][number] =>
				clause.id === "failure-any" ? { ...clause, ask: { ...clause.ask, who: "role:approver" } } : clause,
			);
			const seed = await server.api("propose", { edits: [{ op: "policy", base: before.version, clauses }] });
			const q = (await server.api("inbox", { kind: "adopt" })).items.find((item) => item.q === seed.question);
			if (!q) throw new Error("Policy review missing");
			await server.api("decide", { q: q.q, onEvidence: q.evidenceHash, answer: { is: "accept" } });
			view = await openPage(server, { path: "/p/scratch/settings" });
			await view.page.getByRole("button", { name: "Edit clauses", exact: true }).click();
			expect(
				await view.page
					.getByRole("row", { name: "Clause failure-any", exact: true })
					.getByLabel("Who answers")
					.inputValue(),
			).toBe("role:approver");
			await view.page.getByLabel("Flaky hold in days").fill("9");
			await view.page.getByLabel("Policy change reason").fill("Keep role approval while changing the hold.");
			await view.page.getByRole("button", { name: "Apply policy" }).click();
			await view.page.getByText("Custom policy is in force.", { exact: false }).waitFor();
			const after = Policy.parse(await server.api("admin", { do: "policy.show", project: "scratch" }));
			expect(after.clauses).toEqual(clauses);
			expect(after.settings.holds.flakyDays).toBe(9);
			expect(view.errors).toEqual([]);
		} finally {
			await view?.close();
			await server.stop();
		}
	},
	30000,
);

(browserAvailable ? test : test.skip)(
	"policy edits preserve answers on clauses whose answer field is disabled",
	async () => {
		const server = await fixture({ preset: "loose", mode: "server" });
		let view: Awaited<ReturnType<typeof openPage>> | null = null;
		try {
			const before = Policy.extend({ version: z.number() }).parse(
				await server.api("admin", { do: "policy.show", project: "scratch" }),
			);
			const clauses = before.clauses.map((c) => (c.id === "failure-any" ? { ...c, answer: { is: "flaky" } } : c));
			const seed = await server.api("propose", { edits: [{ op: "policy", base: before.version, clauses }] });
			const q = (await server.api("inbox", { kind: "adopt" })).items.find((item) => item.q === seed.question);
			if (!q) throw new Error("Policy review missing");
			await server.api("decide", { q: q.q, onEvidence: q.evidenceHash, answer: { is: "accept" } });
			view = await openPage(server, { path: "/p/scratch/settings" });
			await view.page.getByRole("button", { name: "Edit clauses", exact: true }).click();
			await view.page.getByLabel("Flaky hold in days").fill("9");
			await view.page.getByLabel("Policy change reason").fill("Only change the hold.");
			await view.page.getByRole("button", { name: "Apply policy" }).click();
			await view.page.getByText("Custom policy is in force.", { exact: false }).waitFor();
			const after = Policy.parse(await server.api("admin", { do: "policy.show", project: "scratch" }));
			expect(after.clauses).toEqual(clauses);
			expect(after.settings.holds.flakyDays).toBe(9);
			expect(view.errors).toEqual([]);
		} finally {
			await view?.close();
			await server.stop();
		}
	},
	30000,
);

(browserAvailable ? test : test.skip)(
	"the policy editor keeps its draft when adoption conflicts with a newer policy",
	async () => {
		const server = await fixture({ preset: "loose", mode: "server" });
		let view: Awaited<ReturnType<typeof openPage>> | null = null;
		try {
			view = await openPage(server, { path: "/p/scratch/settings" });
			const { page } = view;
			page.setDefaultTimeout(3000);
			await page.getByRole("button", { name: "Edit clauses", exact: true }).click();
			await page.getByLabel("Flaky hold in days").fill("9");
			await page.getByLabel("Policy change reason").fill("Keep this on conflict.");
			await page.route("**/api/p/scratch/decide", async (route) => {
				const other = await server.api("propose", { edits: [{ op: "policy", preset: "standard" }] });
				const q = (await server.api("inbox", { kind: "adopt" })).items.find((item) => item.q === other.question);
				if (!q) throw new Error("Policy review missing");
				await server.api("decide", { q: q.q, onEvidence: q.evidenceHash, answer: { is: "accept" } });
				await route.continue();
			});
			await page.getByRole("button", { name: "Apply policy" }).click();
			await page
				.locator("#detail .settings-message")
				.getByText(
					"The policy changed while you edited. Your draft is kept. Cancel and reopen the editor to start from the current policy.",
					{ exact: true },
				)
				.first()
				.waitFor();
			expect(await page.getByLabel("Flaky hold in days").inputValue()).toBe("9");
			expect(await page.getByLabel("Policy change reason").inputValue()).toBe("Keep this on conflict.");
			expect(Policy.parse(await server.api("admin", { do: "policy.show", project: "scratch" })).preset).toBe(
				"standard",
			);
			expect((await server.api("inbox", { kind: "adopt" })).items).toHaveLength(1);
			expect(view.errors).toEqual([]);
		} finally {
			await view?.close();
			await server.stop();
		}
	},
	30000,
);

(browserAvailable ? test : test.skip)(
	"the policy editor explains rights and refuses automatic changes for agents or admins without produce",
	async () => {
		const server = await fixture({ preset: "loose", mode: "server" });
		try {
			for (const kind of ["human", "agent"] as const) {
				const created = z.object({ token: z.string() }).parse(
					await server.api("admin", {
						do: "token.create",
						actor: `${kind}-reader`,
						kind,
						can: kind === "human" ? ["read", "admin"] : ["read", "produce", "answer", "admin"],
					}),
				);
				const view = await openPage({ ...server, token: created.token }, { path: "/p/scratch/settings" });
				try {
					const { page } = view;
					await page.getByRole("button", { name: "Edit clauses", exact: true }).waitFor();
					expect(await page.getByRole("button", { name: "Edit clauses", exact: true }).isDisabled()).toBe(true);
					expect(await page.getByLabel("Policy preset").isDisabled()).toBe(true);
					await page
						.getByText("Changing policy here needs a person with produce and admin on this project.", { exact: false })
						.waitFor();
					expect(view.errors).toEqual([]);
				} finally {
					await view.close();
				}
			}
			expect(Policy.parse(await server.api("admin", { do: "policy.show", project: "scratch" })).preset).toBe("loose");
		} finally {
			await server.stop();
		}
	},
	30000,
);

(browserAvailable ? test : test.skip)(
	"settings records policy decisions, scopes and revokes tokens, and switches projects",
	async () => {
		const server = await fixture({ preset: "loose", mode: "server" });
		let view: Awaited<ReturnType<typeof openPage>> | null = null;
		try {
			await server.api("propose", { edits: [{ op: "create", outline: "Visible in scratch" }] });
			await server.api("admin", { do: "project.create", key: "restricted", name: "Restricted" });
			await call(
				"propose",
				{ edits: [{ op: "create", outline: "Only in restricted" }] },
				{
					url: server.url,
					project: "restricted",
					token: server.token,
				},
			);
			view = await openPage(server, { path: "/p/scratch/settings" });
			const { page } = view;
			page.setDefaultTimeout(8000);
			// The policy in force is explained where it is read, and the comparison marks it.
			const inForce = page.locator("#detail .settings-preset-summary");
			expect(await inForce.innerText()).toBe(PRESET_SUMMARY.loose);
			const comparison = page.locator("#detail .settings-guide");
			expect(await comparison.getByRole("table").isVisible()).toBe(false);
			await comparison.getByText("Compare the policies", { exact: true }).click();
			expect(await comparison.locator("thead th").allInnerTexts()).toEqual([
				"Who answers",
				"loose · in force",
				"standard",
				"strict",
			]);
			expect(await comparison.getByRole("row", { name: "An agent's edit to a case", exact: false }).innerText()).toBe(
				["An agent's edit to a case", "By rule: Accept", "A person", "A person, with a reason"].join("\t"),
			);
			expect(await comparison.locator("tbody tr").count()).toBe(PRESET_GUIDE.length);
			await page.getByRole("switch", { name: "Agent edits need a person", exact: false }).check();
			await eventually(
				() => server.api("admin", { do: "policy.show", project: "scratch" }),
				(reply) => Policy.parse(reply).preset === "standard",
			);
			await page.getByText("are both recorded.", { exact: false }).waitFor();
			await page.getByText(PRESET_SUMMARY.standard, { exact: true }).waitFor();
			await comparison.getByRole("columnheader", { name: "standard · in force", exact: true }).waitFor();
			const adopted = (await server.api("inbox", { state: "decided", kind: "adopt" })).items.find(
				(q) => q.evidence.author === "robin",
			);
			expect(adopted?.decision?.answer.is).toBe("accept");
			expect(adopted?.decision?.by).toEqual(["robin"]);
			await page.getByLabel("Policy preset").selectOption("strict");
			await eventually(
				() => server.api("admin", { do: "policy.show", project: "scratch" }),
				(reply) => Policy.parse(reply).preset === "strict",
			);
			// Under `strict` a person adopts every new case, so the rule that would make them is not offered.
			const unlinked = page.getByLabel("Tests with no case", { exact: true });
			await eventually(
				() => unlinked.inputValue(),
				(value) => value === "ask",
			);
			await eventually(
				() => unlinked.locator('option[value="create"]').evaluate((option: HTMLOptionElement) => option.disabled),
				(disabled) => disabled,
			);
			await page.getByLabel("Policy preset").selectOption("standard");
			await eventually(
				() => server.api("admin", { do: "policy.show", project: "scratch" }),
				(reply) => Policy.parse(reply).preset === "standard",
			);
			// What happens to a test with no case is its own choice. `standard` starts by tracking them; asking puts
			// one question per file in the queue, and tracking again answers every one of them at once.
			await eventually(
				() => unlinked.inputValue(),
				(value) => value === "track",
			);
			await page.getByText(UNLINKED_HELP.track, { exact: true }).waitFor();
			await unlinked.selectOption("ask");
			await page.getByText(`Tests with no case: ${UNLINKED_LABELS.ask}.`, { exact: false }).waitFor();
			for (const file of ["tests/a.spec.ts", "tests/b.spec.ts"])
				await server.api("report", {
					target: { commit: "cafe0001", branch: "main" },
					job: file,
					results: [{ test: { key: `${file}::one`, file }, outcome: "pass" }],
				});
			expect((await server.api("inbox", {})).counts.map).toBe(2);
			await unlinked.selectOption("track");
			await page.getByText("The rule answered 2 open questions about tests with no case.", { exact: false }).waitFor();
			expect((await server.api("inbox", {})).counts.open).toBe(0);
			expect(Policy.parse(await server.api("admin", { do: "policy.show", project: "scratch" })).preset).toBe(
				"standard",
			);
			await page.getByRole("option", { name: "Tokens", exact: true }).click();
			await page.getByLabel("Token actor").fill("reviewer");
			await page.getByRole("button", { name: "Create token", exact: true }).click();
			await page.getByLabel("New token").waitFor();
			const secret = await page.getByLabel("New token").inputValue();
			expect(secret.length).toBeGreaterThan(10);
			expect((await server.api("find", { in: "cases" }, { token: secret })).items.map((row) => row.title)).toEqual([
				"Visible in scratch",
			]);
			const denied = await fetch(`${server.url}/api/p/restricted/find`, {
				method: "POST",
				headers: { "Content-Type": "application/json", authorization: `Bearer ${secret}` },
				body: JSON.stringify({ in: "cases" }),
			});
			// The token holds no grant on `restricted`: it is told what it would be told of a project that does
			// not exist, so that the reply does not confirm the project's key (test/http.test.ts).
			expect(denied.status).toBe(404);
			expect(
				z.object({ ok: z.literal(false), error: z.object({ code: z.string() }) }).parse(await denied.json()).error.code,
			).toBe("not_found");
			const tokens = z
				.array(z.object({ id: z.number(), actor: z.string(), revoked: z.boolean() }))
				.parse(await server.api("admin", { do: "token.list" }));
			expect(tokens.find((token) => token.actor === "reviewer")?.revoked).toBe(false);
			await page.getByRole("button", { name: "Dismiss secret" }).click();
			expect(await page.getByLabel("New token").count()).toBe(0);
			// A pipeline: the form offers what a pipeline may hold and starts from recording alone.
			await page.getByLabel("Token actor").fill("github-actions");
			await page.getByLabel("Producer").selectOption("ci");
			const offered = await page.locator(".settings-capabilities label").allInnerTexts();
			expect(offered.map((text) => text.trim())).toEqual(["read", "record"]);
			expect(await page.locator(".settings-capabilities input:checked").count()).toBe(1);
			await page.getByRole("button", { name: "Create token", exact: true }).click();
			await page.getByLabel("New token").waitFor();
			const pipeline = {
				"Content-Type": "application/json",
				authorization: `Bearer ${await page.getByLabel("New token").inputValue()}`,
			};
			const recorded = await fetch(`${server.url}/api/p/scratch/report`, {
				method: "POST",
				headers: pipeline,
				body: JSON.stringify({ target: { commit: "abc1234" }, results: [{ test: { key: "a::b" }, outcome: "pass" }] }),
			});
			const read = await fetch(`${server.url}/api/p/scratch/find`, { method: "POST", headers: pipeline, body: "{}" });
			expect([recorded.status, read.status]).toEqual([200, 403]);
			await page.getByRole("button", { name: "Dismiss secret" }).click();
			await page.getByRole("button", { name: "Revoke reviewer", exact: true }).click();
			await eventually(
				() => server.api("admin", { do: "token.list" }),
				(reply) =>
					z
						.array(z.object({ actor: z.string(), revoked: z.boolean() }))
						.parse(reply)
						.some((token) => token.actor === "reviewer" && token.revoked),
			);
			const response = await fetch(`${server.url}/api/p/scratch/find`, {
				method: "POST",
				headers: { "Content-Type": "application/json", authorization: `Bearer ${secret}` },
				body: JSON.stringify({ in: "cases" }),
			});
			expect(response.status).toBe(401);
			await page.getByRole("option", { name: "Projects", exact: true }).click();
			await page.getByLabel("Project key").fill("other");
			await page.getByLabel("Project name, optional").fill("Other project");
			// Choosing a project's first policy: the choice is explained as it is made.
			const chosen = page.locator("#project-preset-help");
			expect(await chosen.innerText()).toBe(PRESET_SUMMARY.loose);
			await page.getByLabel("Initial policy").selectOption("strict");
			expect(await chosen.innerText()).toBe(PRESET_SUMMARY.strict);
			expect(await page.getByLabel("Initial policy").getAttribute("aria-describedby")).toBe("project-preset-help");
			await page.locator(".settings-form").getByText("Compare the policies", { exact: true }).click();
			await page.getByRole("columnheader", { name: "strict · selected", exact: true }).waitFor();
			// On a phone the table scrolls inside itself. It does not widen the form or the pane.
			await page.setViewportSize({ width: 390, height: 844 });
			const pane = page.locator("#detail .pane-scroll");
			expect(await pane.evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
			expect(
				await page
					.locator(".settings-form .settings-table-scroll")
					.evaluate((element) => element.scrollWidth > element.clientWidth),
			).toBe(true);
			await page.setViewportSize({ width: 1440, height: 900 });
			await page.getByLabel("Initial policy").selectOption("loose");
			await page.getByRole("button", { name: "Create project", exact: true }).click();
			await page.waitForURL("**/p/other/settings");
			await page.getByRole("option", { name: "Projects", exact: true }).click();
			await page.getByRole("button", { name: "scratch scratch · standard Switch", exact: true }).click();
			await page.waitForURL("**/p/scratch/settings");
			await page.getByRole("option", { name: "Connect", exact: true }).click();
			expect(await page.locator(".settings-command").last().innerText()).toBe(`${server.url}/mcp`);
			// A preset's name over other clauses is a custom policy: no preset's help, and no switch between two presets.
			const proposed = await server.api("propose", {
				edits: [
					{
						op: "policy",
						base: z
							.object({ version: z.number() })
							.parse(await server.api("admin", { do: "policy.show", project: "scratch" })).version,
						preset: "loose",
						clauses: PRESETS.loose.clauses.map((clause) =>
							clause.id === "finding-any" ? { ...clause, ask: { ...clause.ask, reason: "required" as const } } : clause,
						),
					},
				],
			});
			const asked = (await server.api("inbox", { kind: "adopt" })).items.find((q) => q.q === proposed.question);
			if (!asked) throw new Error("The custom policy was not asked about");
			await server.api("decide", { q: asked.q, onEvidence: asked.evidenceHash, answer: { is: "accept" } });
			await page.goto(`${server.url}/p/scratch/settings`);
			await page.getByRole("heading", { name: "custom", exact: true }).waitFor();
			expect(await inForce.innerText()).toBe(
				"This project has a custom policy. Its clause table says who answers, and an instance admin can read it.",
			);
			expect(await page.getByRole("switch").count()).toBe(0);
			expect(await page.locator("#detail .settings-guide th[aria-current]").count()).toBe(0);
			// While the change to a preset is on its way the policy in force is still the custom one: no switch yet.
			let release = (): void => {};
			const held = new Promise<void>((resolve) => {
				release = resolve;
			});
			await page.route("**/api/p/scratch/propose", async (route) => {
				await held;
				await route.continue();
			});
			await page.getByLabel("Policy preset").selectOption("loose");
			await page.getByText("Recording the loose policy proposal and decision…", { exact: true }).waitFor();
			expect(await page.getByRole("switch").count()).toBe(0);
			expect(await page.getByRole("heading", { name: "custom", exact: true }).count()).toBe(1);
			release();
			await page.getByText(PRESET_SUMMARY.loose, { exact: true }).waitFor();
			expect(await page.getByRole("switch", { name: "Agent edits need a person", exact: false }).isChecked()).toBe(
				false,
			);
			expect(view.errors).toEqual([]);
			expect(view.dialogs).toEqual([]);
		} finally {
			await view?.close();
			await server.stop();
		}
	},
	35000,
);

(browserAvailable ? test : test.skip)(
	"Changes displays the real gate, excused decisions, impact and uncovered files",
	async () => {
		const server = await fixture();
		let view: Awaited<ReturnType<typeof openPage>> | null = null;
		try {
			await server.api("propose", {
				edits: [
					{
						op: "create",

						body: {
							title: "Coupon applies",
							methods: ["human", "auto"],
							steps: [{ id: "a1", action: "Apply SAVE10", expected: "Total is 90" }],
						},
					},
				],
			});
			await server.api("report", {
				target: {
					commit: "change0001",
					branch: "fix-coupon",
					pr: 482,
					files: ["tests/coupon.ts", "src/tax.ts"],
					title: "Fix coupon",
				},
				results: [
					{
						test: { key: "tests/coupon.ts::applies", file: "tests/coupon.ts" },
						annotation: { case: "C-1", version: 1 },
						outcome: "fail",
						failure: { message: "expected discount, got full price" },
					},
				],
			});
			const map = (await server.api("inbox", { kind: "map" })).items[0];
			if (!map) throw new Error("Unlinked test question missing");
			await server.api("decide", {
				q: map.q,
				onEvidence: map.evidenceHash,
				answer: { is: "link", pairs: [["T-1", "C-1"]] },
			});
			const q = (await server.api("inbox", { kind: "failure" })).items[0];
			if (!q) throw new Error("Change failure missing");
			await server.api("decide", { q: q.q, onEvidence: q.evidenceHash, answer: { is: "infra" } });
			view = await openPage(server, { path: "/p/scratch/changes/pr%3A482" });
			view.page.setDefaultTimeout(8000);
			await view.page.locator(".change-gate h2").waitFor();
			await view.page.getByText("Infrastructure", { exact: true }).waitFor();
			await view.page.getByText("src/tax.ts", { exact: true }).waitFor();
			expect(await view.page.locator(".change-impact").innerText()).toContain("C-1");
			const gate = await server.api("gate", { change: "pr:482" });
			expect(await view.page.locator(".change-gate").innerText()).toContain(gate.reason);
			expect((await server.api("inbox", { state: "decided", on: "pr:482" })).items[0]?.decision?.answer.is).toBe(
				"infra",
			);
			// The pull request is merged: the list and the detail say so, without a reload, and the answer stays.
			expect(await view.page.locator(".change-ended").count()).toBe(0);
			expect(await server.api("change", { change: "pr:482", state: "merged" })).toMatchObject({ state: "merged" });
			await view.page.locator("#list .change-ended").getByText("merged", { exact: true }).waitFor();
			await view.page
				.getByText("Merged. The verdict above is the last one its commits had.", { exact: false })
				.waitFor();
			await view.page.getByText("Infrastructure", { exact: true }).waitFor();
			expect(view.errors).toEqual([]);
		} finally {
			await view?.close();
			await server.stop();
		}
	},
	30000,
);

(browserAvailable ? test : test.skip)(
	"Settings defines required choice fields through a proposal and decision",
	async () => {
		const server = await fixture({ preset: "loose" });
		let view: Awaited<ReturnType<typeof openPage>> | null = null;
		try {
			const original = Policy.extend({ version: z.number() }).parse(
				await server.api("admin", { do: "policy.show", project: "scratch" }),
			);
			const flakyDetection = { enabled: true, windowDays: 7, minFlips: 4 };
			const configured = await server.api("propose", {
				edits: [{ op: "policy", base: original.version, settings: { ...original.settings, flakyDetection } }],
			});
			const detectorQuestion = (await server.api("inbox", { kind: "adopt" })).items.find(
				(q) => q.q === configured.question,
			);
			if (!detectorQuestion) throw new Error("Detector policy proposal is missing");
			await server.api("decide", {
				q: detectorQuestion.q,
				onEvidence: detectorQuestion.evidenceHash,
				answer: { is: "accept" },
			});
			view = await openPage(server, { path: "/p/scratch/settings" });
			const { page } = view;
			page.setDefaultTimeout(6000);
			await page.getByRole("button", { name: "Add custom field", exact: true }).click();
			await page.getByLabel("Field key 1", { exact: true }).fill("risk");
			await page.getByLabel("Field label 1", { exact: true }).fill("Risk");
			await page.getByLabel("Field type 1", { exact: true }).selectOption("choice");
			await page.getByLabel("Field required 1", { exact: true }).check();
			await page.getByLabel("Field choices 1", { exact: true }).fill("low\nhigh");
			await page.getByRole("button", { name: "Save field definitions", exact: true }).click();
			await page.getByText("Custom field definitions are in force.", { exact: false }).waitFor();
			expect(
				Policy.parse(await server.api("admin", { do: "policy.show", project: "scratch" })).settings,
			).toHaveProperty("fields", { risk: { kind: "choice", label: "Risk", required: true, choices: ["low", "high"] } });
			expect(
				Policy.parse(await server.api("admin", { do: "policy.show", project: "scratch" })).settings.flakyDetection,
			).toEqual(flakyDetection);
			expect(await page.getByText(/Same-code detector: on/).innerText()).toContain(
				"4 outcome changes per test and failure cause in 7 days",
			);
			const decided = await server.api("inbox", { state: "decided", kind: "adopt" });
			expect(decided.items.some((q) => q.decision?.answer.is === "accept" && q.decision.by.includes("robin"))).toBe(
				true,
			);
			await page.getByLabel("Field choices 1", { exact: true }).fill("low\nlow");
			await page.getByRole("button", { name: "Save field definitions", exact: true }).click();
			await page.getByText("Choices must be nonblank and unique", { exact: false }).waitFor();
			expect(
				Policy.parse(await server.api("admin", { do: "policy.show", project: "scratch" })).settings.fields?.risk,
			).toHaveProperty("choices", ["low", "high"]);
			await server.api("propose", {
				edits: [{ op: "create", body: { title: "Field values", fields: { risk: "high", legacy: "keep" } } }],
			});
			const current = Policy.extend({ version: z.number().int().positive() }).parse(
				await server.api("admin", { do: "policy.show", project: "scratch" }),
			);
			const changed = await server.api("propose", {
				edits: [
					{
						op: "policy",
						base: current.version,
						settings: {
							...current.settings,
							fields: {
								risk: { kind: "choice", label: "Risk elsewhere", required: true, choices: ["low", "high"] },
							},
						},
					},
				],
			});
			const q = (await server.api("inbox", { kind: "adopt" })).items.find((q) => q.q === changed.question);
			if (!q) throw new Error("Definition proposal is missing");
			await server.api("decide", { q: q.q, onEvidence: q.evidenceHash, answer: { is: "accept" } });
			await page.getByText("Definitions changed. Reload them before saving.", { exact: true }).waitFor();
			expect(await page.getByRole("button", { name: "Save field definitions", exact: true }).isDisabled()).toBe(true);
			expect(await page.getByLabel("Field choices 1", { exact: true }).inputValue()).toBe("low\nlow");
			await page.getByRole("button", { name: "Reload field definitions", exact: true }).click();
			expect(await page.getByLabel("Field label 1", { exact: true }).inputValue()).toBe("Risk elsewhere");
			await page.getByRole("button", { name: "Remove field 1", exact: true }).click();
			await page.getByRole("button", { name: "Save field definitions", exact: true }).click();
			await eventually(
				() => server.api("admin", { do: "policy.show", project: "scratch" }),
				(reply) => Object.keys(Policy.parse(reply).settings.fields ?? {}).length === 0,
			);
			const documents = await server.api("get", { refs: ["C-1"], as: "md" });
			expect(documents[0]).toHaveProperty("md", expect.stringContaining("risk: high"));
			expect(documents[0]).toHaveProperty("md", expect.stringContaining("legacy: keep"));

			expect(view.errors).toEqual([]);
		} finally {
			await view?.close();
			await server.stop();
		}
	},
	20000,
);

test.skipIf(!browserAvailable)(
	"a person's home opens on entry and by key, with explicit links preserved",
	async () => {
		const server = await startServer({ cases: 2 });
		await server.api("propose", {
			edits: [
				{ op: "folder", name: "HomeFolder" },
				{ op: "create", folder: "HomeFolder", tags: ["home-tag"], outline: "home-query match" },
				{ op: "create", folder: "HomeFolder", outline: "home-query without the tag" },
				{ op: "create", tags: ["home-tag"], outline: "home-query outside the folder" },
			],
		});
		const browser = await openPage(server, { path: "/p/scratch/settings" });
		try {
			const { page } = browser;
			page.setDefaultTimeout(4000);
			await page.getByRole("option", { name: "Your home", exact: true }).click();
			await page.getByLabel("Home screen", { exact: true }).selectOption("queue");
			await page.getByRole("button", { name: "Save home", exact: true }).click();
			await page.getByRole("status").filter({ hasText: "Home saved" }).waitFor();
			for (const path of ["/", "/p/scratch", "/p/scratch/"]) {
				await page.goto(`${server.url}${path}`);
				await page.waitForURL("**/p/scratch/queue");
			}
			await page.goto(`${server.url}/p/scratch?folder=HomeFolder`);
			await page.locator("#app").waitFor();
			expect(page.url()).toBe(`${server.url}/p/scratch?folder=HomeFolder`);
			await eventually(
				() => page.locator("#lcount").innerText(),
				(text) => text === "2 cases",
			);
			await page.goto(`${server.url}/p/scratch/suite/c/1`);
			await page.locator(".ctitle").waitFor();
			await page.keyboard.press("e");
			await page.getByRole("textbox", { name: "Case title", exact: true }).fill("Home navigation seals this draft");
			await page.keyboard.press("Control+k");
			await page.getByRole("textbox", { name: "Jump to or run" }).fill("Go home");
			await page.keyboard.press("Enter");
			await page.waitForURL("**/p/scratch/queue");
			await eventually(
				() => server.api("get", { refs: ["C-1"] }),
				(rows) => rows[0]?.title === "Home navigation seals this draft",
			);
			await page.keyboard.type("gs");
			await page.waitForURL("**/p/scratch/suite");
			await page.keyboard.type("gh");
			await page.waitForURL("**/p/scratch/queue");
			await page.keyboard.type("g,");
			await page.getByRole("option", { name: "Your home", exact: true }).click();
			const planned = await server.api("plan", { name: "Home run", select: { cases: ["C-1"] } });
			await server.api("plan", { name: "Newer run", select: { cases: ["C-1"] } });
			await page.getByLabel("Home screen", { exact: true }).selectOption("run");
			await page.getByLabel("Home run", { exact: true }).fill(planned.run);
			await page.keyboard.press("Tab");
			expect(await page.evaluate(() => document.activeElement?.textContent?.trim())).toBe("Save home");
			await page.keyboard.press("Enter");
			await page.getByRole("status").filter({ hasText: "Home saved" }).waitFor();
			await page.goto(`${server.url}/`);
			await page.waitForURL(`**/p/scratch/runs/${planned.run.slice(2)}`);
			await page.getByText("Home run", { exact: true }).first().waitFor();
			await page.keyboard.type("gq");
			await page.waitForURL("**/p/scratch/queue");
			let release = (): void => {};
			const held = new Promise<void>((resolve) => {
				release = resolve;
			});
			let finish = (): void => {};
			const completed = new Promise<void>((resolve) => {
				finish = resolve;
			});
			await page.route("**/api/p/scratch/get", async (route) => {
				if (route.request().postDataJSON().refs?.includes(planned.run)) {
					await held;
					await route.continue();
					finish();
				} else await route.continue();
			});
			const asked = page.waitForRequest(
				(request) => request.url().endsWith("/get") && request.postDataJSON().refs?.includes(planned.run),
			);
			await page.keyboard.type("gh");
			await asked;
			await page.keyboard.type("g,");
			await page.waitForURL("**/p/scratch/settings");
			const answered = page.waitForResponse(
				(response) => response.url().endsWith("/get") && response.request().postDataJSON().refs?.includes(planned.run),
			);
			release();
			await (await answered).finished();
			await completed;
			await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
			await page.unroute("**/api/p/scratch/get");
			await page.getByRole("option", { name: "Your home", exact: true }).waitFor();
			expect(page.url()).toBe(`${server.url}/p/scratch/settings`);
			await page.goto(`${server.url}/p/scratch/settings`);
			await page.getByRole("option", { name: "Your home", exact: true }).click();
			await page.getByLabel("Home screen", { exact: true }).selectOption("search");
			await page.getByLabel("Home search text", { exact: true }).fill("home-query");
			await page.getByLabel("Home search folder", { exact: true }).fill("HomeFolder");
			await page.getByLabel("Home search tag", { exact: true }).fill("home-tag");
			await page.getByRole("button", { name: "Save home", exact: true }).click();
			await page.getByRole("status").filter({ hasText: "Home saved" }).waitFor();
			await page.getByLabel("Home search text", { exact: true }).fill("unsaved change");
			expect(await page.getByRole("status").filter({ hasText: "Home saved" }).count()).toBe(0);
			await page.getByLabel("Home search text", { exact: true }).fill("home-query");
			await page.getByRole("button", { name: "Save home", exact: true }).click();
			await page.getByRole("status").filter({ hasText: "Home saved" }).waitFor();
			await page.goto(`${server.url}/`);
			await page.getByRole("textbox", { name: "Filter cases", exact: true }).waitFor();
			expect(await page.getByRole("textbox", { name: "Filter cases", exact: true }).inputValue()).toBe("home-query");
			await eventually(
				() => page.locator("#lcount").innerText(),
				(text) => text === "1 cases",
			);
			await page.getByRole("textbox", { name: "Filter cases", exact: true }).fill("changed-filter");
			await page.waitForURL("**/suite?text=changed-filter&folder=HomeFolder&tag=home-tag");
			await page.keyboard.press("Tab");
			await page.keyboard.type("gh");
			await page.waitForURL("**/suite?text=home-query&folder=HomeFolder&tag=home-tag");
			expect(await page.getByRole("textbox", { name: "Filter cases", exact: true }).inputValue()).toBe("home-query");
			await page.keyboard.type("gq");
			await page.keyboard.press("Control+k");
			await page.getByRole("textbox", { name: "Jump to or run" }).fill("Go home");
			await page.keyboard.press("Enter");
			await page.waitForURL("**/suite?text=home-query&folder=HomeFolder&tag=home-tag");
			expect(browser.errors).toEqual([]);
		} finally {
			await browser.close();
			await server.stop();
		}
	},
	30000,
);

for (const secondProject of [true, false])
	test.skipIf(!browserAvailable)(
		secondProject
			? "Q1: a run home in the second project opens by ref"
			: "Q2: a run home after another project's run opens by ref",
		async () => {
			const server = await startServer();
			await server.api("admin", { do: "project.create", key: "other", preset: "loose" });
			const api = <O extends OpName>(op: O, input: Api[O]["input"], project: string) =>
				call(op, input, { url: server.url, token: server.token, project });
			for (const project of ["scratch", "other"])
				await api("propose", { edits: [{ op: "create", outline: "Home case" }] }, project);
			const before = secondProject ? "scratch" : "other";
			const project = secondProject ? "other" : "scratch";
			await api("plan", { name: "Earlier run", select: { cases: ["C-1"] } }, before);
			if (secondProject) await api("plan", { name: "Another earlier run", select: { cases: ["C-1"] } }, before);
			const planned = await api("plan", { name: "Chosen run home", select: { cases: ["C-1"] } }, project);
			const browser = await openPage(server, { path: `/p/${project}/settings` });
			try {
				const { page } = browser;
				page.setDefaultTimeout(4000);
				await page.getByRole("option", { name: "Your home", exact: true }).click();
				await page.getByLabel("Home screen", { exact: true }).selectOption("run");
				await page.getByLabel("Home run", { exact: true }).fill(planned.run);
				await page.getByRole("button", { name: "Save home", exact: true }).click();
				await page.getByRole("status").filter({ hasText: "Home saved" }).waitFor();
				await page.goto(`${server.url}${secondProject ? `/p/${project}` : "/"}`);
				await page.waitForURL(`**/p/${project}/runs/${planned.run.slice(2)}`);
				await page.getByText("Chosen run home", { exact: true }).first().waitFor();
				expect(await page.getByRole("status").filter({ hasText: "Your home was not found" }).count()).toBe(0);
				expect(browser.errors).toEqual([]);
			} finally {
				await browser.close();
				await server.stop();
			}
		},
		15000,
	);

test.skipIf(!browserAvailable)(
	"a failed home lookup on entry opens Suite with a notice",
	async () => {
		const server = await startServer({ cases: 1 });
		const planned = await server.api("plan", { name: "Home run", select: { cases: ["C-1"] } });
		const browser = await openPage(server, { path: "/p/scratch/settings" });
		try {
			const { page } = browser;
			page.setDefaultTimeout(4000);
			await page.getByRole("option", { name: "Your home", exact: true }).click();
			await page.getByLabel("Home screen", { exact: true }).selectOption("run");
			await page.getByLabel("Home run", { exact: true }).fill(planned.run);
			await page.getByRole("button", { name: "Save home", exact: true }).click();
			await page.getByRole("status").filter({ hasText: "Home saved" }).waitFor();
			await page.route(/\/api\/p\/scratch\/(?:get|find)$/, async (route) => {
				const input = route.request().postDataJSON();
				if (input.in === "runs" || input.refs?.includes(planned.run)) await route.abort();
				else await route.continue();
			});
			await page.goto(`${server.url}/`);
			await page.waitForURL("**/p/scratch/suite");
			await page.getByRole("status").filter({ hasText: "Could not read your home. Opened Suite." }).waitFor();
			await eventually(
				() => page.locator("#lcount").innerText(),
				(text) => text === "1 cases",
			);
			expect(await page.getByRole("button", { name: "Reconnect", exact: true }).count()).toBe(0);
			await page.unroute(/\/api\/p\/scratch\/(?:get|find)$/);
			await page.keyboard.type("gh");
			await page.waitForURL(`**/p/scratch/runs/${planned.run.slice(2)}`);
			await page.getByText("Home run", { exact: true }).first().waitFor();
		} finally {
			await browser.close();
			await server.stop();
		}
	},
	15000,
);

test.skipIf(!browserAvailable)(
	"a phone edits its home through Settings and opens a run home on its detail",
	async () => {
		const server = await startServer({ cases: 1 });
		const planned = await server.api("plan", { name: "Phone home run", select: { cases: ["C-1"] } });
		const phone = await openPage(server, { device: "phone", path: "/p/scratch/settings" });
		try {
			const { page } = phone;
			page.setDefaultTimeout(4000);
			await page.getByRole("option", { name: "Your home", exact: true }).tap();
			await page.getByLabel("Home screen", { exact: true }).selectOption("run");
			await page.getByLabel("Home run", { exact: true }).fill(planned.run);
			await page.getByRole("button", { name: "Save home", exact: true }).tap();
			await page.getByRole("status").filter({ hasText: "Home saved" }).waitFor();
			expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
			await page.goto(`${server.url}/`);
			await page.waitForURL(`**/p/scratch/runs/${planned.run.slice(2)}`);
			await eventually(
				() => page.locator("#app").getAttribute("data-pane"),
				(pane) => pane === "detail",
			);
			await page.getByRole("button", { name: "Back to the list", exact: true }).tap();
			await page.getByRole("button", { name: "Actions", exact: true }).tap();
			await page.getByRole("option").filter({ hasText: "Go home" }).tap();
			await eventually(
				() => page.locator("#app").getAttribute("data-pane"),
				(pane) => pane === "detail",
			);
			expect(phone.errors).toEqual([]);
		} finally {
			await phone.close();
			await server.stop();
		}
	},
	30000,
);

test.skipIf(!browserAvailable)(
	"home is personal to a project and browser, and a refused save keeps the previous home",
	async () => {
		const server = await startServer({ mode: "server" });
		await server.api("admin", { do: "project.create", key: "other", preset: "loose" });
		const made = z
			.object({ token: z.string() })
			.parse(await server.api("admin", { do: "token.create", actor: "home-reader", kind: "human", can: ["read"] }));
		const browser = await openPage(server, { path: "/p/scratch/settings" });
		try {
			const { page } = browser;
			page.setDefaultTimeout(4000);
			await page.getByRole("option", { name: "Your home", exact: true }).click();
			await page.getByLabel("Home screen", { exact: true }).selectOption("queue");
			await page.getByRole("button", { name: "Save home", exact: true }).click();
			await page.getByRole("status").filter({ hasText: "Home saved" }).waitFor();
			const homeKey = await page.evaluate(() => Object.keys(localStorage).find((key) => key.includes(":home:")));
			if (!homeKey) throw new Error("Missing home preference");
			await page.getByLabel("Home screen", { exact: true }).selectOption("search");
			await page.getByLabel("Home search tag", { exact: true }).fill("INVALID TAG");
			await page.getByRole("button", { name: "Save home", exact: true }).click();
			await page.getByRole("status").filter({ hasText: "a search with a valid tag" }).waitFor();
			await page.keyboard.type("gh");
			await page.waitForURL("**/p/scratch/queue");
			await page.goto(`${server.url}/p/other`);
			await page.waitForURL("**/p/other/suite");
			await browser.context.request.post(`${server.url}/api/login`, { data: { token: made.token } });
			await page.goto(`${server.url}/`);
			await page.waitForURL("**/p/scratch/suite");
			await browser.context.request.post(`${server.url}/api/login`, { data: { token: server.token } });
			await page.goto(`${server.url}/p/scratch`);
			await page.waitForURL("**/p/scratch/queue");
			const fresh = await openPage(server, { path: "/p/scratch" });
			try {
				await fresh.page.waitForURL("**/p/scratch/suite");
			} finally {
				await fresh.close();
			}
			for (const invalid of [
				"{",
				"null",
				'{"kind":"run","ref":"https://example.com"}',
				'{"kind":"search","text":[],"folder":"","tag":""}',
			]) {
				await page.evaluate(({ key, value }) => localStorage.setItem(key, value), { key: homeKey, value: invalid });
				await page.goto(`${server.url}/p/scratch`);
				await page.waitForURL("**/p/scratch/suite");
			}
			await page.evaluate((key) => {
				localStorage.setItem(key, JSON.stringify({ kind: "queue" }));
				const setItem = Storage.prototype.setItem;
				Storage.prototype.setItem = function (name, value) {
					if (name === key) throw new DOMException("The store refused", "QuotaExceededError");
					setItem.call(this, name, value);
				};
			}, homeKey);
			await page.keyboard.type("g,");
			await page.getByRole("option", { name: "Your home", exact: true }).click();
			await page.getByLabel("Home screen", { exact: true }).selectOption("suite");
			await page.getByRole("button", { name: "Save home", exact: true }).click();
			await page.getByRole("status").filter({ hasText: "could not save your home" }).waitFor();
			await page.keyboard.type("gh");
			await page.waitForURL("**/p/scratch/queue");
			await page.evaluate((key) => {
				const getItem = Storage.prototype.getItem;
				Storage.prototype.getItem = function (name) {
					if (name === key) throw new DOMException("The store refused", "SecurityError");
					return getItem.call(this, name);
				};
			}, homeKey);
			await page.keyboard.type("gh");
			await page.waitForURL("**/p/scratch/suite");
			expect(browser.errors).toEqual([]);
		} finally {
			await browser.close();
			await server.stop();
		}
	},
	30000,
);

test.skipIf(!browserAvailable)(
	"entering at a Suite home restores the person's unsealed capture",
	async () => {
		const server = await startServer();
		const browser = await openPage(server);
		try {
			const { page } = browser;
			page.setDefaultTimeout(4000);
			await page.keyboard.press("c");
			await page.keyboard.type("Home capture");
			await page.keyboard.press("Enter");
			await page.keyboard.type("An unfinished step");
			await page.evaluate(() => history.replaceState(null, "", "/"));
			await page.reload();
			await page.waitForURL("**/p/scratch/suite");
			const step = page.getByRole("textbox", { name: "Step 1", exact: true });
			await step.waitFor();
			expect(await step.inputValue()).toBe("An unfinished step");
			expect(browser.errors).toEqual([]);
		} finally {
			await browser.close();
			await server.stop();
		}
	},
	30000,
);

for (const home of [
	{ kind: "run", ref: "R-999" },
	{ kind: "search", text: "alpha", folder: "Gone", tag: "missing-tag" },
])
	test.skipIf(!browserAvailable)(
		`a missing ${home.kind} home opens Suite once with an explanation`,
		async () => {
			const server = await startServer({ cases: 1 });
			const browser = await openPage(server, { path: "/p/scratch/settings" });
			try {
				const { page } = browser;
				page.setDefaultTimeout(4000);
				await page.getByRole("option", { name: "Your home", exact: true }).click();
				await page.getByRole("button", { name: "Save home", exact: true }).click();
				await page.getByRole("status").filter({ hasText: "Home saved" }).waitFor();
				const key = await page.evaluate(() => Object.keys(localStorage).find((key) => key.includes(":home:")));
				if (!key) throw new Error("Missing home preference");
				await page.evaluate(({ key, home }) => localStorage.setItem(key, JSON.stringify(home)), { key, home });
				await page.goto(`${server.url}/`);
				await page.waitForURL("**/p/scratch/suite");
				await eventually(
					() => page.locator("#lcount").innerText(),
					(text) => text === "1 cases",
				);
				const notice = page
					.locator("#bar")
					.getByRole("status")
					.filter({ hasText: "Your home was not found. Opened Suite." });
				await notice.waitFor();
				expect(await notice.count()).toBe(1);
				await page.keyboard.type("gq");
				await page.waitForURL("**/p/scratch/queue");
				await page.keyboard.type("gh");
				await page.waitForURL("**/p/scratch/suite");
				await notice.waitFor();
				expect(await notice.count()).toBe(1);
				expect(await page.getByRole("textbox", { name: "Filter cases", exact: true }).inputValue()).toBe("");
				expect(browser.errors).toEqual(
					home.kind === "run"
						? Array(2).fill("Failed to load resource: the server responded with a status of 404 (Not Found)")
						: [],
				);
			} finally {
				await browser.close();
				await server.stop();
			}
		},
		30000,
	);

test.skipIf(!browserAvailable)(
	"sidebar folder and tag filters keep the Suite search text",
	async () => {
		const server = await startServer();
		await server.api("propose", {
			edits: [
				{ op: "folder", name: "Filtered" },
				{ op: "create", folder: "Filtered", tags: ["one"], outline: "alpha inside" },
				{ op: "create", folder: "Filtered", tags: ["two"], outline: "beta inside" },
				{ op: "create", tags: ["two"], outline: "alpha outside" },
			],
		});
		const browser = await openPage(server);
		try {
			const { page } = browser;
			page.setDefaultTimeout(4000);
			const filter = page.getByRole("textbox", { name: "Filter cases", exact: true });
			await filter.fill("alpha");
			await page.waitForURL("**/suite?text=alpha");
			await page.locator("#tree button").filter({ hasText: "Filtered" }).click();
			expect(await filter.inputValue()).toBe("alpha");
			expect(new URL(page.url()).searchParams.get("text")).toBe("alpha");
			await eventually(
				() => page.locator("#lcount").innerText(),
				(text) => text === "1 cases",
			);
			await page.locator(".sidebar-tags button").filter({ hasText: "#two" }).click();
			expect(await filter.inputValue()).toBe("alpha");
			expect(new URL(page.url()).searchParams.get("text")).toBe("alpha");
			await eventually(
				() => page.locator("#lcount").innerText(),
				(text) => text === "0 cases",
			);
			await page.getByRole("button", { name: "All tags", exact: true }).click();
			expect(await filter.inputValue()).toBe("alpha");
			expect(new URL(page.url()).searchParams.get("text")).toBe("alpha");
			await eventually(
				() => page.locator("#lcount").innerText(),
				(text) => text === "1 cases",
			);
			await page.locator("#tree button").filter({ hasText: "All cases" }).click();
			expect(await filter.inputValue()).toBe("alpha");
			expect(new URL(page.url()).searchParams.get("text")).toBe("alpha");
			await eventually(
				() => page.locator("#lcount").innerText(),
				(text) => text === "2 cases",
			);
			expect(browser.errors).toEqual([]);
		} finally {
			await browser.close();
			await server.stop();
		}
	},
	30000,
);

for (const restricted of [true, false]) {
	test.skipIf(!browserAvailable)(
		restricted
			? "P5: entry uses the only granted project, including roots with a query and unknown paths"
			: "P5: entry uses an instance whose first project is not scratch",
		async () => {
			const server = await startServer({ mode: "server", firstProject: restricted ? "scratch" : "other" });
			let browser: Awaited<ReturnType<typeof openPage>> | null = null;
			try {
				if (restricted) await server.api("admin", { do: "project.create", key: "other", preset: "loose" });
				await call(
					"propose",
					{ edits: [{ op: "create", outline: "Only in other" }] },
					{
						url: server.url,
						project: "other",
						token: server.token,
					},
				);
				const password = "a long enough password";
				if (restricted) {
					const made = await server.api("invitation", { do: "create", name: "pat", project: "other", can: ["read"] });
					if (!("code" in made)) throw new Error("No invitation was made");
					const accepted = await fetch(`${server.url}/api/login`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ invitation: made.code, password }),
					});
					expect(accepted.status).toBe(200);
				}
				browser = await openPage(server, {
					path: "/p/other/settings",
					...(restricted ? { as: { name: "pat", password } } : {}),
				});
				const { page } = browser;
				page.setDefaultTimeout(4000);
				await page.getByRole("option", { name: "Your home", exact: true }).click();
				await page.getByLabel("Home screen", { exact: true }).selectOption("queue");
				await page.getByRole("button", { name: "Save home", exact: true }).click();
				await page.getByRole("status").filter({ hasText: "Home saved" }).waitFor();
				for (const path of ["/", "/p/other", "/p/other/", "/?utm=1", "/nowhere"]) {
					await page.goto(`${server.url}${path}`);
					const screen = path === "/?utm=1" || path === "/nowhere" ? "suite" : "queue";
					await page.waitForURL(`${server.url}/p/other/${screen}`);
					await page.locator("#app").waitFor();
					expect(await page.locator(".project-name").innerText()).toBe("other");
					if (screen === "suite") {
						await eventually(
							() => page.locator("#lcount").innerText(),
							(text) => text === "1 cases",
						);
						await page.getByRole("option").getByText("Only in other", { exact: true }).waitFor();
					}
					expect(await page.getByText("Cases unavailable", { exact: true }).count()).toBe(0);
					expect(browser.errors).toEqual([]);
				}
			} finally {
				await browser?.close();
				await server.stop();
			}
		},
		30_000,
	);
}

for (const control of ["Policy preset", "Tests with no case"] as const)
	for (const stage of ["propose", "decide"] as const)
		(browserAvailable ? test : test.skip)(
			`${control} explains a concurrent change at ${stage} without editor instructions`,
			async () => {
				const server = await fixture({ preset: "loose", mode: "server" });
				let view: Awaited<ReturnType<typeof openPage>> | null = null;
				try {
					view = await openPage(server, { path: "/p/scratch/settings" });
					const { page } = view;
					page.setDefaultTimeout(3000);
					await page.getByRole("button", { name: "Edit clauses", exact: true }).waitFor();
					await page.route(`**/api/p/scratch/${stage}`, async (route) => {
						const before = Policy.extend({ version: z.number() }).parse(
							await server.api("admin", { do: "policy.show", project: "scratch" }),
						);
						const other = await server.api("propose", {
							edits: [{ op: "policy", base: before.version, settings: { ...before.settings, basis: "exact" } }],
						});
						const q = (await server.api("inbox", { kind: "adopt" })).items.find((item) => item.q === other.question);
						if (!q) throw new Error("Policy review missing");
						await server.api("decide", { q: q.q, onEvidence: q.evidenceHash, answer: { is: "accept" } });
						await route.continue();
					});
					await page.getByLabel(control, { exact: true }).selectOption(control === "Policy preset" ? "strict" : "ask");
					const message = page.locator("#detail .settings-message");
					await message.getByText("The policy changed", { exact: false }).waitFor();
					expect(await message.textContent()).toBe(
						"The policy changed before this selection was saved. Review the current policy and choose again.",
					);
					expect(await server.api("admin", { do: "policy.show", project: "scratch" })).toMatchObject({
						version: 2,
						preset: "loose",
						settings: { unlinked: "track", basis: "exact" },
					});
					expect((await server.api("inbox", { kind: "adopt" })).items).toHaveLength(stage === "decide" ? 1 : 0);
					expect(view.errors).toEqual(
						stage === "propose"
							? ["Failed to load resource: the server responded with a status of 409 (Conflict)"]
							: [],
					);
				} finally {
					await view?.close();
					await server.stop();
				}
			},
			15000,
		);

(browserAvailable ? test : test.skip)(
	"field definitions keep their draft when a concurrent policy change conflicts",
	async () => {
		for (const stage of ["propose", "decide"] as const) {
			const server = await fixture({ preset: "loose", mode: "server" });
			let view: Awaited<ReturnType<typeof openPage>> | null = null;
			try {
				view = await openPage(server, { path: "/p/scratch/settings" });
				const { page } = view;
				page.setDefaultTimeout(3000);
				await page.getByRole("button", { name: "Add custom field", exact: true }).click();
				await page.getByLabel("Field key 1", { exact: true }).fill("notes");
				await page.getByLabel("Field label 1", { exact: true }).fill("Keep this draft");
				let sentBase: unknown;
				await page.route("**/api/p/scratch/propose", async (route) => {
					sentBase = route.request().postDataJSON().edits[0].base;
					if (stage === "propose") await changeElsewhere();
					await route.continue();
				});
				async function changeElsewhere() {
					const other = await server.api("propose", { edits: [{ op: "policy", preset: "standard" }] });
					const q = (await server.api("inbox", { kind: "adopt" })).items.find((item) => item.q === other.question);
					if (!q) throw new Error("Policy review missing");
					await server.api("decide", { q: q.q, onEvidence: q.evidenceHash, answer: { is: "accept" } });
				}
				if (stage === "decide")
					await page.route("**/api/p/scratch/decide", async (route) => {
						await changeElsewhere();
						await route.continue();
					});
				await page.getByRole("button", { name: "Save field definitions", exact: true }).click();
				await page
					.locator("#detail .settings-message")
					.getByText("The policy changed while you edited.", { exact: false })
					.waitFor();
				expect(sentBase).toBe(1);
				expect(await page.getByLabel("Field label 1", { exact: true }).inputValue()).toBe("Keep this draft");
				expect(Policy.parse(await server.api("admin", { do: "policy.show", project: "scratch" }))).toMatchObject({
					preset: "standard",
					settings: { basis: "exact-or-assumed" },
				});
				expect((await server.api("inbox", { kind: "adopt" })).items).toHaveLength(stage === "decide" ? 1 : 0);
				expect(view.errors).toEqual(
					stage === "propose" ? ["Failed to load resource: the server responded with a status of 409 (Conflict)"] : [],
				);
			} finally {
				await view?.close();
				await server.stop();
			}
		}
	},
	30000,
);
