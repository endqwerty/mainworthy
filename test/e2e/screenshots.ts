import { mkdir } from "node:fs/promises";
import { browserAvailable, openPage, startServer } from "./support.ts";

if (!browserAvailable) {
	console.info("Screenshots skipped: system Chromium is missing.");
	process.exit(0);
}
const server = await startServer({ cases: 2000, days: 14 });
const harness = await openPage(server);
try {
	const run = server.seeded?.run ?? "R-1";
	for (const theme of ["light", "dark"]) {
		const pages = [
			{ name: "suite", path: "/p/scratch/suite" },
			{ name: "case", path: "/p/scratch/suite/c/1" },
			{ name: "queue", path: "/p/scratch/queue" },
			{ name: "runs", path: `/p/scratch/runs/${run.slice(2)}` },
			{ name: "changes", path: "/p/scratch/changes/pr%3A482" },
			{ name: "settings", path: "/p/scratch/settings" },
		];
		for (const item of pages) {
			await harness.page.goto(`${server.url}${item.path}`);
			await harness.page.locator("#app").waitFor();
			await harness.page.evaluate((value) => {
				localStorage.setItem("mainworthy:theme", value);
				document.documentElement.dataset.theme = value;
			}, theme);
			await harness.page.waitForTimeout(300);
			if (item.name === "case") {
				await harness.page.keyboard.press("z");
				await harness.page.getByRole("region", { name: "Case diff" }).first().waitFor();
			}
			await mkdir("docs/ui/screenshots", { recursive: true });
			await harness.page.screenshot({ path: `docs/ui/screenshots/${item.name}-${theme}.png` });
			console.info(`Saved ${item.name} ${theme}`);
		}
	}
	if (harness.errors.length) throw new Error(harness.errors.join("\n"));
} finally {
	await harness.close();
	await server.stop();
}
