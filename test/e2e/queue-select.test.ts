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
			page.setDefaultTimeout(8000);
			const { failures, unlinked } = await questions(server);
			await page.reload();
			await page.locator("[data-current-question]").waitFor();
			const [f1, , f3] = failures;
			const [u1, u2, u3] = unlinked;
			if (!f1 || !f3 || !u1 || !u2 || !u3) throw new Error("The questions are missing");
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
			await page.locator(`[data-question="${u2}"] .queue-title`).click();
			await page.locator(`[data-current-question="${u2}"]`).waitFor();
			await bar.getByText("2 failures selected").waitFor();
			// The answers are the selection's, and the pane says the question shown is not one of them.
			await page.locator(".queue-needs").getByText("The question shown is not one of them").waitFor();
			expect(await page.locator(".queue-answers .ans b").allInnerTexts()).toContain("Flaky");
			// A row of another kind does not join, and says why.
			await box(u1).click();
			await page.getByText(`${u1} is unlinked and the selection is of failures`, { exact: false }).first().waitFor();
			expect(await box(u1).getAttribute("data-checked")).toBe("false");

			await page.keyboard.press("f");
			await eventually(
				() => server.api("get", { refs: [f1, f3] }),
				(rows) => rows.every((row) => row.state === "decided"),
			);
			expect(submissions).toHaveLength(1);
			expect(
				z
					.object({ all: z.array(z.object({ q: z.string() })) })
					.parse(submissions[0])
					.all.map((one) => one.q),
			).toEqual([f1, f3]);
			expect((await server.api("get", { refs: [u2] }))[0]?.state).toBe("open");
			await bar.waitFor({ state: "detached" });

			// Select all takes the kind of the question shown; Escape clears; pressing it twice clears too.
			await page.keyboard.press("*");
			await bar.getByText("3 unlinked selected").waitFor();
			await page.keyboard.press("Escape");
			await bar.waitFor({ state: "detached" });
			await page.keyboard.press("*");
			await bar.getByText("3 unlinked selected").waitFor();
			await page.keyboard.press("*");
			await bar.waitFor({ state: "detached" });

			// Shift and a box select the range between two rows.
			await box(u1).click();
			await box(u3).click({ modifiers: ["Shift"] });
			await bar.getByText("3 unlinked selected").waitFor();
			// Linking needs a case for each test, so it is offered for one question at a time.
			expect(await page.getByRole("button", { name: /Link to a case/ }).isDisabled()).toBe(true);
			await page.getByRole("button", { name: /Track without a case/ }).click();
			await eventually(
				() => server.api("get", { refs: [u1, u2, u3] }),
				(rows) => rows.every((row) => row.state === "decided"),
			);
			expect(submissions).toHaveLength(2);
			expect(z.object({ all: z.array(z.unknown()) }).parse(submissions[1]).all).toHaveLength(3);
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
		await questions(server);
		const phone = await openPage(server, { path: "/p/scratch/queue", device: "phone" });
		try {
			const { page } = phone;
			await page.locator("#list [role=option]").first().waitFor();
			expect(await page.locator(".queue-check").count()).toBeGreaterThan(0);
			expect(await page.locator(".queue-check").first().isVisible()).toBe(false);
			expect(phone.errors).toEqual([]);
		} finally {
			await phone.close();
			await server.stop();
		}
	},
	20000,
);
