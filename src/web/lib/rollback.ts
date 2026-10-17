import { z } from "zod";

type Fields = Record<string, unknown>;
const Tags = z.array(z.string());
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const tagsOf = (value: unknown): string[] => {
	const parsed = Tags.safeParse(value);
	return parsed.success ? parsed.data : [];
};

/**
 * Undoes an optimistic change to a row against the row as it is now, not as it was before the change: the
 * stream or a later change may have rewritten it since. `before` and `after` are the row either side of the
 * change. A tag the change added is removed only if it is still there, a tag it removed is put back only if
 * it is still gone, and any other field goes back only if it still holds what the change left.
 */
export function undoChange(current: Fields, before: Fields, after: Fields): Fields {
	let next = current;
	for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
		if (same(before[key], after[key])) continue;
		if (key === "tags") {
			const was = new Set(tagsOf(before.tags));
			const left = new Set(tagsOf(after.tags));
			const tags = new Set(tagsOf(current.tags));
			for (const tag of left) if (!was.has(tag)) tags.delete(tag);
			for (const tag of was) if (!left.has(tag)) tags.add(tag);
			next = { ...next, tags: [...tags] };
		} else if (same(current[key], after[key])) next = { ...next, [key]: before[key] };
	}
	return next;
}
