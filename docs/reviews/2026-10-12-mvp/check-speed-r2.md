# CI gate fix verification

Revision: `4a4f1fa6d5e730ca03dccaa389d16e2991977423`, against parent `9fef1c16c4a20b33f1ba2fbea1c04d7e6139f815`.
Reviewer: Codex, GPT-6 Astra. No other agents started.

The original B1 reproductions are fixed. One blocker remains in the explicitly requested testcase-without-file case. It has two consequences from the same cause: accepting an entirely skipped file and refusing a file that has a passing test. This finding uses synthesized JUnit accepted by Mainworthy's parser. The actual Bun 1.4.3 reports generated during this review include `file` on every testcase and pass all requested checks.

All work ran locally in `$HOME/.cache/mainworthy-arena/verify/dx-r2/tree`, exported with `git archive 4a4f1fa`. Scratch files, fixtures, logs, and this report are under `dx-r2`. The repository was read-only. `bun install --frozen-lockfile` succeeded with Bun 1.4.3. No worktree release command ran.

The safety fact is that a report cannot make the CI gate succeed when every test of a reported file was skipped, while a file containing passed and skipped tests remains accepted. Before mutations, the checks were recorded in this report: the prior probes, parser edge cases, both real reports, targeted tests, static checks, and removing the new counting block.

## Finding B1-R2: inherited testcase file is omitted from the count

Blocking under the requested missing-file case and definition of a blocker. Location: `scripts/ci-gate.ts:51`, with the decision at line 58. The regex requires a `file="..."` attribute on each testcase. It skips testcases whose enclosing testsuite supplies their file. The existing `parseJUnit` call at line 44 does resolve this inheritance, so the gate's two interpretations of the same report disagree.

Reproduce from `dx-r2`:

```
TMPDIR=$HOME/.cache/mainworthy-arena/verify/dx-r2/tmp bun neighbour-probes.ts
```

Fixture `neighbour-fixtures/missing-testcase-file/test-results/tests-1.xml` contains:

```xml
<testsuites>
  <testsuite file="test/a.test.ts" name="test/a.test.ts">
    <testcase name="passes" time="0.1" file="test/a.test.ts" line="1" />
  </testsuite>
  <testsuite file="test/deep/browser.test.ts" name="test/deep/browser.test.ts">
    <testcase name="skips"><skipped /></testcase>
  </testsuite>
</testsuites>
```

Both test files exist in the fixture. The outcome JSON is `{"exit":0,"seconds":1}`. The unchanged gate runs against a fresh local Mainworthy. Deciding evidence in `neighbour-missing-testcase-file.log` and `neighbour-summary.log`:

- Mainworthy accepts `2 results`, including `1 pass` and `1 skip`.
- `mainworthy gate    passed: 1 result proven`.
- The counting block sees only `test/a.test.ts`, with no problems.
- The gate process exits **0**, with no error annotation, although every test of `test/deep/browser.test.ts` was skipped.

The inverse fixture, `missing-file-passing-neighbour`, puts a skipped testcase with an explicit file beside `<testcase name="passes" />` in the same file's suite. Mainworthy correctly reports a pass, but the new count ignores it. The gate exits **1** with `::error::tests-1: every test of test/deep/browser.test.ts was skipped (1)`. This is a new false rejection for an inherited-file report.

Suggested fix: count the already parsed `results` by `result.test.file` and `result.outcome`, or resolve suite inheritance in the count. Add both cases to the regression coverage.

Producer limitation: these two reports are synthetic variations. I did not find a current Bun 1.4.3 execution path that omits a testcase's file, and I do not claim the checked workflow presently generates this format. The blocker applies to the missing-file input expressly included in this review request. Under a narrower contract that only accepts the observed Bun output, this would instead be a hardening limitation.

## a. Diff and testcase parsing

Read the entire `git diff 9fef1c1 4a4f1fa`, the complete gate script and tests, and the relevant existing JUnit parser. The diff is limited to the stated three files. The AGENTS sentence describes the intended per-file requirement.

`neighbour-probes.ts` extracts the exact new counting block from the checked revision, transpiles it with Bun, and records its map and errors. It also invokes the actual full gate against each fixture and a real local Mainworthy. It does not substitute a different counting implementation.

| Shape | Result and deciding evidence |
| --- | --- |
| Self-closing testcase | Pass. Counted as executed; `same-file-mixed` counts two tests and one skip, exits 0. |
| `<skipped />` child | Pass. `same-shard-one-file-skipped` exits 1 with the skipped-file error. |
| Nested suites within a file | Pass. `nested-all-skipped` counts two skips, emits `(2)`, and exits 1; `nested-mixed` counts two tests with one skip and exits 0. |
| Failure child | Pass. `only-failed` counts one executed test and zero skips; Mainworthy blocks and the script exits 2. |
| Error child | Pass. `only-error` counts one executed test and zero skips; Mainworthy blocks and the script exits 2. |
| Attribute order | Pass. Explicit file first and last both count; `attribute-order` emits the skipped-file error with `(2)` and exits 1. |
| File attribute containing a path | Pass. The fixtures use `test/deep/browser.test.ts`; the real browser report uses `test/e2e/round5.test.ts`. Both appear intact in counts and annotations. |
| Testcase without file attribute | Issues. Ignored instead of inheriting its suite's file; see B1-R2. |

Evidence: `neighbour-summary.log`, `neighbour-*.log`, and `neighbour-fixtures/`.

## b. Original reproductions and unchanged gate probes

Copied `ci-probes.ts` and `workflow-probe.ts` unchanged from `dx-r1`. Their relative imports now use the new export. Their historical synthetic GitHub SHA is report metadata, not the code revision executed. Commands, from `dx-r2`:

```
TMPDIR=$HOME/.cache/mainworthy-arena/verify/dx-r2/tmp bun ci-probes.ts
TMPDIR=$HOME/.cache/mainworthy-arena/verify/dx-r2/tmp bun workflow-probe.ts
```

Pass for both original B1 reproductions:

- `one-shard-skipped`: **exit 1**, `::error::tests-2: every test of test/b.test.ts was skipped (1)`. Mainworthy itself still says `passed: 1 result proven`; the new check correctly rejects the job.
- Workflow probe: all six fixture shard commands exit 0, but the gate now **exits 1** with `::error::quiet: every test of test/tests-5.test.ts was skipped (1)`. These reports come from actual Bun runs through `scripts/check.ts`. The fixture shard allocation places the skipped source file in `quiet`. The local server stops in `finally`.

The other probes retain their earlier outcomes:

| Probe | Exit | Deciding line |
| --- | --- | --- |
| Green | 0 | `passed: 2 results proven` |
| Missing report | 1 | `::error::tests-2: no report (test-results/tests-2.xml is missing or empty)` |
| Missing outcome JSON | 1 | `::error::tests-2: no report (its outcome file is missing)` |
| Empty suite | 1 | `::error::tests-2: its report holds no test` |
| Omitted file | 1 | `::error::in no shard's report: test/b.test.ts` |
| Crash | 1 | `::error::tests-2: the tests exited 1 and the report shows no failure` |
| Timeout | 1 | `::error::tests-2: the tests exited 124 and the report shows no failure` |
| Assertion failure | 2 | `blocked: 1 failure unexplained, 1 question open` |
| Slow warning | 0 | `::warning::the slowest shard's tests took 181.0 s, over the budget of 180 s` |
| Slow failure | 1 | `::error::the slowest shard's tests took 241.0 s, over the limit of 240 s` |

Evidence: `ci-summary.log`, `ci-*.log`, `workflow-summary.log`, `workflow-gate.log`, and fixture directories. Crash, timeout, and elapsed-time probes simulate outcome artifacts; they do not terminate a GitHub runner or measure performance.

## c. Neighbours and real reports

Pass for the requested Bun-shaped neighbours:

- Every shard skipped: the script emits an error for each file and exits **3**, because the existing pending Mainworthy gate code takes precedence over the new exit-1 branch. CI still fails. This does not meet a literal universal “exit 1” statement, but it is not a blocker under the supplied definition.
- One file entirely skipped beside an executed file in the same shard: **exit 1**, `::error::tests-1: every test of test/deep/browser.test.ts was skipped (1)`.
- One skipped test beside a pass in the same file: **exit 0**, no skipped-file error.
- The file's only test fails: **exit 2**, blocked, with no false skipped-file annotation.

Ran in the unmodified export:

```
TMPDIR=$HOME/.cache/mainworthy-arena/verify/dx-r2/tmp bun test test/policy.test.ts test/e2e/round5.test.ts --reporter=junit --reporter-outfile=$HOME/.cache/mainworthy-arena/verify/dx-r2/real.xml
```

**Exit 0**. `29 pass`, `1 skip`, `0 fail`, `204 expect() calls`. The actual counting block reports policy `17 tests / 0 skipped` and round5 `13 tests / 1 skipped`, with no flagged files. Feeding the complete real report through the full gate in a fixture containing those two source files yields **exit 0**, `passed: 29 results proven`.

Then `mutation-probes.py` sets `browserAvailable = false` in the exported `test/e2e/support.ts` and runs the same command with `MAINWORTHY_CHROMIUM=/nonexistent`, writing `no-browser.xml`. The support override prevents discovery of an installed default browser without altering this machine's browser paths. It restores the original bytes in `finally`.

The test command exits 0 with `17 pass`, `13 skip`, `0 fail`. The exact counting block records round5 `13 tests / 13 skipped`. The full gate **exits 1** with:

```
::error::tests-1: every test of test/e2e/round5.test.ts was skipped (13)
```

Evidence: `real-tests.log`, `real.xml`, `no-browser-tests.log`, `no-browser.xml`, `neighbour-real.log`, `neighbour-no-browser.log`, and `neighbour-summary.log`.

## d. Tests, static checks, and regression mutation

Pass on the unmodified export:

| Command | Exit | Deciding evidence |
| --- | --- | --- |
| `bun test test/ci-gate.test.ts test/check.test.ts` | 0 | `14 pass`, `0 fail`, `70 expect() calls` |
| `bunx tsc --noEmit` | 0 | No diagnostics |
| `bunx biome check .` | 0 | `Checked 216 files in 246ms. No fixes applied.` |

Logs: `targeted-tests.log`, `static-tsc.log`, and `static-biome.log`. All commands use `TMPDIR` under `dx-r2`.

`python mutation-probes.py` removes precisely the block from `const ran =` through the skipped-file decision in the exported script, then reruns both requested test files. **Exit 1**, `13 pass`, `1 fail`. The sole failure is:

```
(fail) a test file whose tests were all skipped fails the job, though the gate passes on the others
Expected to contain: "::error::tests-2: every test of test/c.test.ts was skipped"
```

The captured received output has `passed: 6 results proven` and no error annotation. This proves the new regression test fails when the implementation is removed. Evidence: `removed-block-tests.log` and `mutations.log`.

Both mutated files were restored in `finally`. `restore-audit.log` confirms byte equality with the reviewed commit for the gate script, browser support, both targeted test files, and AGENTS.md.

## Not checked

No GitHub jobs, artifact transport, deployed server, production service, or external account was exercised. No full-project test run was requested or performed for this narrow re-review. The real report covers the two requested files. I did not establish that Bun itself can emit the missing-file forms in B1-R2. General XML producer compatibility beyond the listed fixtures was not reviewed. No performance or billing claim is made.

ISSUES (1 blockers)
