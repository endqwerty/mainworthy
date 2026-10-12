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
		let previous = -1;
		let next = -1;
		for (let i = index - 1; i >= 0; i--) {
			const candidate = secondary[i];
			if (candidate !== undefined && present.has(candidate)) {
				previous = ordered.indexOf(candidate);
				break;
			}
		}
		for (let i = index + 1; i < secondary.length; i++) {
			const candidate = secondary[i];
			if (candidate !== undefined && present.has(candidate)) {
				next = ordered.indexOf(candidate);
				break;
			}
		}
		const position =
			next >= 0 && (previous < 0 || previous < next) ? next : previous >= 0 ? previous + 1 : ordered.length;
		ordered.splice(position, 0, id);
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
