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
			page.setDefaultTimeout(8000);
			const panel = page.getByRole("region", { name: "Quarantined tests" });
			await panel.getByText("0 quarantined tests", { exact: true }).waitFor();
			await panel.getByLabel("Test ref").fill("T-1");
			await panel.getByLabel("Quarantine reason").fill("Checkout retries disagree on unchanged code");
			await panel.getByRole("spinbutton", { name: "Passing trunk commits", exact: true }).fill("3");
			await panel.getByRole("button", { name: "Propose quarantine", exact: true }).click();
			await page.getByRole("heading", { name: "Quarantine T-1", exact: true }).waitFor();
			await page.locator(".queue-answers .ans").filter({ hasText: "Accept" }).click();
			await page
				.getByLabel("Reason required by policy")
				.fill("Keep checkout failures visible while the test is repaired");
			await page.getByLabel("Reason required by policy").press("Enter");
			await eventually(
				() => server.api("gate", { commit: "aaaa0001" }),
				(gate) => gate.quarantined === 1,
			);
			for (const [ref, exit, reason] of [
				["T-2", { kind: "person" }, "Review the timeout before restoring its gate"],
				[
					"T-3",
					{ kind: "expiry", at: Date.now() + 7 * 86400000 },
					"Temporary quarantine while the modal test is repaired",
				],
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
			await panel.getByText("3 quarantined tests", { exact: true }).waitFor();
			await panel.getByText("3 consecutive passing trunk commits", { exact: false }).waitFor();
			await panel.getByText("A person's decision", { exact: false }).first().waitFor();
			await panel.getByText("Expires", { exact: false }).waitFor();
			expect(await panel.getByRole("listitem").count()).toBe(3);
			const status = await server.api("gate", { commit: "aaaa0001" });
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
			await panel.getByLabel("Quarantine reason").fill("The test is reliable again");
			await panel.getByRole("button", { name: "Propose ending T-2 quarantine" }).click();
			await panel.getByRole("alert").filter({ hasText: "Quarantine changed" }).waitFor();
			expect(await panel.getByLabel("Quarantine reason").inputValue()).toBe("The test is reliable again");
			expect((await server.api("inbox", { kind: "adopt" })).items).toEqual([]);
			await page.unroute("**/api/p/scratch/find");
			await page.goto(`${server.url}/p/scratch/settings`);
			await panel.getByText("A newer quarantine decision", { exact: true }).waitFor();
			await panel.getByLabel("Quarantine reason").fill("The test is reliable again");
			await panel.getByRole("button", { name: "Propose ending T-2 quarantine" }).click();
			await page.getByRole("heading", { name: "End quarantine T-2", exact: true }).waitFor();
			await page.locator(".queue-answers .ans").filter({ hasText: "Accept" }).click();
			await page.getByLabel("Reason required by policy").fill("The timeout fix has been checked");
			await page.getByLabel("Reason required by policy").press("Enter");
			await eventually(
				() => server.api("gate", { commit: "aaaa0001" }),
				(gate) => gate.verdict === "blocked" && gate.quarantined === 2,
			);
			expect(view.errors).toEqual([]);
		} finally {
			await view?.close();
			await server.stop();
		}
	},
	45000,
);
