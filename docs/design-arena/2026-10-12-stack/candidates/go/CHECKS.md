# Checks defined before implementation

The claim to test is that one Go operation path meets Mainworthy's read, save,
ingest and mixed-load budgets using durable SQLite and PostgreSQL stores.
Timings during the arena are provisional because other candidates share the host.

- Run every workload through a real loopback HTTP listener with keep-alive.
  Record 100 warmups, the specified measured iterations, all errors and percentiles.
- W1 must return the requested ref and a valid head-version body.
- W2 must return at most 50 rows after the cursor in the requested folder,
  with linked-test counts, last outcomes and an indexed open-question count.
- W3 must return at most 50 relevant cases, with AND semantics and the
  requested folder restriction. Check seeded queries return matches.
- W4 must commit command, sequence, decided question, decision, version,
  head and search document together. Replay 20 command IDs and compare
  full receipts, row counts and sequence. Reject a stale base version.
- W5 must commit 10,000 results, 100 new tests, 200 failures, 20 signatures,
  target, batch, unique open signature questions and run tally. Check linked
  results carry the current head and unlinked results have unresolved basis.
  Replay a batch and prove that sequence and row counts do not change.
- W5a must parse 10,000 tests, exactly 200 failures and their message bodies.
- W6 must return 20 rows for the requested test in descending sequence order.
- W7 must return the requested commit and a valid tally.
- W8 must return 50 open questions with evidence and the correct total.
- W9 must run 16 readers plus separate save/ingest writers for 20 seconds;
  count responses, errors, throughput and writer latency.
- Compare SQLite drivers in five alternating runs using the same durable
  dataset, workload, pool settings and optimized builds. Verify FTS5 and
  inspect static linkage, artifact size and clean-build cost for each.
- Exercise the registry's HTTP routes, OpenAPI, generated CLI help, MCP
  tools/list and tools/call using the official Go SDK over stdio.
- Measure five process starts to first successful HTTP response, RSS,
  artifact bytes, clean build, direct dependencies and authored source lines.
- Run run.sh unattended against fresh SQLite and cb_go copies in under
  ten minutes. Independent verification must be read-only and from another
  provider. Its absence is reported as unverified.

All source and evidence stay in this directory. The Mainworthy repository is read-only.

Independent review regression checks, defined before the follow-up edits:

- A report with 9 skipped rows must tally 9,791 passes, 200 failures and 9 skips.
  The reviewer observed 9,800 passes on the old revision.
- New questions in one report need distinct references and ranks.
- Prove folder glyph counts and last outcomes against stored rows, including a linked page.
- A test pointing to a missing case must return HTTP 400 and leave no partial report.
- Embedded transaction queries and writes must use prepared statements.
