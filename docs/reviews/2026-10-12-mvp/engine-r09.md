# Mainworthy engine review, round 9

Revision: `f088a5c28fd336c801b439dc47329c7a418ed851`, branch `t3/mvp-product-delivery`.

Reviewer: Codex, GPT-6 Astra. I ran this ordinary local QA review against a clean `git archive` export. I started no other agents and changed neither the shared repository nor Git state. This is a different provider from the engine author, Claude Opus 5.5. The reader-thread author is GPT 6.1 Sol, so those checks are functional QA, not a separate-provider signoff of that subsystem.

Four blockers remain. An opted-in agent run can pass and close with a failure the base never had. A valid matrix report can prevent instance startup. Recovery can preserve an inherited excuse after the base changes. Unadmitted agent evidence can change a commit gate.

The correctness fact is that every counted excuse has a recorded, applicable decision whose supporting evidence is still true. That fact fails in R9-B01 and R9-B03. R9-B02 prevents finite, valid work from completing. R9-B04 contradicts the explicit boundary on agent evidence.

All commands below run from this `engine-r9` directory unless they say `tree`. Scripts and logs are review artifacts. To rerun after cleanup, run `bun install --frozen-lockfile` in `tree`. Defect reproductions assert the observed wrong behavior and should fail after a fix. No performance verdict is claimed.

## Twelve checks

| # | Check | Verdict | What I ran and the deciding evidence |
| --- | --- | --- | --- |
| 1 | Author tests and architecture | issues in proof strength; execution passes in scope | `python3 scripts/author-checks.py` ran the requested `bun test src test --path-ignore-patterns 'test/e2e/**'`, `bunx tsc --noEmit`, and `bunx biome check src test bench`. Output: `588 pass`, `1 fail`, `16541 expect() calls`, `589 tests across 28 files`. The one failure is the excluded disk-budget test rejecting `/tmp` as tmpfs. Typecheck exits 0. Biome: `Checked 178 files ... No fixes applied.` Required architectural mutations fail their named checks. A plain witness is rejected by TypeScript, not the architectural test alone. The inherited sequence assertion calls the same faulty selector as production, demonstrated in R9-T01 below. |
| 2 | Standing and witnesses | pass for writer authority | [STANDING.md](STANDING.md) inventories each scoped standing statement and its decision call path, projections, and four exceptions. `probes`, `standing`, `round3`, `support`, `ledger-fk`, `foreign-keys`, and `witness-constructor` ran. Plain, prototype, reflective, second-mint, and wrong-kind attempts are refused. Removing the kind guard fails both the author regression and independent probe. Seven ledger foreign keys refuse a missing decision, with `foreignKeyViolations:[]`. Undo preserves newer links, signoffs, and producer corrections. The defects below concern the meaning or continued validity of recorded decisions. |
| 3 | Idempotency and atomicity | pass for command accounting | `probes` prints `firstSeq:2,retrySeq:2`, conflicts for operation, actor and project reuse, and `lateRollbackUnchanged:true`. Its 150 interleaved events are unique and contiguous from 2 to 151, with `failedCommandsConsumeSeq:false`. Instance commands replay. `new-probes` records only the secret-withheld marker and one token, and refuses token replay. `round3` records `rows:100000,batches:1,retryFresh:false`. Live uploads preserve unique sequences and replay adds no results. R9-B02 separately exposes a durably accepted report that cannot finish. |
| 4 | Edits never overwrite | pass | `probes`, `policy-supplements`, and the suite/integrity tests cover disjoint stale-field merge, same-field conflict, delayed adoption, re-merge after conflict, author and adopt policy, restore, tags at adoption, and cycles. Deciding lines include `differentField:"merged preserving human pre"`, `sameField:"conflict"`, `restoreVersion:5,versions:5`, tags `["agent","human"]`, multi-case/policy merge `forbidden`, and `a folder cannot be moved into itself or into a folder inside it`. |
| 5 | Evidence basis, methods and inputs | pass for admission and storage | `probes`, `new-probes`, `round3`, `final-probes`, and author evidence tests cover exact, assumed and unresolved bases, pinned disagreement, foreign references, producer/target corrections, 100,000 results, and unusual text. Declined automated claims have `slotFills:0`, while their failures remain in the commit gate. Per-result methods are human/auto, auto/auto and agent/agent. Empty reports/keys and unpaired surrogates are invalid; clipped samples remain well formed. R9-B01 is a later selection error over correctly recorded agent evidence. |
| 6 | Questions, holds and ledger | issues | Original lifecycle probes still pass: 500 failures give one question, scope/cause separation, current-evidence conflicts, clock and target expiry, `flaky,expired,defect` ledger chains, and no automatic override after withdrawal. Six environment orders make 36 decisions with no extra questions. Round-8 target cycling now terminates. R9-B01 omits a still-effective agent failure when validating an answer; R9-B02 mistakes 201 necessary raises for a loop; R9-B03 loses rebase invalidation on recovery. |
| 7 | Gate soundness | issues | Verdict priority, unknown/no-proof/skip/refused-only/agent-only pending, ordinary lane rules, forward-only heads and clock-expired pending all pass. In two live uploads, all 335 reads at the accepted sequence return pending. Two ordinary kill/restart runs recover exactly 100,001 results and replay adds none. R9-B01 falsely passes a release run, R9-B03 falsely passes an old commit after recovery, and R9-B04 changes a commit gate using unadmitted agent evidence. R9-B02 leaves the head passed while the base correction remains unapplied. |
| 8 | Runs and slots | issues | Target, method, pinned basis, explicit agent opt-in, human-only obligations, complete disputes, multiple causes, shared results, closed-run refusal, and correction snapshots pass the earlier probes. `lane-matrix` prints `sequences:4500,observations:13500,commitAndSlotAgree:true`. Mistaken decisions and their undo reach existing and later plans; stale signoff conflicts and a fresh one can close the run. R9-B01 closes a run as passed while its slots still fail, with an inherited excuse unsupported by the base. |
| 9 | Policy and actor boundaries | issues in the agent-evidence boundary; direct authorization passes | `policy-matrix` calls all 15 operations and every answer for agent, CI and reader across loose, standard and strict: `total:324,probeErrors:0`. Applicable-answer supplements verify mistaken and inherited answers, conflict authorship and standard self-adoption refusal. Live scoped tokens get 403 on another project's operations/events, see only permitted projects, and stop working after forgetting. R9-B04 shows an agent with read/produce changing the CI gate through its evidence despite no opt-in. |
| 10 | HTTP surface | pass | `live`, `checkpoint-live`, and author HTTP tests use real loopback listeners. Local absent/same Origin = 200; foreign/null/other scheme/foreign Host = 401. Server session, events and all 15 operations require a token. Every registry route has an OpenAPI entry. Cookies are HttpOnly/SameSite=Strict and rejected from other origins. Sized and chunked 65 MiB bodies return 413; the next ordinary request returns 200. Public routes match `serve()` and unknown routes return 404. Browser UI is outside this verdict. |
| 11 | Concurrency and readers | pass functionally, with the provider limit above | Each live large report preserves 40 simultaneous case writes, 41 unique command sequences and 42 contiguous events while reads complete. `readers-live`: 128 read-after-write checks; all nine read operations agree across 27 inline/worker replies including ten refusals; denied reads never dispatch; workers refuse writes; all 80 requests survive a killed worker; `allWorkerExitsAwaited:true,remaining:0`. Twelve reads after forgetting omit the old name. Checkpoint output: 500 commits while present, 80 after termination, 580 persisted after restart. Explicit 0 is inline; default for 16 cores is 8. R9-B02 is an application-processing/startup failure, not lost worker requests. |
| 12 | Documented departures | issues | Each of the 18 departures is assessed below. The blockers contradict inherited validation, recovery and agent-gate boundaries. Browser drafts and archive correctness are out of scope and not checked here. None of the listed feature cuts is counted as a defect. |

The test runner changes only exported test ports to 8100-8149 and the excluded budget data path to `/tmp`, then restores the files. The sole out-of-scope failure is `on-disk hot paths stay inside the design budgets`: the test rejects tmpfs. There are no other compilation, lint or test failures in the unmodified test run. `logs/author-checks-summary.log` and `logs/author-tests.log` preserve the output.

Architectural checks were challenged one at a time with an upward import, second mint import and call, foreign-table SQL, raw SQL, an unchecked witness parameter, and plain witness objects. Additional mutations cover direct SQLite use, undo outside a kind handler, core I/O, web/server imports, duplicate operations and a second operation path. Every relevant boundary rejects the mutation. For the exact witness shape, tsc reports `missing ... #decision, #kind, #signers, #expiresAt`. The architecture test alone reports `12 pass, 0 fail` for the structural witness, so its rejection is specifically a typecheck result. Logs are `architecture-*.log`, `witness-typecheck*.log`, and `test-strength-summary.log`. All mutations were restored.

The requested sequence command, `MAINWORTHY_SEQUENCE_SEEDS=300 bun test test/sequences.test.ts`, prints `3 pass, 0 fail`: 300 seeds per policy, 72,000 steps. The earlier independent scripts print `state-sequences: 8000 checked, 0 problems`, `state-remaining: 9000 checked, 0 problems`, and `state-extended: 7200 checked, 0 problems` with `R7_CHECK_INHERITED=1`. These results are limited to their assertions and generated inputs. `state-remaining` retains two disabled assertions. `state-extended` still has an obsolete fallback in its own expected-result calculation, so its green result does not prove fallback removal. The new `round9-scope-matrix.mjs` directly proves 29 combinations of line order, environment, answer timing, decision kind, and unavailable bases. No-base, unreported-base, self-base, foreign-base and agent-only-base cases all remain blocked.

## Status of round 8

| Finding | Status | Current deciding evidence |
| --- | --- | --- |
| R8-B01 | fixed with a new problem | `inherited-open-plan.mjs` returns normally. The later head passes by inherited decision and the old planned run stays blocked with an answerable question. `inherited-other-commit-http` now reaches its obsolete expected-passed assertion with actual blocked, instead of a stack overflow. The new raise guard rejects a legitimate matrix in R9-B02. |
| R8-B02 | fixed with a new problem | Added-test and moved-base probes fail their old expected-passed assertions with actual blocked. Dependencies include both tests and follow the new base. `fixed-round8-http` confirms `excused:0` immediately after either base change. R9-B03 is the unhandled recovery path when rebase metadata changes a different canonical scope. |
| R8-B03 | fixed under the recorded contract | The old `two-lines-gate` probe cannot find a second trunk question, as departure 17 now requires. `fixed-round8-http` changes the canonical answer to defect and gets `failed,attributed:2,excused:0`. The 24 line-order/environment/answer-timing variants in `round9-scope-matrix` pass, including planned runs. |
| R8-B04 | fixed with new problems | `inherited-agent-stale` now prints `answer.status:"conflict"` and the run remains blocked. The already-decided agent-plan probe becomes blocked after base correction. Both run through HTTP in the positive replacements. R9-B01 finds an incorrect agent failure selector, and R9-B04 finds the unadmitted-agent gate effect. |

`round8-positive.mjs` also passes newer-attempt base changes, other environments, a base on a stacked change, repository separation, fresh/repeated rebase reports, base results judged mistaken, and human/agent/CI answers on stale base evidence. Its output is `logs/round8-positive.log`.

## Earlier reproductions

Before new exploration or author checks, `python3 scripts/rerun-earlier.py` ran all 65 earlier reproduction scripts copied from round 8, including its consolidated versions of rounds 1-7. Ports and scratch names were changed only for isolation. The complete per-script result and deciding tail are in `logs/rerun-summary.json`; full output is in each `logs/rerun-<script>.log`. Old defect assertions are expected to fail after a fix. Positive replacement scripts were also run, including the complete `fixed-round8-http.mjs` when an old multi-case script stopped at its first obsolete assertion.

| Earlier finding | Status and deciding evidence from this round |
| --- | --- |
| R1-B01 | fixed: multi-case/policy conflict resolution is forbidden and unrelated state is preserved. |
| R1-B02 | fixed: mixed-result methods follow actor kind; agents cannot count as automation. |
| R1-B03 | fixed: naming a run with a different target is invalid and writes no results. |
| R1-B04 | fixed: skips/refused-only evidence cannot clear a failure or establish proof. |
| R1-B05 | fixed: repeated/older reports do not move a change head backward. |
| R1-B06 | fixed: older/equal attempts preserve the failure; correction histories agree. |
| R1-B07 | fixed: other-target correction refused; closed slot remains satisfied and uncorrected. |
| R1-B08 | fixed: per-target infra and broad replacement pass. The two-line case is also fixed under the documented canonical-scope rule. |
| R1-B09 | fixed: operations, events and project lists respect token scope; forgotten tokens return 401. |
| R1-B10 | fixed: delayed adoption preserves newer fields and tags. |
| R1-B11 | fixed: folder cycle refused. |
| R1-B12 | fixed: repository PR keys, commit gates and planned causes are separate. |
| R1-B13 | fixed: pinned version's methods control admission. |
| R1-B14 | fixed: mismatched manual annotation rejected without relinking. |
| R1-B15 | fixed: plain/runtime witnesses and a second mint are refused; structural witnesses fail tsc. |
| R1-B16 | fixed: undo of an older mapping preserves the newer case link. |
| R1-B17 | fixed: bulk pages return 200 then 100 cases; interleaved pages return all 300. |
| R1-B18 | fixed: operation/actor/project reuse conflicts; secret reply withheld, tokens remain 1. |
| R1-B19 | fixed: required jobs fill runs both before and after planning. |
| R1-N01 | fixed: the ledger includes `flaky, expired, defect` with the supersedes chain. |
| R1-N02 | fixed: another origin scheme returns 401. |
| R1-N03 | fixed: public routes match the documented list. |
| R1-N04 | fixed: empty and whitespace test keys are invalid. |
| R2-B01 | fixed: reflective construction, prototype object and second claim refused. The old constructor script fails at its constructor call. |
| R2-B02 | fixed in its original case: agent-only commit pending; agent pass cannot clear a direct pipeline failure. R9-B04 is a new indirect influence through inherited decisions. |
| R2-B03 | fixed: answering one cause leaves the other cause unexplained in the slot. |
| R2-B04 | fixed: later skip preserves the disputed slot. |
| R2-B05 | fixed: repository-qualified gate, impact and prior-result planning agree. |
| R2-B06 | fixed: reserved automated `case:1` is refused before writes. |
| R2-B07 | fixed: passing a subset plan does not close another failure's question. |
| R2-B08 | fixed: infra covers its environment, and the other environment is asked again. |
| R2-B09 | fixed: filtered search returns C-301. |
| R2-N01 | fixed: full/prefix commit reads both environments. |
| R2-N02 | fixed: denied read returns 403 without worker dispatch. |
| R3-B01 | fixed: corrected evidence stays replaced in existing and later plans. |
| R3-B02 | fixed for lane folding: another job or environment preserves the failure. R9-B01 wrongly excuses an agent lane that still fails. |
| R3-B03 | fixed: a plan over existing failure names an answerable question and responds to its decision. |
| R3-B04 | fixed: trunk answer scope includes repository. |
| R3-B05 | fixed: ingest writes one expired row; a subsequent sweep writes none. |
| R3-B06 | fixed: undo mistaken preserves a later producer correction. |
| R3-B07 | fixed: strict map/create is invalid and leaves proposal/case counts unchanged. |
| R3-B08 | fixed: newer target changes evidence hash and the old answer conflicts. |
| R3-B09 | fixed: established stream closes after forgetting; next request is 401. |
| R3-B10 | fixed: an agent's base failure cannot justify inherited for a pipeline head. R9-B04 concerns agent evidence on the head changing an existing excuse. |
| R3-B11 | fixed: another repository's trunk does not justify inherited. |
| R3-T01/T02 | fixed: removing the witness-kind check fails its regression; token replay counts the one stored token. |
| R3-N01 | fixed: default readers are cores minus two clamped to 1–8; explicit 0 is inline. |
| R4-B01 | fixed with new problems: corrected-base probes remain blocked. The removed fallback is not used. R9-B01 and R9-B03 expose different inherited-validation gaps. |
| R4-B02 | fixed: a multi-repository plan remains blocked after answering only one repository's failure. |
| R4-B03 | fixed: same-attempt pass after fail leaves commit and plan blocked. |
| R4-B04 | fixed: pipeline pass retains a needed agent-run failure question. |
| R4-B05 | fixed: infra answers carry/withdraw separately, and broad replacement recomputes both gates. |
| R4-B06 | fixed: producer replacement is forbidden; later withdrawal-policy probes also pass. |
| R4-T01 | fixed: removing the mistaken answer key fails the completeness test; body-limit/restart tests use real HTTP and processes. |
| R4-N01 | fixed: processing slice and documentation both say 200. |
| R5-B01 | fixed: the old probe's missing-question assertion fails; positive probe names a replacement and answers it. |
| R5-B02 | fixed: reopened run gets Q-5; old decided-question lookup is no longer current. |
| R5-B03 | fixed: answering the current broad question updates both commit gates immediately. Answering the superseded narrower question conflicts. |
| R5-B04 | fixed: commit, existing plan and later plan pass; correction has attempt 3. |
| R5-B05 | fixed: split and combined reports each show two unexplained failures and no inherited decision. The round-8 added-test dependency case is also fixed. |
| R5-B06 | fixed: the new failure gets a new question; the originally mistaken result remains discounted. |
| R5-B07 | fixed: strict producer withdrawal forbidden; independent withdrawal without reason invalid. |
| R5-N01 | fixed: failure filter empty; one-item pages return all four refs. |
| R6-B01 | fixed: the 501-test old probe expects passed and gets blocked; positive and HTTP variants show 501 unexplained failures. |
| R6-B02 | fixed: old later-plan probe expects blocked and gets passed. Positive/HTTP tests and three-run undo confirm the new behavior. |
| R6-B03 | fixed: old expected passed gate is now failed; both affected gates update and the ledger records replacement. |
| R6-B04 | fixed: stale signoff no longer exists and cannot close the run; a new signoff after correction succeeds. |
| R6-N01 | fixed: old expected empty list now has one question, and both runs name Q-4. |
| R6 sequence/tally and actor-label findings | fixed in their original cases: enabled sequence audits report zero problems; 12 worker reads after forgetting use the new pseudonym only. The sequence limits are stated below. |
| R7-B01 | fixed: the old commit remains blocked when a later commit is inherited, including the live planned-run variant. |
| R7-B02 | fixed with new problems: direct base corrections, newer attempts and mistaken decisions invalidate inherited answers. R9-B03 covers recovery after a cross-scope rebase. |
| R7-N01 | fixed: the old remaining-question assertion fails; `fixed-covered-question` checks that both covered targets pass and no open question remains. |
| R7-N02 | fixed by the recorded contract: withdrawal uses the current policy, and each decision records its policy version. |

Two old `new-probes` cases stop at the reserved `case:1` refusal; `round3` positively verifies the refusal and absence of writes. `fixed-overlap-stale-gate` has an obsolete narrower question; `fixed-r7` checks the current broad answer and both gates. `findings-http` and `round8-findings-http` stop at fixed assertions; their full positive replacements pass. These are stale expectations in probes, not new engine defects.

## Decision 0012 departures

| # | Verdict | Evidence and limit |
| --- | --- | --- |
| 1 | pass | Integer identities and project-relative public refs match the code. Cross-project references are refused or declined without adopting another project's case. |
| 2 | issues | Ordinary lane folding and target scopes match the description, including both line orders. R9-B01 incorrectly excuses a still-counted agent lane because inherited validation uses a different selector. |
| 3 | issues | Methods, pinned eligibility and default agent exclusion work. R9-B04 violates the explicit promise that agent reports never move a commit gate. |
| 4 | issues | Normal inherited dependency updates, current-policy withdrawal, and mistaken-result behavior pass. R9-B01 omits effective agent failures, R9-B02 fails during necessary invalidation, and R9-B03 loses invalidation across recovery. |
| 5 | not checked | Browser drafts and per-person device storage are outside scope. Server sealing and adoption are checked in item 4. |
| 6 | issues | Ordinary durable acceptance, 200-result slices, pending reads and crash recovery pass. R9-B02 prevents recovery, and R9-B03 recovers the results while losing a required decision update. |
| 7 | pass for the stated refusal and snapshot rule | Closed-run reports conflict. Corrections preserve closed snapshots and affect open and later runs. Reopening restores an answerable failure question. |
| 8 | issues | Time, target and environment holds, visible expiry, broad replacements and the original closure cases pass. R9-B01 and R9-B03 leave an inherited answer without the required fact; R9-B02 cannot finish revoking all valid target-specific holds. |
| 9 | pass | `final-probes` prints one review row for the same case/change and two after a different change. Patch-tree invalidation is expressly deferred. |
| 10 | not checked | Whole-instance archive correctness is outside scope. Its existing tests ran but do not constitute an archive review here. |
| 11 | pass | The live registry/OpenAPI check finds 15 operations and their routes. Streaming transfer remains separate as described. |
| 12 | pass | Generated OpenAPI describes inputs and generic reply envelopes. `src/core/api.ts` contains typed replies; detailed output schemas are deferred. |
| 13 | pass | A resolved conflict creates a new proposal under adopt policy, requires a single case edit by its author, and re-merges or conflicts if current content moved. |
| 14 | pass | Invalid automated annotations produce declined, unbound results which cannot fill slots and still count against the commit. Invalid case-typed claims are rejected. |
| 15 | issues in the inheritance path | Empty/no-proof and ordinary skip preservation pass. R9-B01's newer agent skip preserves the failing slot but wrongly changes its classification to excused, making the run pass. |
| 16 | issues in exact historical gates | Forward-only change heads pass. R9-B03 leaves an old commit gate falsely passed after its change's base moves. |
| 17 | pass for canonical scope and repository separation | The first report's scope is reused in all 24 ordering variants. Other repositories remain separate, ambiguous hashes require `repo`, and the rule does not use an unknown or foreign base. R9-B03 concerns recovery of a rebase across canonical scopes, covered in departures 4 and 6. |
| 18 | pass | Reserved automated `case:<n>` keys are invalid before writes; the manual identity fills only its own case. |

## Defects

### R9-B01: an agent's other job or newer skip can excuse a still-failing release slot

Blocking defect. `agentFailuresWithCause` in `src/server/evidence/evidence.ts` discards an agent failure whenever the same actor has a higher attempt for that test and target. It does not preserve job lanes or ignore skips. `inheritedNow` then omits a failure that the planned run still counts, allowing the loose rule to answer `inherited` for the entire cause.

Reproduction: `bun scripts/agent-lane-inherited.mjs` from this directory. It creates two cases and a run admitting auto and agent evidence. On the base, test one fails and test two passes. On the head, pipeline test one and agent test two fail with the same cause. The run is correctly blocked. The same agent then reports test two passing in a different job at attempt 2, or skipping in the original job at attempt 2.

Both independent variants print a transition from `blocked` with two unexplained failures to `passed` with `excused:2`. The slot for test two remains `state:"failing"`; the run becomes `state:"closed"` with a signoff. Test two never failed on the base. The reproduction asserts this observed wrong behavior and should fail after a fix. Full evidence is `logs/agent-lane-inherited.log`. `agent-lane-http.mjs` independently reproduces the false pass over HTTP with two reader threads, in `logs/agent-lane-http.log`.

This contradicts P3 and departures 2, 4 and 15: other jobs and skips cannot hide a failure, and inherited must be true of every failing test. The fix must use the same effective-lane rules for inherited agent evidence and slot folding.


### R9-B02: the raise limit rejects a legitimate matrix report and leaves its batch unapplied

Blocking defect. The per-command `RAISE_LIMIT` counts all raises of a cause, including distinct environments that each need an answer. It is not limited to repeated processing of the same occurrence.

Reproduction: `bun scripts/raise-limit-targets.mjs`. Report a base failure, then the same inherited failure on one head commit in 201 distinct environments. All reports are valid. Report that the base test passes on attempt 2. The needed revocation raises the cause once per environment, hits the limit and returns `internal: one command raised the question "shared outage" 201 times: stopped instead of going round`.

The base's new report remains durably `accepted`, its gate stays `pending`, and the head still reads `passed` with all 201 failures excused. The same result was first reproduced with 205 environments in `logs/explore-many-targets.log`; the smaller reproduction is in `logs/raise-limit-targets.log`. At the boundary, `bun scripts/explore-many-targets.mjs 200` succeeds, leaves `accepted:[]`, and correctly blocks the head with 200 unexplained failures (`logs/raise-limit-boundary-200.log`). This is finite, necessary work, not a decision cycle. It contradicts the report/recovery and inherited-expiry promises in departures 4, 6 and 8. A real HTTP run, `bun scripts/raise-limit-http.mjs`, also returns HTTP 500. After stopping that server, a new process on the same database exits 1 before listening because startup recovery repeats the same 201-raise error. `logs/raise-limit-http.log` records `restartExit:1`. This therefore prevents normal instance startup, not only one upload.

### R9-B03: recovery loses rebase invalidation when a commit was first reported in another scope

Blocking defect. `ensureTarget` updates a change's base during acceptance, but the list of changed bases exists only in `ctx.rebased`. Startup recovery creates a new context. If the new head was first reported without PR metadata, its canonical target belongs to another scope. Reprocessing that target does not recheck inherited decisions on the PR whose base changed.

Reproduction: `bun scripts/rebase-recovery.mjs`. Base A fails test one, base B passes it, and PR 1's old head inherits the failure from A. A newer commit is first reported by hash only. Then a report identifies that commit as PR 1's new head and changes its base to B. The script compares normal processing with durable acceptance followed by the actual `recoverAccepted` implementation.

The uninterrupted case ends `blocked`. The recovered case ends `passed` with `excused:1`, although the change now names base B and no batch remains accepted. `logs/rebase-recovery.log` records both. The inherited answer and its old dependencies remain in force indefinitely until another suitable report arrives. This contradicts departures 4 and 6, and the exact gate promise for any commit. `bun scripts/rebase-recovery-http.mjs` confirms it with a real server process: an HTTP upload is killed after durable acceptance, a second process recovers all 100,000 results, `remainingAccepted:0`, the new base passes, and the old head still reports `passed, excused:1, stale:false`. See `logs/rebase-recovery-http.log`. A second run independently repeats the crash and asserts `resultsAfter:100004` (the upload plus four setup results), while preserving the wrong gate (`logs/rebase-recovery-http-confirmed.log`).

### R9-B04: an unadmitted agent result changes the commit's gate

Blocking contract defect. An agent's failure is included in the cause-level inherited decision for the commit even when no planned run admits agents. It can revoke the pipeline's inherited excuse and turn the commit gate from passed to blocked.

Reproduction: `bun scripts/agent-changes-commit-gate.mjs`. A CI actor reports the base failing pipeline-test and passing agent-test. Its head report fails only pipeline-test and is correctly excused as inherited. An agent with only read/produce then reports agent-test failing with the same cause on the head. No planned run exists. The script separately repeats this without cases and with a case whose methods are only human.

Both variants print `before.verdict:"passed"`, `after.verdict:"blocked"`, and `plannedRuns:0`. The original pipeline evidence did not change. See `logs/agent-changes-commit-gate.log`.

Departure 3 explicitly says "What an agent reports never moves a commit's gate" and that such a question holds nothing; decision 0009 allows agent evidence to affect gates only when explicitly admitted. The round-8 fix's inclusion of all agent failures in inherited validation conflicts with that contract. Validation must still protect opted-in agent runs, as R8-B04 requires, while preserving the stated commit-gate boundary. This is separate from R9-B01, which permits a false passing release run.

## The tests do not prove this

### R9-T01: the inherited sequence check shares production's failing-test selector

Not a separate blocker from R9-B01. `test/sequences.test.ts:257` calls `failingWithCause`, then calls `failsOnBase` for only the tests it returns. Those are the same functions used by `inheritedNow`. A test omitted by the faulty selector is absent from both the implementation and its supposed check. The assertion also permits an empty set, although the new implementation explicitly requires at least one failure.

`bun scripts/inherited-oracle-gap.mjs` runs both R9-B01 variants and applies the author's inherited assertion to the resulting database. Both print `authorInheritedOracle:{tests:[1],wouldPass:true}` while both release slots are failing and test two passed on the base. This is a concrete false negative, not an inference from a passing suite. The 300 author seeds do not establish this property. An independent expectation must fold each effective agent lane, including jobs, skips, corrections and decisions, then check the base for the resulting tests.

The added round-8 integrity tests prove their specific original fixes. They do not generate a different-job or newer-skip agent update, 201 environments, or loss of `ctx.rebased` between acceptance and recovery. The live restart test proves ordinary staged-result recovery; it does not prove rebase metadata has a durable invalidation path. Those missing inputs are supplied by the new reproductions. I did not mutation-test every legacy test.

The older independent sequence checks are useful but limited too: two checks remain disabled in `state-remaining`, and `state-extended` still permits the removed fallback in its expected-result calculation. The new direct scope/base matrix supplies evidence for the fallback cases instead. Removing the witness-kind guard and the mistaken-answer key does fail the relevant author tests, so those earlier weaknesses remain fixed.

## Worth doing later

The declaration `Q.newestRunWithTest` remains in `runs.ts`, but there is no caller after fallback removal. `logs/inherited-source-search.txt` records the source search. Removing the dead query would make the intended rule easier to inspect; it is not a runtime defect. The known reader-latency issue #60 remains outside this review's performance scope.

## Cleanup and artifact integrity

Every live script stops its listeners and workers in `finally`; crash probes also await their child processes. All temporary source mutations are restored. `logs/export-integrity.json` compares all 404 tracked exported files to the specified Git revision and reports `mismatches:[],allExportedSourceRestored:true`. Final process, port and scratch cleanup is recorded in `logs/cleanup.json`. The shared worktree is untouched. No commit, push, or Git state change was made.

ISSUES (4 blockers)
