import { expect, test } from "bun:test";
import { z } from "zod";
import { browserAvailable, openPage, startServer } from "./support.ts";

/** Measures event-to-next-paint opportunity, with actual caret and changed input checks inside the frame. */
function percentile(values: number[], fraction: number): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? Infinity;
}
for (const cases of [2000, 10000]) {
	test.skipIf(!browserAvailable || (cases === 10000 && process.env.CASEBOOK_SKIP_10K === "1"))(
		`L1 input and virtual scrolling with ${cases.toLocaleString()} real cases`,
		async () => {
			const server = await startServer({ cases });
			const browser = await openPage(server);
			try {
				const { page } = browser;
				await page.waitForFunction(
					(expected) =>
						Number(document.querySelector('[data-testid="case-list"]')?.getAttribute("data-loaded")) >= expected,
					cases,
				);
				expect((await server.api("find", { in: "cases", limit: 1 })).count).toBe(cases);
				await page.evaluate(() => {
					const capture: number[] = [];
					const typing: number[] = [];
					const errors: string[] = [];
					Reflect.set(window, "casebookLatency", { capture, typing, errors });
					window.addEventListener(
						"keydown",
						(event) => {
							if (
								event.key !== "c" ||
								event.target instanceof HTMLInputElement ||
								event.target instanceof HTMLTextAreaElement
							)
								return;
							const start = performance.now();
							requestAnimationFrame(() => {
								const target = document.querySelector('[data-field="capture-title"]');
								if (document.activeElement !== target) errors.push("c did not focus the title on its next frame");
								capture.push(performance.now() - start);
							});
						},
						true,
					);
					window.addEventListener(
						"input",
						(event) => {
							const target = event.target;
							if (!(target instanceof HTMLTextAreaElement) || !target.dataset.field?.endsWith(":action")) return;
							const start = performance.now();
							const value = target.value;
							requestAnimationFrame(() => {
								if (!target.isConnected || target.value !== value) errors.push("typed character was not painted");
								typing.push(performance.now() - start);
							});
						},
						true,
					);
				});
				for (let i = 0; i < 30; i++) {
					await page.keyboard.press("c");
					await page.getByRole("textbox", { name: "Capture title" }).waitFor();
					await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
					await page.keyboard.press("Escape");
				}
				await page.keyboard.press("c");
				await page.keyboard.type("Latency sample");
				await page.keyboard.press("Enter");
				for (let i = 0; i < 30; i++) {
					await page.keyboard.press("a");
					await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
				}
				const samples = z
					.object({ capture: z.array(z.number()), typing: z.array(z.number()), errors: z.array(z.string()) })
					.parse(await page.evaluate(() => Reflect.get(window, "casebookLatency")));
				const capture = samples.capture.slice(0, 30);
				const typing = samples.typing.slice(0, 30);
				expect(capture).toHaveLength(30);
				expect(typing).toHaveLength(30);
				expect(samples.errors).toEqual([]);
				const result = {
					cases,
					capture: { p50: percentile(capture, 0.5), p95: percentile(capture, 0.95) },
					typing: { p50: percentile(typing, 0.5), p95: percentile(typing, 0.95) },
				};
				console.info(
					`L1 ${cases}: capture p50=${result.capture.p50.toFixed(1)}ms p95=${result.capture.p95.toFixed(1)}ms; typing p50=${result.typing.p50.toFixed(1)}ms p95=${result.typing.p95.toFixed(1)}ms; 30 samples each.`,
				);
				expect(result.capture.p95).toBeLessThanOrEqual(100);
				expect(result.typing.p95).toBeLessThanOrEqual(100);
				await page.keyboard.press("Escape");
				const scrolling = await page.evaluate(async (expected) => {
					const list = document.querySelector('[data-testid="case-list"]');
					if (!(list instanceof HTMLElement)) throw new Error("List missing");
					let blankSince: number | null = null;
					let longest = 0;
					let seen = "";
					const destination = Math.min(expected - 24, 5000);
					for (let index = 0; index <= destination; index += 20) {
						list.scrollTop = index * 32;
						await new Promise<void>((resolve) =>
							requestAnimationFrame(() => {
								const rect = list.getBoundingClientRect();
								const present = [...list.querySelectorAll(".row,.capture-row")].filter((row) => {
									const r = row.getBoundingClientRect();
									return r.bottom > rect.top && r.top < rect.bottom;
								});
								const now = performance.now();
								if (present.length === 0) blankSince ??= now;
								else {
									if (blankSince !== null) longest = Math.max(longest, now - blankSince);
									blankSince = null;
									seen = present[0]?.textContent ?? "";
								}
								resolve();
							}),
						);
					}
					if (blankSince !== null) longest = Math.max(longest, performance.now() - blankSince);
					return { longest, scrollTop: list.scrollTop, seen };
				}, cases);
				expect(scrolling.scrollTop).toBeGreaterThan(32 * Math.min(cases - 100, 4900));
				expect(scrolling.seen).toContain("C-");
				expect(scrolling.longest).toBeLessThanOrEqual(100);
				expect(browser.errors).toEqual([]);
				await page.evaluate(() => document.querySelector('[data-testid="case-list"]')?.scrollTo(0, 0));
				const rows = await server.api("find", { in: "cases", text: "Latency sample" });
				expect(rows.items).toHaveLength(1);
				const ref = rows.items[0]?.ref;
				if (typeof ref !== "string") throw new Error("Latency case was never recorded");
				const stored = (await server.api("get", { refs: [ref] }))[0];
				expect(stored?.steps).toMatchObject([{ action: "a".repeat(30) }]);
			} finally {
				await browser.close();
				await server.stop();
			}
		},
		90_000,
	);
}
