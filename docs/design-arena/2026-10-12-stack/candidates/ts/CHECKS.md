# Checks defined before implementation

Expected claim: the same TypeScript operations can serve SQLite Local and PostgreSQL Server through HTTP, CLI, and MCP within Casebook's latency budgets. Treat timings as provisional while other candidates run. No runtime or driver winner is established without alternating repeated measurements.

1. Run every W1 to W9 against a real loopback HTTP listener with persistent connections. Count HTTP, validation, and correctness errors. Return the measured operation's store duration independently of client elapsed time.
2. W1 must return the requested reference and a parsed head version whose title agrees with the case.
3. W2 must return at most 50 ordered rows after the requested cursor in the requested leaf folder, linked-test counts, latest outcome per linked test, and an indexed open count. No more than three batched reads.
4. W3 must return at most 50 matching cases in project 1, relevance ordered, and respect the 24-folder filter in exactly 20% of requests. Validate matches and record plans.
5. W4 must atomically add one command, version, decided adopt question, and decision; increment the sequence once; move the case head and replace its search text. Replay 20 commands and compare before/after table counts and sequence. Inject a failure mid-transaction and prove rollback.
6. W5 must atomically insert 10,000 results, resolve 9,900 seeded keys, create 100 tests, record 200 failures and 20 signatures with 10 initially new, and retain assumed case/head basis or unresolved basis. Assert the run tally and sequence change. Replay a batch and compare durable counts and sequence. Inspect signature question uniqueness.
7. W5a must parse 10,000 generated XML testcases, retain the 200 failure messages, and produce valid W5 input.
8. W6 must return 20 descending results for the selected test. W7 must return the selected commit's run. W8 must return 50 ordered open questions, parsed evidence, and a correct count.
9. W9 must actually run 16 reading clients, one ingesting client, and one saving client together for 20 seconds, count completed requests and errors, and report tail latencies and all ingest times.
10. Generate OpenAPI, HTTP routes, MCP tools, and CLI help from one typed registry. Use the maintained SDK client over stdio for tools/list and tools/call; count serialized tools/list bytes. Prove CLI and HTTP get agree.
11. Measure five process cold starts through the first successful HTTP response, process RSS after workloads, clean build time, compiled-binary bytes, source line count, and direct dependencies.
12. Only after required work: repeat embedded W1 to W8 under Node 26 and then PGlite W1 to W5 against an on-disk 10% seed subset. Report omitted checks explicitly.

Safety fact: no source or result is written outside this candidate's output directory; the shared seed stays unchanged and PostgreSQL mutations only target cb_ts. Independent verification must not reset or write the author's database while measurements are running.
