import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { browserAvailable, eventually, openPage, startServer } from "./support.ts";

test.skipIf(!browserAvailable)(
	"expanded failure shows the sample diagnostic, trail, files, build and test page",
	async () => {
		const server = await startServer();
		let h: Awaited<ReturnType<typeof openPage>> | undefined;
		try {
			await server.api("report", {
				target: { session: "checkout" },
				buildUrl: "https://example.com/build/42",
				results: [
					{
						test: { key: "checkout", name: "Cart checkout" },
						outcome: "fail",
						failure: {
							message: "expected 10, got 12",
							detail: "Coupon response includes the wrong total\ncheckout.ts:42",
						},
						steps: [
							{
								step: "Apply coupon",
								outcome: "fail",
								durationMs: 700,
								actions: [{ text: "Submit coupon SAVE", outcome: "fail", durationMs: 700 }],
							},
						],
						attachments: [{ name: "trace.txt", data: Buffer.from("checkout diagnostic bytes").toString("base64") }],
					},
				],
			});
			const question = (await server.api("inbox", { kind: "failure" })).items[0];
			if (!question) throw new Error("Expected a failure question");
			h = await openPage(server, { path: `/p/scratch/queue/${question.q.slice(2)}` });
			const { page } = h;
			await page.locator("[data-current-question]").waitFor();
			await page.keyboard.press("Space");
			await page.getByText("Coupon response includes the wrong total", { exact: false }).waitFor();
			expect(await page.getByRole("list", { name: "Step trail" }).innerText()).toContain("Apply coupon");
			expect(await page.getByRole("list", { name: "Step trail" }).innerText()).toContain("Submit coupon SAVE");
			expect(await page.getByRole("link", { name: "build", exact: true }).getAttribute("href")).toBe(
				"https://example.com/build/42",
			);
			const download = page.waitForEvent("download");
			await page.getByRole("button", { name: "Download trace.txt" }).click();
			const file = await download;
			expect(file.suggestedFilename()).toBe("trace.txt");
			const path = await file.path();
			if (!path) throw new Error("Attachment download missing");
			expect(await readFile(path, "utf8")).toBe("checkout diagnostic bytes");
			await page.getByRole("link", { name: "T-1", exact: true }).click();
			await page.waitForURL("**/p/scratch/tests/1");
			await page.locator("#detail .test-title").filter({ hasText: "Cart checkout" }).waitFor();
			await page.goto(`${server.url}/p/scratch/queue/${question.q.slice(2)}`);
			await page.getByRole("button", { name: /Infrastructure/ }).click();
			const settled = await eventually(
				() => server.api("get", { refs: [question.q] }),
				(rows) => rows[0]?.state === "decided",
			);
			expect(settled[0]?.decision).toMatchObject({ answer: { is: "infra" } });
		} finally {
			await h?.close();
			await server.stop();
		}
	},
	30000,
);
