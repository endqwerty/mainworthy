# The check and the tests

`bun run check` is the gate on your machine. It runs the type-check, lint, async-port guard and functional
tests, including browser tests.
CI runs those tests in shards and elapsed-time budgets on a dedicated runner. This page explains what
the check does, how the tests are arranged and what keeps them from interfering with each other.

Tests need PostgreSQL 18. The fixture starts one checkout cluster on demand and clones a database for each
harness or server. Set `MAINWORTHY_TEST_PG` to use an existing PostgreSQL admin URL instead, as CI does.
The checkout cluster is disposable and runs with `fsync`, `synchronous_commit` and `full_page_writes` off, like
CI's functional shards: every dropped database forces a checkpoint, and with `fsync` on that took seconds on a
busy machine (#984). CI's performance job alone measures on durable PostgreSQL. `bun run dev` uses the same
cluster, so its data is disposable too: a crash of the machine can lose or corrupt it, an acknowledged sign-out or
revoked token included. It therefore serves from the cluster only in local mode on loopback; server mode or another
host needs `MAINWORTHY_DATABASE_URL`. A cluster already running
when these settings changed takes them the next time a command attaches to it.
Install PostgreSQL binaries or set `MAINWORTHY_PG_BIN`; no in-memory SQLite fallback remains.

## Clean up checkout PostgreSQL

Each checkout cluster records its absolute checkout path and filesystem device in `~/.cache/mainworthy/pg/<id>.json`.
Starting a checkout cluster stops and deletes clusters whose recorded checkout no longer exists, provided its
nearest existing ancestor remains on the recorded filesystem. An unmounted checkout volume retains its cluster.
An existing checkout keeps its cluster, including a stopped cluster. `bun scripts/work.ts scratch rm <directory>`
also cleans up clusters for the deleted export and nested exports before returning.
`stop-server` stops the current checkout cluster; `release` stops and deletes it.

Cleanup skips existing owners without waiting on their startup locks. Before deleting anything it re-reads
ownership and checkout existence under the same per-cluster lock as startup, stops PostgreSQL, and removes
metadata last. A later startup retries an interrupted deletion. Automatic startup and scratch cleanup warn and
retain an entry they cannot safely clean, so a damaged orphan does not block another checkout. Explicit
`bun scripts/pg.ts cleanup` still fails on such an entry. Permission errors do not count as a missing checkout
or a stopped server. Before signaling a PID, cleanup checks that it is a PostgreSQL process running from that
cluster's data directory. A stale PID file cannot authorize stopping another process. An external `MAINWORTHY_TEST_PG` URL is never removed.

### Recover older clusters

Older metadata may lack a checkout path or filesystem device. Starting that checkout records both without replacing the cluster.
Other clusters with unknown owners remain untouched, even when stopped. A stopped server alone does not prove
that its checkout was deleted. This includes the stopped data directories from the shared-memory incident
in [issue #935](https://github.com/endqwerty/mainworthy/issues/935).

Run `bun scripts/pg.ts cleanup` to clean known abandoned clusters and list retained ids with unknown ownership or
an unavailable filesystem. An absent owner with no recorded device is retained unless its original path is supplied explicitly.
If you know an old cluster's original absolute checkout path, supply it:

```sh
bun scripts/pg.ts cleanup /absolute/path/to/deleted-checkout
```

Cleanup hashes that path to match the metadata id and any marked `mw-pg-<id>-*` scratch directories.
It removes them only while the checkout path is absent. This also recovers matching data directories that have
lost their metadata. If the recorded PostgreSQL binaries were deleted, cleanup uses installed or configured
PostgreSQL 18 binaries when it must stop a server. A stopped directory needs no executable.

Recover original checkout paths from retained review logs or worktree records. The hash cannot recover a path.
Without that evidence, retain the directory. Before supplying a legacy path without a recorded device, confirm its
volume is mounted: a missing mount is not a deleted checkout. Do not delete all stopped clusters or remove directories by pattern.

The real-process regression is `test/pg-cleanup.test.ts`, selected by `bun run performance`.
It runs in its own cache and starts PostgreSQL from exported checkouts.
The unavailable-volume case supplies a different recorded device and verifies SQL, metadata and data survive;
restoring the matching device lets the same abandoned cluster be removed. Metadata without a device is also retained.

## Run the tests

| Command | What it runs |
| --- | --- |
| `bun test <file>` | one file. `bunfig.toml` preloads `test/preflight.ts`, which checks Bun and the packages first. |
| `bun run test` | functional tests, with output as it comes. No type-check and no lint. |
| `bun run check` | the type-check, the lint, the async-port guard and functional tests, side by side |
| `bun run performance` | elapsed-time budgets, one file at a time. Run this alone on an idle machine. |
| `bun scripts/check.ts test --only=parallel <file>...` | the named files of one phase, as CI runs the files a change needs |

Several worktrees can run `bun run check` at once. Each run takes half the CPU threads that are free when it
starts (by the load average), at least two and at most half of all threads, so a check alone keeps its speed.
Use `bun run check --workers=<n>` or `bun run test --workers=<n>` to choose a cap for that run.
The performance job needs an idle machine because its elapsed times measure the product. CI gives it a
runner of its own. The iPhone simulator lane is separate and still uses one simulator.

## What the check does

The check runs these steps:

1. `scripts/preflight.ts` checks Bun and the packages.
2. If browser tests will run, the check compiles `test/e2e/serve.ts` once.
3. The type-check, the lint, `bun scripts/async-port.ts --check` and the tests start side by side.
4. Functional test files run in parallel workers.
5. The check prints a summary.

- The functional phase runs test files in workers: half the free CPU threads, at least two (one on a two-thread
  machine) and at most half of all threads (`parallelWorkers` in `scripts/check-plan.ts`). Each file gets its own globals and modules. `scripts/test-timings.json` gives each file a
  weight, so the slowest files start first.
- `bun run performance` selects the separate `PERFORMANCE` files in `scripts/check-plan.ts`.
  It runs with one worker and preserves the product thresholds. It is outside the default check.
- When a selected phase includes browser tests, the check compiles `test/e2e/serve.ts` once into a private
  temporary directory and passes it to the tests as `MAINWORTHY_E2E_SERVER`. Each browser test still starts its
  own server process with its own data directory, port and token.
- The check starts one headless Chromium per worker slot and passes the endpoints in
  `MAINWORTHY_E2E_BROWSER_ENDPOINTS`. Each test still gets a fresh browser context, with its own cookies and
  storage. The few tests that need their own browser launch one.

At the end the check prints the wall time and exit of each part, the log of each part that failed, each failed
test with its file and reason, whether the browser tests ran, and the five slowest files. When the tests take more
than 130 seconds in total, the check warns. Budget misses (elapsed time, bytes, tokens or operation counts) warn
with the measured number and baseline in the local end summary and CI job summary, and change no exit code or gate
verdict. A measurement above ten times its baseline fails (below). Workload errors and crashes still fail. The
operation-count budgets in `test/budgets.test.ts` run in the functional check.

## Know the kinds of tests

| Where | What it checks |
| --- | --- |
| `src/**/*.test.ts` | pure functions beside their code: the outline grammar, diff, merge, signatures, durations |
| `test/<area>.test.ts` | an area through the real registry: suite, evidence, runs, policy, sessions, tokens, passkeys, trackers, archives |
| `test/sequences-*.test.ts` | long sequences of operations under each policy preset |
| `test/architecture.test.ts` | the module map, the registry, the witness writers, the PostgreSQL baseline, the identity rules, the phone layout and what a public repository may contain |
| `test/integrity.test.ts` | one test for each thing that must never happen, such as a green gate with nothing proven or an agent's result counted as a pipeline's. Each came from an independent review. |
| `test/budgets.test.ts` | operation counts on hot paths, reported as budgets |
| `PERFORMANCE` in `scripts/check-plan.ts` | elapsed-time budgets for the paths people wait on |
| `test/docs.test.ts` | the guide against the code: the generated tables, links, the operation table in `docs/architecture.md`, the diagrams and the docs site |
| `test/ios-contract.test.ts`, `test/licences.test.ts`, `test/demo-time.test.ts`, `test/work.test.ts` | the iPhone contract, the licence notices, the server's clock, and `scripts/work.ts` |
| `test/e2e/` | journeys in a real Chromium against a real server |

### Put a test at the cheapest layer that reaches it

A reachable finding or a behaviour change gets the cheapest test that would catch it again (the owner, 2026-10-27,
on [#1010](https://github.com/endqwerty/mainworthy/issues/1010): "4 is critical"). On 2026-10-27, unit tests were 32
of 231 files and 0.2% of the test time; browser tests were 39% of it and most of the `flaky-test` issues.

- **Pure logic** (a rule, a parser, a merge, a verdict): a unit test beside the code in `src/`, with no database.
- **What needs SQL, a transaction, the registry or a policy**: a test in `test/<area>.test.ts`.
- **What needs a server or the command line** (a route, a header, a process): a server test, starting the command once.
- **What only a browser shows**: focus, keys, rendering, several windows, the content security policy, the order a
  page receives replies in. A browser test checks the journey once; the conditions behind it go a layer down.

Extend an existing test before adding a file. A pull request that adds a browser test says why on a line of its
description starting `Browser tests:`; the `description` job (`bun scripts/work.ts pr-body`) asks for that line and
names each test it found.

## Keep tests independent

Tests run beside each other. A test that fails only next to others shares something with them. Fix the sharing.
Elapsed-time measurements and database process cleanup checks belong in `PERFORMANCE`. Keep other
deterministic correctness and operation-count checks in the functional suite. Shared benchmark workloads run
their real operation and correctness check once in functional tests. Warmups and repeated samples belong to performance tests.

- For an isolated PostgreSQL-backed app, use `harness` in `test/helpers.ts`. It calls the real registry and has
  in-memory blobs, an adjustable clock, project and actor helpers, and `ciReport` fixtures.
- For a real server, use `startServer` in `test/e2e/support.ts`. Its server binds port 0 and reports the URL the OS assigned.
  Each server has a fresh data directory, removed by its supervisor after the process exits.
- For a browser, use the context `support.ts` hands out. It connects to the worker's shared Chromium.
- To move time in a browser test, use the fixture's `/test/clock` route instead of waiting.

A test that fails by chance is a defect. File an issue with the `flaky-test` label in milestone M1, and fix the
cause instead of retrying.

## Report a budget

A budget is a baseline, not a limit (the owner, 2026-10-24: "None of them should be hard limits. The end result of
user experience, user features, and developer experience are all that matters. Numbers are always allowed to be
broken if the end user gains something from it"). A pull request that breaks one says what the user gains.

Any test file can import `budget` from `scripts/budget.ts` and call
`budget(name, measured, limit, unit)`. Units can be milliseconds, bytes, tokens or another measured quantity.
A value above the baseline records a warning. A value above ten times the baseline (`FAIL_MULTIPLE`; a baseline of
0 counts as 1) fails, so the jump is reviewed. The owner, 2026-10-24: "10x is definitely a big enough jump that it's
fair to mark a test as failed if it suddenly exceeds that and for it to be flagged for review. Only intentionally
meaning to do that should be allowed." To mean to, change the baseline in the same pull request and say why.
Invalid measurements and workload errors still fail.

The check collects warnings from every phase into its end summary and appends them to `GITHUB_STEP_SUMMARY`
in CI. Each run has its own report directory, and each process writes its own file. A standalone `bun test`
prints the warning immediately. Keep correctness assertions separate from baseline comparisons.

## Refresh the test timings

`scripts/test-timings.json` holds a weight per test file in milliseconds. Both the CI shard assignment and the
local worker order read it. After you add or split test files, refresh it and commit the result.

To take the weights from a passing CI run, use the GitHub CLI with access to the repository:

```
$ gh run list --workflow check.yml --branch main --status success
$ bun scripts/work.ts timings-from-ci <run-id>
```

The command downloads the run's JUnit artifacts and reads the newest attempt of each shard, performance tests included.
It takes each file's outer suite duration, which includes setup. Then it rescales the CI milliseconds by the
median ratio of existing weight to CI time, so files the run did not cover stay on a comparable scale. Files
missing from the run keep their old weights. A failed report or an invalid duration leaves the file unchanged.
Prefer a run of all tests.

To measure locally instead, run `bun run test --update-timings`. It runs every file alone, covers both
phases, and rewrites the file only after both pass. Run this recording alone because it includes elapsed-time
budgets. The weights are scheduling estimates. They do not predict local elapsed time or CI shard time.

## Reference: flags of the test runner

`bun scripts/check.ts test` takes these flags. CI uses them to run one shard.

| Flag | Effect |
| --- | --- |
| `--only=parallel`, `--only=performance` | runs one phase |
| `--shard=<i>/<n>` | runs share `i` of `n` of the parallel phase |
| `--workers=<n>` | caps functional workers for this run. Performance always uses one. |
| `--junit=<path>` | writes a JUnit report |
| `--update-timings` | measures both phases, every file alone, and rewrites `scripts/test-timings.json` |
| `<file>...` | runs only those files. Needs one phase and no shard. |

The browser is Playwright's headless shell, which `bun run browser` installs; `MAINWORTHY_CHROMIUM` names another. `MAINWORTHY_E2E_SERVER` names a compiled fixture for a standalone
`bun test test/e2e/<file>`, which otherwise starts the server from source.
