# 0035: Reply schemas in the registry

2026-10-14. Issue #52.

## Problem

The registry described inputs, but its OpenAPI success envelope accepted any result. Reply types and the CLI's validators were separate declarations. The iPhone app checked its own subset against real replies.

## Decision

Each operation registers an `output` schema beside `input`. The pure core owns these schemas so clients can import them without importing the server. Existing reply types and `Api` infer their result types from the schemas. The CLI imports the same validators. A registry test holds the server declarations and client contracts equal.

OpenAPI emits each operation's complete success envelope, including its result schema and required nullable `seq`. Ref and action variants remain unions. Open records describe variable decision evidence and effects. Fields selected by `get.fields` remain optional. Heterogeneous `get` and `find` rows retain their general static record type while their runtime schemas validate the known alternatives.

MCP emits a projection of each output schema: the result's top-level type and required fields, inside `{ result, seq }`. It does not repeat nested schemas in every tool definition. The full schemas are in OpenAPI. Compact input-field prose and tool descriptions keep tools/list within its measured token budget. The budget equals the total rounded up to the next 50 tokens.

The iPhone contract remains a consumer subset. Its tests validate real replies against both the registered output and the app's decoding requirements. Generated Swift does not change.

## Alternatives and checks

Putting reply schemas in the server would make browser clients depend on a higher layer. Keeping types and CLI validators separate would preserve the drift that caused the missing descriptions. Emitting full nested MCP schemas would exceed the tool-list budget.

The HTTP tests validate replies from every operation and every `find` collection. They validate served OpenAPI schemas and reject missing and retyped required fields. The iPhone scenarios exercise populated cases, proposals, runs, slots and questions, including nullable expected results. MCP tests check the output envelope and retain the token limit.

This supplies reply descriptions and reusable validators. Comparing the schemas of two server versions remains work for issue #90.
