// Spans for the work this process does. The code names spans through the OpenTelemetry API alone, which does
// nothing until the instance registers an exporter (`src/app/telemetry.ts`), so tests and CLI commands pay nothing.
//
// A span leaves the instance, so it carries what the code knows about itself (an operation's name, a route's
// pattern, a statement declared in the source) and never what a caller sent: no message, value, key or name.
import {
	type Attributes,
	context,
	INVALID_SPAN_CONTEXT,
	ROOT_CONTEXT,
	type Span,
	SpanKind,
	SpanStatusCode,
	trace,
} from "@opentelemetry/api";
import { VERSION } from "../../core/version.ts";
import type { Tracing } from "./db.ts";

/**
 * Where a span goes. `root` starts a trace whatever is running, as a request does: a caller's `traceparent` is
 * not taken. `nested` is a child of the running span, or a root without one. `under-parent` is made only inside
 * a running span: a statement or a connection wait that no request or job asked for (a job poll, a lock wait)
 * would otherwise make a trace of its own every few seconds.
 */
export type Placement = "root" | "nested" | "under-parent";
export type Kind = "server" | "client" | "internal";
const KINDS = { server: SpanKind.SERVER, client: SpanKind.CLIENT, internal: SpanKind.INTERNAL } as const;

/** The trace each failed span's error belonged to, for the log line written where the context is gone. */
const traces = new WeakMap<object, string>();

/** What kind of failure this is, without its text, which can quote a value. */
export const errorType = (error: unknown): string =>
	error instanceof Error ? error.name : error === null ? "null" : typeof error;

function failed(span: Span, error: unknown): void {
	if (!span.isRecording()) return;
	if (typeof error === "object" && error !== null) traces.set(error, span.spanContext().traceId);
	span.setAttribute("error.type", errorType(error));
	span.setStatus({ code: SpanStatusCode.ERROR });
}

/**
 * Runs `fn` in a span named `name`, ending the span when `fn` returns or its promise settles. A thrown error or a
 * rejection marks the span failed by its type alone and passes on unchanged. A function that answers at once
 * still answers at once.
 */
export function withSpan<T>(
	name: string,
	attributes: Attributes,
	fn: (span: Span) => T,
	placement: Placement = "nested",
	kind: Kind = "internal",
): T {
	const parent = placement === "root" ? ROOT_CONTEXT : context.active();
	if (placement === "under-parent" && !trace.getSpan(parent)?.isRecording())
		return fn(trace.wrapSpanContext(INVALID_SPAN_CONTEXT));
	// Asked each time: the provider is registered after this module loads, and again after a restart.
	const span = trace.getTracer("mainworthy", VERSION).startSpan(name, { kind: KINDS[kind], attributes }, parent);
	let result: T;
	try {
		result = context.with(trace.setSpan(parent, span), fn, undefined, span);
	} catch (error) {
		failed(span, error);
		span.end();
		throw error;
	}
	if (!(result instanceof Promise)) {
		span.end();
		return result;
	}
	return result.then(
		(value) => {
			span.end();
			return value;
		},
		(error: unknown) => {
			failed(span, error);
			span.end();
			throw error;
		},
	) as T;
}

/** Marks the running span failed with `type`, for a failure that is a reply and not a thrown error. */
export function markFailed(span: Span, type: string): void {
	span.setAttribute("error.type", type);
	span.setStatus({ code: SpanStatusCode.ERROR });
}

/** The running trace, for a log line, or null when nothing is traced. */
export function currentTrace(): string | null {
	const span = trace.getSpan(context.active());
	return span?.isRecording() ? span.spanContext().traceId : null;
}

/** The trace a failed span's error belonged to, or the running one. */
export const traceOf = (error: unknown): string | null =>
	(typeof error === "object" && error !== null ? traces.get(error) : undefined) ?? currentTrace();

/** ` (trace <id>)` for a log line, or nothing when untraced. */
export const traceNote = (error?: unknown): string => {
	const id = error === undefined ? currentTrace() : traceOf(error);
	return id ? ` (trace ${id})` : "";
};

/** What a database is given to trace its statements and connection waits (`Database.open`). */
export const databaseTracing: Tracing = { span: withSpan, note: () => traceNote() };
