import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import axe from "axe-core";
import type { Page } from "playwright-core";
import { KINDS } from "../../src/core/kinds.ts";
import { browserAvailable, openPage, startServer } from "./support.ts";

declare global {
	interface Window {
		axe: typeof axe;
	}
}

const controls =
	'button, summary, [role="button"], a[href], input:not([type="hidden"]), select, textarea, [contenteditable="true"], [tabindex]';

/** Real Tab presses establish keyboard modality and prove a path to each control, including scroll containers. */
async function keyboard(page: Page): Promise<string[]> {
	const expected = await page.evaluate((selector) => {
		const nodes = [...document.querySelectorAll<HTMLElement>(selector)].filter(
			(node) =>
				!node.closest("[inert]") &&
				!node.matches(":disabled") &&
				node.checkVisibility() &&
				getComputedStyle(node).visibility === "visible",
		);
		return nodes.flatMap((node, index) => {
			if (node.tabIndex < 0 && !node.isContentEditable) return [];
			if (node instanceof HTMLInputElement && node.type === "radio" && !node.checked) return [];
			node.dataset.a11yControl = String(index);
			return [
				{
					id: String(index),
					name: node.getAttribute("aria-label") ?? node.textContent?.trim().slice(0, 60) ?? node.id,
				},
			];
		});
	}, controls);
	const reached = new Set<string>();
	const problems: string[] = [];
	const initial = await page.evaluate(() => document.activeElement?.matches(":focus-visible") === true);
	for (let i = 0; i <= (expected.length + 2) * 2; i++) {
		if (i > 0 || !initial) await page.keyboard.press("Tab");
		const result = await page.evaluate((expected) => {
			const node = document.activeElement;
			if (!(node instanceof HTMLElement)) return null;
			const id = node.dataset.a11yControl ?? expected.find((item) => item.name === node.getAttribute("aria-label"))?.id;
			if (!id) return null;
			const style = getComputedStyle(node);
			const box = node.getBoundingClientRect();
			let left = Math.max(0, box.left);
			let right = Math.min(innerWidth, box.right);
			let top = Math.max(0, box.top);
			let bottom = Math.min(innerHeight, box.bottom);
			for (let parent = node.parentElement; parent; parent = parent.parentElement) {
				const clip = getComputedStyle(parent);
				const rect = parent.getBoundingClientRect();
				if (clip.overflowX !== "visible") {
					left = Math.max(left, rect.left);
					right = Math.min(right, rect.right);
				}
				if (clip.overflowY !== "visible") {
					top = Math.max(top, rect.top);
					bottom = Math.min(bottom, rect.bottom);
				}
			}
			const above = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
			return {
				id,
				geometry: `${node.outerHTML.slice(0, 110)} at ${box.x},${box.y} behind ${above?.outerHTML.slice(0, 110)}`,
				focus:
					(style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) >= 2) ||
					(node.closest(".fwrap")?.matches(":focus-within") === true &&
						getComputedStyle(node.closest(".fwrap") ?? node).boxShadow !== "none"),
				visible: right > left && bottom > top && (above === node || node.contains(above)),
			};
		}, expected);
		if (!result) continue;
		reached.add(result.id);
		if (!result.focus) problems.push(`No focus indicator: ${expected.find((node) => node.id === result.id)?.name}`);
		if (!result.visible)
			problems.push(`Focus obscured: ${expected.find((node) => node.id === result.id)?.name}: ${result.geometry}`);
		if (reached.size === expected.length) break;
	}
	for (const node of expected) if (!reached.has(node.id)) problems.push(`Tab cannot reach: ${node.name}`);
	return [...new Set(problems)];
}

test.skipIf(!browserAvailable)(
	"WCAG 2.2 AA: every web screen, both themes, keyboard, targets and live status",
	async () => {
		const server = await startServer({ mode: "server", cases: 8, passkeys: true });
		const h = await openPage(server, { signedIn: false, path: "/" });
		const { page } = h;
		const findings: string[] = [];
		const scanned: string[] = [];
		const manual: string[] = [];
		const capture = process.env.MAINWORTHY_A11Y_CAPTURE;
		if (capture) await mkdir(capture, { recursive: true });
		await page.addInitScript(axe.source);
		await page.evaluate(axe.source);
		const scan = async (name: string) => {
			for (const theme of ["light", "dark"]) {
				await page.evaluate((value) => {
					document.documentElement.dataset.theme = value;
				}, theme);
				const result = await page.evaluate(() => {
					// WCAG 2.5.8 Equivalent: full-size Run slots rows perform the same selection as run dots.
					window.axe.configure({ rules: [{ id: "target-size", selector: "*:not(.run-dot)" }] });
					return window.axe.run(document, {
						runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] },
						resultTypes: ["violations", "incomplete"],
					});
				});
				for (const rule of result.incomplete)
					for (const node of rule.nodes) manual.push(`${name}/${theme}: ${rule.id}: ${node.target.join(" ")}`);
				for (const rule of result.violations)
					for (const node of rule.nodes)
						findings.push(`${name}/${theme}: ${rule.id}: ${node.target.join(" ")}: ${node.failureSummary}`);
				const badges = await page.evaluate(() => {
					const luminance = (color: string) => {
						const channels = color
							.match(/[\d.]+/g)
							?.slice(0, 3)
							.map(Number);
						if (channels?.length !== 3) throw new Error(`Unexpected computed color: ${color}`);
						return channels.reduce((sum, channel, i) => {
							const value = channel / 255;
							return (
								sum +
								(value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4) *
									([0.2126, 0.7152, 0.0722][i] ?? 0)
							);
						}, 0);
					};
					return [...document.querySelectorAll<HTMLElement>(".pg-a, #nav em.hot")].flatMap((node) => {
						if (!node.checkVisibility()) return [];
						const style = getComputedStyle(node);
						const foreground = luminance(style.color);
						const background = luminance(style.backgroundColor);
						const ratio = (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
						return ratio >= 4.5 ? [] : [`${node.className}: ${ratio.toFixed(2)}:1, expected 4.5:1`];
					});
				});
				findings.push(...badges.map((value) => `${name}/${theme}/badge-contrast: ${value}`));
				if (
					capture &&
					["suite", "queue-failure", "settings-People", "palette", "phone-case", "run", "editor"].includes(name)
				)
					await page.screenshot({ path: `${capture}/${name}-${theme}.png` });
			}
			const sizes = await page.evaluate(
				(selector) =>
					[...document.querySelectorAll<HTMLElement>(selector)].flatMap((node) => {
						if (
							node.closest("[inert]") ||
							node.matches(":disabled") ||
							!node.checkVisibility() ||
							getComputedStyle(node).visibility !== "visible"
						)
							return [];
						if (node instanceof HTMLAnchorElement && node.closest("p")) return []; // Inline text exception, 2.5.8.
						if (node.tabIndex < 0)
							return node.matches("button,a[href],input,select,textarea,summary,[role=button]") &&
								!node.matches(".overlay-backdrop,.menu-backdrop")
								? [`No keyboard path: ${node.outerHTML.slice(0, 160)}`]
								: [];
						// WCAG 2.5.8 Equivalent: each run dot selects the same slot as its full-size Run slots row.
						if (node.matches(".run-dot")) return [];
						const label =
							node instanceof HTMLInputElement && ["checkbox", "radio"].includes(node.type) ? node.labels?.[0] : null;
						const box = (label ?? node).getBoundingClientRect();
						return box.width >= 24 && box.height >= 24
							? []
							: [`${node.outerHTML.slice(0, 160)}: ${box.width.toFixed(1)} x ${box.height.toFixed(1)}`];
					}),
				controls,
			);
			findings.push(...sizes.map((value) => `${name}/target: ${value}`));
			findings.push(...(await keyboard(page)).map((value) => `${name}/keyboard: ${value}`));
			scanned.push(name);
		};
		const visit = async (path: string, ready: string) => {
			await page.goto(`${server.url}${path}`);
			await page.locator(ready).first().waitFor();
		};
		try {
			await scan("sign-in");
			const invitation = await server.api("invitation", { do: "create", name: "pat" });
			if (!("code" in invitation)) throw new Error("No invitation code");
			await visit(`/invite#${invitation.code}`, "#invite-password");
			await scan("invitation");
			await page.getByRole("checkbox", { name: "Make a passkey on this device" }).check();
			await scan("invitation-passkey");
			const accepted = await h.context.request.post(`${server.url}/api/login`, {
				data: { invitation: invitation.code, password: "a long enough password" },
			});
			expect(accepted.ok()).toBe(true);
			await h.context.request.post(`${server.url}/api/login`, { data: { token: server.token } });
			const closed = await server.api("plan", { name: "Closed audit run", select: { cases: ["C-2"] } });
			await server.api("report", { run: closed.run, results: [{ test: { case: "C-2" }, outcome: "pass" }] });
			const pending = await server.api("plan", {
				name: "Active audit run",
				select: { cases: ["C-4", "C-5", "C-6", "C-7", "C-8"] },
			});
			const strict = await server.api("propose", { edits: [{ op: "policy", preset: "strict" }] });
			const policy = (await server.api("inbox", { kind: "adopt" })).items.find((q) => q.q === strict.question);
			if (!policy) throw new Error("No policy question");
			await server.api("decide", { q: policy.q, onEvidence: policy.evidenceHash, answer: { is: "accept" } });
			const signoff = await server.api("plan", {
				name: "Audit sign-off",
				select: { cases: ["C-3"] },
				accepts: { commit: "a11y0001" },
			});
			await server.api("report", { run: signoff.run, results: [{ test: { case: "C-3" }, outcome: "pass" }] });
			const questions = (await server.api("inbox", {})).items;
			for (const kind of KINDS) {
				const q = questions.find((item) => item.kind === kind);
				if (!q) throw new Error(`Missing ${kind} fixture`);
				await visit(`/p/scratch/queue/${q.q.slice(2)}`, "[data-current-question]");
				await scan(`queue-${kind}`);
				if (kind === "failure") {
					await page.locator(".queue-answers button").filter({ hasText: "Flaky" }).click();
					await page.locator("#answer-extra").waitFor();
					await scan("queue-answer-reason");
				}
			}
			await visit("/p/scratch/runs", "#list [role=option]");
			await scan("runs");
			await page.getByRole("button", { name: "Plan run", exact: false }).click();
			await scan("run-planner");
			await page.getByRole("radio", { name: "Count only results recorded in this run", exact: true }).focus();
			await page.keyboard.press("ArrowRight");
			expect(await page.getByRole("radio", { name: "Accept results for a commit", exact: true }).isChecked()).toBe(
				true,
			);
			await scan("run-planner-commit");
			await visit(`/p/scratch/runs/${pending.run.slice(2)}`, "[data-ready=true]");
			expect(await page.locator(".run-controls button").filter({ hasText: "Fail" }).isEnabled()).toBe(true);
			await scan("run");
			await page.locator(".run-controls button").filter({ hasText: "Fail" }).click();
			await scan("run-note");
			await visit(`/p/scratch/runs/${closed.run.slice(2)}`, "[data-ready=true]");
			await scan("closed-run");
			await visit("/p/scratch/suite", "#list [role=option]");
			await scan("suite");
			await visit("/p/scratch/suite/c/4", ".ctitle");
			await scan("case");
			await page.locator(".ctitle").click();
			await page.getByRole("textbox", { name: "Case title", exact: true }).waitFor();
			await page.locator(".case-properties > summary").click();
			await scan("editor");
			await page.keyboard.press("Escape");
			await visit("/p/scratch/changes", "#list [role=option]");
			await scan("changes");
			// The pass rate holds what the other reports have (a select, a table, links) and the chart besides.
			await visit("/p/scratch/reports/pass-rate", "#detail .report-hero");
			await scan("reports");
			await visit("/p/scratch/settings", "#detail h2");
			for (const section of [
				"Policy",
				"Tokens",
				"Projects",
				"Connect",
				"Your home",
				"Your sign-in",
				"Your sessions",
				"People",
			]) {
				await page.getByRole("option", { name: section, exact: true }).click();
				await page.locator("#detail h2").first().waitFor();
				await scan(`settings-${section}`);
				if (section === "Policy") {
					await page.getByRole("button", { name: "Add custom field", exact: true }).click();
					await page.getByLabel("Field type 1", { exact: true }).selectOption("choice");
					await page.getByRole("button", { name: "Edit clauses", exact: true }).click();
					await scan("policy-editor");
				}
			}
			await server.api("admin", { do: "team.create", name: "Audit team" });
			await page.getByLabel("New team name", { exact: true }).fill("Local team");
			await page.getByRole("button", { name: "Create team", exact: true }).click();
			await page.getByLabel("Grant on", { exact: true }).waitFor();
			await page.getByRole("button", { name: "Sign-in details for pat", exact: true }).click();
			await page.getByRole("button", { name: "Recovery link for pat", exact: true }).click();
			await page.getByLabel("Person to forget", { exact: true }).selectOption("pat");
			await scan("people-forms");
			await page.getByLabel("Name", { exact: true }).fill("sam");
			await page.getByRole("button", { name: "Make invitation link", exact: true }).click();
			await page.getByLabel("Invitation link for sam", { exact: true }).waitFor();
			await scan("people-invitation-link");
			await page.keyboard.press("ControlOrMeta+k");
			await page.locator("[data-overlay=palette]").waitFor();
			await scan("palette");
			const firstChoice = await page
				.locator("[data-overlay=palette]")
				.getByRole("option", { selected: true })
				.innerText();
			await page.locator(".palette-input").focus();
			await page.keyboard.press("ArrowDown");
			expect(await page.locator("[data-overlay=palette]").getByRole("option", { selected: true }).innerText()).not.toBe(
				firstChoice,
			);
			await page.keyboard.press("Escape");
			expect(await page.locator("[data-overlay=palette]").count()).toBe(0);
			await page.keyboard.press("?");
			await page.getByRole("region", { name: "Keyboard shortcuts" }).waitFor();
			await scan("keyboard-help");
			await page.keyboard.press("Escape");
			expect(await page.locator("[data-overlay=help]").count()).toBe(0);
			await visit("/p/scratch/suite", "#list [role=option]");
			await visit("/p/scratch/suite/c/4", ".ctitle");
			await page.locator(".ctitle").click();
			await page.getByRole("textbox", { name: "Case title", exact: true }).fill("Accessible audit case");
			await page.keyboard.press("Escape");
			const status = page.locator("#stat");
			await page.waitForFunction(() => document.querySelector("#stat")?.textContent?.includes("Proposed"));
			expect(await status.getAttribute("role")).toBe("status");
			expect(await status.getAttribute("aria-live")).toBe("polite");
			expect(await status.getAttribute("aria-atomic")).toBe("true");
			expect(await status.textContent()).toContain("Proposed");
			await page.getByRole("button", { name: "Sign out", exact: true }).click();
			await scan("sign-out");
			await page.keyboard.press("Escape");
			expect(await page.locator("[data-overlay=signout]").count()).toBe(0);
			const cdp = await h.context.newCDPSession(page);
			await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true });
			await page.setViewportSize({ width: 390, height: 844 });
			// The list is scanned once its rows are in: before that it is an empty listbox, which axe reports.
			await visit("/p/scratch/queue", ".pane-scroll [role=option]");
			expect(await page.locator("html").getAttribute("data-layout")).toBe("phone");
			await scan("phone-queue");
			if (await page.getByRole("button", { name: "Back to the list", exact: true }).isVisible())
				await page.getByRole("button", { name: "Back to the list", exact: true }).click();
			await page.locator("#list [role=option]").first().click();
			await page.locator("#app[data-pane=detail]").waitFor();
			await scan("phone-question");
			await visit("/p/scratch/suite/c/4", ".ctitle");
			await scan("phone-case");
			await page.getByRole("button", { name: "Menu", exact: true }).press("Enter");
			await scan("phone-menu");
			await page.getByRole("button", { name: "Actions", exact: true }).click();
			await scan("phone-palette");
			await page.keyboard.press("Escape");
			expect(await page.locator("[data-overlay=palette]").count()).toBe(0);
			expect(h.errors).toEqual([]);
			if (capture) await Bun.write(`${capture}/manual-checks.json`, JSON.stringify(manual, null, 2));
			console.info(
				`Accessibility: ${scanned.length} screens in light and dark; keyboard, targets and live status checked; ${manual.length} axe results need human review.`,
			);
			expect(findings).toEqual([]);
		} finally {
			if (findings.length) console.info(JSON.stringify(findings, null, 2));
			await h.close().finally(() => server.stop());
		}
	},
	60_000,
);
