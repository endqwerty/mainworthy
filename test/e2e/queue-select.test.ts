// Several questions of one kind take one answer: a box on each row, shift for a range, select all, Escape to clear.
import { expect, test } from "bun:test";
import { z } from "zod";
import { browserAvailable, eventually, openPage, type Server, startServer } from "./support.ts";

/** Three failures and three tests with no case, each in a file of its own, under a policy that asks about both. */
async function questions(server: Server): Promise<{ failures: string[]; unlinked: string[] }> {
	await server.api("propose", {
		edits: ["Amber", "Cedar", "Fern"].map((outline) => ({ op: "create", outline })),
	});
	await server.api("report", {
		target: { session: "select" },
		results: ["C-1", "C-2", "C-3"].map((ref) => ({
			test: { case: ref },
			outcome: "fail",
			failure: { message: `expected ${ref}, got indigo` },
		})),
	});
	await server.api("report", {
		target: { session: "select" },
		results: ["a", "b", "c"].map((name) => ({
			test: { key: `tests/${name}.ts::${name}`, file: `tests/${name}.ts` },
			outcome: "pass",
		})),
	});
	const refs = async (kind: "failure" | "map") => (await server.api("inbox", { kind })).items.map((item) => item.q);
	const found = { failures: await refs("failure"), unlinked: await refs("map") };
	if (found.failures.length !== 3 || found.unlinked.length !== 3) throw new Error("The questions are missing");
	return found;
}

test.skipIf(!browserAvailable)(
	"a box, a range and select all choose questions of one kind, and one answer settles them in one request",
	async () => {
		const server = await startServer({ preset: "standard", unlinked: "ask" });
		const view = await openPage(server, { path: "/p/scratch/queue" });
		try {
			const { page } = view;
			const { failures, unlinked } = await questions(server);
			const [f1, f2, f3] = failures;
			const [u1, u2, u3] = unlinked;
			if (!f1 || !f2 || !f3 || !u1 || !u2 || !u3) throw new Error("The questions are missing");
			// An agent advises an answer to the failure that will not be selected.
			const agent = z.object({ token: z.string() }).parse(
				await server.api("admin", {
					do: "token.create",
					actor: "reviewer",
					kind: "agent",
					can: ["read", "produce", "answer"],
					project: "scratch",
				}),
			).token;
			const advised = (await server.api("get", { refs: [f2] }))[0];
			const hash = z.object({ evidenceHash: z.string() }).parse(advised).evidenceHash;
			await server.api("decide", { q: f2, onEvidence: hash, answer: { is: "infra" } }, { token: agent });
			await page.reload();
			await page.locator("[data-current-question]").waitFor();
			const box = (ref: string) => page.locator(`[data-question="${ref}"] .queue-check`);
			const bar = page.locator(".queue-bulk");
			const submissions: unknown[] = [];
			page.on("request", (request) => {
				if (request.url().endsWith("/decide")) submissions.push(request.postDataJSON());
			});

			// A box selects without moving to the row; a click on the row moves and leaves the selection alone.
			await box(f1).click();
			await box(f3).click();
			await bar.getByText("2 failures selected").waitFor();
			expect(await box(f1).getAttribute("data-checked")).toBe("true");
			// A screen reader hears the selection: the option is selected, and the question shown is the current one.
			const option = (ref: string) => page.locator(`[data-question="${ref}"] [role=option]`);
			expect(await option(f1).getAttribute("aria-selected")).toBe("true");
			expect(await option(f2).getAttribute("aria-selected")).toBe("false");
			await page.locator(`[data-question="${u2}"] .queue-title`).click();
			await page.locator(`[data-current-question="${u2}"]`).waitFor();
			expect([await option(u2).getAttribute("aria-current"), await option(u2).getAttribute("aria-selected")]).toEqual([
				"true",
				"false",
			]);
			await bar.getByText("2 failures selected").waitFor();
			// The answers are the selection's, and the pane says the question shown is not one of them.
			await page.locator(".queue-needs").getByText("The question shown is not one of them").waitFor();
			expect(await page.locator(".queue-answers .ans b").allInnerTexts()).toContain("Flaky");
			// A row of another kind does not join, and says why.
			await box(u1).click();
			await page.getByText(`${u1} is unlinked and the selection is of failures`, { exact: false }).first().waitFor();
			expect(await box(u1).getAttribute("data-checked")).toBe("false");

			// Advice is about the question shown, so Enter does not give it to a selection that does not hold it.
			await page.locator(`[data-question="${f2}"] .queue-title`).click();
			await page.getByText("reviewer suggests infra", { exact: false }).waitFor();
			await page.keyboard.press("Enter");
			await page.getByText("Advice is for the question shown", { exact: false }).first().waitFor();
			expect(submissions).toHaveLength(0);

			// A defect reference asked for a selection stays open while the question shown is not in it.
			await page.keyboard.press("d");
			await page.locator("#answer-extra").fill("BUG-7");
			expect(await page.locator("#answer-extra").inputValue()).toBe("BUG-7");
			await bar.getByText("2 failures selected").waitFor();
			// While it is open the selection is what the answer goes to, so it does not change.
			await box(f3).click();
			await page
				.getByText("Record or cancel the answer before changing the selection", { exact: false })
				.first()
				.waitFor();
			expect(await box(f3).getAttribute("data-checked")).toBe("true");
			await bar.getByRole("button", { name: /Clear/ }).click();
			await bar.getByText("2 failures selected").waitFor();
			await page.locator("#answer-extra").focus();
			await page.keyboard.press("Enter");
			await eventually(
				() => server.api("get", { refs: [f1, f3] }),
				(rows) => rows.every((row) => row.state === "decided"),
			);
			expect(submissions).toHaveLength(1);
			const sent = z
				.object({ all: z.array(z.object({ q: z.string(), answer: z.object({ is: z.string(), ref: z.string() }) })) })
				.parse(submissions[0]).all;
			expect(sent.map((one) => [one.q, one.answer.is, one.answer.ref])).toEqual([
				[f1, "defect", "BUG-7"],
				[f3, "defect", "BUG-7"],
			]);
			expect((await server.api("get", { refs: [f2, u2] })).map((row) => row.state)).toEqual(["open", "open"]);
			await bar.waitFor({ state: "detached" });

			// Select all takes the kind of the question shown; Escape clears; pressing it twice clears too.
			await page.keyboard.press("*");
			await bar.getByText("3 unlinked tests selected").waitFor();
			await page.keyboard.press("Escape");
			await bar.waitFor({ state: "detached" });
			await page.keyboard.press("*");
			await bar.getByText("3 unlinked tests selected").waitFor();
			await page.keyboard.press("*");
			await bar.waitFor({ state: "detached" });

			// Shift and a box select the range between two rows.
			await box(u1).click();
			await box(u3).click({ modifiers: ["Shift"] });
			await bar.getByText("3 unlinked tests selected").waitFor();
			// Linking needs a case for each test, so it is offered for one question at a time.
			expect(await page.getByRole("button", { name: /Link to a case/ }).isDisabled()).toBe(true);
			await page.getByRole("button", { name: /Track without a case/ }).click();
			await eventually(
				() => server.api("get", { refs: [u1, u2, u3] }),
				(rows) => rows.every((row) => row.state === "decided"),
			);
			expect(submissions).toHaveLength(2);
			expect(z.object({ all: z.array(z.unknown()) }).parse(submissions[1]).all).toHaveLength(3);

			// Unlinked questions are counted by their tests: those that came with no file share one question, which
			// is no one file.
			await server.api("report", {
				target: { session: "select" },
				results: [
					{ test: { key: "bare a", name: "a" }, outcome: "pass" },
					{ test: { key: "bare b", name: "b" }, outcome: "pass" },
					{ test: { key: "tests/d.ts::d", file: "tests/d.ts" }, outcome: "pass" },
				],
			});
			const open = (await server.api("inbox", { kind: "map" })).items;
			expect(open.map((item) => item.title).sort()).toEqual([
				"1 test in tests/d.ts has no case",
				"2 tests in (no file) have no case",
			]);
			await page.reload();
			for (const item of open) await box(item.q).click();
			await bar.getByText("3 unlinked tests selected").waitFor();
			expect(view.errors).toEqual([]);
		} finally {
			await view.close();
			await server.stop();
		}
	},
	30000,
);

test.skipIf(!browserAvailable)(
	"a phone shows no box: the palette selects, as it lists every key (decision 0018)",
	async () => {
		const server = await startServer({ preset: "standard", unlinked: "ask" });
		const { failures } = await questions(server);
		const phone = await openPage(server, { path: "/p/scratch/queue", device: "phone" });
		try {
			const { page } = phone;
			await page.locator("#list [role=option]").first().waitFor();
			expect(await page.locator(".queue-check").count()).toBeGreaterThan(0);
			expect(await page.locator(".queue-check").first().isVisible()).toBe(false);
			const failure = failures[0];
			if (!failure) throw new Error("Missing failure question");
			await page.locator(`[data-question="${failure}"] [role=option]`).tap();
			await page.getByRole("button", { name: "Actions", exact: true }).tap();
			await page.getByRole("option", { name: /Select question/ }).tap();
			await page.locator(".queue-bulk").getByText("1 failure selected", { exact: true }).waitFor();
			expect(await page.locator(`[data-question="${failure}"] .queue-check`).getAttribute("data-checked")).toBe("true");
			expect(await page.locator(".queue-answers .ans b").allInnerTexts()).toContain("Flaky");
			expect(phone.errors).toEqual([]);
		} finally {
			await phone.close();
			await server.stop();
		}
	},
	20000,
);
