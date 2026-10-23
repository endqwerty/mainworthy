# Local QA verification of archive recovery and signature clipping

Revision: `506e3ece169d30cbfbda312811d5e81f99624f57`, requested branch `mvp/2-engine`.
Verifier: OpenAI Codex, GPT-6 Astra. I ran these checks myself in a clean `git archive 506e3ec` export, using Bun 1.4.3. I did not change the repository or start other agents. This report establishes the tested behavior; it does not establish a different-provider review if the author was also Codex.

All commands below ran in `ship-r1/tree` unless stated otherwise. Scripts and logs are beside this report. After the initial test run, I set `TMPDIR=$HOME/.cache/mainworthy-arena/verify/ship-r1/tmp` for server tests and probes. The initial run used the tests' default temporary directories, which their cleanup removed. All deliberate scratch files and this report are under `ship-r1`.

## Safety facts

The archive change is safe if pending reports produce the same stored evidence and gate as normal application, and a failed application leaves no partial report effects. Both facts passed the local HTTP checks below. The importer commits the archive first; `recoverAccepted` then applies each report in its own transaction. A report that cannot apply stays accepted, with its original staged contents, and its gate stays pending. Other reports continue.

The signature change is safe for ordinary text if its normalization and hashes remain identical. All changed call sites use positive integer limits. With no surrogate at a cut, `clip` and `clipEnd` return exactly what the previous slices returned. This passed differential checks. One Unicode case increases the final text from 299 to 300 units, described below; the old output split a character, and ordinary grouping is unaffected.

## Checks and deciding evidence

1. **Pass: installation and diff review.** Ran `bun install --frozen-lockfile`, which reported `117 packages installed`, on Bun `1.4.3 (c6da4a4d3)`. Read `git diff aa7a605 506e3ec -- src/surfaces/archive.ts src/surfaces/archive.test.ts src/server/transfer/transfer.test.ts` and `git diff 490aaf5 506e3ec -- src/core/signature.ts src/core/text.ts` against the source repository, read both complete changed implementations, and traced recovery through `jobs.ts`, `processBatch`, and evidence application. The transfer fixture also gained the command `request` field. Read the earlier archive review for context.

2. **Pass: archive tests.** Ran `bun test src/surfaces/archive.test.ts src/server/transfer`. `archive-tests.log` ends with `41 pass`, `0 fail`, `2334 expect() calls`. These include the pending-report regression, ordinary round trip, refusal and rollback checks.

3. **Pass: regression test detects the original defect.** In the export only, removed the recovery import, comment, and `recoverAccepted(app)` call. Ran `bun test src/surfaces/archive.test.ts -t 'a report the original'`. `mutation.log` reports `0 pass`, `1 fail`, exit 1. The deciding mismatch is expected `verdict: "blocked"`, `pass: 1`, `unexplained: 1`, versus actual `verdict: "pending"`, `pass: 0`, `unexplained: 0`, with `reason: "pending: 1 report accepted and not yet applied"`. Restored the exact file and checked it with `cmp`; the archive suite passed afterward.

4. **Pass: independently constructed pending report over real HTTP.** Ran `TMPDIR=.../ship-r1/tmp bun ../archive-probe.ts`. It starts production servers through `withInstance`, on loopback ports assigned by the OS, and stops them afterward. The probe creates a case through HTTP, accepts a two-result report in the first transaction, exports through `/api/export`, and then explicitly applies the source report through `processBatch` in the second transaction. The pending archive imports through `/api/import` into a fresh server. Both servers use the same fixed clock so full equality checks include timestamps. `archive-probe.log` says `pending import: gate, both question lists, tests, result rows, question rows, signatures exactly equal to applied source`. The gate is `blocked`, with `pass: 1`, `unexplained: 1`, and `open: ["Q-2"]`. This compares open and decided inbox replies as well as stored results and questions. A second recovery says `recovery repeated: 0 applied; results 2`.

5. **Pass: archive without pending work.** The same script exports the source again after application and imports that archive into another fresh server. Evidence: `no-pending import: identical reads, results, questions, signatures, and batches`. It compares the same reads and stored rows, plus full batch rows.

6. **Pass: failed report application leaves no partial report effects.** The probe accepts two reports. To force a failure after the first result of the first report has been written, it changes the second staged result's `test` to `null` in the disposable source database, then exports normally. The archive imports with HTTP 200. Recovery logs `mainworthy: report 1 could not be applied and stays pending: null is not an Object. (evaluating '"case" in input.test')`. Assertions confirm that the failed batch, including staged text, is unchanged; its gate equals the source's pending gate; neither its first result nor its newly created test survives; the later batch is processed with both results; the original case remains; and foreign-key checks return no rows. Deciding line: `cannot-apply import: HTTP 200; broken batch and pending gate retained; 0 partial results or tests; later batch processed with 2 results; original case retained; foreign keys valid`. This verifies complete archive restoration plus atomic application per report, not rollback of the entire archive on an application failure. The first probe attempt used an unknown case instead; that follows the intentional per-result rejection path and did not force a transaction failure. I corrected the fixture rather than treating that as an application defect. Its output is retained in `archive-probe-first-attempt.log`.

7. **Pass: existing signature and text tests.** Ran `bun test src/core/signature.test.ts src/core/text.test.ts`. `signature-tests.log` ends with `79 pass`, `0 fail`, `733 expect() calls`.

8. **Pass for ordinary grouping; Unicode length caveat below: differential signature probe.** Ran `bun ../signature-probe.ts`, comparing the current function and hash with `490aaf5:src/core/signature.ts`, copied into scratch with only its hash import path adjusted. `signature-probe.log` reports `ordinary and BMP inputs: 1527 outputs and hashes identical; empty, whitespace, and 100000-character line included`. Inputs include numbers in assertions, volatile timeout durations, accented and CJK text, stack frames, and long frame paths. It reports `equal timeout pair stays equal; unequal assertion pair stays unequal`. Another 135 cases place emoji, musical symbols, Deseret letters, or U+10FFFF around cuts; those outputs were well formed and no longer than the old outputs. Differences in those cases occurred only when the old output contained a split character.

9. **Pass: types and lint on the clean export.** Ran `bunx tsc --noEmit`: exit 0, no diagnostics. Ran `bunx biome check src test bench`: exit 0, `Checked 129 files in 209ms. No fixes applied.` Logs are `tsc.log` and `biome.log`. These ran before adding scratch comparison code to the export. That comparison copy was subsequently moved outside the source tree; the archive mutation was restored.

## Clipping semantics and non-blocking findings

For positive integer limits, prefix `clip` removes a high surrogate at the right cut; suffix `clipEnd` skips a low surrogate at the left cut. Both measure UTF-16 units, not graphemes or display width. A sufficiently long limit returns the whole string. For well-formed input at a fixed positive limit, each result equals the old slice or is one unit shorter.

Both return empty text at zero. Prefix slice also does so, but `text.slice(-0)` returns the whole string, unlike `clipEnd(text, 0)`. At negative limits, prefix `clip` retains JavaScript's relative-end slicing and does not protect a split pair. For example, `clip("ab😀cd", -3)` returns `"ab\ud83d"`. Negative `clipEnd` returns empty text, unlike `slice(-max)`. These limits never occur in the changed signature calls: constants are positive, and the dynamic cause budget is at least 147 because a shortened frame is at most 150 units. The helpers assume well-formed input and do not repair arbitrary existing unpaired surrogates.

The literal claim that the final signature is *never longer than before* is false for a Unicode boundary. Reproducer in `signature-probe.ts`:

```ts
{
  message: "x".repeat(146) + " " + "a".repeat(200),
  detail: "at " + "p".repeat(200) + "😀" + "q".repeat(143) + ".ts:1"
}
```

The old frame suffix begins with half of the emoji. The new suffix removes it, freeing one unit for the cause. That extra cause unit also prevents `trimEnd()` from dropping the preceding space. The deciding output is `{"oldLength":299,"newLength":300,"oldWellFormed":false,"newWellFormed":true}`. This stays within the existing 300-unit bound and occurs in the expressly permitted class where old code split a character. It is not a blocker under the supplied criteria. For ordinary text, every intermediate value and therefore every resulting signature and grouping remains identical.

No blocking findings.

## Limits

This was a focused local review of the two changes, not the full application or the surrounding pull requests. I did not test the web UI, deployment, sustained concurrent imports, every archive data shape, or operating-system failure during commit. The failed-application fixture deliberately altered staged data after acceptance; I did not establish a normal valid API sequence that produces that malformed payload. The helper's negative-limit behavior is outside these signature call sites. I did not measure or make performance claims. All probe servers stopped, and their data directories were removed. The export and evidence remain under the requested review directory. No worktree release command was run.

PASS (no blockers)
