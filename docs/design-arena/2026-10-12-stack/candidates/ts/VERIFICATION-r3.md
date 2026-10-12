# Verdict: PASS on the current revision

**Revision:** `ts/REVISION.txt` sha256 `3d2dcc80966b01a9f0ceb26db4156662f8d946aef8f8063240e711740eab885a`. `sha256sum -c` gave 25/25 OK before my checks and 0 failures after. Finished 23:08:38 PDT.

Both round 2 blockers are resolved on this revision: the required-mode run completed, and the bench now refuses a server it did not spawn.

## Pass

| Check | Result |
| --- | --- |
| Final required-mode run | `RUN_COMPLETE` written 23:08:06; `run-duration-v3.txt` = 227.345 s (under 10 min). The log has 20 workload lines, all `"errors":0`, and no error line. |
| Artifact freshness | `embedded.json` 23:06:10, `server.json` 23:08:01, `openapi.json`, `registry-proof.json` and `results.json` 23:08:06, all from this run. |
| OpenAPI | `dist/casebook openapi` is byte-identical to `openapi.json` on disk; 6 unique `$id`, 6 refs. The stale-file issue from rounds 1 and 2 is gone. |
| Startup ownership | With my own server holding the port, `bench.ts` failed with `Port belongs to another process; refusing contaminated benchmark`, exit 1, and wrote no result file. |
| PID header | `/health`, `/counts` and operation responses all carry `x-process-pid` equal to the spawned child, on SQLite and PG. |
| SQLite save (scratch copy) | One save: version, question, decision, command and seq each +1; head 1 → 2; replay returned the identical receipt with no count change. |
| SQLite rollback | `/rollback`: seq 219967 → 219967, no count change. Missing ref → 400. |
| SQLite ingest via JUnit | Parsed XML ingested: result +10000, test +10000, question +20, signature +20, target/batch/run/seq +1; replay inserted 0 with no count change. |
| CLI and MCP | CLI `get` is byte-identical to HTTP `get`. MCP over stdio with the SDK client: tools `get, propose, report`, read-only hints true/false/false, 5,209 bytes, `get` returns structured content, bad input → `isError`. |
| PG reads | After `RUN_COMPLETE`, 0 connections at my start. `get` for refs 1, 4242 and 99999 matches `psql` on ref, head and title. |
| PG replays | `server-bun-save-0` sent twice returned the identical stored receipt, with 1 command row. `server-bun-report-0` returned `inserted: 0`. Counts unchanged. |
| PG basis | The author's last batch: 9,900 assumed, all with case and version; 100 unresolved with neither. |
| PG mixed, 20 s | 16 readers + ingester + saver: 0 errors; 21,755 reads at p95 32.5 ms; 71 ingests of 216–559 ms; 71 saves at p95 348 ms, max 535 ms. Durable deltas are exact: result +710,000, version/decision/command +71, batch/target/run +71, signature +20, question +91 (71 saves + 20 signatures), open +20. |

## Issues (none blocking)

- **Saves queue behind ingests on PG too.** 71 saves in 20 s at p95 348 ms; this was already noted for SQLite.
- **My PG mixed ingests exercised only the unresolved basis.** They used JUnit keys with no linked case, so all 710,000 rows are correctly unresolved; the assumed basis under concurrent load is evidenced only by the author's batch.
- **`cb_ts` now holds my 71 batches and 71 saves**, all prefixed `verifier-r3-pg-`. The author's result files were written before I started and are untouched.
- **Earlier notes still stand:** tally replaced per batch, every error is HTTP 400, bind-parameter bound on report size, XML parser trims a trailing space from messages.

## Not checked this round

- W1–W3 and W6–W8 answers against independent SQL (round 1 did this on an earlier revision); here only `get` on PG and the response-shape checks inside the mixed load.
- SQLite mixed concurrency, skipped to avoid loading the author's run (round 2 passed it).
- W5a parse counts, the Node 26 server, and PGlite persistence (round 2 passed them).
- Cold start, memory and build metrics: the author's figures from this run only.
- `CB_EXTRAS=1` end to end on this revision; `node.json` and `pglite.json` are from 22:29 and 22:42, before the freeze.
- Full PGlite scale, mixed load and power-loss parity, as agreed; `fsync=off` remains a limitation.
- Whole-source re-read: this round I read `run.sh`, the `bench.ts` startup path and the `main.ts` handler only.
- Open-fingerprint uniqueness by direct SQL on PG; only the question and open deltas support it.

## Safety fact

Holds.
- `../seed.db` sha256 starts `7df559361b6db2a2`, matching `ts/seed.sha256`.
- I wrote no source and did not run `run.sh`.
- I made no PG connection until `RUN_COMPLETE` existed, and touched only `cb_ts`; 0 connections remained afterwards.
- `ts/verification` is empty, and nothing is listening on 30457 or 30458.
