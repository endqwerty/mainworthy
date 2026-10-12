# Casebook engine QA review, round 10

Revision: `8482d113cda8b81d9187ee0a893824b673dcac1d`, branch `t3/mvp-product-delivery`.

Four blockers remain. A target limit can sign off a run while an omitted environment fails, and can select the wrong commit or repository. An unadmitted agent result can withdraw a person's answer and change a commit gate. A mistaken judgment can leave a newer run's gate inconsistent with its satisfied slots. The required lint check also fails.

I ran the code from a clean `git archive` export in `engine-r10/tree`, with Bun 1.4.3. The shared repository and Git state are untouched. I started no other agents. The engine author is Claude Opus 5.5; this verifier is Codex GPT-6 Astra. Reader threads were authored by GPT 6.1 Sol, so their checks provide functional QA rather than a different-provider signoff of that subsystem.

The correctness fact is that an excuse requires a recorded, applicable decision, and every gate must reflect all the evidence it admits after that decision. Human `inherited` judgments are limited to the answered target. Base-failure hints cannot change standing. Accepted reports remain pending until applied. The reduced inherited and recovery contracts pass the new targeted checks. The full engine does not satisfy the gate contract, as the findings below demonstrate.

Commands below run from this `engine-r10` directory unless `tree` is specified. Defect reproductions assert the observed wrong behavior and should fail after a fix. Dependencies are removed during cleanup; rerun `bun install --frozen-lockfile` in `tree` before reproducing. Logs and scripts are retained. No performance verdict is claimed.

## Twelve checks

| # | Check | Verdict | What I ran and deciding evidence |
| --- | --- | --- | --- |
| 1 | Author tests and architectural boundaries | issues | `python3 scripts/author-checks.py` ran the requested `bun test src test --path-ignore-patterns 'test/e2e/**'`, `bunx tsc --noEmit`, and `bunx biome check src test bench`. The tests print `581 pass`, `1 fail`, `16534 expect() calls`, `582 tests across 28 files`. The sole test failure is the excluded disk-budget test rejecting `/tmp` as tmpfs. Typecheck exits 0. Lint exits 1 on scoped `test/integrity.test.ts:421:60`, R10-B02. All required architectural violations fail the named boundary; a structural witness is rejected by TypeScript, although architecture tests alone pass. `logs/architecture-summary.log` and `logs/rerun-architecture-last.log` retain each mutation. Removing the witness-kind guard and mistaken answer key makes their tests fail. The sequence proof gap is R10-T01 below. |
| 2 | Standing changes and witnesses | pass | [STANDING.md](STANDING.md) lists every scoped standing statement, its decision path, projections, reversals and the four documented exceptions. `standing`, `round3`, `ledger-fk`, `foreign-keys`, and the architecture mutations execute the boundaries. Output includes wrong-kind refusals for link/excuse/close/policy, `noLedgerChanges:true`, seven missing-decision foreign-key refusals, and `foreignKeyViolations:[]`. Plain/prototype/reflective values and second mint claims fail. Undo preserves newer links, signoffs and producer corrections. The engine defects concern the decisions' effects and applicability, not an unrecorded writer. |
| 3 | Idempotency and atomicity | pass | `probes`, `new-probes`, `round3`, `live`, and `r10-recovery-failure`. Deciding output: `firstSeq:2,retrySeq:2`; changed operation/actor/project all conflict; `lateRollbackUnchanged:true`; `events:150,unique:150,first:2,last:151,failedCommandsConsumeSeq:false`. Instance replies replay; token-creating replies store `(reply not kept: it held a secret)`, retry conflicts and tokens=1. A 100000-result report has one batch, retryFresh=false. The recovery error injection rolls back the partial result before continuing with the next batch. |
| 4 | Edits never overwrite | pass | `probes`, `policy-supplements`, author suite tests. Stale disjoint edits print `merged preserving human pre`; same-field edits conflict. Delayed adoption merges again or returns conflict. Conflict resolution is one edit of one case by its author and still meets adopt policy; multi-case/policy attempts are refused. Restore creates version 5 with versions=5. Tags use adoption-time state. Folder-cycle attempt is invalid and the hierarchy remains unchanged. |
| 5 | Evidence and basis | pass | `probes`, `new-probes`, `round3`, `final-probes` and author evidence tests. Exact/assumed/unresolved basis cases, old-version same-claim obligations and project isolation pass. Invalid automated annotation is declined and stored unbound, fills no slot and still blocks the commit; invalid case-typed claim is rejected. Human methods are `[human,auto]`, pipeline `[auto,auto]`, agent `[agent,agent]`. Other-producer/target corrections are refused, closed snapshots preserved. `rows:100000,batches:1,retryFresh:false`. Empty reports and unpaired surrogates are invalid; clipped samples print `allWellFormed:true`. |
| 6 | Cause questions, decisions and holds | issues | Baselines `lifecycle`, `lifecycle-positive`, `fixed-r7`, target/undo probes pass their original cases. Output: `failedResults:500,questions:1,excused:500`; six environment orders, 36 decisions, `extraQuestions:0`; ledger chain `flaky → expired → defect`; stale evidence conflicts. `r10-rule-withdrawal` records the map-track clause and withdrawal, then prints `laterReportDidNotOverride:true`. The 24 new inherited combinations prove human target judgments, agent advice/refusal, no automatic failure rule and no base-hint authority. Load checks finish 501 environments and 501 causes across 75 plans with accepted=0. R10-B01 nevertheless invalidates a human answer from uncounted agent evidence; R10-B03 leaves a run stale after a cause decision. |
| 7 | Gates | issues | Pure verdict priority, unknown/skip/refused/agent-only pending, late/same attempts, jobs, producer isolation, forward-only head and expired-hold pending pass in `probes`, `round3`, `final-probes`, and `lane-matrix`. Live HTTP has 334 observations made while a report is accepted, all pending. Two process interruptions recover exactly 100001 rows, accepted=0 and retryFresh=false. `r10-recovery-failure` leaves only the bad batch pending while the server serves other gates. R10-B04 produces a false passed/closed plan and incorrect repository/prefix lookup; B01 moves the commit gate with an unadmitted agent; B03 leaves a stale blocked gate after all its slots are satisfied. |
| 8 | Runs and slots | issues | Pinned methods, basis and target checks; human-only and agent opt-in checks; closed-run refusal/correction snapshots; shared result filling two runs; multiple causes; and dispute retention pass. `lane-matrix` prints `4500` sequences, `13500` observations, `commitAndSlotAgree:true` for lane folding. R10-B04 drops the 201st matching target when a run is planned over existing results. R10-B03 refreshes the later run's slots but not its gate/signoff. Both reproduce through HTTP with readers=2. |
| 9 | Policy | issues | Direct permissions pass: `policy-matrix` executes 324 calls across all 15 operations, every answer, three presets and agent/CI/reader actors, with `probeErrors:0`. Applicable mistaken answers and conflict-author cases run separately. Standard agent self-adoption is forbidden, cases=0. CI cannot decide, readers cannot write, project-limited tokens get 403 for another project's operations/events and see only their project in session. Forgotten token returns 401; existing stream closes. Human inherited follows each preset, while agent is advised under loose/standard and forbidden under strict. R10-B01 remains an indirect way for a produce-only agent to change a person's decision and a commit gate. |
| 10 | HTTP | pass | `live`, `checkpoint-live`, author HTTP tests and source review of `serve()`. Local absent/same Origin=200; foreign/null/scheme/Host=401. Server-mode anonymous requests to all 15 operations, session and project events=401. Public health/OpenAPI and login/logout are the explicit exceptions; unknown route=404. Cookie has HttpOnly and SameSite=Strict; foreign-origin cookie use=401. Sized and chunked 65 MiB bodies=413, next ordinary request=200. Registry and OpenAPI expose 15 operations; no extra project-reading route is anonymous. |
| 11 | Concurrency and reader threads | pass | Functional QA only, with the provider limit stated above. `live` twice uploads 100000 results alongside 40 case writes: 41 unique command sequences, 42 contiguous event sequences, no lost/duplicated writes, and 167 reads completed during each open write. `readers-live`: 32 clients, 128 committed readbacks, 9 operations/27 replies/10 refusals match inline; denied reads never dispatch; worker writes are forbidden. All 80 requests survive a worker death, with 20 fallbacks. Shutdown awaits all workers, remaining=0. `checkpoint-live`: 574 writes while checkpoint thread lives, 80 after its death, all 654 survive restart; explicit readers=0 uses inline, 16-core default=8. This establishes correctness, not latency target #60. |
| 12 | Recorded departures | issues | All 18 dispositions appear below. Browser drafts and whole-instance transfer are explicitly not checked as subsystems, because the brief excludes them. The inherited feature removal matches departure 4, but departures 2, 3, 4, 8, 16 and 17 have the reported remaining contradictions. |

The author commands used temporary changes only for the required port range and `/tmp` data location. Those changes and all deliberate architectural mutations were restored before the source-integrity comparison. The one out-of-scope budget failure is not counted as a blocker. No browser or performance verification is claimed.

## Round-9 findings and earlier reproductions

All 84 runnable reproduction scripts from the round-9 bundle were run first. [EARLIER.md](EARLIER.md) gives every script's exit, disposition, actual result, obsolete assumptions and positive replacement. Raw outputs are under `logs/rerun-*.log`; `logs/rerun-summary.json` is the complete inventory. A failed old defect assertion is treated as a fix only after checking its actual result. A script stopped by removed machinery is marked no longer applicable, with current-contract variants where needed.

| Earlier item | Status | Deciding evidence |
| --- | --- | --- |
| R9-B01, agent job/skip falsely inherits | removed with its feature | Both current variants remain `blocked`, `unexplained:2`, run `open`, signoff null. No automatic inherited decision exists. See `logs/current-agent-lane-inherited.log`; the original HTTP probe also gets blocked instead of passed. |
| R9-B02, matrix raise guard and startup failure | fixed | The old HTTP error assertion now sees 200. New load checks complete 501 environments, leave `accepted:0`, and after one human target answer show excused=1/unexplained=500. 501 causes across 75 planned runs also finish and remain answerable. Recovery injection starts the server with gates `[passed,pending,passed]`, rolls back a partial result, logs the failure and processes the later batch. After repairing only the staged input and restarting: results=3, accepted=0, other reports not repeated. R10-B04 is a separate internal target-list limit. |
| R9-B03, lost rebase invalidation at recovery | removed with its feature | `rebase-recovery` prints blocked for uninterrupted and recovered paths. Actual HTTP interruption/restart recovers 100004 total rows and accepted=0; the old head is blocked instead of falsely inherited. No `ctx.rebased` or base-dependent decision remains. |
| R9-B04, agent report changes commit gate | fixed with a new problem | Original automatic-inherited setup now starts blocked, so its former path is gone. R10-B01 demonstrates the same prohibited influence through a human flaky answer instead. |
| R9-T01, shared inherited sequence oracle | removed with its feature | `failingWithCause`, `inheritedNow`, the dependency table and that sequence assertion are absent. R10-T01 below demonstrates different remaining omissions in the sequence checks. |

## Current inherited and recovery contract

`bun scripts/r10-inherited-contract.mjs` runs 24 combinations: all three presets against absent, unreported, passing, failing, self, foreign-repository, agent-only and stacked bases. Every initial head is blocked with no automatic failure decision. Only a counted failing base supplies the display hint. A person can answer inherited on a change even without that hint. CI is forbidden; agents only advise under loose/standard and are forbidden under strict. Human holds contain exactly `this-target` and the answered target. Another environment and another commit ask again; undo preserves the independently answered environment. Later base correction does not revoke the person's judgment.

A same-target report after a base-hint change prints `basisUnchanged:true,evidenceHashUnchanged:true,decisions:0,predicateRejected:true,removedTableAbsent:true`. The four remaining hold terms pass their boundary checks. Presets contain no failure rule. Source search finds the hint only in display evidence, with no removed dependency functions or table reachable. This is the intended reduced contract, not a stale dependency defect.

`r10-recovery-failure.mjs` injects an application error into the middle of three durably accepted local reports. The injected staged record has one valid result followed by an invalid test, so the check proves rollback after partial work. This is deliberate error-path coverage, not a claim that ordinary validated input can create that record. The server logs the error, retains that batch as accepted/pending, processes both surrounding batches and starts serving. Restoring the original staged input and restarting applies it once.

## Decision 0012 departures

| # | Verdict | Evidence and limit |
| --- | --- | --- |
| 1 | pass | Integer identities and project-relative refs match the implementation; cross-project cases are refused or declined. |
| 2 | issues | Effective lanes, same-attempt worse outcome, cause scopes and ordinary posthoc plans pass. R10-B04 truncates prior target admission; B03 leaves a planned gate inconsistent with its slots after a decision. |
| 3 | issues | Per-result methods and pinned human/agent eligibility pass. R10-B01 contradicts the explicit statement that an agent's reports never move a commit gate. |
| 4 | issues | The human inherited judgment, current-policy withdrawal and removed dependencies match the new description. Mistaken-result sharing works in the old cases, but R10-B03 fails to recompute a newer run reached by that judgment. |
| 5 | not checked | Browser drafts, storage and per-person device isolation are out of scope. Server sealing/adoption are checked under item 4. |
| 6 | pass | Durable pending horizon, 200-result slices, concurrent reads, restart replay and per-report recovery isolation all run successfully. No remaining rebase-dependent judgment exists. |
| 7 | pass | Named closed-run reports conflict; corrections preserve closed snapshots and affect open/later runs; reopening restores an answerable failure question. |
| 8 | issues | Four hold terms, expiry ledger, target/environment isolation, superseding answers and original closure cases pass. R10-B03 leaves a run stale when a decision changes its admitted results. |
| 9 | pass | Same case/change produces one review row; a different change produces a second. Patch-tree invalidation is deliberately deferred. |
| 10 | not checked | Whole-instance archive review is excluded. Its existing tests and an incidental foreign-key roundtrip ran, but are not a separate signoff of transfer. |
| 11 | pass | Fifteen registry operations have HTTP/OpenAPI routes. Streaming transfer remains separate as documented. |
| 12 | pass | OpenAPI describes inputs and generic reply envelopes. Detailed TypeScript reply types remain in core/api.ts; output schemas are explicitly deferred. |
| 13 | pass | Resolved conflicts create new proposals, require one case edit by the author and still meet adoption policy; later edits merge or conflict again. |
| 14 | pass | An invalid automated claim is kept unbound and returned in declined, cannot fill a slot and cannot hide its failure from the commit. Invalid case-typed claims are rejected. |
| 15 | pass | Unknown, skipped-only, rejected-only and agent-only commit evidence stays pending. A skip does not replace a pass/failure in the tested lane matrix. Overall gate correctness still fails for the separate admission and decision defects. |
| 16 | issues | Forward-only change head passes. The promise that a commit's gate is exact fails in R10-B04 when a requested repository is beyond the target limit. |
| 17 | issues | Canonical scope orderings, ordinary repo separation and own-repository base hints pass. R10-B04 guesses a repository for an ambiguous hash and reports no evidence for an explicitly requested repository after 200 earlier targets. |
| 18 | pass | Automated case:<n> keys are invalid before writes; a manual identity test fills only its own case. |

## Defects

### R10-B04: planning a run silently drops targets after the first 200 and can sign off a failed build

Blocking false-pass defect, confirmed twice through `invoke` and over HTTP with two reader threads (`logs/matrix-http.log`). Reproduction: `bun scripts/plan-omits-environments.mjs`. It asserts the observed defect.

Report one pinned case in 201 environments of the same commit: 200 pass, the final environment fails. The commit gate correctly reads `blocked`. Create a planned run for that commit, accepting all environments. It admits only the first 200 results, reads `passed`, and receives an automatic signoff. A second run accepting only the last environment reads `pending` with a missing slot, despite the existing failure.

Deciding output in `logs/plan-omits-environments-confirmed.log`: `admitted:200,reported:201`, planned gate `passed`, run `state:"closed",signoff:3`; the commit remains `blocked` with `unexplained:1`.

Cause: `evidence.ts` queries `targetsByCommit` and `targetsByCommitPrefix` put `LIMIT 200` on the target list before run/repository/environment filtering. `runs.targetsOfRun` treats this truncated list as complete when `fillFromPrior` admits prior results. Commit aggregation uses the unbounded target list, so the two public gates disagree. The same bounded helper also selects a repository for commit lookup.

`scripts/commit-target-cap.mjs` confirms two more consequences of the same limit (`logs/commit-target-cap.log`). After 200 passing environments in repository `app`, the same hash's failing report in `fork` is outside the selected rows: an unqualified gate wrongly guesses `app` and passes, while an explicitly named `fork` gate says no report exists. Likewise, an ambiguous seven-character prefix chooses a passing commit when the different, failing commit is after those 200 rows. No new blocker is counted for these manifestations of the same query defect.

This contradicts P3, checks 7 and 8, and decision 0012 departures 2 and 17: slots and signoff must reflect the evidence the run admits. A list-response pagination limit cannot safely limit this internal standing calculation.

### R10-B01: an unadmitted agent result withdraws a human flaky answer and changes the commit gate

Blocking contract defect, confirmed twice through `invoke` and over HTTP with two reader threads (`logs/r10-findings-http.log`). Reproduction: `bun scripts/agent-invalidates-flaky.mjs` from this directory. The script asserts the observed defect.

Create a planned run over two human cases. A pipeline fails case one and a person passes it, making its slot disputed. A person answers `flaky`; the commit gate passes. An agent with read/produce reports the same failure. The run does not admit agents and neither case declares them. Nevertheless, the human decision is ended as `outdated` and the commit gate becomes blocked. The spare case keeps the run open throughout.

Deciding output in `logs/agent-invalidates-flaky.log`: `before:"passed",after:"blocked",agentSlotFills:0,countedResultsUnchanged:true`. The ledger gains `{"is":"outdated"}` superseding the person's `flaky` decision. `scripts/r10-agent-dispute.mjs` also demonstrates the admitted-agent variant.

Cause: `runs.applyBatchSteps` builds a failure group for the agent with `disputed:false` because it filled no slot. `decisions.raiseFailure` puts that batch-local dispute flag into the cause's material basis. `raise` treats the changed basis as grounds to end the existing human decision and recomputes the commit gate. The counted pipeline/person results did not change.

This contradicts decision 0012 departure 3, "What an agent reports never moves a commit's gate", and the agent-admission boundary in decision 0009. Removing inherited dependencies did not remove this other path through cause-level decision invalidation.

### R10-B03: changing an older answer to mistaken leaves another planned run's gate stale

Blocking correctness defect. Reproduction: `bun scripts/mistaken-stale-plan.mjs`. Confirmed first by the extended sequence checker, then reduced to ordinary calls through `invoke` and reproduced over HTTP with two reader threads (`logs/r10-findings-http.log`).

Create a run over all environments of a commit. A failure and another person's pass dispute one slot in production. Answer `infra` for production. Report the same dispute in staging and pass the spare case. Create a second run over staging only. Change the original production answer to `mistaken`.

The decision discounts the shared failing results in both runs. Both staging slots become `satisfied`, but the staging run is not recomputed: its gate still says `blocked`, `disputed:1`, and names the old failure question. The run remains open instead of receiving the normal passed-run signoff. Output in `logs/mistaken-stale-plan.log` shows slot `rev:16` with `state:"satisfied"`, while the run stays at `rev:15` and its previous gate.

Cause: `discountFailures` refreshes every slot holding a discounted result, including slots in newer runs that the old question never named. `refreshSlotById` does not add those runs to `ctx.recompute`. `settle` gathers `runsShowing` after the discount removed the original cause, so it also misses this run. The later run's original question cannot repair the stale projection by being read.

This contradicts decision 0012 departures 2, 4 and 8, which require decisions to reach every run using the result and recompute their gates in the same transaction. `scripts/state-current.mjs` found the first occurrence at seed 72 after enabling the two assertions disabled in the inherited round-9 checker. The 300 author seeds still pass.

### R10-B02: the required lint check fails in the scoped integrity tests

Blocking delivery check failure. Reproduction: `bash scripts/lint-check.sh`. Both the full check and a second independent invocation exit 1.

Deciding output: `test/integrity.test.ts:421:60 lint/correctness/noUnsafeOptionalChaining`, `Unsafe usage of optional chaining`, `Found 1 error.` The expression casts the result of `find(...)?.evidence`, then reads `.hints` outside that optional chain. Biome also reports three unused-import warnings left by the deleted inherited tests. See `logs/lint.log` and `logs/lint-confirmed.log`.

This is in scope and prevents the required `bun run check` from passing. The one excluded budget failure is separately noted and is not counted here.

## The tests do not prove this

### R10-T01: the sequence audit accepts the demonstrated wrong states

This is a proof gap supporting the application defects, not an additional blocker count. I reran the author's exact requested command in `tree`: `CASEBOOK_SEQUENCE_SEEDS=300 bun test test/sequences.test.ts`. It prints `3 pass,0 fail`, 300 seeds per policy, 80 steps per seed. The older independent checkers also complete with 80/8000, 80/12000 and 60/7200 seed/check counts and zero reported problems. These outcomes are not proof of the missing properties.

I copied the current author's `scopeOf` and `audit` function unchanged into three review scripts, supplied the same database query helper, and ran it on each reduced application defect. `oracle-agent-invalidates-flaky.ts`, `oracle-mistaken-stale-plan.ts`, and `oracle-plan-omits-environments.ts` all print `authorSequenceAudit:null` while separately asserting the wrong public result. Their matching logs retain the full evidence. This is a demonstrated false negative, not speculation from a passing random run.

The comment at `test/sequences.test.ts:16` promises a planned run's tally equals what its slots give. The body at 193–226 only compares each open slot's state with its admitted results. The earlier run loop recomputes tallies only for change runs. It never independently tallies planned slots, so a stale blocked run with two satisfied slots passes. It also compares a stored verdict with its own stored tally, which cannot expose two mutually consistent stale values. R10-B03 exercises exactly that gap.

The audit has no before/after invariant that an agent upload leaves commit standing unchanged. It also starts its slot checks from already admitted rows rather than checking admission completeness against every matching target; therefore the 201st omitted environment and the automatic signoff escape it. The generator uses only two environments, so adding seeds alone cannot reach that bound. The new reproductions cover these inputs directly.

The old `state-remaining.mjs` contains two disabled checks. `state-current.mjs` enables them and uses the canonical repository scope. It prints `seeds:80,steps:11987,checked:11986,problems:1`, with seed 72 failing because a gate omits the current failure question. The saved trace and replay lead to R10-B03. The reduced case also exposes the simpler stale tally, which the author's audit misses. The removed inherited check in `state-extended` is now vacuous and was not treated as proof of person-judgment behavior.

Architectural mutation checks and the witness-kind/mistaken-answer regressions do fail when their tested behavior is removed. A plain object witness is a compile-time boundary, not an architecture-test assertion. I did not mutation-test every legacy example test.

## Worth doing later

The round-9 unused `Q.newestRunWithTest` and `scopeOfRun` declarations are gone. No further runtime defect was found in that cleanup. The known reader-latency issue #60 remains outside this correctness review. The scripts for the new boundary inputs and sequence assertions should remain in future verification runs after the four blockers are fixed.

## Cleanup and artifact integrity

All 404 tracked exported files match the specified Git revision: `mismatches:[],allExportedSourceRestored:true` in `logs/export-integrity.json`. Every temporary source mutation was restored. Live scripts stop their servers and workers in finally blocks, and crash probes await their child processes. The final check in `logs/cleanup.json` records no owned processes, no listeners on ports 8150–8199 and no remaining owned `/tmp` data. Only the export's node_modules, .casebook and test-results paths were released. The shared repository and Git state are untouched. No commit or push was made.

ISSUES (4 blockers)
