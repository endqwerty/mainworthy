# Mainworthy engine verification, round 7

Revision: `bdda0b1ba6eaec54b5778684559d8192cb19a0f6`, branch `t3/mvp-product-delivery`.

Verifier: Codex, GPT-6 Astra. Independent of engine author Claude Opus 5.5. The reader threads were authored by Codex, so their functional checks below do not supply a different-provider verdict for that subsystem. No other agents were started.

Two blocking defects and two non-blocking findings are confirmed. The four original round-6 blockers are fixed in their original reproductions. The inherited-failure mechanism still has two distinct ways to report a passing gate without the supporting base evidence.

The correctness claim is that gates count exactly the admissible evidence, and every standing change follows an authorized recorded decision whose hold still applies. A current failing run must either have a covering decision or an answerable question. A correction or decision replacement must update every dependent run, and historical commit gates must remain exact.

All execution used a clean `git archive` export in `engine-r7/tree`, with `bun install --frozen-lockfile` on Bun 1.4.3. All 404 tracked files still matched a fresh archive after the temporary test mutations (`logs/export-integrity.json`). The shared repository was not edited and no Git command changed its state. Commands below run from `engine-r7`, unless they explicitly name `tree`. After dependency release, install again in `tree` before running the scripts.

## Twelve checks

The verdicts describe each check within its stated scope. They do not approve the engine as a whole.

| # | Check | Verdict | What ran and deciding evidence |
| --- | --- | --- | --- |
| 1 | Author tests and architecture | pass in scope | `python scripts/author-checks.py` ran `bun test src test --path-ignore-patterns 'test/e2e/**'`, `bunx tsc --noEmit`, and `bunx biome check src test bench`. Results: `581 pass`, `1 fail`, `16603 expect() calls`, `582 tests across 28 files`; tsc exit 0; Biome `Checked 178 files ... No fixes applied`. The sole failure was the excluded disk-budget test refusing mandated `/tmp` because it is tmpfs. Each requested architecture mutation failed its intended check; a structural Witness was instead rejected by tsc for missing private fields. `architecture-summary.log`, `architecture-additional-summary.log`, `architecture-last-summary.log`. Source restored. Test-strength limits are below. |
| 2 | Standing and witnesses | pass | [STANDING.md](STANDING.md) lists every scoped standing statement, its call path and the four documented exceptions. `standing`, `probes`, `round3`, `support`, and `ledger-fk` reject plain, prototype, reflective and wrong-kind witnesses, a second mint, and reseeding. Seven decision references reject missing ledger rows; `foreignKeyViolations:[]`. Undo preserves newer links/signoffs/excuses and independent producer corrections. `fixed-r7.mjs` restores mistaken results in three runs, including one planned later. B01/B02 concern incorrect or stale authority from valid decisions, not a writer without a ledger entry. |
| 3 | Idempotency and atomicity | pass | `probes.mjs`: `firstSeq:2,retrySeq:2`, operation/actor/project reuse conflicts, `lateRollbackUnchanged:true`; 150 distinct events numbered 2 through 151 and `failedCommandsConsumeSeq:false`. `new-probes.mjs` records the secret-bearing reply as a refusal marker and leaves `tokens:1`; instance commands replay. The live report/restart checks lose or duplicate no writes. `rerun-probes.log`, `rerun-new-probes.log`, `rerun-live.log`. |
| 4 | Non-overwriting edits | pass | `probes`, `policy-supplements` and author suite tests exercise disjoint stale-field merge, same-field conflict, delayed adoption, conflict resolution after more work, author/adopt policy, restore, tag deltas and folder cycles. Deciding outputs include `differentField: merged preserving human pre`, `sameField: conflict`, `restoreVersion:5,versions:5`, delayed tags `[agent,human]`, multi-case/policy resolution `forbidden`, and cycle refusal. Neither side of a conflict is dropped. |
| 5 | Evidence provenance and inputs | pass | `probes`, `new-probes`, `round3`, `final-probes`: exact/assumed/unresolved basis each exercised; invalid case claims rejected, automated claims retained with no case and `declined`, `slotFills:0`, declined failures still block. Human/CI/agent methods are human+auto / auto+auto / agent+agent. Foreign refs and other-producer/target corrections refused. A 100,000-result report yields `rows:100000,batches:1,retryFresh:false`. Empty reports/keys and unpaired surrogates rejected; clipped emoji stays well formed. `lane-matrix.mjs`: `sequences:4500,observations:13500,commitAndSlotAgree:true`. |
| 6 | Questions, holds and ledger | issues | `lifecycle`: `failedResults:500,questions:1`; held answers carry, evidence/target changes conflict, expiry leaves a linked `expired` row, rule decisions name their clause, and a person's withdrawal is not silently reanswered. `lifecycle-positive`: six environment orders, 36 answer decisions, no extra questions. B01 applies inherited authority to a commit for which its fact is false. B02 keeps that authority after the base result is corrected. N01 leaves an answered target in the open queue when question bases differ. Existing clock-expiry and supersession chains pass. |
| 7 | Gate soundness | issues | Verdict priority, unknown/no-proof/skips/refused-only/agent-only pending, separate producer/job lanes, equal/older attempts, forward-only change heads, and pending before expiry sweep all pass. Live large uploads produced 340 reads at the accepted sequence, all pending. Two real kill/restart cycles recovered exactly 100,001 results, with no duplicate on replay. B01 and B02 give false passing gates. B01 also closes an open planned run on that false pass. |
| 8 | Runs and slots | issues | Admission by target, basis, method and pinned version passes. Human-only slots reject tests; agents require explicit admission. Multiple causes and tests remain counted; disputes survive later writes; one result fills multiple runs. Closed-run reports are refused and corrections preserve closed snapshots. R6-B02 and B04 are fixed both through invoke and HTTP: later plans inherit mistaken judgments, withdrawal restores them, stale signoff conflicts, and signoff is asked again after a valid correction. B01 still marks a planned run passed and closes it without valid inherited evidence. |
| 9 | Policy and authorization | pass for current policy | `policy-matrix.mjs` exercised all 15 operations and all answers for agent, CI and reader under all three presets: `total:324,probeErrors:0`, with each clause matched. Supplements cover applicable mistaken answers, conflict authorship, agent self-adoption and basis options. Advice writes no decision; CI cannot decide; readers cannot write. Live tokens remain project-scoped for operations/events/session lists; forgotten tokens and established streams stop working. N02 is a departure-4 wording mismatch: after an administrator switches to loose, withdrawal follows that current policy rather than the original decision's policy. |
| 10 | HTTP | pass | `live` and `checkpoint-live` use real local listeners. Local Origin absent/same = 200; foreign/null/other scheme/Host = 401. Server session/events and all 15 operations = 401 without a token. All registry operations have routes and OpenAPI entries. Cookie is HttpOnly/SameSite=Strict and rejected from another origin. Other-project operations/events = 403. Sized and chunked 65 MiB bodies return actual 413; the next ordinary request returns 200. Public-route checks agree with `serve()`. |
| 11 | Concurrency and readers | pass functionally | Each 100,000-result upload preserved 40 concurrent case writes, 41 distinct command sequences and 42 contiguous events while reads completed. `readers-live`: 128 read-after-write observations; all nine read operations agree inline/worker across 27 replies including ten refusals; denied reads never dispatched; worker writes refused; 80 requests survive a killed worker; `allWorkerExitsAwaited:true,remaining:0`. Twelve reads after forgetting contain only the pseudonym. Checkpoint test: 610 commits while present, 80 after termination, 690 persisted across restart. Inline=0 works; default for 16 cores is 8. No performance verdict or different-provider claim for the reader authorship. |
| 12 | Documented departures | issues | Every numbered departure is assessed below. B01/B02 contradict inherited holds and exact gate promises; N01 contradicts the one-answer queue promise; N02 contradicts the description of withdrawal policy. Browser draft storage and archive correctness are outside scope and explicitly not checked. The listed cuts themselves are not defects. |

The author-test runner temporarily assigned listeners to ports 7950 through 7999 and budget data to `/tmp/mainworthy-engine-r7-budgets`, then restored the files. No other out-of-scope compile or test failure occurred. The 600-seed author sequence run was also executed from `tree`: `MAINWORTHY_SEQUENCE_SEEDS=600 bun test test/sequences.test.ts`, giving `2 pass, 0 fail`, 600 sequences under loose and 600 under standard, 96,000 audited steps. Its invariants do not establish that a stored excuse is justified by the base's effective evidence.

## Status of round 6

The original defect scripts assert the old bad outcomes. Their assertion failures below are expected on a fixed revision. Positive replacements (`fixed-r7.mjs`, `fixed-question-missing-from-gate.mjs`) and HTTP checks (`fixed-r6-http.mjs`) then verify the complete new behavior.

| Finding | Status | What this revision prints |
| --- | --- | --- |
| R6-B01 | fixed with a new problem | `inherited-limit.mjs` fails the old passed assertion with actual `blocked`. Positive and HTTP checks show 501 unexplained failures and no inherited decision. R7-B01/B02 are distinct inherited-scope and invalidation failures. |
| R6-B02 | fixed | `mistaken-later-plan.mjs` fails the old blocked assertion with actual `passed`. Commit and both plans pass over HTTP. The stronger positive check discounts two existing open runs and a later plan, then restores all three on withdrawal. |
| R6-B03 | fixed | `replace-targeted-answer.mjs` fails the old passed assertion with actual `failed`. Both gates fail immediately; ledger is `infra,infra,outdated,defect`; retry receipt says defect. The older R5 overlap script must now answer the still-current broad question because the old narrower question has been ended. |
| R6-B04 | fixed | `signoff-stale.mjs` reaches no current signoff and fails its obsolete property access. Positive checks assert the stale approval conflicts and run stays open; correcting the failure opens a new signoff that can close it. HTTP confirms `conflict`. |
| R6-N01 | fixed | The old script expects a second run's empty open list and gets length 1. Both gates now list `Q-4`, which names both runs. |
| Stored-tally mismatch from R6 sequences | fixed in the rerun | All four original audits enabled: `seeds:200,steps:20000,checked:20000,problems:0`. The separate original remaining audit gives `60` seeds, `9000` checked steps and `0` problems. Its two previously disabled assertions remain disabled and are not claimed as evidence from that run. |
| Actor-label cache | fixed in functional checks | Live reader test performs 12 reads before and 12 after forgetting; old name absent afterward, token returns 401. The author HTTP tests exercise inline and pooled connections too. |

## Earlier reproductions

`rerun-all.py` ran the prior in-process and live scripts before the new twelve-check work. `rerun-r6.py` ran the fixed copies and the five R6 reproductions. Logs are `rerun-*.log`, `rerun-summary.log`, and `rerun-r6-summary.log`. The old standalone `findings-http.mjs` stops at its now-wrong R6-B01 passed assertion; `fixed-r6-http.mjs` reruns all four over HTTP with the corrected expectations.

`new-probes.mjs` exits 1 because two old fixtures try reserved automated `case:1` keys. `round3.mjs` verifies the intended rejection and lack of writes. `closed-question.mjs` now receives `Q-7` instead of an empty open list; `fixed-closed-question.mjs` checks that result. `fixed-overlap-stale-gate.mjs` now gets conflict on the older infra question, because the later broad flaky answer ended it. `fixed-r7.mjs` verifies that answering the current question changes both gates immediately. These method/expectation changes are not new defects.

| Round-5 finding | Status | Deciding result |
| --- | --- | --- |
| R5-B01 | fixed | Replacement question `Q-4` exists and answering it passes. `rerun-fixed-dissolved-target-lost.log`. |
| R5-B02 | fixed | Reopened run names `Q-5`, the question names it, and answering passes. `rerun-fixed-reopen-lost-question.log`. |
| R5-B03 | fixed | Current broad answer can be replaced; both commit gates immediately fail. Old narrower question is correctly refused after replacement. `fixed-r7.log`. |
| R5-B04 | fixed | Commit, existing plan and later plan pass; correction attempt becomes 3. `rerun-fixed-correction-history.log`. |
| R5-B05 | fixed with a new problem | Split and combined reports each have two unexplained failures and no decision. R7-B01 concerns results split across different commits. |
| R5-B06 | fixed | A new failure opens `Q-3`; the originally mistaken result stays discounted, including in a later plan. |
| R5-B07 | fixed | Under unchanged strict policy, producer withdrawal is forbidden, no-reason withdrawal invalid, and the gate remains failed. N02 records what changes after policy switches. |
| R5-N01 | fixed | Kind filter returns no failures; one-item pages return all four refs. |

| Earlier finding | Status from current rerun |
| --- | --- |
| R1-B01 | fixed: multi-case/policy conflict resolution forbidden; unrelated case and policy preserved. |
| R1-B02 | fixed: per-result methods follow actor kind; an agent cannot count as automation. |
| R1-B03 | fixed: naming a run does not admit a different target. |
| R1-B04 | fixed: skipped/refused-only evidence cannot clear a failure or create proof. |
| R1-B05 | fixed: an older commit retry does not move the change head back. |
| R1-B06 | fixed: older and equal attempts preserve the failure; longer correction histories now agree too. |
| R1-B07 | fixed: other-target correction refused and closed snapshots preserved. |
| R1-B08 | fixed: original target scope and broad/target replacement pass. `fixed-r7.log`, broad-answer scenario. |
| R1-B09 | fixed: scoped operations/events/session and forgotten-token checks pass over HTTP. |
| R1-B10 | fixed: delayed adoption preserves newer fields and tags. |
| R1-B11 | fixed: folder cycle refused. |
| R1-B12 | fixed: repository PR keys, commit gates and planned-run causes remain separate. |
| R1-B13 | fixed: slot methods read the pinned version. |
| R1-B14 | fixed: mismatched manual annotation rejected without relinking. |
| R1-B15 | fixed: invalid runtime and structural witnesses refused. |
| R1-B16 | fixed: undo of old mapping preserves newer link. |
| R1-B17 | fixed: bulk cursor returns 200 then 100; interleaved pages see all 300. |
| R1-B18 | fixed: operation/actor/project command reuse conflicts; secret-bearing replay is withheld and writes no second token. |
| R1-B19 | fixed: processed jobs fill existing and subsequently planned runs. |
| R1-N01 | fixed: expiry is a ledger row in the supersedes chain. |
| R1-N02 | fixed: other origin scheme returns 401. |
| R1-N03 | fixed: documented public-route contract matches live responses. |
| R1-N04 | fixed: empty/whitespace test keys refused. |
| R2-B01 | fixed: reflective construction, prototype object and second mint refused. |
| R2-B02 | fixed: agent-only commit pending; agent pass cannot clear pipeline failure. |
| R2-B03 | fixed: deciding one of two causes leaves the slot blocked by the other. |
| R2-B04 | fixed: later skip retains disputed slot. |
| R2-B05 | fixed: repository-qualified gate/impact/planning agree; cross-repository evidence remains separately classified. |
| R2-B06 | fixed: reserved automated case key refused before writing. |
| R2-B07 | fixed: passing subset plan does not dissolve another failure's question. |
| R2-B08 | fixed: infra for production does not cover staging, which is asked again. |
| R2-B09 | fixed: filtered search finds C-301. |
| R2-N01 | fixed: full and unambiguous prefix commit reads both environments. |
| R2-N02 | fixed: denied read returns 403 before worker dispatch. |
| R3-B01 | fixed: corrected result stays replaced in existing and future plans, including longer histories. |
| R3-B02 | fixed: another job/environment's pass cannot replace a failing lane. |
| R3-B03 | fixed: new plan over existing failure joins its question and responds to its answer. |
| R3-B04 | fixed: trunk scopes include repository; planned causes classify separately. |
| R3-B05 | fixed: ingest expiry writes one expired row and later sweep adds none. |
| R3-B06 | fixed: mistaken undo preserves a subsequent producer correction. |
| R3-B07 | fixed: strict map/create refused atomically, with instructions to propose/adopt/link. |
| R3-B08 | fixed: newer target changes the hash and the saved answer conflicts; stale signoff also conflicts in `fixed-r7.log`. |
| R3-B09 | fixed: established stream closes after forgetting; new request returns 401. |
| R3-B10 | fixed: agent result on base does not justify inherited for CI head. |
| R3-B11 | fixed: another repository's trunk cannot justify inherited. |
| R3-T01 | fixed: removing witness-kind rejection fails the named author test and independent probe. |
| R3-T02 | fixed: secret replay test actually counts one token row. |
| R3-N01 | fixed: reader default is cores minus two clamped 1..8; explicit 0 works inline. |
| R4-B01 | fixed with a new problem: corrected-base and late-trunk-fallback reproductions stay blocked. R7-B02 corrects the base after the inherited decision; R7-B01 applies the decision to another commit. |
| R4-B02 | fixed: plan over repositories a and b stays blocked after only a is excused. |
| R4-B03 | fixed: same-attempt pass after fail keeps commit and planned gate blocked. |
| R4-B04 | fixed: pipeline pass retains agent-run question and it remains answerable. |
| R4-B05 | fixed: separate infrastructure answers carry and withdraw independently; broad replacement now ends the narrower answer and retallies its runs. |
| R4-B06 | fixed: both answer-replacement producer probes forbidden; round-5 withdrawal variants now refused too. |
| R4-T01 | fixed: answer-key mutation fails; replay/bulk tests count stored entities; body-limit test reads actual socket status; restart test kills and restarts a process. |
| R4-N01 | fixed: slice constant and current documentation say 200. |


## Decision 0012 departures

| # | Verdict | Evidence and limits |
| --- | --- | --- |
| 1 | pass | Real operations use integer identities and project-relative refs. Cross-project resolution/refusal checks pass. |
| 2 | pass for lane accounting | Ordinary attempts/jobs/producers, all causes, prior-plan question attachment and independent planned-slot reconstruction pass. Inherited classification defects are listed under 4 and 8. |
| 3 | pass | Per-result actor methods, pinned eligibility and agent opt-in pass. Agent-only commit pending; pipeline pass cannot dissolve a needed agent-run failure question. |
| 4 | issues | The 501-test and same-commit split-report fixes pass, as do mistaken sharing, later plans, recurrence and withdrawal. B01 applies inherited to another commit without base proof; B02 keeps inherited after the base's correction. N02 shows withdrawal uses the current policy. |
| 5 | not checked | Browser draft storage and person isolation are outside the engine scope. Server proposal behavior is checked. |
| 6 | pass | Acceptance is durable before application; accepted-sequence live reads all pending; sliced recovery after two process crashes applies once. SLICE is 200. No timing or budget verdict. |
| 7 | pass | Closed-run uploads are refused. Corrections preserve closed snapshots, normalize attempts and refold complete histories. A reopened failing run gets a question. B01 is invalid closure before a run closes, not a late-upload cut. |
| 8 | issues | Target/environment holds, recurrence, clock expiry, replacement ledger rows and dependency recomputation pass their original cases. B01/B02 expose invalid inherited authority; N01 leaves an open question about fully excused targets when their bases differ. |
| 9 | pass | `final-probes.mjs`: same case/change produces one reviewed-basis row; a different change key produces two. Patch-hash invalidation is explicitly deferred. |
| 10 | not checked | Archive/transfer correctness is excluded. Its broad-suite tests ran, but this review gives no archive verdict. |
| 11 | pass | Fifteen operations have registry routes and OpenAPI entries; the named three missing operations are deferred. Streaming transfer is the documented separate exception. |
| 12 | pass | OpenAPI publishes inputs with generic reply envelopes; reply shapes live in TypeScript. Full output schemas are not claimed. |
| 13 | pass | Conflict resolution produces a new proposal under adoption policy and retains newer independent work or conflicts again. Author/single-edit restrictions pass. |
| 14 | pass | Invalid automated claims remain unresolved and declined, cannot fill a slot, and still contribute failing commit evidence. Invalid case-typed claims are rejected. |
| 15 | pass | No proof, skips-only, refused-only and agent-only stay pending. A skip never replaces prior proof/failure. An unjustified excuse in B01/B02 is a separate classification defect. |
| 16 | issues | Forward-only change head checks pass. The promise that a commit's gate is always exact fails in B01 and B02. |
| 17 | pass for repository separation | PR keys, trunk scopes, repository-qualified gates, ambiguity refusal and base lookup separation pass. B01/B02 stay within one repository. |
| 18 | pass | Reserved automated `case:<n>` keys are refused before writes. A manual result for C-1 fills only that case with exact pinned basis. |

## Blocking defects

### R7-B01: An inherited answer for a newer commit excuses a different test on an older commit

Blocks: yes. Confirmed twice with `bun scripts/inherited-other-commit.mjs`; deciding output is in `logs/inherited-other-commit-confirmed.log`.

Report base0001 with test `old` failing and test `new` passing. Report head0001 on PR 1 with only `new` failing with the same cause. Its gate is blocked. Report head0002 on that PR with only `old` failing. The rule correctly identifies the newer failure as inherited, but its answer applies to the entire change scope and recomputes head0001 as passed with one excused failure. Test `new` never failed on the base, and no new evidence was reported for head0001.

Deciding lines: `before.verdict: blocked`, `after.verdict: passed`, `after.tally.excused: 1`; stored evidence shows `base0001/new: pass` and `head0001/new: fail`. The ledger contains only the rule's `inherited` answer for this cause.

The current commit's `failingWithCause` check in `raiseFailure` does not establish the base-failure fact for other commits in the scope. `failureHandler.effect` stores the inherited answer as a scope-wide excuse, and `settle` now recomputes every run showing that cause. The older gate therefore applies a fact that is false for its own test. This contradicts P3, checks 6 and 7, and departures 4, 8 and 16, which promise exact commit gates and inherited evidence for every failing test. The 501-test reproduction itself is fixed.

A real HTTP reproduction with two reader workers also confirms that an open planned run pinned to head0001 becomes passed and is automatically closed, although its only result is the failure absent from the base. Run `bun scripts/inherited-other-commit-http.mjs`; `logs/inherited-other-commit-http.log` records both gates changing from blocked to passed and `planState: closed`. This affects a still-active requested run, not only historical commit display.

### R7-B02: Correcting the base's failure leaves the dependent change falsely passing

Blocks: yes. Confirmed twice with `bun scripts/inherited-base-corrected-late.mjs`; see `logs/inherited-base-corrected-late-confirmed.log`.

Report test `one` failing on base0001, then the same failure on head0001 of a change based on base0001. The rule answers inherited and the head gate passes. The original producer then explicitly corrects the base failure to pass. The base gate now counts only that pass, but head0001 still returns passed with one excused failure and `stale: false`. Reporting the same head failure once more changes its gate to blocked and inserts an outdated row. No change in the head's effective failing test was needed to reveal that its excuse no longer held.

Deciding output: `baseAfterCorrection.tally.pass: 1`; `headBeforeAnotherReport.verdict: passed, excused: 1`; `headAfterAnotherReport.verdict: blocked, unexplained: 1`.

The `hint:fails-on-base` fact is rechecked only while raising a failure for the dependent change. A producer correction of the base recomputes the base's lanes and runs but does not invalidate decisions that depend on those results. Until a new head report, the gate applies a hold whose supporting fact has been withdrawn. This contradicts P3/P4 and checks 6 and 7. Departure 4 promises the base's effective evidence after corrections, and departure 8 promises holds while their facts hold. This is distinct from B01's scope-wide application to a different commit: here one current head becomes stale when the original base evidence is corrected. `inherited-base-corrected-http.mjs` confirms the same sequence through HTTP with two reader workers.

## The tests do not prove this

The current in-scope test suite passes while both inherited-failure reproductions fail their product promises. The new 501-test regression checks the current commit only. The corrected-base tests either correct before the first head report or send a further head report after correction. None checks the dependent head gate immediately after withdrawing the original base evidence. The author sequence audit checks that projections agree with stored excuses, not that each inherited excuse is true for every commit it classifies.

Mutation checks provide useful narrower evidence. Removing the witness-kind guard fails both the author's named integrity test and the independent wrong-kind probe. Removing the `mistaken` answer key fails the author's completeness test. Architecture mutations fail their named rule; structural witness construction fails tsc rather than the architecture suite. Those distinctions are recorded in the logs.

The independent `state-extended.mjs` extends the R6 generator with two repositories, changes with a base, human results from two people, agent-only obligations, strict signoff, closure/reopening, policy switches, corrections and expiry. It independently folds admitted slot histories, checks each slot's state/causes, reconstructs planned tallies, checks verdicts and live-question coverage, checks excuse ownership in both directions, and refuses a supersedes link to an answer still in force. It also checks for open questions already covered by an excuse, and optionally validates rule-made inherited excuses against effective base lanes.

Validated runs:

- Original R6 full audit: 200 seeds, 20,000 steps, zero problems. Original remaining audit: 60 seeds, 9,000 steps, zero problems in its enabled checks. Lane matrix: 4,500 histories, 13,500 comparisons, agreement.
- Extended planned-run audit: `R7_ALLOW_COVERED=1 bun scripts/state-extended.mjs 150`, 18,000 steps, zero additional consistency problems. It deliberately disables N01's known covered-question check, and does not enable the optional inherited-fact check. There were 2,020 successful plans and 12,368 successful reports. This is not a pass for either disabled semantic check.
- A coverage run of the first 60 seeds reports 951 successful reports naming a run, 190 successful withdrawals, and 1,091 decisions. Invalid plans in these final runs are deliberate ambiguous-repository cases; closed-run report conflicts are expected. The pilot initially omitted required obligation IDs and counted no successful plans; it is not used as planned-run evidence. A draft supersedes audit initially counted expired/outdated ledger markers as live answers; correcting that method removed those false alarms.
- `R7_ALLOW_COVERED=1 R7_CHECK_INHERITED=1 bun scripts/state-extended.mjs 60` checks only inherited decisions signed by a rule and finds seven seeds with inherited excuses lacking effective base failure, after 6,873 completed audits. Trace files are `logs/extended-failure-*.json`. These stops are not counted as seven separate defects; the report uses the two independently reduced and repeated inherited reproductions.
- The covered-question audit found the queue inconsistency and was reduced to `covered-question.mjs`, confirmed twice. Its preliminary generator run is not used as evidence of planned-run coverage.

Both blockers were also confirmed over real HTTP routes with two read workers. B01 shows a still-open plan becoming passed and closed. B02 shows a current head remaining passed after base correction and becoming blocked on its next report. See `inherited-other-commit-http.log` and `inherited-base-corrected-http.log`.

The test suite's aggregate `2 pass` from 1,200 author sequences is bounded evidence for its five assertions, not for absent assertions. Browser behavior, performance, and archive correctness are outside the requested scope. The reader checks are functional QA from the same provider as their author, not a different-provider approval.

## Non-blocking findings and follow-up

### R7-N01: A broad answer can leave an open question about a fully excused target

Blocks: no by itself. Confirmed twice with `bun scripts/covered-question.mjs`; see `logs/covered-question-confirmed.log`.

Under standard, a cause on two commits has different `fails-on-base` hints. Answer infra on the first, let the second ask again, withdraw the first answer, then answer flaky on the second. Both commit gates pass under the new broad excuse, while the first question remains open and names the first run in its blocks. `answeredElsewhere` requires the earlier question's basis to match; gate classification applies the excuse without that comparison. This violates P4's one answer for the covered cause and target, and the explicit new audit in the round 7 brief. It also identifies the mismatch between basis-checked question handling and scope-wide classification behind R7-B01. No incorrect gate verdict is independently attributed to this queue-only example.

### R7-N02: Withdrawal uses the current policy, contrary to departure 4's description

Blocks: no. This is a documented-contract mismatch after an administrator deliberately relaxes policy, not a demonstrated way to bypass the policy currently in force. Confirmed twice with `bun scripts/undo-switched-policy.mjs`; see `logs/undo-switched-policy-confirmed.log`.

An independent person records defect under strict. The producer cannot withdraw it, and an independent person cannot withdraw without a reason. After the administrator switches to loose, both withdrawals succeed without reasons. The ledger records the original answer under policy 1 and the withdrawal under policy 2. `undo()` resolves the old answer against `currentPolicy`, whereas departure 4 says withdrawal is held to the clause the answer was given under. Clarify that promise or enforce the recorded policy. Existing regression tests cover only withdrawal without a policy switch.

## Cleanup

All review servers and worker processes stopped. The final audit found no review process and no listener on ports 7950 through 7999. All review `/tmp` data was removed. The exported tree's `node_modules`, `.mainworthy` and `test-results` were released; reports, scripts and logs remain under `engine-r7`. `logs/cleanup.json` records the audit. No repository change or commit was made by this review.

ISSUES (2 blockers)
