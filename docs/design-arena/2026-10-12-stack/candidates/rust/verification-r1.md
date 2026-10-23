# Verdict: RUST candidate passes the spike SPEC on the current revision, with one real defect in server mode outside the benchmark path

I ran my own checks over real HTTP on port 18485 against my own copy of `seed.db`, with an independent read-only SQL oracle. Nothing in the source, `work.db` or the repository was modified; all my processes are stopped, port 18485 is free and my database copy is deleted.

## Revision judged

The source changed three times while I worked. This verdict covers only the last state:

| File | SHA256 |
| --- | --- |
| `src/db.rs` | `2c9c7331f1108032633ffb2f595240b94b43169ee5acdada167eafc4c9a1dfe8` |
| `src/main.rs` | `60add17d4ad73a4a1c67229a96d11734d41ac63411532c2962602a6c9323fe38` |
| `src/ops.rs` | `55b5fd1d971c1e80698e9aca95c6951aa1b7879b760a3b0a06aabbd32ba298cc` |
| `src/registry.rs` | `83c98ac4bc44e3ae6ee09c40516a71ed037b5564739f798325750d40cd562bed` |
| `Cargo.toml` | `57aa466993a804f61ddc4b895c008fd36ade632e099f2a3cefad868ea6cdf11e` |
| `Cargo.lock` | `b4e61889e9297260f25c54db68bb987abc46b3736541b5b26604a238eb6d6868` |
| `benchmark.py` | `add1b9a1edeb1620b9ed23af6573306cd709b7408cf8818beacd2a0e0fb4b52f` |
| `build.py` | `5830eb7dc099084cd9d9c741835035fb874ffbf4270e40292a1ddfe1c9b6e0b1` |
| `run.sh` | `62e6c7be869658cc86f5ac190b4b369489540a8326616373943ea71bab5fc743` |
| `CHECKS.md` | `7049dac567ccf0e727274d17ccee81a98b59dfcd7557c1c22734466a996f3833` |
| release binary | `4ea9fb46e9fccf3079f2c70128b04b722e7789b12bc95f093875be892e6f87b6` |

- **Embedded (SQLite):** the full suite ran on this exact binary (80 checks, 0 failures) and on the two earlier revisions with the same result.
- **Server (PostgreSQL):** the checks ran on the previous binary (`b5c59e11…`). The delta to the current source is a writer-only SQLite `cache_size=-65536` pragma and one `profile("result_insert")` timer line; I read it but did not rerun PostgreSQL on it, because the author was using `cb_rust`.

## Safety fact

Acknowledged writes must be atomic, applied once per command id or batch key, and durable.

- **SQLite:** proven by running it (rollback, replay, concurrency, `kill -9`).
- **PostgreSQL:** proven for reads and for rollback of failed transactions. Successful writes were not run by me; the author's stored data is consistent with it. It does not hold when a client disconnects mid-write (issue 1).

## Results per check

| Check | Status | Deciding lines |
| --- | --- | --- |
| W1 get | pass | 62 refs equal SQL `kase` row plus head version body, `mismatches=0`; PostgreSQL 12 refs, `mismatches 0` |
| W2 folder page | pass | 25 pages: ids, order, test count, last outcomes and open count equal SQL; PostgreSQL 4 pages equal |
| W3 search | pass | 60 queries: top-50 scores, ids, ref, title and folder equal an independent FTS5 bm25 oracle; PostgreSQL 15 queries, hit count equals `min(50, independent match count)` |
| W4 seal-save | pass (SQLite) | `delta={'seq': 1, 'command': 1, 'version': 1, 'question': 1, 'decision': 1}`; stored body equals input; hash is sha256 of the body; head, title and rev updated; old search token gone, new one found |
| W4 idempotency | pass (SQLite) | identical replay returns the same receipt with `delta={}`; 12 concurrent identical commands give one write and one receipt |
| W4 version sequence | pass (SQLite) | 12 concurrent saves on one case: `nos=[2..13]`, `seqs=219969..219980`, head equals max |
| W4 rollback | pass (SQLite) | stale base returns `400 conflict: base version 1, head 2` with `delta={}` and no command row; unknown ref and 6 invalid inputs also `delta={}` |
| W5 report | pass (SQLite) | `'n': 10000, 'f': 200, 's': 20, 'a': 9900, 'u': 100`; tests +100, signatures +10; all 10,000 stored rows equal the input by ordinal |
| W5 basis and head | pass (SQLite) | `bad=0`; after a save on a linked case, `basis_version=2 old_head=1` |
| W5 questions | pass (SQLite) | first batch raises 20, later batches 10; `duplicate_open=0` |
| W5 replay | pass (SQLite) | `replay: True` with `delta={}`; 4 concurrent identical batches give `replay_flags=[False, True, True, True]` |
| W5a parser | pass for the spec shape | 10,000 cases, 200 failures, `message_bytes: 80000`; named and numeric entities, CDATA and multibyte text decode correctly; unknown entity, mismatched tag, bad UTF-8 and missing name are rejected |
| W6, W7, W8 and queue count | pass | full-row equality on 43 tests and 40 commits; queue `count=50051 sql=50051`; both stores count through an index-only scan on `question_open` |
| W9 mixed (8 s, not 20 s) | pass on correctness | 27,221 reads with 0 errors; 46 saves and 22 ingests acknowledged; sequence gapless |
| Durability | pass for process crash | `kill -9` right after the mix: `DURABLE all acked writes present after kill -9: True`, `quick_check ok`; WAL with `synchronous=NORMAL`; PostgreSQL session `synchronous_commit` is `on` |
| Prepared statements and pools | pass by reading only | `prepare_cached` on SQLite, per-connection statement map on PostgreSQL; 8 read + 1 write and 16 read + 2 write connections (18 observed) |
| Registry: HTTP and OpenAPI | pass | `3.1.0`; `refs 11 unresolved []`, no `$defs` left; the HTTP document equals the CLI one |
| Registry: MCP | pass | `rmcp` 3.5.1 from `modelcontextprotocol/rust-sdk`, `protocolVersion 2025-11-25`, `tools/list` 4,461 bytes; schemas identical to the OpenAPI components; invalid input returns `isError: true` |
| Registry: CLI | pass | generated `--help` embeds the same schema JSON; invalid input and unknown operation exit 1 |
| Store path | pass by reading | dialect SQL now sits in `db.rs`; `ops.rs` has one code path |
| PostgreSQL stored data from the author's run | pass (read-only) | 180 batches with exactly 10,000 results each; `torn_commands 0`, `head_gaps 0`, `bad_basis 0`, `fts_stale 0`; `seq_vs_writes 1415 / 1415` |
| PostgreSQL failed-write rollback | pass | 6 failed write transactions leave `idle-in-transaction: 0`; the next read returns 200 |
| Driver error counting | pass by reading | warm-up, measured and audit errors all count; `run.sh` exits 1 when `overall_errors` is non-zero |

## Issues

1. **Server mode: a client disconnect in the middle of a write leaves an open transaction in the pool.** This is the one item I would fix or disclose.
   - **Proven:** after the disconnect, the pooled connection sits at `('idle in transaction', 'SELECT seq FROM project WHERE id=1 FOR UPDATE')` and still holds the project row lock.
   - **Inferred, not run** (it would have written to `cb_rust`): the next write on that connection runs inside the abandoned transaction, so its `COMMIT` also commits the abandoned request's partial writes, such as a command row with outcome `{}` and a bumped sequence with no version.
   - **Scope:** `benchmark.py` never aborts a request, so measured numbers are unaffected. By reading, SQLite mode is immune because the work runs to completion in `spawn_blocking`.
   - **Fix:** in `Store::call` (`ops.rs`, the non-SQLite branch), run the work in its own task so it always reaches `COMMIT` or `ROLLBACK`: `tokio::spawn(async move { invoke(lease.db.as_mut().unwrap(), &name, input).await }).await??`.
   - **Reproduce:** hold `BEGIN; SELECT seq FROM project WHERE id=1 FOR UPDATE; SELECT pg_sleep(2.5); ROLLBACK` in `psql`, send `POST /op/propose {"cmd":"x"}` on a raw socket, close the socket after 0.5 s, then read `pg_stat_activity`. The script is `tmp/verifier/pg.py`, phase B.

2. **The parser accepts some broken input as success.** Truncation inside a failure body returns 200 with `count 1, failures 1`; `hello world` and an empty body return 200 with `count 0`. Fix: fail at end of input if elements are still open or no `testsuite`/`testcase` was seen.

3. **Unlisted operations are callable over MCP and the CLI.** `tools/call` with name `w8` runs, although it is not in `tools/list`. Fix: reject names missing from `registry::operations()` in `call_tool` and the CLI path.

4. **A pass row carrying a message creates a signature and an open question** (`new_signatures: 1, questions: 1`). Fix: compute the signature hash only for failing rows.

5. **The SQLite WAL grows without bound under the mix.** It reached 423 MB after 8 s, and ingest time crept from about 200 ms to about 400 ms. Continuous readers probably prevent the WAL from restarting. This belongs in the report's "what limits it" section; an explicit `wal_checkpoint(RESTART)` or `journal_size_limit` on the writer is the likely remedy.

6. **Saves queue behind ingests on the single writer.** Save p95 during the mix was 390 to 480 ms. The spec only asks for this to be reported, and the machine was shared, so the number is provisional.

Outside the spec, so not requested:
- Self-closing `<failure message="…"/>`, `<error>` and `<skipped/>` are parsed as pass.
- A repeated command id with a different payload silently returns the stored receipt, which is what the spec wording asks for.
- An empty report creates a batch, target and run.
- Every error returns 400, including a missing case.
- By reading only: `time` is truncated to milliseconds rather than rounded.

## Not checked

- Full `run.sh`, its 10-minute limit, `results.json` and `REPORT.md` (both are still placeholders).
- PostgreSQL W4, W5 and W9 success paths by my own execution.
- The full 20-second W9 and all timing budgets.
- Cold start, memory, artifact size, build time and line counts.
- Power-loss durability.
- The parsed rows themselves: `/parse` returns only counts and byte totals.

## What I did that touched shared state

- **Row lock on `cb_rust`:** for the disconnect test I twice took a 2.5-second `FOR UPDATE` lock on `project` and rolled it back, each time with 0 other connections. Data was unchanged: `cb_rust unchanged: True`, `verifier rows: 0`.
- **Load during profiling:** my SQLite runs overlapped the author's profiling, so their timings in that window may be perturbed.

Scripts and outputs are in `$HOME/.cache/mainworthy-arena/stack/rust/tmp/verifier` (`verify.py`, `registry.py`, `mixed.py`, `pg.py`, with snapshots in `rev2/` and `rev3/`). Any further source change, including a fix for issue 1, needs a new round.
