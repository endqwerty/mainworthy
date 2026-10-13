# Mainworthy engine review, round 16

Revision: `a374026c88914701cb9ef09d73b05d62c70dc603`.
Baseline: `46c9222b03b91bc7fa9d7c51204b7e0e14736ce8`.
Reviewer: Codex, GPT-6 Astra. Independent local QA. No other agents were started.

The three fixes hold on the tested inputs, and the three speed changes preserve the compared application results. No blocking application-logic defect was found. One nonblocking regression-test gap is recorded below.

The fact to prove was that every active policy condition holds, placement reaches every old question and preserves its named tests, and the speed changes preserve queue items, stored run state, and gates. Both revisions were exported with `git archive`; all commands ran in the review directory. The [scoped diff](logs/scope.diff) was read directly. This review did not edit or clean the shared repository.

## Scoped results

| Item | Status | What ran and deciding lines |
| --- | --- | --- |
| R15-B01 | Fixed | The original administrator reproduction twice prints `you:"forbidden", after:"forbidden", gate:"blocked"`. The positive proposal reproduction checks human and agent authors: `reply:"forbidden", currentCases:0`. The operation matrix passes all 864 combinations on both runs, covering `who`, `agents`, `notProducer`, actor type, administrator status, producer status, answers, changed answers, and withdrawals. An additional 72-case matrix covers actual proposal authors. The unchanged preset matrix passes 312 cases, 104 per preset. [Original](logs/r15-author-not-producer-1.log), [proposal](logs/r16-author-proposal.log), [864 cases](logs/r15-authority-matrix-1.log), [72 authors](logs/r16-proposal-author-matrix.log), [presets](logs/r13-authority-matrix.log). |
| R15-B02 | Fixed | Placement passes with 201, 500, and 2,000 old questions, for both `infra` and `mistaken`. The largest cases print `outdated:2000`, `display:200`, `calculation:2000`, `oldEnded:true`, and `newDispute:true`. The old closed run is blocked and names the replacement dispute. The capped reader returns exactly the newest 200 rows of the uncapped reader. [201/500](logs/r16-placement-boundaries-corrected.log), [2,000](logs/r16-placement-2000.log), [script](scripts/r16-placement-boundaries.mjs). |
| R15-N01 | Fixed; regression-test gap below | Six positive cases cover overlapping tests, disjoint tests, and histories whose samples were already truncated. Examples: `namedUnion:80, newCount:80, sample:50`; `oldCounts:[100,100], namedUnion:50, newCount:100`. The two-test reproduction now keeps both names and reports 2. Additional placement checks preserve a pipeline test's `counted` flag when it overlaps an agent test or is distinct. A later pipeline correction dissolves the question and leaves its gate passed. [Union cases](logs/r16-evidence-union-corrected.log), [script](scripts/r16-evidence-union.mjs), [counted evidence](logs/r16-placement-counted-evidence.log). |
| `disputedSlots` | Equivalent on tested inputs | Ran the exact old and new SQL against one database with two projects, 36 constructed planned slots, open and closed runs, closed tallies with and without disputes, non-disputed controls, multiple causes sharing a slot, and change runs without slots. All 15 project/signature comparisons match, including missing values. `problems:0`. Old plan starts with `SEARCH r USING INDEX runs_open (project=?)`; new plan starts with `SCAN s USING INDEX slots_disputed`, then the run's primary key. [Script](scripts/r16-disputed-slots.mjs), [results](logs/r16-disputed-slots-corrected.log), [exact SQL and plans](logs/disputed-plans.json). |
| `toItemFor` | Equivalent on tested inputs | Compared current items with baseline `{...toItem(row), you:mayAnswer(row)}`, and current inbox pages with baseline inbox pages, on the same database. `itemComparisons:248, pageComparisons:784, problems:0`. Every kind is both open and decided under all three presets and a custom policy. Includes open and decided disputes, ordinary failures, advice, owner/member/agent/pipeline readers, cursors, and reference-filtered pages. Plain `toItem` also matches. [Script](scripts/r16-inbox-equivalence.mjs), [results](logs/r16-inbox-equivalence-final.log). |
| `dissolveStale` / `dissolve` | Equivalent on tested inputs | Ran the same operations on both revisions. `stateComparisons:51, gateComparisons:267, scenarios:15, problems:0`. Compared complete question rows, decision rows, run rows, dependency rows, and gates. Cases cover one run waiting for many questions, many runs waiting for one, partial closure, older plans still waiting after a newer commit passes, sign-off, and retries under every preset. Closed questions disappear from stored blocking lists; remaining open failures still block. Separately, `closeIfGone` after withdrawal updates the stored lists immediately and matches baseline under all presets. [Script](scripts/r16-dissolve-equivalence.mjs), [results](logs/r16-dissolve-equivalence-corrected.log), [withdrawal](logs/r16-close-if-gone.log). |

The repaired author and placement cases also pass over real HTTP with two reader threads and full application restarts. Human and agent self-approval stays forbidden, with no case created. Both 201-question placement histories remain blocked with the answerable old dispute after restart, and identical retries return the original receipt. [HTTP log](logs/r16-fixed-http.log), [script](scripts/r16-fixed-http.mjs).

## Retained round-15 reproductions

All eight `r15-*.mjs` scripts ran twice with their assertions unchanged. Only their data directory moved under this round's `data/`. The two runs agree on every exit status. A failure at an assertion of the former defect is expected when that defect is fixed. Positive copies reach the later branches where those old assertions stop the original script. [Complete run summary](logs/retained-summary.json).

| Script | Both exits | Deciding result |
| --- | --- | --- |
| `r15-author-not-producer.mjs` | 0 | `after:"forbidden", gate:"blocked"`. |
| `r15-author-proposal.mjs` | 1 | `you:"forbidden", reply:"forbidden", currentCases:0`, rather than the old expected self-approval. The positive copy also checks the agent. |
| `r15-authority-matrix.mjs` | 0 | `checked:864, failures:0, fixtureErrors:0`. |
| `r15-b01-restart.mjs` | 0 | `presets:3, restarts:15, checks:201, outstanding:0, problems:0`. |
| `r15-new-findings-http.mjs` | 1 | First self-approval assertion receives `forbidden`, not its old expected `decided`. The positive HTTP copy completes both author types and both placement answers. |
| `r15-relocation-disjoint-count.mjs` | 1 | First case reports `count:2` with both tests, not the old expected 1. The positive union probe completes the larger cases. |
| `r15-relocation-history-cap.mjs` | 1 | The 200-environment case ends 201 old answers and re-asks the oldest dispute, contrary to its old defect assertions. |
| `r15-relocation-mixed.mjs` | 0 | `checked:14, failures:[]`; targets, tests, dispute parties, and run references survive. |

## New findings in scope

### R16-N01: the combined placement test does not detect removal of the test-union fix

Nonblocking regression-test gap at `test/integrity.test.ts:1518`. The test reports all 205 environments before answering their failure questions. Its first question has already accumulated both test names, `b` and `c`. The old implementation can retain that one question's sample and still satisfy the new assertions.

Smallest distinguishing input: report test A failing in environment one, answer it with `infra`, then report test B with the same cause in environment two and answer it. Place the commit with its first pipeline report. The current revision preserves both tests and reports 2. Without the union fix it retains one and reports 1.

To confirm the mutation, only the baseline `askWhereCommitIs` body was restored in the export, retaining the new uncapped `everyQuestionOn` read. On two repeated comparisons, the repository test gives `1 pass, 0 fail`, while the reviewer probe on that same mutated source fails with `1 !== 2`. Restoring the target source makes the reviewer probe pass. [Mutation script](scripts/r16-mutation-confirmation.py), [author test, repeat](logs/mutation-union-author-test-2.log), [reviewer probe, repeat](logs/mutation-union-reviewer-probe-2.log), [restored probe](logs/restored-union-probe.log).

This misses the requested regression property that removing the fix makes its test fail. It does not block this revision: the implementation passes the independent distinguishing input and adjacent cases. Answer each environment inside the test's report loop, or add the two-environment reproduction as a separate test, so a future removal is caught. No repository change was made here.

## Required checks and mutations

| Check | Result and deciding lines |
| --- | --- |
| `bun test src test --path-ignore-patterns 'test/e2e/**'` | Pass. `628 pass`, `0 fail`, `17216 expect() calls`, 29 files. Includes the on-disk budget test. [Log](logs/author-tests.log). |
| `bunx tsc --noEmit` | Pass, exit 0. [Log](logs/typecheck.log). |
| `bunx biome check src test bench` | Pass. `Checked 188 files ... No fixes applied.` [Log](logs/lint.log). |
| `MAINWORTHY_SEQUENCE_SEEDS=300 bun test test/sequences.test.ts` | Pass. `3 pass, 0 fail`, 300 histories per preset. [Log](logs/sequences-300.log). |
| `MAINWORTHY_SEQUENCE_SEEDS=150 bun test test/sequences-extended.test.ts` | Pass. `3 pass, 0 fail`, 150 extended histories per preset. [Log](logs/sequences-extended-150.log). |
| Retained `r14-state-extended` probe | Pass. `seeds:60, checked:7200, problems:0, staleProjections:0`. [Log](logs/r14-state-extended.log). |
| Remove author restriction | Detected by the new policy assertions. `Expected: "forbidden", Received: "counts"`. [Log](logs/mutation-author-condition.log). |
| Restore capped placement read | Detected by the new integrity test. Expected no active old infra decisions; received `n:6`. [Log](logs/mutation-placement-cap.log). |
| Remove test-union fix | Not detected by the repository test. Detected twice by the reviewer probe, as R16-N01 explains. |
| Restore per-question recomputation | Detected by the new budget test. `Expected: < 12, Received: 302`. [Log](logs/mutation-dissolve-batching.log). |
| Restore target source | All three affected repository tests pass: `3 pass, 0 fail`. The six-case union probe passes too. [Tests](logs/restored-targeted-tests.log), [probe](logs/restored-union-probe.log). |

Test ports and the budget data path were temporarily adapted only in the export to obey the brief. All server ports stayed within 8900–8949. File-backed data used `data/` on btrfs, including `TMPDIR`; the budget test did not use a memory filesystem. Type-checking and lint ran after the adaptations were restored. [Check runner](scripts/run-checks.py).

Fixture corrections are not product findings. They corrected a guessed scope-reference prefix, Bun's SQL parameter-key convention, a too-short commit string, and an assumption that different tests without files create separate map questions. An optional mixed-evidence setup had already placed its commit with an earlier pipeline report; a first-placement fixture replaced it. The original 2,000-question setup was stopped during construction; the completed replacement answers each environment as it arrives. It still creates 2,000 active old questions and tests both old answers. The original completed 201/500 cases remain in their log.

## Outside the scope

No additional finding was identified outside the scope.

## Limits and retained artifacts

This round does not repeat the twelve checks. It covers the three round-15 items, the three speed changes, and adjacent behavior specified in ENGINE-R16.md. It does not include the full-size benchmark or a separate browser, production, or deployment review. No measured speedup is claimed. Finite old/new comparisons establish equivalence for the recorded inputs, not every possible history.

Failure questions still show at most 50 tests. When old questions already held truncated samples, the combined count preserves the largest prior count and the union of the named samples; it is not necessarily the exact distinct total of all underlying results. For example, two disjoint 60-test histories retain a count of 100 and show 50. The review treats this as the stated sampled-evidence contract, not a claim that all 120 underlying tests were enumerated.

All 414 archived files match their initial hashes after the mutations and temporary test adaptations: `changed:[]`. [Export integrity](logs/export-integrity.json). Review servers have stopped; the process audit has no remaining review processes. [Process audit](logs/process-audit.json). The exported sources, scripts, logs, and this report are retained. Cleanup removes only this round's installed dependencies and disposable data; reinstall with `bun install --frozen-lockfile` in `tree/` and `baseline/` before rerunning comparisons. [Cleanup record](logs/cleanup.json).

PASS (no blockers)
