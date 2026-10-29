// A collector for one machine: receives the spans a server sends over OTLP/HTTP as JSON and prints each trace as a
// tree. The telemetry tests read the same receiver.
//
//   bun scripts/traces.ts      listens on a free port and prints the variable to start the server with
import { gunzipSync } from "bun";

export type ReceivedSpan = {
	traceId: string;
	spanId: string;
	parentSpanId: string | null;
	name: string;
	kind: number;
	startNs: bigint;
	endNs: bigint;
	attributes: Record<string, unknown>;
	/** 0 unset, 1 ok, 2 error. */
	status: number;
	resource: Record<string, unknown>;
};

type AnyValue = {
	stringValue?: string;
	intValue?: string | number;
	doubleValue?: number;
	boolValue?: boolean;
	arrayValue?: { values?: AnyValue[] };
};
type KeyValue = { key: string; value: AnyValue };
type Body = {
	resourceSpans?: {
		resource?: { attributes?: KeyValue[] };
		scopeSpans?: {
			spans?: {
				traceId: string;
				spanId: string;
				parentSpanId?: string;
				name: string;
				kind?: number;
				startTimeUnixNano: string;
				endTimeUnixNano: string;
				attributes?: KeyValue[];
				status?: { code?: number };
			}[];
		}[];
	}[];
};

const plain = (value: AnyValue): unknown =>
	value.stringValue ??
	(value.intValue !== undefined ? Number(value.intValue) : undefined) ??
	value.doubleValue ??
	value.boolValue ??
	value.arrayValue?.values?.map(plain);
const attributesOf = (list: KeyValue[] = []): Record<string, unknown> =>
	Object.fromEntries(list.map(({ key, value }) => [key, plain(value)]));

export function spansOf(body: string): ReceivedSpan[] {
	const parsed = JSON.parse(body) as Body;
	return (parsed.resourceSpans ?? []).flatMap((group) => {
		const resource = attributesOf(group.resource?.attributes);
		return (group.scopeSpans ?? []).flatMap((scope) =>
			(scope.spans ?? []).map((span) => ({
				traceId: span.traceId,
				spanId: span.spanId,
				parentSpanId: span.parentSpanId || null,
				name: span.name,
				kind: span.kind ?? 0,
				startNs: BigInt(span.startTimeUnixNano),
				endNs: BigInt(span.endTimeUnixNano),
				attributes: attributesOf(span.attributes),
				status: span.status?.code ?? 0,
				resource,
			})),
		);
	});
}

/** `ok` takes every request; `refuse` answers 400, which a sender does not retry; `silent` never answers. */
export type Answer = "ok" | "refuse" | "silent";

export function receiver(answer: Answer = "ok", onSpans?: (spans: ReceivedSpan[]) => void) {
	const bodies: string[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		idleTimeout: 0,
		async fetch(req) {
			if (new URL(req.url).pathname !== "/v1/traces" || req.method !== "POST")
				return new Response("not found", { status: 404 });
			if (answer === "silent") return await new Promise<Response>(() => undefined);
			if (answer === "refuse") return new Response("refused", { status: 400 });
			const bytes = new Uint8Array(await req.arrayBuffer());
			const body = new TextDecoder().decode(req.headers.get("content-encoding") === "gzip" ? gunzipSync(bytes) : bytes);
			bodies.push(body);
			onSpans?.(spansOf(body));
			return Response.json({});
		},
	});
	return {
		url: `http://127.0.0.1:${server.port}`,
		/** Every request body as sent, to search for what must never leave the instance. */
		bodies,
		spans: (): ReceivedSpan[] => bodies.flatMap(spansOf),
		stop: () => server.stop(true),
	};
}

/** One line per span, children under their parent, with milliseconds. */
export function treeOf(spans: readonly ReceivedSpan[]): string[] {
	const ids = new Set(spans.map((span) => span.spanId));
	const children = Map.groupBy(spans, (span) =>
		span.parentSpanId && ids.has(span.parentSpanId) ? span.parentSpanId : "",
	);
	const lines: string[] = [];
	const walk = (parent: string, depth: number) => {
		for (const span of (children.get(parent) ?? []).toSorted((a, b) => Number(a.startNs - b.startNs))) {
			const ms = (Number(span.endNs - span.startNs) / 1e6).toFixed(1);
			const text = span.attributes["db.query.text"];
			const detail = typeof text === "string" ? `  ${text.replace(/\s+/g, " ").slice(0, 80)}` : "";
			const failed = span.status === 2 ? `  failed: ${String(span.attributes["error.type"])}` : "";
			lines.push(`${"  ".repeat(depth)}${span.name}  ${ms} ms${failed}${detail}`);
			walk(span.spanId, depth + 1);
		}
	};
	walk("", 0);
	return lines;
}

if (import.meta.main) {
	const pending = new Map<string, ReceivedSpan[]>();
	const open = receiver("ok", (spans) => {
		for (const span of spans) pending.set(span.traceId, [...(pending.get(span.traceId) ?? []), span]);
		for (const [id, trace] of pending) {
			if (!trace.some((span) => span.parentSpanId === null)) continue;
			pending.delete(id);
			console.log(`\ntrace ${id}`);
			for (const line of treeOf(trace)) console.log(`  ${line}`);
		}
	});
	console.log(`Receiving traces. Start the server with:\n  OTEL_EXPORTER_OTLP_ENDPOINT=${open.url} bun run dev`);
	process.once("SIGINT", () => {
		open.stop();
		process.exit(0);
	});
}
