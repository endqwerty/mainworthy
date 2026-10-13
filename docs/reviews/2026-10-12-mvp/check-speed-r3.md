# CI gate and check runner verification

Revision: `c824dce104263eac472bfafbb9476e9bd8f104e9`, against `358a2aa`. Reviewer: Codex, GPT-6 Astra. No other agents started.

B1-R2 is fixed. One blocking regression remains in the gate's handling of text inside JUnit output and comments. The requested ordinary suite-inheritance cases pass.

All execution used the clean export at `/home/endqwerty/.cache/casebook-arena/verify/dx-r3/tree`. The repository was read-only. `git archive c824dce104263eac472bfafbb9476e9bd8f104e9` supplied the export, and `bun install --frozen-lockfile` succeeded with Bun 1.4.3. Logs, fixtures, scripts, and temporary files are under `dx-r3`. No worktree release command ran.

The safety fact is that the gate rejects a file whose tests all skipped, accepts a file with an executed test, and preserves failure handling. The runner must show one browser-unavailable note without changing its intended local success status. Checks were recorded in `PLAN.md` before mutations. The gate safety fact is disproved by B1-R3 below.

## B1-R3: XML output text is counted as test results

Blocking under the supplied definition, with both a false pass and a false rejection. Location: `scripts/ci-gate.ts:54-64`, and the skipped-file decision at lines 68-70.

The new regex walks text inside XML comments and CDATA as though it were result elements. Unlike the old regex, it now accepts testcases without a file attribute and gives them their enclosing suite's file. The existing `parseJUnit` call correctly ignores this text. The gate therefore gives two different meanings to the same valid report.

Reproduce from `dx-r3`:

```
TMPDIR=/home/endqwerty/.cache/casebook-arena/verify/dx-r3/tmp bun text-probes.ts
TMPDIR=/home/endqwerty/.cache/casebook-arena/verify/dx-r3/tmp bun baseline-text-probes.ts
```

Both scripts run the full gate against a fresh local Casebook, with the fixture source files present and outcome JSON `{"exit":0,"seconds":1}`. The baseline script uses the exact `358a2aa` gate source in `baseline/scripts/ci-gate.ts`, with dependencies linked to the export. Those dependencies are unchanged by the reviewed diff.

### False pass

Fixture `neighbour-fixtures/skipped-file-output-fake-pass/test-results/tests-1.xml` has one passing file and a second file with only a skipped test. The second suite contains captured output showing a testcase example:

```xml
<testsuite file="test/deep/browser.test.ts" name="test/deep/browser.test.ts">
  <testcase name="skips" file="test/deep/browser.test.ts"><skipped /></testcase>
  <system-out><![CDATA[<testcase name="example" />]]></system-out>
</testsuite>
```

Deciding evidence:

- Casebook reports `2 results   1 pass   0 fail   1 skip`.
- Head counts the second file as two tests, one skipped, and exits **0** without an error annotation.
- Baseline counts it as one test, one skipped, and exits **1** with `::error::tests-1: every test of test/deep/browser.test.ts was skipped (1)`.

Evidence: `text-summary.log`, `baseline-text-summary.log`, `neighbour-skipped-file-output-fake-pass.log`, and `baseline-skipped-file-output-fake-pass.log`.

### False rejection

Fixture `inherited-pass-output-skipped-text` contains one passing testcase whose file comes from its suite:

```xml
<testsuite file="test/deep/browser.test.ts" name="test/deep/browser.test.ts">
  <testcase name="passes"><system-out><![CDATA[<skipped />]]></system-out></testcase>
</testsuite>
```

Casebook reports `1 results   1 pass   0 fail   0 skip` and `passed: 1 result proven`. Head nevertheless exits **1** with `::error::tests-1: every test of test/deep/browser.test.ts was skipped (1)`. Baseline exits **0**. Replacing the system-out with `<!-- <skipped /> -->` has the same result.

Evidence: `neighbour-inherited-pass-output-skipped-text.log`, `neighbour-inherited-pass-comment-skipped-text.log`, their `baseline-` equivalents, and both text summary logs.

These are one blocker with the same cause. Count the already parsed `results` by `result.test.file` and `result.outcome` to avoid interpreting XML twice. Add regression cases for ignored text.

Producer limit: these are valid synthesized JUnit reports, not reports observed from Bun during this review. They extend the inherited-file format expressly included in the review. I do not claim the checked Bun workflow currently produces them.

## Diff and requested probes

Read `git diff 358a2aa c824dce -- scripts test`, all of both scripts and their targeted tests, browser discovery, and the relevant JUnit parser behavior. The diff is limited to the three stated files. The check runner collects identical skip lines in a Set, prints them in its summary, and leaves its exit calculation unchanged.

Copied `neighbour-probes.ts` unchanged from `dx-r2`, preserving every prior fixture. It extracts the actual counting block for diagnostics and runs the full gate separately. Its historical GitHub SHA is synthetic report metadata, not the executed code revision.

Commands from `dx-r3`, with `TMPDIR` set to `dx-r3/tmp`:

```
bun neighbour-probes.ts
bun extended-probes.ts
```

The requested probes pass:

| Probe | Exit | Deciding evidence |
| --- | --- | --- |
| `missing-testcase-file` | 1 | `every test of test/deep/browser.test.ts was skipped (1)` |
| `missing-file-passing-neighbour` | 0 | Two tests, one skipped; no problems; `passed: 1 result proven` |
| Same shard, one entirely skipped file | 1 | Skipped-file error for the second file |
| Same file, pass beside skip | 0 | Two tests, one skipped; no problems |
| Explicit-file failure or error child | 2 | `blocked: 1 failure unexplained, 1 question open`; no skipped-file error |
| Nested suites, every test skipped | 1 | Skipped-file error with `(2)` |
| Nested suites, mixed outcomes | 0 | Two tests, one skipped; no problems |
| File attribute first or last | 1 | Two tests and two skips attributed to the same file |
| Three-deep suites, inherited skips | 1 | Innermost skip attributed to `test/deep/browser.test.ts` |
| Three-deep suites, inherited pass beside skip | 0 | Two tests, one skipped; no problems |
| Three-deep suite pop restores parent file | 1 | Child file skipped; following passing testcase counted for parent file |
| Self-closing suite before mixed tests | 0 | Following tests retain their outer suite's file |
| Self-closing suite before an inherited skip | 1 | Skip attributed to the outer suite's file, not the empty suite |
| Suite with no file anywhere, pass | 0 | One unnamed-file test, zero skipped; no problems |
| Suite with no file anywhere, skip | 3 | `every test of a suite that names no file was skipped (1)`; existing pending gate status takes precedence |
| Inherited-file failure or error child | 2 | `blocked: 1 failure unexplained, 1 question open`; one executed test, zero skips |

The two B1-R2 symptoms are gone. Every other original neighbour retains its prior exit and annotation. The nameless suite fixtures contain no source files, so they isolate counting rather than deliberately triggering the existing missing-source-file check.

Evidence: `neighbour-summary.log`, `extended-summary.log`, `neighbour-*.log`, and `neighbour-fixtures/`. An initial extended run overlapped the export-only regression mutation; it was discarded and rerun after restoration. The saved extended summary is the clean rerun.

## Real Bun report

Pass. In the unmodified export:

```
TMPDIR=/home/endqwerty/.cache/casebook-arena/verify/dx-r3/tmp bun test test/policy.test.ts test/e2e/round5.test.ts --reporter=junit --reporter-outfile=/home/endqwerty/.cache/casebook-arena/verify/dx-r3/real.xml
```

Exit **0**. Deciding lines: `29 pass`, `1 skip`, `0 fail`, `204 expect() calls`.

The actual counter records policy as 17 tests with zero skips and round5 as 13 tests with one skip. No file is flagged. Running the complete report through the full gate, with those two source files present, exits **0** and says `passed: 29 results proven`.

Evidence: `real-tests.log`, `real.xml`, `neighbour-real.log`, and `extended-summary.log`.

## Targeted tests, static checks, and mutation

All requested checks pass on the unmodified export. Commands used `TMPDIR` under `dx-r3`.

| Command | Exit | Deciding lines |
| --- | --- | --- |
| `bun test test/ci-gate.test.ts test/check.test.ts` | 0 | `15 pass`, `0 fail`, `75 expect() calls` |
| `bunx tsc --noEmit` | 0 | No diagnostics |
| `bunx biome check .` | 0 | `Checked 216 files in 307ms. No fixes applied.` |

Evidence: `targeted-tests.log`, `static-tsc.log`, `static-biome.log`, and their `.exit` files.

Replaced only the counting block in the exported `scripts/ci-gate.ts` with its exact old block from `358a2aa`. Then ran:

```
bun test test/ci-gate.test.ts -t 'a test that takes its file from its suite is counted for that file'
```

Pass for mutation sensitivity. The test command exits **1**, with `0 pass`, `7 filtered out`, `1 fail`. The deciding assertion at line 160 expects `::error::tests-2: every test of test/c.test.ts was skipped`, which is absent. The received gate output says `passed: 6 results proven`. The script was restored in `finally`.

Evidence: `old-counting-tests.log` and `old-counting-tests.exit`.

## Browser notice

Browser-available run passes. In the unmodified export, `TMPDIR=.../dx-r3/tmp bun run check` exits **0**. Both test phases, type-check, and lint say `ok`. Deciding lines include `Ran 708 tests across 59 files` and `Ran 166 tests across 5 files`. There is no `NOTE: the browser tests did not run.` line and no `Skipping Casebook e2e` line.

The check emits its existing wall-time warning because the run exceeds its limit and the machine has other work. It retains exit 0 under the existing shared-machine exemption. This review makes no performance claim. Evidence: `check-browser.log` and `check-browser.exit`.

Browser-unavailable run also passes. `python no-browser-check.py` changes the exported browser path discovery to `.find((path) => path && existsSync(path) && false)`, so `chromiumPath` is undefined while its type and all check behavior remain intact. It runs `bun run check` with `TMPDIR` under `dx-r3` and restores the original support file in `finally`.

The check exits **0**. Type-check, lint, and both test phases say `ok`. Exactly one summary note appears:

```
NOTE: the browser tests did not run. Skipping Casebook e2e: set CASEBOOK_CHROMIUM or install system Chromium.
```

The driver confirms `exit 0 NOTE count 1` and `Browser support restored byte for byte.` Evidence: `no-browser-check.py`, `no-browser-driver.log`, `check-no-browser.log`, and `check-no-browser.exit`.

## Restoration and limits

Every exported regular file was compared byte for byte with a fresh archive of the reviewed revision after both mutations. No differences remain. Evidence: `restore-audit.log`.

No repository edit, commit, PR operation, external service, GitHub job, artifact transport, or production check was performed. No other agents ran. Browser checks used the project's local test commands. General XML compatibility beyond the described cases was not exhaustively reviewed, and the synthesized XML output cases are not established Bun producer behavior. No performance claim is made.

ISSUES (1 blockers)
