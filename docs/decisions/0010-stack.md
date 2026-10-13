# 0010: The stack: TypeScript on Bun, one SQLite file, React

- Date: 2026-10-12
- Status: proposed (the owner reviews). Supersedes [0001](0001-stack-open.md); amends [0002](0002-layered-self-hosting.md).

Decision 0001 left the stack open and said it must be chosen on measurements. The owner's answer on language
(decision 0009, answer 6): they know TypeScript best, Python well and Go a little, "but if another language is
decidedly better, we want to use the correct language rather than what I know".

## The arena

Three candidates each built the same spike from one specification, on one shared dataset (100,000 cases with
149,766 versions, 20,000 tests, 1,000,000 results, 50,000 open questions), in an embedded store mode (SQLite) and
a server store mode (PostgreSQL 18), behind a real HTTP listener, and proved the one-registry path (HTTP with
OpenAPI, MCP and CLI from one declaration of three operations). The specification, the schema, the seed script,
each candidate's source, report and raw results, and the judge's verdict are in
`docs/design-arena/2026-10-12-stack/`.

| Candidate | Stack | Built by |
| --- | --- | --- |
| ts | TypeScript 7 on Bun 1.4, `bun:sqlite`, `Bun.sql`, Zod 4, the official MCP SDK | GPT 6.1 Sol |
| go | Go, SQLite through cgo, pgx 5, the official MCP Go SDK | GPT 6.1 Sol |
| rust | Rust, axum, rusqlite, tokio-postgres, rmcp | GPT 6.1 Sol |

Each candidate had its own work checked by a reviewer from another provider (Claude Opus 5.5) before reporting.
The cross-judge was GPT 6 Astra, which re-ran every candidate itself, one at a time.

### What was measured

The cross-judge froze each candidate's source and ran it itself, five complete runs per candidate, alternating
Go, Rust, TypeScript, on a machine other work shared. Each cell is the **median of the five runs' p95, with the
lowest and highest run in brackets**, in milliseconds through HTTP on loopback. E is embedded SQLite, S is
PostgreSQL 18. W5 is the time for one report.

| Workload | Budget | TS E | TS S | Go E | Go S | Rust E | Rust S |
| --- | ---: | --- | --- | --- | --- | --- | --- |
| W1 read one case | 20 | 0.76 [0.64–1.28] | 0.59 [0.41–2.55] | 0.22 [0.19–0.25] | 0.22 [0.20–0.23] | 4.33 [2.58–4.40] | 0.27 [0.25–0.30] |
| W2 folder page with proof strips | 50 | 3.70 [3.27–9.75] | 8.04 [6.45–8.58] | 3.18 [2.50–3.35] | 6.65 [5.25–7.84] | 7.11 [5.18–8.78] | 8.27 [6.66–8.72] |
| W3 full-text search | 100 | 42.2 [29.8–51.2] | 61.6 [53.3–68.3] | 30.1 [26.5–39.8] | 29.5 [27.5–34.2] | 53.5 [49.9–57.4] | 51.1 [46.1–53.7] |
| W4 save one case (one transaction) | 50 | 16.1 [16.0–16.4] | 19.1 [18.6–22.1] | 14.9 [8.7–15.3] | 19.1 [16.3–19.8] | 15.6 [15.5–15.9] | 19.1 [18.5–23.8] |
| W5 ingest 10,000 results | 2,000 | 370 [332–487] | 234 [215–261] | 491 [388–650] | 300 [243–368] | 436 [391–474] | 357 [346–426] |
| W5 slowest single report | 2,000 | 934 | 618 | 859 | 557 | 513 | 480 |
| W5a parse a 10,000-test JUnit file | none | 38.7 | 48.5 | 30.5 | 25.3 | 6.2 | 4.8 |
| W6 last 20 results of a test | 20 | 0.43 | 0.32 | 0.33 | 0.32 | 0.41 | 0.45 |
| W7 gate read | 20 | 0.28 | 0.25 | 0.12 | 0.17 | 0.17 | 0.23 |
| W8 queue page at 50,000 open | 50 | 4.67 [4.39–5.95] | 9.60 [7.63–10.7] | 2.71 [2.47–3.27] | 7.57 [5.93–7.68] | 2.98 [2.59–3.90] | 7.67 [6.76–8.46] |
| W9 reads during ingest and saves | 50 | 17.8 [17.0–23.1] | 31.6 [29.3–32.3] | 6.2 [6.1–10.2] | 12.6 [12.1–16.1] | 10.4 [9.8–11.7] | 15.1 [14.7–17.4] |

"All 300 required budget checks across 15 runs pass; all measured, warmup and mixed-writer error counts are
zero" (the verdict). An earlier TypeScript run, taken while the other candidates were still building, came close
on two lines (PostgreSQL search p95 99 ms, mixed reads 40 ms); the judge traced the search to the ranking function
in the SQL (`ts_rank_cd` against `ts_rank`: 51 ms against 32 ms), not to the language.

**Every stack meets every budget in both store modes.** The database does the work; the language around it
barely shows. Go is about three times as quick as TypeScript on reads under mixed load, and Rust parses XML six
times faster, and each of those is already far inside its budget. The judge's own caution applies to every
difference in this table: the three candidates used different clients, pool sizes and ranking functions, so
"do not interpret small differences as intrinsic language speed". On the budgets, no language is decidedly better.

### The judge's verdict

**TypeScript on Bun, 26 of 30; Rust 23; Go 22.** The full text, with its evidence, is
[`verdict.md`](../design-arena/2026-10-12-stack/verdict.md).

| Criterion | TypeScript on Bun | Go | Rust |
| --- | ---: | ---: | ---: |
| Budgets, honestly measured | 4 | 4 | 4 |
| One operation layer for every surface | 5 | 5 | 5 |
| Logic shared with the browser | 5 | 2 | 3 |
| Agents write the code correctly | 3 | 3 | 4 |
| Deploy and operate | 4 | 5 | 4 |
| Decidedly better for Mainworthy | 5 | 3 | 3 |

In its words: "The decisive result is that backend budgets do not force a second language, while the specified
keyboard UI requires identical algorithms on both sides." It would change the choice for a repeatable
TypeScript-only budget failure, or for a Rust and WebAssembly editor slice that enforced the decision witness
and met the browser's latency budget.

What it asked of a TypeScript implementation, and where each stands in the code as built:

- **Every edit names the version it was made on.** Two of the three spikes accepted an edit with no base. In the
  product `base` is required by the schema of `propose`, and a test covers the stale and the missing case.
- **Negative checks for the things TypeScript's structural types let through** (a forged witness, an import that
  skips a layer, SQL in the wrong module). `test/architecture.test.ts` and `test/integrity.test.ts` do this, and
  the witness is a class with a private field that a plain object does not satisfy.
- **A worker failure soak.** Not done. The reader threads are covered by tests, not by a long run (#60).

### Where the lead and the judge disagree: PostgreSQL now or later

The judge recommends **both stores from the first usable version**: SQLite for Local and for a first
single-process Server, with a tested PostgreSQL adapter beside it, as decision 0002 required. It says it would
choose SQLite only "if Cloud proof is explicitly deferred beyond the first usable version and the dual-engine
contract/migration cost becomes material".

The lead built SQLite only, and that condition is the reason: the Cloud layer is deferred (decision 0009,
answer 2: self-hosted first, a hosted tier "if this product works well"), and the cost is material. Two search
dialects, two migration sets and an asynchronous transaction layer through every module, for a store nobody runs
yet, is a week that the first user does not benefit from. The judge's own measurement removes the performance
argument for it ("SQLite-only is sufficient for the measured single-process load"). What is lost is the proof,
before 1.0, that the design survives a second store. That is a real loss, it is the owner's call, and it is recorded
as #57 with the triggers below. If they prefer the judge's position, the change is mechanical and the arena's
TypeScript candidate is a working reference for it.

## Decision

1. **TypeScript 7 on Bun 1.4**, for the server, the CLI and the web UI.
2. **One SQLite file** (`bun:sqlite`, WAL) is the store for the Local and Server layers. PostgreSQL is added
   when one organisation needs several instances (the Cloud layer), not before.
3. **React 19**, bundled by Bun, for the web UI (decision 0011).
4. **Zod 4** schemas are the single declaration of every operation's input; TypeScript types, the OpenAPI
   document, the MCP tool schemas and the CLI flags are derived from them.
5. **The official MCP TypeScript SDK**, on its v1 line (1.32, protocol 2025-11-25), which is maintained but no
   longer the current one. Moving to v2 and the 2026-07-28 protocol is one file (#61).
6. **Biome** for format and lint, **`bun test`** for tests, **playwright-core** driving the system Chromium for
   browser tests.

### Why TypeScript, when all three pass

The deciding criterion is the third one in the judge's rubric, and it is structural, not a preference.

- **The editor and the server must run the same logic.** The product's first promise is that capture never
  waits: the browser splits a pasted list into steps, prints and parses canonical Markdown, diffs versions and
  merges concurrent edits on the keypress, and the server must reach the same result when it seals the edit.
  In TypeScript that is one module imported twice (`src/core`). The Go and Rust candidates both said what it
  costs them: compile the logic to WebAssembly and ship it to the browser, or write it twice and keep the two
  in step. Either is a second build and a place to drift, on the hottest path.
- **One declaration, no generator.** A Zod schema is the type, the validator, the JSON Schema for OpenAPI and
  MCP, and the source of the CLI flags, in the language the UI is written in. The web client is typed from the
  same file. Go and Rust need a code generation step between the server and the UI.
- **The design leans on sum types.** Question kinds with closed answer sets, edits, hold terms and verdicts are
  discriminated unions with exhaustive switches; a decision witness is a type only one module can construct.
  Rust expresses this best, TypeScript well, Go by convention only (the judge's notes say the same).
- **The owner reads and writes it**, and agents have the most worked examples to copy correctly.

**Why not Go.** The best operations story of the three: a 17 MB static binary, the quickest under mixed load,
the simplest concurrency. It loses on the first two points above, and on exhaustiveness.

**Why not Rust.** The strongest type system for these invariants and the fastest pure logic. A clean build
takes about 70 seconds and an incremental one about 10; sharing logic with the browser means a WebAssembly
toolchain; and the owner does not use it. Its advantages are real and none of them is needed to meet a budget.

**Why Bun and not Node.** One tool is the runtime, the package manager, the test runner, the bundler for the
web UI and the compiler of a single executable (94 MB, starts in about a quarter of a second); `bun:sqlite` is
built in. The candidate ran the same code under Node 26 with `node:sqlite` and met the budgets there too, so
this is a choice of convenience with a way back, not a lock-in: nothing outside `src/server/kernel/db.ts` and
the entry point touches a Bun-only API.

### Why SQLite only, for now

This amends decision 0002, which said the Server layer runs on a server database.

- **The first deployment is one person on one home server.** A container with one file on a volume needs no
  database container to run, upgrade and back up. That is the operations burden a self-hoster actually feels.
- **It is the fastest shape for the product's promise.** A hot read is a few microseconds in process: on the
  real engine, a gate read takes 0.01 ms, a folder page 0.6 ms, a save 2.4 ms (the lead's probe on this machine;
  the benchmark in `bench/` is the authority).
- **The domain code is synchronous.** One operation is one transaction with no connection pool and no
  interleaving to reason about. That simplicity is where a team of agents writing the code goes right.
- **The design already serialises writes per project** (one sequence per project, in commit order), so one
  writer per database is not a new ceiling.
- **PostgreSQL works, on the evidence, when it is needed.** The TypeScript candidate met every budget on it.

What it costs: the domain code will have to become asynchronous to add PostgreSQL (the compiler finds every
site; it is mechanical, and it touches most files), and a self-hoster who is required to use PostgreSQL cannot
adopt Mainworthy yet. Both are accepted.

**PostgreSQL is built when one of these is true** (#57): one organisation needs more than one instance
(availability, or more read throughput than one process gives); an adopter that matters requires it; or the
database file outgrows what a single volume and its backup handle comfortably.

A hosted tier does not by itself need it: an instance per organisation (one container, one volume, one file)
isolates tenants completely and is the cheapest thing to operate. That is a decision for #31.

**PGlite** (PostgreSQL in WebAssembly, in process) was tried as a way to have one SQL dialect everywhere. It
ran, on a tenth of the dataset, but reports `fsync=off` and refused to turn it on. Rejected: a store whose
durability cannot be shown does not carry a record that is supposed to be true.

### One process, one writer, readers on their own threads

The engine is one process. One connection writes; reads run on reader threads, each with its own read-only
connection that sees only what is committed. A write waits its turn at a gate instead of blocking the thread. A
large report is accepted in one short transaction, then applied in slices of 200 results. Before this was built,
a 10,000-result report held every read for 0.3 to 0.65 seconds.

## Risks, and what would expose each early

- **Bun is younger than Node.** The way back is small (see above). The check runs the whole suite on every
  change, so a Bun regression shows as a failing test, not as a surprise in production.
- **A save waits behind a report.** This is the judge's biggest risk, and it is real here: there is one writer
  per database, so a person's save queues behind a pipeline's 10,000-result report (the benchmark's mixed-load
  workload measures it). Typing does not wait, because the editor keeps the draft on the device and saves in the
  background, but the acknowledgement does. What to try next is in #60.
- **The single writer is a ceiling.** The benchmark measures write throughput; the trigger for PostgreSQL is
  written above.
- **The lead started building on this stack before the judge's verdict**, on the candidates' interim numbers,
  to use the waiting time. Had the verdict gone against TypeScript, the engine would have been rewritten. Read
  the verdict knowing that.

## What this adds to the repository

`package.json`, `bun.lock`, `tsconfig.json`, `biome.json`; `t3.json` with install, check, dev and
release-worktree scripts; the stack rules in `AGENTS.md`; the check command `bun run check`.
