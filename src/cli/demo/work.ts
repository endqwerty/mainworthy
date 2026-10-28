import type { Clause } from "../../core/kinds.ts";
import { PRESETS } from "../../core/presets.ts";
/** A live demo renews at half the ordinary lease length, without changing its random history. */
export const DEMO_WORK = { seconds: 86_400, renewEveryMs: 12 * 3_600_000 };

export const DEMO_CLAUSES: Clause[] = [
	...PRESETS.standard.clauses.filter((clause) => clause.kind !== "signoff"),
	{
		id: "release-approvals",
		kind: "signoff",
		when: ["always"],
		ask: { who: "member", agents: "none", notProducer: true, reason: "required", approvals: 2 },
		blocks: "nothing",
	},
];
