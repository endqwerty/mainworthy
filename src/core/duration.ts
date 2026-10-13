// How long from now, as a person writes it in a setting: `12h`, `14d`, `2w`. One syntax and one reader, so a
// lifetime means the same in the environment, on the command line and in a form.

const UNIT_MS = { h: 3_600_000, d: 86_400_000, w: 604_800_000 } as const;
const isUnit = (text: string): text is keyof typeof UNIT_MS => Object.hasOwn(UNIT_MS, text);

/** What a refusal tells the person who wrote the value. */
export const DURATION_FORMAT = "a whole number from 1 to 9999 and h, d or w, like 12h, 14d or 2w";

/** The syntax itself, for a schema that describes an input: the API's description shows it to whoever reads it. */
export const DURATION_PATTERN = /^([1-9]\d{0,3})([hdw])$/;

/**
 * The milliseconds a duration stands for, or null when the text is not one. Hours, days and weeks, and no
 * smaller unit: nothing that takes a duration here is meant to last minutes. No zero, no sign, no fraction and
 * no space, so a value that was mistyped is refused where a lenient reader would guess.
 */
export function durationMs(text: string): number | null {
	const match = DURATION_PATTERN.exec(text);
	const [, count, unit] = match ?? [];
	if (count === undefined || unit === undefined || !isUnit(unit)) return null;
	return Number(count) * UNIT_MS[unit];
}

/**
 * How long from `now` until `at`, as a sentence says it: "in 13 days", "in 5 hours", "in under an hour". Days
 * from two days up, hours below that, each rounded to the nearest, so a token made for `90d` a moment ago ends
 * "in 90 days". Null when `at` is not after `now`: what has ended has no time left to name.
 */
export function untilPhrase(at: number, now: number): string | null {
	const left = at - now;
	if (left <= 0) return null;
	if (left < UNIT_MS.h) return "in under an hour";
	if (left < 2 * UNIT_MS.d) {
		const hours = Math.round(left / UNIT_MS.h);
		return `in ${hours} ${hours === 1 ? "hour" : "hours"}`;
	}
	return `in ${Math.round(left / UNIT_MS.d)} days`;
}
