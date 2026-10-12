**Verdict: PASS, with minor issues and none blocking.** In my own runs every workload met its budget in both modes with zero errors, and the safety fact held on the real HTTP path in both stores.

- **Verifier:** Anthropic / Claude Opus 5.5 (`claude-opus-5-5`), effort high, no delegation.
- **Revision:** `cc666940155b05c1a37cb34e7da5646a84cdbf26b27cbfbd941240a1a40d7515`. All 22 files match `source-manifest.json` before and after my runs.
- **Finished:** 22:46 PDT, 2026-10-11.

## Required checks

| Check | Verdict | Deciding output (mine) |
|---|---|---|
| Source hashes match the manifest | PASS | `files 22 mismatches 0` |
| Static linkage | PASS | `statically linked, stripped`; `ldd`: `not a dynamic executable` |
| Binary built from this source | PASS (not bit-identical) | Rebuild is the same size (16,904,808 bytes), 59 bytes differ, build info identical; the rebuild passes selfcheck |
| Selfcheck, embedded and server | PASS | Both print `PASS mode=…`, exit 0 |
| W1–W8 iteration counts, 100 warmups (W5 too) | PASS | Every workload `warm 100`; 120 `*-report-*` batches in the database |
| W1–W9 budgets and errors, both modes | PASS | Table below; `errors 0`, `warmupErrors 0` everywhere |
| W9: reads and both writers ran | PASS | Stored rows match the reported counts (below) |
| Failed commands write nothing | PASS | Stale base gives 409; missing case, empty steps, unknown field, wrong type and empty command give 400; snapshot delta `{}` |
| Concurrent command replay | PASS | 16 identical posts return 16 identical receipts; delta `seq 1, command 1, version 1, question 1, decision 1` |
| Stale versions under a race | PASS | 16 different commands on one base: `[200, 409 ×15]`, one record set, losers leave no rows |
| Head never moves without a decision | PASS | `versions without adopt decision 0`, `heads not matching version 0` on both post-benchmark databases |
| Failed report writes nothing | PASS | Client abort at 30 ms and 120 ms: nothing written. Server only: int4 overflow in COPY and a NUL key fail mid-transaction, delta `{}` |
| Batch replay, concurrent and sequential | PASS | 6 identical posts: 1 ingest and 5 `replay:true` with the same batch and sequence; delta is exactly one batch |
| Sequence not bumped on replay or failure | PASS | No gaps: embedded `1570 = 1570 = 1570`, server `1594 = 1594 = 1594` (sequence delta = commands + batches = distinct sequences) |
| Stored basis | PASS | 9,900 assumed at the current head, 100 unresolved, 200 fail, 20 signatures; test 4242 carries the head moved by the earlier saves |
| Search AND and folder filtering | PASS | 221 searches per mode against a brute-force token oracle (87 multi-word, 188 capped at 50, area via `folder.parent`): no mismatches |
| W2, W6, W8 against SQL oracles | PASS | Rows, test counts, last outcomes, open total and order all equal, both modes |
| Run tally | ISSUES | Finding 1 |
| Schema equivalence and registry | PASS | OpenAPI 3.1.0 schemas equal the MCP `inputSchema`/`outputSchema` for all three operations; `tools/list` is 4,309 bytes; protocol negotiated 2025-11-25 |
| One operation layer across surfaces | PASS | A propose over MCP, replayed over the CLI, returns the identical receipt with no writes; stale base rejected over MCP and CLI flags |
| `run.sh` | PASS by inspection | Rebuilds when stale, resets SQLite and `cb_go` before each selfcheck and benchmark, deletes `results.json` first, asserts zero errors and under 600 s. I ran its component commands, not the script |
| Clean build time, five-run driver comparison, pure driver | NOT CHECKED | Not re-measured |
| SQLite `synchronous=NORMAL` | NOT CHECKED at runtime | Read in the connection string only; WAL confirmed in the file |

## My timings

Milliseconds; p95 unless stated. Provisional, as the spec says.

| Workload | Budget | Embedded | Server |
|---|---|---:|---:|
| W1 | < 20 | 0.210 | 0.251 |
| W2 | < 50 | 3.293 | 9.489 |
| W3 | < 100 | 40.091 | 40.465 |
| W4 | < 50 | 6.352 | 11.877 |
| W5 max | < 2000 | 505.959 | 333.779 |
| W5a | report | 34.548 | 31.165 |
| W6 | < 20 | 0.387 | 0.404 |
| W7 | < 20 | 0.137 | 0.211 |
| W8 | < 50 | 2.908 | 8.477 |
| W9 reads | < 50 | 8.330 | 16.64 |
| W9 ingest max | < 2000 | 1036.8 | 931.4 |
| W9 save p95 | report | 420.0 | 445.1 |

- **W9 evidence:** embedded ran 102,183 reads (5,030/s), 31 ingests and 319 saves; server ran 54,416 reads (2,708/s), 32 ingests and 342 saves. The stored rows agree: 31 and 32 mix batches with 310,000 and 320,000 results, and case 95000 at head 320 and 343.
- **Search equivalence:** both modes returned 20,559 rows across 499 non-empty queries.
- **Extras:** cold start median 3.95 ms embedded and 4.61 ms server; resident memory 347.5 MB and 39.0 MB.

## Findings

1. **Tally counts skips as passes** (`operations.go:346`). `pass` is inserted minus failures. My report with 9 skips stored `{"pass":9800,"unexplained":200}` against 9,791 pass rows. The benchmark fixture has no skips, and `checkBatch` never reads the tally, so the W5 check string "basis/tally/replay verified" overstates what is checked.
2. **Questions from one report share `ref_no` and `rank`** (`operations.go:308-310`). 20 questions, 1 distinct value each, both set to the sequence. The schema has no unique index, so nothing rejects it.
3. **The W2 glyph assertion cannot fail** (`bench.go:302`). It compares `Tests` with `len(Last)`, which the same loop builds. About 80% of measured pages also hold no linked tests, because only ranks up to 31,000 are linked. The data itself is correct by my oracle.
4. **Replay ignores the payload.** The same command id with a different ref and body returns the old receipt with 200. A batch replay returns zeroed counters, not the stored outcome. Neither writes anything.
5. **Every non-conflict error is HTTP 400 with raw driver text** (`registry.go:102-107`), including not-found (`sql: no rows in result set`) and PostgreSQL errors.
6. **The area filter is id arithmetic, not the folder tree** (`store.go:65,80`). It is correct for this seed only.
7. **Embedded write transactions are not prepared**, except the result insert (`store.go:241-254`). The spec asks for prepared statements; this only costs the candidate.
8. **Possible nil dereference** at `operations.go:333` if a test points at a missing case. Found by reading only, not reproduced.
9. **`run.sh` reuses extras from earlier scripts.** Build metrics, driver comparison and diagnostics are not re-measured, and `combine.py` asserts neither budgets nor iteration counts.

Mixed-load save p95 of 420–445 ms is far above W4's standalone 50 ms. The report discloses it and explains it as saves waiting on the project row lock behind ingests; it is not a W9 budget.

No registry duplication, no missing workload and no false benchmark result found.

## Limits

- My embedded challenge overlapped part of my server benchmark's W1–W8, and other candidates may have been running, so the server timings above may be inflated.
- `cb_go` is left in its post-benchmark and post-challenge state. `run.sh` resets it; I never connected to `cb_seed`.
- I deleted my large scratch database copies and the rebuilt binary. The logs, JSON outputs and `challenge.py` remain in `go/verification-scratch`.
- No source, script, report or result file was changed, and nothing was written to the Casebook repository.
