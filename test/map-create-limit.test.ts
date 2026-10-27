// One command is one transaction, and the database ends a transaction after two minutes. Answers to tests with no
// case create at most one report's worth of cases in one command, whether one file asks for more or several files
// together do. What is refused keeps its question open, instead of a command that could outlast the transaction: a
// policy that never changes, or under the `create` rule a report that never applies.
import { expect, test } from "bun:test";
import type { InboxReply, ReportReceipt } from "../src/core/ops.ts";
import { CREATE_MAX } from "../src/server/decisions/kinds.ts";
import { sql } from "../src/server/kernel/db.ts";
import { ciReport, type Harness, harness } from "./helpers.ts";

/**
 * The backlog a project asking about its tests gathers over many reports, written at once: reporting it takes more
 * than a minute. Numbers far above the reported tests' keep the next report's numbers free.
 */
async function backlog(h: Harness, file: string, n: number): Promise<void> {
	await h.app.database.write(
		async (db) =>
			await db.transaction(
				async () =>
					await db.run(
						sql<{ file: string; n: number }>(`
						INSERT INTO tests (project, no, kind, key, name, file, first_seq, last_seq)
						SELECT p.id, 1000000 + g, 'auto', $file || '::backlog ' || g, 'backlog ' || g, $file, 1, 1
						FROM projects p, generate_series(1, $n::int) g WHERE p.key = 'scratch'`),
						{ file, n },
					),
			),
	);
}

const openMap = async (h: Harness) => (await h.call<InboxReply>("inbox", { kind: "map", state: "open" })).items;
const cases = async (h: Harness) => (await h.call<{ count: number }>("find", { in: "cases" })).count;

/** Turns the project to `create`, as its admin does: a proposal and its acceptance. */
async function turnToCreate(h: Harness): Promise<void> {
	const proposed = await h.call<{ proposal: string }>("propose", { edits: [{ op: "policy", unlinked: "create" }] });
	const adopt = (await h.call<InboxReply>("inbox", { kind: "adopt", on: proposed.proposal })).items[0];
	if (!adopt) throw new Error("expected the policy's adopt question");
	const reply = await h.call<{ status: string }[]>("decide", {
		q: adopt.q,
		onEvidence: adopt.evidenceHash,
		answer: { is: "accept" },
	});
	expect(reply[0]).toMatchObject({ status: "decided" });
	const policy = await h.call<{ settings: { unlinked: string } }>("admin", { do: "policy.show", project: "scratch" });
	expect(policy.settings.unlinked).toBe("create");
}

test("`create` refuses a file with more tests than one report carries; the question stays open and reports apply", async () => {
	const h = await harness({ unlinked: "ask" });
	try {
		const file = "tests/checkout/huge.spec.ts";
		await h.call("report", ciReport({ commit: "huge0001", n: 1, file }));
		await backlog(h, file, CREATE_MAX);
		await h.call("report", ciReport({ commit: "huge0002", n: 2, only: [1], file }));
		const [question] = await openMap(h);
		if (!question) throw new Error("expected the file's question");
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
		await turnToCreate(h);
		const receipt = await h.call<ReportReceipt>("report", ciReport({ commit: "huge0003", n: 3, only: [2], file }));
		expect(receipt.counts.total).toBe(1);
		expect((await openMap(h)).map((item) => item.title)).toEqual([`${CREATE_MAX + 3} tests in ${file} have no case`]);
		expect(await cases(h)).toBe(0);
	} finally {
		await h.close();
	}
});

test("one command creates at most one report's worth of cases across files; the rest keep their questions", async () => {
	const h = await harness({ unlinked: "ask" });
	try {
		// Two files asked about, the second exactly at the limit: each fits alone, not both in one command.
		const small = "tests/checkout/small.spec.ts";
		const large = "tests/checkout/large.spec.ts";
		await h.call("report", ciReport({ commit: "many0001", n: 1, file: small }));
		await h.call("report", ciReport({ commit: "many0001", job: "large", n: 1, file: large }));
		await backlog(h, large, CREATE_MAX - 1);
		expect(await openMap(h)).toHaveLength(2);

		// Turning to `create` answers the small file's question first and leaves the large one's open.
		await turnToCreate(h);
		expect(await cases(h)).toBe(1);
		const open = await openMap(h);
		expect(open.map((item) => (item.evidence as { file: string }).file)).toEqual([large]);
		expect((await h.call<{ count: number }>("find", { in: "tests", unlinked: true })).count).toBe(CREATE_MAX);
	} finally {
		await h.close();
	}
});

test("a report under the `create` rule makes what fits and applies; a file past the limit keeps its question", async () => {
	const h = await harness({ unlinked: "create" });
	try {
		const small = "tests/checkout/small.spec.ts";
		const large = "tests/checkout/large.spec.ts";
		await backlog(h, large, CREATE_MAX - 1);
		const first = ciReport({ commit: "many0002", n: 1, file: small });
		const second = ciReport({ commit: "many0002", n: 1, file: large });
		const receipt = await h.call<ReportReceipt>("report", { ...first, results: [...first.results, ...second.results] });
		expect(receipt.counts.total).toBe(2);
		expect(await cases(h)).toBe(1);
		expect((await openMap(h)).map((item) => (item.evidence as { file: string }).file)).toEqual([large]);
	} finally {
		await h.close();
	}
});
