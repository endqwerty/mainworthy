// How long from now, as a person writes it in a setting: `12h`, `14d`, `2w`. One syntax and one reader, so a
// lifetime means the same in the environment, on the command line and in a form.

const UNIT_MS = { h: 3_600_000, d: 86_400_000, w: 604_800_000 } as const;
const isUnit = (text: string): text is keyof typeof UNIT_MS => Object.hasOwn(UNIT_MS, text);

/** What a refusal tells the person who wrote the value. */
export const DURATION_FORMAT = "a whole number from 1 to 9999 and h, d or w, like 12h, 14d or 2w";

/**
 * The milliseconds a duration stands for, or null when the text is not one. Hours, days and weeks, and no
 * smaller unit: nothing that takes a duration here is meant to last minutes. No zero, no sign, no fraction and
 * no space, so a value that was mistyped is refused where a lenient reader would guess.
 */
export function durationMs(text: string): number | null {
	const match = /^([1-9]\d{0,3})([hdw])$/.exec(text);
	const [, count, unit] = match ?? [];
	if (count === undefined || unit === undefined || !isUnit(unit)) return null;
	return Number(count) * UNIT_MS[unit];
}
