// How the reports write their numbers.

/** A rate as a percentage. Near the ends it keeps a decimal, so one failure in a thousand never reads as 100%. */
export function percent(rate: number | null): string {
	if (rate === null) return "none";
	const p = rate * 100;
	const shown = p > 99 && p < 100 ? Math.floor(p * 10) / 10 : p > 0 && p < 1 ? Math.ceil(p * 10) / 10 : Math.round(p);
	return `${shown}%`;
}

/** A length of time, in the largest unit that keeps it readable. */
export function spent(ms: number): string {
	if (ms < 1000) return `${ms} ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
	const minutes = Math.round(ms / 60_000);
	return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** A number and the noun it counts, which takes an s for any number but one. */
export const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;
