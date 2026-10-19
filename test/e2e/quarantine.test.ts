import { expect, test } from "bun:test";
import { z } from "zod";
import { ciReport } from "../helpers.ts";
import { browserAvailable, eventually, openPage, startServer } from "./support.ts";

(browserAvailable ? test : test.skip)(
	"quarantine proposals are reviewed and the list explains every exit rule",
	async () => {
		const server = await startServer({ preset: "loose" });
		let view: Awaited<ReturnType<typeof openPage>> | null = null;
		try {
			await server.api(
				"report",
				ciReport({ commit: "aaaa0001", n: 3, fail: { 0: "expected green", 1: "expected total", 2: "expected modal" } }),
			);
			view = await openPage(server, { path: "/p/scratch/settings" });
			const page = view.page;
			const session = await view.context.newCDPSession(page);
			await session.send("Emulation.setTimezoneOverride", { timezoneId: "America/Los_Angeles" });
			await session.send("Emulation.setLocaleOverride", { locale: "en-US" });
			page.setDefaultTimeout(8000);
			const panel = page.getByRole("region", { name: "Quarantined tests" });
			const accept = page
				.locator('.queue-pane:has([data-proposal-read="ready"]) .queue-answers .ans')
				.filter({ hasText: "Accept" });
			await panel.getByText("0 quarantined tests", { exact: true }).waitFor();
			await panel.getByLabel("Test ref").fill("T-1");
			await panel.getByLabel("Quarantine reason").fill("Checkout retries disagree on unchanged code");
			await panel.getByRole("spinbutton", { name: "Passing trunk commits", exact: true }).fill("3");
			await panel.getByRole("button", { name: "Propose quarantine", exact: true }).click();
			await page.getByRole("heading", { name: "Quarantine T-1", exact: true }).waitFor();
			await accept.click();
			await page
				.getByLabel("Reason required by policy")
				.fill("Keep checkout failures visible while the test is repaired");
			await page.getByLabel("Reason required by policy").press("Enter");
			await eventually(
				() => server.api("find", { in: "tests", state: "quarantined" }),
				(tests) => tests.count === 1,
			);
			expect(await server.api("gate", { commit: "aaaa0001" })).toMatchObject({ verdict: "blocked" });
			for (const [ref, exit, reason] of [
				["T-2", { kind: "person" }, "Review the timeout before restoring its gate"],
			] as const) {
				const proposal = await server.api("propose", {
					edits: [{ op: "quarantine", test: ref, base: null, exit }],
					reason,
				});
				const questions = await server.api("inbox", { kind: "adopt" });
				const q = questions.items.find((q) => q.q === proposal.question);
				if (!q) throw new Error("missing proposal");
				expect(
					(await server.api("decide", { q: q.q, onEvidence: q.evidenceHash, answer: { is: "accept" }, reason }))[0]
						?.status,
				).toBe("decided");
			}
			await page.goto(`${server.url}/p/scratch/settings`);
			await panel.getByLabel("Test ref").fill("T-3");
			await panel
				.getByLabel("Quarantine reason", { exact: true })
				.fill("Temporary quarantine while the modal test is repaired");
			await panel.getByLabel("Exit rule", { exact: true }).selectOption("expiry");
			await panel.getByLabel("Expiry date", { exact: true }).fill("2099-10-18T09:00");
			await panel.getByRole("button", { name: "Propose quarantine", exact: true }).click();
			await page.getByRole("heading", { name: "Quarantine T-3", exact: true }).waitFor();
			await page.getByText("Expires Oct 18, 2099, 9:00 AM", { exact: false }).waitFor();
			await accept.click();
			await page.getByLabel("Reason required by policy").fill("Temporary quarantine while the modal test is repaired");
			await page.getByLabel("Reason required by policy").press("Enter");
			await eventually(
				() => server.api("find", { in: "tests", state: "quarantined" }),
				(tests) => tests.count === 3,
			);
			await server.api(
				"report",
				ciReport({ commit: "aaaa0002", n: 3, fail: { 0: "expected green", 1: "expected total", 2: "expected modal" } }),
			);
			await page.goto(`${server.url}/p/scratch/settings`);
			await panel.getByText("3 quarantined tests", { exact: true }).waitFor();
			await panel.getByText("3 consecutive passing trunk commits", { exact: false }).waitFor();
			await panel.getByText("A person's decision", { exact: false }).first().waitFor();
			await panel.getByText("Expires Oct 18, 2099, 9:00 AM", { exact: false }).waitFor();
			expect(await panel.getByRole("listitem").count()).toBe(3);
			const entries = z
				.array(z.object({ quarantine: z.object({ since: z.number() }) }))
				.parse(await server.api("get", { refs: ["T-1"] }));
			const since = entries[0]?.quarantine.since;
			if (since === undefined) throw new Error("Missing quarantine entry time");
			const localSince = await page.evaluate(
				(at) => new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }),
				since,
			);
			await panel
				.getByRole("listitem")
				.filter({ hasText: "T-1 ·" })
				.getByText(`Since ${localSince}`, { exact: false })
				.waitFor();
			const end = panel.getByRole("button", { name: "Propose ending T-2 quarantine" });
			expect(await end.isDisabled()).toBe(true);
			expect(
				await end.evaluate((button) => ({
					border: getComputedStyle(button).borderTopWidth,
					opacity: getComputedStyle(button).opacity,
				})),
			).toEqual({ border: "1px", opacity: "0.5" });
			await panel
				.getByLabel("Quarantine reason", { exact: true })
				.fill("An entry reason does not authorize ending quarantine");
			expect(await end.isDisabled()).toBe(true);
			await panel.getByLabel("Reason to end quarantine", { exact: true }).fill(" ");
			expect(await end.isDisabled()).toBe(true);
			const status = await server.api("gate", { commit: "aaaa0002" });
			expect(status).toMatchObject({ verdict: "passed", quarantined: 3, tally: { excused: 3, pass: 0 } });
			expect(status.reason).toContain("3 quarantined failures recorded, not blocking");
			const artifact = process.env.MAINWORTHY_QUARANTINE_SCREENSHOT;
			if (artifact) await panel.locator("ul").screenshot({ path: artifact });
			expect(view.errors).toEqual([]);
			const before = await server.api("find", { in: "tests", state: "quarantined", limit: 20 });
			await page.route("**/api/p/scratch/find", (route) =>
				route.fulfill({ json: { ok: true, result: before, seq: 0 } }),
			);
			const detail = z
				.array(z.object({ quarantine: z.object({ decision: z.number() }) }))
				.parse(await server.api("get", { refs: ["T-2"] }))[0];
			if (!detail) throw new Error("Missing T-2 quarantine");
			const update = await server.api("propose", {
				edits: [{ op: "quarantine", test: "T-2", base: detail.quarantine.decision, exit: { kind: "person" } }],
				reason: "Another reviewer updated quarantine",
			});
			const updateQ = (await server.api("inbox", { kind: "adopt" })).items.find((q) => q.q === update.question);
			if (!updateQ) throw new Error("Missing updated proposal");
			await server.api("decide", {
				q: updateQ.q,
				onEvidence: updateQ.evidenceHash,
				answer: { is: "accept" },
				reason: "A newer quarantine decision",
			});
			await panel.getByLabel("Reason to end quarantine", { exact: true }).fill("The test is reliable again");
			await panel.getByRole("button", { name: "Propose ending T-2 quarantine" }).click();
			await panel.getByRole("alert").filter({ hasText: "Quarantine changed" }).waitFor();
			expect(await panel.getByLabel("Reason to end quarantine", { exact: true }).inputValue()).toBe(
				"The test is reliable again",
			);
			expect((await server.api("inbox", { kind: "adopt" })).items).toEqual([]);
			await page.unroute("**/api/p/scratch/find");
			await page.goto(`${server.url}/p/scratch/settings`);
			await panel.getByText("A newer quarantine decision", { exact: true }).waitFor();
			await panel.getByLabel("Reason to end quarantine", { exact: true }).fill("The test is reliable again");
			await panel.getByRole("button", { name: "Propose ending T-2 quarantine" }).click();
			await page.getByRole("heading", { name: "End quarantine T-2", exact: true }).waitFor();
			await accept.click();
			await page.getByLabel("Reason required by policy").fill("The timeout fix has been checked");
			await page.getByLabel("Reason required by policy").press("Enter");
			await eventually(
				() => server.api("find", { in: "tests", state: "quarantined" }),
				(tests) => tests.count === 2,
			);
			expect(await server.api("gate", { commit: "aaaa0002" })).toMatchObject({ verdict: "passed", quarantined: 3 });
			await server.api(
				"report",
				ciReport({ commit: "aaaa0003", n: 3, fail: { 0: "expected green", 1: "expected total", 2: "expected modal" } }),
			);
			expect(await server.api("gate", { commit: "aaaa0003" })).toMatchObject({ verdict: "blocked", quarantined: 2 });
			expect(view.errors).toEqual([]);
		} finally {
			await view?.close();
			await server.stop();
		}
	},
	45000,
);
