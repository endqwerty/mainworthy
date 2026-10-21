// A failing test in this repository's CI belongs to the session that pushed the commit, not to a person's queue.
// Two halves: the project's policy answers every CI failure "needs a fix" by rule, so no question waits for the
// owner (`ciPolicy`), and a session reads the verdict and what failed from the deployed Mainworthy (`readCi`).
// `docs/deploy.md` says how it was set up.
import { homedir } from "node:os";
import { join } from "node:path";
import { Clause, type Policy } from "../../src/core/kinds.ts";
import type { GateStatus, InboxReply, ProposeReply } from "../../src/core/ops.ts";
import { EXIT_CODE } from "../../src/core/runs.ts";

/** One call of an operation, the way `Client.call` makes it. A test passes the in-process harness. */
export type Call = (op: string, input: unknown) => Promise<unknown>;

export const INSTANCE = { url: "https://mainworthy.com", project: "mainworthy" };
/** Where a session's token for reading the instance is kept, outside the repository. */
export const TOKEN_FILE = join(homedir(), ".config", "mainworthy", "agent-token");

const NEEDS_FIX = { is: "defect" } as const;
const RULE = { who: "rule", agents: "none", notProducer: false, reason: "optional" } as const;
const same = (a: readonly Clause[], b: readonly Clause[]): boolean =>
	JSON.stringify(Clause.array().parse(a)) === JSON.stringify(Clause.array().parse(b));

/**
 * The clauses with every failure clause answered "needs a fix" by a rule, except a dispute between two reports,
 * which only a person can settle. The answer ends by itself when a commit passes the test (decision 0102).
 */
export function fixByRule(clauses: readonly Clause[]): Clause[] {
	return clauses.map((clause) =>
		clause.kind !== "failure" || clause.when.includes("hint:disputed")
			? clause
			: { ...clause, ask: RULE, answer: NEEDS_FIX },
	);
}

/**
 * Proposes `fixByRule` of the project's policy and accepts it. Needs an admin who is a person: on the instance, the
 * owner token. Run again, it changes nothing. Open failure questions are answered by the new rule at once.
 */
export async function ciPolicy(call: Call, project: string): Promise<string> {
	const policy = (await call("admin", { do: "policy.show", project })) as Policy & { version: number };
	const clauses = fixByRule(policy.clauses);
	if (same(clauses, policy.clauses))
		return `project ${project}: every CI failure is already answered "needs a fix" by rule`;
	const proposed = (await call("propose", {
		edits: [{ op: "policy", base: policy.version, clauses }],
	})) as ProposeReply;
	const adoptions = (await call("inbox", { kind: "adopt", limit: 500 })) as InboxReply;
	const adoption = adoptions.items.find((item) => item.q === proposed.question);
	if (!adoption)
		throw new Error(`project ${project}: the policy proposal is ${proposed.status}, with nothing to accept`);
	await call("decide", { q: adoption.q, onEvidence: adoption.evidenceHash, answer: { is: "accept" } });
	const now = (await call("admin", { do: "policy.show", project })) as Policy;
	if (!same(now.clauses, clauses))
		throw new Error(`project ${project}: ${adoption.q} was answered and the policy is still not the one proposed`);
	return `project ${project}: every CI failure is answered "needs a fix" by rule (${adoption.q} accepted)`;
}

export type Target = { change: string } | { commit: string };

type Row = { test: string; name: string; file: string | null; message: string | null; build: string | null };
type Rows = { count: number; items: Row[] };

const SHOWN = 20;

/**
 * The gate of a pull request or a commit, and the tests behind a verdict that is not `passed`, as text and the exit
 * code `mainworthy gate` gives: 0 passed, 1 failed, 2 blocked, 3 pending. Waits up to `wait` seconds for pending.
 */
export async function readCi(
	call: Call,
	target: Target,
	options: { wait?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ text: string; exit: number }> {
	const sleep = options.sleep ?? Bun.sleep;
	const deadline = Date.now() + (options.wait ?? 0) * 1000;
	let gate = (await call("gate", target)) as GateStatus;
	while (gate.verdict === "pending" && Date.now() < deadline) {
		await sleep(Math.min(10_000, Math.max(0, deadline - Date.now())));
		gate = (await call("gate", target)) as GateStatus;
	}
	const what = "change" in target ? target.change : target.commit.slice(0, 12);
	const lines = [`${what}: ${gate.verdict}: ${gate.reason.replace(new RegExp(`^${gate.verdict}:\\s*`), "")}`];
	for (const state of ["attributed", "unexplained"] as const) {
		if (gate.verdict === "passed" || !gate.tally[state]) continue;
		const rows = (await call("find", { in: "results", ...target, state, limit: SHOWN })) as Rows;
		lines.push("", `${state === "attributed" ? "needs a fix" : "not explained yet"} (${rows.count}):`);
		for (const row of rows.items) {
			lines.push(`  ${row.test} ${row.file ?? "?"}: ${row.name}`);
			for (const text of (row.message ?? "").split("\n").filter(Boolean).slice(0, 4)) lines.push(`    ${text}`);
			if (row.build) lines.push(`    ${row.build}`);
		}
		if (rows.count > rows.items.length) lines.push(`  and ${rows.count - rows.items.length} more`);
	}
	lines.push("", NEXT[gate.verdict](gate));
	return { text: lines.join("\n"), exit: EXIT_CODE[gate.verdict] };
}

const NEXT: Record<GateStatus["verdict"], (gate: GateStatus) => string> = {
	passed: () => "Nothing to do.",
	failed: () =>
		"Fix them and push. The gate passes when a commit passes these tests; nobody else is asked. " +
		"A test that fails now and then is a defect too: re-run its shard's job to unblock, and file it as flaky-test.",
	blocked: (gate) =>
		`A person is asked (${gate.open.join(", ") || "see the queue"}). If that is a CI failure, the project's policy ` +
		"no longer answers failures by rule: `bun scripts/work.ts ci-policy` with the owner token sets it again.",
	pending: () => "Results are still coming: run it again with --wait=<seconds>.",
};
