# 0010: The stack: TypeScript on Bun, one SQLite file, React

- Date: 2026-10-12
- Status: proposed (Daniel reviews). Supersedes [0001](0001-stack-open.md); amends [0002](0002-layered-self-hosting.md).

Decision 0001 left the stack open and said it must be chosen on measurements. Daniel's answer on language
(decision 0009, answer 6): he knows TypeScript best, Python well and Go a little, "but if another language is
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

p95 in milliseconds through HTTP on loopback; W5 is the time for one report. These are the candidates' own
final runs, taken while other work shared the machine, so read them as "inside the budget by how much", not as a
ranking. The judge's serial re-runs are in the next section.

| Workload | Budget | ts SQLite | ts Postgres | go SQLite | go Postgres | rust SQLite | rust Postgres |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| W1 read one case | 20 | 1.1 | 0.4 | 0.3 | 0.2 | 2.8 | 0.4 |
| W2 folder page with proof strips | 50 | 4.2 | 9.0 | 3.7 | 7.5 | 6.5 | 8.5 |
| W3 full-text search | 100 | 43.8 | 54.4 | 42.0 | 31.1 | 55.9 | 52.9 |
| W4 save one case (one transaction) | 50 | 16.9 | 19.9 | 12.6 | 18.9 | 7.0 | 9.6 |
| W5 ingest 10,000 results | 2,000 | 389 | 224 | 536 | 287 | 442 | 381 |
| W5a parse a 10,000-test JUnit file | none | 46.5 | 44.4 | 26.8 | 27.3 | 7.1 | 6.7 |
| W6 last 20 results of a test | 20 | 0.4 | 0.3 | 0.3 | 0.3 | 0.5 | 0.5 |
| W7 gate read | 20 | 0.3 | 0.2 | 0.1 | 0.2 | 0.2 | 0.3 |
| W8 queue page at 50,000 open | 50 | 5.1 | 9.2 | 2.5 | 6.9 | 3.5 | 8.2 |
| W9 reads during ingest and saves | 50 | 18.2 | 28.7 | 7.9 | 15.3 | 11.3 | 19.2 |

Zero errors on every workload for all three.

**Every stack meets every budget in both store modes, by 2 to 100 times.** The database does the work; the
language around it barely shows. Go is about twice as quick as TypeScript on reads under mixed load, and Rust
parses XML six times faster, but each of those is already far inside its budget. On the budgets, no language
is decidedly better.

### The judge's re-runs and verdict

JUDGE_SECTION

## Decision

1. **TypeScript 7 on Bun 1.4**, for the server, the CLI and the web UI.
2. **One SQLite file** (`bun:sqlite`, WAL) is the store for the Local and Server layers. PostgreSQL is added
   when one organisation needs several instances (the Cloud layer), not before.
3. **React 19**, bundled by Bun, for the web UI (decision 0011).
4. **Zod 4** schemas are the single declaration of every operation's input; TypeScript types, the OpenAPI
   document, the MCP tool schemas and the CLI flags are derived from them.
5. **The official MCP TypeScript SDK**, MCP_SDK_LINE.
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
- **Daniel reads and writes it**, and agents have the most worked examples to copy correctly.

**Why not Go.** The best operations story of the three: a 17 MB static binary, the quickest under mixed load,
the simplest concurrency. It loses on the first two points above, and on exhaustiveness.

**Why not Rust.** The strongest type system for these invariants and the fastest pure logic. A clean build
takes about 70 seconds and an incremental one about 10; sharing logic with the browser means a WebAssembly
toolchain; and Daniel does not use it. Its advantages are real and none of them is needed to meet a budget.

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
adopt Casebook yet. Both are accepted.

**PostgreSQL is built when one of these is true** (#57): one organisation needs more than one instance
(availability, or more read throughput than one process gives); an adopter that matters requires it; or the
database file outgrows what a single volume and its backup handle comfortably.

A hosted tier does not by itself need it: an instance per organisation (one container, one volume, one file)
isolates tenants completely and is the cheapest thing to operate. That is a decision for #31.

**PGlite** (PostgreSQL in WebAssembly, in process) was tried as a way to have one SQL dialect everywhere. It
ran, on a tenth of the dataset, but reports `fsync=off` and refused to turn it on. Rejected: a store whose
durability cannot be shown does not carry a record that is supposed to be true.

### One process, one writer, readers never wait

The engine is one process with two connections to the file: one writes, one reads (it sees only what is
committed). A write waits its turn at a gate instead of blocking the thread. A large report is accepted in one
short transaction, then applied in slices of 500 results; between slices the server answers reads. Before this
was built, a 10,000-result report held the thread for 0.3 to 0.65 seconds.

The TypeScript candidate went further and used worker threads (one writer, four readers). Not adopted: it is
a second way for code to run, and the slices already keep a read from waiting longer than one slice. If read
CPU ever becomes the limit, reader workers are the next step and the operation layer does not change (#60).

## Risks, and what would expose each early

- **Bun is younger than Node.** The way back is small (see above). The check runs the whole suite on every
  change, so a Bun regression shows as a failing test, not as a surprise in production.
- **A long synchronous operation blocks reads.** Reports are sliced; a bulk edit of thousands of cases is not
  yet (about 0.2 s per thousand). The benchmark's mixed-load workload is the test (#60).
- **The single writer is a ceiling.** The benchmark measures write throughput; the trigger for PostgreSQL is
  written above.
- **The lead started building on this stack before the judge's verdict**, on the candidates' interim numbers,
  to use the waiting time. Had the verdict gone against TypeScript, the engine would have been rewritten. Read
  the verdict knowing that.

## What this adds to the repository

`package.json`, `bun.lock`, `tsconfig.json`, `biome.json`; `t3.json` with install, check, dev and
release-worktree scripts; the stack rules in `AGENTS.md`; the check command `bun run check`.
