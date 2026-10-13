# Verdict: TypeScript stack candidate — PASS on current source, with 2 issues to fix before the final run is trusted

**Revision:** `ts/REVISION.txt` sha256 `952b6594b48683d2732f3bd0c9f623d2659f893aac9086d378d7debc5a0d3368`. `sha256sum -c REVISION.txt` gave 25/25 OK before and after my checks.

I found no wrong fast answers, no omitted work, and no idempotency, atomicity or basis errors. The two issues are a `run.sh` time margin that is too thin and a stale `openapi.json`.

**Safety fact:** holds.
- The shared seed is unchanged: `sha256sum ../seed.db` = `7df55936…3848b0`, matching `ts/seed.sha256`.
- `db-pg.ts:8` refuses anything except `cb_ts` on `127.0.0.1:54329`, and `run.sh` drops/creates only `cb_ts`, connecting through `postgres`.
- My `cb_ts` `/counts` were identical before and after (seq 221314, open 51840), and I left 0 connections.
- My scratch lived only in `ts/verification` and is removed. I did not run `run.sh` or the build, driver-choice or PGlite scripts, and did not read the go or rust candidates.

## How I checked

I ran the already-built `dist/server.js`, `dist/mainworthy` and `dist/node.js` on port 30457 against my own seed copy, and compared responses with independent SQL (`bun:sqlite`, `sqlite3`, `psql`). On `cb_ts` I used SELECTs, replays of existing commands and batches, and `/rollback` only.

## Check groups

| Group | Result | Deciding values |
| --- | --- | --- |
| W1 read | pass | SQLite 8/8 and PG 4/4 refs match on id, head, hash and parsed body; missing ref 100001 → 400. |
| W2 folder page | pass | SQLite 4 pages and PG 3 pages match on ids, order, linked-test count, last outcome and open count; `x-queries: 3`. Open count is index-only on both stores (`COVERING INDEX question_open` / `Index Only Scan`). |
| W3 search | pass | SQLite 72 queries (2,959 rows) and PG 46 queries (1,878 rows): same count and same scores as an independent query, all in folder scope; 0 mismatches. |
| W4 seal-save | pass | One save changed exactly version, question, decision, command and seq by +1. Head, hash, rev, parent, adopt/decided question, decision basis and stored command outcome all agree; full-text index holds one row for the case, the new term hits and the old term is gone. |
| Command replay | pass | SQLite replay returned the identical receipt with counts unchanged. PG replay of `server-bun-save-0..2` returned the stored outcome, with the matching version, question and decision rows present. |
| Rollback | pass | `/rollback` on both stores: seq and all counts unchanged; no `arena-rollback-proof` command row in SQLite. |
| W5 ingest | pass | One report: result +10000, test +100, signature +10, question +20, target/batch/run/seq +1. 200 fails, 9,900 assumed with the correct case and head, 100 unresolved, 0 bad basis rows, 20 signatures of which 10 seeded were reused; tally `{total:10000,pass:9800,fail:200}`. |
| Batch replay and uniqueness | pass | SQLite replay inserted 0, counts unchanged. A second batch with the same messages added only batch, results and seq; 0 duplicate open fingerprints. PG replay of `server-bun-report-181/182` inserted 0, left no stray target, and the durable rows show 10000/200/9900/100 with 0 bad basis. |
| W5a JUnit parse | not checked | Read `xml.ts` and the bench assertions only; the author's files show 0 errors. |
| W6–W8 | pass | History for 5 tests (SQLite) and 3 (PG), gate rows, and the queue's 50 ordered ids, parsed evidence and open count all match SQL. |
| Mixed concurrency | pass (SQLite), partial (PG) | SQLite, 6 s, 16 readers + ingester + saver: 0 errors, 7–13k reads, read p95 17.6–33 ms, 29 ingests of 137–510 ms; durable result +290,000 = ingests × 10,000. PG: read-only 16-client run only (6,400 reads, p95 24 ms, 0 errors), because writes were off limits. |
| Registry, HTTP, MCP, CLI | pass | Real stdio `tools/list` and `tools/call get` through the SDK client against all three artifacts: tools `get,propose,report`, 5,209 bytes, invalid input → `isError`. CLI `get` (binary and bundle) is byte-identical to HTTP `get`; Node HTTP `get` matches Bun. |
| OpenAPI | issue 2 | Current source is correct; the file on disk is stale. |
| Typecheck | pass | `bun run check` → `tsc --noEmit` clean in 0.4 s. |
| Benchmark script | pass with notes | 100 warm-ups plus the stated counts for every workload; errors counted and exit non-zero; client timing includes request serialisation; W3 filters exactly 20%. |
| `run.sh` under 10 minutes | issue 1 | Not run by me. |
| Cold start, memory, build metrics, PGlite | not checked | Author's `node.json` and `pglite.json` show 0 errors. |

## Issues

1. **`run.sh` is at risk of exceeding 10 minutes with extras on (the default).** There is no end-to-end timed run. Output file times from the last runs give:
   - embedded 76 s (22:23:57 → 22:25:13)
   - server 109 s (→ 22:27:02)
   - Node 124 s (→ 22:29:11)
   - PGlite about 160 s (22:40:04 seed info → 22:42:35, plus the load)
   - driver choice up to 108 s, plus build and resets

   That is roughly 9–10 minutes under today's contention. Most of it is the 100 warm-up ingests per store. Reproduce with `time ./run.sh`. Either time one full run, or default `CB_EXTRAS=0`, or cut the warm-up ingests in the extras. Because of `set -e`, an extras failure also aborts before `aggregate.ts`, leaving `results.json` stale; `pglite-run.log` records one such abort.

2. **`openapi.json` on disk is stale and has dangling refs.** `diff <(dist/mainworthy openapi) openapi.json` shows the file lacks the `$id` lines that current source emits (`registry.ts:20-21`). Without them, the six `#/$defs/__schema0` refs point at the document root, where no `$defs` exists. Re-running `registry-proof.ts` in the final pipeline fixes it. `REPORT.md` is likewise still marked interim.

## Low-severity notes (not blockers)

- **Write routing duplicates the registry.** `sqlite-pool.ts:30` hard-codes `/api/propose` and `/api/report` as writer paths instead of using the registry's `effect`. A fourth write operation would need that line too, or it runs on a reader connection. `Workloads.dispatch` also repeats get/propose/report (reachable as `/bench/propose`), bypassing output validation. Results stay correct because ids are allocated inside `BEGIN IMMEDIATE`.
- **Run tally is replaced, not accumulated.** A second batch for the same commit overwrites the tally with that batch's own numbers. The spec is ambiguous here.
- **Same command id with a different payload** returns the stored receipt with 200 and no conflict signal. This is what the spec asks for.
- **Seeded signatures are matched by sample text** from a map loaded at start-up, because the seed's hashes are synthetic.
- **Every error returns HTTP 400**, including not-found and version conflict.
- **Reports are bounded by bind-parameter limits**: the known-test lookup binds one parameter per result, so about 32k results on SQLite and 65k on PG.
- **Saves queue behind ingests on SQLite.** I saw 30 saves in 6 s, max 280 ms; the author's W9 shows save p95 782 ms and ingest max 1,635 ms. Both are inside the stated budgets.
- **W3 warm-up reuses 100 of the 500 measured queries.**
- **One unexplained observation.** `PRAGMA quick_check` on my own long-lived read-only connection reported `fts5: checksum mismatch` twice after heavy writes. Fresh connections (CLI and Bun, SQLite 3.53.4) on the live and closed database returned `ok`, the FTS `integrity-check` passed, and search through all reader workers returned fresh results. I could not attribute it to the candidate.

Finished 22:50 PDT.
