# 0082: Read between bulk proposal slices without publishing partial changes

2026-10-15. Part of [issue #60](https://github.com/endqwerty/mainworthy/issues/60), item 5.
This preserves [decision 0008](0008-one-evidence-model.md) and the single writer in
[decision 0010](0010-stack.md). Local implementation checks are recorded below. Independent review is pending.

## Problem

Reports already yield between slices of 200 results. Bulk proposals and their adoption instead run synchronous
loops over every case. Reader workers can query committed state, but the main thread cannot dispatch a new
request or deliver their replies until those loops finish. An inline reader cannot run at all during that work.

A bulk proposal remains one proposal, one question, and one decision. Neither readers nor a server restart may
expose part of its adoption. Making each slice a separate committed edit would break that promise.

## Decision

Keep the proposal and its adoption in one SQLite write transaction. Yield to the event loop after at most 200
case visits when resolving case edits, validating custom fields, collecting per-case policy scope facts, or
applying creates, content edits, placements, restores, and state changes. A single move or state edit can name many cases, so its inner case loop yields too. The operation
registry already drives generators while retaining a transaction when they yield without `COMMIT`.

`proposeSteps` seals through `sealSteps`, then raises the ordinary adoption question through `raiseSteps`.
Automatic and explicit acceptance share the same decision settlement and `adoptSteps`. Each standing writer
still receives the decision's witness. Synchronous callers drain those same generators with `complete`.
There is one implementation of each domain operation.

Decision effects now return generators. A generator savepoint holds the same SQL savepoint across its yields.
If an acceptance fails after earlier slices wrote cases, the savepoint rolls those cases and the decision back.
Other answers in a batched `decide` can then run. A generator closed before completion rolls its savepoint back
as well. The synchronous savepoint uses the same implementation.

Disk readers use separate read-only connections and snapshots. Before commit, they see the old case heads,
versions, placements, search index, proposal, and question state. Commit publishes every change together,
including the decision effects, sequence, and command reply. One change notification follows. A process killed
between slices leaves an uncommitted transaction, which SQLite rolls back when the database reopens. The same
command can be retried unchanged and applies once. A reply lost after commit is replayed from the command row.

This does not add a pending state, migration, archive format, operation, or second way to mint a witness.
Parsing, schema validation, hashing, JSON serialization, folder-tree expansion, the final commit, and unusually
large individual case bodies still run synchronously. Slices bound case-loop work, not every possible main-thread pause.

## Alternatives and save acknowledgement

Staging committed case versions and publishing a generation pointer could let short writes commit between
slices. Every case reader, search query, alias lookup, folder and policy effect, and history/export path would
then need a definition of visibility. Intervening saves would require conflict revalidation before publication.
Restart recovery would need to discard or resume stages without exposing them. Moving staged rows into the
current tables in one final loop would recreate the long unsliced pause.

That larger change is deferred. This change retains the write gate for the whole transaction. A short save
still waits behind bulk adoption or report application. Releasing the gate while this transaction is open would
let the next write join it and could acknowledge a save that later rolls back. Item 1 of issue #60 therefore
remains open. Items 2 and 3 are measured by the existing read mix. Item 4, the long worker-failure soak, is unchanged.

## Checks

`test/suite.test.ts` exercises the registry against a disk database with an inline reader:

- Sealing a review-required bulk proposal answers reads before publishing it.
- Automatic bulk creation and explicit acceptance answer reads during partial adoption. Those reads see no
  partial cases, search matches, proposal, or decided question. Publication happens once, and a retry is unchanged.
- Bulk content edits, moves with tags, and archiving retain the complete old state between slices.
- An alias collision at the end of adoption rolls every earlier slice back. The question remains open and
  another answer in the same batch succeeds.
- Separate processes are killed with `SIGKILL` after a real partial adoption, for both `propose` and `decide`.
  Reopening finds no partial cases, versions, placements, search rows, decision, or command acknowledgement.
  Retrying and replaying the command creates exactly the intended versions and one adoption decision.

The first two adoption regressions failed before the production change with `Expected: true; Received: false`:
no read ran while adoption was partially applied. The nine atomic bulk checks now pass.

## Mixed-load measurement

The speed comparison is **inconclusive**. Read p95 is lower in each observed head run, but the base's
run-to-run spread is larger than the median gap. These shared-machine runs do not establish a stable speedup.
No head run meets the 50 ms read target under this bulk workload. Save acknowledgement still waits for the
active transaction, and its p95 ranges overlap.

Machine and conditions: Apple M4, 10 logical cores, 16 GiB RAM, macOS 27.2, Bun 1.4.3, APFS on an external SSD.
The machine also ran other work. One-minute load ranged from 11.0 to 26.9 across the recorded window boundaries.
The separate load-generator process used at most 13.7% of one core averaged over a complete run, including
warmup and verification. This is not a client CPU throughput ceiling. An excluded diagnostic native sample
of the server's main thread contains SQLite execution and FTS index-write stacks, matching the per-case SQL
in `adoptSteps` and `indexCase`. Yielding frees the main thread between those calls. It neither removes that
work nor releases SQLite's writer.

The closed baseline has 100,000 cases, 160,428 versions, 20,000 tests, 1,050,120 results, and 50,000 open questions.
Every window starts from a fresh database copy. Both code revisions use the identical revised `bench/external.ts`,
production server mode, eight reader workers plus the checkpoint thread, and an independent HTTP client process.
The baseline code is `8d7700535f45004cf28e16a808f76eae244606ab`; the head is this change on that base.

Sixteen clients cycle through case, folder, history, gate, queue, and search reads. One writer repeatedly
creates 2,000 cases, proposes edits to them as an agent, and accepts that proposal as a person. A second writer
saves C-7, then waits 200 ms after each acknowledgement. Its initial base-version read precedes the load window.
Each window has a two-second warmup, five seconds of readers alone, and twenty seconds of mixed load. Requests
and bulk cycles begun before the deadline finish afterward. Response timers start after request serialization
and include reply decoding. After the window, every bulk case's committed title and version, each folder's
case count, and the short save's final version are checked over HTTP.

Runs alternate base, head, five times. Values below are milliseconds. The summary is the median of the five
per-window quantiles, followed by their minimum and maximum.

| Measurement | Base median, range | Head median, range |
| --- | ---: | ---: |
| Read p95 | 1,282.8, 668.5 to 3,296.0 | 128.8, 106.5 to 300.1 |
| Save acknowledgement p50 | 900.8, 506.8 to 1,827.0 | 354.3, 309.1 to 382.0 |
| Save acknowledgement p95 | 1,233.4, 717.8 to 4,210.7 | 1,094.2, 408.1 to 1,719.2 |

| Pair | Base read p95 | Head read p95 | Base save p50 / p95 | Head save p50 / p95 | Save samples, base / head |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 671.7 | 106.5 | 506.8 / 783.5 | 347.7 / 553.4 | 28 / 46 |
| 2 | 668.5 | 128.8 | 523.7 / 717.8 | 382.0 / 1,719.2 | 27 / 38 |
| 3 | 1,324.8 | 300.1 | 1,146.1 / 1,622.1 | 309.1 / 1,616.7 | 17 / 25 |
| 4 | 3,296.0 | 229.0 | 1,827.0 / 4,210.7 | 362.3 / 1,094.2 | 12 / 28 |
| 5 | 1,282.8 | 113.5 | 900.8 / 1,233.4 | 354.3 / 408.1 | 22 / 47 |

All ten runs completed with zero errors. They collected 5,060 base reads and 35,394 head reads, 106 base save
acknowledgements and 184 head acknowledgements. They created and verified 184,000 base bulk cases and 182,000
head bulk cases, each with its accepted version 2. The number of finished bulk cycles differs because this is
a fixed-duration workload, not a fixed count of writes.

Search p95, measured without a query change, has a base median of 1,298.8 ms, range 714.0 to 3,295.8,
and a head median of 133.9 ms, range 107.2 to 311.2. The slowest individual reads are 4,402.9 ms on base and
1,154.6 ms on head. These observations do not explain the startup outliers in item 3.

An earlier 5,000-case pilot produced no base save samples because its initial version read consumed the busy
window. It is excluded. The revised client primes that read before timing and fails if a window has no save
acknowledgements. The native profiling run is also excluded.

Reproduce on both revisions with the same closed dataset and benchmark client:

```sh
bun bench/external.ts <dataset directory> 20 8 bulk 2000
```

Use five alternating pairs and retain every run. The result measures this workload on this shared machine,
not the server's idle latency, a comparison of reader configurations, or a long failure soak.

