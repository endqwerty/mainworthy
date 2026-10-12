// Text that is safe to store and to cut. JavaScript strings are UTF-16: a character outside the basic plane (most
// emoji) is two units, and half of one is not valid text. Stored, it cannot be written as UTF-8, which the archive
// and every client rely on.

const isHigh = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff;

/** At most the first `max` units of a text, never ending in the first half of a two-unit character. */
export function clip(text: string, max: number): string {
	if (text.length <= max) return text;
	return text.slice(0, max > 0 && isHigh(text.charCodeAt(max - 1)) ? max - 1 : max);
}

/** At most the last `max` units of a text, never starting in the second half of a two-unit character. */
export function clipEnd(text: string, max: number): string {
	if (text.length <= max) return text;
	const start = text.length - max;
	const low = text.charCodeAt(start);
	return text.slice(low >= 0xdc00 && low <= 0xdfff ? start + 1 : start);
}

/**
 * The path of the first string in a value that holds half a character (an unpaired surrogate), or null. Called on
 * every operation's input, so no such text enters the record through any field.
 */
export function malformedText(value: unknown, path = ""): string | null {
	if (typeof value === "string") return value.isWellFormed() ? null : path || "input";
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			const found = malformedText(value[i], `${path}[${i}]`);
			if (found) return found;
		}
		return null;
	}
	if (typeof value === "object" && value !== null) {
		for (const [key, inner] of Object.entries(value)) {
			if (!key.isWellFormed()) return path || "input";
			const found = malformedText(inner, path ? `${path}.${key}` : key);
			if (found) return found;
		}
	}
	return null;
}
