# CI gate verification

Revision: `8168a5e407a0c9cea412e65ac2b37bf69e9fda48`, against parent `ed9e85e042b855cdfb10db6994c311336fb53f07`. Reviewer: Codex, GPT-6 Astra. No other agents started.

B1-R3 is fixed. One new blocker remains: using the reader's truncated file name merges distinct files and can conceal a file whose tests all skipped. This was reproduced with Bun's own report.

All execution used the clean export at `/home/endqwerty/.cache/mainworthy-arena/verify/dx-r4/tree`. The repository was read-only. `git archive 8168a5e` supplied the export, and `bun install --frozen-lockfile` succeeded with Bun 1.4.3. All review scripts, logs, fixtures and temporary directories are under `dx-r4`. Test commands set `TMPDIR` to `dx-r4/tmp`. No worktree release command ran.

The safety fact is that counting parsed results must preserve each source file's identity, reject a wholly skipped file, and accept a file with an executed test. B1-R4 disproves the identity requirement. The `verify` skill shaped the full-gate probes and the comparison with the parent. TypeScript review and report writing also followed `typescript-best-practices`, `technical-writing` and `unslop`.

## B1-R4: truncated file names merge distinct files

Blocking under the requested definition. Location: `scripts/ci-gate.ts:55`, where the new map uses `result.test.file` as its key. The relevant reader behavior is `src/surfaces/formats/junit.ts:587`, which sets that field with `limited(file, 500, "Test file", start)`.

Two distinct paths longer than 500 characters can have the same first 500 characters. When one file passes and the other file wholly skips, the new map combines them into two tests with one skip. No skipped-file error is emitted. The independent missing-file check sees both full suite paths, so it does not reject the report either.

This is a regression against the parent and is possible in Bun's own reports. The review created two real files under `long-path-fixture`. Their paths are built as follows:

```text
prefix = "test/" + five 99-character "a" directory names separated by "/" + "/"
passing file = prefix + "pass.test.ts"
skipped file = prefix + "skip.test.ts"
```

Both relative paths have 517 characters. Each directory component is valid on this machine. The passing file contains `test("runs", () => {})`; the other contains `test.skip("skips", () => {})`, each with the normal `bun:test` import.

Ran from `dx-r4/long-path-fixture`:

```sh
TMPDIR=/home/endqwerty/.cache/mainworthy-arena/verify/dx-r4/tmp bun test --reporter=junit --reporter-outfile=/home/endqwerty/.cache/mainworthy-arena/verify/dx-r4/long-path.xml
```

Bun exits **0** and prints `1 pass`, `1 skip`, `0 fail`, `Ran 2 tests across 2 files.` The generated XML contains both full file paths.

Then ran from `dx-r4`, with the same `TMPDIR`:

```sh
bun long-path-probe.ts
bun baseline-long-path-probe.ts
```

Both run the complete gate against a fresh local Mainworthy with the two source paths present and outcome JSON `{"exit":0,"seconds":1}`. The baseline uses the exact parent gate script, with unchanged dependencies linked to the clean export.

Deciding evidence:

- Head: one map entry with `{"tests":2,"skipped":1}`, `"problems":[]`, **exit 0**, and `mainworthy gate    passed: 1 result proven`.
- Head also prints two `Test file truncated to 500 characters` warnings. They do not change its exit code.
- Parent: two map entries, **exit 1**, and `::error::tests-1: every test of test/.../skip.test.ts was skipped (1)`. The complete path is in the saved log.

Evidence: `long-path.xml`, `long-path-bun.log`, `long-path-summary.log`, `baseline-long-path-summary.log`, `neighbour-long-path-real-bun.log`, `baseline-long-path-real-bun.log`, and both probe scripts. The source files are retained under `long-path-fixture`.

Suggested correction: preserve the full source-file identity in parser metadata for this check, while retaining one XML interpretation. The bounded display field is not a unique file identifier. Add a regression with two actual paths that share their first 500 characters. Restoring the old text pattern would reintroduce B1-R3.

## Check a: reader semantics

**Issues**, due to B1-R4. Read `git show 8168a5e -- scripts test`, the gate and its tests, and the reader's file assignment, status initialization, child handling, annotation handling, retry handling and damage recovery.

Ran `TMPDIR=.../dx-r4/tmp bun reader-probes.ts`. Every ordinary edge below behaved correctly through the full gate. Evidence is `reader-summary.log` and the individual `neighbour-*.log` files.

| Input | Result and deciding evidence |
| --- | --- |
| Failure followed by skip; skip followed by failure | Both exit 2, `blocked: 1 failure unexplained, 1 question open`. The reader preserves failure precedence; neither is counted as a skip. |
| `status="notrun"`, `disabled`, or `skipped` | Each exits 1 beside a passing file, with `every test of test/deep/browser.test.ts was skipped (1)`. |
| `flakyFailure` or `rerunFailure` without a final failure | Exit 0. The reader records a passing result after retries. The counter follows that established interpretation. |
| `rerunError` plus a final skip | Exit 1 with the skipped-file error. |
| Name annotation `@C-1` plus skip | Exit 1 with the correct file's skipped error. |
| Mainworthy property annotation on a pass | Exit 0. The reader keeps `test.key` and `test.file`; annotations do not replace them with `{ case: ... }`. |
| Malformed skipped testcase | Exit 2, `blocked: 1 failure unexplained, 1 question open`. Damage becomes an error result, so treating it as non-skip does not make the gate pass. |

The reader constructs keyed tests only. `{ case: ... }` is permitted by the broader input type but is not returned by this reader. The defensive branch in the new loop therefore does not discard files on reader-produced case annotations. Results with no file deliberately share the unnamed group, as requested. Empty results are rejected separately. An uncaught parsing exception would terminate the process unsuccessfully rather than yield a successful count; no exception was injected.

The status, mixed failure/skip, retry, and malformed fixtures are synthetic. This review does not claim Bun emits those combinations. B1-R4 is different: its report was generated by the installed Bun, not synthesized.

## Check b: prior fixtures and gate failures

**Pass.** Copied the dx-r3 neighbour, extended and text probe scripts into `dx-r4`. The dx-r2 and dx-r3 neighbour fixture definitions are identical. The only necessary diagnostic adaptation supplies `parseJUnit(xml).results` to the extracted counting block; the actual gate subprocess always runs the complete reviewed script. Copied `ci-probes.ts` from dx-r2 unchanged. Fixture payloads were preserved.

Commands from `dx-r4`, all with `TMPDIR=.../dx-r4/tmp`:

```sh
bun neighbour-probes.ts
bun extended-probes.ts
bun text-probes.ts
bun ci-probes.ts
```

Each probe starts a fresh local Mainworthy. Historical GitHub values in these scripts are fixture metadata; they do not access GitHub or select executable code.

| Fixture or group | Exit and deciding evidence |
| --- | --- |
| B1-R3 `skipped-file-output-fake-pass` | 1, `every test of test/deep/browser.test.ts was skipped (1)` |
| B1-R3 `inherited-pass-output-skipped-text` | 0, no error, `passed: 1 result proven` |
| Passing test with skipped text in a comment; suite output with testcase text | Both 0, no errors |
| B1-R2 `missing-testcase-file` | 1, correct inherited file's skipped error |
| B1-R2 `missing-file-passing-neighbour` | 0, two tests and one skip in the same file |
| Same shard with one skipped file | 1, skipped-file error |
| Mixed outcomes in one file | 0 |
| Explicit or inherited failure and error children | 2, `blocked: 1 failure unexplained, 1 question open` |
| Nested all-skipped suite; file attributes in either order | 1, two skips attributed to the correct file |
| Nested mixed suite | 0 |
| Three-deep inherited skips; suite stack restored after inner suite | 1, correct skipped file |
| Three-deep mixed suite; self-closing suite before mixed cases | 0 |
| Self-closing suite before inherited skip | 1, skip assigned to the enclosing file |
| No file anywhere, pass | 0 |
| No file anywhere, skip | 3, existing pending status takes precedence; `every test of a suite that names no file was skipped (1)` is present |
| Original B1, one shard skipped | 1, `every test of test/b.test.ts was skipped (1)` |
| All shards skipped | 3, `pending: nothing was proven`, both skipped-file annotations |
| Green shards | 0, `passed: 2 results proven` |
| Missing XML | 1, `no report (test-results/tests-2.xml is missing or empty)` |
| Missing outcome JSON | 1, `no report (its outcome file is missing)` |
| Empty suite | 1, `its report holds no test` and `mainworthy report exited 4` |
| Omitted source file | 1, `in no shard's report: test/b.test.ts` |
| Crash outcome | 1, `the tests exited 1 and the report shows no failure` |
| Timeout outcome | 1, `the tests exited 124 and the report shows no failure` |
| Assertion failure | 2, `blocked: 1 failure unexplained, 1 question open` |
| Slow warning | 0, `::warning::the slowest shard's tests took 181.0 s` |
| Slow failure | 1, `::error::the slowest shard's tests took 241.0 s` |

Evidence: `neighbour-summary.log`, `extended-summary.log`, `text-summary.log`, `ci-summary.log`, individual logs, and the retained fixture directories. Crash, timeout and slow-shard probes use outcome files; they do not deliberately crash or delay a runner.

## Check c: real Bun reports

**Pass.** In the clean export:

```sh
TMPDIR=/home/endqwerty/.cache/mainworthy-arena/verify/dx-r4/tmp bun test test/policy.test.ts test/e2e/round5.test.ts --reporter=junit --reporter-outfile=/home/endqwerty/.cache/mainworthy-arena/verify/dx-r4/real.xml
```

Exit **0**, `29 pass`, `1 skip`, `0 fail`, `204 expect() calls`. Through the full gate: policy has 17 tests and zero skips; round5 has 13 tests and one skip. No file is flagged. Exit **0**, `passed: 29 results proven`.

Repeated the command with output `no-browser.xml` after changing only the exported browser discovery predicate to `.find((path) => path && existsSync(path) && false)`. Restored the support file in `finally`.

Bun exits **0**, `17 pass`, `13 skip`, `0 fail`, `157 expect() calls`. The full gate exits **1** and prints `::error::tests-1: every test of test/e2e/round5.test.ts was skipped (13)`.

Evidence: `real-tests.log`, `real-tests.exit`, `real.xml`, `no-browser-tests.log`, `no-browser-tests.exit`, `no-browser.xml`, `neighbour-real.log`, `neighbour-no-browser.log`, and `neighbour-summary.log`. The browser tests use the project's local test workflow.

## Check d: targeted tests, static checks, mutation

**Pass** for every requested check.

| Command from the export | Exit | Deciding lines |
| --- | --- | --- |
| `bun test test/ci-gate.test.ts test/check.test.ts` | 0 | `16 pass`, `0 fail`, `79 expect() calls` |
| `bunx tsc --noEmit` | 0 | No diagnostics |
| `bunx biome check .` | 0 | `Checked 216 files in 345ms. No fixes applied.` |

Evidence: `targeted-tests.log`, `static-tsc.log`, `static-biome.log`, and corresponding `.exit` files.

After all ordinary gate probes finished, removed only the new `for (const result of results)` loop from the exported gate, leaving the empty map and its subsequent error check. Ran:

```sh
bun test test/ci-gate.test.ts -t "a test file whose tests were all skipped|a test that takes its file from its suite|text inside a test's output"
```

Exit **1**, `0 pass`, `6 filtered out`, `3 fail`. Each named regression test fails because its expected `::error::tests-2: every test of test/c.test.ts was skipped` is absent. The gate is restored in `finally`. Evidence: `mutation-tests.log` and `mutation-tests.exit`.

## Restoration and limits

Compared all 481 exported regular files byte for byte against a fresh `git archive 8168a5e`. `Differences: []`. Evidence: `restore-audit.log`.

No repository changes, commits, PR operations, external systems, GitHub workflow execution, artifact transport or production checks. No other agents. This bounded review ran the requested targeted tests and static checks, not the whole `bun run check` suite. It did not audit all JUnit dialects or unrelated parser behavior. The existing regex for report coverage was read but not comprehensively reviewed. No performance claim is made. The long-path fixture establishes a valid Bun-produced false pass; current repository paths were not claimed to trigger it.

ISSUES (1 blockers)
