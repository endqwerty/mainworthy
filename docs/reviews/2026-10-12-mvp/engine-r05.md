# Mainworthy engine verification, round 5

Revision: `310eddfd23aadcbd7a1f88c33174f8c7501b08c6`, branch `t3/mvp-product-delivery`.

Verifier: Codex, GPT-6 Astra. Independent of the engine author, Claude Opus 5.5. Reader-thread authorship is Codex; those checks are performed here as requested, without claiming cross-provider independence for that subsystem.

Status: Review complete. Seven blocking defects and one non-blocking reader defect were confirmed. The original six round-4 reproductions are fixed; their wider interactions still have defects below.

Source exported with `git archive`; all execution is in `engine-r5/tree`. Dependencies installed with `bun install --frozen-lockfile`. This review made no changes to the shared repository. Reproduction commands run from `engine-r5`. After dependency release, first run `bun install --frozen-lockfile` in `engine-r5/tree`, then return to `engine-r5` for the scripts.

The correctness claim is that gates and standing derive only from admissible evidence and authorized recorded decisions. Missing, contradictory or unrelated evidence must not silently produce a passing gate.

## Twelve checks

| # | Check | Verdict | What ran and deciding evidence |
| --- | --- | --- | --- |
| 1 | Author tests and architecture rules | pass | `python scripts/author-checks.py` runs the required broad Bun command, tsc and Biome. `563 pass`, `1 fail`, `16549 expect() calls`; the sole failure is the excluded disk-budget test refusing mandated `/tmp` because it is tmpfs. Typecheck exits 0; Biome reports `Checked 176 files ... No fixes applied`. Every requested architecture mutation fails its intended check; a structural Witness is rejected by tsc for missing private fields. Sources restored. See `logs/author-tests.log`, `typecheck.log`, `lint.log`, `architecture-summary.log`. Test-strength limits are assessed separately below. |
| 2 | Standing and decision witnesses | pass | `STANDING.md` inventories every scoped standing writer and traces its recorded-decision path or documented exception. `standing.mjs`, `probes.mjs`, `round3.mjs`, `support.mjs` reject plain/prototype/reflective/wrong-kind witnesses and a second mint. `ledger-fk.mjs` confirms seven standing references reject a missing decision, with `foreignKeyViolations:[]`. Original link/excuse/signoff undo isolation and correction preservation pass. R5-B03/B07 concern overlapping-answer maintenance and authorization, despite recorded witness-bearing decisions. |
| 3 | Idempotency and atomicity | pass | `probes.mjs`: replay seq 2 twice with one write; operation/actor/project reuse conflicts; late failure leaves the audited rows unchanged; 150 unique contiguous sequences 2..151 with no gaps from failed commands. `new-probes.mjs`: instance replay, secret reply withheld, `tokens:1`. Live reports preserve 40 concurrent writes and 42 contiguous events, and crash retries duplicate no results. Logs `rerun-probes`, `rerun-new-probes`, `rerun-live`. |
| 4 | Non-overwriting edits | pass | `probes.mjs` and `policy-supplements.mjs`: disjoint stale changes merge; overlapping changes conflict; resolution retains newer preconditions and follows strict adoption policy; unauthorized/multi-edit resolutions fail; restore produces version 5 and preserves all five; delayed tags become `[agent,human]`; a descendant folder move is invalid. |
| 5 | Evidence provenance and report inputs | issues | Exact/assumed/unresolved basis is 1/1/1; invalid case-typed claims are rejected and automated claims are declined but remain in the commit gate and fill zero slots. Human/CI/agent method batches are human+auto/auto+auto/agent+agent. Foreign references, other-producer and other-target corrections are refused. A 100,000-result retry keeps one batch and 100,000 rows. Empty keys/reports and lone surrogates fail; emoji clipping stays well formed. R5-B04 finds inconsistent effective correction history in commits versus slots. Logs `rerun-probes`, `rerun-new-probes`, `rerun-round3`, `rerun-final-probes`, `correction-history-confirmed`. |
| 6 | Questions, holds and ledger | issues | 500 failures create one question and one carried answer. Distinct frames with the same text stay separate. Hold boundaries and inherited fact expiry pass. `lifecycle-positive.mjs` passes six report orders across three environments, 36 answer decisions and individual undo/re-answer cycles without extra questions. Both sweep-first and report-first expiry produce `flaky -> expired -> defect` with correct supersedes links. R5-B01/B02/B03/B05/B06 expose lost questions, displaced standing and answers carried beyond what they decided. |
| 7 | Gate soundness | issues | Pure verdict priority, unknown/no-proof/skips/declined-only/agent-only pending, forward-only change heads, older attempts, separate jobs/producers and expiry-before-sweep pass. Two live uploads give 349 observed accepted-state reads, all pending. Two real SIGKILL/restart cycles recover 100,001 rows exactly and retries add none. R5-B03/B05 produce false passes; B04 gives incompatible effective outcomes; B01/B02/B06 leave blocked runs without an answerable failure question. |
| 8 | Runs and slots | issues | Target/basis/method admission, pinned version methods, human-only slots, explicit agent opt-in, distinct actors, repeated-attempt failure retention, every cause, two-run sharing and closed correction snapshots pass the rerun probes. R5-B02 loses the failure question after reopening, B04 disagrees with the commit projection, and B06 carries a result-specific mistaken answer to a new failure without resolving or asking about it. |
| 9 | Policy and authorization | issues | `policy-matrix.mjs` executes 324 operation/answer invocations over loose/standard/strict and agent/CI/reader with `probeErrors:0`. Supplements exercise valid mistaken answers, conflict author rules, agent self-adoption and basis policy. Live project-scoped operations, events, session lists and forgotten-token revocation pass. Both original R4-B06 replacement probes now return forbidden. R5-B07 shows withdrawal still bypasses notProducer and required reason. |
| 10 | HTTP | pass | Real local listeners: same/no Origin 200; foreign/null/different scheme/Host 401. Server anonymous session/events and all 15 operation routes return 401. Every registry operation appears in generated OpenAPI and has a route. Cookie is HttpOnly/SameSite=Strict and foreign-origin cookie requests fail. Scoped other-project reads/events 403. Both sized and chunked 65 MiB bodies return actual 413; a following ordinary request succeeds. Public routes match `serve()` plus static UI/unknown 404. Logs `rerun-live`, `rerun-checkpoint-live`; the author body test also reads the socket's actual status line. |
| 11 | Concurrency and readers | pass | Each live 100,000-result upload preserves all 40 simultaneous writes, 41 unique command sequences and 42 contiguous events while reads complete. `readers-live.mjs`: 128 read-after-write observations; 27 inline/worker replies over all 9 reads, including 10 refusals; denied calls never reach a worker; worker writes return forbidden; 80 requests survive a killed worker; shutdown awaits all workers. Checkpoint exists during 347 commits, 80 more survive its termination, and all 427 survive restart. Inline=0 works; default at 16 cores is 8. Code uses passive checkpoints. No performance verdict is given. These functional checks are not a cross-provider verdict on the separately authored reader subsystem. |
| 12 | Documented departures | issues | All eighteen assessed below. Defects contradict the evidence/decision guarantees in 2, 4, 7, 8 and 17. The slice-size documentation now correctly says 200. Browser persistence and archive implementation are explicitly not checked because this brief excludes them. |

Commands in the table refer to scripts under `scripts/`; matching logs are under `logs/`. Reproduction scripts assert the observed defective behavior so an exit of 0 demonstrates reproduction, not a healthy implementation. All reported observations were obtained on this exact export.

## Earlier findings

The updated round-4 working copies were run first, before the broad suite and new probes. `scripts/rerun.py` ran every in-process earlier reproduction group. The HTTP, reader and checkpoint scripts followed on real listeners. `new-probes.mjs` exits 1 only because two obsolete original reserved-key scenarios now fail at the deliberately added rejection. `round3.mjs reserved-key-refusal` verifies the revised contract and absence of writes. No such fixture failure is reported as a product defect.

| Round-4 finding | Status on this revision |
| --- | --- |
| R4-B01 | fixed with new problems elsewhere in the same paths: corrected-base and late-trunk-fallback heads now remain blocked. R5-B04 finds longer correction histories diverge; R5-B05 finds the base hint changes with report boundaries. `logs/rerun-round4.log`. |
| R4-B02 | fixed: the early plan containing both repositories remains blocked after only repository a is excused; b's question remains open. `posthoc-multi-repository-scope`. |
| R4-B03 | fixed: fail then pass at the same attempt leaves both commit and planned gates blocked, with both immutable results retained. `same-attempt-replaces-failure`. |
| R4-B04 | fixed with new question-lifecycle problems: a pipeline pass retains the question for the agent-only run, and the original question can be answered. R5-B02/B06 cover different paths that still lose answerable questions. `logs/rerun-lifecycle-r4.log`. |
| R4-B05 | fixed with new overlap problems: two infra answers carry independently; return to production asks nothing and the old production answer can be undone. R5-B01/B03 cover narrowing and replacement of overlapping answers. `infra-two-answers-and-return`, plus `lifecycle-positive.log`. |
| R4-B06 | fixed for answer replacement, with a new withdrawal problem: both original producer probes return forbidden and store no extra discount/decision. R5-B07 shows undo omits the checks. `logs/rerun-policy-r4.log`. |
| R4-T01 | fixed: key completeness now compares the schema; removing mistaken fails the named test. Replay/bulk tests count cases, versions, proposals and decisions. Token generation is tested over two starts. Body limit reads the socket status. `test/restart.test.ts` really kills and restarts a process and passes here. |
| R4-N01 | fixed: source constant and the three cited documents agree on 200; the real report driver uses that constant. |

The author-discovered dependent-run lapse case also passes: the earlier commit and the closed planned run become blocked, name the replacement question, and return to passed after a new answer. The later reopening path in R5-B02 is additional.

| Earlier finding | Status from this round's rerun |
| --- | --- |
| R1-B01 | fixed: multi-case/policy conflict resolution is forbidden, unrelated case remains active and policy stays loose. |
| R1-B02 | fixed: per-result methods respect actor kind; an agent cannot count as automation. |
| R1-B03 | fixed: naming a run does not admit another target. |
| R1-B04 | fixed: skip/refused-only cannot turn failure into proof. |
| R1-B05 | fixed: retry of an older commit does not move the change head backward. |
| R1-B06 | fixed in original and equal-attempt variants; R5-B04 is a further correction-history problem. |
| R1-B07 | fixed: other-target corrections refused; closed snapshots preserved. |
| R1-B08 | fixed in original target-scope probe; R5-B01/B03 cover overlapping answers. |
| R1-B09 | fixed: scoped projects/events/session and forgotten-token checks pass on HTTP. |
| R1-B10 | fixed: delayed edits preserve newer fields and tags. |
| R1-B11 | fixed: folder cycle refused. |
| R1-B12 | fixed: repository PR keys, commit gates and early planned-run excuses stay separate. |
| R1-B13 | fixed: slot eligibility reads pinned version methods. |
| R1-B14 | fixed: mismatched manual annotation refused without relinking. |
| R1-B15 | fixed: runtime and type-level witness constructions refused. |
| R1-B16 | fixed: undo old mapping preserves a newer link. |
| R1-B17 | fixed: 300 changed cases return as 200 plus 100; interleaved variant sees all 300. R5-N01 is the separate decided-inbox cursor. |
| R1-B18 | fixed: command identity and secret-bearing replay checks pass. |
| R1-B19 | fixed: processed jobs fill existing and newly planned runs. |
| R1-N01 | fixed: expiry is a ledger row in the supersedes chain. |
| R1-N02 | fixed: another origin scheme returns 401. |
| R1-N03 | fixed by the explicit public-route contract, checked on the live server. |
| R1-N04 | fixed: empty/whitespace test keys refused. |
| R2-B01 | fixed: three constructor calls, prototype object and second mint refused. |
| R2-B02 | fixed: agent-only commit is pending; agent pass cannot clear pipeline failure. |
| R2-B03 | fixed: answering one of two causes leaves the slot blocked. |
| R2-B04 | fixed: later skip retains disputed slot. |
| R2-B05 | fixed: repository-qualified gate/impact/planning agree and later cross-repository evidence stays separately classified. |
| R2-B06 | fixed: reserved automated case key refused before writing. |
| R2-B07 | fixed in original passing-subset probe; R5-B02/B06 expose other lifecycle paths. |
| R2-B08 | fixed: infra covers production only and reasks staging. |
| R2-B09 | fixed: folder-filtered search finds C-301. |
| R2-N01 | fixed: full and unambiguous prefix commit reads both environments. |
| R2-N02 | fixed: read denial returns 403 before worker dispatch. |
| R3-B01 | fixed for a single corrected result in existing and later plans; R5-B04 finds earlier surviving attempts produce disagreement. |
| R3-B02 | fixed: a separate job or environment pass cannot replace a failing lane. |
| R3-B03 | fixed: a plan over existing failure joins its question and responds to its answer. |
| R3-B04 | fixed: trunk scopes include repository and planned causes are classified separately. |
| R3-B05 | fixed: ingest expiry writes one expired row, and the later sweep adds none. |
| R3-B06 | fixed: undo mistaken preserves a later producer correction. |
| R3-B07 | fixed: strict map/create refuses atomically and instructs propose/adopt/link. |
| R3-B08 | fixed: newer target changes the evidence hash; old answer conflicts. |
| R3-B09 | fixed: established event stream closes after forgetting; fresh call is 401. |
| R3-B10 | fixed: an agent's base result does not justify inherited for a CI head. |
| R3-B11 | fixed: another repository's trunk does not justify inherited. |
| R3-T01 | fixed: removing the witness-kind guard fails the named author test and independent probe. |
| R3-T02 | fixed: replay actually checks one token row. |
| R3-N01 | fixed: default reader count is cores minus two, clamped 1..8; explicit 0 runs inline. |

The deciding outputs for these earlier findings are in `logs/rerun-probes.log`, `rerun-new-probes.log`, `rerun-round3.log`, `rerun-lifecycle.log`, `rerun-final-probes.log`, `rerun-standing.log`, `rerun-live.log`, `rerun-readers-live.log` and `rerun-checkpoint-live.log`.

## Decision 0012 departures

| # | Verdict | Assessment |
| --- | --- | --- |
| 1 | pass | Integer internal identities and project-relative public refs appear on real operations. Foreign refs do not resolve across projects. |
| 2 | issues | Original lane/job/producer/attempt/scope probes pass. R5-B04 gives different effective lane history in commits and slots; B02/B06 lose answerable questions for failing runs. |
| 3 | pass | Mixed methods, pinned eligibility, agent-only commit pending and explicit agent opt-in all pass. The original agent-question dissolution defect is fixed. |
| 4 | issues | Inherited reads current per-lane base rows in the original fixes, and producer lookup now reads results. R5-B05 wrongly extends a batch-local base hint; B06 carries a mistaken result judgment to new evidence. R5-B07 omits producer checks on withdrawal. |
| 5 | not checked | Browser draft persistence is out of scope. Server proposals were exercised. |
| 6 | pass | Acceptance is durable before apply, every observed outstanding gate read is pending, two crash cycles recover exactly once, and SLICE is 200 as documented. |
| 7 | issues | Closed-run refusal and preservation under correction pass. R5-B04 shows inconsistent correction history; B02 shows the documented signoff-withdrawal path reopens a run without its failure question. |
| 8 | issues | Basic target holds, three-environment permutations, expiry and dependent-run recomputation pass. R5-B01/B03 break overlap/narrowing/replacement; B06 carries an answer beyond its finite effect. The documented older-commit infra exception remains conservative and is not a finding. |
| 9 | pass | Same case/change basis produces one review across commits; another change key produces another. Patch-hash invalidation is explicitly deferred. |
| 10 | not checked | Transfer/archive implementation excluded. Its broad-suite tests ran; no independent archive verdict is asserted. |
| 11 | pass | Fifteen registry operations have routes and OpenAPI entries. Deferred operations are absent. Streaming transfer is an explicit separate exception, not silently judged here. |
| 12 | pass | OpenAPI schemas describe inputs and generic envelopes; TypeScript carries reply types. Full reply schemas are not claimed. |
| 13 | pass | Conflict resolution creates a proposal under current adopt policy; strict does not silently adopt; author restrictions and delayed merge checks pass. |
| 14 | pass | Automated bad claims remain unresolved/declined, fill no slot, and still block the commit when failing. Invalid case-typed claims are refused. |
| 15 | pass | Nothing-proven/skips/refused-only/agent-only remains pending; skip cannot replace prior proof or failure. |
| 16 | pass | Late or repeated old commit reports do not move the change head backward. |
| 17 | issues | Repository keys, gates, trunk scopes and base repository filtering pass. R5-B05 still uses a partial set of base facts to justify a cause-wide inherited answer. |
| 18 | pass | Reserved `case:<n>` automated keys fail before inserting results; manual C-n fills its own slot exactly. |

## Defects

### R5-B03: Re-answering an older target question can leave the newest commit falsely passing

Blocks: yes. Confirmed twice.

Reproduction: `bun scripts/overlap-stale-gate.mjs`. Report one cause in two environments on commit first001. Answer production infra, then staging flaky. Report the same failure on second01, which carries the flaky answer and passes. Change the original production answer to defect.

Deciding output: first001 becomes `failed`, but second01 stays `passed` with one excused failure. The sole excuse row is already `class:"attributed", decision:4`. Re-reporting second01 makes it `failed` without any further decision. The report receipt still claims `answer:"flaky", how:"already decided"`. See `logs/overlap-stale-gate-confirmed.log`.

The new broad answer overwrites the other question's target-0 excuse via `setExcuse` at `src/server/evidence/evidence.ts:1082`, without superseding that decision or recomputing its dependent runs. `settle` at `src/server/decisions/decisions.ts:443` recomputes only runs attached to its own question or the decision it directly supersedes. `standingOn` then still lists the displaced answer and chooses by question epoch rather than the actual standing. This contradicts P0/P3/P4, check 7, and departure 8's promise to recompute every dependent run when an answer stops standing.

### R5-B05: Splitting a report lets a base failure excuse a different test that passed on base

Blocks: yes. Confirmed twice, with an equivalent combined-report control.

Reproduction: `bun scripts/inherited-split.mjs`. On the base, test old fails and test new passes. On the head, both fail with the same cause. Send the head's new failure first, then its old failure in a second report, in the same lane and attempt.

Both fixtures have identical effective test rows. Combined upload gives `blocked, unexplained:2` and no failure decision. Split upload gives `passed, excused:2` with an inherited decision. See `logs/inherited-split-confirmed.log`. The longer first probe is `scripts/inherited-mixed-tests.mjs`.

`raiseFailure` at `src/server/ops/writes.ts:222` accumulates tests in the question but computes `hint:fails-on-base` only from the latest batch's `group.tests`. The last report's old test therefore allows the rule to excuse the whole accumulated cause, including the test proven passing on base. This contradicts P3, checks 6 and 7, and departure 4's promise that inherited means already failing on base. Report boundaries must not change whether identical effective evidence is excused.

### R5-B04: A correction with an earlier attempt produces different effective evidence in commits and slots

Blocks: yes. Confirmed twice.

Reproduction: `bun scripts/correction-history.mjs`. In one lane report fail at attempt 2, then fail at attempt 3, then pass at attempt 1 explicitly correcting attempt 3. All results are exact for the same pinned version. The commit gate becomes `passed`; both the existing run and a newly planned one remain `blocked` on the uncorrected attempt-2 failure.

Deciding rows: `run_tests` contains only the passing attempt 1, while the slot has `state:"failing"` and cause `[[1,1]]`. There are no excuses. See `logs/correction-history-confirmed.log`.

`applyBatchSteps` at `src/server/runs/runs.ts:497` deletes only the currently selected corrected row from `run_tests` and inserts the correction without reconsidering the remaining lane history. `aggregateSlot` at `src/core/runs.ts:151` instead folds all uncorrected rows and selects attempt 2. The same admissible evidence has two definitions of what currently counts. Either correction semantics must be applied consistently to the lane, or the commit must retain the failure its full-history fold still counts. This contradicts P3 and departures 2 and 7. The one-result lower-attempt correction regression test does not cover prior attempts.

### R5-B07: Withdrawing a failure decision bypasses the clause's producer and reason requirements

Blocks: yes. Confirmed twice, with the two omitted checks tested separately.

Reproduction: `bun scripts/undo-policy.mjs`. Under strict, one person reports a failure and an independent person classifies it as defect with a reason. The producer's attempt to replace it with infra is correctly forbidden, but the same producer can withdraw it with a reason. Independently, a non-producer's replacement without a reason is invalid, but withdrawal without a reason succeeds.

Both withdrawals record a new decision under strict's `failure-any` clause and change the gate from failed to blocked. The producer variant has `replace.status:"forbidden", undo.status:"reopened"`; the missing-reason variant has `replace.status:"invalid", undo.status:"reopened"`. See `logs/undo-policy-confirmed.log`.

`undo` at `src/server/decisions/decisions.ts:577` passes `isProducer:false` to `standingOf` and never checks `ask.reason`, although it resolves the same clause used by answers. No documented exception permits producers to withdraw another person's decision or waive required reasons. This contradicts P5 and check 9. The round-4 producer fix covers answer replacement but not withdrawal.

### R5-B01: Replacing a broad answer loses the question for the other environment

Blocks: yes. Confirmed twice through real `invoke` calls.

Reproduction: `bun scripts/dissolved-target-lost.mjs`. Report the same cause in staging and production on one commit. Answer production `infra`, withdraw that answer while the staging question remains open, and answer staging `flaky`. The broad flaky answer dissolves the production question. Change the staging answer to `infra`. Production now fails without an answer, but its question stays dissolved.

Deciding output: `verdict:"blocked", unexplained:1, open:[]`; the failure inbox is `[]`. Answering the production question returns `conflict: this question no longer applies`. See `logs/dissolved-target-lost-confirmed.log` and the independent first run in `logs/target-overlap-first.log`.

`answeredElsewhere` at `src/server/decisions/decisions.ts:495` dissolves covered questions without recording which answer replaced them or transferring their targets to that answer's question. Later replacement/withdrawal sees only the staging target. This contradicts P4, checks 6 and 7, and departure 8's promise to ask immediately about an uncovered environment of the current commit.


### R5-B02: Reopening a run does not restore its still-failing question

Blocks: yes. Confirmed with two independent fixtures and twice with the minimal script.

Reproduction: `bun scripts/reopen-lost-question.mjs`. Report one failure, plan a run over it, and answer flaky so the run closes. Withdraw the flaky answer. A newer passing attempt clears the commit gate, but the closed run correctly keeps its earlier failure. Withdraw the signoff to reopen that run, as departure 7 instructs.

The reopened run is `state:"open"`, `verdict:"blocked", unexplained:1, open:[]`. Its failure inbox is empty and the old failure question refuses an answer with `this question no longer applies`. See `logs/reopen-lost-question-confirmed.log`; the inherited-hold variant is `scripts/closed-question.mjs` and its log.

`stoppedFailing` ignores closed runs, which matches the documented question-closure rule. But `signoffHandler.revert` at `src/server/decisions/kinds.ts:475`, `reopenRun` at `src/server/runs/runs.ts:1058`, and `refold` do not raise or rejoin a failure question when a closed snapshot becomes an open run again. The defect is the final open run, not the documented exclusion of closed runs during dissolution. This contradicts P4, check 7, and departures 2, 7 and 8.

### R5-B06: A carried mistaken answer leaves a fresh disputed result without a question

Blocks: yes. Confirmed twice.

Reproduction: `bun scripts/mistaken-carry.mjs`. Keep a two-case run open. One person fails C-1 and another passes it. Answer the dispute `mistaken`, which discounts the first failure. The first person then reports the same cause failing again at attempt 2.

Deciding output: receipt says `how:"already decided", answer:"mistaken"`; gate says `blocked, disputed:1, open:[]`; the failure inbox is empty. Only result 1 is discounted, while new result 3 remains counted. Re-answering mistaken returns `already`. See `logs/mistaken-carry-confirmed.log`.

The mistaken decision stores a finite list of discounted results, but its hold depends only on the cause/disputed basis. `raise` at `src/server/decisions/decisions.ts:140` carries that answer to new results without extending its effect or asking for another decision. This contradicts P3/P4, checks 6 to 8, and departures 4 and 8. A decision that one recorded result was wrong does not establish that a new result was wrong.

## The tests do not prove this

The round-4 test-strength issues are fixed, rather than repeated as findings. The mutation that removes the mistaken key now yields `0 pass, 1 fail`; removing the witness-kind guard fails both the author test and the independent probe. Replay and bulk cardinality assertions, two-start token checks, a real socket status line, and the real process restart test now test the named effects.

The passing suite does not cover the combinations that produced R5-B01 through B07. In particular, one-result corrections do not establish consistent effective history with multiple attempts; two infra answers do not establish overlapping broad-answer replacement; a single mistaken decision does not establish its carry semantics; and answer authorization tests do not establish withdrawal authorization. These are coverage gaps demonstrated by the saved real-code reproductions, not additional blockers beyond the defects.

The test named "a closed run takes no more results until its sign-off is withdrawn" proves reopening an ordinary passing run. It does not prove that a retained failing snapshot rejoins its question after reopening. Likewise, worker/inline parity can pass when both paths return the same incorrect ledger pagination, R5-N01.

## Worth doing later

### R5-N01: The decided inbox ignores its kind filter and skips equal-revision rows when paginating

Blocks: no, it does not change stored evidence or gate standing. Confirmed twice.

Run `bun scripts/ledger-page.mjs`. Create one case, then report passing tests from three files in one command. The full ledger contains four questions. Asking for decided failure questions returns all four non-failure questions. Paginating with limit 1 returns only two of the four, because the next page uses `rev < last.rev` and drops the other questions settled at the same revision.

`queuePage` uses `Q.ledger` without applying kind and orders/pages only by rev. See `logs/ledger-page-confirmed.log`. Filter consistently and use a stable tie-breaker for the cursor. The existing reader-thread parity tests prove worker/inline agreement, not that both replies honor these filters and pagination.


## Execution and cleanup notes

The shared worktree was read only through `git rev-parse`, `git diff` and `git archive`. Every runnable source came from the pinned archive. Export-only author-test adjustments remapped ephemeral listener ports into 7700..7749 and the excluded budget data directory into `/tmp`; they changed no application logic and were restored. Architecture/test-strength mutations were applied one at a time and restored. All 468 tracked files and symlinks compare equal to a fresh archive of the judged hash, `logs/export-integrity.json`.

The out-of-scope budget test cannot run on the requested tmpfs data path. No performance finding or approval is inferred. The original old-key probe errors and one corrected syntax/working-directory error in review scripts were method errors, not product findings. No other agents were started.

Cleanup completed: no review Bun/Node process or listener on ports 7700..7749 remains, and all review-prefixed `/tmp` data is removed. Evidence is recorded in `logs/cleanup.json`. Reproduction scripts, logs, report and source export remain under `engine-r5`. Application dependencies and transient export data have been released. This review made no changes to the shared repository.

ISSUES (7 blockers)
