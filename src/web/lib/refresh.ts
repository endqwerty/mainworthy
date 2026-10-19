import { z } from "zod";
import type { Api, OpName } from "../../core/api.ts";
import { FindInput } from "../../core/ops.ts";

export const Change = z.object({ op: z.string().optional(), touched: z.array(z.string()) });
type Change = z.infer<typeof Change>;
const Collection = z.object({ in: FindInput.shape.in });
const Administration = z.object({ do: z.string() });
const staticAdministration: ReadonlySet<string> = new Set([
	"actor.list",
] satisfies readonly Api["admin"]["input"]["do"][]);

type Writes = { attachments: boolean; deployments: boolean };
const suite = { attachments: false, deployments: false };
// Only proven dependencies go here. An unlisted operation, including a newly added one, refreshes everything.
const writes: ReadonlyMap<string, Writes> = new Map(
	Object.entries({
		propose: suite,
		"import-csv": suite,
		decide: suite,
		claim: suite,
		plan: suite,
		change: suite,
		report: { attachments: true, deployments: false },
		attach: { attachments: true, deployments: false },
		announce: { attachments: false, deployments: true },
	} satisfies Partial<Record<OpName, Writes>>),
);

// These lists have no proof, gate or question projection. Other collections cross those boundaries.
const suiteOnly = {
	cases: false,
	tests: false,
	runs: false,
	folders: true,
	tags: true,
	requirements: true,
	slots: false,
	changes: false,
	deployments: false,
	results: false,
} satisfies Record<z.infer<typeof FindInput>["in"], boolean>;

function contains(input: unknown, match: (value: string) => boolean): boolean {
	if (typeof input === "string") return match(input);
	if (Array.isArray(input)) return input.some((value) => contains(value, match));
	return input !== null && typeof input === "object" && Object.values(input).some((value) => contains(value, match));
}

/** Which reads can change: unknown metadata stays conservative, and relational projections stay broad. */
export function affected(key: readonly unknown[], change: Change): boolean {
	const { op, touched } = change;
	const changes = op ? writes.get(op) : undefined;
	if (!changes) return true;
	if (touched.some((ref) => !/^[CQRPT]-\d+$/.test(ref) && ref !== "policy" && ref !== "folders")) return true;
	const read = key[1];
	const input = key[2];
	if (read === "teams") return false;
	if (read === "attachment") return changes.attachments;
	if (read === "admin") {
		const method = Administration.safeParse(input);
		if (!method.success) return true;
		if (staticAdministration.has(method.data.do)) return false;
		if (method.data.do === "policy.show") return touched.length === 0 || touched.includes("policy");
		// Token last-use metadata changes with authenticated project calls, without a token ref in touched.
		return true;
	}
	if (read === "find") {
		const collection = Collection.safeParse(input);
		if (!collection.success) return true;
		if (collection.data.in === "deployments") return changes.deployments;
		if (suiteOnly[collection.data.in])
			return touched.length === 0 || touched.some((ref) => ref.startsWith("C-") || ref === "folders");
		return true;
	}
	if (read === "inbox" || read === "gate" || read === "impact" || read === "stats") return true;
	// A rejection may touch only its question; a case timeline projects that question too.
	if (read === "timeline" && (op === "propose" || touched.some((ref) => ref.startsWith("Q-")))) return true;
	if ((read === "get" || read === "timeline") && op === "report") return true;
	// A waiting proposal projects its cases now. A question's decision can change the proposal's standing.
	if (
		read === "get" &&
		contains(input, (value) => /^P-\d+$/.test(value)) &&
		touched.some((ref) => ref.startsWith("C-") || ref.startsWith("Q-"))
	)
		return true;
	return (
		touched.length === 0 ||
		touched.includes("policy") ||
		touched.includes("folders") ||
		contains(input, (value) => touched.includes(value))
	);
}
