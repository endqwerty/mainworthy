# Verdict: NOT PASSING yet — the final pipeline failed, so PostgreSQL is unverified on this revision

**Revision:** `ts/REVISION.txt` sha256 `9f9d3536…691ea9f6`; `sha256sum -c` gave 25/25 OK before and after my checks.

The source behaves correctly in every SQLite check I ran myself, on Bun and on Node. But `run-final.log` ends in an error, and `RUN_COMPLETE` was written anyway. The condition for the PostgreSQL W9 run was not met, so I did not run it.

## Blocker: the final run aborted in embedded mode

- `run-final.log` ends with `error: version: expected delta 1100, got 0` at `bench.ts:157`, right after W4. `run-duration.txt` says 35.566 s, which is far too short for a full `CB_EXTRAS=1` run.
- Nothing after embedded W4 ran. `server.json` (22:27), `node.json` (22:29), `pglite.json` (22:42), `openapi.json` and `registry-proof.json` (22:27) all predate the 22:54 source freeze.
- `results.json` (22:54:46) was rebuilt by the EXIT trap from those stale files.
- `embedded.json` was rewritten at 22:55:17, 31 s after the failure; I could not tell what wrote it.

**Likely cause: a port collision, not a source bug.**
- A judge run of a frozen ts copy (`judge/stack/frozen/ts-run2`) was listening on the same port 30452 when I looked at 22:58.
- `bench.ts:60-61` accepts any server that answers `/health`. I confirmed a second server on a taken port exits with code 1 only after about 200 ms, so the bench can attach to the foreign server first.
- Deterministic command ids already used on that server would then replay: valid receipts, W4 p95 of 0.27 ms, delta 0. That matches the log exactly.
- I did not see the 22:54 collision itself; this is inference from the log and the 22:58 process list.

**To clear it:** rerun `CB_EXTRAS=1 ./run.sh` while nothing else uses port 30452 or `cb_ts`, and write `RUN_COMPLETE` only on exit 0. The judge's copy also resets `cb_ts`, so the two runs corrupt each other's PostgreSQL numbers as well.

## What I checked myself

All on my own seed copy in `ts/verification`, port 30457, against the built `dist` artifacts.

| Group | Result | Deciding values |
| --- | --- | --- |
| W4 seal-save (Bun) | pass | One save: version, question, decision, command and seq each +1; replay returned the identical receipt; head moved to 2 and the new term is searchable. |
| W5a JUnit parse | pass | The real `junit.xml` (917,442 bytes) through `src/xml.ts`: 10,000 rows, 200 fail, 9,800 pass, 10,000 unique keys, 20 distinct messages, matching an independent regex count; parse took 201 ms. |
| W5 ingest of that XML | pass | result +10000, test +10000, question +20, signature +20, target/batch/run/seq +1; replay inserted 0 with no count change. |
| Write routing from registry | pass | `sqlite-pool.ts:32` now reads `registry.effect`; propose and report land on the writer on both Bun and Node. Duplicate dispatch is gone; `dispatch` only serves bench read paths. |
| Dialect behind `Db` methods | pass | `workloads.ts` calls `db.search`, `db.replaceSearch`, `db.lockProject` and has no dialect branches left. |
| Node 26 server | pass | `node dist/node.js` (v26.11.1): save +1 on the five counters, replay identical, stale base → 400 version conflict, ingest deltas the same as Bun (result/test +10000, question/signature +20), replay 0, missing ref → 400, rollback no change. `get` is byte-identical to Bun's. |
| Mixed concurrency, SQLite | pass | 8 s, 16 readers + ingester + saver: 13,741 reads, 0 errors, read p95 23 ms, 26 ingests and 26 saves; result +260,000 and version +26 exactly; 0 duplicate open fingerprints. |
| FTS quick_check observation | not reproduced | A long-lived read-only connection held across the mixed load returned `ok`; a fresh connection returned `ok`; FTS `integrity-check` passed. |
| Cold start through `/health` | pass | Three runs each: binary 219–250 ms, Bun bundle 217–223 ms, Node 260–274 ms. |
| Artifact size and build | pass | Binary 91,408,352 bytes; `server.js` + worker = 605,981; `node.js` + worker = 527,742; all three match `build-metrics.json`. |
| Typecheck | pass | `bun run check` → `tsc --noEmit` clean in 0.6 s. |
| OpenAPI `$id` | pass on source, file stale | Freshly generated from binary and bundle (identical): 6 unique `urn:mainworthy:<op>:<input\|output>` ids, 6 refs, 0 dangling. `openapi.json` on disk still differs by 30 diff lines because `registry-proof.ts` never ran. |
| MCP and CLI | pass | Stdio on the binary: tools `get, propose, report` with `readOnlyHint` true/false/false; `get` returns structured content; bad input → `isError`. CLI `get` matches. |
| PGlite persistence | pass, limited | Through `src/db-pglite.ts` on disk: a committed row survives close and reopen, and survives SIGKILL right after commit; a thrown transaction rolls back. It reports `fsync=off`, `synchronous_commit=on`. |
| PostgreSQL, all workloads and W9 | not checked | Precondition unmet, and the judge's run was resetting `cb_ts`. No PostgreSQL evidence exists for this revision. |
| `run.sh` | reviewed, not run | Defaults to required modes, `CB_EXTRAS=1` gates Node and PGlite, EXIT trap aggregates. The trap is what produced a fresh-looking `results.json` from stale inputs. |

## Safety fact

Holds.
- `../seed.db` sha256 is `7df55936…3848b0`, matching `ts/seed.sha256`.
- `db-pg.ts:8` still refuses anything except `cb_ts` on `127.0.0.1:54329`.
- I made no connection to `cb_ts`, and did not touch `work.db`, `node-work.db`, `pglite-data` or any benchmark output.
- `ts/verification` is empty again, nothing is listening on 30457, and no process of mine remains.

## Smaller findings

- **The bench does not check that the server is its own child.** This is the mechanism behind the blocker; it would also report a bogus cold start.
- **Failure messages are trimmed.** The generated text is 420 characters and the parsed message is 419, because the XML parser drops the trailing space. Harmless here, but messages feed signatures.
- **Earlier notes still stand:** tally replaced per batch, every error is HTTP 400, bind-parameter bound on report size, saves queue behind ingests on SQLite.

## Review limits

- Whole-source review was partial: I read `db.ts`, `db-pg.ts`, `db-pglite.ts`, `sqlite-bun.ts`, `sqlite-pool.ts`, `sqlite-worker.ts`, `registry.ts`, `main.ts`, `invoke.ts`, `schemas.ts`, `xml.ts` and `run.sh` in full, and only grepped or part-read `workloads.ts`, `bench.ts` and `pglite-extra.ts`.
- `sqlite-node.ts`, `driver-choice.ts`, `aggregate.ts`, `build-metrics.ts` and `registry-proof.ts` were not read this round.
- W1–W3 and W6–W8 answers were not re-compared against independent SQL this round; round 1 did that on an earlier revision.
- PGlite at full scale, PGlite mixed concurrency and power-loss recovery are untested, as agreed. `fsync=off` means its durability is not comparable to native PostgreSQL.
- I did not time a full `run.sh`.

Finished 23:02 PDT.
