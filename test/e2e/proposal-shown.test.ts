import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Page } from "playwright-core";
import { z } from "zod";
import { browserAvailable, eventually, openPage, type Server, startServer } from "./support.ts";

const t = browserAvailable ? test : test.skip;

async function agentToken(server: Server): Promise<string> {
	return z.object({ token: z.string() }).parse(
		await server.api("admin", {
			do: "token.create",
			actor: "writer",
			kind: "agent",
			can: ["read", "produce"],
			project: "scratch",
		}),
	).token;
}
const longTitle = (i: number) =>
	`Proposed case ${i + 1} ${"with a long title that wraps across the evidence column when it is narrow ".repeat(3)}`;

/** Records, every frame, whether the last edit's bottom has been inside every clipping ancestor and the window. */
async function trackLast(page: Page, q: string): Promise<void> {
	await page.evaluate((q) => {
		const w = window as unknown as { lastSeen: boolean };
		w.lastSeen = false;
		const tick = () => {
			const ev = document.querySelector<HTMLElement>(`[data-proposal-evidence="${CSS.escape(q)}"]`);
			const last = ev?.lastElementChild as HTMLElement | null;
			if (last) {
				const box = last.getBoundingClientRect();
				let top = 0;
				let bottom = window.innerHeight;
				for (let el: HTMLElement | null = last.parentElement; el; el = el.parentElement) {
					const style = getComputedStyle(el);
					if (style.overflowY !== "visible") {
						const r = el.getBoundingClientRect();
						top = Math.max(top, r.top);
						bottom = Math.min(bottom, r.bottom);
					}
				}
				if (box.bottom <= bottom + 1 && box.bottom > top) w.lastSeen = true;
			}
			requestAnimationFrame(tick);
		};
		tick();
	}, q);
}
const lastSeen = (page: Page) => page.evaluate(() => (window as unknown as { lastSeen: boolean }).lastSeen);
const frames = (page: Page) =>
	page.evaluate(
		() =>
			new Promise<void>((r) =>
				requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
			),
	);
const openAdopt = async (server: Server) => (await server.api("inbox", { kind: "adopt" })).items.map((q) => q.q);

/** An unread press finishes by revealing evidence; a ready press finishes with the server's decision. */
async function advanceProposal(page: Page, q: string, press: () => Promise<unknown>): Promise<boolean> {
	const evidence = page.locator(`[data-proposal-evidence="${q}"][data-proposal-loaded="true"]`);
	await evidence.waitFor();
	await frames(page);
	if ((await evidence.getAttribute("data-proposal-read")) === "ready") {
		const decided = page.waitForResponse((response) => response.url().endsWith("/decide"));
		await press();
		const response = await decided;
		expect(response.ok()).toBe(true);
		await response.finished();
		return true;
	}
	const decided = page
		.waitForResponse((response) => response.url().endsWith("/decide"))
		.then(async (response) => {
			expect(response.ok()).toBe(true);
			await response.finished();
			return true;
		});
	const paged = page
		.locator("#stat")
		.filter({ hasText: new RegExp(`${q} (has unread edits|is now in view)`) })
		.waitFor()
		.then(() => false);
	await press();
	if (await Promise.race([decided, paged])) return true;
	await frames(page);
	return await Promise.race([
		decided,
		page
			.locator(
				`[data-proposal-evidence="${q}"][data-proposal-read="loaded"], [data-proposal-evidence="${q}"][data-proposal-read="ready"]`,
			)
			.waitFor()
			.then(() => false),
	]);
}

/** Samples actual visible pixels independently of the proposal's read state. Reflow resets each part. */
async function trackPartCoverage(page: Page, q: string): Promise<void> {
	await page.addInitScript((q) => {
		type Part = { height: number; width: number; rows: number; seen: Uint8Array };
		let evidence: Element | null = null;
		const parts = new Map<HTMLElement, Part>();
		Object.defineProperty(window, "mainworthyPartCoverage", {
			get: () => ({
				parts: parts.size,
				unseen: [...parts.values()].reduce((n, part) => n + part.seen.reduce((sum, cell) => sum + 1 - cell, 0), 0),
			}),
		});
		const tick = () => {
			const current = document.querySelector(`[data-proposal-evidence="${CSS.escape(q)}"]`);
			if (current && current !== evidence) {
				evidence = current;
				parts.clear();
			}
			if (current?.getAttribute("data-proposal-loaded") === "true") {
				for (const element of current.querySelectorAll<HTMLElement>("p, .dl, li")) {
					const box = element.getBoundingClientRect();
					const width = Math.max(box.width, element.scrollWidth);
					let part = parts.get(element);
					if (!part || Math.abs(part.height - box.height) > 0.5 || Math.abs(part.width - width) > 0.5) {
						const rows = Math.max(1, Math.ceil(box.height / 12));
						part = { height: box.height, width, rows, seen: new Uint8Array(rows * 5) };
						parts.set(element, part);
					}
					for (let row = 0; row < part.rows; row++) {
						const y = box.top + ((row + 0.5) / part.rows) * box.height;
						if (y < 0 || y >= innerHeight) continue;
						for (let column = 0; column < 5; column++) {
							const cell = row * 5 + column;
							if (part.seen[cell]) continue;
							const x = box.left + ((column + 0.5) / 5) * width;
							if (x < 0 || x >= innerWidth) continue;
							const hit = document.elementFromPoint(x, y);
							if (hit && element.contains(hit)) part.seen[cell] = 1;
						}
					}
				}
			}
			requestAnimationFrame(tick);
		};
		tick();
	}, q);
}

const partCoverage = async (page: Page) =>
	z
		.object({ parts: z.number(), unseen: z.number() })
		.parse(await page.evaluate((): unknown => Reflect.get(window, "mainworthyPartCoverage")));

describe("short evidence layouts", () => {
	let server: Server;
	let q: string;
	beforeAll(async () => {
		if (!browserAvailable) return;
		server = await startServer({ preset: "standard", seed: false });
		const token = await agentToken(server);
		const proposed = await server.api("propose", { edits: [{ op: "create", outline: "One case" }] }, { token });
		q = proposed.question ?? "";
	});
	afterAll(async () => {
		await server?.stop();
	});
	for (const [device, width, height] of [
		["phone", 390, 844],
		["phone", 390, 360],
		["desktop", 700, 844],
	] as const)
		t(
			`${device} Queue at ${width}x${height} fits short evidence without extra space`,
			async () => {
				let view: Awaited<ReturnType<typeof openPage>> | null = null;
				try {
					view = await openPage(server, {
						path: "/p/scratch/queue",
						device,
						setup: async (page) => page.setViewportSize({ width, height }),
					});
					const { page } = view;
					if (device === "phone") await page.locator("#list [role=option]").first().tap();
					await page.locator(`[data-proposal-evidence="${q}"][data-proposal-loaded="true"]`).waitFor();
					await frames(page);
					const minimum = await page.locator(".queue-evidence").evaluate((area) => getComputedStyle(area).minHeight);
					expect(minimum).toBe("0px");
					if (device === "desktop") {
						const fits = await page.locator("#detail").evaluate((pane) => {
							const footer = pane.querySelector(".queue-last");
							return (
								pane.scrollHeight <= pane.clientHeight &&
								footer !== null &&
								footer.getBoundingClientRect().bottom <= pane.getBoundingClientRect().bottom
							);
						});
						expect(fits).toBe(true);
					}
					expect(view.errors).toEqual([]);
				} finally {
					await view?.close();
				}
			},
			30000,
		);
});

describe("desktop rejection layouts", () => {
	let server: Server;
	let token: string;
	beforeAll(async () => {
		if (!browserAvailable) return;
		server = await startServer({ preset: "standard", seed: false });
		token = await agentToken(server);
	});
	afterAll(async () => {
		await server?.stop();
	});
	for (const [width, height] of [
		[1100, 260],
		[1100, 500],
		[1280, 180],
		[700, 300],
		[1100, 220],
	] as const)
		for (const via of ["click", "key"] as const)
			t(
				`desktop Queue at ${width}x${height} pages all evidence by ${via} before rejecting`,
				async () => {
					let view: Awaited<ReturnType<typeof openPage>> | null = null;
					try {
						const proposed = await server.api(
							"propose",
							{
								edits: [
									{ op: "create", outline: `${longTitle(0)}\n  ${"Read the next word ".repeat(80)} > It works` },
									...Array.from({ length: 10 }, (_, i) => ({ op: "create" as const, outline: longTitle(i + 1) })),
								],
							},
							{ token },
						);
						const q = proposed.question ?? "";
						view = await openPage(server, {
							path: "/p/scratch/queue",
							setup: async (page) => {
								await page.setViewportSize({ width, height });
								await trackPartCoverage(page, q);
							},
						});
						const { page } = view;
						const expectPageInPlace = async () =>
							expect(
								await page.locator("#app").evaluate((app) => ({
									scrollY: window.scrollY,
									top: app.getBoundingClientRect().top,
								})),
							).toEqual({ scrollY: 0, top: 0 });
						const reject = page.locator(".queue-answers").getByRole("button", { name: "Reject", exact: false });
						const evidence = page.locator(`[data-proposal-evidence="${q}"][data-proposal-loaded="true"]`);
						await evidence.waitFor();
						await page.locator("#detail").evaluate((pane) => {
							pane.scrollTop = pane.scrollHeight;
						});
						await frames(page);
						expect(await evidence.getAttribute("data-proposal-read")).toBe("loaded");
						for (
							let presses = 0;
							presses < 120 && (await evidence.getAttribute("data-proposal-read")) !== "ready";
							presses++
						) {
							if (via === "click") await reject.click();
							else await page.keyboard.press("r");
							await frames(page);
							await expectPageInPlace();
							expect(await openAdopt(server)).toEqual([q]);
						}
						await expectPageInPlace();
						expect({
							read: await evidence.getAttribute("data-proposal-read"),
							...(await partCoverage(page)),
						}).toMatchObject({ read: "ready", unseen: 0 });
						expect((await partCoverage(page)).parts).toBeGreaterThan(11);
						const decided = page.waitForResponse((reply) => reply.url().endsWith("/decide"));
						if (via === "click") await reject.click();
						else await page.keyboard.press("r");
						expect((await decided).ok()).toBe(true);
						expect((await server.api("get", { refs: [q] }))[0]?.decision).toMatchObject({ answer: { is: "reject" } });
						await expectPageInPlace();
						expect(view.errors).toEqual([]);
					} finally {
						await view?.close();
					}
				},
				30000,
			);
});

describe("clipped evidence layouts", () => {
	let server: Server;
	let token: string;
	beforeAll(async () => {
		if (!browserAvailable) return;
		server = await startServer({ preset: "standard", seed: false });
		token = await agentToken(server);
		await server.api("propose", { edits: [{ op: "create", outline: "Original case" }] });
	});
	afterAll(async () => {
		await server?.stop();
	});
	for (const [device, width, height] of [
		["phone", 390, 360],
		["phone", 844, 340],
		["phone", 667, 320],
		["desktop", 1100, 240],
	] as const)
		for (const edge of ["top", "bottom"] as const)
			t(
				`${device} ${width}x${height} pages evidence clipped by the pane's ${edge}`,
				async () => {
					let view: Awaited<ReturnType<typeof openPage>> | null = null;
					try {
						const proposed = await server.api(
							"propose",
							{
								edits: [
									{ op: "edit", case: "C-1", base: 1, body: { title: "Changed case" } },
									...Array.from({ length: 20 }, (_, i) => ({ op: "create" as const, outline: `Extra case ${i}` })),
								],
							},
							{ token },
						);
						const q = proposed.question ?? "";
						view = await openPage(server, {
							path: "/p/scratch/suite/c/1",
							device,
							setup: async (page) => {
								await page.setViewportSize({ width, height });
								await trackPartCoverage(page, q);
							},
						});
						const { page } = view;
						const evidence = page.locator(`[data-proposal-evidence="${q}"][data-proposal-loaded="true"]`);
						await evidence.waitFor();
						if (width === 390)
							await page.locator("#bar").evaluate((bar) => {
								bar.style.fontFamily = "monospace";
							});
						const clipped = await evidence.evaluate((element, edge) => {
							const pane = element.closest<HTMLElement>(".pane-scroll");
							if (!pane) throw new Error("Missing case pane");
							const frame = pane.getBoundingClientRect();
							pane.scrollTop +=
								element.getBoundingClientRect().top - (edge === "top" ? frame.top - 40 : frame.bottom - 40);
							const box = element.getBoundingClientRect();
							return edge === "top" ? box.top < frame.top : box.top < frame.bottom && box.bottom > frame.bottom;
						}, edge);
						expect(clipped).toBe(true);
						await frames(page);
						expect(await evidence.getAttribute("data-proposal-read")).toBe("loaded");
						for (
							let presses = 0;
							presses < 80 && (await evidence.getAttribute("data-proposal-read")) !== "ready";
							presses++
						) {
							await page.keyboard.press("r");
							await frames(page);
							expect(await openAdopt(server)).toEqual([q]);
							if (presses === 0)
								expect(
									await evidence.evaluate((element) => {
										const card = element.closest("[data-proposal]");
										const pane = element.closest(".pane-scroll");
										return card && pane && card.getBoundingClientRect().height > pane.getBoundingClientRect().height;
									}),
								).toBe(true);
						}
						expect(await evidence.getAttribute("data-proposal-read")).toBe("ready");
						expect(await partCoverage(page)).toEqual({ parts: 42, unseen: 0 });
						const response = page.waitForResponse((reply) => reply.url().endsWith("/decide"));
						await page.keyboard.press("r");
						await response;
						expect((await server.api("get", { refs: [q] }))[0]?.decision).toMatchObject({ answer: { is: "reject" } });
						expect((await server.api("get", { refs: ["C-1"] }))[0]).toMatchObject({
							title: "Original case",
							version: 1,
						});
						expect(view.errors).toEqual([]);
					} finally {
						await view?.close();
					}
				},
				30000,
			);
});

describe("short case layouts", () => {
	let server: Server;
	let token: string;
	beforeAll(async () => {
		if (!browserAvailable) return;
		server = await startServer({ preset: "standard", seed: false });
		token = await agentToken(server);
		await server.api("propose", { edits: [{ op: "create", outline: "Original case" }] });
	});
	afterAll(async () => {
		await server?.stop();
	});
	for (const device of ["desktop", "phone"] as const)
		t(
			`${device} short case window pages on every answer press without moving the outer pane`,
			async () => {
				let view: Awaited<ReturnType<typeof openPage>> | null = null;
				try {
					const proposed = await server.api(
						"propose",
						{
							edits: [
								{ op: "edit", case: "C-1", base: 1, body: { title: "Changed case" } },
								...Array.from({ length: 20 }, (_, i) => ({ op: "create" as const, outline: `Extra case ${i}` })),
							],
						},
						{ token },
					);
					const q = proposed.question ?? "";
					view = await openPage(server, {
						path: "/p/scratch/suite/c/1",
						device,
						setup: async (page) => {
							await page.setViewportSize(
								device === "phone" ? { width: 390, height: 360 } : { width: 1100, height: 420 },
							);
							await trackPartCoverage(page, q);
						},
					});
					const { page } = view;
					const evidence = page.locator(`[data-proposal-evidence="${q}"]`);
					await page.locator(`[data-proposal-evidence="${q}"][data-proposal-loaded="true"]`).waitFor();
					if (device === "phone") {
						// Wider system fonts wrap the paging status and reduce the height left for the card.
						await page.locator("#bar").evaluate((bar) => {
							bar.style.fontFamily = "monospace";
						});
					}
					await page.keyboard.press("r");
					await frames(page);
					const pane = page.locator(".pane-scroll");
					const cardHeight = await page
						.locator(`[data-proposal="${q}"]`)
						.evaluate((card) => card.getBoundingClientRect().height);
					if (device === "desktop")
						expect(await pane.evaluate((element) => element.clientHeight)).toBeGreaterThan(cardHeight + 8);
					const outerTop = await pane.evaluate((element) => element.scrollTop);
					for (
						let presses = 0;
						presses < 60 && (await evidence.getAttribute("data-proposal-read")) !== "ready";
						presses++
					) {
						const before = await evidence.evaluate((element) => element.scrollTop);
						if (presses === 1) {
							await pane.evaluate((element) => {
								element.scrollTop = 0;
							});
							await frames(page);
							const cardTop = await page
								.locator(`[data-proposal="${q}"]`)
								.evaluate((card) => card.getBoundingClientRect().top);
							expect(cardTop).toBeGreaterThanOrEqual(
								await pane.evaluate((element) => element.getBoundingClientRect().bottom),
							);
						}
						await page.keyboard.press("r");
						await frames(page);
						if (device === "desktop")
							expect(await pane.evaluate((element) => element.scrollTop)).toBeCloseTo(outerTop, 0);
						else expect(await pane.evaluate((element) => element.scrollTop)).toBeGreaterThanOrEqual(outerTop);
						if (device === "desktop")
							expect(await evidence.evaluate((element) => element.scrollTop)).toBeGreaterThan(before);
						else
							expect(
								(await evidence.evaluate((element) => element.scrollTop)) +
									(await pane.evaluate((element) => element.scrollTop)),
							).toBeGreaterThan(before + (presses === 1 ? 0 : outerTop));
						expect(await openAdopt(server)).toEqual([q]);
						if (device === "phone") {
							expect(await page.locator("#bar").evaluate((bar) => bar.clientHeight)).toBeGreaterThan(28);
							expect(await pane.evaluate((element) => element.clientHeight)).toBeLessThan(cardHeight);
						}
					}
					expect(await evidence.getAttribute("data-proposal-read")).toBe("ready");
					expect(await partCoverage(page)).toEqual({ parts: 42, unseen: 0 });
					await pane.evaluate((element) => {
						element.scrollTop = 0;
					});
					await frames(page);
					await page.keyboard.press("r");
					await frames(page);
					expect(await openAdopt(server)).toEqual([q]);
					expect(await page.locator("#stat").innerText()).toBe(`${q} is now in view. Read it, then press r again.`);
					const response = page.waitForResponse((reply) => reply.url().endsWith("/decide"));
					await page.keyboard.press("r");
					await response;
					expect((await server.api("get", { refs: [q] }))[0]?.decision).toMatchObject({ answer: { is: "reject" } });
					expect((await server.api("get", { refs: ["C-1"] }))[0]).toMatchObject({ title: "Original case", version: 1 });
					expect(view.errors).toEqual([]);
				} finally {
					await view?.close();
				}
			},
			60000,
		);
});

for (const [device, fractional] of [
	["desktop", false],
	["phone", false],
	["phone", true],
] as const)
	t(
		`${device} Queue keeps a partly shown short step unread before accepting${fractional ? " with a fractional pane height" : ""}`,
		async () => {
			const server = await startServer({ mode: "local", preset: "standard" });
			let view: Awaited<ReturnType<typeof openPage>> | null = null;
			try {
				const token = await agentToken(server);
				const proposed = await server.api(
					"propose",
					{
						edits: Array.from({ length: 8 }, (_, i) => ({
							op: "create" as const,
							outline: `Case ${i}\n  ${Array.from({ length: device === "phone" ? 55 : 175 }, (_, j) => `s${i}x${j}`).join(" ")} > ok`,
						})),
					},
					{ token },
				);
				const q = proposed.question ?? "";
				view = await openPage(server, {
					path: "/p/scratch/queue",
					device,
					setup: async (page) => {
						await page.setViewportSize(device === "phone" ? { width: 390, height: 360 } : { width: 1000, height: 800 });
						if (fractional)
							await page.addInitScript(() => {
								// Set the geometry before any evidence can be measured or painted.
								const observer = new MutationObserver(() => {
									const pane = document.getElementById("detail");
									if (!pane) return;
									pane.style.height = "200.6px";
									observer.disconnect();
								});
								observer.observe(document, { childList: true, subtree: true });
							});
						await trackPartCoverage(page, q);
					},
				});
				const page = view.page;
				if (device === "phone") await page.locator("#list [role=option]").first().tap();
				await page.locator(`[data-proposal-evidence="${q}"][data-proposal-loaded="true"]`).waitFor();
				await frames(page);
				if (device === "desktop") {
					// A scrollbar jump shows only the bottom of a row shorter than the evidence area.
					const geometry = await page.locator(".queue-evidence").evaluate((area) => {
						const row = area.querySelectorAll(".dl")[7];
						if (!row) throw new Error("The proposal's eighth diff row is missing");
						const box = row.getBoundingClientRect();
						const top = area.getBoundingClientRect().top;
						area.scrollTop += box.bottom - top - 3;
						return { row: box.height, area: area.clientHeight, bottom: row.getBoundingClientRect().bottom - top };
					});
					expect(geometry.row).toBeGreaterThan(geometry.area / 2);
					expect(geometry.row).toBeLessThan(geometry.area);
					expect(geometry.bottom).toBeCloseTo(3, 0);
					await frames(page);
					await page.locator(".queue-evidence").evaluate((area) => {
						area.scrollTop = 0;
					});
					await frames(page);
				}
				const accept = page.locator(".queue-answers").getByRole("button", { name: "Accept", exact: false });
				let answered = false;
				for (let presses = 0; presses < 40; presses++) {
					const before = await partCoverage(page);
					expect(before.parts).toBe(24);
					answered = await advanceProposal(page, q, () =>
						device === "phone" ? accept.tap() : page.keyboard.press("a"),
					);
					if (before.unseen > 0) {
						expect(answered).toBe(false);
						expect(await openAdopt(server)).toEqual([q]);
					}
					if (answered) {
						expect(before.unseen).toBe(0);
						expect(await partCoverage(page)).toEqual({ parts: 24, unseen: 0 });
						answered = true;
						break;
					}
				}
				expect(answered).toBe(true);
				await eventually(
					() => openAdopt(server),
					(open) => !open.includes(q),
				);
				expect((await server.api("get", { refs: ["C-8"] }))[0]?.title).toBe("Case 7");
				expect(view.errors).toEqual([]);
			} finally {
				await view?.close();
				await server.stop();
			}
		},
		120000,
	);

t(
	"Queue keeps unseen edits unread after widening the window",
	async () => {
		const server = await startServer({ mode: "local", preset: "standard" });
		let view: Awaited<ReturnType<typeof openPage>> | null = null;
		try {
			const token = await agentToken(server);
			const proposed = await server.api(
				"propose",
				{ edits: Array.from({ length: 250 }, (_, i) => ({ op: "create" as const, outline: longTitle(i) })) },
				{ token },
			);
			const q = proposed.question ?? "";
			view = await openPage(server, { path: "/p/scratch/queue" });
			const page = view.page;
			const decides: string[] = [];
			page.on("request", (request) => {
				if (request.url().endsWith("/decide")) decides.push(request.url());
			});
			await page.setViewportSize({ width: 1000, height: 800 });
			await page.locator(`[data-proposal-evidence="${q}"][data-proposal-loaded="true"]`).waitFor();
			await trackLast(page, q);
			const area = page.locator(".queue-evidence");
			const narrow = await area.evaluate((a) => a.scrollHeight);
			// Scroll gradually through three quarters of the narrow content.
			for (let i = 0; i < 400; i++) {
				const done = await area.evaluate((a) => {
					a.scrollTop += a.clientHeight / 2;
					return a.scrollTop + a.clientHeight >= a.scrollHeight * 0.75;
				});
				await frames(page);
				if (done) break;
			}
			await page.setViewportSize({ width: 2400, height: 800 });
			await frames(page);
			const wide = await area.evaluate((a) => a.scrollHeight);
			expect(wide).toBeLessThan(narrow);
			console.log(
				"PROBE resize scrollHeight narrow",
				narrow,
				"wide",
				wide,
				"lastSeen before press",
				await lastSeen(page),
			);
			const seenBefore = await lastSeen(page);
			expect(await advanceProposal(page, q, () => page.keyboard.press("a"))).toBe(false);
			expect(decides).toEqual([]);
			const open = await openAdopt(server);
			const status = await page.locator("[role=status]").allTextContents();
			console.log("PROBE resize open after press", open, "status", status.slice(0, 3));
			expect(seenBefore).toBe(false);
			expect(open).toEqual([q]);
			expect(view.errors).toEqual([]);
		} finally {
			await view?.close();
			await server.stop();
		}
	},
	90000,
);

t(
	"phone Queue accepts after its page has shown every edit",
	async () => {
		const server = await startServer({ mode: "local", preset: "standard" });
		let view: Awaited<ReturnType<typeof openPage>> | null = null;
		try {
			const token = await agentToken(server);
			const proposed = await server.api(
				"propose",
				{ edits: Array.from({ length: 30 }, (_, i) => ({ op: "create", outline: `Short case ${i + 1}` })) },
				{ token },
			);
			const q = proposed.question ?? "";
			view = await openPage(server, { path: "/p/scratch/queue", device: "phone" });
			const page = view.page;

			await page.locator("#list [role=option]").first().tap();
			console.log("PROBE phone", "layout", await page.evaluate(() => document.documentElement.dataset.layout));
			await page.locator(`[data-proposal-evidence="${q}"][data-proposal-loaded="true"]`).waitFor();
			await trackLast(page, q);
			const accept = page.locator(".queue-answers").getByRole("button", { name: "Accept", exact: false });
			const scroller = await page.evaluate(() => {
				const d = document.querySelector<HTMLElement>("#detail");
				const e = document.querySelector<HTMLElement>(".queue-evidence");
				return {
					detail: d ? [d.scrollHeight, d.clientHeight, getComputedStyle(d).overflowY] : null,
					evidence: e ? [e.scrollHeight, e.clientHeight, getComputedStyle(e).overflowY] : null,
				};
			});
			console.log("PROBE phone", "scrollers", JSON.stringify(scroller));
			// Skipping the middle cannot answer. The same tap brings the first unread edit into the phone's page.
			const detail = page.locator("#detail");
			const skipped = await detail.evaluate((area) => {
				area.scrollTop = area.scrollHeight;
				return area.scrollTop;
			});
			await frames(page);
			await accept.tap();
			await frames(page);
			expect(await openAdopt(server)).toEqual([q]);
			expect(await detail.evaluate((area) => area.scrollTop)).toBeLessThan(skipped);

			// A person scrolls the page gradually down to the answers.
			for (let i = 0; i < 200; i++) {
				const done = await page.evaluate(() => {
					const d = document.querySelector<HTMLElement>("#detail") as HTMLElement;
					d.scrollTop += d.clientHeight / 3;
					return d.scrollTop + d.clientHeight >= d.scrollHeight - 2;
				});
				await frames(page);
				if (done) break;
			}
			console.log("PROBE phone", "lastSeen after scrolling", await lastSeen(page));
			const statuses: string[] = [];
			let answered = false;
			for (let i = 0; i < 40; i++) {
				answered = await advanceProposal(page, q, () => accept.tap());
				statuses.push((await page.locator("[role=status]").allTextContents()).join(" | "));
				if (answered) break;
				expect(await openAdopt(server)).toEqual([q]);
			}
			console.log("PROBE phone", "answered after taps", answered, "taps", statuses.length);
			expect(await lastSeen(page)).toBe(true);
			expect(answered).toBe(true);
			await eventually(
				() => openAdopt(server),
				(open) => !open.includes(q),
			);
			await eventually(
				() => openAdopt(server),
				(open) => !open.includes(q),
			);
			expect((await server.api("get", { refs: ["C-30"] }))[0]?.title).toBe("Short case 30");
			expect(view.errors).toEqual([]);
		} finally {
			await view?.close();
			await server.stop();
		}
	},
	90000,
);

t(
	"case cards keep unseen edits unread after widening the window",
	async () => {
		const server = await startServer({ mode: "local", preset: "standard" });
		let view: Awaited<ReturnType<typeof openPage>> | null = null;
		try {
			await server.api("propose", { edits: [{ op: "create", outline: "Checkout" }] });
			const token = await agentToken(server);
			const proposed = await server.api(
				"propose",
				{
					edits: [
						{ op: "edit", case: "C-1", base: 1, body: { title: "Checkout renamed" } },
						...Array.from({ length: 249 }, (_, i) => ({ op: "create" as const, outline: longTitle(i) })),
					],
				},
				{ token },
			);
			const q = proposed.question ?? "";
			view = await openPage(server, { path: "/p/scratch/suite/c/1" });
			const page = view.page;
			await page.setViewportSize({ width: 1100, height: 800 });
			const decides: string[] = [];
			page.on("request", (r) => {
				if (r.url().endsWith("/decide")) decides.push(r.url());
			});
			await page.locator(`[data-proposal-evidence="${q}"][data-proposal-loaded="true"]`).waitFor();
			await trackLast(page, q);
			const accept = page.locator(`[data-proposal="${q}"]`).getByRole("button", { name: "Accept" });
			const edits = page.locator(`[data-proposal-evidence="${q}"]`);
			await accept.click();
			await accept.click();
			await edits.evaluate((e) => {
				e.scrollTop = e.scrollHeight;
			});
			await frames(page);
			await accept.click();
			await page.keyboard.press("a");
			await page
				.locator("#stat")
				.filter({ hasText: `${q} has unread edits` })
				.waitFor();
			await frames(page);
			console.log("PROBE card decides after immediate/jump", decides.length);
			expect(decides).toEqual([]);
			// Read three fifths of the content gradually, then widen.
			await edits.evaluate((e) => {
				e.scrollTop = 0;
			});
			await page.reload();
			await page.locator(`[data-proposal-evidence="${q}"][data-proposal-loaded="true"]`).waitFor();
			await trackLast(page, q);
			await accept.click(); // brings card into view
			const narrow = await edits.evaluate((e) => e.scrollHeight);
			for (let i = 0; i < 800; i++) {
				const done = await edits.evaluate((e) => {
					e.scrollTop += e.clientHeight / 2;
					return e.scrollTop + e.clientHeight >= e.scrollHeight * 0.6;
				});
				await frames(page);
				if (done) break;
			}
			await page.setViewportSize({ width: 2400, height: 800 });
			await frames(page);
			const wide = await edits.evaluate((e) => e.scrollHeight);
			expect(wide).toBeLessThan(narrow);
			const seen = await lastSeen(page);
			await accept.click();
			await page
				.locator("#stat")
				.filter({ hasText: `${q} has unread edits` })
				.waitFor();
			await frames(page);
			expect(decides).toEqual([]);
			console.log(
				"PROBE card resize narrow",
				narrow,
				"wide",
				wide,
				"lastSeen",
				seen,
				"decides",
				decides.length,
				decides.length && !seen ? "ANSWERED UNSHOWN" : "held",
			);
			expect(seen).toBe(false);
			expect(await openAdopt(server)).toEqual([q]);
			expect((await server.api("get", { refs: ["C-1"] }))[0]?.title).toBe("Checkout");
			expect(view.errors).toEqual([]);
		} finally {
			await view?.close();
			await server.stop();
		}
	},
	120000,
);

t(
	"proposal paging restarts across a write without browser errors and resets changed evidence",
	async () => {
		const server = await startServer({ mode: "local", preset: "standard" });
		let view: Awaited<ReturnType<typeof openPage>> | null = null;
		try {
			await server.api("propose", { edits: [{ op: "create", outline: "Checkout\n  Step > Result" }] });
			const token = await agentToken(server);
			const proposed = await server.api(
				"propose",
				{
					edits: [
						...Array.from({ length: 249 }, (_, i) => ({ op: "create" as const, outline: `Live case ${i + 1}` })),
						{ op: "edit", case: "C-1", base: 1, body: { title: "Checkout renamed" } },
					],
				},
				{ token },
			);
			const q = proposed.question ?? "";
			let holdPage2 = false;
			let cursorHeld = false;
			let cursorDelivered = false;
			let release = () => {};
			const held = new Promise<void>((r) => {
				release = r;
			});
			const page2Statuses: number[] = [];
			view = await openPage(server, {
				path: "/p/scratch/queue",
				setup: async (page) => {
					await page.addInitScript(() => {
						const Source = window.EventSource;
						Reflect.set(window, "proposalStreamEvents", 0);
						window.EventSource = class extends Source {
							constructor(url: string | URL, options?: EventSourceInit) {
								super(url, options);
								this.addEventListener("message", () =>
									Reflect.set(window, "proposalStreamEvents", Number(Reflect.get(window, "proposalStreamEvents")) + 1),
								);
							}
						};
					});
					await page.route("**/get", async (route) => {
						const input = z.object({ cursor: z.string().optional() }).parse(route.request().postDataJSON());
						let wasHeld = false;
						if (input.cursor && holdPage2) {
							holdPage2 = false;
							cursorHeld = true;
							wasHeld = true;
							await held;
						}
						const reply = await route.fetch();
						if (input.cursor) page2Statuses.push(reply.status());
						await route.fulfill({ response: reply });
						if (wasHeld) cursorDelivered = true;
					});
				},
			});
			const page = view.page;
			const decides: string[] = [];
			page.on("request", (r) => {
				if (r.url().endsWith("/decide")) decides.push(r.url());
			});
			const ev = page.locator(`[data-proposal-evidence="${q}"]`);
			await page.locator(`[data-proposal-evidence="${q}"][data-proposal-loaded="true"]`).waitFor();
			for (let i = 0; i < 10; i++) await page.keyboard.press("a");
			const covered = await page.locator(".queue-evidence").evaluate((a) => a.scrollTop);
			// An unrelated write: the page reads again; the same edits stay read up to where they were.
			holdPage2 = true;
			await server.api("propose", { edits: [{ op: "create", outline: "Unrelated" }] });
			await eventually(async () => cursorHeld, Boolean);
			const events = await page.evaluate(() => Number(Reflect.get(window, "proposalStreamEvents")));
			// While page 2 is held, a further write changes the project sequence.
			await server.api("propose", { edits: [{ op: "create", outline: "Unrelated 2" }] });
			await page.waitForFunction((seen) => Number(Reflect.get(window, "proposalStreamEvents")) > seen, events);
			release();
			await eventually(async () => cursorDelivered, Boolean);
			await page.locator(`[data-proposal-evidence="${q}"][data-proposal-loaded="true"]`).waitFor();
			console.log(
				"PROBE live page2 statuses",
				JSON.stringify(page2Statuses),
				"read",
				await ev.getAttribute("data-proposal-read"),
				"loaded",
				await ev.getAttribute("data-proposal-loaded"),
				"error",
				await ev.getAttribute("data-proposal-error"),
			);
			await page.locator(`[data-proposal-evidence="${q}"][data-proposal-loaded="true"]`).waitFor();
			expect(await page.locator(".queue-evidence").evaluate((a) => a.scrollTop)).toBe(covered);
			console.log(
				"PROBE live scrollTop before",
				covered,
				"after",
				await page.locator(".queue-evidence").evaluate((a) => a.scrollTop),
			);
			// Read to the end, then a person edits C-1: the last edit's rendering changes and reading starts over.
			const atEnd = () =>
				page.locator(".queue-evidence").evaluate((a) => a.scrollTop + a.clientHeight >= a.scrollHeight - 2);
			for (let i = 0; i < 200 && !(await atEnd()) && (await ev.getAttribute("data-proposal-read")) !== "ready"; i++)
				await page.keyboard.press("a");
			expect(decides).toEqual([]);
			const [row] = await server.api("get", { refs: ["C-1"] });
			const body = z.object({ version: z.number() }).passthrough().parse(row);
			await server.api("propose", {
				edits: [{ op: "edit", case: "C-1", base: body.version, body: { title: "Checkout by a person" } }],
			});
			await ev.getByText("Checkout by a person", { exact: false }).waitFor();
			await page.locator(`[data-proposal-evidence="${q}"][data-proposal-loaded="true"]`).waitFor();
			expect(await page.locator(".queue-evidence").evaluate((a) => a.scrollTop)).toBe(0);
			console.log(
				"PROBE live after case change scrollTop",
				await page.locator(".queue-evidence").evaluate((a) => a.scrollTop),
			);
			expect(await advanceProposal(page, q, () => page.keyboard.press("a"))).toBe(false);
			expect(decides).toEqual([]);
			console.log("PROBE live decides after case change + one press", decides.length);
			expect((await server.api("get", { refs: ["C-1"] }))[0]?.title).toBe("Checkout by a person");
			expect(await openAdopt(server)).toEqual([q]);
			expect(view.errors).toEqual([]);
		} finally {
			await view?.close();
			await server.stop();
		}
	},
	120000,
);

/**
 * Independent coverage: every frame, sample each edit block (a child of the evidence) in 12 px slices by
 * elementFromPoint; a slice counts as shown only when the topmost element at its centre is inside the block.
 * Kept as fractions of the block, so zoom and reflow do not move what was recorded.
 */
async function trackCoverage(page: Page, q: string): Promise<void> {
	await page.addInitScript((q) => {
		type Cov = { n: number; seen: Uint8Array };
		const w = window as unknown as { cov: Map<Element, Cov>; covEv: Element | null };
		w.cov = new Map();
		w.covEv = null;
		const tick = () => {
			const ev = document.querySelector<HTMLElement>(`[data-proposal-evidence="${CSS.escape(q)}"]`);
			if (ev && ev !== w.covEv) {
				w.covEv = ev;
				w.cov = new Map();
			}
			if (ev && ev.dataset.proposalLoaded === "true") {
				for (const block of Array.from(ev.children)) {
					const box = block.getBoundingClientRect();
					let entry = w.cov.get(block);
					if (!entry) {
						const n = Math.max(1, Math.min(4000, Math.ceil(box.height / 12)));
						entry = { n, seen: new Uint8Array(n) };
						w.cov.set(block, entry);
					}
					if (box.bottom < 0 || box.top > window.innerHeight || box.height === 0) continue;
					const x = Math.min(Math.max(box.left + Math.min(40, box.width / 2), 0), window.innerWidth - 1);
					for (let i = 0; i < entry.n; i++) {
						if (entry.seen[i]) continue;
						const y = box.top + ((i + 0.5) / entry.n) * box.height;
						if (y < 0 || y >= window.innerHeight) continue;
						const hit = document.elementFromPoint(x, y);
						if (hit && block.contains(hit)) entry.seen[i] = 1;
					}
				}
			}
			requestAnimationFrame(tick);
		};
		tick();
	}, q);
}
async function coverage(page: Page): Promise<{ blocks: number; partial: number; unseenSlices: number; worst: number }> {
	return page.evaluate(() => {
		const w = window as unknown as { cov: Map<Element, { n: number; seen: Uint8Array }> };
		let partial = 0;
		let unseen = 0;
		let worst = 1;
		for (const { n, seen } of w.cov.values()) {
			const s = seen.reduce((a, b) => a + b, 0);
			if (s < n) partial++;
			unseen += n - s;
			worst = Math.min(worst, s / n);
		}
		return { blocks: w.cov.size, partial, unseenSlices: unseen, worst: Math.round(worst * 1000) / 1000 };
	});
}

for (const device of ["desktop", "phone"] as const)
	t(
		`${device} Queue pages every screen of a tall step before accepting`,
		async () => {
			const server = await startServer({ mode: "local", preset: "standard" });
			let view: Awaited<ReturnType<typeof openPage>> | null = null;
			try {
				const token = await agentToken(server);
				const words = Array.from({ length: device === "phone" ? 200 : 6000 }, (_, i) =>
					device === "phone" ? `word${i}` : `w${i}`,
				).join(" ");
				const edits =
					device === "phone"
						? [
								{ op: "create" as const, outline: "Short one\n  Open > Opens" },
								{ op: "create" as const, outline: `Long step case\n  ${words} > It works` },
								{ op: "create" as const, outline: "Short two\n  Open > Opens" },
							]
						: [{ op: "create" as const, outline: `Tall case\n  ${words} > Expected ${words.slice(0, 2000)}` }];
				const proposed = await server.api("propose", { edits }, { token });
				const q = proposed.question ?? "";
				view = await openPage(server, {
					path: "/p/scratch/queue",
					device,
					setup: async (page) => {
						await page.setViewportSize(device === "phone" ? { width: 390, height: 360 } : { width: 1000, height: 800 });
						await trackCoverage(page, q);
					},
				});
				const page = view.page;
				if (device === "phone") await page.locator("#list [role=option]").first().tap();
				await page.locator(`[data-proposal-evidence="${q}"][data-proposal-loaded="true"]`).waitFor();
				const geometry = await page.evaluate(() => ({
					rows: [...document.querySelectorAll(".proposal-edits .dl")].map((row) =>
						Math.round(row.getBoundingClientRect().height),
					),
					area: document.querySelector(".queue-evidence")?.clientHeight,
					detail: document.querySelector("#detail")?.clientHeight,
				}));
				console.log(`PROBE ${device} tall geometry`, JSON.stringify(geometry));
				const accept = page.locator(".queue-answers").getByRole("button", { name: "Accept", exact: false });
				await frames(page);
				let answered = false;
				for (let presses = 1; presses <= 60; presses++) {
					await frames(page);
					let read = await coverage(page);
					answered = await advanceProposal(page, q, () =>
						device === "phone" ? accept.tap() : page.keyboard.press("a"),
					);
					if (answered) {
						await frames(page);
						read = await coverage(page);
					}
					const open = await openAdopt(server);
					if (read.partial > 0) {
						console.log(`PROBE ${device} tall unread`, JSON.stringify({ presses, open, ...read }));
						expect(open).toEqual([q]);
					}
					if (answered) {
						console.log(`PROBE ${device} tall answered`, JSON.stringify({ presses, ...read }));
						expect(read.partial).toBe(0);
						expect(read.unseenSlices).toBe(0);
						answered = true;
						break;
					}
				}
				expect(answered).toBe(true);
				await eventually(
					() => openAdopt(server),
					(open) => !open.includes(q),
				);
				expect((await server.api("get", { refs: [device === "phone" ? "C-3" : "C-1"] }))[0]?.title).toBe(
					device === "phone" ? "Short two" : "Tall case",
				);
				expect(view.errors).toEqual([]);
			} finally {
				await view?.close();
				await server.stop();
			}
		},
		120000,
	);

t(
	"phone Queue keeps a tall step unread after growing around a skipped middle",
	async () => {
		const server = await startServer({ mode: "local", preset: "standard" });
		let view: Awaited<ReturnType<typeof openPage>> | null = null;
		try {
			const token = await agentToken(server);
			const words = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ");
			const proposed = await server.api(
				"propose",
				{
					edits: [
						{ op: "create", outline: "Short one\n  Open > Opens" },
						{ op: "create", outline: `Long step case\n  ${words} > It works` },
						...Array.from({ length: 10 }, (_, i) => ({ op: "create" as const, outline: `Short ${i}\n  Open > Opens` })),
					],
				},
				{ token },
			);
			const q = proposed.question ?? "";
			view = await openPage(server, {
				path: "/p/scratch/queue",
				device: "phone",
				setup: async (page) => {
					await page.setViewportSize({ width: 390, height: 360 });
					await trackCoverage(page, q);
				},
			});
			const page = view.page;
			await page.locator("#list [role=option]").first().tap();
			await page.locator(`[data-proposal-evidence="${q}"][data-proposal-loaded="true"]`).waitFor();
			const accept = page.locator(".queue-answers").getByRole("button", { name: "Accept", exact: false });
			await frames(page);
			await accept.tap();
			await frames(page);
			await page
				.locator(".proposal-edits .dl")
				.nth(3)
				.evaluate((row) => row.scrollIntoView({ block: "end" }));
			await frames(page);
			await page.setViewportSize({ width: 390, height: 844 });
			await page.waitForFunction(() => innerHeight === 844);
			await frames(page);
			expect(await advanceProposal(page, q, () => accept.tap())).toBe(false);
			expect(await openAdopt(server)).toEqual([q]);
			let answered = false;
			for (let presses = 0; presses < 40; presses++) {
				await frames(page);
				const read = await coverage(page);
				answered = await advanceProposal(page, q, () => accept.tap());
				const open = await openAdopt(server);
				if (read.partial > 0) expect(open).toEqual([q]);
				if (answered) {
					expect(read.unseenSlices).toBe(0);
					answered = true;
					break;
				}
			}
			expect(answered).toBe(true);
			await eventually(
				() => openAdopt(server),
				(open) => !open.includes(q),
			);
			expect((await server.api("get", { refs: ["C-12"] }))[0]?.title).toBe("Short 9");
			expect(view.errors).toEqual([]);
		} finally {
			await view?.close();
			await server.stop();
		}
	},
	120000,
);

t(
	"waiting agent edits name their author, policy and case notice; new titles are additions",
	async () => {
		const server = await startServer({ mode: "local", preset: "standard", seed: false });
		let view: Awaited<ReturnType<typeof openPage>> | null = null;
		try {
			await server.api("propose", { edits: [{ op: "create", outline: "Original" }] });
			const token = await agentToken(server);
			const result = await server.api(
				"propose",
				{ edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Agent revision" } }] },
				{ token },
			);
			const q = result.question ?? "";
			view = await openPage(server, { path: "/p/scratch/queue" });
			const page = view.page;
			await page.locator(".queue-title").filter({ hasText: "by an agent ·" }).waitFor();
			await page
				.locator(".queue-meta")
				.filter({ hasText: /proposal.*P-/ })
				.waitFor();
			await page
				.getByText("Not in effect yet. Under the standard policy, an agent's edit waits for a person.", {
					exact: false,
				})
				.waitFor();
			await page.getByText("Your answer counts.", { exact: true }).waitFor();
			await page.goto(`${server.url}/p/scratch/suite/c/1`);
			const notice = page.locator(".case-proposal-notice");
			await notice
				.filter({ hasText: "writer, an agent, proposed a change to this case. It is not in effect yet." })
				.waitFor();
			await notice.getByRole("link", { name: "See the change", exact: true }).click();
			expect(await page.locator(`[data-proposal="${q}"]`).isVisible()).toBe(true);
			await notice.getByRole("link", { name: q, exact: true }).click();
			await page.locator(`[data-current-question="${q}"]`).waitFor();
			const created = await server.api(
				"propose",
				{ edits: [{ op: "create", outline: "Added case\n  Open > Works" }] },
				{ token },
			);
			await page.goto(`${server.url}/p/scratch/queue`);
			await page.locator(`[data-current-question="${created.question}"]`).waitFor();
			const title = page.locator(`[data-proposal-evidence="${created.question}"] .dl`).first();
			await title.waitFor();
			expect(await title.getAttribute("class")).toContain("add");
			expect(await title.locator("i").textContent()).toBe("+");
			expect(view.errors).toEqual([]);
		} finally {
			await view?.close();
			await server.stop();
		}
	},
	30000,
);
