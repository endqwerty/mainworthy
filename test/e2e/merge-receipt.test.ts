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

			expect(await view.page.locator(".change-merge-receipt").count()).toBe(1);
			const receipt = view.page.locator(".change-merge-receipt");
			expect(await receipt.innerText()).toContain("Head receipt726 when the merge was reported");
			expect(await receipt.innerText()).toContain("passed");
			await receipt.getByText("Counted results", { exact: true }).click();
			await receipt.locator(".change-receipt-result").filter({ hasText: "Checkout completes" }).waitFor();
			if (process.env.MAINWORTHY_RECEIPT_SCREENSHOT) {
				await view.page.screenshot({
					path: join(process.env.MAINWORTHY_RECEIPT_SCREENSHOT, "merge-receipt.png"),
					fullPage: true,
				});
			}
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

(browserAvailable ? test : test.skip)(
	"receipt results are requested a page at a time",
	async () => {
		const server = await startServer();
		let view: Awaited<ReturnType<typeof openPage>> | undefined;
		try {
			await server.api("report", {
				target: { commit: "receiptpages726", branch: "feature", pr: 726 },
				results: Array.from({ length: 123 }, (_, i) => ({
					test: { key: `receipt-${i}`, name: `Receipt result ${i}` },
					outcome: "pass",
				})),
			});
			await server.api("change", { change: "pr:726", state: "merged" });
			view = await openPage(server, { path: "/p/scratch/changes/pr%3A726" });
			const receipt = view.page.locator(".change-merge-receipt");
			await receipt.getByText("Counted results", { exact: true }).click();
			await receipt.locator(".change-receipt-result").nth(49).waitFor();
			expect(await receipt.locator(".change-receipt-result").count()).toBe(50);
			await receipt.getByRole("button", { name: "More counted results" }).click();
			await receipt.locator(".change-receipt-result").nth(99).waitFor();
			expect(await receipt.locator(".change-receipt-result").count()).toBe(100);
			await receipt.getByRole("button", { name: "More counted results" }).click();
			await receipt.locator(".change-receipt-result").nth(122).waitFor();
			expect(await receipt.locator(".change-receipt-result").count()).toBe(123);
			expect(await receipt.getByRole("button", { name: "More counted results" }).count()).toBe(0);
			expect(view.errors).toEqual([]);
		} finally {
			await view?.close();
			await server.stop();
		}
	},
	30000,
);
