# AUX-R1 verification report: the archive (export and import) and the reader threads

- **Revision judged:** `aa7a6050526bf44ebabeef2ca648b37d0bc796ec` (branch `t3/mvp-product-delivery`), from a clean
  `git archive` export at `/home/endqwerty/.cache/casebook-arena/verify/aux-r1/tree`. Nothing in the repository was
  changed. (The checkout itself had moved on to `a1ec56e` with other agents' uncommitted edits by the time I finished;
  none of that was judged.)
- **Verifier:** Claude Opus 5.5 (Anthropic), independent of the author (GPT 6.1 Sol). Bun 1.4.3, Linux x64, 16 cores,
  a machine shared with other reviews, so timings are noisy.
- **How:** every check below was run by me against the real code: real servers started with
  `bun src/cli/main.ts serve` (or `start()` in-process where I had to reach inside), on loopback ports 7900 to 7949.
  My scripts are in `scratch/`, their output in `logs/`. Data directories were removed at the end; to rerun a script,
  run `bun install --frozen-lockfile` in `tree/` first (I removed `node_modules` and `dist` to give the disk back).

**Result: one blocker (F1), three defects that do not block (F2, F3, F4).** The archive's central promise held in every
run: nothing lost, altered, duplicated or reordered, and every refused import left the target untouched.

## The twelve checks

| # | Check | Verdict | What I ran, and the lines that decide it |
|---|---|---|---|
| 1 | Authors' archive tests, types, lint | **pass** | `bun test src/server/transfer src/cli`: `75 pass 0 fail 2618 expect() calls, Ran 75 tests across 5 files`. `bunx tsc --noEmit`: exit 0, no output. `bunx biome check src test`: `Checked 170 files in 113ms. No fixes applied.` Whether the tests prove their names: see "The tests do not prove this". I read the fixtures, the helpers and a sample of test bodies, not every body. |
| 2 | Round trip of a real instance, then keep using it | **pass** | `scratch/fixture.ts` builds an instance over HTTP with 8 actors (owner, two humans, an agent, a CI actor, one later forgotten, one revoked), 3 projects on 3 presets, cases with up to 6 versions and a restore, folders (nested, renamed, moved, archived), tags, requirements, proposals (adopted, open, rejected, stale-base), policy switches, CI reports with failures and a correction, questions (open, decided, undone and asked again), planned runs with slots, a closed run, a withdrawn sign-off, a review with findings. Export over `GET /api/export`, import over `POST /api/import` into a fresh server (`scratch/roundtrip.ts`): `A vs B (same process that imported): 5269 reads compared (2469 of them 200 replies), 0 differ`; the same after a restart with readers=0 and with readers=4; control `A vs A again: 0 differ`. Reads: `get` (data, md, fields, each version), `find` in all 8 kinds with text, folder, tag, state, run, paging; `inbox` open and decided by kind with paging; `gate`; `timeline`; `history`; `since` and `impact` with the original's cursors; `check`; admin lists. File level (`scratch/dbcompare.ts`): `tables differing (tokens expected): 1; rows compared in A: 453`, `integrity_check: ok`, `foreign_key_check: []` on both; tokens `6` in the original, `0` in the import. Continuation (`scratch/continue.ts`, the same 19 commands on the original and on the import, import served with readers=4): both hand out `P-23, Q-39, C-11, C-12`, `seq 67…78`, `R-9`, `Q-42…45`, decisions `32…36`; a decide, an undo and a second decide work; replayed commands with their old `cmd` return the stored reply on both. `16/19 replies equal`; the 3 that differ, and all 63 differing reads afterwards, involve only the cases created after the import, whose step ids are random on each instance. |
| 3 | Fidelity | **pass** | `scratch/fidelity.ts` writes extreme values into a copy of the fixture database with SQL, exports, imports, and `dbcompare.ts` compares every value with its storage class: `tables differing (tokens expected): 1; rows compared in A: 466`. In the imported file: counters `9223372036854775807` and `-9223372036854775808`; `duration_ms` `9007199254740993` and `9007199254740992`; one text value of 4,500,000 characters (13,500,000 bytes); a value with a leading byte-order mark, all control characters U+0001 to U+001F, U+007F, U+2028/2029, combining marks, ZWJ emoji and U+10FFFF; empty strings and NULLs kept apart (`proposals`: reason NULL 14 / empty 1, cause NULL 23 / empty 1); JSON text kept byte for byte, including odd spacing and a duplicate key; text that looks like a number (`'123'`, `'1e5'`, `'null'`, `'-0'`) still text. Search: the import's `find` replies equal the original's for 31 queries per project, among them prefix (`coup`=1, `prefixsearch`=1, `multi wor`=1), multi-word (`login works`=1, `works login`=1, `save10 total`=1), CJK (`雪だるま`=1) and no-hit queries. The schema is all `STRICT` with no REAL or BLOB column, so there is no float or blob path to lose. |
| 4 | Refusals | **pass** | `scratch/refusals.ts`, all against one running target through `POST /api/import`, with the database fingerprinted (every row of every table, tokens and search index included) before and after each attempt: 13 truncations (byte 0, 1, mid-header, end of header, mid-row, inside a multi-byte character, before and inside the footer), not-JSON lines, a blank line, unknown table, the excluded `tokens` table, unknown and missing column, wrong types, an integer beyond 64 bits, NULL in a NOT NULL column, schema one lower and one higher, format 2, missing or doubled header, duplicated lines (with the footer untouched and with every count and digest recomputed), a removed row (also with counts recomputed: `archive foreign key violation in table reviews, referencing cases`), wrong footer count, wrong and upper-case digest, a flipped character, data after the footer, two archives in one body, empty body, CRLF, a byte-order mark, invalid UTF-8, gzip bytes, a row setting `meta.schema_version`. Each: HTTP 400, a message naming the fault and usually the line, fingerprint unchanged, target still answering. `BAD count: 0`. Afterwards the good archive imported into that same target: `200`, `reads equal to the original after that import: 405/405`. Targets that are not empty (one case added; one extra actor; a second project; policy switched; an already imported instance): `409 import needs a fresh instance; existing projects or user data will not be replaced`, unchanged. Server mode: no token and wrong token `401`, a token without `admin` `403`, for both routes; the owner's export holds no token, secret or hash. |
| 5 | Size and streaming | **pass** (see F2) | `scratch/size.ts`, real servers, archive spooled to disk: `results=50000 rows=172083 archive=42.7MB: export 470 ms, peak RSS 173 MB; import 3694 ms, peak RSS 192 MB` · `results=200000 rows=472107 archive=122.5MB: export 1313 ms, peak RSS 212 MB (start 77); import 12779 ms, peak RSS 222 MB (start 93)` · `results=400000 rows=872139 archive=229.2MB: export 2751 ms, peak RSS 254 MB; import 24345 ms, peak RSS 239 MB`. Time grows in proportion to size. Memory does not: 5.4 times the archive adds 81 MB (export) and 47 MB (import). Sampling the kinds of memory during a 267 MB export (`scratch/rsskind.ts`): heap `70 -> 125 MB`, file-backed pages (SQLite's memory map of the database) `36 -> 148 MB`; so the growth follows the database being mapped, not the archive being held. `gate` and `find` on the import equal the original at each size. No spool file was left in the temp directory after any run. |
| 6 | Export during writes | **pass** (see F3) | `scratch/snapshot.ts`: 8 exports taken while 3 clients proposed, reported and decided and a fourth sent 6,000-result reports (`writes acknowledged while exporting: propose 27, report 27, decide 27, big 23`). Every archive imported; for each: `integrity ok; fk violations 0; dangling decision refs [versions.decision:0 placements.decision:0 covers.decision:0 tests.linked_by:0 excuses.decision:0 decisions.supersedes:0 policies.decision:0 runs.signoff:0 slot_results.discounted_by:0 depends_on.decision:0]`, and a server started on it answered `check`, `inbox` and `find runs` with 200. 7 of the 8 snapshots caught a report between its two transactions (`batches: accepted 1`), which is a consistent state; what the importing server then does with it is F3. |
| 7 | Authors' reader tests | **pass** | `bun test src/server/readers.test.ts test/http.test.ts test/architecture.test.ts`: `40 pass 0 fail 581 expect() calls, Ran 40 tests across 3 files`. |
| 8 | Parity and authorization | **issues: F1** | `scratch/parity.ts`: two servers on copies of the same data, `CASEBOOK_READERS=0` and `=4`, server mode. For each of 10 callers (owner; agent; human; a token limited to another project; a read-only token on one project; a token without `read`; a forgotten actor's token; a revoked token; no token; an unknown token): 5,175 to 5,269 well-formed reads over every read operation and 4 project names, plus 4,642 odd inputs (not JSON, wrong types, out-of-range limits, bad cursors, an unpaired surrogate, FTS syntax, unknown project and operation, an invalid write). `0 differ` for every caller in every operation reply, byte for byte (no reply carries a timing field). After identical writes on both (case, agent proposal, report, decide, undo, plan, run result, a project created after the readers started, a policy switch): `5282 reads, 0 differ` for owner and agent, `5175, 0 differ` for the limited token. The only differing bytes in the whole run are in the web page served for `GET` on an API path (Bun's bundle name differs per process), which is not an operation. Dispatch (`scratch/isolation.ts`, `pool.run` wrapped to record every call): no token, unknown token, no `read` capability, a token limited to another project, a forgotten actor's token, a revoked token, an unknown project, an unknown operation: `dispatched 0` each; allowed reads `dispatched 1`; a write and an admin call `dispatched 0`. **The exception is F1:** after `actor.forget` the two configurations give different replies. |
| 9 | Read after write | **pass** | `scratch/raw.ts`, over HTTP in server mode, 24 clients, each writing and at once reading back: a new case (`get`, `find` by a unique word, `timeline`), an edit, a report (`gate` not pending, the question open), a decision, an undo, and every fourth round a new project, a new token used at once, a token limited to its project, and a forgotten actor's token refused at once; every read's `seq` must be at least the write's. Meanwhile 20,000-result reports run back to back. `readers=1: 1152 read-after-write checks, missed 0; large reports completed meanwhile 19` · `readers=4: 1372 checks, missed 0; 18` · `readers=8: 1152 checks, missed 0; 19`. (My first run reported one miss per round at every reader count; the probe was wrong, not the server: `inbox on:` takes a case, run, test or change, not a question. Corrected and rerun.) |
| 10 | Isolation | **issues: F4** | **Read-only** (`scratch/isolation.ts`): on a reader connection, `invoke` of `propose`, `report`, `plan`, `claim`, `decide`, `admin project.create`, `token.create`, `actor.forget`: `internal: attempt to write a readonly database`; raw `INSERT`, `UPDATE`, `DELETE`, `CREATE TABLE`, `DROP TABLE`, an FTS insert, `PRAGMA user_version`, `VACUUM`, `BEGIN IMMEDIATE`: all throw the same; a real reader thread sent write operations directly: `forbidden: reader threads cannot write` for each; database fingerprint `UNCHANGED`. **Threads dying under load:** 48 clients reading, 12 kills in 3 s (a crash from a bad message, a single `terminate`, all four at once, in turn): `requests sent 7766: correct 7766, wrong 0, failed 0; answered by a thread 6758, replayed inline 258; threads alive now 4`, and the next read was answered by a thread. **Shutdown: fails as a client sees it, F4.** **Second server on the same directory:** not refused. In my runs it was safe: two servers taking writes at once for 10 s (`acknowledged writes 216; not visible on the other server: 0; duplicate case refs: 0`, integrity ok, no foreign-key violation, no error in either log), and a second server started 8 times while the first applied 40,000-result reports (`acknowledged reports 14`, each applied exactly once, `results per batch: 40000 x 14`). Not proven safe in general: see "Not checked". |
| 11 | The checkpoint thread | **pass** | **Log size** (`scratch/wal.ts`, 1,500-result reports back to back plus 32 to 48 reading clients): `readers=4, 40 s: WAL MB at 10/25/50/75/100% of the run 25.6/86.2/116.9/116.9/116.9` · `readers=8, 150 s: 51.1/122.7/136.5/136.5/136.5` (416 reports, 86,914 reads, 0 errors) · `readers=0, 40 s: 3.5/4.0/4.7/4.7/5.0`. It stops growing: flat for the second half of both runs. The level it settles at is noted under "Worth doing later". **SIGKILL** (`scratch/kill.ts`, three clients creating cases and two sending 3,000 to 18,000-result reports, killed after a random 0.3 to 2.5 s, restarted, every acknowledged write read back): `readers=4`, 8 kills: `total missing 0` of 152 cases and 35 reports; `readers=8`, 6 kills: `total missing 0` of 144 cases and 37 reports; both files afterwards `integrity ok; fk violations 0; batches processed 43; results rows per processed batch equal to its count: mismatched 0`. 43 batches against 35 and 37 acknowledged means the kills did land on reports in flight, and the restart finished them. **Thread absent** (`scratch/nockpt.ts`, the checkpoint thread terminated mid-run): `without: 35 s, reports 151, reads 2984, errors 0; WAL max 98.7 MB`, then a write `200`, a read `200`, clean stop. |
| 12 | Configuration | **pass** | `scratch/config.ts`. The rule: `cores -> readers: 1->1 2->1 3->1 4->2 6->4 8->6 10->8 16->8 64->8`, as documented. Real server, threads counted by name in `/proc`: unset (16 cores) `casebook-reader: 8, casebook-checkp: 1`; `0`: neither; `1`: 1 + 1; `8`: 8 + 1; `3`: 3 + 1; each answered 2,400 reads correctly. `abc`, `-1`, `1.5`, empty, `" 4"`, `0x4`, `1e1`, `9999999999999999999`: `did not start, exit 4: invalid: CASEBOOK_READERS must be a non-negative integer`. **Compiled binary:** `bun run build` produced `dist/casebook` (94,980,064 bytes); `dist/casebook serve` shows the same thread counts for unset, 0, 1, 8 and 3, and the same refusals. That the binary's threads do the reading (`scratch/bincpu.ts`, readers=3, 2,880 reads): `CPU ticks used during the burst: main=261 casebook-reader=869 casebook-reader=867 casebook-reader=864 casebook-checkp=1`. |

## Findings

### Defects

#### F1 (BLOCKS): after `actor.forget`, reads answered on the main thread still show the forgotten person's name

`forgetActor` (`src/server/identity/identity.ts:229`) clears the display-name cache of the writing connection only
(`labels.get(app.db)`). Reads resolve names with `actorLabel(ctx.db, …)` where `ctx.db` is `app.reader`, a different
connection on every file-backed instance, and that cache is never cleared. Reader threads are restarted by `refresh()`
after an instance write, so they answer correctly; the main thread keeps the name until the process restarts.

Real server (`scratch/forget.ts`): create a token for `jane.doe`, let her propose a case, read `get C-1`,
`timeline C-1`, `get P-1`, then `admin actor.forget jane.doe`, and read again six times:

    readers=0: before forget name shown=true; forget -> {"forgotten":"forgotten-3","tokensRevoked":1}; reads after: NAME-STILL-SHOWN x6
    readers=4: before forget name shown=true; forget -> {"forgotten":"forgotten-3","tokensRevoked":1}; reads after: pseudonym x6

Smallest reproduction, the authors' own forget test with the pool taken out of the way: `scratch/repro/f1.test.ts`
(`bun test ./f1.test.ts`). Both cases fail at this revision:

    (fail) after actor.forget, a read answered on the main thread no longer shows the name (readers=0)
      Received: …"by":"case-author","kind":"human"…          <- over HTTP
    (fail) after actor.forget, a read answered on the main thread no longer shows the name (readers=2)
      Received: …"by":"case-author","kind":"human"…          <- the inline call the pool falls back to

What it contradicts: the Part B fact that a reader thread's reply is the one the main thread would give (here the
thread is right and the main thread is wrong); check 8, which names "a forgotten actor"; "never shows state older than
a write the same caller has already been told succeeded"; and the promise of `actor.forget` itself
(`docs/compliance.md`). Exposure, stated plainly: with the default configuration reads go to the threads and are
correct. The name is shown with `CASEBOOK_READERS=0` (a documented setting) on every read, and with readers on by
every inline fallback: a read replayed after a thread fails, and reads answered during shutdown. Only an actor whose
name the main thread had already read is affected. The in-memory tests cannot see it, because there
`app.reader === app.db`. The fix is small (clear both connections' caches, or key the cache by instance).

#### F2 (does not block): an export stops the server answering anyone for its whole duration

`/api/export` runs `exportArchive` to completion on the main thread before the first byte is sent
(`src/surfaces/archive.ts:123`). Every request waits, reads included, because reader threads are reached only through
the main thread. `scratch/size.ts`, `/healthz` polled every 5 ms during the transfer:

    results=50000  export 470 ms,  longest wait of another request 425 ms
    results=200000 export 1313 ms, longest wait of another request 1194 ms
    results=400000 export 2751 ms, longest wait of another request 2551 ms

The stall grows in proportion to the instance. `docs/deploy.md` gives the export as the backup to take "while the
server runs", and departure 6 of decision 0012 exists because a stall of 0.3 to 0.65 s was judged too long. The import
stalls in the same way (12.7 s at 200,000 results, 24.3 s at 400,000), but its target is an empty instance. Nothing is
wrong in the data: the snapshot is consistent. I found no issue tracking it (#60 is about reads under reports).

#### F3 (does not block): a report caught mid-application by an export is never applied by the instance that imports it, until that instance restarts

An export taken between a report's two transactions holds the batch as `accepted`, with its results staged. The
original finishes it a moment later. The importing server runs `recoverAccepted` only at start
(`src/server/start.ts:49`), not after `/api/import`. `scratch/accepted.ts`, a 40,000-result report:

    original, gate of the commit:                       blocked (blocked: 40 failures unexplained, 1 question open)
    imported, still running, gate right after import:   pending (pending: 1 report accepted and not yet applied)
    imported, still running, gate 4 s later:            pending (pending: 1 report accepted and not yet applied)
    imported, still running, after a later report:      pending (pending: 1 report accepted and not yet applied)
    imported, after a restart, gate:                    blocked (blocked: 40 failures unexplained, 1 question open)

It contradicts "continues correctly": results the original acknowledged, and their questions, are absent from the
restored instance for as long as it keeps running, and nothing tells the operator. It is not rare under load: 7 of my 8
exports in check 6 were in this state. Why it does not block: the gate says `pending`, which is true; a restart
repairs it with the original's outcome; and in `server` mode the operator has to restart anyway, because the import
removes every token (confirmed in `scratch/servermode.ts`: the importing token gets `401` straight after the import,
and after a restart with `CASEBOOK_OWNER_TOKEN` set, `200` and `210/210 reads equal to the original`). It is reached
in `local` mode, where no restart is asked for. Fix: run the recovery inside the import's turn at the gate.

#### F4 (does not block): a graceful stop resets every request in flight, and with reader threads then spends seconds computing replies nobody receives

`scratch/shutdown.ts`, a real server on a 400,000-result database, SIGTERM while 64 reads are in flight:

    readers=4: SIGTERM after 5 / 20 / 35 ms -> exit 0 in 3254 / 3334 / 3226 ms; replies: {"error:ECONNRESET":64} each time
    readers=0: SIGTERM after 5 / 20 / 35 ms -> exit 0 in 73 / 46 / 29 ms;       replies: {"ok":1,"error:ECONNRESET":63} each time
    a 30,000-result report in flight at SIGTERM -> the client got ECONNRESET; after a restart its gate: passed, 30000 results proven

`stop()` calls `server.stop(true)` first (`src/server/start.ts:75`), which closes every connection, and only then
`readers.stop()`, which answers each pending read inline on the main thread (64 x about 50 ms) for sockets that are
gone. So "shutdown waits for in-flight reads" does not hold for a client. Nothing is lost or corrupted; every restart
or deploy resets the reads in flight, and a write in flight is applied while its caller is told nothing, which is safe
to retry only when the caller sent a `cmd`. Stopping the listener without force, or after the pool has drained, would
fix both halves.

### The tests do not prove this

- **The archive tests work on rows, not on an instance.** `transfer.test.ts` fills tables with hand-written rows through
  SQL and compares tables. That proves what the names say at the level of rows (and the refusal tests are thorough),
  but no test builds an instance through the operations, compares reads after an import, or keeps using the import.
  The two that go through a server create one case and compare `find` (`src/surfaces/archive.test.ts:33`,
  `src/cli/main.test.ts:211`). `docs/deploy.md` says "A test does exactly this and compares every table": true for
  tables. My check 2 did the rest and it held.
- **"50,000 result rows are exported and imported, with timing"** runs in memory in one process: no file, no HTTP, no
  memory figure. It could not have seen F2.
- **"every registered read has the same reply as inline, including refusals"** uses one caller (the local owner), one
  project and 17 inputs. Its method is sound (it compares with `invoke` in the same process), the spread is small.
- **"forgetting an actor clears names cached by the readers before the next read"** proves exactly its name: the
  readers. Nothing reads on the main thread after a forget on a file-backed instance, which is where F1 is.
- **"stop resolves pending work inline, awaits thread exits, and is idempotent"** proves the pool's side. No test has a
  client waiting on a reply while the server stops (F4).
- **No test imports a snapshot taken during a report** (F3), though the docs recommend exporting a running server.

### Worth doing later

- **The log settles at 81 to 137 MB with reader threads, against 5 MB without.** In check 11 the write-ahead log
  reached 80.8 MB within 12 s with the checkpoint thread running, and 98.7 MB without it: nearly the same. Under
  reads that overlap, what bounds the log is the writer's own 20,000-page limit (82 MB at 4,096-byte pages), which is
  the checkpoint-inside-a-commit the thread exists to avoid. The log was larger than the database in two runs
  (116.9 MB against 61.8 MB; 136.5 MB against 120.7 MB). Not a correctness fault, and performance is out of scope, so
  I only report the numbers.
- **The spool goes to the system temp directory** (`os.tmpdir()`, `src/surfaces/archive.ts:24`): the whole archive
  before the first byte of an export, and the whole upload before an import starts. Where `/tmp` is memory (as on this
  machine) that is memory equal to the archive. My size figures were taken with `TMPDIR` on disk.
- **A second server on the same directory is accepted silently.** It behaved in my runs, but nothing says so to the
  operator, and by reading `db.ts` a write on one waits up to 5 s inside SQLite, on the thread, for the other's lock.
- **`CASEBOOK_READERS` has no upper limit** when set by hand (by reading `readerCount`; I did not start 5,000 threads).
- **A reader thread that cannot start is retried every 100 ms for ever, with a log line each time** (by reading
  `readers.ts`; not run).
- **Some refusals answer with a raw validation dump** (a nested object or a boolean as a value, an extra header key,
  an upper-case digest). They are refused correctly and name the line; the message is hard to read.

## Not checked

- **Power loss.** `synchronous = NORMAL` was tested against killed processes only (14 SIGKILLs), not against a machine
  losing power.
- **Archives across schema versions.** There is one migration, so "older" and "newer" were tested as refusals only.
- **Safety of a second server in general.** The moment I most wanted, a second server starting while the first is
  between a report's two transactions, was attempted 8 times with no fault; I cannot show the window was hit.
- **Long runs.** Nothing ran longer than 150 s: no soak of thread failures, no log behaviour over hours.
- **Performance** (out of scope, #60), the Docker image, Coolify, and any platform but Linux x64.
- **The CLI commands** (out of scope) including the gzip path; I drove the archive through the HTTP routes.
- **Bodies near the 8 GiB limit**; the largest archive was 267 MB.
- **A checkpoint thread that throws.** I terminated it; I did not make it fail on its own.
- **Stored text that is not valid UTF-8** (the export's documented refusal): the authors' test only, not rerun by me.
- **NUL characters** are outside the brief; one value (`a\0b`) did round-trip (`hex 610062` on both sides).
- **Every test body.** For check 1 I read fixtures, helpers and a sample; I did not audit all 75 tests line by line.
- Nothing out of scope failed to compile or failed a test in the commands I ran.

ISSUES (1 blocker)
