# Casebook engine review, round 14

Revision: `3ef3aed2d9ac9cd9003acc6e36e20bc6e8314e68`.
Reviewer: Codex, GPT-6 Astra. Independent of the Claude-authored engine. The Codex-authored reader threads receive functional QA here, not a different-provider signoff.

Completed local review: four blocking defects and one nonblocking projection defect. The original round-13 inputs are repaired, but placement and custom dispute authority are not yet sound over the additional inputs below. The full-hash identity change passed the collision and repository checks.

The fact to establish: standing answers and gate verdicts must reflect only authorized decisions and admitted evidence, at acceptance, application, relocation, expiry, and restart. A blocked gate must retain an answerable question.

The source was exported using `git archive` at the named revision, then dependencies were installed with `bun install --frozen-lockfile` (Bun 1.4.3). All review work and artifacts are in this review directory. The shared checkout was read only through `git archive`; it was not edited or cleaned. Runtime data used `/tmp`, and real servers used ports 8850–8899. All checks below were run by this reviewer. This is functional QA, with no performance verdict.

## The twelve checks

### 1. Author tests and what they prove — issues

Ran `bun test src test --path-ignore-patterns 'test/e2e/**'`, `bunx tsc --noEmit`, and `bunx biome check src test bench` in the export. Test-only ports and disk data paths were temporarily redirected to the brief's allowed ports and `/tmp`, then restored. [Command summary](logs/author-checks-summary.log): `620 pass`, `1 fail`, `16913 expect() calls`, `Ran 621 tests across 29 files`; typecheck exit 0; lint exit 0, `Checked 187 files ... No fixes applied.`

The sole failing test was the excluded on-disk budget test: `benchmark data directory is on tmpfs/ramfs` for its redirected `/tmp` directory; performance was not checked.

Independently repeated both requested larger runs: [300 seeds per preset](logs/sequences-300.log), `3 pass`, `0 fail` (900 histories); [150 extended seeds per preset](logs/sequences-extended-150.log), `3 pass`, `0 fail` (450 histories). These results do not establish the four missing behaviors demonstrated below.

Mutated the export one rule at a time, ran the architecture suite and restored each mutation. Upward imports, a second mint caller/import, another owner's SQL, raw domain SQL and a writer ignoring its witness all fail. A plain object typed as a witness **does not fail architecture alone**; it fails the required typecheck with `TS2739`, missing the private witness fields. Invalid declared SQL, outside SQLite access, outside reversal callers, core I/O, web/server imports, duplicate operations and a second operation path also fail their checks. [Required mutations](logs/architecture-mutations-summary.log), [additional mutations](logs/architecture-additional-summary.log), [registry checks](logs/architecture-last-summary.log).

R13-T01's repaired stateful oracle was extracted with its current closure state and actual post-command bookkeeping. Both `infra` and `mistaken` produce `before:true, after:true, actualUndo:"forbidden"` in [r14-authority-oracle](logs/r14-authority-oracle.log), including after the mistaken result stops counting. The old extraction fails because it omits the new closure state; that is not a product failure.

The historical `state-extended` probe exits zero despite seven failed assertions: `checked:6756, problems:7`. They expose N01. An adaptation that checks the public gate separately, while counting the stale stored verdicts, finishes `checked:7200, problems:0, staleProjections:70` ([log](logs/r14-state-extended.log)). The source was not changed for that run.

### 2. Standing only through a recorded decision — pass

[STANDING.md](STANDING.md) lists every in-scope SQL writer of the named standing columns/tables, its decision call path or documented exception, and the related projections. It judges all four “What is not standing” exceptions and the four reversal writers.

Fresh witness/runtime/foreign-key probes and architecture mutations pass the combined boundary. Deciding lines: real wrong-kind witnesses are refused by link, excuse, close and policy writers; `noLedgerChanges:true`; seven missing-decision references fail; `foreignKeyViolations:[]`. Withdrawal preserves a newer link, signoff, excuse or discount and does not clear a producer's correction. Plain/prototype/reflected witness values cannot be used as a minted witness. This proves recorded-decision ownership, not the correctness of the policy that permits an answer; B02/B04 concern that separate permission check.

### 3. Idempotency and atomicity — pass

Ran the command probes, crash/recovery probes and real HTTP interleaving. [r12-command-binding](logs/rerun-r12-command-binding.log) injects failure after the first applied result: `rollback:{batches:1,results:0,tests:0}`, `acceptedBinding:true`, five changed-request attempts return `conflict`; after repair `sameReply:true, results:2, eventSeqs:[2,3]`. The one accepted batch is the documented first transaction, not a partial application. Object key order replays, changed array order conflicts, and another operation/actor/project/content cannot reuse the id.

Instance operations replay; the token-creating reply is not replayed, with `tokenStored:false, tokenRetry:"conflict"`. The real concurrent identical HTTP report gives `sameReply:true`, 30,000 rows once, changed content 409 ([current HTTP positive bundle](logs/r14-r12-http-positive.log)). Across each 100,000-result concurrent run: `uniqueCommandSeqs:41, eventSeqCount:42, contiguous:true` ([live log](logs/rerun-live.log)). Late ordinary-command failures leave no partial rows. Real process termination between acceptance and application preserves the binding, and restart/retry writes no duplicate results.

B03 is a valid accepted report that cannot finish processing. Its application still rolls back atomically; the processing defect is recorded under checks 6/7.

### 4. Edits never overwrite — pass

Ran author suite tests and the fresh `probes`, `new-probes`, `policy-supplements` and `final-probes` scenarios; stopped obsolete tails are listed in [EARLIER.md](EARLIER.md). Disjoint stale fields merge; a same-field conflict retains both sides; adoption merges again against a moved head. The conflict-resolution fixture ends with `version:5, title:"Resolved", pre:"New work after conflict"`, preserving the intervening work ([log](logs/rerun-probes.log)). Resolution is a new proposal subject to adoption, and an unauthorized multi-case/policy resolution is `forbidden` with the second case still active and the policy unchanged.

Restore creates a later immutable version. Deferred tag edits produce `tagsBefore:["human"], tagsAfter:["agent","human"]`. A folder cycle is `invalid` with `a folder cannot be moved into itself or into a folder inside it`. Author-only resolution and the one-edit restriction are exercised by the suite and supplementary policy probes.

### 5. Evidence says what it proves — pass

Ran evidence/integrity/sequence tests, mixed-result and correction probes, and the 100,000-result probe. [Basis probe](logs/rerun-probes.log): `basis:{exact:1,assumed:1,unresolved:1}`; typed disagreement is rejected with empty admitted results and missing slots; automated version 999 is retained with no case, listed in `declined`, and its gate stays `blocked` with one unexplained failure. No declined annotation fills a slot.

The per-result method probe shows person human/auto, pipeline auto/auto and agent agent/agent. Cross-project refs and corrections naming another producer, test, target or typed run are refused. Closed snapshots retain their original result. [round3](logs/rerun-round3.log) inserts 100,000 results once, exact retry is not fresh, and the truncated emoji sample is well formed; malformed half-character input and empty test keys are refused. Unusual valid text remains data. The separate lane matrix finishes `sequences:4500, observations:13500, commitAndSlotAgree:true` ([log](logs/rerun-lane-matrix.log)).

### 6. One question per cause, asked again honestly — issues

Ordinary cause/hold/expiry/withdrawal checks pass: 500 failures produce one question and 500 excused results after an answer; all six three-environment answer orders finish `answerDecisions:36, extraQuestions:0, carryAndUndo:true`; both expiry orderings record `flaky → expired → defect` ([lifecycle](logs/rerun-lifecycle.log), [positive lifecycle](logs/rerun-lifecycle-positive.log)). Stale evidence returns `conflict`; ending an answer removes its excuse and links the next question. Rule decisions record their clause, and withdrawal/rejection prevents the same rule from overriding that person again.

The new ordinary placement matrix passes 32 combinations: open/closed, flaky/infra/mistaken/expired, one/two environments, no destination answer or an existing flaky answer; `problems:[]` ([log](logs/r14-placement-lifecycle.log)). R13's 16 destination-joining cases and its eight count-preservation cases also pass. Nevertheless B02 settles a relocated closed dispute using the wrong clause, and B03 repeatedly raises retained historical targets until application fails. These break the broader re-asking contract.

### 7. Gate correctness and accepted evidence — issues

Verdict order, nothing-proven pending, skip/declined/agent-only pending, independent lanes and forward-only change heads pass the suite and prior probes. On real HTTP, both 100,000-result rounds yield 168 accepted-phase reads, all pending; ordinary reads/writes continue. Two actual process terminations between acceptance and application recover 100,001 rows, `stillAccepted:0`, blocked gate and `retryFresh:false` ([live log](logs/rerun-live.log)). Expired holds read pending before the next write/sweep.

The original R13 placement-horizon fixture is repaired: same and other environment each have `acceptedPhaseSamples:333, nonPendingSamples:0, outstanding:1`, then blocked. Its restart fixture also clears the accepted report and asks the replacement question. Four additional failure/retry/recovery variants balance the existing runs' counters at zero, including an agent report already waiting before placement ([log](logs/r14-waiting-horizon.log)).

B01 creates a new run after acceptance: it passes and can close before the accepted failure is applied, then stays passed after recovery. B02/B04 allow passing gates based on answers the current dispute clause does not permit. B03 keeps a valid first report accepted indefinitely across exact retry and restart. N01 leaves only the stored verdict stale; the public gate remains correct.

### 8. Runs and slots — issues

Slot qualification, pinned methods, explicit target checks, human-only slots, opted-in agent slots, two independent producers, multiple tests/causes and one result filling two plans pass their probes. Deciding output includes `agentDefault:"missing", agentWithoutDeclaration:"missing", humanOnlyAuto:"missing", sharedSlots:2, closedReport:"conflict"` and a dispute still `disputed`/`blocked` after 20 later writes ([log](logs/rerun-probes.log)). Corrections and late commit uploads preserve closed evidence snapshots; reopening catches up and asks about the remaining failures.

The defect is at the closure boundary: B01 can sign off a newly created run while a report for its accepted target is already pending. The later snapshot behavior then preserves the false pass. B02 also concerns a closed run's dispute being answered during placement. The normal evidence-admission and snapshot checks do not exercise either transition.

### 9. Policy — issues

The preset matrix executes `total:324, probeErrors:0`: all fifteen operations and every answer for agent, CI and reader, under all three presets ([log](logs/rerun-policy-matrix.log)). The applicable `mistaken` and conflict/adoption supplements confirm agents can advise only where allowed; standard agents cannot adopt their own proposals; CI cannot decide and readers cannot write. Scoped tokens cannot read another project's operations/events, the session lists only their project, and a forgotten actor's token returns 401. The 312-case authority matrix passes with 104 cases per preset and `failures:[]` ([log](logs/rerun-r13-authority-matrix.log)).

Nine new custom-authority controls cover admin and author clauses, permitted/advising/refused agents, and permitted/refused rules replacing a prior answer ([log](logs/r14-custom-authority.log)). The admin exception to an author clause is honored rather than reported as a defect. B04 finds two additional combinations where `standingOf` ignores one part of a custom admin clause. B02 applies an ordinary-failure rule before a closed dispute has been established at its new scope. Both are reproduced through the operation registry and real HTTP.

### 10. HTTP surface — pass

[Live HTTP probes](logs/rerun-live.log) show local absent/same origin 200; foreign/null origin, foreign host and another scheme 401. Server anonymous session/events/all fifteen operations return 401; public health/OpenAPI return 200; unknown route 404. Cookies are HttpOnly and SameSite=Strict, and another origin is refused. Declared and streamed oversized bodies both return 413; the next ordinary request returns 200. All fifteen registry operations are routes and occur in OpenAPI.

The named-person fix is exercised on every operation, session, event stream and added-route wrapper: malformed or mismatched names 401; matching/absent names 200 ([session log](logs/rerun-r13-session-header.log)). An added write route rejects the mismatch with 401 and leaves no proposal ([log](logs/rerun-r13-header-extra-write.log)). The public exceptions inspected in `serve` are health, API description, login/logout and static assets; other data routes use the guard. Internal behavior of excluded MCP/transfer modules is not signed off here. The downstream application defects reproduced over HTTP do not identify an additional HTTP guard defect.

### 11. Concurrency and reader threads — pass for functional behavior

Each real 100,000-result upload interleaves 40 ordinary writes, with no lost/duplicate command sequence and contiguous events; reads answer during the open write ([live log](logs/rerun-live.log)). [Reader probes](logs/rerun-readers-live.log): `clients:32, reads:128, workerCompletions:128, fallbacks:0`; all nine read operations match inline over `replies:27, refusals:10`. Denied requests do not reach a reader, and a worker write returns `reader threads cannot write`. Forgotten identity cache checks pass.

After a worker is stopped, `requests:80, allAnswered:true`, with inline fallback and replacement workers. Shutdown reports `allWorkerExitsAwaited:true, remaining:0`. [Checkpoint probe](logs/rerun-checkpoint-live.log): writes complete while the checkpoint thread is present; 80 more complete after it stops; `persistedAfterRestart:637, inlineReadCount:637, inlineReaders:0, defaultFor16Cores:8`. Those counts establish liveness/durability, not latency. The reader code's author is also Codex, so these results do not meet a different-provider signoff requirement for that portion.

### 12. Departures 1–18 — issues overall

Decision 0012 is the contract used here. Listed cuts are not defects.

| Departure | Verdict | Evidence or limit |
| --- | --- | --- |
| 1. Integer ids and public refs | pass | Registry and HTTP probes use stable project-scoped refs. Cross-instance merge is excluded. |
| 2. Test lanes versus planned slots | pass | 4,500 lane sequences; prior-evidence plans; required-job and prefix selection probes. The new-plan pending horizon is separately B01 under departure 6. |
| 3. Eligibility, agents and placement | issues | Methods and agent isolation pass. B02/B03 break relocation; N01 leaves a waiting run's stored verdict stale. Delayed agent visibility in pull-request impact is accepted. |
| 4. Failure answers and dispute authority | issues | Person-given inherited and results-named mistaken behavior pass. B02/B04 contradict current dispute permission checks. Automatic inheritance #69 and pre-dispute answers standing under #70 are accepted limits. |
| 5. Browser drafts | not checked | Browser storage/reload/person separation is excluded. The HTTP person-name guard is checked in 10. |
| 6. Two report transactions and sliced apply | issues | Existing-run horizon, rollback, reader liveness and restart pass. B01 misses preaccepted evidence in a new plan; B03 cannot finish applying. No latency conclusion. |
| 7. Closed run snapshots and reopening | issues | Normal late uploads, corrections, catch-up and human signoff veto pass. B01 reaches closed state prematurely, and B02 mishandles the closed dispute at relocation. |
| 8. Holds and honest re-asking | issues | Time/target/named-result holds and ordinary reversals pass. B02/B03 break placement re-asking. Older superseded commits not being asked about again is an explicit limit. |
| 9. Review basis | pass | `sameBasisDeduplicated:true, anotherChangeSeparate:true, resultFacts:0` in [review-basis probe](logs/rerun-r12-review-basis.log). Patch-hash invalidation is deferred #49. |
| 10. Whole-instance export/import | not checked | Transfer is excluded; incidental archive tests do not constitute a transfer review. |
| 11. Fifteen operations | pass within scope | Registry uniqueness, HTTP/OpenAPI completeness and no alternative in-scope operation path. CLI/MCP and streaming transfer implementation are excluded. |
| 12. Input-only API schemas | pass | Operation inputs/OpenAPI checked. Output schemas are the stated #52 cut. |
| 13. Resolution makes a new proposal | pass | Check 4 and conflict-author policy supplements. |
| 14. Automated outcomes retained when annotation is declined | pass | Invalid version stored unlinked, slot remains empty and failing commit remains blocked; typed mismatch refused. |
| 15. Nothing proven stays pending | pass | No report, skips only, refused results and agent-only commit probes. |
| 16. Forward-only head | pass | Late/repeated attempts do not move the head back; an agent cannot move it. |
| 17. Repository and commit identity | pass | 1,539 placement-order cases, 29 scope/no-fallback checks, and nine new full-hash/repository variants. The same full hash in app/fork/no-repo is distinct; unspecified ambiguous lookup is invalid. |
| 18. Reserved manual test keys | pass | Automated `case:<n>` is refused; mapping cannot change the manual identity. |

## Earlier findings and reproductions

The first work was rerunning all earlier reproductions, before the new probes. [EARLIER.md](EARLIER.md) records all 179 entries individually as fixed, fixed with a new problem, or no longer applicable, with fresh output and log links. [The run index](logs/rerun-summary.json) has exits and complete tail excerpts; no entry timed out. Both hunts' scripts and their original sequence runners ran. Old defect assertions often fail because the defect is repaired; those failures and obsolete fixtures are explained rather than counted as successful test runs.

| Round-13 item | Status | Evidence on this revision |
| --- | --- | --- |
| B01: existing-run placement horizon | fixed with a new problem | Original same/other-environment and restart fixtures pass. B01 below covers plans created after acceptance; N01 covers recomputation after an unrelated run finishes waiting. |
| B02: person-name guard outside operations | fixed | Every mismatched/malformed route case is refused; the extra write creates nothing. |
| B03: closed run loses its answerable question on placement | fixed with a new problem | Original twelve cases now have blocked gates and open replacement questions, `orphanedClosedRuns:0`. Additional closed-dispute/rule and many-answer inputs fail as B02/B03 below. |
| B04: later answer overrides protected dispute | fixed with a new problem | The original standard/custom admin/custom human fixtures preserve the prior answer. B04 below demonstrates two other custom clause combinations that shared `standingOf` does not enforce. |
| B05: first-twelve-character collision | fixed | The old label assertion is obsolete. The updated full-hash probe covers both colliding and non-colliding controls, retains the unaffected second question and answers it to a passed gate. |
| N01: count falls to sample of fifty | fixed | Counts 1/50/51/501 preserved across one/two environments, with displayed sample at most fifty. |
| T01: test oracle forgets disputed answer after mistaken | fixed | Current closure/bookkeeping predicts both infra and mistaken restrictions after settlement, matching the actual forbidden withdrawal. |

Issue #70 remains recorded as a limit. The new B02/B04 cases involve a decision made or changed under the current dispute clause, so that limit does not cover them.

## Confirmed defects

The four blocking findings below each reproduced twice in process and once over a real HTTP server with two reader threads. Their scripts assert the current defect, so a repaired implementation should fail those assertions. Run from this review directory; after dependency cleanup, first run `bun install --frozen-lockfile` inside `tree`. The small in-process command named in each finding is sufficient to reproduce it; the HTTP bundles are [r14-findings-http.mjs](scripts/r14-findings-http.mjs) and [r14-policy-http.mjs](scripts/r14-policy-http.mjs).

### R14-B01: a run created during an accepted report can pass and close before that report is applied

Blocking P3 gate defect. Reproduced twice with `bun scripts/r14-plan-during-accepted.mjs`; see `logs/r14-plan-during-accepted.log` and `logs/r14-plan-during-accepted-repeat.log`.

A pipeline has a passing annotated result. Its next, failing attempt is durably accepted, but application fails. A new planned run over that commit reads only the older pass and starts with `outstanding:0`. It returns `passed` while the commit gate correctly returns `pending`. Under loose and standard the rule also closes it. Repairing the application failure and retrying the exact command blocks the commit, but the newly closed planned run remains passed because the failure is now a late result. Strict also gives a false pass during acceptance, though it stays open and becomes blocked on retry.

Deciding output for loose and standard: `commitDuring:"pending", runDuring:"passed", stateDuring:{state:"closed",outstanding:0,accepted_seq:0,applied_seq:0}, commitAfter:"blocked", runAfter:"passed"`.

The only fixture intervention is a temporary SQLite trigger that raises an application error; acceptance and every user action use the real operation registry. The trigger is removed before retry. `runs.plan` initializes the horizon to zero and fills only applied results; it does not inherit already accepted batches that its target admits. Contradicts check 7 and departure 6. This is separate from R13-B01, whose existing-run relocation fixture is repaired. Real HTTP plus restart confirms `httpFailureStatus:500, commitDuring:"pending", runDuring:"passed", restart:{commit:"blocked",run:"passed"}` ([log](logs/r14-findings-http.log)).


### R14-B02: relocating a closed dispute lets a plain-failure rule settle it

Blocking policy and gate defect. Reproduced twice with `bun scripts/r14-relocation-rule-dispute.mjs`; logs of the same name and `-repeat` are under `logs/`. This uses only supported operations and no database mutation.

Two agents disagree in a planned run that admits them before any pipeline has placed the commit. A person settles the dispute with `infra` or `mistaken`, and the passing run closes. Through the normal policy proposal/adoption path, install a policy that leaves disputes to a non-producer human but lets a rule answer ordinary failures. When the first pipeline report places the commit in a pull request, the old answer correctly ends. The new question is incorrectly settled by the ordinary `failure-change` rule. The closed run is passed again although its slot is disputed and the displayed question says a non-producer human is needed.

Deciding output for both answers: `closed:true, gate:"passed", slot:"disputed", destination:{state:"decided", hints:["disputed"], decision:{answer:{is:"flaky"},by:["policy"],rule:"failure-change"}, needs:"one member who did not produce the evidence who is not an agent"}`. Open-run controls remain blocked with an open dispute question.

`askWhereCommitIs` reverts/lapses the old answer, then calls `raiseFailure` before recomputing the closed run. Its group declares `disputed:false`, and `inDispute` excludes that closed run while its stored disputed tally is still zero. The rule therefore answers before the new scope's dispute facts are established. This contradicts P5 and departures 3/4. It is not issue #70: the slot was already disputed and the old answer was explicitly an answer to that dispute; the new rule decision is made during relocation. HTTP reproduces `gate:"passed", rule:"failure-change", hints:["disputed"]` ([log](logs/r14-findings-http.log)).

### R14-B04: custom admin clauses do not enforce all of their conditions

Blocking policy defect. Reproduced twice with `bun scripts/r14-policy-constraints.mjs`; logs of the same name and `-repeat` are under `logs/`. Policy changes use a proposal and the owner's adopt decision.

Two direct dispute-answer variants contradict their displayed requirements. First, a clause asks for `who:"admin", agents:"answer"`; an agent with only `read,produce,answer` and no admin capability nevertheless settles it. Second, a clause asks for `who:"admin", notProducer:true`; the admin who reported the disputed failure nevertheless settles their own evidence. Both actors were correctly refused under standard before the custom clause was installed. Both answers turn the run passed.

Deciding lines: `mode:"admin-agent", needs:"an admin", you:"counts", after:"decided", gate:"passed"`; and `mode:"admin-not-producer", isFailProducer:true, needs:"an admin who did not produce the evidence who is not an agent", you:"counts", after:"decided", gate:"passed"`.

`standingOf` in `src/core/kinds.ts` returns from the agent branch before checking the admin role, and returns from the admin branch before checking `notProducer`. R13-B04's `maySettle` repair now calls this shared function, but that function still does not enforce a whole custom clause. Contradicts P5 and check 9. This is neither a pre-dispute answer nor the documented admin exception for an author clause. Both variants reproduce over HTTP using actual tokens with the stated capabilities ([log](logs/r14-policy-http.log)).

### R14-B03: relocating 51 answered environments cannot finish applying the first pipeline report

Blocking report-processing defect. Reproduced twice with `bun scripts/r14-relocation-many-answers.mjs`; logs of the same name and `-repeat` are under `logs/`. The script uses only supported operations.

An agent reports the same failure on one commit in 51 environments. The owner answers each environment with `infra`. Each older question retains the targets it had already seen. The first pipeline report places that commit in a pull request. `askWhereCommitIs` now visits every decided question and raises every target in its retained list, including targets raised from the other questions. The oldest target is raised 51 times in one command, hitting the loop guard. Application rolls back after durable acceptance. Retrying the identical command fails the same way and the commit stays pending. Two and fifty environments are passing controls.

Deciding output: `count:51, answers:51, first.ok:false, retry.ok:false, pending:1`; both errors say `one command raised the question "same cause" 51 times for one target: stopped`. The gate says `pending: 1 report accepted and not yet applied`.

This contradicts checks 6/7 and departures 3/6/8. Atomic rollback itself works. The remedy needs to avoid raising the same cause/target repeatedly while ending all old answers; raising the loop-guard limit would leave the duplicate traversal. HTTP returns 500 before and after restart, with `accepted:1, gate:"pending"` ([log](logs/r14-findings-http.log)). Recovery reports the failure and the server starts; it does not repair this report.

### R14-N01: a run that only waits for placement can retain a stale stored verdict

Nonblocking projection defect, confirmed under all three presets. `bun scripts/r14-stale-waiting.mjs` creates a blocked run limited to repository app, an agent failure on the same commit in fork, then the first counted fork report with that same failure. During relocation the destination question already exists; `raise` drains `ctx.recompute` while the unrelated run is still waiting. `noteApplied` clears that run's outstanding count but does not queue another fold. It retains `verdict:"pending", outstanding:0`.

The public gate recomputes the verdict from the stored tally and correctly returns `verdict:"blocked", stale:true`, naming the answerable question. No false gate verdict or failed signoff was established from this stale projection. This explains all seven `stored-verdict-stale` failures in the original 60-seed `state-extended` rerun; that probe exits zero despite reporting failures. The minimal reproduction was repeated under all three presets. See [minimal log](logs/r14-stale-waiting.log), [repeat](logs/r14-stale-waiting-repeat.log), and [original random log](logs/rerun-state-extended.log). The follow-up public-gate audit completes all 7,200 steps with zero public-gate/invariant failures and 70 stale projections. N01 contradicts the promise that those waiting runs are recomputed after application, but is not counted as a blocker because the public gate remains correct.

## What the tests do not prove

- The ordinary synchronous random command driver does not insert a plan between report acceptance and application. Existing-run pending tests can pass while B01 remains.
- Placement tests do not combine a previously answered closed dispute with an ordinary-failure rule that must not answer disputes. Open-run controls do not expose B02.
- A 501-test count fixture and unanswered environment histories do not cover 51 separately answered environments with overlapping retained target lists. B03 needs that history, not merely a large result count.
- Preset checks and isolated custom admin/member checks do not prove every condition of a custom clause is combined. The agent/admin and admin/nonproducer combinations in B04 are missing.
- Stored verdict consistency is not established by the passing author sequence suites; the older review probe detects N01. That probe also requires reading its structured `problems` field because its exit code stays zero. This is a limitation of the retained review harness, not a new product defect.
- The architectural plain-object witness check belongs to typechecking. Architecture alone passing that mutation is not evidence that the value is accepted at runtime; type and runtime probes both refuse it.

## Worth doing later and review limits

N01 can be repaired after the blockers by ensuring runs whose waiting count is cleared are folded after that update, including when an inner question operation already consumed the recompute set. The public verdict remained correct in the observed cases.

Automatic inherited judgments (#69), pre-dispute answer invalidation (#70), browser drafts, transfer, CLI/MCP implementation, and the documented read-latency work (#60) remain outside this signoff. No omitted contract or excluded implementation is counted as a pass. Diagnostic logs from corrected reproduction fixtures are retained and are not defect evidence.

The final [export integrity check](logs/export-integrity.json) compares every archived file against the named commit after all temporary mutations. [Cleanup record](logs/cleanup.json) records removal of review-owned dependencies/runtime data and the absence of a review server left running. Source, scripts, logs and this report remain available; no changes were made to the shared checkout.

ISSUES (4 blockers)
