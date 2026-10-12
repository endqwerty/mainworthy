# Verdict: PASS on the current source, with one finding to state in the report

**Revision:** `ts/REVISION.txt` sha256 `65ae4cd1…5e7445`; `sha256sum -c` gave 25/25 OK before and after my checks. Finished 23:16:30 PDT.

The two-line correction is right and works. However, the corrected comparison now selects postgres.js, not Bun.sql, so the "selected Bun.sql stack" no longer matches the candidate's own files.

## Finding: the selection has flipped to postgres.js

- **What the files say:** `selected-driver.txt` is `postgres`, and `driver-choice.json` and `results.json` both record `selected: postgres` (ingest ranges separated, point reads overlapping).
- **Rerun numbers (author's, not reproduced by me):** ingest 199–218 ms on postgres.js against 255–304 ms on Bun.sql.
- **Rerun is complete and on current source:** 12 log lines, 12 `driver-*` batches in `cb_ts`, written 23:11:59 after `db-pg.ts` at 23:09:11.
- **Consequence for a fresh run:** `run.sh` exports `PG_DRIVER` from `selected-driver.txt`, so `./run.sh` on this revision would run server mode on postgres.js. That path has no W1–W9 run and only the probes below.
- **Which driver produced `server.json` is unrecorded:** no artifact names it, and the earlier `driver-choice.json` was overwritten. Bun.sql for the 23:08 run is the author's statement only.
- **`REPORT.md` is stale on this:** line 50 still says the comparison "is being rerun" and that Bun is preferred "if the tuned difference is inconclusive". By the script's own rule it is not inconclusive.

The report needs to say which driver the W1–W9 server numbers belong to and that the corrected choice has no required-mode run behind it.

## Pass

| Check | Result |
| --- | --- |
| Manifest diff | `REVISION-r3.txt` and `REVISION.txt` differ on the `src/db-pg.ts` line only. |
| Change is exactly the two options | Stripping `,{prepare:true}` from current `db-pg.ts` reproduces the round 3 hash `6a2851f6…`; the string occurs twice (lines 21 and 22). |
| Library source, postgres 3.4.9 | `index.js:119-127`: `unsafe` sets `prepare: false` before spreading the caller's options, so an explicit `true` wins. `connection.js:232` requires both the client and the query option. |
| Library behaviour, one connection | Default `unsafe` with a parameter left `pg_prepared_statements` empty. With `{prepare:true}` it listed one named statement, reused on the second call. Same result inside `begin`. |
| Adapter, regular path | `openPg('postgres')` read of case 4242 left a named statement on the same backend pid. |
| Adapter, transaction path | An `UPDATE kase` and a read inside `db.transaction` both showed as named statements; the read saw the new title; after the throw the row was identical. |
| Operation code on postgres.js | `get` for ref 4242 matches `psql` on title, head number, head hash and rev. `rollbackProof()` returned seq 221485 → 221485 with counts and head unchanged. |
| No committed change | Command, version, question, decision and batch counts and project seq were identical before and after. No rollback-proof or verifier command row exists. |
| Typecheck | `bun run check` (`tsc --noEmit`) exit 0. |

## Limits and things not checked

- **No W1–W9 or mixed load on postgres.js.** My evidence for that driver is one read, one rollback, `get` and `rollbackProof`.
- **Driver timings not reproduced.** The comparison stays provisional; other candidates were running (a Rust judge run was active).
- **Bun.sql path not re-run this round.** It is byte-identical to round 3 by hash, and I relied on that.
- **Unchanged from round 3 and not repeated:** SQLite save, ingest, replay and mixed load, CLI, MCP, OpenAPI, the startup ownership refusal, and every item in round 3's "not checked" list.
- **Parameterless queries stay unprepared** on postgres.js (`simple` is forced when there are no arguments). This is harmless, but "prepared queries" is not literally every query.
- **Statement-cache growth under bulk inserts not checked.** My session ended with 13 named statements.
- **Build figures postdate the timed run.** `dist/`, `build-metrics.json` and `results.json` were rewritten at 23:14:43, so the build figures are not from the 23:08 run. None of these are in the manifest.

## Safety fact

Holds, with one side effect.
- `rollbackProof()` calls `nextval('ids')`, which does not roll back, so the `ids` sequence in `cb_ts` advanced. No rows were committed.
- `../seed.db` sha256 matches `ts/seed.sha256`.
- I wrote no source, did not run `run.sh` and reset nothing. I touched only `cb_ts`; 0 connections were open before and after.
- `ts/verification` is empty; the one scratch file is deleted.
- I read only `ts/` and the shared seed hash, no other candidate.
