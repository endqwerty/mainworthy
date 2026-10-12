**Verdict: PASS, no blockers.** One budget miss in my own `run.sh` run (embedded W9 ingest max) is the thing to look at before you quote numbers, and the five-run driver comparison is not checked.

- **Verifier:** Anthropic / Claude Opus 5.5 (`claude-opus-5-5`), effort high, no delegation.
- **Revision:** `4cac9a7f468cac9b25a346731539e7aa4261707e2c5803712d470e3600a37813`. All 22 files match the manifest before and after my runs (`files 22 mismatches 0`).
- **Finished:** 23:04 PDT, 2026-10-11. I started resetting `cb_go` only after your `PASS all workloads … run.sh 208 seconds` line was present.

## Checks

| Check | Verdict | Deciding output (mine) |
|---|---|---|
| Source hashes, start and end | PASS | `mismatches 0` both times, parent and scratch copies |
| Binary built from this source | PASS | My rebuild is byte-identical to your `casebook-cgo` (`cmp -l`: 0 differing bytes, 16,917,256 bytes), statically linked |
| `run.sh` unattended, scratch copy | PASS | `PASS all workloads in both modes; zero errors; run.sh 217 seconds`, exit 0 |
| Selfcheck, embedded and server | PASS | Both print `PASS mode=…` including `skip tally 9791/200/9; unique question refs/ranks; stored glyph oracle; orphan link rollback` |
| Iteration counts and warmups | PASS | Every W1–W8 has the specified iterations and `warmup 100`, both modes |
| Errors | PASS | `errors=0 warmupErrors=0` on every workload; W9 `errors=0/0/0` |
| Budgets | ISSUES | `budgetMisses ['embedded.W9.ingest.max']`: 2119.6 ms against 2000 (finding 1) |
| W9 reads and both writers ran | PASS | Embedded 26 ingests and 194 saves; server 28 and 201; 26 mix batches stored in SQLite |
| Failed commands write nothing | PASS | Stale base 409; missing case, empty steps, unknown field, wrong type, empty command 400; snapshot delta `{}` |
| Concurrent command replay | PASS | 16 identical posts, identical receipts; delta `seq 1, command 1, version 1, question 1, decision 1` |
| Stale versions under a race | PASS | 16 commands on one base: `[200, 409 ×15]`, one record set, losers leave no rows |
| Concurrent batch replay | PASS | 6 identical posts: 1 ingest, 5 `replay:true`, same batch and sequence; exactly one batch written |
| Failed report writes nothing | PASS | Invalid outcome, duplicate key, client abort at 30 ms and 120 ms; on the server, int4 overflow in COPY and a NUL key: delta `{}` |
| Skip tally | PASS | Stored `pass 9791, skip 9, unexplained 200` equals the result rows, both stores |
| Orphan link rollback | PASS | `HTTP 400 … references missing case 9999999`, delta `{}`; the next report commits with the next sequence |
| Unique question refs and ranks | PASS | 20 questions, 20 distinct refs and ranks; all post-seed questions (2,764 embedded, 2,813 server) are distinct, `ref = id`, `rank = id*1000`, and collide with no seed ref |
| Glyph oracle | PASS | Folder 21 cursor 0: 50 rows, 31 linked tests, counts and last outcomes equal SQL; three other pages also equal |
| Search AND and area | PASS | 221 searches per store against a brute-force token oracle (87 multi-word, 188 capped at 50, area via `folder.parent`): no mismatches |
| Stored basis | PASS | 9,900 assumed at the current head, 100 unresolved, 200 fail, 20 signatures; test 4242 carries the moved head |
| Sequence and head invariants | PASS | Post-benchmark: embedded `1440 = 1440 = 1440`, server `1455 = 1455 = 1455`; no version without an adopt decision, no head not matching its version |
| MCP and CLI shared outcomes | PASS | Propose over MCP, replayed over CLI and HTTP, returns the identical receipt with one record set; stale base rejected on MCP (`isError`) and CLI (exit 1) |
| Registry proof | PASS | `PASS registry: 3 operations; identical schemas; MCP tools/list+tools/call; generated CLI; OpenAPI HTTP` |
| Clean build | PASS (contended) | cgo 62.9 s, pure 17.1 s, both statically linked; ran alongside my benchmark, so the times are inflated |
| Five-run driver comparison | NOT CHECKED | My isolated copy lacked `queries.txt`, the probe exited at once, and there was no time to rerun |
| SQLite `synchronous=NORMAL` at runtime | NOT CHECKED | Read in the DSN only; WAL confirmed in the file |

## My timings

Milliseconds, p95 unless stated. Provisional: my challenges and clean build overlapped parts of this run.

| Workload | Budget | Embedded | Server |
|---|---|---:|---:|
| W1 | < 20 | 0.263 | 0.468 |
| W2 | < 50 | 3.133 | 8.865 |
| W3 | < 100 | 35.925 | 35.351 |
| W4 | < 50 | 14.597 | 25.834 |
| W5 max | < 2000 | 604.585 | 375.431 |
| W5a | report | 29.125 | 32.693 |
| W6 | < 20 | 0.349 | 0.415 |
| W7 | < 20 | 0.141 | 0.207 |
| W8 | < 50 | 3.082 | 8.962 |
| W9 reads | < 50 | 10.189 | 20.480 |
| W9 ingest max | < 2000 | **2119.6** (rerun 1354.9) | 1028.0 |
| W9 save p95 | report | 618.4 | 544.1 |

## Findings (non-blocking)

1. **Embedded W9 ingest max missed its budget once.** It hit 2119.6 ms while my own clean cgo build was running on the same host. An embedded rerun with nothing of mine overlapping W9 gave 1354.9 ms, and round 1 gave 1036.8 ms. I read it as contention, but it shows the headroom is thin under CPU load.
2. **`run.sh` prints PASS despite a budget miss.** `combine.py` records `budgetMisses` but does not fail on them, so the PASS line means zero errors and correct counts, not budgets met. The report should quote `budgetMisses`.
3. **The W2 benchmark assertion is still unfalsifiable** (`bench.go:302`, `Tests` against `len(Last)`). The real oracle now lives in SelfCheck, for one page only.
4. **SQLite transaction statements are re-prepared in every transaction** (`store.go`, `sqliteTx.prepare`). That meets "prepared" literally but gives no reuse across transactions.
5. **The run tally is the latest batch's, not cumulative per commit** (`ON CONFLICT … SET tally=excluded.tally`). `checkBatch` also compares `unexplained`, which includes `error`, with `fail` rows only; both are fine for this fixture.
6. **Carried over as stated spike limits:** replay ignores a changed payload, batch replay returns zeroed counters, every non-conflict error is HTTP 400 with raw driver text, and the area filter is id arithmetic.

No false benchmark result, missing workload or partial write found.

## State left behind

- `cb_go` is in its post-benchmark and post-challenge state; I never connected to `cb_seed` and changed no server settings.
- I deleted my scratch databases, the rebuilt binaries and the two clean compiler caches I created under `toolchains`.
- Logs, JSON outputs, `challenge.py` and `mcpcli.py` remain in `go/verification-scratch-r2`.
- No parent source, script, report, result or binary was changed, and nothing was written to the Casebook repository.
