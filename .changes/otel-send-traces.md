---
id: otel
category: Added
date: 2026-10-29
pr: https://github.com/endqwerty/mainworthy/pull/1094
---

The server can send traces to an OpenTelemetry collector or a vendor that takes OTLP over HTTP, such as Sentry. Set `OTEL_EXPORTER_OTLP_ENDPOINT` to turn it on. Each request is a trace of its route, its operation, its PostgreSQL statements and its waits for a connection; a background job is a trace of its own. A trace holds the server's own names and statement texts, never what a caller sent. A collector that fails costs requests nothing. Log lines for failed requests and slow writes name their trace. See [send traces to an OpenTelemetry collector](../docs/guide/configuration.md#send-traces-to-an-opentelemetry-collector).
