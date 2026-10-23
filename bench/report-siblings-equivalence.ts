import type { GateStatus, InboxReply, ReportReceipt } from "../src/core/ops.ts";
import { ciReport, harness } from "../test/helpers.ts";

/** Full public gates and questions at each step, for comparison across revisions. */
export async function snapshots() {
	return await Promise.all(
		["loose", "standard"].map(async (preset) => {
			const h = await harness({ preset });
			const ci = h.actor("pipeline", "ci", ["read", "record"]);
			const stages: unknown[] = [];
			const targets = ["base0001", "otherbase", "change01", "change02", "change03"];
			const runs: string[] = [];
			const capture = async (step: string) => {
				const questions: InboxReply["items"] = [];
				for (const state of ["open", "decided"] as const) {
					let cursor: string | undefined;
					do {
						const page = await h.call<InboxReply>("inbox", { state, limit: 200, ...(cursor ? { cursor } : {}) });
						questions.push(...page.items);
						cursor = page.cursor ?? undefined;
					} while (cursor);
				}
				stages.push({
					step,
					gates: await Promise.all(
						targets.map(async (commit) => await h.call<GateStatus>("gate", { commit, repo: "acme/web" })),
					),
					otherRepo: await h.call<GateStatus>("gate", { commit: "change03", repo: "acme/other" }),
					planned: await Promise.all(runs.map(async (run) => await h.call<GateStatus>("gate", { run }))),
					questions,
				});
			};
			try {
				await h.call("propose", {
					edits: [
						{ op: "create", body: { title: "Checkout", steps: [{ id: "buy", action: "Buy", expected: "Receipt" }] } },
					],
				});
				const adoption = (await h.call<InboxReply>("inbox", { kind: "adopt" })).items[0];
				if (adoption)
					await h.call("decide", { q: adoption.q, onEvidence: adoption.evidenceHash, answer: { is: "accept" } });
				const report = async (
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
				const initial = await report("base0001");
				await report("otherbase", undefined, 1, {});
				await report("change01", 1);
				await report("change02", 2, 1, { 0: "shared cause", 1: "new cause" });
				await report("change03", 3, 1, { 0: "shared cause" }, { job: "unit" });
				const other = ciReport({ commit: "change03", pr: 3, base: "base0001", n: 2, fail: { 0: "shared cause" } });
				await h.call("report", { ...other, target: { ...other.target, repo: "acme/other", env: "linux" } }, ci);
				runs.push(
					(
						await h.call<{ run: string }>("plan", {
							name: "Pinned",
							select: { cases: ["C-1"] },
							accepts: { commit: "change01", repo: "acme/web" },
						})
					).run,
				);
				await capture("mixed reports and planned run");
				await report("change01", 1, 2);
				await capture("one change retry");
				const fail = (await h.call<InboxReply>("inbox", { on: "pr:2", kind: "failure" })).items.find(
					(q) => q.title === "new cause",
				);
				if (!fail) throw new Error("missing new failure");
				await h.call("decide", {
					q: fail.q,
					onEvidence: fail.evidenceHash,
					answer: { is: "flaky" },
					reason: "Intermittent runner failure",
				});
				await capture("manual answer");
				const corrected = ciReport({ commit: "base0001", n: 2 });
				await h.call(
					"report",
					{ ...corrected, results: [{ ...corrected.results[0], corrects: initial.results[0] }] },
					ci,
				);
				await capture("corrected base");
				await report("base0001", undefined, 3);
				await capture("base fails again");
				const moved = ciReport({
					commit: "change01",
					pr: 1,
					base: "otherbase",
					n: 2,
					fail: { 0: "shared cause" },
					attempt: 3,
				});
				await h.call("report", moved, ci);
				await capture("retargeted change");
				for (const next of ["standard", "loose"] as const) {
					await h.call("propose", { edits: [{ op: "policy", preset: next }] });
					const q = (await h.call<InboxReply>("inbox", { kind: "adopt" })).items[0];
					if (!q) throw new Error("missing policy adoption");
					await h.call("decide", { q: q.q, onEvidence: q.evidenceHash, answer: { is: "accept" } });
					await capture(`adopted ${next}`);
				}
				return { preset, stages };
			} finally {
				h.close();
			}
		}),
	);
}

if (import.meta.main) console.log(JSON.stringify(await snapshots(), null, 2));
