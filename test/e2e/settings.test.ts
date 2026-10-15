import { expect, test } from "bun:test";
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
			const original = Policy.parse(await server.api("admin", { do: "policy.show", project: "scratch" }));
			const flakyDetection = { enabled: true, windowDays: 7, minFlips: 4 };
			const configured = await server.api("propose", {
				edits: [{ op: "policy", settings: { ...original.settings, flakyDetection } }],
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
			const current = Policy.parse(await server.api("admin", { do: "policy.show", project: "scratch" }));
			const changed = await server.api("propose", {
				edits: [
					{
						op: "policy",
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
