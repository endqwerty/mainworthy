import { afterEach, beforeEach } from "bun:test";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { Browser, BrowserContext } from "playwright-core";
import { type ChromiumDiagnosticState, chromiumDiagnosticPaths } from "../../scripts/chromium-diagnostics.ts";

const browsers = new Set<Browser>();
let executed = 0;
let previousStderr: string | null = null;
function report(
	event: { kind: "state" } | { kind: "crash" | "disconnected"; at: string } = { kind: "state" },
	snapshot = false,
): void {
	const directory = process.env.MAINWORTHY_E2E_DIAGNOSTICS_DIRECTORY;
	if (process.env.MAINWORTHY_E2E_DIAGNOSTICS !== "1" || !directory || browsers.size === 0) return;
	const slot = Number(process.env.BUN_TEST_WORKER_ID ?? "1");
	const paths = chromiumDiagnosticPaths(directory, slot);
	const contexts = [...browsers].flatMap((browser) => browser.contexts());
	let stderr: string | null = null;
	if (snapshot) {
		const tail = existsSync(paths.stderr) ? readFileSync(paths.stderr, "utf8") : "";
		if (tail !== previousStderr) {
			previousStderr = tail;
			stderr = tail;
		}
	}
	const state: ChromiumDiagnosticState = {
		slot,
		file: Bun.main,
		test: executed,
		contexts: contexts.length,
		pages: contexts.reduce((count, context) => count + context.pages().length, 0),
		stderr,
		...event,
	};
	appendFileSync(paths.records, `${JSON.stringify(state)}\n`);
}
try {
	beforeEach(() => {
		executed++;
		report();
	});
	afterEach(() => report({ kind: "state" }, true));
} catch {}

export const browserDiagnostics = {
	connected(browser: Browser): void {
		browsers.add(browser);
		browser.on("disconnected", () => {
			if (browsers.has(browser)) report({ kind: "disconnected", at: new Date().toISOString() }, true);
		});
		report();
	},
	context(context: BrowserContext): void {
		const browser = context.browser();
		if (!browser || !browsers.has(browser)) return;
		context.on("close", () => report());
		context.on("page", (page) => {
			page.on("crash", () => report({ kind: "crash", at: new Date().toISOString() }, true));
			page.on("close", () => report());
			report();
		});
		report();
	},
	clear(): void {
		browsers.clear();
		previousStderr = null;
	},
};
