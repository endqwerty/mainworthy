// Sends the spans of `src/server/kernel/telemetry.ts` to an OpenTelemetry collector or vendor over OTLP. Off unless
// the operator names an endpoint with the standard variables; the code that makes spans does not know either way.
import { randomUUID } from "node:crypto";
import { validateHeaderName, validateHeaderValue } from "node:http";
import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { detectResources, envDetector, resourceFromAttributes } from "@opentelemetry/resources";
import {
	AlwaysOffSampler,
	AlwaysOnSampler,
	BatchSpanProcessor,
	ParentBasedSampler,
	type Sampler,
	SamplingDecision,
	type SpanExporter,
	TraceIdRatioBasedSampler,
	TracerProvider,
} from "@opentelemetry/sdk-trace";
import { VERSION } from "../core/version.ts";

type Env = Readonly<Record<string, string | undefined>>;

/** What the operator asked for, read once when the server starts. A setting it cannot honour stops the start. */
export type TelemetrySettings =
	| { kind: "off" }
	| { kind: "traces"; url: URL; headers: Readonly<Record<string, string>>; sampler: Sampler };

const ratio = (env: Env): number => {
	const text = env.OTEL_TRACES_SAMPLER_ARG ?? "1";
	const value = Number(text);
	if (text.trim() === "" || !Number.isFinite(value) || value < 0 || value > 1)
		throw new Error("OTEL_TRACES_SAMPLER_ARG must be a number from 0 to 1");
	return value;
};

/** The standard sampler names. Spans start only in this process, so a parent-based one acts as its root sampler. */
const SAMPLERS = new Map<string, (env: Env) => Sampler>([
	["always_on", () => new AlwaysOnSampler()],
	["always_off", () => new AlwaysOffSampler()],
	["traceidratio", (env) => new TraceIdRatioBasedSampler(ratio(env))],
	["parentbased_always_on", () => new ParentBasedSampler({ root: new AlwaysOnSampler() })],
	["parentbased_always_off", () => new ParentBasedSampler({ root: new AlwaysOffSampler() })],
	["parentbased_traceidratio", (env) => new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(ratio(env)) })],
]);

/** The health probe asks every few seconds and its answer is fixed; a trace of each would bury the rest. */
const withoutProbe = (inner: Sampler): Sampler => ({
	shouldSample: (ctx, traceId, name, kind, attributes, links) =>
		attributes["http.route"] === "/health"
			? { decision: SamplingDecision.NOT_RECORD }
			: inner.shouldSample(ctx, traceId, name, kind, attributes, links),
	toString: () => `withoutProbe(${inner.toString()})`,
});

export function telemetrySettings(env: Env): TelemetrySettings {
	if (env.OTEL_SDK_DISABLED?.trim().toLowerCase() === "true") return { kind: "off" };
	const exporter = env.OTEL_TRACES_EXPORTER?.trim().toLowerCase();
	if (exporter === "none") return { kind: "off" };
	if (exporter && exporter !== "otlp") throw new Error("OTEL_TRACES_EXPORTER must be otlp or none");
	// The signal's own endpoint is the whole URL; the shared one is a base the signal's path goes under.
	const own = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
	const base = env.OTEL_EXPORTER_OTLP_ENDPOINT;
	const named = own || (base ? `${base.replace(/\/+$/, "")}/v1/traces` : "");
	if (!named) return { kind: "off" };
	for (const name of ["OTEL_EXPORTER_OTLP_TRACES_PROTOCOL", "OTEL_EXPORTER_OTLP_PROTOCOL"]) {
		const protocol = env[name];
		if (protocol && protocol !== "http/json")
			throw new Error(`${name} must be http/json: Mainworthy sends OTLP over HTTP as JSON`);
	}
	let url: URL;
	try {
		url = new URL(named);
	} catch {
		throw new Error("the OTLP endpoint must be a URL");
	}
	if (url.protocol !== "https:" && url.protocol !== "http:")
		throw new Error("the OTLP endpoint must be an http or https URL");
	const samplerName = env.OTEL_TRACES_SAMPLER?.trim().toLowerCase() || "parentbased_always_on";
	const sampler = SAMPLERS.get(samplerName);
	if (!sampler) throw new Error(`OTEL_TRACES_SAMPLER must be one of ${[...SAMPLERS.keys()].join(", ")}`);
	return {
		kind: "traces",
		url,
		headers: {
			...headers("OTEL_EXPORTER_OTLP_HEADERS", env.OTEL_EXPORTER_OTLP_HEADERS),
			...headers("OTEL_EXPORTER_OTLP_TRACES_HEADERS", env.OTEL_EXPORTER_OTLP_TRACES_HEADERS),
		},
		sampler: withoutProbe(sampler(env)),
	};
}

/**
 * `key=value` pairs separated by commas, each value percent-encoded, as the specification writes them. A header
 * HTTP cannot send stops the start here, not every batch later; the message names it without its value.
 */
function headers(variable: string, text: string | undefined): Record<string, string> {
	const pairs: Record<string, string> = {};
	for (const pair of (text ?? "").split(",")) {
		if (!pair.trim()) continue;
		const at = pair.indexOf("=");
		const key = at > 0 ? pair.slice(0, at).trim() : "";
		try {
			validateHeaderName(key);
		} catch {
			throw new Error(`${variable} must be name=value pairs separated by commas, each name a valid header name`);
		}
		let value: string;
		try {
			value = decodeURIComponent(pair.slice(at + 1).trim());
			validateHeaderValue(key, value);
		} catch {
			throw new Error(`${variable}: the value of ${key} is not a valid header value once percent-decoded`);
		}
		pairs[key] = value;
	}
	return pairs;
}

type ExportDone = Parameters<SpanExporter["export"]>[1];
/** What a failed send was, without text a collector wrote: a refused connection, a timeout or an HTTP status. */
const failureOf = (error: Error | undefined): string => {
	if (!error) return "unknown";
	const code = (error as Error & { code?: unknown }).code;
	return typeof code === "string" || typeof code === "number" ? `${error.name} ${code}` : error.name;
};

/** One line when sending starts to fail and one when it works again, not one for each batch. */
function warningOnce(exporter: SpanExporter): SpanExporter {
	let failing = false;
	return {
		export(spans, done: ExportDone) {
			exporter.export(spans, (result) => {
				// 0 is `ExportResultCode.SUCCESS`.
				if (result.code !== 0 && !failing)
					console.warn(
						`[mainworthy] telemetry: could not send traces (${failureOf(result.error)}); spans are dropped until a send succeeds`,
					);
				else if (result.code === 0 && failing) console.warn("[mainworthy] telemetry: sending traces again");
				failing = result.code !== 0;
				done(result);
			});
		},
		shutdown: () => exporter.shutdown(),
		forceFlush: () => exporter.forceFlush?.() ?? Promise.resolve(),
	};
}

export type Telemetry = {
	/** Where traces go, without path or credentials, for the start line. */
	origin: string;
	/**
	 * Sends what is queued and stops. Waits at most `deadlineMs`: an endpoint that does not answer must not hold up
	 * a stopping server, which is killed at its own deadline.
	 */
	stop: (deadlineMs: number) => Promise<"sent" | "failed" | "late">;
};

/**
 * Starts sending spans, or returns null when the settings say off. One per process: the API keeps the provider
 * and the context in globals.
 */
export function startTelemetry(settings: TelemetrySettings, commit: string | null): Telemetry | null {
	if (settings.kind === "off") return null;
	const resource = resourceFromAttributes({
		"service.name": "mainworthy",
		"service.version": commit ?? VERSION,
		"service.instance.id": randomUUID(),
	}).merge(detectResources({ detectors: [envDetector] }));
	const provider = new TracerProvider({
		resource,
		sampler: settings.sampler,
		spanProcessors: [
			new BatchSpanProcessor({
				exporter: warningOnce(new OTLPTraceExporter({ url: settings.url.href, headers: { ...settings.headers } })),
			}),
		],
	});
	const contexts = new AsyncLocalStorageContextManager().enable();
	if (!context.setGlobalContextManager(contexts) || !trace.setGlobalTracerProvider(provider)) {
		context.disable();
		trace.disable();
		throw new Error("telemetry is already started in this process");
	}
	return {
		origin: settings.url.origin,
		async stop(deadlineMs) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const late = new Promise<"late">((resolve) => {
				timer = setTimeout(() => resolve("late"), deadlineMs);
			});
			const sent = provider.shutdown().then(
				() => "sent" as const,
				() => "failed" as const,
			);
			try {
				return await Promise.race([sent, late]);
			} finally {
				clearTimeout(timer);
				trace.disable();
				context.disable();
			}
		},
	};
}
