import { expect, test } from "bun:test";
import { z } from "zod";
import { PRESETS } from "../../src/core/presets.ts";
import { browserAvailable, eventually, openPage, type Server, startServer } from "./support.ts";

const cases = async (server: Server, refs: string[]) =>
	z
		.array(z.object({ tags: z.array(z.string()), title: z.string(), version: z.number() }))
		.parse(await server.api("get", { refs }));

test.skipIf(!browserAvailable)(
	"bulk tag removal works from keys and the palette and undo restores only original tags",
	async () => {
		const server = await startServer();
		await server.api("propose", {
			edits: [
				{ op: "create", outline: "First", tags: ["shared", "keep"] },
				{ op: "create", outline: "Second", tags: ["shared"] },
				{ op: "create", outline: "Third", tags: ["keep"] },
			],
		});
		const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
		try {
			const { page } = h;
			await page.getByRole("button", { name: "First", exact: true }).waitFor();
			await page.keyboard.press("x");
			await page.keyboard.press("j");
			await page.keyboard.press("x");
			await page.keyboard.press("j");
			await page.keyboard.press("x");
			await page.evaluate(() =>
				window.dispatchEvent(new KeyboardEvent("keydown", { key: "†", code: "KeyT", altKey: true, bubbles: true })),
			);
			await page.getByRole("textbox", { name: "Remove tag from selected cases" }).fill("shared");
			await page.keyboard.press("Enter");
			const tags = async () => (await cases(server, ["C-1", "C-2", "C-3"])).map((row) => row.tags);
			expect(await eventually(tags, (value) => !value.flat().includes("shared"))).toEqual([["keep"], [], ["keep"]]);
			await page.keyboard.press("u");
			expect(await eventually(tags, (value) => value[0]?.includes("shared") === true)).toEqual([
				["keep", "shared"],
				["shared"],
				["keep"],
			]);
			await page.keyboard.press("ControlOrMeta+k");
			await page.getByRole("textbox", { name: "Jump to or run", exact: true }).fill("Remove tag");
			await page.keyboard.press("Enter");
			await page.getByRole("textbox", { name: "Remove tag from selected cases" }).fill("keep");
			await page.keyboard.press("Enter");
			await eventually(tags, (value) => value[2]?.length === 0);
			expect((await tags())[0]).toEqual(["keep", "shared"]);
			expect(h.errors).toEqual([]);
		} finally {
			await h.close();
			await server.stop();
		}
	},
	30_000,
);

test.skipIf(!browserAvailable)(
	"editor chip removal survives reload, removes a typed tag and preserves the case body",
	async () => {
		const server = await startServer();
		await server.api("propose", { edits: [{ op: "create", outline: "Tagged case", tags: ["old", "keep"] }] });
		const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
		try {
			const { page } = h;
			await page.getByRole("button", { name: "Tagged case", exact: true }).waitFor();
			await page.keyboard.press("e");
			await page.getByRole("textbox", { name: "Case title", exact: true }).fill("Tagged case #typed");
			await page.keyboard.press("Enter");
			await page.getByRole("button", { name: "Remove tag #typed", exact: true }).click();
			await page.getByRole("button", { name: "Remove tag #old", exact: true }).click();
			await page.reload();
			await page.getByRole("textbox", { name: "Case title", exact: true }).waitFor();
			expect(await page.locator(".ctags").textContent()).toBe("#keep");
			await page.keyboard.press("Escape");
			const saved = await eventually(
				() => cases(server, ["C-1"]),
				(rows) => rows[0]?.tags?.length === 1,
			);
			expect(saved[0]).toMatchObject({ tags: ["keep"], title: "Tagged case", version: 1 });
			expect(h.errors).toEqual([]);
		} finally {
			await h.close();
			await server.stop();
		}
	},
	30_000,
);

for (const control of ["bulk", "chip"] as const) {
	test.skipIf(!browserAvailable)(
		`${control} removal of a protected tag waits for review without applying it`,
		async () => {
			const server = await startServer();
			await server.api("propose", { edits: [{ op: "create", outline: "Protected", tags: ["critical"] }] });
			const policy = await server.api("propose", {
				edits: [
					{
						op: "policy",
						base: z
							.object({ version: z.number() })
							.parse(await server.api("admin", { do: "policy.show", project: "scratch" })).version,
						clauses: [
							...PRESETS.loose.clauses.slice(0, 3),
							{
								id: "review-critical",
								kind: "adopt",
								when: ["tag:critical"],
								ask: { who: "member", agents: "none", notProducer: false, reason: "optional" },
								blocks: "nothing",
							},
							...PRESETS.loose.clauses.slice(3),
						],
					},
				],
			});
			const question = (await server.api("inbox", { kind: "adopt" })).items.find((item) => item.q === policy.question);
			if (!question) throw new Error("Policy question missing");
			await server.api("decide", { q: question.q, onEvidence: question.evidenceHash, answer: { is: "accept" } });
			const h = await openPage(server, { path: "/p/scratch/suite/c/1" });
			try {
				const { page } = h;
				await page.getByRole("button", { name: "Protected", exact: true }).waitFor();
				if (control === "bulk") {
					await page.keyboard.press("Alt+t");
					await page.getByRole("textbox", { name: "Remove tag from selected cases" }).fill("critical");
					await page.keyboard.press("Enter");
				} else {
					await page.keyboard.press("e");
					await page.getByRole("button", { name: "Remove tag #critical", exact: true }).click();
					await page.keyboard.press("Escape");
				}
				const pending = await eventually(
					() => server.api("inbox", { kind: "adopt" }),
					(reply) => reply.items.length === 1,
				);
				expect(pending.items[0]?.q).not.toBe(policy.question);
				expect((await cases(server, ["C-1"]))[0]).toMatchObject({ tags: ["critical"], version: 1 });
				await page.waitForFunction(() =>
					document.querySelector("#stat")?.textContent?.toLowerCase().includes("waiting"),
				);
				const removal = pending.items[0];
				if (!removal) throw new Error("Removal question missing");
				await server.api("decide", { q: removal.q, onEvidence: removal.evidenceHash, answer: { is: "accept" } });
				expect((await cases(server, ["C-1"]))[0]).toMatchObject({ tags: [], version: 1 });
				expect(h.errors).toEqual([]);
			} finally {
				await h.close();
				await server.stop();
			}
		},
		30_000,
	);
}

test.skipIf(!browserAvailable)(
	"phone Actions removes tags while editor chips have no duplicate touch control",
	async () => {
		const server = await startServer();
		await server.api("propose", { edits: [{ op: "create", outline: "Phone case", tags: ["remove", "keep"] }] });
		const h = await openPage(server, { device: "phone", path: "/p/scratch/suite/c/1" });
		try {
			const { page } = h;
			await page.getByRole("button", { name: "Phone case", exact: true }).waitFor();
			await page.getByRole("button", { name: "Phone case", exact: true }).tap();
			expect(await page.locator(".tag-remove").count()).toBe(2);
			expect(await page.locator(".tag-remove").first().isVisible()).toBe(false);
			await page.getByRole("button", { name: "Actions", exact: true }).tap();
			await page.getByRole("option", { name: /Seal and leave editor/ }).tap();
			await page.getByRole("button", { name: "Actions", exact: true }).tap();
			await page.getByRole("option", { name: /Remove tag/ }).tap();
			await page.getByRole("option", { name: /#remove/ }).tap();
			const saved = await eventually(
				() => cases(server, ["C-1"]),
				(rows) => rows[0]?.tags?.length === 1,
			);
			expect(saved[0]?.tags).toEqual(["keep"]);
			expect(h.errors).toEqual([]);
		} finally {
			await h.close();
			await server.stop();
		}
	},
	30_000,
);

test.skipIf(!browserAvailable)(
	"Option+[ uses its physical bracket key to open the previous folder",
	async () => {
		const server = await startServer();
		await server.api("propose", {
			edits: [
				{ op: "create", outline: "First folder case", folder: "Alpha" },
				{ op: "create", outline: "Second folder case", folder: "Beta" },
			],
		});
		const h = await openPage(server, { path: "/p/scratch/suite?folder=Beta" });
		try {
			const { page } = h;
			await page.getByRole("option").filter({ hasText: "Second folder case" }).waitFor();
			await page.evaluate(() =>
				window.dispatchEvent(
					new KeyboardEvent("keydown", { key: "“", code: "BracketLeft", altKey: true, bubbles: true }),
				),
			);
			await page.getByRole("option").filter({ hasText: "First folder case" }).waitFor();
			expect(await page.locator("#ltitle").textContent()).toBe("Alpha");
			expect(h.errors).toEqual([]);
		} finally {
			await h.close();
			await server.stop();
		}
	},
	30_000,
);
