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
	let port = 7481;
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
			NODE_ENV: "production",
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
			if (child.exitCode !== null)
				throw new Error(`Builder 2 server exited before readiness: ${await new Response(child.stderr).text()}`);
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
import { Policy } from "../../src/core/kinds.ts";
import { PRESET_GUIDE, PRESET_SUMMARY } from "../../src/core/policy-guide.ts";
import { PRESETS } from "../../src/core/presets.ts";

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
				(q) => q.evidence.author === "daniel",
			);
			expect(adopted?.decision?.answer.is).toBe("accept");
			expect(adopted?.decision?.by).toEqual(["daniel"]);
			await page.getByLabel("Policy preset").selectOption("strict");
			await eventually(
				() => server.api("admin", { do: "policy.show", project: "scratch" }),
				(reply) => Policy.parse(reply).preset === "strict",
			);
			await page.getByLabel("Policy preset").selectOption("standard");
			await eventually(
				() => server.api("admin", { do: "policy.show", project: "scratch" }),
				(reply) => Policy.parse(reply).preset === "standard",
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
			expect(denied.status).toBe(403);
			expect(
				z.object({ ok: z.literal(false), error: z.object({ code: z.string() }) }).parse(await denied.json()).error.code,
			).toBe("forbidden");
			const tokens = z
				.array(z.object({ id: z.number(), actor: z.string(), revoked: z.boolean() }))
				.parse(await server.api("admin", { do: "token.list" }));
			expect(tokens.find((token) => token.actor === "reviewer")?.revoked).toBe(false);
			await page.getByRole("button", { name: "Dismiss secret" }).click();
			expect(await page.getByLabel("New token").count()).toBe(0);
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
			expect(view.errors).toEqual([]);
		} finally {
			await view?.close();
			await server.stop();
		}
	},
	30000,
);
