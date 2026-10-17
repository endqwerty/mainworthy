import { expect, test } from "bun:test";
import { ReportsReply } from "../../src/core/replies.ts";
import { browserAvailable, openPage, startServer } from "./support.ts";

const check = test.skipIf(!browserAvailable);

check(
	"reports open by keyboard, show real results and refresh when evidence arrives",
	async () => {
		const server = await startServer();
		await server.api("admin", { do: "project.create", key: "second" });
		const browser = await openPage(server);
		try {
			const { page } = browser;
			await page.keyboard.type("gt");
			await page.waitForURL("**/p/scratch/tests");
			await page.keyboard.press("g");
			await page.keyboard.press("p");
			await page.getByRole("region", { name: "Switch project", exact: true }).waitFor();
			expect(await page.getByRole("option").allInnerTexts()).toEqual([
				expect.stringContaining("scratch"),
				expect.stringContaining("second"),
			]);
			await page.keyboard.press("Escape");
			await page.keyboard.press("g");
			await page.keyboard.press("a");
			await page.getByText("No results in this period.", { exact: true }).waitFor();
			await server.api("report", {
				target: { commit: "a".repeat(40) },
				results: [{ test: { key: "checkout" }, outcome: "pass" }],
			});
			await page.getByText("100.0%", { exact: true }).waitFor();
			const cli = Bun.spawn([process.execPath, "src/cli/main.ts", "reports", "--days", "30"], {
				env: {
					...process.env,
					MAINWORTHY_URL: server.url,
					MAINWORTHY_TOKEN: server.token,
					MAINWORTHY_PROJECT: "scratch",
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			const cliOutput = await new Response(cli.stdout).text();
			expect(await cli.exited).toBe(0);
			expect(ReportsReply.parse(JSON.parse(cliOutput)).days.map((row) => row.passRate)).toEqual([1]);
			await browser.context.route("**/api/p/scratch/reports", (route) =>
				route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify({ ok: false, error: { code: "forbidden", message: "Report access ended" } }),
				}),
			);
			await server.api("report", {
				target: { commit: "b".repeat(40) },
				results: [{ test: { key: "second" }, outcome: "pass" }],
			});
			await page.getByText("Report access ended", { exact: true }).waitFor();
			expect(await page.getByText("100.0%", { exact: true }).count()).toBe(0);
			await browser.context.unroute("**/api/p/scratch/reports");
			await server.api("report", {
				target: { commit: "c".repeat(40) },
				results: [{ test: { key: "third" }, outcome: "pass" }],
			});
			await page.getByText("100.0%", { exact: true }).waitFor();
			await page.keyboard.press("j");
			await page.keyboard.press("Enter");
			await page.getByRole("heading", { name: "No cases automated" }).waitFor();
			expect(page.url()).toContain("/reports/automation");
			await page.keyboard.type("gs");
			await page.waitForURL("**/p/scratch/suite");
			let reportReads = 0;
			page.on("request", (request) => {
				if (request.url().endsWith("/api/p/scratch/reports")) reportReads++;
			});
			await server.api("report", {
				target: { commit: "d".repeat(40) },
				results: [{ test: { key: "fourth" }, outcome: "pass" }],
			});
			await page.waitForTimeout(300);
			expect(reportReads).toBe(0);
			await page.keyboard.type("ga");
			await page.getByText("100.0%", { exact: true }).waitFor();
			expect(reportReads).toBe(1);
			expect(browser.errors).toEqual([]);
		} finally {
			await browser.close();
			await server.stop();
		}
	},
	30_000,
);

check(
	"phone reports keep the list and detail separate without horizontal overflow",
	async () => {
		const server = await startServer();
		const browser = await openPage(server, { path: "/p/scratch/reports", device: "phone" });
		try {
			const { page } = browser;
			await page.getByRole("option", { name: "Pass rate over time" }).waitFor();
			await page.keyboard.press("j");
			expect(await page.getByRole("option", { name: "Automation and backlog" }).getAttribute("aria-selected")).toBe(
				"true",
			);
			await page.keyboard.press("Enter");
			await page.getByRole("heading", { name: "No cases automated" }).waitFor();
			await page.getByRole("button", { name: "Back to the list" }).tap();
			await page.getByRole("option", { name: "Time spent on reruns" }).tap();
			await page.getByRole("heading", { name: "0.00 seconds recorded" }).waitFor();
			expect(await page.locator("#app").getAttribute("data-pane")).toBe("detail");
			expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
			await page.getByRole("button", { name: "Back to the list" }).tap();
			expect(await page.locator("#app").getAttribute("data-pane")).toBe("list");
			expect(browser.errors).toEqual([]);
		} finally {
			await browser.close();
			await server.stop();
		}
	},
	30_000,
);
