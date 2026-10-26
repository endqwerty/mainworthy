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

/** An ISO 8601 time that names its zone, in milliseconds; a time without one is local to an unknown machine. */
export function zonedTime(text: string): number | "no zone" | undefined {
	const match = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(Z|[+-]\d{2}:?\d{2})?$/i.exec(text.trim());
	if (!match) return undefined;
	if (match[1] === undefined) return "no zone";
	const ms = Date.parse(text.trim().replace(",", "."));
	return Number.isFinite(ms) ? ms : undefined;
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
