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
					const next: number[] = [];
					const previous: number[] = [];
					const errors: string[] = [];
					Reflect.set(window, "casebookLatency", { capture, typing, next, previous, errors });
					window.addEventListener(
						"keydown",
						(event) => {
							if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
							if (event.key === "j" || event.key === "k") {
								const current = document.querySelector('#list [role="option"][aria-selected="true"]');
								const neighbor =
									event.key === "j"
										? current?.parentElement?.nextElementSibling
										: current?.parentElement?.previousElementSibling;
								const expected = neighbor?.querySelector(".id")?.textContent;
								const start = performance.now();
								Reflect.set(
									window,
									"navigationPaint",
									new Promise<void>((resolve) => {
										const painted = () => {
											const selected = document.querySelector(
												'#list [role="option"][aria-selected="true"] .id',
											)?.textContent;
											const elapsed = performance.now() - start;
											if (expected && selected !== expected && elapsed < 1000) {
												requestAnimationFrame(painted);
												return;
											}
											if (!expected || selected !== expected)
												errors.push(`${event.key}: expected ${expected}, selected ${selected}`);
											(event.key === "j" ? next : previous).push(elapsed);
											resolve();
										};
										requestAnimationFrame(painted);
									}),
								);
								return;
							}
							if (event.key !== "c") return;
							const start = performance.now();
							requestAnimationFrame(() => {
								const target = document.querySelector('#detail [data-field="title"]');
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
				await page.locator('#list [role="option"][aria-selected="true"]').waitFor();
				for (let i = 0; i < 200; i++) {
					for (const key of ["j", "k"]) {
						await page.keyboard.press(key);
						await page.waitForFunction(
							({ key, count }) => {
								const samples: unknown = Reflect.get(window, "casebookLatency");
								if (!samples || typeof samples !== "object") return false;
								const values =
									key === "j" && "next" in samples ? samples.next : "previous" in samples ? samples.previous : null;
								return Array.isArray(values) && values.length >= count;
							},
							{ key, count: i + 1 },
						);
						await page.evaluate(
							() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
						);
					}
				}
				for (let i = 0; i < 200; i++) {
					await page.keyboard.press("c");
					await page.getByRole("textbox", { name: "Case title" }).waitFor();
					await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
					await page.keyboard.press("Escape");
				}
				await page.keyboard.press("c");
				await page.keyboard.type("Latency sample");
				await page.keyboard.press("Enter");
				for (let i = 0; i < 200; i++) {
					await page.keyboard.press("a");
					await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
				}
				const samples = z
					.object({
						capture: z.array(z.number()),
						typing: z.array(z.number()),
						next: z.array(z.number()),
						previous: z.array(z.number()),
						errors: z.array(z.string()),
					})
					.parse(await page.evaluate(() => Reflect.get(window, "casebookLatency")));
				const capture = samples.capture.slice(0, 200);
				const typing = samples.typing.slice(0, 200);
				expect(capture).toHaveLength(200);
				expect(typing).toHaveLength(200);
				expect(samples.next).toHaveLength(200);
				expect(samples.previous).toHaveLength(200);
				expect(samples.errors).toEqual([]);
				const result = {
					cases,
					capture: { p50: percentile(capture, 0.5), p95: percentile(capture, 0.95) },
					typing: { p50: percentile(typing, 0.5), p95: percentile(typing, 0.95) },
					next: { p50: percentile(samples.next, 0.5), p95: percentile(samples.next, 0.95) },
					previous: { p50: percentile(samples.previous, 0.5), p95: percentile(samples.previous, 0.95) },
				};
				console.info(
					`L1 ${cases}: capture p95=${result.capture.p95.toFixed(1)}ms; typing p95=${result.typing.p95.toFixed(1)}ms; j p95=${result.next.p95.toFixed(1)}ms; k p95=${result.previous.p95.toFixed(1)}ms; 200 samples each.`,
				);
				expect(result.capture.p95).toBeLessThanOrEqual(100);
				expect(result.typing.p95).toBeLessThanOrEqual(100);
				expect(result.next.p95).toBeLessThanOrEqual(100);
				expect(result.previous.p95).toBeLessThanOrEqual(100);
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
				expect(stored?.steps).toMatchObject([{ action: "a".repeat(200) }]);
			} finally {
				await browser.close();
				await server.stop();
			}
		},
		90_000,
	);
}
