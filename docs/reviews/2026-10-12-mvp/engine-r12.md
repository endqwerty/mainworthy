# Casebook engine QA review, round 12

Revision: **`de5702371f5e1a6881cb8748a5befdec9a1ca378`**, branch `t3/mvp-product-delivery`.

**Three blocking defects.** A moved target can leave an open run falsely passed. Two dispute-lifecycle paths let a participant replace or withdraw a judgment that the current clause should keep from them. The original round-11 reproduction inputs now give the corrected results; the new failures extend the dispute and placement cases.

Reviewer: Codex, GPT-6 Astra. This is an independent check of the engine authored by Claude Opus 5.5. Reader threads were authored by Codex GPT-6.1 Sol: check 11 is executed functional QA, not a different-provider verification of that subsystem. No other agents were started and no author-run result was used as evidence.

The correctness fact under review: every counted result belongs to the right case version, target and producer; every excuse has a recorded decision covering that cause and scope; only a person permitted by the current clause can change standing; every unexplained live failure is answerable; and a command id remains bound to one request through failure and restart. The defects below violate these facts through ordinary application operations.

All work ran locally in this revision's clean archive at `engine-r12/tree`. The shared checkout was read only by `git archive`; it was never changed, installed into or cleaned. [EARLIER.md](EARLIER.md) records all 146 inherited/original-hunt reproduction entries and the four additional hunt sequence runners, including their actual output and any unexecuted tail. [STANDING.md](STANDING.md) inventories the scoped standing writes and their callers. Raw logs and executable probes are retained in this review directory.

Commands below run from `/home/endqwerty/.cache/casebook-arena/verify/engine-r12`. Install the exported tree's dependencies with `bun install --frozen-lockfile` there if they have been released. HTTP probes use only loopback, ports 8650–8699, and their own `/tmp` data. Each main blocker probe was reproduced twice through `invoke`; all three were also reproduced over HTTP with two reader threads. The standalone defect probes assert the promised behavior and fail on this revision; their failure is the reproduction. [HTTP confirmation](logs/r12-http.log).

## Required checks

### 1. Author tests and assertion strength — issues

Ran `bun test src test --path-ignore-patterns 'test/e2e/**'`, `bunx tsc --noEmit`, and `bunx biome check src test bench` via [author-checks.py](scripts/author-checks.py). Temporary test-port and budget-directory substitutions obeyed the brief and were restored. Deciding output: **`608 pass`, `1 fail`, `16664 expect() calls`**, 609 tests across 29 files. The sole failure is out of scope: the disk-budget test refuses the required `/tmp` data location because it is tmpfs. Typecheck exits 0; lint exits 0: **`Checked 186 files ... No fixes applied.`** [Tests](logs/author-tests.log), [check summary](logs/author-checks-progress.log).

Reran the requested long suites: `CASEBOOK_SEQUENCE_SEEDS=300 bun test test/sequences.test.ts` and `CASEBOOK_SEQUENCE_SEEDS=150 bun test test/sequences-extended.test.ts`; **each reports `3 pass`, `0 fail`**, covering loose, standard and strict. My inherited current-state checker reports **`80` seeds, `12000` checks, `problems:0`**; independent lane enumeration reports **`4500` sequences, `13500` observations, `commitAndSlotAgree:true`**. [300 seeds](logs/sequences-300.log), [150 seeds](logs/sequences-extended-150.log), [current-state probe](logs/rerun-state-current.log), [lanes](logs/rerun-lane-matrix.log).

One-at-a-time architecture mutations fail the intended checks: upward import, second witness-mint import/call, foreign-table SQL, raw domain SQL, writer ignoring its witness, bad declared SQL, outside SQLite/undo callers, core I/O, web/server import, duplicate operation and a second operation path. A plain structural witness passes the architecture test alone, but TypeScript refuses it: **`TS2739 ... missing ... #decision, #kind, #signers, #expiresAt`**. Removing the runtime kind guard fails both the author regression and the independent wrong-kind probe. After restoration, architecture reports **`12 pass`, `0 fail`**. [Mutation summary](logs/architecture-summary.log), [additional mutations](logs/architecture-additional-summary.log), [runtime mutation](logs/test-strength.log), [final architecture](logs/architecture-final.log).

The issues are assertion coverage, not an in-scope baseline test failure: **R12-T01** below. Both current audit bodies accept B01/B03 after the wrong authorization. Both detect B02 when supplied the minimized state; their generators missed that state.

### 2. Standing changes require a recorded decision — pass for the recorded-decision boundary

[STANDING.md](STANDING.md) lists every scoped statement for case heads and copies, placement/tags/state, links, excuses, run closure, policy, coverage and slot correction/discounts. The normal path is the registry transaction → decision row → sole mint → kind handler → standing writer. Four documented initialization/evidence exceptions and four restricted reversal functions are accounted for individually.

Runtime constructors, prototype objects and a second mint are refused. Genuine witnesses of the wrong kind are refused with **`noLedgerChanges:true`**. Seven decision foreign keys reject a nonexistent ledger decision and **`foreignKeyViolations:[]`**. Undo preserves newer links, newer signoffs, target-specific excuses and producer corrections. R11-B01 now leaves **`corrected:1`** after reopening and withdrawing the mistaken judgment, with run and commit both **passed**. [Standing](logs/rerun-standing.log), [foreign keys](logs/rerun-ledger-fk.log), [corrected history](logs/rerun-r11-correction-after-mistaken.log).

This passes the witness, ledger and reversal-boundary checks. It does not pass policy authorization: B01/B03 obtain a valid recorded decision through an incorrect eligibility check, covered in check 9.

### 3. Idempotency and atomicity — pass

Original command probes return **`firstSeq:2`, `retrySeq:2`, `changedOp:conflict`, `changedActor:conflict`, `lateRollbackUnchanged:true`**; another project also conflicts. R11-B02's differently ordered nested records now return the identical full reply and sequence. List reordering and changed record values still conflict. Instance project commands replay; token creation replay is refused and command storage contains no token text. [Original probes](logs/rerun-probes.log), [record order](logs/rerun-r11-command-order.log), [additional commands](logs/r12-command-binding.log).

A temporary SQLite trigger fails report application after its first result. Acceptance and the command binding remain, while **`results:0`, `tests:0`, `batches:1`** prove application rollback. Different content, operation, actor, project and instance reuse each conflict. Removing only that fixture fault lets the unchanged request finish once: **`results:2`, `eventSeqs:[2,3]`, `sameReply:true`**. [Failed-application probe](scripts/r12-command-binding.mjs), [log](logs/r12-command-binding.log).

R11-B04's real accepted-phase stop/restart now keeps the binding: **`pendingObserved:true`, `recovered:100001`**, changed content **HTTP 409**, and **`resultsAfter:100001`**. A concurrent duplicate command during a 30,000-result HTTP upload gets the same full reply and sequence; changed content returns **409**, total results stay **30000**. Two ordinary crash/restarts also recover once. [Crash binding](logs/rerun-r11-command-crash.log), [concurrent duplicate](logs/r12-http.log), [recovery](logs/rerun-live.log).

150 interleaved commands yield **150 unique events**, sequences **2–151**, with **`failedCommandsConsumeSeq:false`**. Each live 100,000-result/40-write round has **41 unique command sequences and 42 contiguous event sequences**. A bad staged report rolls back partial rows without preventing other startup recovery. [Recovery fault](logs/rerun-r10-recovery-failure.log).

### 4. Edits never overwrite — pass

Ran the suite/integrity tests and `probes`, `new-probes`, `policy-supplements`. Stale disjoint edits merge; same-field conflict preserves both versions. Delayed resolution retains intervening work: **version 4 → 5, title `Resolved`, precondition `New work after conflict` preserved**. Waiting proposals re-merge at adoption. Multi-case/policy resolutions cannot pass through an unauthorized conflict author; a standard agent's self-adoption is **`forbidden`, `cases:0`**. Restore appends a version. Tags apply over current tags (**`[human] → [agent,human]`**), and a folder cycle is **invalid**. These exercise the registry/adoption path. [Edit probes](logs/rerun-probes.log), [policy supplements](logs/rerun-policy-supplements.log).

### 5. Evidence says what it proves — pass

Ran evidence/integrity tests and the basis, mixed-method, declined-result, correction and Unicode probes. Basis is exact from a pin/version, assumed from an admissible unversioned link/annotation, otherwise unresolved. Conflicting typed evidence is rejected. Contradictory automated annotations are retained without a case in **`declined`**, fill no slot, and keep their failing commit blocked. Foreign-project refs and corrections of another actor/target are refused. Methods are per result: **person `[human,auto]`, pipeline `[auto,auto]`, agent `[agent,agent]`**. [Original probes](logs/rerun-probes.log), [declined claims](logs/rerun-new-probes.log), [method probes](logs/rerun-final-probes.log).

A duplicate 100,000-result report leaves **`rows:100000`, `batches:1`, `retryFresh:false`**. Empty/blank test keys and unpaired surrogates are invalid; clipped text is well formed (**`trimmedSampleWellFormed:true`, length 247**). A unique commit prefix resolves once; a later collision cannot enter that plan. Ambiguous planning is invalid, an unknown prefix remains literal, and typed evidence creates **`phantomTargets:0`**. The 201st target remains visible. [Large/Unicode](logs/rerun-round3.log), [prefixes](logs/rerun-r11-positive.log), [boundaries](logs/r12-boundaries-positive.log).

### 6. Cause questions, holds and honest re-asking — issues

500 failures with one cause raise **one question** and one answer excuses all 500. Six environment orders complete **36 decisions**, **`extraQuestions:0`, `carryAndUndo:true`**. Expiry preserves **`flaky → expired → defect`**, and stale-target answers conflict. Distinct causes with identical text, repositories, projects and environments stay separate. All **501 causes across 75 runs** are blocked and answerable. [Lifecycle](logs/rerun-lifecycle.log), [orders/expiry](logs/rerun-lifecycle-positive.log), [load](logs/rerun-r10-load.log), [scope matrix](logs/rerun-round9-scope-matrix.log).

The new three-preset lifecycle check expires a disputed answer, re-answers, corrects its failure, withdraws the answer, then disputes again. Each has **one expired ledger row**; standard/strict keep the producer **forbidden**, loose permits them. Sticky facts survive correction while the answer stands, and the gone cause dissolves after withdrawal. [Lifecycle script](scripts/r12-facts-lifecycle.mjs), [log](logs/r12-facts-lifecycle.log). A person's rejection of rule signoff survives **111** later passing reports; only a later human approval restores rule behavior. The map-rule analogue also passes. [Rule overrides](logs/rerun-r11-positive.log).

**B02** violates the required scope coverage: an open planned run remains passed on an excuse for its old scope, with no question about the now-unexplained live failure. The wider placement probe leaves unanswered old-scope questions stale as well. **B01/B03** violate the answer/withdrawal authority promise. None is the accepted pre-dispute-answer limit (#70).

### 7. Gate conservatism — issues

Verdict precedence, empty/skip/all-refused/agent-only commit pending states, expired-hold pending and lane folding pass. Other jobs/producers/skips cannot erase a failure in the executed lane histories. During the two live 100,000-result uploads, **168 and 169 accepted-phase gate reads all say pending**. Reader requests continue during application. Two real stop/restarts recover **100001** rows with **`stillAccepted:0`, `retryFresh:false`**. [Live gates](logs/rerun-live.log), [lanes](logs/rerun-lane-matrix.log).

Agent reports leave established commit gates unchanged in admitted/unadmitted variants. R11-B03 now establishes the first real head/base/title/files correctly; the real change gate is blocked and matches its commit. Agent-only failure questions remain open until answered. [Agent variants](logs/rerun-r11-agent-dispute-fixed.log), [initial head](logs/rerun-r11-agent-initial-change.log), [HTTP fix confirmations](logs/r12-r11-http-positive.log).

**B02 is a false pass:** target scope changes, **`coveringDecisions:0`**, but the still-open run reads **`passed`, `excused:1`, `open:[]`**. It reproduces in both directions and over HTTP.

### 8. Runs and slots — issues

Pinned methods/basis govern admission. A named run does not admit the wrong target. Human-only slots do not count test/agent methods; agents require both the obligation and pinned case to admit them. One result fills two runs. A fail beside another producer's pass remains disputed after 20 later writes. Multiple tests/causes remain counted. Closed runs reject directly named reports and retain their evidence snapshot. Reopening twice catches newer evidence and then a standing excuse; R11-B01 now preserves corrected discounted evidence. [Run probes](logs/rerun-probes.log), [methods/closed snapshots](logs/rerun-final-probes.log), [reopening](logs/rerun-r11-positive.log).

Required jobs remain pending for agent, skip-only, blocked-only and mixed typed-pass/auto-skip batches; a decisive automated result meets them. A self-only required-job plan is invalid. Broad and explicitly named **20001-case** selections are refused with no partial run; **20000** succeeds. [Jobs](logs/rerun-hunt-r2-person-meets-job.log), [boundaries](logs/r12-boundaries-positive.log).

The new placement-order matrix passes **1539 cases, `problems:[]`**: six actor orders, trunk/branch/PR/hash targets, repository presence, same/different environments, plus typed-result order and fork isolation. The targets move correctly. **B02** shows the missing next step: an existing run limited to another environment is not recomputed after its target moved. [Placement matrix](logs/r12-placement-order.log), [false pass](logs/r12-placement-false-pass.log).

### 9. Policy and actor/project access — issues

The 324-call matrix exercises all 15 operations and every answer for agents, CI and readers under all presets: **`probeErrors:0`**. Agents can only advise where the clause says so; advice writes no decision. CI cannot decide. A standard agent cannot adopt its own proposal. Readers cannot write. Scoped cross-project operations/events return **403**; sessions expose only authorized projects. Forgotten tokens return **401** and their stream closes. Policy-switch display now shows the current strict non-producer/reason requirement. [Matrix](logs/rerun-policy-matrix.log), [supplements](logs/rerun-policy-supplements.log), [HTTP access](logs/rerun-live.log), [current needs](logs/rerun-hunt-r2-stale-ask-after-policy-switch.log).

**B01:** a participant correctly excluded before settlement becomes eligible after `mistaken` or closure because the participant list is no longer recoverable. This also reproduces under strict; loose is a permissive control. **B03:** closure removes the dispute fact when the dispute arose after the standing answer; the original failure producer changes or withdraws under `failure-any`. Both are new actions after a dispute, outside #70. [Participant variants](logs/r12-settled-parties.log), [three presets](logs/r12-settled-policy.log), [closure variants](logs/r12-closed-later-dispute.log).

### 10. HTTP surface — pass

Real local requests: absent/same Origin **200**; foreign/null Origin, wrong Host and other scheme **401**. Server-mode anonymous session/events/project requests and all 15 operation routes return **401**. Login cookies are **HttpOnly, SameSite=Strict**, and are not accepted from another origin. Scoped reads/events return **403** outside their project; forget produces **401**. Sized and chunked oversized operation bodies return **413**, followed by a normal **200**. Every registry operation has a route and an OpenAPI entry. [HTTP probe](logs/rerun-live.log), [all anonymous operation routes](logs/rerun-checkpoint-live.log).

Read `serve`, `sessionOf` and `handleOp` as well as running them. The only unguarded responses are the documented health/API-description/login/logout/static UI paths and unknown-path 404. Extra surface routes are session-guarded. UI and transfer semantics remain outside scope. The reproduced application-logic defects are included in their engine checks above.

### 11. Concurrency and readers — pass for functional QA

Two 100,000-result HTTP rounds coexist with 40 writes each: **41 unique command sequences, 42 contiguous event sequences**, no lost/duplicate writes, reads answered meanwhile. 32 clients complete **128 committed readbacks**, all through workers with **0 fallbacks**. All nine read operations yield **27 replies and 10 refusals** identical to inline execution. Denied requests do not reach workers; a worker refuses writes. After a worker dies, **80 requests all answer**, with 19 safe inline fallbacks and replacement workers. Shutdown gives **`allWorkerExitsAwaited:true`, `remaining:0`**. [Concurrency](logs/rerun-live.log), [reader cases](logs/rerun-readers-live.log).

With the checkpoint alive, **538 writes commit**; after terminating only that thread, **80 more** commit; all **618** persist through restart. Inline mode reports 0 reader workers and the default for 16 cores is 8. These establish tested correctness/progress, not a latency bound. Performance and issue #60 are excluded. Reader code was written by the reviewer's provider, so this is not its required different-provider signoff. [Checkpoint](logs/rerun-checkpoint-live.log).

### 12. Decision 0012 departures — issues

| Departure | Verdict | Current evidence |
| --- | --- | --- |
| 1. Integer ids and public refs | pass | Registry flows use integer storage and C-/P-/Q-/R- refs; foreign-project refs refused. Import id mapping is excluded. |
| 2. Lanes vs slots; one commit; required jobs | pass | 4500 lane histories agree; all 201 targets admitted; unique prefix settled and ambiguity refused; jobs require a decisive automated result. Repo-unspecified plans spanning repositories are documented. |
| 3. Links, methods and agent influence | issues | Method/admission/agent-head cases pass. B03 fails the promise that current disputes govern new authority after closure. |
| 4. Failure answers and current authority | issues | Human inherited remains target-specific with no automatic rule; mistaken discounts named results. B01/B03 violate the retained participant/dispute authority promises. |
| 5. Browser drafts | not checked | Browser/device behavior is explicitly out of scope. |
| 6. Accepted report then sliced application | pass | Accepted gates pending, worker reads continue, recovery finishes, failed application rolls back. Accepted command binding is now durable. |
| 7. Closed snapshots and reopening | pass | Closed snapshots refuse late direct results; reopening catches later evidence/corrections/discounts. R11-B01 fixed. Person signoff rejection survives later reports. |
| 8. Holds, questions and recomputation | issues | Expiry/supersession/target holds pass; B02 leaves a live open run excused without a decision in its new scope or an answerable question. |
| 9. Version plus change-key review basis | pass | `claim` hashes case head plus change key; repeat basis is deduplicated, another change is distinct, result facts stay zero. [Executed probe](logs/r12-review-basis.log). Patch-tree invalidation is deferred. |
| 10. Whole-instance archive | not checked | Transfer/import/export behavior is excluded; incidental suite passes are not an archive review. |
| 11. Fifteen operations | pass | All 15 registry routes and OpenAPI entries agree; added operation/route mutations fail architecture checks. |
| 12. Input-only API description | pass | Input schemas are generated; replies are TypeScript types and a generic response envelope. |
| 13. Conflict resolution makes a proposal | pass | Delayed resolution re-merges; multi-edit/unauthorized payloads refused; adoption policy still applies. |
| 14. Automated contradictory claims retained | pass | Typed contradictions rejected; automated contradictions declined but retained, counted by commit gates and excluded from slots. |
| 15. Nothing proven stays pending | pass | Empty/skipped/refused/agent-only commit cases remain pending; skips preserve decisive lane evidence. Agent-enabled planned runs are separately admitted. |
| 16. Forward-only counted change heads | pass | Existing-head and late-report probes pass; R11-B03 first-real-report metadata/head now correct. |
| 17. Repositories and canonical failure scopes | issues | Physical placement/repository isolation pass 1539 new cases and 29 prior scope checks. B02 leaves old-scope answers/tallies on an affected open run after placement. |
| 18. Reserved manual keys | pass | Automated `case:n` keys refused; manual identity cannot be remapped. |

The four “What is not standing” exceptions and decision reversals are documented with their actual writers in [STANDING.md](STANDING.md).

## Earlier finding status

These statuses refer to executed reproduction inputs, with broader remaining failures stated explicitly. Full per-script output is in [EARLIER.md](EARLIER.md).

| Round-11 finding | Status on this revision | Deciding evidence |
| --- | --- | --- |
| R11-B01 discounted correction missed on reopen | fixed | `corrected:1` before/after undo; run and commit passed. [Original](logs/rerun-r11-correction-after-mistaken.log), [HTTP](logs/r12-r11-http-positive.log). |
| R11-B02 JSON record key order | fixed | Identical replies and seq=2; HTTP retry 200. List order remains significant. [Original](logs/rerun-r11-command-order.log). |
| R11-B03 initial agent change metadata/head | fixed | Head older001, base realbase, title Pipeline, files real.ts; change/commit both blocked. [Original](logs/rerun-r11-agent-initial-change.log). |
| R11-B04 accepted command binding lost on restart | fixed | Binding exists across a real stop/restart; changed content 409; rows remain 100001. [Original](logs/rerun-r11-command-crash.log). |
| R11-B05 new action after later dispute | fixed with a new problem | Open-run replacement/withdrawal now forbidden; after closure B03 admits both. [HTTP controls](logs/r12-r11-http-positive.log), [new case](logs/r12-closed-later-dispute.log). |
| R11-N01 capped list made total count fall | fixed | Initial and after-agent count both 501, displayed list remains 50. [Positive](logs/rerun-r11-positive.log). |
| R11-N02 named selection over 20000 | fixed | Both named and broad 20001 return invalid; no partial run, 20000 accepted. [Positive](logs/r12-boundaries-positive.log). |
| R11-T01 audit coverage | fixed with a new problem | Current deterministic regressions pass and added head/placement/job audits execute. R12-T01 identifies missing authority assertions and a missed placement sequence; closed-run admission remains an explicit exclusion. |

| Hunt finding | Status on this revision | Deciding evidence |
| --- | --- | --- |
| H1-01 prefix admits multiple commits | fixed | Ambiguous plan invalid, unique prefix resolved once, later collision excluded, phantomTargets=0. [Original](logs/rerun-hunt-r1-prefix-run.log), [positive](logs/rerun-r11-positive.log). |
| H1-02 agent/skipped batch meets jobs | fixed | Pending until decisive automated result; self-only job requirement invalid. [Original](logs/rerun-hunt-r1-agent-job.log), [positive](logs/rerun-r11-positive.log). |
| H1-03 answer before dispute continues | recorded as a limit | fail→pass→answer forbidden; fail→answer→pass retains old answer as #70 says. [Original](logs/rerun-hunt-r1-producer-settles-dispute.log). |
| H1-04 reopened run misses correction | fixed | Reopened run blocked, corrected=1, latest failure admitted. R11 discounted-correction extension also fixed. [Original](logs/rerun-hunt-r1-reopen-stale.log). |
| H1-05 agent moves change head | fixed | Existing change stays blocked on same head; initial metadata extension R11-B03 also fixed. [Original](logs/rerun-hunt-r1-agent-moves-head.log). |
| H1-06 rule overrides person's rejection | fixed | state=open/signoff=null after another pass; 111 additional reports still do not override the person. [Original](logs/rerun-hunt-r1-reject-overridden.log), [positive](logs/rerun-r11-positive.log). |
| H2-01 participant changes settled dispute | fixed with a new problem | All eight original Alice variants forbidden. B01 loses Bob after posthoc planning/carried answers; B03 loses a later dispute upon closure. [Original](logs/rerun-hunt-r2-producer-undoes-mistaken.log). |
| H2-02 agent chooses failure scope | fixed with a new problem | Original pipeline gates blocked in the correct change scope, with or without agent. B02 leaves a different environment's open planned gate falsely passed after all targets move. [Original](logs/rerun-hunt-r2-agent-names-scope.log). |
| H2-03 mixed typed/skip meets job | fixed | Typed+skip remains pending; per-result methods govern jobs. [Original](logs/rerun-hunt-r2-person-meets-job.log). |
| H2 observation: stale needs after policy switch | fixed | Current strict needs include non-producer/reason; no-reason invalid, agent forbidden. [Original](logs/rerun-hunt-r2-stale-ask-after-policy-switch.log). |
| H1 observation: repo-unspecified plan spans repos | recorded as a limit | Still admitted/disputed; departure 2 allows it. Explicit repo isolation passes. [Original](logs/rerun-hunt-r1-fork-fills-slot.log). |

## Defects, most severe first

### R12-B02: moving every target of a commit leaves runs for another environment falsely passed

Blocking gate defect. Reproduction: `bun scripts/r12-placement-false-pass.mjs`. Two independent runs reproduce both directions, trunk to change and change to trunk. Logs: `logs/r12-placement-false-pass.log` and `logs/r12-placement-false-pass-repeat.log`.

Under `strict`, plan an agent-enabled run over commit `relocate001` in `agent-env`. An agent reports a failure there as trunk. A person answers `flaky`; the run is passed and still open. The first pipeline report names the commit as `pr:7` in `pipeline-env`, with an unrelated pass. `ensureTarget` correctly moves every target of this commit to the pipeline's scope, including `agent-env`. However, the earlier run is not recomputed. It remains `passed`, with one excused failure, no open question and no decision covering the new scope. Reporting in the same environment is a control: that run becomes `blocked` with a new question.

Deciding output for the other-environment case: `currentScope:"change:1"`, `coveringDecisions:0`, `runState:"open"`, `gate.verdict:"passed"`, `tally.excused:1`, `open:[]`. The only excuse remains `scope:"line:trunk@app"`. The reverse move gives the same false pass. Summary `falsePasses:2`. The wider placement probe also leaves an unanswered open failure attached to its obsolete scope until somebody answers it, at which point another question appears.

Cause: `tree/src/server/evidence/evidence.ts:121` and `ensureTarget` update all targets with the commit's `what`, while `acceptReport` and `processBatchSteps` in `tree/src/server/ops/writes.ts` mark and recompute only `runsFor` the arriving target. The environment-filtered run does not match that target even though its own target changed.

Contradicts P3, check 6's scope coverage, and decision 0012 departures 8 and 17. The run is explicitly open, so the documented closed-run snapshot exception does not apply. H2-02's original gate fixture is fixed, but the relocation introduces this stale run projection.

### R12-B01: settlement forgets a participant whom the dispute clause excludes

Blocking policy defect. Reproduction: `bun scripts/r12-settled-parties.mjs`. Both runs reproduce 12 incorrect authorizations among 16 variants. The three-preset probe `scripts/r12-settled-policy.mjs` additionally reproduces the same wrong withdrawal under `strict`; `loose` permits it by policy and is the control (`logs/r12-settled-policy.log`). Logs: `logs/r12-settled-parties.log` and `logs/r12-settled-parties-repeat.log`.

Under `standard`, Alice reports a failure and Bob reports a pass of the same case/target before a run is planned over them. The planned slot is disputed. Bob's initial `infra` answer is correctly `forbidden`. Carol, who produced neither result, answers `mistaken`. Bob can now withdraw her answer (`reopened`) or replace it (`decided`). If Carol answered `flaky`, Bob becomes eligible when the run closes. The same failure occurs when the run exists first but Bob's pass arrives while a previous answer stands.

Deciding output: `storedProducers:[3]`, `bob:4`, `storedFacts:["scope:trunk","hint:disputed"]`, `control:"forbidden"`, followed by `action:"reopened"` or `action:"decided"`; summary `incorrectlyAllowed:12, variants:16`. The kept dispute flag chooses the right clause, but not the right people.

Cause: `failureHandler.isProducer` in `tree/src/server/decisions/kinds.ts:413` retains failure reporters, then checks other participants only through `openPlannedAbout` and current `partiesTo`. Closing the run excludes it. A `mistaken` decision removes the cause from the slot. Neither path remembers Bob when he was not appended to the question's `producers`. `setQuestionFacts` retains the dispute fact alone.

Contradicts P5 and decision 0012 departure 4: an answer given to a dispute must remain unavailable to the people it was kept from. This is outside issue #70 because Carol gives the challenged answer after the dispute exists. H2-01's original reporter fixture is fixed; the participant variants are not.

### R12-B03: closing a run relaxes authority for a dispute that arose after the standing answer

Blocking policy defect. Reproduction: `bun scripts/r12-closed-later-dispute.mjs`, confirmed twice. Logs: `logs/r12-closed-later-dispute.log` and `logs/r12-closed-later-dispute-repeat.log`.

Under `standard`, Alice fails C-1 and answers `flaky` before Bob passes it. The run also needs C-2, so it stays open. The disputed slot correctly keeps Alice from changing or withdrawing her answer. Bob then passes C-2 and the rule closes the run. Although C-1 remains `disputed`, the question now says `needs:"one member"` and loses `hint:disputed`. Alice can replace her answer with `infra` under `failure-any`, or withdraw it. Both actions were `forbidden` immediately before closure.

Deciding output: open controls are `forbidden`; closed variants are `reopened` and `decided`. The ledger records the newly given `infra` and the withdrawal under `failure-any`, not `failure-disputed`. Summary `incorrectlyAllowed:2`.

Cause: `Q.disputedSlots` in `tree/src/server/runs/runs.ts:189` ignores a closed run whose tally has zero *unresolved* disputes. The old flaky answer makes that tally zero even though the slot still disputes the evidence. `factsNow` in `tree/src/server/decisions/decisions.ts:1070` retains the dispute only if it was stored when the answer was given; here it arose later. This differs from B01, which retains the dispute clause but forgets a participant.

Contradicts decision 0012 departure 4 and the brief's explicit promise that every new answer, replacement or withdrawal from the moment of a dispute meets the dispute clause. Issue #70 allows the original answer to stand. It does not authorize these new decisions after closure. R11-B05's original open-run fixture is fixed, but this closed-run path remains.

## The tests do not prove this

### R12-T01: the sequence audits have no check for the demonstrated authority failures

Nonblocking proof gap, separate from B01 and B03. `scripts/r12-audit-extract.py` copies both audit bodies and their scope functions from this revision without changing them. `scripts/audit-r12-settled-parties.mjs` and `scripts/audit-r12-closed-later-dispute.mjs` run those audits immediately after the real operations in the reproductions. Both return `null` in every variant, including the twelve and two incorrect authorizations. Logs: `logs/audit-r12-settled-parties.log` and `logs/audit-r12-closed-later-dispute.log`.

This is not true of B02: given either false-pass state, both current audits report `a live run shows an unexplained failure nobody is asked about`. The state is missing from the generated sequences, rather than missing from those assertions. The placement trace is supplied explicitly to the extracted extended audit. The actual `300`-seed and `150`-seed suites each pass all three presets on this revision.

The deterministic H2-01 test creates the run before the results, so both participants are kept on the question; it does not prove authority for a run planned over prior results or a second participant arriving while an answer stands. The R11-B05 regression keeps the run open, so it does not prove the same authority after closure.

## Worth doing later and scope limits

Automatic inherited classification (#69), the original answer-before-dispute ordering (#70), performance (#60), browser drafts and transfer behavior are not new defects from this review. No additional later-work recommendation is needed to explain the three blockers. Current-provider functional evidence for the reader subsystem does not replace its different-provider verification gate.

## Export and cleanup

All **412 archived files** match the initial export, with no extra source files. All review servers have stopped; no review-owned `/tmp` data remains. Only this export's dependencies were released. [Source integrity](logs/final-integrity.json), [cleanup](logs/cleanup.json). The shared repository checkout was never changed or cleaned. Reproduction scripts, logs and reports remain in this directory.

ISSUES (3 blockers)
