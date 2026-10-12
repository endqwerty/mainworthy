import { canonicalJson } from "./hash.ts";
import type { CaseBody, Step } from "./model.ts";

export type FieldDiff<T> = { kind: "same"; before: T; after: T } | { kind: "changed"; before: T; after: T };
export type WordSegment = { op: "eq" | "del" | "ins"; text: string };
export type TextDiff =
	| { kind: "same"; before: string | null; after: string | null }
	| { kind: "changed"; before: string | null; after: string | null; segments: WordSegment[] };
type ExistingStepDiff = { id: string; before: Step; after: Step; from: number; to: number };
type OrderNode = { id: string; rank: number; previous: OrderNode | null };
export type StepDiff =
	| (ExistingStepDiff & { kind: "same" })
	| { kind: "added"; id: string; after: Step; to: number }
	| { kind: "removed"; id: string; before: Step; from: number }
	| (ExistingStepDiff & { kind: "moved" })
	| (ExistingStepDiff & { kind: "changed"; moved: boolean; action: TextDiff; expected: TextDiff });
export type BodyDiff = {
	title: FieldDiff<CaseBody["title"]>;
	pre: FieldDiff<CaseBody["pre"]>;
	methods: FieldDiff<CaseBody["methods"]>;
	automate: FieldDiff<CaseBody["automate"]>;
	fields: FieldDiff<CaseBody["fields"]>;
	steps: StepDiff[];
};

function fieldDiff<T>({ before, after }: { before: T; after: T }): FieldDiff<T> {
	return {
		kind: Object.is(before, after) || canonicalJson(before) === canonicalJson(after) ? "same" : "changed",
		before,
		after,
	};
}

/** Identifies a minimal set of relative moves, retaining a longest increasing subsequence of shared step identities. */
export function movedStepIds({ before, after }: { before: readonly Step[]; after: readonly Step[] }): Set<string> {
	const original = new Map(before.map((step, index) => [step.id, index]));
	const tails: OrderNode[] = [];
	for (const step of after) {
		const rank = original.get(step.id);
		if (rank === undefined) continue;
		let low = 0;
		let high = tails.length;
		while (low < high) {
			const mid = (low + high) >>> 1;
			const tail = tails[mid];
			if (tail && tail.rank < rank) low = mid + 1;
			else high = mid;
		}
		tails[low] = { id: step.id, rank, previous: low === 0 ? null : (tails[low - 1] ?? null) };
	}
	const stable = new Set<string>();
	let node = tails.at(-1) ?? null;
	while (node) {
		stable.add(node.id);
		node = node.previous;
	}
	return new Set(after.filter((step) => original.has(step.id) && !stable.has(step.id)).map((step) => step.id));
}

/** Returns lossless word segments. LCS uses at most 262,144 cells; larger unmatched middles become one replacement. */
export function diffWords({ before, after }: { before: string; after: string }): WordSegment[] {
	if (before === after) return before === "" ? [] : [{ op: "eq", text: before }];
	const originalLeft = before.match(/\s+|\S+/g) ?? [];
	const originalRight = after.match(/\s+|\S+/g) ?? [];
	let prefix = 0;
	while (
		prefix < originalLeft.length &&
		prefix < originalRight.length &&
		originalLeft[prefix] === originalRight[prefix]
	)
		prefix++;
	let suffix = 0;
	while (
		suffix < originalLeft.length - prefix &&
		suffix < originalRight.length - prefix &&
		originalLeft[originalLeft.length - suffix - 1] === originalRight[originalRight.length - suffix - 1]
	)
		suffix++;
	const left = originalLeft.slice(prefix, originalLeft.length - suffix);
	const right = originalRight.slice(prefix, originalRight.length - suffix);
	const segments: WordSegment[] = [];
	function append({ op, text }: WordSegment): void {
		const last = segments.at(-1);
		if (last?.op === op) last.text += text;
		else if (text.length > 0) segments.push({ op, text });
	}
	append({ op: "eq", text: originalLeft.slice(0, prefix).join("") });
	const stride = right.length + 1;
	const cells = (left.length + 1) * stride;
	if (cells > 262_144) {
		append({ op: "del", text: left.join("") });
		append({ op: "ins", text: right.join("") });
		append({ op: "eq", text: originalLeft.slice(originalLeft.length - suffix).join("") });
		return segments;
	}
	const lcs = new Uint32Array(cells);
	for (let i = left.length - 1; i >= 0; i--) {
		for (let j = right.length - 1; j >= 0; j--) {
			lcs[i * stride + j] =
				left[i] === right[j]
					? 1 + (lcs[(i + 1) * stride + j + 1] ?? 0)
					: Math.max(lcs[(i + 1) * stride + j] ?? 0, lcs[i * stride + j + 1] ?? 0);
		}
	}
	let i = 0;
	let j = 0;
	while (i < left.length || j < right.length) {
		const a = left[i];
		const b = right[j];
		if (a !== undefined && b !== undefined && a === b) {
			append({ op: "eq", text: a });
			i++;
			j++;
		} else if (
			a !== undefined &&
			(b === undefined || (lcs[(i + 1) * stride + j] ?? 0) >= (lcs[i * stride + j + 1] ?? 0))
		) {
			append({ op: "del", text: a });
			i++;
		} else if (b !== undefined) {
			append({ op: "ins", text: b });
			j++;
		}
	}
	append({ op: "eq", text: originalLeft.slice(originalLeft.length - suffix).join("") });
	return segments;
}

function textDiff({ before, after }: { before: string | null; after: string | null }): TextDiff {
	return before === after
		? { kind: "same", before, after }
		: { kind: "changed", before, after, segments: diffWords({ before: before ?? "", after: after ?? "" }) };
}

/** Compares full bodies, anchoring unique steps by id. Neighbour additions/removals alone do not count as moves. */
export function diffBodies(a: CaseBody, b: CaseBody): BodyDiff {
	const before = new Map(a.steps.map((step, index) => [step.id, { step, index }]));
	const after = new Map(b.steps.map((step, index) => [step.id, { step, index }]));
	const movedIds = movedStepIds({ before: a.steps, after: b.steps });
	const steps: StepDiff[] = [];
	for (const [to, step] of b.steps.entries()) {
		const old = before.get(step.id);
		if (!old) {
			steps.push({ kind: "added", id: step.id, after: step, to });
			continue;
		}
		const common: ExistingStepDiff = { id: step.id, before: old.step, after: step, from: old.index, to };
		const moved = movedIds.has(step.id);
		if (old.step.action !== step.action || old.step.expected !== step.expected) {
			steps.push({
				...common,
				kind: "changed",
				moved,
				action: textDiff({ before: old.step.action, after: step.action }),
				expected: textDiff({ before: old.step.expected, after: step.expected }),
			});
		} else steps.push({ ...common, kind: moved ? "moved" : "same" });
	}
	for (const [from, step] of a.steps.entries()) {
		if (!after.has(step.id)) steps.push({ kind: "removed", id: step.id, before: step, from });
	}
	return {
		title: fieldDiff({ before: a.title, after: b.title }),
		pre: fieldDiff({ before: a.pre, after: b.pre }),
		methods: fieldDiff({ before: a.methods, after: b.methods }),
		automate: fieldDiff({ before: a.automate, after: b.automate }),
		fields: fieldDiff({ before: a.fields, after: b.fields }),
		steps,
	};
}

/** True exactly when the diff contains no value, membership or relative-order change. */
export function isEmptyDiff(diff: BodyDiff): boolean {
	return (
		diff.title.kind === "same" &&
		diff.pre.kind === "same" &&
		diff.methods.kind === "same" &&
		diff.automate.kind === "same" &&
		diff.fields.kind === "same" &&
		diff.steps.every((step) => step.kind === "same")
	);
}

/** Applies all after-values and order to a body without mutating either argument. */
export function applyDiff({ body, diff }: { body: CaseBody; diff: BodyDiff }): CaseBody {
	const steps: { to: number; step: Step }[] = [];
	for (const entry of diff.steps) {
		switch (entry.kind) {
			case "same":
			case "added":
			case "changed":
			case "moved":
				steps.push({ to: entry.to, step: { ...entry.after } });
				break;
			case "removed":
				break;
			default: {
				const exhaustive: never = entry;
				return exhaustive;
			}
		}
	}
	return {
		...body,
		title: diff.title.after,
		pre: diff.pre.after,
		methods: [...diff.methods.after],
		automate: diff.automate.after,
		fields: Object.fromEntries(Object.entries(diff.fields.after)),
		steps: steps.sort((a, b) => a.to - b.to).map(({ step }) => step),
	};
}

/** Returns one compact history line naming changed fields and counting additions, removals and moves. */
export function summariseDiff(diff: BodyDiff): string {
	const parts: string[] = [];
	for (const key of ["title", "pre", "methods", "automate", "fields"] satisfies (keyof Omit<BodyDiff, "steps">)[]) {
		if (diff[key].kind === "changed") parts.push(key);
	}
	let added = 0;
	let removed = 0;
	let moved = 0;
	for (const step of diff.steps) {
		switch (step.kind) {
			case "same":
				break;
			case "added":
				added++;
				break;
			case "removed":
				removed++;
				break;
			case "moved":
				moved++;
				break;
			case "changed":
				if (step.action.kind === "changed") parts.push(`${step.id}.action`);
				if (step.expected.kind === "changed") parts.push(`${step.id}.expected`);
				if (step.moved) moved++;
				break;
			default: {
				const exhaustive: never = step;
				return exhaustive;
			}
		}
	}
	if (added > 0) parts.push(`+${added} step${added === 1 ? "" : "s"}`);
	if (removed > 0) parts.push(`-${removed} step${removed === 1 ? "" : "s"}`);
	if (moved > 0) parts.push(`↕${moved} step${moved === 1 ? "" : "s"}`);
	return parts.join(", ") || "no changes";
}
