// Traces as an operator's collector receives them: the real exporter sends to a receiver in this file, over HTTP.
// Each test file runs in its own worker, so the provider this file registers is seen by nobody else.
import { afterEach, expect, spyOn, test } from "bun:test";
import { type ReceivedSpan, receiver } from "../scripts/traces.ts";
import { startTelemetry, type Telemetry, telemetrySettings } from "../src/app/telemetry.ts";
import { API_VERSION, API_VERSION_HEADER } from "../src/core/version.ts";
import { createToken } from "../src/server/identity/identity.ts";
import { Database, sql } from "../src/server/kernel/db.ts";
import { databaseTracing, withSpan } from "../src/server/kernel/telemetry.ts";
import { findOp } from "../src/server/ops/reads.ts";
import { serve } from "../src/surfaces/http.ts";
import { testDatabase } from "./db.ts";
import { harness } from "./helpers.ts";

const SECRET_TEXT = "Kestrel-7731 private case text";
const PROJECT = "harrier-9";

let running: Telemetry | null = null;
afterEach(async () => {
	await running?.stop(1000);
	running = null;
});

const start = (url: string): Telemetry => {
	running = startTelemetry(telemetrySettings({ OTEL_EXPORTER_OTLP_ENDPOINT: url }), "a".repeat(40));
	if (!running) throw new Error("telemetry did not start");
	return running;
};

async function instance() {
	const h = await harness({ project: PROJECT });
	const server = serve(h.app, h.owner);
	const { secret } = await createToken(h.app, {
		actor: "kite-agent",
		kind: "agent",
		can: ["read", "produce"],
		project: 0,
		label: "t",
	});
	const origin = `http://127.0.0.1:${server.port}`;
	const send = async (op: string, input: unknown) =>
		await fetch(`${origin}/api/p/${PROJECT}/${op}`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${secret}`,
				"content-type": "application/json",
				[API_VERSION_HEADER]: String(API_VERSION),
			},
			body: JSON.stringify(input),
		});
	return {
		h,
		origin,
		secret,
		send,
		async close() {
			await server.stop(true);
			await h.close();
		},
	};
}

const childrenOf = (spans: readonly ReceivedSpan[], parent: ReceivedSpan) =>
	spans.filter((span) => span.parentSpanId === parent.spanId);
const one = (spans: readonly ReceivedSpan[], match: (span: ReceivedSpan) => boolean): ReceivedSpan => {
	const found = spans.filter(match);
	if (found.length !== 1) throw new Error(`expected one span, found ${found.length}`);
	return found[0] as ReceivedSpan;
};

test("a request is one trace of its route, its operation and its statements, carrying nothing the caller sent", async () => {
	const collector = receiver();
	const telemetry = start(collector.url);
	const it = await instance();
	try {
		expect((await fetch(`${it.origin}/health`)).status).toBe(200);
		const proposed = await it.send("propose", { edits: [{ op: "create", outline: SECRET_TEXT }] });
		expect(await proposed.json()).toMatchObject({ ok: true });
		const found = await it.send("find", { text: SECRET_TEXT });
		expect(await found.json()).toMatchObject({ ok: true });
		expect(await telemetry.stop(5000)).toBe("sent");
		running = null;

		const spans = collector.spans();
		const requests = spans.filter((span) => span.parentSpanId === null && span.kind === 2);
		expect(requests.map((span) => span.name).sort()).toEqual(["POST /api/p/:project/:op", "POST /api/p/:project/:op"]);
		const proposal = one(spans, (span) => span.name === "propose");
		const request = one(spans, (span) => span.spanId === proposal.parentSpanId);
		expect(request.attributes).toMatchObject({
			"http.request.method": "POST",
			"http.route": "/api/p/:project/:op",
			"http.response.status_code": 200,
		});
		expect(proposal.attributes).toMatchObject({ "mainworthy.operation.effect": "write" });
		const statements = childrenOf(spans, proposal).filter((span) => span.attributes["db.system.name"] === "postgresql");
		expect(statements.map((span) => span.name)).toContain("COMMIT");
		const inserts = statements.filter((span) => span.attributes["db.operation.name"] === "INSERT");
		expect(inserts.length).toBeGreaterThan(0);
		for (const insert of inserts) expect(String(insert.attributes["db.query.text"])).toContain("$");
		expect(one(spans, (span) => span.name === "find").traceId).not.toBe(proposal.traceId);
		expect(spans.every((span) => span.resource["service.name"] === "mainworthy")).toBe(true);
		expect(spans[0]?.resource["service.version"]).toBe("a".repeat(40));
		// The probe is not traced.
		expect(spans.some((span) => span.attributes["http.route"] === "/health")).toBe(false);
		// Nothing the caller sent or named leaves the instance: not the text, the project, the token or a person.
		const sent = collector.bodies.join("\n");
		for (const text of [SECRET_TEXT, "Kestrel", PROJECT, it.secret, "robin"]) expect(sent).not.toContain(text);
	} finally {
		await it.close();
		collector.stop();
	}
});

test("requests at the same time keep their own traces", async () => {
	const collector = receiver();
	// After the harness, whose own setup call is an operation run in this process and so a trace of its own.
	const it = await instance();
	const telemetry = start(collector.url);
	try {
		const replies = await Promise.all(
			Array.from({ length: 8 }, (_, i) =>
				i % 2
					? it.send("find", { text: `t${i}` })
					: it.send("propose", { edits: [{ op: "create", outline: `c${i}` }] }),
			),
		);
		for (const reply of replies) expect((await reply.json()) as unknown).toMatchObject({ ok: true });
		await telemetry.stop(5000);
		running = null;
		const spans = collector.spans();
		const byId = new Map(spans.map((span) => [span.spanId, span]));
		const rootOf = (span: ReceivedSpan): ReceivedSpan => {
			const parent = span.parentSpanId ? byId.get(span.parentSpanId) : undefined;
			return parent ? rootOf(parent) : span;
		};
		const operations = spans.filter((span) => span.name === "find" || span.name === "propose");
		expect(operations).toHaveLength(8);
		expect(new Set(operations.map((span) => span.traceId)).size).toBe(8);
		for (const span of spans) {
			expect(rootOf(span).traceId).toBe(span.traceId);
			expect(rootOf(span).parentSpanId).toBeNull();
		}
		// Every statement belongs to one of the eight requests; none starts a trace of its own.
		const statements = spans.filter((span) => span.attributes["db.system.name"] === "postgresql");
		expect(statements.length).toBeGreaterThan(8);
		for (const statement of statements) expect(rootOf(statement).kind).toBe(2);
	} finally {
		await it.close();
		collector.stop();
	}
});

test("a failed operation is marked by its kind alone, and its log line names the trace", async () => {
	const collector = receiver();
	const telemetry = start(collector.url);
	const it = await instance();
	if (findOp.effect !== "read") throw new Error("find must stay a read operation");
	const broken = spyOn(findOp, "run").mockImplementation(async () => {
		throw new Error(`${SECRET_TEXT} reached the log`);
	});
	const errors = spyOn(console, "error").mockImplementation(() => undefined);
	try {
		const reply = await it.send("find", { text: "x" });
		expect(await reply.json()).toMatchObject({ ok: false, error: { code: "internal" } });
		await telemetry.stop(5000);
		running = null;
		const failed = one(collector.spans(), (span) => span.name === "find");
		expect(failed.status).toBe(2);
		expect(failed.attributes["error.type"]).toBe("internal");
		expect(String(errors.mock.calls[0]?.[0])).toContain(`(trace ${failed.traceId})`);
		expect(collector.bodies.join("\n")).not.toContain("Kestrel");
	} finally {
		broken.mockRestore();
		errors.mockRestore();
		await it.close();
		collector.stop();
	}
});

test("an endpoint that refuses or never answers fails no request, warns once, and stopping waits only its deadline", async () => {
	for (const answer of ["refuse", "silent"] as const) {
		const collector = receiver(answer);
		const telemetry = start(collector.url);
		const it = await instance();
		const warnings = spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			for (let i = 0; i < 3; i++) {
				const reply = await it.send("find", { text: "x" });
				expect(await reply.json()).toMatchObject({ ok: true });
			}
			const stopped = await telemetry.stop(answer === "silent" ? 300 : 5000);
			running = null;
			expect(stopped).toBe(answer === "silent" ? "late" : "failed");
			const said = warnings.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("telemetry"));
			expect(said).toEqual(
				answer === "refuse"
					? [
							"[mainworthy] telemetry: could not send traces (OTLPExporterError 400); spans are dropped until a send succeeds",
						]
					: [],
			);
		} finally {
			warnings.mockRestore();
			await it.close();
			collector.stop();
		}
	}
});

test("a slow write's log line names its trace", async () => {
	const collector = receiver();
	start(collector.url);
	const fixture = await testDatabase();
	const database = await Database.open({ url: fixture.url, slowWriteMs: 1, tracing: databaseTracing });
	const warnings = spyOn(console, "warn").mockImplementation(() => undefined);
	try {
		const traceId = await withSpan(
			"work",
			{},
			async (span) => {
				await database.write((db) => db.allDynamic("SELECT pg_sleep(0.01)"));
				return span.spanContext().traceId;
			},
			"root",
		);
		const line = warnings.mock.calls.map((call) => String(call[0])).find((text) => text.includes("slow write"));
		expect(line).toContain(`(trace ${traceId})`);
	} finally {
		warnings.mockRestore();
		await database.close();
		await fixture.close();
		collector.stop();
	}
});

test("a statement outside a traced request makes no span, and a dynamic statement sends no text", async () => {
	const collector = receiver();
	const telemetry = start(collector.url);
	const fixture = await testDatabase();
	const database = await Database.open({ url: fixture.url, tracing: databaseTracing });
	const declared = sql<readonly [], { n: number }>("SELECT 1 AS n");
	try {
		await database.read((db) => db.all(declared));
		await withSpan("work", {}, () => database.read((db) => db.allDynamic("SELECT 'Kestrel' AS k")), "root");
		await telemetry.stop(5000);
		running = null;
		const spans = collector.spans();
		const work = one(spans, (span) => span.name === "work");
		expect(spans.filter((span) => span.traceId !== work.traceId)).toEqual([]);
		const dynamic = one(spans, (span) => span.attributes["db.operation.name"] === "SELECT");
		expect(dynamic.attributes["db.query.text"]).toBeUndefined();
		expect(collector.bodies.join("\n")).not.toContain("Kestrel");
	} finally {
		await database.close();
		await fixture.close();
		collector.stop();
	}
});

test("the settings: off unless an endpoint is named, and a value the server cannot honour stops the start", () => {
	expect(telemetrySettings({}).kind).toBe("off");
	expect(telemetrySettings({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://x", OTEL_SDK_DISABLED: "true" }).kind).toBe("off");
	expect(telemetrySettings({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://x", OTEL_TRACES_EXPORTER: "none" }).kind).toBe("off");
	const own = telemetrySettings({
		OTEL_EXPORTER_OTLP_ENDPOINT: "http://ignored.example",
		OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://collector.example/api/1/otlp/v1/traces",
	});
	expect(own.kind === "traces" && own.url.href).toBe("https://collector.example/api/1/otlp/v1/traces");
	const shared = telemetrySettings({
		OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example/otlp/",
		OTEL_EXPORTER_OTLP_HEADERS: "x-sentry-auth=sentry%20sentry_key=abc,other = 1",
		OTEL_EXPORTER_OTLP_TRACES_HEADERS: "other=2",
	});
	expect(shared.kind === "traces" && shared.url.href).toBe("https://collector.example/otlp/v1/traces");
	expect(shared.kind === "traces" && shared.headers).toEqual({ "x-sentry-auth": "sentry sentry_key=abc", other: "2" });
	for (const env of [
		{ OTEL_EXPORTER_OTLP_ENDPOINT: "not a url" },
		{ OTEL_EXPORTER_OTLP_ENDPOINT: "ftp://x" },
		{ OTEL_EXPORTER_OTLP_ENDPOINT: "http://x", OTEL_TRACES_EXPORTER: "zipkin" },
		{ OTEL_EXPORTER_OTLP_ENDPOINT: "http://x", OTEL_EXPORTER_OTLP_PROTOCOL: "grpc" },
		{ OTEL_EXPORTER_OTLP_ENDPOINT: "http://x", OTEL_TRACES_SAMPLER: "sometimes" },
		{ OTEL_EXPORTER_OTLP_ENDPOINT: "http://x", OTEL_EXPORTER_OTLP_HEADERS: "no-equals-sign" },
		{ OTEL_EXPORTER_OTLP_ENDPOINT: "http://x", OTEL_TRACES_SAMPLER: "traceidratio", OTEL_TRACES_SAMPLER_ARG: "2" },
	])
		expect(() => telemetrySettings(env)).toThrow();
	expect(
		telemetrySettings({
			OTEL_EXPORTER_OTLP_ENDPOINT: "http://x",
			OTEL_TRACES_SAMPLER: "traceidratio",
			OTEL_TRACES_SAMPLER_ARG: "0.25",
		}).kind,
	).toBe("traces");
});
