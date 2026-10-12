# QA review of PR 80

Revision: `6d7d12ccdf2159e5387b59b92f15905734e337b9`, compared with `26b4183a36f29c5d572825786837b04249b13b98`.
Reviewer: Codex, GPT-6 Astra. No other agents started.

The review checkout is `/home/endqwerty/.cache/casebook-arena/verify/dx-r1/tree`, exported with `git archive`. Targeted fixtures, scratch and logs are under its parent. Shared checkout is read-only. Bun install succeeded with frozen lockfile, Bun 1.4.3.

Safety fact: every previously executed test still executes with its assertions intact, and failed or absent checks cannot produce a successful aggregate result.

Planned checks before any mutation: compare test calls and bodies across revisions; three full check runs; inject separate test/type/lint failures and exercise budgets; run browser/port/interception guards and remove each guard in the export; exercise CI gate omissions, failures and skipped results; run documented commands and static/architecture checks. Restore every probe mutation.

Timing qualification: another agent is running selected browser files on the same machine. These runs can test repeatability under that load but cannot establish a quiet-machine speedup over 403 seconds. No before/after speedup is claimed here.

Verdict: two blockers under the requested definition. CI can pass a completely skipped shard, and the PR says nine jobs where the workflow has eight. Detailed evidence follows.

## Test moves

Static declaration inventory (`compare.py`, `test-name-counts.json`): 587 old declaration templates, 609 new, zero removed, 22 added. Templates in parameterized loops count once here, not once per runtime test. The combined split comparison is `compare-splits.py` / `splits.log`.

The combined round4/round8 comparison found all 37 declaration templates and byte-identical complete `check(...)` calls, including callback bodies and timeouts. Loop headings and their value sets were inspected separately and preserved. New files combine tests from both original files. Sequence helpers changed their outer registration loops into functions called once for each of loose, standard and strict; generators, seed limits, callback assertions and timeouts are unchanged: 120000 ms for sequences and 600000 ms for extended sequences. The extended sequence helper no longer permits CASEBOOK_SEQUENCE_LIB to suppress registration through a discovered test file. Both old latency sizes, 2000 and 10000, have explicit wrappers; callback and skip condition are unchanged. Existing no-browser and CASEBOOK_SKIP_10K conditions remain.

The one existing test body changed outside these moves, the archive spool test, uses its own temporary directory and adds a positive assertion that a spool actually exists before cancellation. This strengthens its evidence and avoids observing concurrent tests' spools. No new `.only`, retries, skipped old test or extended timeout found in the diff.

## Confirmed finding B1: CI accepts a shard whose tests were all skipped

Blocking. `scripts/ci-gate.ts:43-49` counts skipped records as tests and records their suite file as covered. It never requires a decisive result from each shard or each expected browser file. When another shard passes, Casebook's aggregate gate passes.

Smallest reproduction: `TMPDIR=$PWD/tmp bun ci-probes.ts` from this report's directory. Fixture `ci-fixtures/one-shard-skipped` has one passing test in tests-1 and one `<skipped/>` test in tests-2, both outcome files `{ "exit": 0, "seconds": 1 }`. Both expected test files appear in reports. The unchanged gate script runs against a real local Casebook with GitHub pull-request variables. Deciding output in `ci-one-shard-skipped.log`: `casebook gate    passed: 1 result proven`, tests-2 has one test, zero failed and exit 0; final process exit 0. Thus a runner missing Chromium can skip its browser tests and still make CI green. All shards skipped returns pending/exit 3, but a mixed run does not protect the skipped shard.

Other CI probes (`ci-summary.log`) pass: missing XML and missing outcome JSON exit 1, an empty suite exits 1, an omitted test file exits 1, crash exit 1 or timeout exit 124 with no reported failure is rejected, an assertion failure produces blocked/exit 2, 181-second duration warns/exit 0 and 241 seconds fails/exit 1. These are artifact simulations using the real gate script and local Casebook, not GitHub job execution.

Bun registration cross-check, independent of the text comparison: ran the base's `bun test src test --test-name-pattern='^$' --reporter=junit --reporter-outfile=../base-list.xml`. The impossible name pattern deliberately registers without executing tests. Then `register-phases.ts` called the current `testArgs` for all five parallel shards and quiet with the same impossible pattern, separate copies of committed timings and JUnit output. Comparing `(classname, name)` multisets yields `BEFORE 854 AFTER 876 REMOVED {} ADDED 22`. All 65 current files appear exactly once across the six reports, with no undiscovered or duplicate file. See `registration-comparison.log`. These filtered runs are registration evidence only; the full checks execute their bodies.

CI skipped-shard reproduction strengthened with actual Bun output: `workflow-probe.ts` starts `bun src/cli/main.ts serve` on port 7357 in its own data directory, uses empty CASEBOOK_URL/TOKEN/PROJECT and the requested GitHub variables, and runs the unchanged check script to produce six fixture shard reports. One fixture test is skipped. The unchanged `bun scripts/ci-gate.ts test-results tests-1 tests-2 tests-3 tests-4 tests-5 quiet` exits 0 with `quiet 1 0 0` and `passed: 5 results proven`. See `workflow-summary.log`. The fixture shards use 1/6 through 6/6 to give each tiny fixture one file; this tests the same CLI/report path, not real GitHub scheduling. The local fallback server exits in finally.

## Three consecutive full checks

Command: `TMPDIR=/home/endqwerty/.cache/casebook-arena/verify/dx-r1/tmp bun run check`, three times without source changes. Machine has 16 available threads. Another agent's selected browser tests were active. Logs are `check-1.log`, `check-2.log`, `check-3.log`.

| Run | Type-check | Lint | Parallel tests | Quiet tests | Tests / total | Exit |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 1.9 s | 0.5 s | 112.0 s | 38.2 s | 150.2 s / 150.2 s | 1 |
| 2 | 1.9 s | 0.5 s | 91.6 s | 36.7 s | 128.3 s / 128.3 s | 0 |
| 3 | 2.8 s | 0.6 s | 88.9 s | 36.8 s | 125.8 s / 125.8 s | 0 |

Each discovered `Ran 710 tests across 60 files` in parallel and `Ran 166 tests across 5 files` in quiet. Run 1 reports 707 pass, 1 skip, 2 fail and 1 error in parallel. It failed on:

- `a proposal arriving on an open case appears without navigation`: `error: The expected server state did not arrive`, support.ts:346 from recovery.test.ts:447, after 11635 ms.
- `standard: a adopts the agent's real diff and preserves agent attribution`: `this test timed out after 30000ms`, followed by `waitFor: Target page, context or browser has been closed` at agent.test.ts:138, waiting for `Proposal decisions cannot be withdrawn.`

All three quiet phases passed. Runs 2 and 3 passed both test phases. They still do not demonstrate the claimed quiet-machine 116-second time. The budget warnings explicitly exempted the runs because other work occupied 3.2, 4.8 and 4.6 cores respectively. Both intermittent failures passed on isolated reruns, described below. This review does not establish that the change caused those failures.

## Budget controls

The unchanged `over()` thresholds and tests were inspected. `budget-probe.py` copies the runner and plan into a small fixture, substitutes deterministic duration and busy-core measurements only, and executes real child test processes. It does not alter the limits or decision branches. See `budget-summary.log` and its per-case logs:

- 116 simulated test seconds, no other work: `WARNING`, exit 0.
- 122 seconds, no other work: `OVER BUDGET`, exit 1.
- 122 seconds, 3 busy cores: warning with `Not held to the limit`, exit 0.
- Explicit `test --workers=8` at 122 seconds: no budget output, exit 0. This is an intentional option exemption in code, even when 8 equals this machine's default.
- Unknown `--no-budget`: diagnostic and exit 4.

A normal `bun run check` has no environment switch that silently disables the budget. Small machines or sampled external load downgrade a violation to a visible warning. Explicit workers, one phase, a shard, and `--update-timings` disable the whole-suite budget. The load estimate is sampled before and after, not continuously, so it cannot establish whether competing work occupied the machine throughout a run. Hard-failure branch evidence above uses simulated measurements; these three unmodified real runs exercised the exemption branch.

## Browser setup and guard mutations

Pass for the checked isolation and guard behavior. `bun test --parallel=1 test/e2e/interception.test.ts test/e2e/ports.test.ts test/e2e/browser.test.ts` produced `9 pass`, `0 fail`, `35 expect() calls`, 6.51 seconds. The original tests cover page routes, context routes, pages opened later, blank pages, closed pages, shared-browser identity, fresh-context cookies/localStorage and recovery after the shared browser closes.

`guard-mutations.py` changed only the exported support.ts and restored its original contents in finally after every run:

| Removed guard | Test result and deciding evidence |
| --- | --- |
| Installing the route wrapper in openPage | interception.test.ts exits 1; expected one probe, received zero, line 71 |
| interceptionLive body, changed to immediate return | interception.test.ts exits 1; forced-order key request expected one intercepted request, received zero, line 42; wrapper assertion also fails |
| Port lock exclusion | ports.test.ts exits 1; reservations that must reject instead resolve |
| Stale-lock reclamation | ports.test.ts exits 1; dead-owner and old-lock tests throw `No free Casebook e2e port` |
| Fresh context creation, reusing first existing context | browser.test.ts exits 1; `expect(second.context).not.toBe(first.context)` fails |
| Reopening a disconnected shared browser | browser.test.ts exits 1; `browser.newContext: Target page, context or browser has been closed` |

See `mutation-*.log`. These are intentional failures, not failures of the delivered revision.

An additional real-browser probe, `bun test ../isolation-edge.test.ts`, produced `2 pass`, `0 fail`. It stored a service worker, CacheStorage entry and IndexedDB database in the first context, then verified all three absent in a second context on the same origin. It created a case in one server and verified the second server had zero cases. It ran interceptionLive on about:blank, raced it with page.close, called it again after close, and installed a context route with that page gone. No unexpected errors or hangs. Ordinary Playwright route installation can still reject if its own page/context is already closed; the wrapper does not promise to suppress that native error.

Two reader threads still exercise the real worker pool. Pool-specific tests in test/http.test.ts and src/server/readers.test.ts explicitly choose their own reader counts and check pooled completion/fallback behavior. The UI tests retain real HTTP servers and unchanged assertions. This change does reduce resource contention between test servers; these tests do not prove production throughput with eight readers, and this review makes no such claim.

The two intermittent run-1 failures were rerun in isolation: `bun test test/e2e/recovery.test.ts --test-name-pattern='a proposal arriving on an open case'` produced 2 pass / 0 fail; `bun test test/e2e/agent.test.ts --test-name-pattern='standard: a adopts'` produced 1 pass / 0 fail. Their cause under shared-machine load remains unresolved. The PR already names the agent-test timeout; this review also observed the recovery failure.

## Requested static and architecture checks

Pass on the unmodified export, before mutation probes:

- `bunx tsc --noEmit`: exit 0, no diagnostics.
- `bunx biome check .`: exit 0, `Checked 217 files in 183ms. No fixes applied.`
- `bun test test/architecture.test.ts`: exit 0, `12 pass`, `0 fail`, `31 expect() calls`.

Logs: `static-tsc.log`, `static-biome.log`, `architecture.log`.

The full check also hides the missing-browser warning on success. `scripts/check.ts:145-150` prints only the last line of successful captured test output, discarding both the `Skipping Casebook e2e...` notice and pass/skip counts. `message-probe.py` runs the unchanged runner against tiny fixture test files, one of which emits that exact notice and skips its test. `message-check.log` exits 0 and contains only `tests: parallel: Ran 1 test across 1 file`, with no skip notice. This reinforces B1's visibility problem. `bun run test` streams the original test output and does retain the notice.

The full injected-assertion run also exercised the real budget failure branch: `OVER BUDGET: the tests took 124.5 s`, with only 0.3 busy cores at the initial sample. This establishes the branch is wired in the real runner, although the test failure already required a nonzero exit.

The one skipped test in the complete runs is pre-existing: `test/e2e/round5.test.ts:328`, `R5B-4 needs slot-fill atStep from the server: undo restores the earlier failure's recorded step`. It is unchanged by this diff. The 854-before / 876-after registration inventory includes this declaration; no previously executing test was changed to skip.

## Confirmed finding B2: the PR counts nine CI jobs, but the workflow has eight

This is blocking only under the review brief's explicit rule that a false PR claim blocks. It is a description correction, not a runtime failure. The fetched PR body (`pr.json`, section “CI cost”) says “Nine jobs bill about 20 minutes per run”. The workflow has six matrix entries, tests-1 through tests-5 and quiet, plus static and gate: eight jobs. Smallest reproduction is counting the matrix entries and the other two jobs in `.github/workflows/check.yml`. Correct the count and base the cost explanation on the actual eight jobs. Billing duration remains an estimate until a real run.

## Workflow review and remaining GitHub limits

Source review of `.github/workflows/check.yml` finds five parallel shards and quiet, `fail-fast: false`, always-upload steps, an artifact download that permits the gate script to diagnose omissions, and a final static-job status assertion with `if: always()`. The gate depends on both static and tests and uses `if: ${{ !cancelled() }}`, so it is configured to run after a failed dependency, while excluding cancellation. Test steps intentionally use continue-on-error and delegate the result to the gate script. The missing-report, exit-code and file-coverage checks are therefore essential; their local failure probes are recorded above.

Only a real GitHub run can establish runner browser availability, installation and warm-up behavior, matrix timing, artifact upload/download wiring, permissions, job-timeout and cancellation propagation, the observed gate status after those failures, branch-protection requirements, actual latency and billed cost. None of those are claimed as locally verified. In particular, no real GitHub timeout or cancellation was induced. No production/deployed Casebook was used. Every gate probe used a new local instance and local data.

A quiet-machine before/after benchmark was not run. The base was used for source and registration comparisons, not for an additional complete serial browser suite. The review therefore does not independently substantiate the 403-to-116-second speedup or four clean 116-to-117-second repetitions in the PR.

## Failure propagation through the full check

Pass. `after-three.py` injected each defect separately in the export, ran the actual `bun run check`, then removed the temporary source file in finally. Original tests were otherwise unchanged.

| Probe | Mutation | Deciding output | Result |
| --- | --- | --- | --- |
| Test assertion | test/qa-failure.test.ts contains `expect(1).toBe(2)` | `QA injected failure`, expected 2 / received 1; `FAILED: tests: parallel` | exit 1, 124.5 s tests |
| Type error | src/core/qa-failure.ts contains `export const qaValue: string = 123` | `error TS2322: Type 'number' is not assignable to type 'string'.`; `FAILED: typecheck` | exit 1, 123.8 s tests |
| Lint error | trailing spaces in src/core/qa-failure.ts | formatter diagnostic on qa-failure.ts; `Found 1 error.`; `FAILED: lint` | exit 1, 128.1 s tests |

Logs are `injected-test.log`, `injected-type.log`, `injected-lint.log`. The assertion probe had precisely the injected failure, with 709 original parallel tests passing and the existing skip. Both static-error probes passed every original test phase. The test/type runs also exceeded the hard wall budget. The lint run used the busy-machine exemption and still exited 1 for lint, confirming that exemption does not erase a failing part.

## Documented commands

Pass for command parsing and the requested execution coverage. All commands ran from the exported root with TMPDIR inside this review directory.

| AGENTS.md command | Deciding evidence |
| --- | --- |
| `bun run test` | exit 0; parallel `709 pass`, `1 skip`, `0 fail`; quiet `166 pass`, `0 fail`; tests/total 130.0 s. Visible busy-machine budget warning. |
| `bun test test/suite.test.ts` | exit 0; `12 pass`, `0 fail`, `49 expect() calls`, 321 ms. |
| `bun run test --only=parallel --shard=2/5` | exit 0; `--shard=2/5: running 6/60 test files`; `28 pass`, `0 fail`, 34.9 s. |
| `bun run test --only=quiet` | exit 0; `166 pass`, `0 fail`, `1137 expect() calls`, 36.6 s. |
| `bun run test --update-timings` | starts `bun test --parallel=1 --no-orphans ... --update-timings` as documented. Intentionally interrupted after 3 s with `timeout --signal=INT --kill-after=5s`, wrapper exit 124. Not run to completion, as permitted by the brief. |

Logs: `documented-*.log`. SHA-256 of scripts/test-timings.json before and after the interrupted timing update is identical: `82af148e4d81fd3ced0d7c4429c4fa7ffb75f9e7e56a6af4dba263c9b57b3f3d`.

The three full-check totals above are the runner's own measured total. Complete command elapsed times, including the initial and final load samples and process startup, were approximately 152, 129 and 127 seconds, recorded in `three-summary.log`.

## Check-by-check disposition

- a. Pass. All 854 original registered names remain, all current files occur exactly once across phases/shards, moved bodies/timeouts and registration loop values are preserved. One old skip remains unchanged.
- b. Issues. All requested runs and error injections were performed. Error propagation and budget branches work. The first full run failed two browser tests; the next two passed under the busy-machine exemption. Quiet-machine performance and repeatability remain unverified.
- c. Pass for the requested probes. All three guard files pass on the revision and fail under the relevant guard removals. Extra browser-storage, server-data and closing-page probes pass.
- d. Issues. B1 permits an entirely skipped shard to end green when another shard proves a result. Missing reports, missing files, nonzero exits, timeout artifacts and reported assertion failures were rejected locally. Real GitHub orchestration remains unverified. B2 corrects the PR's job-count claim.
- e. Pass. Each documented command starts and selects the intended work; all completed command runs pass. Timing-update completion was intentionally not checked.
- f. Pass. TypeScript, Biome and architecture checks pass on the unmodified revision.

## Final state

`restore-audit.py` compares Git blob hashes for all files in the specified commit against the export. Final output: `tracked files checked 461 changed []`, `QA source files remaining []`. The shared repository was not edited. No commit, push or PR comment was made. PR 80 is linked to this review thread. Fixture servers and browsers were stopped; evidence and reproduction scripts remain under the requested review directory.

The two blockers are B1, a functional CI gap, and B2, a factual PR correction counted as blocking under the brief's explicit definition. The intermittent browser failures are recorded as unresolved stability observations, not attributed to this diff without evidence.

ISSUES (2 blockers)
