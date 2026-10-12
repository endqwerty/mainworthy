# Casebook engine verification, round 6

Revision: `aa7a6050526bf44ebabeef2ca648b37d0bc796ec`, branch `t3/mvp-product-delivery`.

Verifier: Codex, GPT-6 Astra. Independent of the engine author, Claude Opus 5.5. Reader threads were authored by Codex; these functional checks do not claim a different-provider verdict for that subsystem. No other agents were started.

Status: Review complete. Four blocking defects and one non-blocking gate-reply defect confirmed. All seven original round-5 blocker reproductions are fixed; three have new failures in related paths. The round-5 inbox pagination defect is also fixed.

The correctness claim is that gates and standing follow admissible evidence and authorized recorded decisions. Every unexplained failure in a live run must have an answerable question naming that run. Replacement must end the answer it displaces and update every run that relied on it. Commits and slots must agree on the effective result in each admitted lane.

All execution used a clean `git archive` export in `engine-r6/tree`, installed with `bun install --frozen-lockfile` on Bun 1.4.3. The shared repository was read-only. After the temporary test mutations, all 403 tracked files matched a fresh archive of this revision (`logs/export-integrity.json`). Reproduction commands below run from `engine-r6`; after dependency release, run `bun install --frozen-lockfile` in `tree` first.

## Twelve checks

Verdicts apply to the named check and its stated limits, not approval of the engine as a whole. Commands refer to `scripts/`; execution evidence is under `logs/`.

| # | Check | Verdict | What ran and deciding evidence |
| --- | --- | --- | --- |
| 1 | Author tests and architecture rules | pass | `python scripts/author-checks.py` ran the required broad Bun command, tsc and Biome. `573 pass`, `1 fail`, `16438 expect() calls`, `574 tests across 27 files`. The sole failure was the excluded disk-budget test rejecting mandated `/tmp` because it is tmpfs; no budget or performance verdict is made. Typecheck exit 0; Biome `Checked 177 files ... No fixes applied`. Requested architecture mutations each failed their intended rule, except a plain structural Witness, which the type checker rejected for missing private fields. Additional SQLite, undo-caller, pure-core, web-import and duplicate-operation mutations failed too. Sources restored. Logs: `author-summary`, `architecture-summary`. Test-strength limits are below. |
| 2 | Standing and decision witnesses | pass | [STANDING.md](STANDING.md) inventories every scoped standing statement, decision path and exception. `standing.mjs`, `probes.mjs`, `round3.mjs`, `support.mjs` reject plain/prototype/reflective/wrong-kind witnesses and a second mint. `ledger-fk.mjs`: all seven tested decision references reject a missing ledger row; `foreignKeyViolations:[]`. Link/excuse/signoff undo preserves newer decisions; mistaken undo preserves a producer correction. B02/B03/B04 concern the meaning and maintenance of valid decisions, not an unrecorded writer. |
| 3 | Idempotency and atomicity | pass | `probes.mjs`: `firstSeq:2,retrySeq:2`, operation/actor/project reuse conflicts, `lateRollbackUnchanged:true`; 150 unique events numbered 2..151, `failedCommandsConsumeSeq:false`. `new-probes.mjs`: instance replay, secret reply stored only as a refusal marker, retry conflict, `tokens:1`. Live report/restart scripts preserve writes and duplicate no result. Logs: `rerun-probes`, `rerun-new-probes`, `rerun-live`. |
| 4 | Non-overwriting edits | pass | `probes.mjs` and `policy-supplements.mjs`: disjoint stale fields merge; the same field conflicts; resolution retains work added while waiting and follows adopt policy. Unauthorized/multi-edit resolution is refused. Restore yields `restoreVersion:5,versions:5`; delayed tags become `[agent,human]`; a descendant folder move returns invalid. |
| 5 | Evidence provenance and inputs | pass | `probes`, `new-probes`, `round3`, `final-probes`: exact/assumed/unresolved basis 1/1/1; invalid case-typed claims rejected, automated claims declined with no case, `slotFills:0`, failing declined evidence still blocks the commit. Human/CI/agent methods are human+auto/auto+auto/agent+agent. Foreign refs and other-producer/other-target corrections refused. `first:100000,retryFresh:false,rows:100000,batches:1`. Empty reports/keys and unpaired surrogates invalid; clipped emoji remains well formed. `lane-matrix.mjs` adds 4,500 ordinary correction histories with 13,500 observations agreeing between commits and slots. B02 concerns reuse of a later judgment on evidence, assessed in 6–8. |
| 6 | Questions, holds and ledger | issues | `lifecycle.mjs`: `failedResults:500,questions:1`, one carried answer; different frames with the same text remain distinct. `support` verifies hold boundaries and inherited-fact expiry. `lifecycle-positive`: six environment orders, 36 answer decisions, `extraQuestions:0`; report-first and sweep-first both record `flaky -> expired -> defect` with supersedes links. Original stale failure basis, undo and rule-withdrawal checks pass. B01 applies a cause-wide rule from a truncated sample; B03 leaves overlapping answers and a stale dependent gate; B02 asks again about an unchanged result already judged mistaken; B04 accepts stale sign-off evidence. |
| 7 | Gate soundness | issues | Verdict priority, unknown/no-proof/skips/declined-only/agent-only pending, forward-only change heads, separate jobs/producers, older/equal attempts and expiry-before-sweep pass the reruns. Live uploads: 336 observed accepted-state reads, all pending. Two real SIGKILL/restart cycles recover exactly 100,001 results and retry adds none. B01 and B03 produce false passing gates. B02 makes commit and a new planned run disagree about the same judged result. N01 omits an existing answerable question from a gate reply. |
| 8 | Runs and slots | issues | Admission by target/basis/method, pinned version methods, human-only slots, explicit agent opt-in, disputes after 20 later writes, multiple causes, sharing one result between two runs, closed-run report refusal and correction snapshots all pass. Original correction-history and reopening fixes pass. B02 readmits a mistaken historical result into a new slot; B04 closes a now-disputed run using the old passing sign-off basis. |
| 9 | Policy and authorization | pass | `policy-matrix.mjs`: all 15 operations and all answer variants exercised for agent, CI and reader under all three presets, `total:324,probeErrors:0`, with every declared clause matched. Supplements test applicable mistaken answers, conflict authorship, standard agent self-adoption and basis policy. Advice creates no decision; CI cannot decide; reader cannot write. `fixed-undo-policy`: producer undo forbidden, independent undo without required reason invalid, no extra ledger row. Live limited-project operations/events/session lists and forgotten-token revocation pass. |
| 10 | HTTP | pass | Real local listeners: no/same Origin 200; foreign/null/other scheme/Host 401. Server anonymous session/events and all 15 operations 401. Registry operations all have routes and OpenAPI entries. Cookie is HttpOnly/SameSite=Strict; foreign-origin cookie requests fail. Other-project read/events 403. Sized and chunked 65 MiB requests both return actual 413; next ordinary request 200. Public routes match `serve()` (plus static UI/unknown 404). Logs: `rerun-live`, `rerun-checkpoint-live`. |
| 11 | Concurrency and readers | pass | Each 100,000-result upload preserves 40 concurrent case writes, 41 distinct command sequences and 42 contiguous events while reads complete. `readers-live`: 128 read-after-write observations; 27 inline/worker replies over all nine reads, including ten refusals; denied calls never dispatched; worker write forbidden; 80 requests survive a killed worker; `allWorkerExitsAwaited:true,remaining:0`. Checkpoint present during 618 commits; 80 more survive its termination; 698 survive restart. Inline=0 works, default for 16 cores is 8, checkpoints are passive. This is a functional result, with no latency/budget judgment and no different-provider verdict on reader authorship. |
| 12 | Documented departures | issues | All eighteen assessed below. Defects contradict the lane/judgment/hold promises in 2, 4 and 8. Browser persistence (5) and archive implementation (10) are explicitly not checked. The documented cuts themselves are not defects. |

The test runner temporarily mapped ephemeral listener ports into 7750–7799 and disk-budget scratch into `/tmp/casebook-engine-r6-budgets`, then restored the files. The broad command was `bun test src test --path-ignore-patterns 'test/e2e/**'`; compile and lint commands were `bunx tsc --noEmit` and `bunx biome check src test bench`.

All four blocking findings also reproduce through the actual HTTP operation routes with two reader workers (`bun scripts/findings-http.mjs`, `logs/findings-http.log`). That script uses separate projects and actual distinct actors where the finding needs them. The small scripts below use the real `invoke` path and assert the defective outcome: exit 0 means the defect reproduced.

## Earlier findings

`rerun-all.py` first ran all earlier in-process reproductions from round 5's working copies, including its seven blocker scripts and inbox pagination. Live, reader and checkpoint scripts followed. The seven round-5 scripts intentionally assert their old defective outcomes; each now fails at the expected fixed assertion. Corrected `fixed-*.mjs` copies then verify the complete expected behavior, including answering the new questions. None of those expected old-assertion failures is counted as a new defect.

`new-probes.mjs` has two obsolete reserved-`case:1` fixtures and therefore exits 1 at the intended new input refusal. `round3.mjs`'s reserved-key test checks that revised contract and absence of writes. `closed-question.mjs`, an extra round-5 lifecycle variant, now fails its old `open:[]` assertion because the reopened run names `Q-7`. Its required round-5 reopening case is also covered by the corrected script.

| Round-5 finding | Status | Deciding result on this revision |
| --- | --- | --- |
| R5-B01 | fixed | Old empty-question assertion receives `Q-4`. The corrected script answers it and asserts the final gate passes. `fixed-dissolved-target-lost.log`. N01 is a separate gate-list omission, with the question still present and answerable. |
| R5-B02 | fixed | Reopened run names `Q-5`, inbox question names that run, and answering it passes. `fixed-reopen-lost-question.log`. |
| R5-B03 | fixed with a new problem | Both original commit gates now fail immediately; ledger contains `infra,flaky,outdated,defect`, and the retry carries defect. `fixed-overlap-stale-gate.log`. B03 below finds broad-versus-target replacement still fails. |
| R5-B04 | fixed | Commit, existing plan and new plan all pass; correction attempt normalized to 3. `fixed-correction-history.log`. All 4,500 additional ordinary correction sequences agree. |
| R5-B05 | fixed with a new problem | Combined and split two-test reports both stay blocked with two unexplained failures and no failure decision. `fixed-inherited-split.log`. B01 below breaks the same promise beyond 500 tests. |
| R5-B06 | fixed with a new problem | Recurrence opens `Q-3`, keeps the old result discounted, and re-answering the old question returns already. `fixed-mistaken-carry.log`. B02 below reuses the originally discounted result in a later plan. |
| R5-B07 | fixed | Producer undo is forbidden; independent undo without a reason is invalid; gate stays failed and no withdrawal row is inserted. `fixed-undo-policy.log`. |
| R5-N01 | fixed | Failure filter returns `[]`; one-item pages return all four refs in order. `fixed-ledger-page.log`. |

Every earlier finding was also assessed from this round's execution, not accepted from an older verdict:

| Earlier finding | Status from current rerun |
| --- | --- |
| R1-B01 | fixed: multi-case/policy conflict resolution forbidden; unrelated case and policy preserved. |
| R1-B02 | fixed: per-result methods follow actor kind; an agent cannot count as automation. |
| R1-B03 | fixed: naming a run does not admit a different target. |
| R1-B04 | fixed: skipped/refused-only evidence cannot clear a failure or create proof. |
| R1-B05 | fixed: an older commit retry does not move the change head back. |
| R1-B06 | fixed: older and equal attempts preserve the failure; longer correction histories now agree too. |
| R1-B07 | fixed: other-target correction refused and closed snapshots preserved. |
| R1-B08 | fixed with a new overlap problem: original target scope is correct; R6-B03 concerns replacement across broad and target-specific answers. |
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
| R3-B08 | fixed: newer target changes question hash; old answer conflicts. R6-B04 finds stale basis for a different kind, sign-off. |
| R3-B09 | fixed: established stream closes after forgetting; new request returns 401. |
| R3-B10 | fixed: agent result on base does not justify inherited for CI head. |
| R3-B11 | fixed: another repository's trunk cannot justify inherited. |
| R3-T01 | fixed: removing witness-kind rejection fails the named author test and independent probe. |
| R3-T02 | fixed: secret replay test actually counts one token row. |
| R3-N01 | fixed: reader default is cores minus two clamped 1..8; explicit 0 works inline. |
| R4-B01 | fixed with a new base-hint problem: corrected-base and late-trunk-fallback heads stay blocked. R6-B01 is a truncated set of tests. |
| R4-B02 | fixed: plan over repositories a and b stays blocked after only a is excused. |
| R4-B03 | fixed: same-attempt pass after fail keeps commit and planned gate blocked. |
| R4-B04 | fixed: pipeline pass retains agent-run question and it remains answerable. |
| R4-B05 | fixed with a new replacement problem: separate infra answers carry and undo independently; R6-B03 covers broad-versus-target replacement. |
| R4-B06 | fixed: both answer-replacement producer probes forbidden; round-5 withdrawal variants now refused too. |
| R4-T01 | fixed: answer-key mutation fails; replay/bulk tests count stored entities; body-limit test reads actual socket status; restart test kills and restarts a process. |
| R4-N01 | fixed: slice constant and current documentation say 200. |

Evidence for rounds 1–4: `rerun-probes`, `rerun-new-probes`, `rerun-round3`, `rerun-round4`, `rerun-lifecycle`, `rerun-lifecycle-r4`, `rerun-policy-r4`, `rerun-final-probes`, `rerun-live`, `rerun-readers-live`, `rerun-checkpoint-live`, and `test-strength-summary` logs. The author-discovered dependent-run lapse case also passes: its earlier commit and closed planned run are recomputed and name the replacement question.

## Decision 0012 departures

| # | Verdict | Assessment |
| --- | --- | --- |
| 1 | pass | Real operations use integer storage identities and project-relative refs; foreign refs do not resolve across projects. |
| 2 | issues | Ordinary attempt/job/producer/target lanes and all-cause counting pass. R6-B02 makes a newly planned slot and commit disagree about the same result after a mistaken decision. |
| 3 | pass | Mixed methods, pinned eligibility, explicit agent opt-in and agent-only commit pending all pass. An agent failure remains a question for its relevant planned run. |
| 4 | issues | Producer checks, withdrawal reasons and original recurrence fix pass. R6-B01 breaks the every-test base condition at 501 tests; R6-B02 reintroduces a specifically judged result without new evidence. |
| 5 | not checked | Browser draft persistence is outside scope. Server proposal paths were exercised. |
| 6 | pass | Durable acceptance precedes application, all observed accepted-state reads pending, two crashes recover once, and SLICE is 200. No performance claim. |
| 7 | pass | Closed reports refused; producer corrections preserve closed snapshots, normalize attempts and refold history; reopened failing run is asked again. R6-B04 concerns stale evidence before sign-off, not the documented late-report cut. |
| 8 | issues | Basic holds, independent environments, honest failure recurrence, expiry rows and original dependent-run fixes pass. R6-B03 leaves an overlapping answer in force and a dependent gate stale. R6-B04 records a sign-off on obsolete evidence. N01 affects the gate's list, while its answerable question exists. The documented older-commit infra exception is not a defect. |
| 9 | pass | Same case version and change key produce one review across commits; another change key produces another. Patch-hash invalidation is explicitly deferred. |
| 10 | not checked | Archive/transfer implementation is excluded; its broad-suite tests ran without an independent archive verdict. |
| 11 | pass | Fifteen registry operations have routes and OpenAPI entries; named deferred operations absent. Streaming transfer is the documented separate exception. |
| 12 | pass | OpenAPI describes inputs and generic response envelopes; concrete reply shapes are TypeScript types. Full reply schemas are not claimed. |
| 13 | pass | Conflict resolution creates a proposal governed by current adopt policy, preserves newer work or conflicts again, and enforces author/single-edit restrictions. |
| 14 | pass | Bad automated claims kept unresolved/declined, fill no slot and still block a failing commit; invalid case-typed claims rejected. |
| 15 | pass | Nothing proven, skips only, all refused and agent-only remain pending; skip preserves prior proof or failure. |
| 16 | pass | Late/repeated old commit reports do not move the change head backward. |
| 17 | pass | Repository PR keys, scoped gates, ambiguity refusal, trunk scopes and base repository filtering pass. R6-B01 is incomplete same-repository test coverage, recorded under 4. |
| 18 | pass | Reserved automated `case:<n>` keys refused before writes; manual C-n result fills only its own slot with exact basis. |

## Defects

### R6-B01: The 501st failing test can be excused by a base failure it did not have

Blocks: yes. Confirmed twice against the pinned export, first in `r6-explore.mjs`, then the minimal reproduction.

Run `bun scripts/inherited-limit.mjs`. On the base, 500 tests fail with one cause and test 501 passes. On the head, all 501 fail with that cause. The gate is correctly blocked. Report just the first failing test again. No effective outcome changed, but the rule now excuses all 501 and the gate passes.

Deciding output in `logs/inherited-limit-confirmed.log`: before `blocked, unexplained:501`; after `passed, excused:501`; `test-0500` has base `pass` and head `fail`. The ledger records `inherited`.

`Q.failingWithCause` in `src/server/runs/runs.ts:183` limits the evidence to 500 tests. `raiseFailure` in `src/server/decisions/decisions.ts:704` combines that sample with the arriving report and treats it as every failing test. The final test is outside both sets. This contradicts P3, checks 6 and 7, and departure 4's explicit promise that inherited must hold for every currently failing test, independent of report boundaries. R5-B05's original two-test case is fixed, but the invariant still fails at this boundary.

### R6-B03: Replacing a target-specific answer with a broad answer leaves another commit falsely passing

Blocks: yes. Confirmed in generated sequences and twice with the minimal reproduction.

Run `bun scripts/replace-targeted-answer.mjs`. Report one cause on first001 and answer infra. Report it on second01 and answer infra there too. Both gates pass. Replace the first answer with defect, which applies to the cause throughout the scope. first001 becomes failed, but second01 stays passed. Its standing classification is already attributed. Another report on second01 changes the gate to failed with no new decision, while the receipt still calls its answer infra.

Deciding output in `logs/replace-targeted-answer-confirmed.log`: `after.first.verdict:failed`, `after.second.verdict:passed`, `retry.gate.verdict:failed`, `retry.questions[0].answer:infra`. The ledger is infra, infra, defect, with no outdated row ending the second infra answer.

`endReplaced` in `src/server/decisions/decisions.ts:509` treats broad-versus-target coverage as non-overlapping. `setExcuse` adds the newer broad row, and `excuseFor` chooses it by decision id over the target row, but `settle` neither ends that displaced target answer nor recomputes its dependent run. This contradicts P0/P3/P4, checks 6 and 7, and departure 8's one-answer and dependent-run promises. R5-B03's broad-versus-broad case is fixed; broad-versus-target still produces the same false pass.

### R6-B04: A sign-off accepts stale passing evidence after the run becomes disputed

Blocks: yes. Confirmed twice.

Run `bun scripts/signoff-stale.mjs`. Under strict, record a passing result and read the open sign-off question. Another person then records a failure in the same slot. The run is now blocked and disputed, but the sign-off question still shows a passed verdict and its original evidence hash. Approving with that old hash succeeds and closes the disputed run under a decision based on the old passing evidence.

Deciding output in `logs/signoff-stale-confirmed.log`: the saved and current sign-off evidence both contain `verdict:passed, tally.pass:1`; the actual gate is `blocked, disputed:1`; approval is `decided`; the stored run is `state:closed, disputed:1`.

`refold` in `src/server/decisions/decisions.ts:800` only refreshes a sign-off when `wantsSignoff` is true. A run that stops passing leaves the earlier question unchanged. `signoffHandler.effect` in `src/server/decisions/kinds.ts:481` closes the run without validating its current basis. This contradicts P0/P3, check 6's stale-evidence rule, and decision 0012's claim that answers are basis checked. The gate does not falsely turn green in this reproduction, but an authoritative closure is recorded on evidence the signer was not shown. This is distinct from the documented refusal of reports after a run has closed: both results arrived before closure.

### R6-B02: A new planned run counts a result already judged mistaken

Blocks: yes. Confirmed twice, including a one-case minimal fixture.

Run `bun scripts/mistaken-later-plan.mjs`. Two people report fail and pass for the same exact case version, test, and commit. A planned run shows their dispute. Answer `mistaken`. The named failure leaves that run and the commit gate, and both pass. Plan the same case on the same commit again. The new run admits the same mistaken result, becomes disputed, and asks another question. No new result was reported.

Deciding output in `logs/mistaken-later-plan-confirmed.log`: commit and original run `passed`; new run `blocked, disputed:1`. Result 1 has `discounted_by:3` in the first slot and `discounted_by:null` in the new slot.

`fillFromPrior` in `src/server/runs/runs.ts:1101` admits historical results without their existing mistaken judgment. The judgment is stored only on old slot-result rows, while `refoldLaneOf` excludes a result from its commit if any slot discounted it. Identical admitted lane histories therefore disagree. This contradicts P3/P4, checks 6 to 8, and departures 2 and 4: a mistaken answer names specific results, and a new result is what justifies asking again. R5-B06's recurrence case is fixed, but reuse of its original result remains inconsistent.

## The tests do not prove this

The current suite proves the original round-5 examples, but it misses the four confirmed variants above. This is a coverage limit supported by a passing in-scope suite and failing real reproductions, not four additional defects in the blocker count.

- The inherited regression uses two tests, so it cannot expose the `LIMIT 500` sample being treated as exhaustive.
- The replacement regression displaces a broad answer with another broad answer. It does not replace a target-specific answer with a broad answer and inspect every affected run and receipt.
- The mistaken-result tests check current slots and a later report. They do not create a new plan over the same already judged historical result.
- Passing-signoff tests do not let the run become disputed before approving the saved question hash. An equality check against a question that was never refreshed cannot prove that the signer's basis is current.

Mutation evidence is useful: removing the witness-kind guard makes the author's named integrity test and independent wrong-kind probe fail; removing `mistaken` from the advertised answer keys makes the named policy test fail. See `test-strength-summary.log`. A plain object typed as Witness is rejected by tsc, not by the architecture test itself; the report does not conflate those gates.

Additional sequences concentrated on the two new invariants. `state-sequences.mjs` ran 4,192 steps and stopped each seed at its first mismatch (64 stops). Inspection and reduction yielded the already reported overlapping-answer/stale-tally problem and gate-list omission; those 64 stops are not 64 distinct defects. Trace files are `logs/state-failure-*.json`.

`bun scripts/state-remaining.mjs 120` then ran 18,000 steps over reports, attempts, corrections, plans, answers, withdrawal and time sweeps. With the two known stored-tally/gate-list assertions explicitly disabled, the remaining live-question-coverage and commit-history checks reported `checked:18000,problems:0`. That result is bounded evidence for those remaining checks, not a pass for the disabled assertions or a proof over every sequence. `lane-matrix.mjs` separately checks 4,500 three-result correction histories against a local history fold, including fail/error/pass/skip/blocked and descending attempt orders; `observations:13500,commitAndSlotAgree:true`. Its cases contain no mistaken judgments and therefore do not cover B02.

The brief excludes browser tests, archive/transfer correctness and performance budgets. The one excluded budget failure is recorded under check 1. Reader checks were run, but their author shares the verifier's provider. These limits do not reduce the four engine findings, which were independently reproduced both in process and over HTTP.

## Worth doing later

### R6-N01: A second live run omits its answerable failure question from the gate

Blocks: no. The gate remains blocked, and the inbox has an answerable question naming both runs. Confirmed twice.

Run `bun scripts/question-missing-from-gate.mjs`. Plan two runs over one failing commit, report the cause on a newer commit, and answer infra for the newer target. Both earlier planned runs still fail. The first gets a replacement question in `gate.open`; the second returns `open:[]`, although the same question names it in the inbox.

`askUnexplained` in `src/server/decisions/decisions.ts:766` calls `alsoAbout` for an already open question and continues without setting `asked`. `refold` therefore skips its second tally and leaves the second run's stored blocking list unchanged. The new invariant records the question but the gate reply does not expose it. See `logs/question-missing-from-gate-confirmed.log`.

## Cleanup

Every review server was stopped. The final process and listener audit found none running and no listener on ports 7750–7799. All review `/tmp` data is removed; the remaining budget directory was deleted. Exported `node_modules`, `.casebook` and `test-results` were released. Reports, scripts and logs remain under `engine-r6`. The shared repository was not changed. See `logs/cleanup.json`.

ISSUES (4 blockers)
