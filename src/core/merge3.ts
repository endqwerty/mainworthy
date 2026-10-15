import { movedStepIds } from "./diff.ts";
import { canonicalJson } from "./hash.ts";
import type { CaseBody, Step } from "./model.ts";

export type Conflict = { path: string; base: unknown; mine: unknown; theirs: unknown };
export type MergeResult = { merged: CaseBody; conflicts: Conflict[] };

function equal({ a, b }: { a: unknown; b: unknown }): boolean {
	if (Object.is(a, b)) return true;
	if (a === undefined || b === undefined) return false;
	return canonicalJson(a) === canonicalJson(b);
}

function mergeField<T>({
	path,
	base,
	mine,
	theirs,
	conflicts,
}: {
	path: string;
	base: T;
	mine: T;
	theirs: T;
	conflicts: Conflict[];
}): T {
	if (equal({ a: mine, b: theirs }) || equal({ a: theirs, b: base })) return mine;
	if (equal({ a: mine, b: base })) return theirs;
	conflicts.push({ path, base, mine, theirs });
	return mine;
}

function insertionIndex({
	ordered,
	source,
	index,
	present,
}: {
	ordered: string[];
	source: string[];
	index: number;
	present: ReadonlySet<string>;
}): number {
	let previous = -1;
	let next = -1;
	for (let i = index - 1; i >= 0; i--) {
		const candidate = source[i];
		if (candidate !== undefined && present.has(candidate)) {
			previous = ordered.indexOf(candidate);
			break;
		}
	}
	for (let i = index + 1; i < source.length; i++) {
		const candidate = source[i];
		if (candidate !== undefined && present.has(candidate)) {
			next = ordered.indexOf(candidate);
			break;
		}
	}
	return next >= 0 && (previous < 0 || previous < next) ? next : previous >= 0 ? previous + 1 : ordered.length;
}

/** Applies a chosen field to the working merge. An explicit order is applied last, preserving other additions. */
export function applyMergeChoice({
	merged,
	source,
	path,
	order,
}: {
	merged: CaseBody;
	source: CaseBody;
	path: string;
	order?: Step[] | undefined;
}): CaseBody {
	let result = merged;
	switch (path) {
		case "title":
			result = { ...merged, title: source.title };
			break;
		case "pre":
			result = { ...merged, pre: source.pre };
			break;
		case "methods":
			result = { ...merged, methods: [...source.methods] };
			break;
		case "automate":
			result = { ...merged, automate: source.automate };
			break;
		case "steps.order":
			order = source.steps;
			break;
		default: {
			if (path.startsWith("fields.")) {
				const key = path.slice(7);
				const fields = { ...merged.fields };
				if (Object.hasOwn(source.fields, key) && source.fields[key] !== undefined) fields[key] = source.fields[key];
				else delete fields[key];
				result = { ...merged, fields };
				break;
			}
			const [kind, id, part, extra] = path.split(".");
			if (kind !== "steps" || !id || extra !== undefined) break;
			const step = source.steps.find((item) => item.id === id);
			if (part === undefined) {
				const steps = merged.steps.filter((item) => item.id !== id);
				if (step) {
					const position = merged.steps.findIndex((item) => item.id === id);
					steps.splice(
						position >= 0
							? position
							: insertionIndex({
									ordered: steps.map((item) => item.id),
									source: source.steps.map((item) => item.id),
									index: source.steps.indexOf(step),
									present: new Set(steps.map((item) => item.id)),
								}),
						0,
						{ ...step },
					);
				}
				result = { ...merged, steps };
			} else if (step && (part === "action" || part === "expected")) {
				result = {
					...merged,
					steps: merged.steps.map((item) =>
						item.id === id
							? part === "action"
								? { ...item, action: step.action }
								: { ...item, expected: step.expected }
							: item,
					),
				};
			}
		}
	}
	if (order) {
		const steps = order.flatMap((item) => result.steps.filter((step) => step.id === item.id));
		const ids = new Set(steps.map((item) => item.id));
		result = { ...result, steps: [...steps, ...result.steps.filter((item) => !ids.has(item.id))] };
	}
	return result;
}

function mergeOrder({
	base,
	mine,
	theirs,
	kept,
	conflicts,
}: {
	base: Step[];
	mine: Step[];
	theirs: Step[];
	kept: ReadonlyMap<string, Step>;
	conflicts: Conflict[];
}): string[] {
	const baseIds = base.map((step) => step.id);
	const mineIds = mine.map((step) => step.id).filter((id) => kept.has(id));
	const theirsIds = theirs.map((step) => step.id).filter((id) => kept.has(id));
	const common = new Set(mineIds.filter((id) => theirsIds.includes(id)));
	const originalSet = new Set(baseIds);
	const original = baseIds.filter((id) => common.has(id));
	const mineOriginal = mineIds.filter((id) => common.has(id) && originalSet.has(id));
	const theirsOriginal = theirsIds.filter((id) => common.has(id) && originalSet.has(id));
	const mineChanged = !equal({ a: original, b: mineOriginal });
	const theirsChanged = !equal({ a: original, b: theirsOriginal });
	const mineCommon = mineIds.filter((id) => common.has(id));
	const theirsCommon = theirsIds.filter((id) => common.has(id));
	const sharedAddition = mineCommon.some((id) => !originalSet.has(id));
	const orderConflict =
		!equal({ a: mineCommon, b: theirsCommon }) && ((mineChanged && theirsChanged) || sharedAddition);
	if (orderConflict)
		conflicts.push({
			path: "steps.order",
			base: baseIds,
			mine: mine.map((s) => s.id),
			theirs: theirs.map((s) => s.id),
		});
	const preferTheirs = !orderConflict && !mineChanged && theirsChanged;
	const ordered = [...(preferTheirs ? theirsIds : mineIds)];
	const secondary = preferTheirs ? mineIds : theirsIds;
	const present = new Set(ordered);
	for (const [index, id] of secondary.entries()) {
		if (present.has(id)) continue;
		ordered.splice(insertionIndex({ ordered, source: secondary, index, present }), 0, id);
		present.add(id);
	}
	return ordered;
}

/** Merges fields and unique step identities against base. Conflicts retain mine, including its deletion and ordering choices. */
export function mergeBodies({ base, mine, theirs }: { base: CaseBody; mine: CaseBody; theirs: CaseBody }): MergeResult {
	const conflicts: Conflict[] = [];
	const title = mergeField({ path: "title", base: base.title, mine: mine.title, theirs: theirs.title, conflicts });
	const pre = mergeField({ path: "pre", base: base.pre, mine: mine.pre, theirs: theirs.pre, conflicts });
	const methods = mergeField({
		path: "methods",
		base: base.methods,
		mine: mine.methods,
		theirs: theirs.methods,
		conflicts,
	});
	const automate = mergeField({
		path: "automate",
		base: base.automate,
		mine: mine.automate,
		theirs: theirs.automate,
		conflicts,
	});
	const fields: [string, string][] = [];
	const fieldKeys = new Set([...Object.keys(base.fields), ...Object.keys(mine.fields), ...Object.keys(theirs.fields)]);
	for (const key of fieldKeys) {
		const ownValue = ({ body }: { body: CaseBody }): string | undefined =>
			Object.hasOwn(body.fields, key) ? body.fields[key] : undefined;
		const value = mergeField({
			path: `fields.${key}`,
			base: ownValue({ body: base }),
			mine: ownValue({ body: mine }),
			theirs: ownValue({ body: theirs }),
			conflicts,
		});
		if (value !== undefined) fields.push([key, value]);
	}
	const original = new Map(base.steps.map((step) => [step.id, step]));
	const local = new Map(mine.steps.map((step) => [step.id, step]));
	const remote = new Map(theirs.steps.map((step) => [step.id, step]));
	const mineMoved = movedStepIds({ before: base.steps, after: mine.steps });
	const theirsMoved = movedStepIds({ before: base.steps, after: theirs.steps });
	const kept = new Map<string, Step>();
	const ids = new Set([...original.keys(), ...local.keys(), ...remote.keys()]);
	for (const id of ids) {
		const before = original.get(id);
		const ours = local.get(id);
		const other = remote.get(id);
		if (!ours && !other) continue;
		if (!before) {
			if (ours && other) {
				const action = mergeField<string | undefined>({
					path: `steps.${id}.action`,
					base: undefined,
					mine: ours.action,
					theirs: other.action,
					conflicts,
				});
				const expected = mergeField<string | null | undefined>({
					path: `steps.${id}.expected`,
					base: undefined,
					mine: ours.expected,
					theirs: other.expected,
					conflicts,
				});
				kept.set(id, { id, action: action ?? ours.action, expected: expected ?? null });
			} else if (ours || other) {
				const added = ours ?? other;
				if (added) kept.set(id, { ...added });
			}
			continue;
		}
		if (!ours || !other) {
			const survivor = ours ?? other;
			const moved = ours ? mineMoved.has(id) : theirsMoved.has(id);
			if (survivor && (!equal({ a: before, b: survivor }) || moved)) {
				conflicts.push({ path: `steps.${id}`, base: before, mine: ours, theirs: other });
				if (ours) kept.set(id, { ...ours });
			}
			continue;
		}
		kept.set(id, {
			id,
			action: mergeField({
				path: `steps.${id}.action`,
				base: before.action,
				mine: ours.action,
				theirs: other.action,
				conflicts,
			}),
			expected: mergeField({
				path: `steps.${id}.expected`,
				base: before.expected,
				mine: ours.expected,
				theirs: other.expected,
				conflicts,
			}),
		});
	}
	const order = mergeOrder({ base: base.steps, mine: mine.steps, theirs: theirs.steps, kept, conflicts });
	const steps: Step[] = [];
	for (const id of order) {
		const step = kept.get(id);
		if (step) steps.push(step);
	}
	return {
		merged: { title, pre, methods: [...methods], automate, fields: Object.fromEntries(fields), steps },
		conflicts,
	};
}
