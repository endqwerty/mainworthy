// One `create` answer is one transaction, and the database ends a transaction after two minutes. A file that
// gathered more tests with no case than one report may carry is refused, and its question stays open, instead of an
// answer that could outlast the transaction: under the `create` rule, a report that never applies.
import { expect, test } from "bun:test";
import type { InboxReply, ReportReceipt } from "../src/core/ops.ts";
import { CREATE_MAX } from "../src/server/decisions/kinds.ts";
import { sql } from "../src/server/kernel/db.ts";
import { ciReport, harness } from "./helpers.ts";

test("`create` refuses a file with more tests than one report carries; the question stays open and reports apply", async () => {
	const h = await harness({ unlinked: "ask" });
	try {
		const file = "tests/checkout/huge.spec.ts";
		const asked = async () => {
			const open = (await h.call<InboxReply>("inbox", { kind: "map", state: "open" })).items;
			expect(open).toHaveLength(1);
			const [question] = open;
			if (!question) throw new Error("expected the file's question");
			return question;
		};
		await h.call("report", ciReport({ commit: "huge0001", n: 1, file }));
		// The backlog a project asking about its tests gathers over many reports, written at once: reporting it takes
		// more than a minute. Numbers far above the reported tests' keep the next report's numbers free.
		await h.app.database.write(
			async (db) =>
				await db.transaction(
					async () =>
						await db.run(
							sql<{ file: string; n: number }>(`
					INSERT INTO tests (project, no, kind, key, name, file, first_seq, last_seq)
					SELECT p.id, 1000000 + g, 'auto', 'huge::' || g, 'huge ' || g, $file, 1, 1
					FROM projects p, generate_series(1, $n::int) g WHERE p.key = 'scratch'`),
							{ file, n: CREATE_MAX },
						),
				),
		);
		await h.call("report", ciReport({ commit: "huge0002", n: 2, only: [1], file }));
		const question = await asked();
		expect(question.title).toBe(`${CREATE_MAX + 2} tests in ${file} have no case`);

		// A person's answer is refused and says what to do.
		const reply = await h.call<{ status: string; needs: string }[]>("decide", {
			q: question.q,
			onEvidence: question.evidenceHash,
			answer: { is: "create" },
		});
		expect(reply[0]).toMatchObject({ status: "invalid" });
		expect(reply[0]?.needs).toContain(`one answer creates at most ${CREATE_MAX}`);

		// The rule's answer, when the project turns to `create` and when a report adds a test, is refused the same
		// way: the policy changes, the report applies, and the question stays open.
		const proposed = await h.call<{ proposal: string }>("propose", { edits: [{ op: "policy", unlinked: "create" }] });
		const adopt = (await h.call<InboxReply>("inbox", { kind: "adopt", on: proposed.proposal })).items[0];
		if (!adopt) throw new Error("expected the policy's adopt question");
		expect(
			(
				await h.call<{ status: string }[]>("decide", {
					q: adopt.q,
					onEvidence: adopt.evidenceHash,
					answer: { is: "accept" },
				})
			)[0],
		).toMatchObject({ status: "decided" });
		const policy = await h.call<{ settings: { unlinked: string } }>("admin", { do: "policy.show", project: "scratch" });
		expect(policy.settings.unlinked).toBe("create");
		const receipt = await h.call<ReportReceipt>("report", ciReport({ commit: "huge0003", n: 3, only: [2], file }));
		expect(receipt.counts.total).toBe(1);
		expect((await asked()).title).toBe(`${CREATE_MAX + 3} tests in ${file} have no case`);
		expect((await h.call<{ count: number }>("find", { in: "cases" })).count).toBe(0);
	} finally {
		await h.close();
	}
});
