# The check and the tests

`bun run check` is the gate on your machine. It type-checks, lints and runs the functional tests,
including browser tests.
CI runs those tests in shards and elapsed-time budgets on a dedicated runner. This page explains what
the check does, how the tests are arranged and what keeps them from interfering with each other.

## Run the tests

| Command | What it runs |
| --- | --- |
| `bun test <file>` | one file. `bunfig.toml` preloads `test/preflight.ts`, which checks Bun and the packages first. |
| `bun run test` | functional tests, with output as it comes. No type-check and no lint. |
| `bun run check` | the type-check, the lint and functional tests, side by side |
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
3. The type-check, the lint and the tests start side by side.
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
| `test/architecture.test.ts` | the module map, the registry, the witness writers, migrations, the identity rules, the phone layout and what a public repository may contain |
| `test/integrity.test.ts` | one test for each thing that must never happen, such as a green gate with nothing proven or an agent's result counted as a pipeline's. Each came from an independent review. |
| `test/budgets.test.ts` | operation counts on hot paths, reported as budgets |
| `PERFORMANCE` in `scripts/check-plan.ts` | elapsed-time budgets for the paths people wait on |
| `test/docs.test.ts` | the guide against the code: the generated tables, links, the operation table in `docs/architecture.md`, the diagrams and the docs site |
| `test/ios-contract.test.ts`, `test/licences.test.ts`, `test/demo-time.test.ts`, `test/work.test.ts` | the iPhone contract, the licence notices, the server's clock, and `scripts/work.ts` |
| `test/e2e/` | journeys in a real Chromium against a real server |

## Keep tests independent

Tests run beside each other. A test that fails only next to others shares something with them. Fix the sharing.
Only elapsed-time measurements belong in `PERFORMANCE`. Keep deterministic correctness and operation-count
checks in the functional suite. Shared benchmark workloads run their real operation and correctness check once
in functional tests. Warmups and repeated samples belong to performance tests.

- For an in-memory instance, use `harness` in `test/helpers.ts`. It calls the real registry and has an
  adjustable clock, project and actor helpers, and `ciReport` fixtures.
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
