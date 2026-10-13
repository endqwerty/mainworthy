# Round 2 verdict: PASS

The RUST candidate meets the spike SPEC on the frozen revision in both store modes, and all four round-1 defects are fixed. I ran every check myself from 22:32 to 22:38 PDT; nothing is carried forward from round 1.

Verifier: Claude Opus 5.5 (Anthropic), independent of the author (Codex). All checks went over real HTTP on port 18485 with an independent SQL oracle (sqlite3 read-only, `psql`). Embedded mode used my own copy of `seed.db`. Server mode used `cb_rust` recreated from `cb_seed` while I held the exclusive flock on `rust/.run.lock` (22:32:38 to 22:38:00).

## Revision judged

| File | SHA256 |
| --- | --- |
| `src/db.rs` | `2c9c7331f1108032633ffb2f595240b94b43169ee5acdada167eafc4c9a1dfe8` |
| `src/main.rs` | `26d6137c00ae3c0d7605fadfe1601f7dbd3b0c616951b600fe2e8c4fe77edf92` |
| `src/ops.rs` | `c659d159a5ec289bdb8eb983b10684be6b2621a5f6f3eb0aaa6006c275321831` |
| `src/registry.rs` | `83c98ac4bc44e3ae6ee09c40516a71ed037b5564739f798325750d40cd562bed` |
| `Cargo.toml` | `57aa466993a804f61ddc4b895c008fd36ade632e099f2a3cefad868ea6cdf11e` |
| `Cargo.lock` | `b4e61889e9297260f25c54db68bb987abc46b3736541b5b26604a238eb6d6868` |
| `benchmark.py` | `81a6f1e6b71801f29c3cb857de40de038226d0774ccf84345dce8a81748a38bc` |
| `build.py` | `5830eb7dc099084cd9d9c741835035fb874ffbf4270e40292a1ddfe1c9b6e0b1` |
| `run.sh` | `08d3905a5ad621d654efb1404170b9c55cd8d14ee54c8e8ccce1ffa6c6598da5` |
| `CHECKS.md` | `57522770b1e4dc18d9c1e5a0ebbcbf593c3b80ae9afc03134bfcec4674ae7022` |
| release binary | `4a94d16bf92a6e5ed0a8d6df17cbe3485c3fa5e25b5a22a43b63b76896ddee9f` |

The hashes were identical before and after my runs. The author's separate clean build (`final-clean-target`, finished 22:34:59) produced the same binary hash, so the binary matches this source.

## Safety fact

Acknowledged writes are atomic, applied once per command id or batch key, and survive a process crash. This is now proven by execution in both stores, including successful PostgreSQL W4 and W5, rollback, replay, client cancellation and `kill -9`.

## The four round-1 fixes

| Round-1 issue | Status | Deciding lines |
| --- | --- | --- |
| PostgreSQL write abandoned on client disconnect | fixed | With the project row locked by another session and the client socket already closed: `during=[('active', 'Lock', 'SELECT seq FROM project WHERE id=1 FOR UPDATE')]`. After release: `after_non_idle=[] conns=18 delta={'seq': 1, 'command': 1, 'version': 1, 'question': 1, 'decision': 1} outcome=complete`, for both RST and FIN closes. |
| Truncated or non-XML input accepted | fixed | 14 broken inputs all return 400, including truncated in a failure body, empty, plain text, two roots and trailing text. Valid input still parses: `count 10000, failures 200, message_bytes 80600`, equal to the expected bytes. |
| Unlisted operations callable over MCP and CLI | fixed | MCP `tools/call` for `w8`, `w2` and `audit` returns `isError` with `Unknown registered operation`; CLI `w8` and `audit` exit 1; `POST /op/w8` is 404. |
| Passing row with a message raised a signature and question | fixed | The report adds `signature +10` and `question +20`, the failing ones only; the passing row stores its message with `signature` NULL. |

After the mid-lock disconnects, the stored rows equal the input, the four following writes give `delta={'seq': 4, 'command': 4, ...}`, and replaying the disconnected command returns its receipt with no write. Disconnects 0 to 0.15 s into a running ingest are all-or-nothing in both modes, with 0 open transactions afterwards.

## Workload correctness (both modes unless noted)

| Check | Status | Deciding lines |
| --- | --- | --- |
| W1, W2, W6, W7, W8 | pass | Full-row equality with SQL, `mismatches=0`: 32 refs, 8 pages, 15 tests, 15 commits, each run twice; queue `count=50070 sql=50070` on PostgreSQL after writes |
| W3 search | pass | 25 queries, 1,250 hits: scores, ids, fields and area scope equal an independent bm25 / `ts_rank` query |
| W4 seal-save | pass | `delta={'seq': 1, 'command': 1, 'version': 1, 'question': 1, 'decision': 1}`; body, sha256 hash, head, title and search document equal the input |
| W4 idempotency and head basis | pass | Replay gives `delta={}`; 12 concurrent identical commands write once; 12 concurrent saves on one case give `nos=2..13 seqs=219969..219980 head=13`; 8 saves on one base give `[200, 400 x7]` |
| W4 rollback | pass | `400 conflict: base version 5, head 6` with `delta={}` and no command row |
| W5 report | pass | All 10,000 stored rows equal the input by ordinal: `bad=0 {'fail': 200, 'assumed': 9900, 'unresolved': 100, 'sig': 200}`; after a save, `basis_version=2 saved_no=2` |
| W5 replay and concurrency | pass | Replay `delta={}`; 4 concurrent identical batches give `replays=[False, True, True, True]`; one open question per fingerprint (`max=1`); invalid report 400 with `delta={}` |
| W9 mixed, 8 s | pass on correctness | Embedded `reads=29534 errors=0`; server `reads=19825 errors=0` |
| Crash (`kill -9` during a write) | pass | Every acknowledged write present, `torn_cmd=0 torn_batch=0`, sequence gapless; SQLite `quick_check ok`; a write after restart succeeds |
| Schema and settings | pass | SQLite schema equals the seed's; PostgreSQL has the 36 shared indexes and no others; queue count is index-only in both; `synchronous_commit` reads `on` |
| Registry | pass | OpenAPI `3.1.0` with exactly three paths and every `$ref` resolved; MCP `rmcp 3.5.1`, protocol `2025-11-25`, `tools/list` is exactly `get, propose, report` at 4,461 bytes; tool schemas equal the OpenAPI components; CLI help is generated |

## Remaining limitations

These are disclosed by the author and not fixed; I agree they are limitations, not SPEC failures.

- **SQLite WAL growth under continuous reads:** I did not re-measure the peak; the author's W9 records it.
- **Saves queue behind ingests:** in my 8 s mix, save p95 was 311 ms embedded and 296 ms server, against an ingest max of 354 ms and 334 ms. The SPEC only asks for this to be reported. In server mode the project row lock serialises writes, so the second write connection adds no concurrency.

By reading only, none blocking:

- **No reconnect:** the PostgreSQL pool never reconnects after a lost connection.
- **Panic in a write handler:** it would return a connection to the pool mid-transaction; I found no reachable panic in the write path.

## Not checked

- The full `run.sh`, its 10-minute limit, the final `results.json` and `REPORT.md`.
- The 20-second W9 and all latency budgets.
- Cold start, memory, artifact size, build times and line counts.
- Power-loss durability.

## State left behind

- **Missed repeat:** an author-side `./run.sh` was started while I held the lock (seen at 22:32:57) and left no results, so if a repeat is missing, that is why.
- **`cb_rust`:** back at the seed state (`seq 219966`, 200 batches) with 0 connections; I never connected to `cb_seed`.
- **My processes:** servers are stopped, port 18485 is free, my SQLite copy is deleted and the flock is released.
- **Untouched:** no source was edited and `work.db` was not modified.

The verdict is filed at `/home/endqwerty/.cache/mainworthy-arena/stack/rust/tmp/verifier2/verification-r2.md`, with `v2.py`, `extra.py` and their outputs beside it. Any further source change needs a new round.
