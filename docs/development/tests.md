# The check and the tests

`bun run check` is the gate on your machine. It type-checks, lints and runs every test, including the latency
budgets and the browser tests, in about two minutes. CI runs the same tests in shards. This page explains what
the check does, how the tests are arranged and what keeps them from interfering with each other.

## Run the tests

| Command | What it runs |
| --- | --- |
| `bun test <file>` | one file. `bunfig.toml` preloads `test/preflight.ts`, which checks Bun and the packages first. |
| `bun run test` | every test file, with output as it comes. No type-check and no lint. |
| `bun run check` | the type-check, the lint and every test, side by side |
| `bun scripts/check.ts test --only=parallel <file>...` | the named files of one phase, as CI runs the files a change needs |

One agent at a time runs the whole suite on a machine. If another run is in progress, the check says so. To wait
for it, run `bun scripts/work.ts wait-tests`.

## What the check does

The check runs these steps:

1. `scripts/preflight.ts` checks Bun and the packages.
2. If browser tests will run, the check compiles `test/e2e/serve.ts` once.
3. The type-check, the lint and the tests start side by side.
4. The tests run in two phases: the parallel phase, then the quiet phase.
5. The check prints a summary.

- The parallel phase runs test files in workers, half the CPU threads by default. Each file gets its own globals
  and modules. `scripts/test-timings.json` gives each file a weight, so the slowest files start first.
- The quiet phase runs after it with one or two workers. It holds only the tests in `QUIET`
  (`scripts/check-plan.ts`): tests that compare a time with a limit, which a busy machine would fail.
- When a selected phase includes browser tests, the check compiles `test/e2e/serve.ts` once into a private
  temporary directory and passes it to the tests as `MAINWORTHY_E2E_SERVER`. Each browser test still starts its
  own server process with its own data directory, port and token.
- The check starts one headless Chromium per worker slot and passes the endpoints in
  `MAINWORTHY_E2E_BROWSER_ENDPOINTS`. Each test still gets a fresh browser context, with its own cookies and
  storage. The few tests that need their own browser launch one.

At the end the check prints the wall time and exit of each part, the log of each part that failed, each failed
test with its file and reason, whether the browser tests ran, and the five slowest files. When the tests take more
than 130 seconds in total, the check warns. Elapsed time alone fails nothing (decision 0097). The product's latency budgets in
`test/budgets.test.ts` still fail when exceeded. A budget is a measured baseline, not a ceiling: only a hard limit,
a cost a user would feel measured on a representative workload and accepted by the owner, should fail, and the rest
should warn (AGENTS.md). Which of these stay hard is #906.

## Know the kinds of tests

| Where | What it checks |
| --- | --- |
| `src/**/*.test.ts` | pure functions beside their code: the outline grammar, diff, merge, signatures, durations |
| `test/<area>.test.ts` | an area through the real registry: suite, evidence, runs, policy, sessions, tokens, passkeys, trackers, archives |
| `test/sequences-*.test.ts` | long sequences of operations under each policy preset |
| `test/architecture.test.ts` | the module map, the registry, the witness writers, migrations, the identity rules, the phone layout and what a public repository may contain |
| `test/integrity.test.ts` | one test for each thing that must never happen, such as a green gate with nothing proven or an agent's result counted as a pipeline's. Each came from an independent review. |
| `test/budgets.test.ts` | the latency of the paths people wait on |
| `test/docs.test.ts` | the guide against the code: the generated tables, links, the operation table in `docs/architecture.md`, the diagrams and the docs site |
| `test/ios-contract.test.ts`, `test/licences.test.ts`, `test/demo-time.test.ts`, `test/work.test.ts` | the iPhone contract, the licence notices, the server's clock, and `scripts/work.ts` |
| `test/e2e/` | journeys in a real Chromium against a real server |

## Keep tests independent

Tests run beside each other. A test that fails only next to others shares something with them. Fix the sharing.
Do not move the test to `QUIET`, which is only for tests that compare a time with a limit.

- For an in-memory instance, use `harness` in `test/helpers.ts`. It calls the real registry and has an
  adjustable clock, project and actor helpers, and `ciReport` fixtures.
- For a real server, use `startServer` in `test/e2e/support.ts`. It reserves a port through a lock directory that
  every checkout shares, makes a fresh data directory and removes both when the test stops.
- For a browser, use the context `support.ts` hands out. It connects to the worker's shared Chromium.
- To move time in a browser test, use the fixture's `/test/clock` route instead of waiting.

A test that fails by chance is a defect. File an issue with the `flaky-test` label in milestone M1, and fix the
cause instead of retrying.

## Refresh the test timings

`scripts/test-timings.json` holds a weight per test file in milliseconds. Both the CI shard assignment and the
local worker order read it. After you add or split test files, refresh it and commit the result.

To take the weights from a passing CI run, use the GitHub CLI with access to the repository:

```
$ gh run list --workflow check.yml --branch main --status success
$ bun scripts/work.ts timings-from-ci <run-id>
```

The command downloads the run's JUnit artifacts and reads the newest attempt of each shard, quiet tests included.
It takes each file's outer suite duration, which includes setup. Then it rescales the CI milliseconds by the
median ratio of existing weight to CI time, so files the run did not cover stay on a comparable scale. Files
missing from the run keep their old weights. A failed report or an invalid duration leaves the file unchanged.
Prefer a run of all tests.

To measure locally instead, run `bun run test --update-timings`. It runs every file alone, which takes about six
minutes, and rewrites the file only after both phases pass. The weights are scheduling estimates. They do not
predict local elapsed time or CI shard time.

## Reference: flags of the test runner

`bun scripts/check.ts test` takes these flags. CI uses them to run one shard.

| Flag | Effect |
| --- | --- |
| `--only=parallel`, `--only=quiet` | runs one phase |
| `--shard=<i>/<n>` | runs share `i` of `n` of the parallel phase |
| `--workers=<n>` | runs that many workers in the parallel phase |
| `--junit=<path>` | writes a JUnit report |
| `--update-timings` | measures every file alone and rewrites `scripts/test-timings.json` |
| `<file>...` | runs only those files. Needs one phase and no shard. |

The browser is Playwright's headless shell, which `bun run browser` installs; `MAINWORTHY_CHROMIUM` names another. `MAINWORTHY_E2E_SERVER` names a compiled fixture for a standalone
`bun test test/e2e/<file>`, which otherwise starts the server from source.
