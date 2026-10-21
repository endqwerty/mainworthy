import { expect, test } from "bun:test";
import { z } from "zod";
import choicesTable from "../../ios/Kit/Tests/MainworthyScreensTests/Fixtures/conflict-choices.json";
import { mergeBodies } from "../../src/core/merge3.ts";
import { CaseBody, ConflictAddress, conflictLabel } from "../../src/core/model.ts";
import { browserAvailable, eventually, openPage, startServer } from "./support.ts";

test.skipIf(!browserAvailable)(
	"same-field edits retain both sides until a merge decision makes the next version",
	async () => {
		const server = await startServer();
		await server.api("propose", {
			edits: [{ op: "create", outline: "Original title\n  Apply coupon > Coupon accepted" }],
		});
		const browser = await openPage(server, { path: "/p/scratch/suite/c/1" });
		try {
			const { page } = browser;
			await page.getByRole("button", { name: "Original title", exact: true }).waitFor();
			await page.keyboard.press("e");
			await page.getByRole("textbox", { name: "Case title", exact: true }).fill("My title");
			await server.api("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Their title" } }] });
			await page.keyboard.press("Escape");
			const conflict = page.getByRole("region", { name: "Edit conflict" });
			await conflict.waitFor();
			expect(await conflict.textContent()).toContain("My title");
			expect(await conflict.textContent()).toContain("Their title");
			const current = (await server.api("get", { refs: ["C-1"] }))[0];
			expect(current?.title).toBe("Their title");
			expect(current?.version).toBe(2);
			await conflict.getByRole("button", { name: "Use my title", exact: true }).click();
			await conflict.getByRole("button", { name: "Resolve conflict", exact: true }).click();
			const merged = await eventually(
				() => server.api("get", { refs: ["C-1"] }),
				(value) => value[0]?.version === 3,
			);
			expect(merged[0]?.title).toBe("My title");
			const history = await server.api("history", { ref: "C-1" });
			expect(Array.isArray(history.versions) ? history.versions.length : 0).toBe(3);
			expect(browser.errors).toEqual([]);
		} finally {
			await browser.close();
			await server.stop();
		}
	},
	30_000,
);

const scenarios = z
	.array(
		z.object({
			name: z.string(),
			base: CaseBody,
			mine: CaseBody,
			current: CaseBody,
			expected: CaseBody,
			addresses: z.array(ConflictAddress),
			choices: z.array(z.object({ address: ConflictAddress, side: z.enum(["mine", "current"]) })),
		}),
	)
	.parse(choicesTable);

for (const row of scenarios)
	test.skipIf(!browserAvailable)(
		`shared conflict choices: ${row.name}`,
		async () => {
			const server = await startServer();
			await server.api("propose", { edits: [{ op: "create", body: row.base }] });
			const browser = await openPage(server, { path: "/p/scratch/suite/c/1" });
			try {
				const { page } = browser;
				await page.getByRole("button", { name: row.base.title, exact: true }).waitFor();
				await page.keyboard.press("e");
				await page.getByRole("textbox", { name: "Case title", exact: true }).fill("Fixture draft");
				await server.api("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: row.current }] });
				await server.api("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: row.mine }] });
				const question = (await server.api("inbox", { on: "C-1", kind: "adopt" })).items[0];
				if (!question) throw Error("Missing conflict question");
				const merge = mergeBodies({ base: row.base, mine: row.mine, theirs: row.current });
				expect(merge.conflicts.map((item) => item.address)).toEqual(row.addresses);
				// Restore a saved card so every table row starts with exactly the native draft and documents.
				await page.evaluate(
					({ row, question, merged }) => {
						const key = Object.keys(localStorage).find((key) => key.includes(":draft:"));
						if (!key) throw Error("Missing local draft");
						const draft = JSON.parse(localStorage.getItem(key) ?? "null");
						const conflict = {
							q: question.q,
							proposal: question.evidence.proposal,
							ref: "C-1",
							base: row.base,
							mine: row.mine,
							current: row.current,
							merged,
							addresses: row.addresses,
							draftId: "C-1",
							sentMerges: [],
						};
						localStorage.setItem(key, JSON.stringify({ ...draft, body: row.mine, conflict }));
					},
					{ row, question, merged: merge.merged },
				);
				await page.reload();
				const card = page.getByRole("region", { name: "Edit conflict" });
				await card.waitFor();
				for (const choice of row.choices) {
					const field = card
						.locator(".conflict-field")
						.filter({ has: page.getByText(conflictLabel(choice.address), { exact: true }) });
					const kind =
						choice.address.kind === "step-order"
							? "order"
							: choice.address.kind === "step"
								? "step"
								: conflictLabel(choice.address);
					const side =
						kind === "step" || kind === "order"
							? choice.side === "mine"
								? "your draft"
								: "current version"
							: choice.side === "mine"
								? "my"
								: "current";
					await field.getByRole("button", { name: `Use ${side} ${kind}`, exact: true }).click();
					if (row.choices.length > 1 && choice.address.kind === "step-order") {
						await page.reload();
						await card.waitFor();
					}
				}
				let submitted: unknown;
				await page.route("**/decide", async (route) => {
					submitted = route.request().postDataJSON().answer.body;
					await route.continue();
				});
				await card.getByRole("button", { name: "Resolve conflict", exact: true }).click();
				await card.waitFor({ state: "detached" });
				expect(CaseBody.parse(submitted)).toEqual(row.expected);
				const saved = (await server.api("get", { refs: ["C-1"] }))[0];
				expect(CaseBody.parse({ ...saved, fields: {} })).toEqual(row.expected);
				expect(browser.errors).toEqual([]);
			} finally {
				await browser.close();
				await server.stop();
			}
		},
		30_000,
	);
