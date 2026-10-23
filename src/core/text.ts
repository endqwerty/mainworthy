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

/** Escape terminal controls; JSON serialization may preserve its structural line breaks. */
export function escapeControls(text: string, options: { preserveNewlines?: boolean } = {}): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: these controls must be escaped before terminal output.
	return text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, (char) =>
		options.preserveNewlines && char === "\n" ? char : `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
}

/** Preserve JSON values while escaping controls JSON.stringify leaves literal; an absent value becomes null. */
export function reportJson(value: unknown, space?: number): string {
	return escapeControls(JSON.stringify(value, null, space) ?? "null", { preserveNewlines: true });
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
