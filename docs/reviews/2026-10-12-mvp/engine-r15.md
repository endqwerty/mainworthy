# Mainworthy engine review, round 15

Revision: `46c9222b03b91bc7fa9d7c51204b7e0e14736ce8`.
Reviewer: Codex, GPT-6 Astra. Independent local QA of the specified revision.

Completed bounded re-check: the five original inputs are repaired. Two blocking defects remain on adjacent inputs, and combining old questions loses some displayed test evidence. This revision does not pass.

The fact to prove: accepted reports keep every affected run pending until application; relocating a commit preserves each cause, dispute, party, count and affected run without duplicate raises; authority satisfies every condition of the active clause. Waiting counters and stored verdicts must agree after retries and restart.

The named revision was exported with `git archive`. All work is confined to this review directory; the shared checkout is unchanged. This is a bounded re-check of round 14, not a repeat of the twelve checks.

## Round-14 findings

| Item | Status | What ran and deciding lines |
| --- | --- | --- |
| R14-B01 | fixed | Original script run twice exits 1 at the old `passed` assertion. It prints `runDuring:"pending", state:"open", outstanding:1`, then `runAfter:"blocked", outstanding:0`. Adapted assertions pass under loose, standard and strict; HTTP restart changes pending to blocked. See [positive log](logs/positive-r14-plan-during-accepted.log) and [HTTP](logs/positive-r14-findings-http.log). |
| R14-B02 | fixed with a new problem (R15-B02) | Original script run twice exits 1 because the closed case is now open, not decided. `closed:true, settled:"infra", gate:"blocked", slot:"disputed", destination.state:"open", hints:["disputed"]`. Adapted checks also pass for `mistaken` and both open/closed controls. [Log](logs/positive-r14-relocation-rule-dispute.log). |
| R14-B03 | fixed with a new problem (R15-B02, R15-N01) | Original script run twice exits 1 because 51 environments now apply successfully. Adapted 2/50/51/200-environment cases all have `first.ok:true, retry.ok:true, pending:0`; one question contains exactly that many targets. [Log](logs/positive-r14-relocation-many-answers.log). HTTP retry after restart returns 200 with `accepted:0`.  |
| R14-B04 | fixed with a new problem (R15-B01) | Original script run twice exits 1 at its old decided assertion. `admin-agent` now shows `you:"advice", after:"advised", gate:"blocked"`; `admin-not-producer` gives `after:"forbidden", gate:"blocked"`. Both adapted inputs pass in process and over HTTP. [Log](logs/positive-r14-policy-constraints.log), [HTTP](logs/positive-r14-policy-http.log). |
| R14-N01 | fixed | Original script run twice exits 1 because the stored verdict is now blocked. Adapted checks pass for all three presets with `stored:{verdict:"blocked",outstanding:0}, gate.stale:false`. [Log](logs/positive-r14-stale-waiting.log). |

## New findings

### R15-B02: relocation reads only the newest 200 questions and leaves an older dispute behind

Blocking gate and question-lifecycle defect. Reproduced twice using `bun scripts/r15-relocation-history-cap.mjs`, with only supported operations. [First log](logs/r15-relocation-history-cap.log), [repeat](logs/r15-relocation-history-cap-repeat.log).

Smallest tested boundary: two causes across 200 environments. Two agents disagree on case C-1 in the first environment. Answer that dispute with `infra` or `mistaken`, closing its planned run. Report a second distinct cause in 200 environments of the same commit and answer each with `infra`. The first pipeline report then places the commit in PR 7. The commit report applies successfully, but the older dispute is absent from the replacement questions.

The deciding lines for `infra` are `count:200, gate:{verdict:"blocked",open:[]}, oldQuestion.answer:"infra", outdated:200`. For `mistaken`, they are `count:200, gate:{verdict:"passed",open:[]}, oldQuestion.answer:"mistaken", outdated:200`. Only the second cause is asked about in PR 7. The older answer should also have ended, restoring the disputed evidence and leaving an answerable question. Both 199-environment controls do that correctly: `oldQuestion.answer:"outdated", outdated:200, gate.verdict:"blocked"`, with the new dispute in `gate.open`.

`askWhereCommitIs` gathers from `questionsOn(scope)`, whose `onRef` SQL in `src/server/decisions/questions.ts` limits the result to 200 rows before the caller filters for active failure questions. The oldest of these 201 active questions is never visited. Its answer is not ended and its run is not named by the replacement question. This contradicts the placement contract in decision 0012 and the round-15 requirement to end every old answer and re-ask every cause. It produces a blocked closed run with no answerable question, or a passed closed run still resting on the unended `mistaken` answer. Confirmed over real HTTP with two reader threads and after application restart: `infra` stays `blocked` with `open:[]`; `mistaken` stays `passed` with `open:[]`. An identical report retry returns the same receipt. [HTTP log](logs/r15-new-findings-http.log), [script](scripts/r15-new-findings-http.mjs).

### R15-B01: an author clause still skips the condition that excludes evidence producers

Blocking policy defect. The original admin combinations in R14-B04 are repaired, but `standingOf` returns early for `who:"author"` before enforcing `notProducer`. The role exception lets an administrator stand in for an author; it does not explain the non-admin self-approval below.

Smallest reproduction: `bun scripts/r15-author-proposal.mjs`. Adopt a custom policy with `adopt-any` and `adopt-agent` asking `{who:"author", agents:"answer", notProducer:true}`. A human or agent with only `read,produce,answer` proposes a new case, reads the displayed requirement, then accepts their own proposal. Output for both: `admin:false, needs:"the author of the proposal who did not produce the evidence", you:"counts", reply:"decided", currentCases:1`. [Log](logs/r15-author-proposal.log).

The failure also occurs on a dispute when a human administrator produced its failing evidence. Change its clause to `{who:"author", agents:"none", notProducer:true}`. The previously forbidden answer becomes `decided` and the disputed run becomes `passed`. Reproduced twice using `bun scripts/r15-author-not-producer.mjs`, whose correct-behavior assertion fails. [First log](logs/r15-author-not-producer.log), [repeat](logs/r15-author-not-producer-repeat.log).

This contradicts the `Ask.notProducer` contract in `src/core/kinds.ts` (an evidence producer may not settle it), the displayed requirement, and the round-15 claim that a clause satisfies all its conditions. The relevant early returns are in `standingOf`, lines 314–320. No database mutation is used in either reproduction. The 864-case operation matrix covers all four `who` values, all three agent modes, both producer restrictions, people/agents/pipelines, admin/member actors, producers/non-producers, and answers/changed answers/withdrawals. It confirms nine mismatches, all this same author-condition defect, with zero fixture errors. The other 855 cases match the independent expectations. [Matrix](logs/r15-authority-matrix.log), [all observations](logs/r15-authority-all.json). The unchanged preset matrix passes all 312 cases, 104 per preset. [Preset log](logs/r13-authority-matrix.log). Confirmed over real HTTP with two reader threads for both non-admin human and agent authors: `answer:"decided", casesAfterRestart:1`. [HTTP log](logs/r15-new-findings-http.log). The proposal reproduction also passed its defect assertions on a second clean run. [Repeat](logs/r15-author-proposal-repeat.log).

### R15-N01: combining old questions drops distinct tests from the new question

Nonblocking evidence-display defect, reproduced twice with `bun scripts/r15-relocation-disjoint-count.mjs`. An agent reports test A failing in environment one and test B failing with the same cause in environment two; answer each question with `infra`. Place the commit with the first pipeline report. The new question names both targets, but shows only test B and `count:1`, although two distinct tests failed. [First log](logs/r15-relocation-disjoint-count.log), [repeat](logs/r15-relocation-disjoint-count-repeat.log).

Deciding line: `before:[{count:1,tests:["T-1"]},{count:1,tests:["T-2"]}], actualDistinctTests:2, after:{count:1,tests:["T-2"],targets:[2,1]}`. The same loss occurs for 40+40 and 60+60 disjoint tests. In the new two-pass `askWhereCommitIs`, each cause retains only the first encountered question's `seen.tests`; the count is the maximum across questions, and those tests are reused for every target. The union is never built. As a control, restoring only the previous `askWhereCommitIs` implementation in this export preserves both tests and gives `count:2` for the two-test input; the defective-count assertion then fails. [Old-function control](logs/r15-disjoint-count-old-function.log). The source was restored afterward. This contradicts the question's displayed failing-test count and the requirement to preserve the cause's evidence while asking again. No false public gate or incorrect standing decision was established from this display loss, so it is not counted as a blocker.

## Required checks

Mixed relocation cases pass in 14 variants: 2/4/200 environments, `infra` and `mistaken` answers, shared causes on decided and open questions, some environments answered and others open, a dispute in only one environment, two distinct causes, and counts of 1/51/501 with samples capped at 50. All targets, affected run references and dispute parties survive relocation; the second cause stays undisputed. [Log](logs/r15-relocation-mixed.log). This passing history has fewer than 200 old questions; the separate R15-B02 boundary has 201.

All five added tests pass on the revision and fail with their own fix removed in the isolated export. B01 gets `Expected:"pending", Received:"passed"`; B02 has no open dispute question; B03 reaches `one command raised the question "same cause" 51 times for one target: stopped`; B04 gets `Expected:"forbidden", Received:"counts"`; N01 leaves `verdict:"pending"` instead of `blocked`. [Mutation results](logs/mutations-summary.json), [mutation script](scripts/r15-mutations.py). Every mutation was restored; the source hash comparison after these runs reported `changed:[]`.

The retained 60-seed reviewer probe ran twice, each time reporting `checked:7200, problems:0, staleProjections:0`. Its original round-14 stale projections are gone. [First](logs/r14-state-extended-1.log), [repeat](logs/r14-state-extended-2.log).

B01 adjacent HTTP check passes: three presets, fifteen full application restarts, 201 state observations, and five simultaneously accepted reports spanning environments, repositories, commits and projects. Includes plans before and after partial application, repeated failures, out-of-order application and identical retries. Every expected waiting count matches, all counters finish at zero, and stored/public verdicts agree. [Script](scripts/r15-b01-restart.mjs), [log](logs/r15-b01-restart.log). A preliminary fixture expected `stale:true` merely because a newly planned run was pending; that expectation was wrong and was removed. A freshly folded pending projection is not stale.

Author suite: `625 pass`, `1 fail`, `16920 expect() calls`, `Ran 626 tests across 29 files`. The sole failure is the on-disk budget test rejecting the brief-mandated `/tmp` path on tmpfs before any measurement. No performance verdict is claimed. `bunx tsc --noEmit` exits 0; `bunx biome check src test bench` exits 0, `Checked 187 files ... No fixes applied.` [Summary](logs/author-checks-summary.log). Test ports and the budget data path were temporarily adapted in the export, then restored.

Larger sequence runs each pass: 300 seeds per preset, `3 pass, 0 fail` (900 histories), and 150 extended seeds per preset, `3 pass, 0 fail` (450 histories). [Ordinary](logs/sequences-300.log), [extended](logs/sequences-extended-150.log).

The original 16 `r14-*.mjs` scripts were run twice. Both runs agree on every exit status. [Complete exit/log summary](logs/r14-summary.json). Reproductions intentionally stop at their repaired old assertion; adapted copies assert correct behavior through every original branch, with ports changed to 8900–8949. [Adapted script results](logs/positive-summary.json).

The retained `r14-custom-authority-diagnostic` script fails on its old `rule-permitted` expectation (`passed` instead of `failed`), exactly as its stored round-14 log does. The corrected nine-case `r14-custom-authority` control passes twice; this diagnostic mismatch is not a new defect. The other positive retained scripts pass twice, including placement lifecycle, waiting horizon, full commit identity, authority oracle and the HTTP positive bundle. The complete exit summary above distinguishes these from defect-asserting scripts.

## Limits

This review does not repeat the previous twelve checks. It covers the five round-14 fixes and the adjacent cases in ENGINE-R15.md. No performance or browser verdict is claimed. The required suite's on-disk budget check could not run on the mandated tmpfs data directory; it is not counted as a pass. No production, deployment, CLI/MCP feature review, transfer review, or previously deferred contract is included. The report does not certify those areas.

One HTTP setup attempt used the nonexistent `cases` operation while trying to read a created case; it was corrected to the registry's `get` operation before the HTTP confirmations above. [Setup error](logs/r15-new-findings-http-fixture-error.log). The B01 check also corrected its unsupported assumption that all pending projections must be stale. Neither setup error is product evidence.

[Export integrity](logs/export-integrity.json) compares all archived files with their initial hashes after all temporary source/test mutations were restored. [Cleanup](logs/cleanup.json) records removal of review-owned dependencies and `/tmp` data. The export, scripts, logs and this report remain available. Reinstall with `bun install --frozen-lockfile` inside `tree` before rerunning the scripts. No shared-checkout files were changed or cleaned.

ISSUES (2 blockers)
