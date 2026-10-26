import type { ReportSpan } from "../../core/ops.ts";

// When a report's tests started and ended, as its runner wrote it (issue #722). Read only where the format says it
// unambiguously; anything else leaves the span out and keeps the results.

/** A span from a start and a length in milliseconds, or none when either is unusable. */
export function spanOf(startedAt: number, durationMs: number): ReportSpan | undefined {
	const start = Math.round(startedAt);
	const end = Math.round(startedAt + durationMs);
	return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end >= start
		? { startedAt: start, endedAt: end }
		: undefined;
}

/**
 * An ISO 8601 time that names its zone, in milliseconds; a time without one is local to an unknown machine. A date
 * the calendar does not have, such as February 30, is no time: `Date.parse` would roll it into March.
 */
export function zonedTime(text: string): number | "no zone" | undefined {
	const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:[.,](\d+))?(?:(Z)|([+-])(\d{2}):?(\d{2}))?$/i.exec(
		text.trim(),
	);
	if (!match) return undefined;
	const [year, month, day, hour, minute, second, offsetHours, offsetMinutes] = [1, 2, 3, 4, 5, 6, 10, 11].map((i) =>
		Number(match[i] ?? 0),
	) as [number, number, number, number, number, number, number, number];
	const date = new Date(Date.UTC(year, month - 1, day));
	if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59)
		return undefined;
	if (match[8] === undefined && match[9] === undefined) return "no zone";
	if (offsetHours > 23 || offsetMinutes > 59) return undefined;
	// Whole milliseconds, the rest cut off, as Date.parse reads them.
	const fraction = Number((match[7] ?? "").slice(0, 3).padEnd(3, "0"));
	const offset = (match[9] === "-" ? -1 : 1) * (offsetHours * 60 + offsetMinutes) * 60_000;
	return Date.UTC(year, month - 1, day, hour, minute, second) + fraction - offset;
}

/** The span of several files sent as one report: from the first start to the last end, when every file has one. */
export function joinSpans(spans: readonly (ReportSpan | undefined)[]): ReportSpan | undefined {
	let joined: ReportSpan | undefined;
	for (const span of spans) {
		if (span === undefined) return undefined;
		joined = joined
			? { startedAt: Math.min(joined.startedAt, span.startedAt), endedAt: Math.max(joined.endedAt, span.endedAt) }
			: span;
	}
	return joined;
}

export const SPAN_UNUSABLE = "the report's start and end times are unusable; no reported span is kept";
