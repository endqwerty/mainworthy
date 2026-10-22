import { expect, test } from "bun:test";
import { join } from "node:path";
import { browserAvailable, openPage, startServer } from "./support.ts";

(browserAvailable ? test : test.skip)(
	"a merged fast-forward shows the reported gate beside the head's current gate",
	async () => {
		const server = await startServer();
		let view: Awaited<ReturnType<typeof openPage>> | undefined;
		try {
			await server.api("report", {
				target: { commit: "receipt726", branch: "feature", pr: 726, title: "Retry the checkout test" },
				results: [
					{ test: { key: "checkout", name: "Checkout completes" }, outcome: "fail", failure: { message: "Timed out" } },
				],
			});
			const asked = (await server.api("inbox", { kind: "failure" })).items[0];
			if (!asked) throw new Error("Expected a failure question");
			await server.api("decide", { q: asked.q, onEvidence: asked.evidenceHash, answer: { is: "flaky" } });
			expect((await server.api("gate", { change: "pr:726" })).verdict).toBe("passed");
			await server.api("change", {
				change: "pr:726",
				state: "merged",
				head: "receipt726",
				landing: { commit: "receipt726", branch: "main" },
			});
			expect((await server.api("gate", { change: "pr:726" })).verdict).toBe("blocked");
			view = await openPage(server, { path: "/p/scratch/changes/pr%3A726" });
			await view.page.locator(".change-gate h2").getByText("blocked", { exact: true }).waitFor();
			await view.page.getByText("Merged as its head.", { exact: false }).waitFor();
			if (process.env.MAINWORTHY_RECEIPT_SCREENSHOT) {
				await view.page.screenshot({
					path: join(process.env.MAINWORTHY_RECEIPT_SCREENSHOT, "merge-receipt.png"),
					fullPage: true,
				});
			}
			expect(await view.page.locator(".change-merge-receipt").count()).toBe(1);
			const receipt = view.page.locator(".change-merge-receipt");
			expect(await receipt.innerText()).toContain("Head receipt726 when the merge was reported");
			expect(await receipt.innerText()).toContain("passed");
			await receipt.getByText("Counted results", { exact: true }).click();
			expect(await receipt.innerText()).toContain("Checkout completes");
			expect(await receipt.innerText()).toContain("excused");
			expect(view.errors).toEqual([]);
		} finally {
			await view?.close();
			await server.stop();
		}
	},
	30000,
);
