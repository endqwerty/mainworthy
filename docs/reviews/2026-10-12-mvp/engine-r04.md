# Casebook engine verification, round 4

Revision: `cb8e9a3659aa326d894e89250d90e0d61f588d60`, branch `t3/mvp-product-delivery`.

Verifier: Codex, GPT-6 Astra. Source exported with `git archive` into `engine-r4/tree`; dependencies installed with `bun install --frozen-lockfile`. The shared repository is not edited. Run project checks in `engine-r4/tree`, and `bun scripts/...` or `python scripts/...` from `engine-r4`. Reinstall the export with `bun install --frozen-lockfile` if its dependencies have been released.

Status: Review complete.

The correctness claim is that gates and current standing derive only from admissible evidence and recorded, authorized decisions. Conflicting, incomplete, late, or unrelated evidence must not silently produce a passing gate.

## Twelve checks

| # | Check | Verdict | What ran and deciding evidence |
| --- | --- | --- | --- |
| 1 | Author tests and architecture mutations | issues | Required broad command with export-only port/data fixture adjustments: 552 pass, 1 out-of-scope budget test cannot run on mandated /tmp because it is tmpfs; 16,402 assertions (logs/author-tests.log). tsc exits 0; Biome checks 176 files, no fixes. Upward imports, extra mint caller, wrong-owner/raw SQL, ignored witness and other module/registry mutations fail their intended checks. Plain Witness fails tsc for missing private fields. Removing the kind guard now fails the named author test. R4-T01 confirms remaining test-strength gaps, including a deleted answer key that the completeness test accepts. |
| 2 | Standing changes and witnesses | pass | STANDING.md inventories every scoped head/body/placement/link/excuse/signoff/policy/cover/corrected/discounted writer and traces its decision path or documented exception. Runtime constructor/prototype/plain-object/second-mint probes and genuine wrong-kind witnesses are refused; structural Witness fails tsc. Link/excuse/signoff undo preserves newer decisions; mistaken undo preserves the producer's later correction. Ingest expiry now records a lapse row. See logs/scripts-standing.mjs.log, scripts-round3.mjs.log, scripts-lifecycle.mjs.log and architecture logs. Genuine decisions can still have the wrong evidence/scope/producer authority, detailed separately in R4-B01/B02/B06. |
| 3 | Idempotency and atomicity | pass | scripts/probes.mjs and new-probes.mjs: same command returns seq 2 twice and writes one case; actor/op/project reuse conflicts; late claim failure leaves audited tables unchanged; 150 events have 150 unique contiguous seqs 2..151. Instance creation replays; a token-producing command refuses replay, keeps no secret, and creates one token. Live uploads preserve 40 writes/42 contiguous events and crash retries duplicate no results. |
| 4 | Edits never overwrite | pass | scripts/probes.mjs and policy-supplements.mjs: disjoint stale edits merge, same fields conflict, delayed resolution retains newer preconditions, restore produces version 5 with five immutable versions, queued tags end [agent,human], strict resolution makes a reviewable proposal, unauthorized/multi-edit resolutions fail, descendant folder move is invalid without creating a cycle. |
| 5 | Evidence provenance and report inputs | issues | Independent probes show exact/assumed/unresolved=1/1/1, invalid manual claims rejected, declined automated failures kept unresolved and blocking the commit while filling no slot. Methods per human/CI/agent batch are human+auto/auto+auto/agent+agent. Foreign refs and invalid corrections refused. 100,000-result retry keeps one batch and 100,000 rows; empty keys/reports and lone surrogates refused, actual emoji clip boundaries stay well formed. The corrected result is removed from existing/later runs, but the inherited reader still uses it, R4-B01; same-attempt replacement also violates the requested retention rule, R4-B03. |
| 6 | Questions, holds and decisions | issues | 500 failures share one question; one decision excuses all 500 and carries. Distinct frames with the same text remain separate. All hold terms and time boundaries exercised. Ingest-first expiry adds expired once, sweep is a no-op and the next answer supersedes it; sweep-first expiry also records the chain. Target changes invalidate old answers; rule withdrawal persists. R4-B04 dissolves a live planned failure's question; R4-B05 reasks a still-covered target; R4-B06 loses producer constraints on carry/reask. Logs/scripts-lifecycle.mjs.log, scripts-support.mjs.log, lifecycle-r4-confirmed.log, policy-r4-confirmed.log. |
| 7 | Gate soundness | issues | Pure verdict priority, unknown commit, skips/refused/agent-only pending, forward-only change heads, old attempts, separate jobs/producers, expiry-before-sweep pending all pass baseline probes. Live reports prove pending throughout durable acceptance and recovery after two crashes. R4-B01/B02 create passing gates from inapplicable excuses; B03 lets an equal CI attempt clear a failure; B04 leaves a blocked planned gate without a question. The documented older-commit infra exception remains conservative: old commit blocked, current change passed, no old prompt. It makes no false claim of old proof. |
| 8 | Runs and slots | issues | Target/basis/method admission, pinned methods, human-only slots, explicit agent opt-in plus case permission, min-actor/dispute retention, every cause, two-run sharing and closed correction snapshots pass original probes. New-plan correction backfill and joining existing failure questions now work. R4-B02 permits later cross-repository admission with one scope, B03 replaces an equal attempt, B04 lets evidence excluded from an agent-only run dissolve its question, and B06 admits a producer's own disputed-result decision. |
| 9 | Policy and authorization | issues | policy-matrix.mjs runs 324 real operation/answer invocations across loose/standard/strict and agent/CI/reader, with zero probe errors and clause selectors checked. policy-supplements.mjs covers valid mistaken answers, conflict author rules, agent self-adoption and same-claim admission. Live project scoping, session lists, event streams and revocation pass. R4-B06 bypasses notProducer through incomplete producer history when a decision is carried or a previously decided cause becomes disputed. |
| 10 | HTTP surface | pass | Real listeners: local same/no Origin 200; foreign/null/scheme/Host 401. Server unauthenticated session/events and all 15 operation routes return 401; every registry route is in OpenAPI. Cookie is HttpOnly/SameSite=Strict and cross-origin cookie calls return 401. Other-project scoped reads/events return 403. Sized and chunked 65 MiB bodies return 413, next ordinary request succeeds. Public handlers match serve()'s list. Logs/live.log, checkpoint-live.log, scripts-final-probes.mjs.log. |
| 11 | Concurrency and reader threads | pass | Two live 100,000-result uploads each preserve 40 simultaneous writes, 41 unique command seqs and 42 contiguous events; 371 accepted-state gate reads are all pending. Two SIGKILL/restart cycles recover exactly 100,001 results and retry adds none. Readers: 128 read-after-write observations, 27 inline/worker replies across 9 ops with 10 refusals, denied requests never dispatched, worker writes forbidden, all 80 requests survive a killed worker, shutdown awaits every worker. Checkpoint alive for 618 commits; 80 more after termination; all 698 survive restart. Inline=0 works; default at 16 cores is 8. No performance verdict. Logs/live.log, readers-live.log, checkpoint-live.log. |
| 12 | Documented departures | issues | All eighteen departures are assessed below. Concrete defects contradict 2/3/4/8/17; the report slice size is 200 versus the stated 500, R4-N01. Other inspected in-scope departures behave as described. Browser persistence (5) and archive implementation (10) remain explicitly not checked because the brief excludes them. Older-commit infra behavior is conservative and documented, not a defect. |

## Round 3 findings

| Finding | Status and evidence |
| --- | --- |
| R3-B01 | fixed with a new problem: existing plan, commit gate and later plan all pass after the accepted lower-attempt correction (logs/scripts-new-probes.mjs.log). R4-B01 finds the corrected failure still used as base evidence. |
| R3-B02 | fixed: another job and another environment leave the slot failing and the gate blocked (logs/scripts-round3.mjs.log). |
| R3-B03 | fixed in the original reproduction: the new plan lists Q-2, and answering flaky changes its gate from blocked to passed (logs/scripts-round3.mjs.log). |
| R3-B04 | fixed with a new problem: separate trunk commit gates now use line:trunk@a and line:trunk@b. A planned run created before either report still applies a's excuse to b's evidence, R4-B02. |
| R3-B05 | fixed: ingest records expired superseding the flaky decision; sweep returns 0 and only Q-3 remains open (logs/scripts-lifecycle.mjs.log). |
| R3-B06 | fixed: undo leaves the producer's corrected flag at 1 and the corrected slot passing (logs/scripts-lifecycle.mjs.log). |
| R3-B07 | fixed: strict map/create returns an accurate instruction to propose, adopt and link; no missing proposal is claimed (logs/scripts-lifecycle.mjs.log). |
| R3-B08 | fixed: the target change changes evidenceHash; the old infra answer conflicts and both failing gates stay blocked (logs/scripts-final-probes.mjs.log). |
| R3-B09 | fixed: the established stream closes after forgetting, sends no event and a fresh request returns 401 (logs/scripts-final-probes.mjs.log). |
| R3-B10 | fixed in the original reproduction: agent base results are excluded and the CI head stays blocked (logs/scripts-final-probes.mjs.log). |
| R3-B11 | fixed in the original reproduction: an unrelated repository's trunk does not produce inherited and the head stays blocked (logs/scripts-final-probes.mjs.log). |
| R3-T01 | fixed: removing the witness-kind guard now makes the named author test fail (exit 1), as does the independent genuine-witness probe; source restored (logs/test-strength.log). |
| R3-T02 | fixed: the author now asserts the token count value; the independent replay probe also observes tokens:1 (logs/scripts-new-probes.mjs.log). |
| R3-N01 | fixed: brief and implementation now agree; readerCount({},16) returns 8 and inline 0 works (logs/checkpoint-live.log). |

## Round 1 reproduction results

| Finding | Status and evidence |
| --- | --- |
| R1-B01 | fixed: merge-multi-case-and-policy returns forbidden; policy stays loose and the unrelated case stays active. |
| R1-B02 | fixed: mixed-methods-all-actors records human+auto, auto+auto and agent+agent; agent-only evidence does not fill default slots. |
| R1-B03 | fixed: target-bypass returns invalid and the named planned slot remains missing. |
| R1-B04 | fixed: skips-and-red-to-green preserves the failed gate; refused-only and no-proof gates remain pending. |
| R1-B05 | fixed: retryFresh:false leaves the change on its newer blocked run. |
| R1-B06 | fixed with a new problem: multiple tests and older attempts retain the failure; R4-B03 replaces it at an equal attempt. |
| R1-B07 | fixed: cross-target correction is rejected; same-target corrections update open runs while preserving the closed snapshot. |
| R1-B08 | fixed with a new problem: only the selected target is excused; R4-B05 later reasks an already-covered target. |
| R1-B09 | fixed: live scoped session contains only scratch, other-project reads/events return 403, forgotten token returns 401. |
| R1-B10 | fixed: delayed resolution retains newer preconditions; queued tags finish [agent,human]; unresolved overlapping fields conflict. |
| R1-B11 | fixed: the descendant-folder move returns invalid and the hierarchy remains acyclic. |
| R1-B12 | fixed with a new problem: repository-specific changes and commit gates stay separate; R4-B02 crosses them inside an early unqualified plan. |
| R1-B13 | fixed: the slot pinned to human-only version 1 remains missing after the head admits agents. |
| R1-B14 | fixed: conflicting manual annotation is refused and manual test case_id stays 1. |
| R1-B15 | fixed: plain/prototype witnesses, reflective constructor calls and a second mint are refused; structural Witness also fails tsc. |
| R1-B16 | fixed: undoing the old map leaves the newer case_id at 2. |
| R1-B17 | fixed: the original 300-case probe returns 200 then 100; the interleaved cursor probe reads all 300 over four pages. |
| R1-B18 | fixed: op/actor/project command reuse conflicts, instance writes replay, and secret-bearing replies are withheld with one token row. |
| R1-B19 | fixed: required job is processed; the existing gate and a plan made afterward pass. |
| R1-N01 | fixed: expiry records expired superseding flaky, then the new answer supersedes expired. |
| R1-N02 | fixed: different scheme returns 401 in local mode and with the session cookie. |
| R1-N03 | fixed by an explicit contract: serve() lists health/OpenAPI/login/logout as public; project operations, session and stream require a token. |
| R1-N04 | fixed: empty and whitespace-only test keys return invalid before storage. |

## Round 2 reproduction results

| Finding | Status and evidence |
| --- | --- |
| R2-B01 | fixed: three reflective constructor calls, prototype object and second mint claim are refused. |
| R2-B02 | fixed: keyed agent evidence neither proves the default commit gate nor replaces the pipeline failure; explicit agent plans can pass. |
| R2-B03 | fixed: a slot retains every distinct cause and stays blocked after only one is excused. |
| R2-B04 | fixed: later skip leaves the planned slot disputed and its gate blocked. |
| R2-B05 | fixed with a new problem: qualified gate/impact and plans over existing reports choose the right repository; R4-B02 admits later evidence across repositories. |
| R2-B06 | fixed: automated case:1 is rejected atomically; valid manual C-1 then fills only its own slot. |
| R2-B07 | fixed with a new problem: a passing subset plan preserves the commit failure question; R4-B04 finds the reverse method-specific case. |
| R2-B08 | fixed with a new problem: infra excuses only production and immediately reasks staging; R4-B05 reasks production after both have valid answers. |
| R2-B09 | fixed: folder-filtered search returns C-301 with count 1. |
| R2-N01 | fixed: full commit and unambiguous prefix both pass with two environments. |
| R2-N02 | fixed: the live reader probe observes denied:403 with zero worker dispatch. |

## Decision 0012: each departure

| # | Verdict | Evidence against the stated departure |
| --- | --- | --- |
| 1 | pass | Actual invoke/HTTP records use integer database identities and project-relative C-/T-/P-/Q-/R- refs. Foreign refs remain isolated. |
| 2 | issues | Change tests and planned slots preserve separate jobs/environments and all causes in the original probes. R4-B02 crosses scope inside a plan, B03 lets an equal attempt replace a failure, and B04 leaves an unexplained slot with no question. |
| 3 | issues | Mixed-result methods, pinned-case eligibility and positive agent opt-in pass. R4-B04 removes the question for a still-counted agent failure when a pipeline reports a pass excluded by the plan. |
| 4 | issues | Inherited and mistaken exist and record decisions. R4-B01 supplies obsolete base facts to inherited; B06 lets a producer settle their own disputed failure under a notProducer clause. |
| 5 | not checked | Browser draft persistence is excluded. The server's sealed-proposal behavior was exercised, without approving device persistence. |
| 6 | issues | Two durable transactions, live pending horizon, yielding and recovery pass. The constant is 200 results, not the documented 500; R4-N01 is nonblocking. |
| 7 | pass | Closed named runs refuse reports. Valid same-target correction changes only open runs and later plans; the closed slot remains its old result. The separate base-hint reader defect is R4-B01. |
| 8 | issues | All four hold terms, ingest/sweep expiry chains and changed-target stale-answer conflicts pass. R4-B05 forgets a still-valid target answer and B04 dissolves a live cause's only question. Older commits remain blocked without a new prompt after a newer commit's infra decision, exactly as documented; current-gate proof remains conservative. |
| 9 | pass | Real claim twice on one case/change across two commits produces one review; changing the change key produces a second. Patch-hash invalidation is explicitly deferred. |
| 10 | not checked | Archive/transfer implementation is excluded. Its tests ran in the broad baseline, but this review gives no independent archive correctness verdict. |
| 11 | pass | All fifteen operations exist in the registry, HTTP routes and generated OpenAPI. Deferred announce/attach/trace are absent. Anonymous and scoped route checks pass. |
| 12 | pass | Generated OpenAPI describes inputs with generic reply envelopes. src/core/api.ts carries TypeScript reply types. Operation-specific response schemas are not claimed. |
| 13 | pass | Resolving a conflict makes a new proposal; strict leaves adoption pending. Newer independent edits survive, overlaps conflict, multi-edit/policy resolutions are refused and actor policy applies. |
| 14 | pass | Bad manual case claims are rejected. Bad automated claims are stored with unresolved basis and declined reasons, cannot fill a slot, and still affect the commit gate. |
| 15 | pass | Unknown/no-proof/skips-only/refused-only/agent-only gates stay pending. A later skip cannot replace a pass/fail in commit or slot probes. |
| 16 | pass | A late old report leaves the change gate on its newer blocked commit; exact old-commit lookup remains available. |
| 17 | issues | Repository-specific PR keys, exact gates, impact, trunk scopes and base repository filters pass original probes. R4-B02 finds an unqualified early plan that later admits both repositories and applies one excuse across them. R4-B01 reads base results that the gate no longer counts. |
| 18 | pass | Automated case:1 is invalid before inserting anything; manual C-1 then records exact basis and fills its own slot. |

## Defects

### R4-B01: The inherited rule uses a corrected or obsolete base failure

Blocks: yes.

Run `bun scripts/round4.mjs corrected-base-inherited` from engine-r4. A CI producer reports the base failing at attempt 2, then sends an accepted passing correction at attempt 1. The base gate is passed. Reporting the same test failing on a new change produces `head.verdict:passed`, with `answer:inherited` and clause `failure-on-base`, although the only base failure was withdrawn by its producer. Reproduced in logs/round4-first.log and logs/round4-confirmed.log.

`src/server/evidence/evidence.ts:300` selects the highest-attempt raw result without applying corrections. The trunk fallback at :294 instead selects the last arrival without respecting attempts; `late-base-fallback` independently makes a passing trunk gate excuse a new failure using a late obsolete failure. The base predicate must use effective evidence under the same rules as the gate. This contradicts P3, check 7 and departure 17's promise that the base hint reads only results a gate would count. The direct correction fold fix in R3-B01 is insufficient for this caller.

### R4-B02: An early planned run applies one repository's excuse to another repository

Blocks: yes.

Run `bun scripts/round4.mjs posthoc-multi-repository-scope`. Create C-1 and a plan accepting commit sameforkcommit before any report. Repositories a and b then both report that commit failing with the same cause at C-1@1. Answer only a's question flaky. The planned gate changes from blocked to passed and closes; b's commit gate remains blocked. The slot still holds both causes `[[1,1],[1,2]]`, and the only excuse is `line:trunk@a`. The b question remains open and names the now-passing planned run. Logs/round4-confirmed.log contains the reproduction.

`src/server/runs/runs.ts:863` checks ambiguity only when the plan is created. Its unspecified repository continues admitting later repositories. `scopeOfRun` at :702 takes the first target's scope, and retally at :748 applies that scope to every cause. Recheck repository ambiguity as evidence arrives, pin an unambiguous repository, or classify each admitted target in its own scope. This contradicts P3 and departures 2 and 17. The original R3-B04 trunk-to-trunk reproduction is fixed; the planned-run path still crosses repositories.

### R4-B06: Question producer tracking lets a producer settle a decision that requires someone else

Blocks: yes.

Run `bun scripts/policy-r4.mjs decided-failure-loses-producer-on-dispute`. Under standard, leave a two-case planned run open, report C-1 failing as actor 2, and excuse it flaky. Actor 3 then passes C-1, producing a dispute. The new question says it requires someone who did not produce the evidence, but `evidence.producers` is only `[3]`. Actor 2 can answer `mistaken`; it is decided and actor 2's own failure is discounted.

The second scenario, `strict-carried-answer-producer-may-redecide`, reproduces the same loss on carry. Under strict, actor 3's failure is excused by the owner. Actor 4 reports the same cause in another job. Its answer is carried without adding actor 4 to the stored producers. Actor 4 can then replace the failure answer with infra despite strict's notProducer rule. Both scenarios reproduce in logs/policy-r4-first.log and logs/policy-r4-confirmed.log.

`src/server/ops/writes.ts:235` merges previous producers only while the previous question is open. Groups created from an existing slot failure may contain no newly failed result, so the reasked question records only the latest passing actor. `decisions.raise`'s carried path at :154 updates refs/counts without the producer evidence. `failureHandler.isProducer` at decisions/kinds.ts:367 trusts that incomplete list. This contradicts P5 and check 9: authorization must use every producer of the evidence the decision will change.

### R4-B03: A second report for the same CI attempt replaces a failure with a pass

Blocks: yes.

Run `bun scripts/round4.mjs same-attempt-replaces-failure`. One CI actor sends fail and then pass for the same test, commit, job and attempt 1. Neither result corrects the other. Both the commit gate and the planned gate become passed, the failure question dissolves and the planned run closes. Both result rows remain, each with `attempt:1,corrects:null`. Reproduced with a CI actor in logs/round4-confirmed.log.

The upsert in `src/server/runs/runs.ts:157` permits `excluded.attempt >= run_tests.attempt`; `src/core/runs.ts:154` resolves equal attempts by arrival order. A genuine newer attempt may replace a prior attempt under departure 2, and an explicit producer correction may withdraw an erroneous result under departure 7. This reproduction has neither. It contradicts the explicit check-7 requirement that a repeated attempt cannot turn a failing gate green and P3's prohibition on a later write hiding a failure.

### R4-B04: A CI pass dissolves the only question for an agent failure still blocking a planned run

Blocks: yes.

Run `bun scripts/lifecycle-r4.mjs agent-slot-question-dissolved-by-ci-pass`. Create a case admitting agents and a planned run accepting only agent results at agentq01. An agent reports an exact failure, producing an open question and a blocked planned gate. A CI actor then reports the same test passing. That CI result cannot fill the agent-only slot, yet it dissolves the question. The planned gate stays `blocked,unexplained:1,open:[]`, the inbox is empty, and answering the former question returns `conflict: this question no longer applies`. Reproduced in logs/lifecycle-r4-first.log and logs/lifecycle-r4-confirmed.log.

`src/server/decisions/decisions.ts:571` lets the commit's passing test dissolve the scope's question without checking planned runs whose admitted evidence still fails. The two gates admit different producer methods. This contradicts P3/P4, checks 6–8 and departure 2's promise that a failure blocking a run has an answerable question. It extends the earlier subset-run and post-hoc-plan question defects to method-specific planned evidence.

### R4-B05: A valid target-specific answer is forgotten when another environment has the newest question

Blocks: yes.

Run `bun scripts/lifecycle-r4.mjs infra-two-answers-and-return`. Report the same cause in staging and production at twoenv01. Answer infra for production, then the automatically reasked staging question. Both excuses remain valid and the gate passes. A further production result on attempt 2 opens Q-4 for the same already-decided cause. Its gate still passes with two excused failures, but the inbox asks the person to decide production again. The original production decision cannot be withdrawn through its old question either: undo returns a conflict directing the caller to Q-4. Reproduced in logs/lifecycle-r4-first.log and logs/lifecycle-r4-confirmed.log.

`src/server/decisions/decisions.ts:131` looks only at the latest question epoch. It sees staging's target hold and never finds production's still-standing answer, although both target-specific excuses exist. Carrying a valid answer must consider the occurrence's target. This violates P4, the F4 floor against asking a question with a valid answer, and check 6's decide-once requirement.


## The tests do not prove this

### R4-T01: Several author tests still prove less than their names claim

Blocks: no.

The round-3 witness-kind and token-count tests are fixed. Earlier coverage gaps remain in other tests.

- `test/policy.test.ts:47` checks only values present in ANSWER_KEYS. `python scripts/test-gaps.py` removes the mistaken key from the export; the named completeness test still reports `1 pass, 0 fail, 22 expect() calls`. The script restores the source. Compare the answer schema's variants to the keyed answers, or name the intended partial mapping.
- `test/suite.test.ts:61` checks the number of folders rather than created cases in the command replay test. The bulk move test at :158 never counts the proposals or decisions its name promises. Independent scripts/probes.mjs and the live sequence checks cover real replay cardinality.
- `test/http.test.ts:324` starts only once in the test promising token generation only on first startup. `test/evidence.test.ts:329` simulates interrupted acceptance in memory and calls recovery directly; it does not restart a process. This review's two live SIGKILL/restart cycles independently verify crash recovery.
- `test/http.test.ts:592` converts any streamed fetch rejection into 413. The independent live check receives an actual 413, so the implementation passes the body-limit check despite that weaker assertion.

These are test-coverage findings, not additional implementation blockers. logs/test-gaps.log and logs/answer-key-test-mutated.log contain the mutation evidence.


## Worth doing later

### R4-N01: The documented report slice size differs from the implementation

Blocks: no.

Decision 0012 departure 6 says slices contain 500 results. The exported `SLICE` is 200, used by applySteps and applyBatchSteps; the real import in logs/slice.log prints `{"SLICE":200}`. The accept/apply behavior and crash recovery pass. Update the description to match the code; this is not a performance finding.


## Review notes

Original round-1/2 scripts were rerun. Their obsolete expectations stop at the newly intentional automated-claim decline, target refusal, removed Witness.mint, pending-empty verdict, reserved-key rejection, or changed HoldTerm shape. Current equivalent probes exercise those paths with the revised contracts; fixture failures are not product defects. All observations in this report were obtained from this exact export.

The broad author suite's seven initial failures were review-environment issues: six nested-server port collisions caused by my first port remap, and one excluded budget test that refuses tmpfs. After fixing the remap, 552 tests pass and only the budget's explicit tmpfs refusal remains. No product failure is inferred from those fixtures. The budget check is not a performance approval.

The round-1/2 status tables summarize reruns in logs/r1-scripts-*.log and logs/r2-scripts-*.log, with revised-contract equivalents in logs/scripts-probes.mjs.log, scripts-new-probes.mjs.log, scripts-round3.mjs.log, scripts-lifecycle.mjs.log and scripts-final-probes.mjs.log. HTTP and worker findings were exercised on real listeners in logs/live.log and readers-live.log. The new defects have two confirming runs each.

Final export integrity: all 468 tracked files and symlinks compare equal to git archive of the judged revision; no source mutation remains (logs/export-integrity.json). The user-specified ports 7650–7699 take precedence over the older port range in the brief. The shared checkout was used only for read-only export and comparison.

Cleanup completed: no review Bun/Node process remains and no listener remains on ports 7650–7699. All review-prefixed /tmp data and the six identified CLI fixture directories from the first failed test setup were removed. Evidence: logs/cleanup.json. Reproduction scripts, logs and this report remain in engine-r4; the shared repository was not changed.


ISSUES (6 blockers)
