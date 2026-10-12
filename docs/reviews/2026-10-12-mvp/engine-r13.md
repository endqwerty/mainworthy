# Casebook engine QA review, round 13

Revision **`3177d996d4acfe0320669b9ff8165f279fab9f3d`**. Verdict: **ISSUES (5 blockers)**, plus one nonblocking count defect and one confirmed test-oracle gap.

Independent engine reviewer: **Codex GPT-6 Astra**; engine author: Claude Opus 5.5. No other agents were used. Reader-thread code is Codex-authored; check 11 is functional QA, not a different-provider signoff of that subsystem. This report does not authorize delivery.

The correctness facts at issue are that accepted evidence makes every affected live gate pending, a failure always retains an answerable question when its scope changes, and answering one question cannot replace another answer the actor is forbidden to change. The reproductions below disprove those facts on this revision. All five blockers were reproduced after checking the fixtures, with passing controls where applicable.

Only `git archive` read the shared checkout. All code ran from the clean export under this review directory, with Bun 1.4.3 and dependencies installed using `bun install --frozen-lockfile`. The diff from `de5702371f5e1a6881cb8748a5befdec9a1ca378` was independently compared from two archives; [changed files](logs/changed-files.txt) and [diff](logs/round13.diff) are retained. Required project/design documents were read; only decision 0012's stated behavior was judged as documentation.

Scripts below run from `/home/endqwerty/.cache/casebook-arena/verify/engine-r13` as `bun scripts/<name>.mjs` unless a different command is shown. Assertions in new defect probes express the promised behavior, so their exit 1 is the reproduced defect. Inherited defect probes often assert the old wrong behavior, so exit 1 can mean the repair works. [EARLIER.md](EARLIER.md) records each such disposition and unexecuted tail. Do not treat the old orchestration/cleanup utilities in the copied scripts directory as test scenarios.

## Twelve checks

### 1. Author's tests and whether they prove their claims — issues

Ran the requested commands through [author-checks.py](scripts/author-checks.py), adapting only the exported tests' listening ports to 8700–8749 and budget data path to `/tmp`, then restoring those adaptations. [Full test log](logs/author-tests.log), [command summary](logs/author-checks-progress.log), [typecheck](logs/typecheck.log), [lint](logs/lint.log):

- `bun test src test --path-ignore-patterns 'test/e2e/**'`: **616 pass, 1 fail, 16903 expect() calls; 617 tests across 29 files**. Every in-scope test passed.
- The sole failure is out of scope: `test/budgets.test.ts` refuses its data directory because `/tmp` is tmpfs/ramfs; no disk-budget verdict is given.
- `bunx tsc --noEmit`: exit **0**.
- `bunx biome check src test bench`: exit **0**, `Checked 186 files ... No fixes applied.`

Independently reran both claimed larger sequence sets: `CASEBOOK_SEQUENCE_SEEDS=300 bun test test/sequences.test.ts` gives **3 pass, 0 fail** ([log](logs/sequences-300.log)); `CASEBOOK_SEQUENCE_SEEDS=150 bun test test/sequences-extended.test.ts` gives **3 pass, 0 fail** ([log](logs/sequences-extended-150.log)). Each covers all three presets. The inherited sequence probes and both hunts' sequence runners also completed; these are reproducible checks, not a proof that every ordering was generated.

Mutated each requested architecture boundary in the export and watched the intended check fail: upward import, second mint import/call, cross-owner SQL, raw domain SQL, unchecked witness. Invalid declared SQL also fails preparation. **A plain object typed as Witness passes architecture.test.ts alone**, but the required typecheck rejects it: `TS2739 ... missing ... #decision, #kind, #signers, #expiresAt`. The combined check enforces that boundary. Additional core/web/SQLite/undo/registry mutations fail as expected. See [mutation summary](logs/architecture-mutations-summary.log), [additional checks](logs/architecture-additional-summary.log) and [last checks](logs/architecture-last-summary.log). Every source mutation was restored.

The current tests accurately detect the three original round-12 cases, but do not prove all the broader claims. R13-T01 below shows that the new authority oracle loses a settled party after `mistaken`. All requested tests pass despite B01–B05: they do not exercise the other-environment accepted horizon, the closed relocation, the common HTTP wrapper, custom dispute clauses or full-commit prefix collisions. These are concrete coverage gaps, separate from the product defects.

### 2. Recorded-decision boundary (P0) — pass

The complete SQL writer/caller inventory and four exceptions are in [STANDING.md](STANDING.md). It covers cases and their projections, tags/folders/coverage, links, excuses, run state/signoff, policy versions and slot correction/discount state. Every judgment writer checks a witness or is one of the documented, bounded reversal paths. Derived projections can still be wrong; passing P0 does not pass their correctness.

Executed `standing`, `round3`, `witness-constructor`, `ledger-fk`, `foreign-keys`, plus the architecture mutations. Deciding output: `noLedgerChanges:true`, seven missing-decision foreign keys refused, `foreignKeyViolations:[]`; plain/prototype/reflection/direct constructions and a second mint are refused, as are genuine witnesses of the wrong kind. Ordinary and late-run undo probes preserve newer links, signoffs and producer corrections. R11's discounted-result correction now retains `corrected:1` and leaves both run and commit passed. Logs are linked in the inventory and earlier-run table.

### 3. Idempotency and atomicity — pass

Executed `probes`, `r11-command-order`, `r11-command-crash`, `r11-positive`, `r12-command-binding`, `r12-digest-keys`, `live` and [r13-r12-http-positive](scripts/r13-r12-http-positive.mjs). [Ordinary checks](logs/rerun-probes.log): `firstSeq:2,retrySeq:2`, changed operation/actor/project conflict, `lateRollbackUnchanged:true`; 150 successful interleaved events are unique and contiguous, `failedCommandsConsumeSeq:false`.

[Application fault injection](logs/rerun-r12-command-binding.log) fails after the first result: accepted binding survives, but `results:0,tests:0`; five changed-request variants conflict. Retrying after removing the fault yields exactly two results, `eventSeqs:[2,3],sameReply:true`. Instance replay succeeds; token reply replay conflicts and `tokenStored:false`. JSON object-key order replays identically; changed accepted record values and array order conflict. Parser-discarded `__proto__` content is not accepted data.

[Real process recovery](logs/rerun-r11-command-crash.log) retains command binding through acceptance/restart, applies exactly 100001 total results and refuses changed content with HTTP 409. [Concurrent HTTP retries](logs/r13-r12-http-positive.log): `pendingObserved:true,sameReply:true,sequence:3,changedStatus:409,results:30000`. No partially applied result set survives the failed application transaction. B01 concerns which run gets the acceptance horizon, not loss of transaction atomicity.

### 4. Edits never overwrite — pass

Executed the edit cases in `probes`, `policy-supplements`, `round3`, the author suite/integrity tests and the inherited positive conflict probes. [Deciding output](logs/rerun-probes.log): waiting different-field proposal **merged preserving human pre**; waiting same-field proposal **conflict**; a resolution lands as version 5 while preserving `pre:"New work after conflict"`; `restoreVersion:5,versions:5`; delayed tags preserve `tagsAfter:["agent","human"]`.

Resolving a multi-case/policy change cannot obtain an admin adoption (`status:"forbidden"`, original cases/policy retained). Standard agent self-adoption is forbidden with zero created cases. Cycle attempts return `a folder cannot be moved into itself or into a folder inside it` and leave the hierarchy readable. Core merge/hash implementations are outside scope; their behavior through the engine was exercised.

### 5. Evidence says what it proves (P3) — pass

Executed `probes`, `new-probes`, `round3`, `final-probes`, `round4`, `r11-positive` and both hunts' method/job probes. [Basis output](logs/rerun-probes.log): `exact:1,assumed:1,unresolved:1`; conflicting pin/version claims are declined, typed cross-case claims rejected, slots remain missing. A bad automated version stays in the gate as `blocked` with one unexplained failure and is returned in `declined`. Foreign/nonexistent refs do not create a case link.

Mixed methods remain per result: pipeline auto, agent agent, person's typed result human and uploaded test auto. An agent key does not count toward a required pipeline job; typed+auto-skip also stays pending. Corrections of another producer/test/target/typed run are refused with the same-target-and-run error. [round3](logs/rerun-round3.log) applies **100000** results once (`retryFresh:false`) and exercises empty/unusual text, invalid lone surrogates and well-formed clipping across emoji. This does not certify the out-of-scope format parsers. Question-count loss on relocation is separately N01, not loss of stored result facts.

### 6. One cause/question and honest lifecycle (P4) — issues

Executed `lifecycle`, `lifecycle-positive`, `target-overlap`, `fixed-r7`, `r10-load`, `r10-rule-withdrawal`, `r12-facts-lifecycle`, all scope probes, and new relocation/authority matrices. [Positive lifecycle](logs/rerun-lifecycle-positive.log): six environment orders, **36 decisions**, `extraQuestions:0,carryAndUndo:true`; both expiry orders record flaky → expired → defect. [Large set](logs/rerun-lifecycle.log): 500 same-cause failures produce one question and 500 excused results after answering. Stale evidence conflicts, ending decisions remain in the ledger, rule decisions name clauses, and a person's rule withdrawal persists across later reports.

[Current facts lifecycle](logs/rerun-r12-facts-lifecycle.log): each preset has `expiredLedger:1,stickyThroughCorrection:true,dissolvedWhenGone:true`; standard/strict refuse the restricted producer on the renewed question. [Relocation joining](logs/r13-relocation-joining.log) passes 16 combinations of an existing destination question/answer, old open/flaky answer, two environments and planned/no planned run.

Failures: B03 leaves a newly unexplained closed gate with no question; B05 dissolves another full commit's still-needed question and leaves it named in that open run's gate. B04 wrongly ends a protected answer through a later question. N01 truncates a moved question's total to its 50-test sample. Ordinary scope/target/project holds pass; these new transitions do not.

### 7. Gate never overstates the evidence (P3) — issues

The ordinary verdict ordering, unknown commit, all-skips, all-refused, agent-only, late/repeated attempts, different job/producer and forward-only head checks pass (`probes`, `round3`, `round4`, `lane-matrix`, `r11-positive`, both hunts). [Lane matrix](logs/rerun-lane-matrix.log): **4500 histories / 13500 observations**, commit and planned-slot outcomes agree. Expired holds read pending before sweeping and blocked with a replacement question afterward.

[Ordinary live HTTP](logs/rerun-live.log) observes 168 durably accepted-phase reads in each of two 100000-result rounds, all pending. Two real stop/restarts show `killedBetweenAcceptAndApply:true,resultsAfter:100001,stillAccepted:0,retryFresh:false`. [New relocation restart](logs/r13-relocation-restart.log) also recovers the first counted report and its question correctly: `recovered:100001,remaining:0,gate:"blocked",open:[Q-5],retryFresh:false`.

However, B01 returns **passed throughout the accepted horizon** for an affected open run in another environment, on two live-server repetitions. B03/B05 violate the answerable-question condition. The completed-operation R12-B02 repair passes; that is insufficient for these cases.

### 8. Runs and slots — issues

The ordinary admission/snapshot checks pass: pinned methods, exact/assumed basis, target restrictions, human-only obligations, explicit agent admission, multiple causes/tests, two runs using one result, closed-run report refusal, corrections while closed and reopening (`probes`, `final-probes`, `fixed-r7`, `r11-positive`, hunt-r2/reopen-around-mistaken). [Deciding output](logs/rerun-probes.log): `agentDefault:"missing",agentWithoutDeclaration:"missing",humanOnlyAuto:"missing",sharedSlots:2,closedReport:"conflict"`; **20 later writes** leave the slot `disputed` and its gate `blocked`.

B03 changes a closed run's gate on relocation while its exact slot_results snapshot remains unchanged and no one can answer the now-unexplained cause. B05 breaks the question attached to a different open planned run. B01 is the affected open run's missing upload horizon. These findings concern new scope/derived-state transitions, not late results being admitted to a closed run.

### 9. Policy (P5) — issues

[policy-matrix](logs/rerun-policy-matrix.log) exercises **324 calls**, all 15 operations and every applicable answer for agent, CI and reader under the three presets; `probeErrors:0`. `policy-supplements` verifies agent advice vs decision, standard agent self-adoption refusal and CI decision refusal. Scoped tokens cannot read other projects or streams, session lists are scoped, and forgotten tokens return 401 (`live`, `readers-live`).

New [authority matrix](logs/r13-authority-matrix.log): **312 cases, 104 per preset, failures:[]**. It varies plan before/after reports, open/closed runs, mistaken/flaky/infra, third-party withdrawal, expiry/reopen, either participant and replace/undo; standard/strict inbox `you` and `needs` agree with refusal, while loose remains permissive. [Mixed parties](logs/r13-agent-parties.log): **12 variants**, preserved message/sample, correct human/agent restrictions. A dispute settled on an earlier build does not wrongly prohibit answering a later plain failure under the stock standard preset; its protected target answer remains in force.

B04 disproves the broader rule for supported custom clauses: `notProducer:false` skips the independent admin/human restriction in cross-question replacement. Both custom variants correctly refuse a direct answer but let the same actor end that answer via a later question. This is not the documented pre-dispute-answer limit #70.

### 10. HTTP surface — issues

[live](logs/rerun-live.log) and [checkpoint-live](logs/rerun-checkpoint-live.log) independently verify local origin/host/scheme checks, server authentication, scoped events/session lists, cookies, body limits and all 15 operation routes/OpenAPI entries. Deciding statuses: no Origin/same Origin **200**; foreign Origin, literal null, foreign Host and other scheme **401**. Anonymous session/events and all operation routes **401**; health/OpenAPI **200**, unknown route **404**. Cookies are HttpOnly and SameSite=Strict; foreign-origin cookie use is refused. Declared and chunked oversized bodies return **413**, then an ordinary request still returns **200**. Login/logout and configured public/static handlers are the explicitly public paths in `serve`; no additional anonymous project reader was found.

New header matrix checks all session-taking route categories, with matching/absent headers as controls. All **15 operation routes** refuse a mismatched name. B02: session, event stream and extra-route handlers accept mismatched and malformed names. A real extra-route write via `/mcp` confirms the common HTTP guard consequence: Bob's cookie plus `X-Casebook-As: Alice` creates/adopts the text as Bob with **200**. MCP implementation semantics remain outside this review.

### 11. Concurrency and reader threads — pass (functional QA)

Executed [live](logs/rerun-live.log), [readers-live](logs/rerun-readers-live.log), [checkpoint-live](logs/rerun-checkpoint-live.log) and author reader/restart tests. Two large-report rounds each preserve all 40 concurrent writes: `uniqueCommandSeqs:41,eventSeqCount:42,contiguous:true`, with worker reads answered while the write is active.

Reader deciding output: **32 clients, 128 committed readbacks, workerCompletions:128,fallbacks:0**; all **9 read operations, 27 replies and 10 refusals** agree with inline. Denied HTTP input never reaches a worker; forgetting an actor removes its cached name on 12 subsequent reads and revokes its token. Worker write attempts return `reader threads cannot write`. Killing a worker leaves **80/80** requests answered, with 20 inline fallbacks and a replacement. Shutdown: `allWorkerExitsAwaited:true,remaining:0`.

Checkpoint: **564** commits while its thread lives, **80** after its death, **644** persisted after restart; inline mode uses zero readers and 16-core default is capped at eight. This is liveness/durability evidence, not a timing budget claim. Performance is excluded (#60). A different-provider signoff of the Codex-authored reader implementation is outside what this Codex review can provide.

### 12. Decision 0012 departures — issues

| # | Verdict | Executed evidence and qualification |
| --- | --- | --- |
| 1 | pass | Public C/Q/R refs and integer storage exercised throughout invoke/HTTP probes. Cross-instance merging is not checked. |
| 2 | issues | 4500 lane histories, repeated attempts, required jobs, pinned exact commits and posthoc plans pass. B05 conflates two full commits by their first twelve characters and loses one run's question. |
| 3 | issues | Per-result methods, pinned eligibility, agent gate isolation and all ordinary placement orders pass. Agent requests no longer reserve a named PR. B01/B03/B05 and N01 break the new relocation behavior. |
| 4 | issues | Human inherited answers are target-bound, hints excuse nothing; 24 inherited-contract combinations and the 312-case authority matrix pass. B04 lets an actor replace a protected dispute answer via a later question under valid custom clauses. #69/#70 remain accepted limits. |
| 5 | not checked | Browser draft storage/person separation is out of scope. The server's accompanying identity header was checked under 10 and has B02. |
| 6 | issues | Two transactions, slice application, concurrent readers, durable command binding and restart recovery work. B01 violates pending-from-acceptance for another affected environment. |
| 7 | issues | Ordinary closed snapshots, correction catch-up, reopen and persistent refusal of rule signoff pass. B03 changes a closed snapshot's interpretation and leaves no question after relocation. |
| 8 | issues | Four supported hold terms, expiry ledger, environment separation, target precedence, undo and ordinary re-asking pass. B04 wrongly ends an answer the actor cannot change; B05 leaves a live run naming a dissolved question. B03 is an additional closed-run relocation gap. |
| 9 | pass | `r12-review-basis`: sameBasisDeduplicated=true, anotherChangeSeparate=true, resultFacts=0. The patch-tree limitation is documented. |
| 10 | not checked | Transfer/import implementation is explicitly out of scope. Its incidental suite results are not an independent contract review. |
| 11 | pass | Registry, routes and OpenAPI each expose 15 operations; duplicate/alternate declarations fail mutation checks. CLI/MCP application semantics and streaming transfer are out of scope. |
| 12 | pass | Input schemas are present; output schema completeness is not promised. Real registry routes were called. |
| 13 | pass | Conflict resolution yields a new proposal subject to adoption, merges again after intervening edits and refuses unauthorized/multi-edit resolution. |
| 14 | pass | Contradictory automated case claims remain recorded, unlinked, declined and included in the commit gate; typed contradictions are rejected. |
| 15 | pass | Unknown, skips-only, all-refused and agent-only commits remain pending; skips do not erase earlier decisive evidence. |
| 16 | pass | Late/retried older commits and agent-only heads do not move an existing change back; the first real pipeline head is used. |
| 17 | issues | Repository collision, fork isolation and first counted placement orders pass (1539 cases). The new agent-to-real placement path has B01/B03/B05; B05 uses distinct full hashes in the same repository. |
| 18 | pass | Reserved automated `case:<n>` keys are refused and manual identity tests cannot be remapped. |

## Status of round 12

| Finding | Status on this revision | Fresh evidence |
| --- | --- | --- |
| R12-B01, settled dispute loses the passing participant | **fixed** | Original 16 variants print `incorrectlyAllowed:0`; standard/strict remain forbidden, loose allowed. The HTTP adaptation and 312-case matrix confirm the repair beyond the original fixture. |
| R12-B02, other environment retains passed tally after placement | **fixed with new problems** | Completed-operation four-way reproduction prints `falsePasses:0`, blocked + Q-5 in each case. B01 is the still-wrong accepted horizon; B03 is the closed-run orphan; B05 is full-commit scope collision. |
| R12-B03, closure relaxes a later dispute | **fixed** | Open/closed replace/undo combinations all forbidden, `incorrectlyAllowed:0`; HTTP before/after needs are unchanged. |
| R12-T01, sequence audit lacks authority checks | **partly addressed; not fully fixed as a proof claim** | The actual current function detects ongoing disputes. R13-T01 below shows it loses the preserved-party restriction after `mistaken`, even though the current product correctly refuses. |

The new web-review sample/message regression is fixed in all 12 mixed-party cases. The operation-route identity check is fixed but incomplete at the common HTTP wrapper (B02). The pre-dispute-answer ordering in issue #70 remains a recorded limit, not a finding. Every earlier reproduction and both hunts' scripts have individual current dispositions in [EARLIER.md](EARLIER.md).

## Confirmed blocking defects

### R13-B01: a relocated run remains passed between report acceptance and application

Blocking gate defect. Reproduction: `bun scripts/r13-placement-pending.mjs`, repeated independently with two reader threads. Logs: [first](logs/r13-placement-pending.log), [repeat](logs/r13-placement-pending-repeat.log).

Under strict, an open planned run admits an agent's failure in `agent-env`; a person answers flaky, so that run passes. The first pipeline report places the same commit in a pull request from `pipeline-env`. Accepting it moves the agent environment's target to the new scope, where its old excuse no longer covers it. During application of 100,000 results, the affected run still returns passed. It becomes blocked only after application commits.

First run: `acceptedPhaseSamples:332, nonPendingSamples:332`, `target.change:2`, `run.outstanding:0`, `run.state:"open"`, `verdict:"passed"`; final verdict blocked. Repeat: 367 of 367 accepted-phase samples return passed. Both samples are bracketed by reads that confirm the pipeline batch remains durably accepted. The same-environment control returns pending in all 333/348 samples with outstanding=1.

`acceptReport` calls `noteAccepted` only for `runsFor` the incoming environment, even though `ensureTarget` moved every environment's target. The new `plannedCounting` recomputation is only in `processBatchSteps`, after results are applied. Thus R12-B02's completed-operation stale tally is fixed, but its false pass persists during the accepted horizon. Contradicts P3, check 7 and decision 0012 departure 6. The closed-run exception does not apply to this open run.

### R13-B02: the session-name check is absent from session-authenticated routes outside the operation handler

Blocking HTTP contract defect. Reproduced twice with `bun scripts/r13-session-header.mjs`; see [first run](logs/r13-session-header.log) and [repeat](logs/r13-session-header-repeat.log).

A cookie authenticates Bob and the request declares `X-Casebook-As: Alice`. Every operation route correctly returns 401, but `/api/session` returns 200 with Bob's identity/projects, `/api/p/scratch/events` opens with 200, and a route installed through `extra.routes` runs as Bob with 200. A malformed percent-encoded name has the same gap. Matching and absent names are passing controls. Deciding output: `operationRoutesRefused:15`, `guardedRouteMismatchesAccepted` contains all six mismatched/malformed cases.

`sameCaller` is called only by `handleOp` in `tree/src/surfaces/http.ts`. The `guarded` wrapper in `serve` authenticates the cookie/token and invokes its handler without applying that check. This wrapper owns the session, events and extra routes. It contradicts the brief's required check of this header on every route taking a session and the promised per-person request guard. Transfer and MCP application logic are not judged here; the common HTTP wrapper is. A concrete extra-route consequence is also reproduced twice in `scripts/r13-header-extra-write.mjs`: a POST to the real `/mcp` handler with Bob's cookie and `X-Casebook-As: Alice` creates and adopts `Text Alice prepared` as Bob, with HTTP 200. See `logs/r13-header-extra-write.log` and its repeat. This is a check of the HTTP identity guard, not a review of MCP semantics.

### R13-B04: overlapping answers ignore a dispute clause's admin or human requirement when notProducer is false

Blocking policy defect, confirmed twice with `bun scripts/r13-dispute-policy-overlap.mjs`. Logs: `logs/r13-dispute-policy-overlap.log` and its repeat. The stock standard preset is a passing control.

Install a valid custom policy through `propose` and the admin's adopt decision. One variant reserves disputes for admins, while ordinary failures remain a member's to answer. Another reserves disputes for people, while explicitly allowing an agent to answer ordinary failures. Both dispute clauses set `notProducer:false`, since that is a separate policy choice.

Alice fails and Bob passes the first build. The restricted actor is correctly refused a direct answer to that dispute. The owner answers infra and the planned run closes passed. A pipeline reports the same cause on the next build, which is correctly a plain failure. The previously refused actor answers expected on that later question. Instead of preserving the protected target-specific answer, the operation ends it with an outdated ledger row and changes the old closed run to failed.

Deciding lines for both custom variants: `direct:"forbidden", later:"decided", oldRun:"failed"`; only the whole-cause attributed excuse remains. Stock standard keeps `oldRun:"passed"` and both excuses. The explicit no-admin/no-agent restriction is therefore lost through a different question.

Cause: `maySettle` in `tree/src/server/decisions/decisions.ts` returns true immediately when `clause.ask.notProducer` is false, before calling `standingOf` to check the admin or human requirement. `endReplaced` consequently treats the old dispute answer as replaceable. Contradicts P5, check 9, and departure 4's promise that another question cannot replace a dispute answer the acting person may not settle. This uses the supported policy-edit operation, not direct database changes.

### R13-B03: relocating an already closed agent run makes its gate blocked with no question to answer

Blocking gate/question defect. Reproduced twice by `bun scripts/r13-relocation-questions.mjs`. All 12 combinations reproduce: loose/standard/strict, same/other environment, and flaky/infra initial answer. Logs: `logs/r13-relocation-questions.log` and its repeat.

A planned run admits an agent's failure before any pipeline report. A person explains it and the run closes, by rule or explicit strict signoff. The first pipeline report then places that commit in a pull request, with an unrelated pass. The new recomputation removes the old-scope excuse from the closed run's tally, leaving `after:"blocked", unexplained:1, gateOpen:[], openFailures:0, run.state:"closed"`. The original answer remains decided in the commit's former scope. No new result entered the closed snapshot.

`plannedCounting` correctly includes the closed run. But `askWhereCommitIs` migrates only open questions, so skips its decided failure; `askUnexplained` then skips the closed run. The failure now needs an answer in its new scope, with nobody asked. Contradicts the check-7 gate/question promise and departure 7's closed snapshot promise: this is not a late result entering a closed run, but the new relocation path changing its verdict and abandoning its explanation. Departure 8's ordinary open-run re-asking does not cover this new invalidation of a closed run.

### R13-B05: relocating one commit dissolves another commit's question when their first twelve characters match

Blocking question/identity defect. Confirmed twice by `bun scripts/r13-prefix-relocation.mjs`, with distinct-prefix commits as a passing control. Logs: `logs/r13-prefix-relocation.log` and its repeat. The inputs are two distinct full 40-character hexadecimal commit IDs in the same repository; no database edits are used.

Create one planned run for each full commit and report an agent failure with the same cause on each. The agent-only targets share one `commit:<first twelve characters>` change, so their two targets are combined in Q-2. A first pipeline report places only the first full commit in pr:7. `askWhereCommitIs` raises Q-4 for that commit, raises the second target back into the still-open Q-2, then unconditionally dissolves Q-2. The second run remains blocked and advertises Q-2 in `gate.open`, but that question is dissolved and absent from the inbox. Its target still belongs to the old scope. An attempted answer to Q-2 returns `conflict: this question no longer applies` ([log](logs/r13-prefix-relocation-answer.log)).

Deciding lines: `collide:true`, before `Q-2 targets:[1,2]`, after only `Q-4 scope:pr:7 targets:[1]`, second gate `blocked ... open:["Q-2"]`, database `Q-2 state:dissolved`. With distinct prefixes both questions stay answerable. Cause: `ensureTarget` and `ownChangeOf` in `tree/src/server/evidence/evidence.ts` use `commit.slice(0,12)` as an identity, while `askWhereCommitIs` assumes every target in that question is the relocating commit. Contradicts check 6/7 and departures 2/3: a full commit is the run's target, each agent-only commit is on its own, and an open blocked run must have an answerable question. This is separate from R13-B03: the affected run is open, its own commit never moved, and no answer was given.

## Nonblocking defect

### R13-N01: relocating an agent question discards the total beyond its 50-test sample

Nonblocking count defect. `bun scripts/r13-relocation-count.mjs` confirms twice that a question with 51 or 501 failing tests is moved to the pull request with `evidence.count:50`; the stored result facts remain. One- and two-environment cases reproduce; 1 and 50 tests are controls. Logs: `logs/r13-relocation-count.log` and its repeat.

`askWhereCommitIs` reconstructs the cause from the question's bounded `tests` array, without preserving its full count. The new question is raised from only that sample. This repeats the presentation problem previously fixed for R11-N01 on a different path. The gate does not count these agent-only results, so this finding is not a gate blocker.

## The tests do not prove this

### R13-T01: the current authority oracle forgets a party after a mistaken answer

This is a **test gap, not a new product blocker**. [r13-authority-oracle.mjs](scripts/r13-authority-oracle.mjs) extracts the exact current `keptFromAnswering` function from `tree/test/sequences.test.ts` and runs it on real application states; [log](logs/r13-authority-oracle.log). Under standard, Alice fails and Bob passes; before settlement the function says Bob is kept from the question. After the owner answers mistaken, the slot becomes satisfied. The function now returns false, while the inbox still says forbidden and Bob's actual withdrawal is correctly refused:

`given:"mistaken",before:true,after:false,inboxYou:"forbidden",actualUndo:"forbidden",slot:"satisfied"`.

The infra control remains true before and after. The oracle reads current disputed slots but not the preserved historical parties/facts that the implementation now relies on. Thus invariant 13 does not assert refusal for this settled-participant case; a regression can escape that random audit. Deterministic tests and this review's matrix do check it. The author should keep those and extend the independent oracle to the same promised lifecycle boundary without calling the production permission function.

The remaining proof gaps are input/transition coverage: accepted-phase relocation across environments (B01), every session-taking route (B02), closed and colliding-commit relocation (B03/B05), custom policy restrictions independent of notProducer (B04), and full question totals beyond a display sample (N01). The full passing seed runs do not generate those cases. The plain-object witness check belongs to the combined typecheck/architecture boundary; it is inaccurate to say architecture.test.ts alone rejects it.

## Worth doing later and limits of this review

No new deferred feature is required by this review. Continuous-report latency (#60), automatic inherited judgments (#69), reconsidering a pre-dispute answer when a dispute first arises (#70), output schemas and the other recorded cuts remain deferred. They are not counted as defects. Browser/e2e behavior, transfer/import semantics and performance budgets were not reviewed. Reader-thread functional checks passed, but this review supplies no different-provider signoff for that Codex-authored code.

Review artifacts, scripts and full logs remain here. Source restoration, process shutdown and removal of only this review's temporary/runtime data and exported dependencies are recorded in [cleanup.json](logs/cleanup.json). The shared checkout was never changed or cleaned.

ISSUES (5 blockers)
