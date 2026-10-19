import type { GateStatus, InboxReply, ReportReceipt } from "../src/core/ops.ts";
import { ciReport, harness } from "../test/helpers.ts";

/** Full public gates and questions at each step, for comparison across revisions. */
export function snapshots() {
	return ["loose", "standard"].map((preset) => {
		const h = harness({ preset });
		const ci = h.actor("pipeline", "ci", ["read", "record"]);
		const stages: unknown[] = [];
		const targets = ["base0001", "otherbase", "change01", "change02", "change03"];
		const runs: string[] = [];
		const capture = (step: string) => {
			const questions: InboxReply["items"] = [];
			for (const state of ["open", "decided"] as const) {
				let cursor: string | undefined;
				do {
					const page = h.call<InboxReply>("inbox", { state, limit: 200, ...(cursor ? { cursor } : {}) });
					questions.push(...page.items);
					cursor = page.cursor ?? undefined;
				} while (cursor);
			}
			stages.push({
				step,
				gates: targets.map((commit) => h.call<GateStatus>("gate", { commit, repo: "acme/web" })),
				otherRepo: h.call<GateStatus>("gate", { commit: "change03", repo: "acme/other" }),
				planned: runs.map((run) => h.call<GateStatus>("gate", { run })),
				questions,
			});
		};
		try {
			h.call("propose", {
				edits: [
					{ op: "create", body: { title: "Checkout", steps: [{ id: "buy", action: "Buy", expected: "Receipt" }] } },
				],
			});
			const adoption = h.call<InboxReply>("inbox", { kind: "adopt" }).items[0];
			if (adoption) h.call("decide", { q: adoption.q, onEvidence: adoption.evidenceHash, answer: { is: "accept" } });
			const report = (
				commit: string,
				pr?: number,
				attempt = 1,
				fail: Record<number, string> = { 0: "shared cause" },
				extra = {},
			) => {
				const input = ciReport({ commit, ...(pr ? { pr, base: "base0001" } : {}), n: 2, fail, attempt });
				return h.call<ReportReceipt>(
					"report",
					{
						...input,
						results: input.results.map((result) => ({ ...result, annotation: { case: "C-1", version: 1 } })),
						...extra,
					},
					ci,
				);
			};
			const initial = report("base0001");
			report("otherbase", undefined, 1, {});
			report("change01", 1);
			report("change02", 2, 1, { 0: "shared cause", 1: "new cause" });
			report("change03", 3, 1, { 0: "shared cause" }, { job: "unit" });
			const other = ciReport({ commit: "change03", pr: 3, base: "base0001", n: 2, fail: { 0: "shared cause" } });
			h.call("report", { ...other, target: { ...other.target, repo: "acme/other", env: "linux" } }, ci);
			runs.push(
				h.call<{ run: string }>("plan", {
					name: "Pinned",
					select: { cases: ["C-1"] },
					accepts: { commit: "change01", repo: "acme/web" },
				}).run,
			);
			capture("mixed reports and planned run");
			report("change01", 1, 2);
			capture("one change retry");
			const fail = h
				.call<InboxReply>("inbox", { on: "pr:2", kind: "failure" })
				.items.find((q) => q.title === "new cause");
			if (!fail) throw new Error("missing new failure");
			h.call("decide", {
				q: fail.q,
				onEvidence: fail.evidenceHash,
				answer: { is: "flaky" },
				reason: "Intermittent runner failure",
			});
			capture("manual answer");
			const corrected = ciReport({ commit: "base0001", n: 2 });
			h.call("report", { ...corrected, results: [{ ...corrected.results[0], corrects: initial.results[0] }] }, ci);
			capture("corrected base");
			report("base0001", undefined, 3);
			capture("base fails again");
			const moved = ciReport({
				commit: "change01",
				pr: 1,
				base: "otherbase",
				n: 2,
				fail: { 0: "shared cause" },
				attempt: 3,
			});
			h.call("report", moved, ci);
			capture("retargeted change");
			for (const next of ["standard", "loose"] as const) {
				h.call("propose", { edits: [{ op: "policy", preset: next }] });
				const q = h.call<InboxReply>("inbox", { kind: "adopt" }).items[0];
				if (!q) throw new Error("missing policy adoption");
				h.call("decide", { q: q.q, onEvidence: q.evidenceHash, answer: { is: "accept" } });
				capture(`adopted ${next}`);
			}
			return { preset, stages };
		} finally {
			h.close();
		}
	});
}

if (import.meta.main) console.log(JSON.stringify(snapshots(), null, 2));
