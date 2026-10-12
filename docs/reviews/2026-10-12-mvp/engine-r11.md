# Casebook engine QA review, round 11

Revision: **`77fc9a73df8244914aaebc2de36daa7a5003f086`**, branch `t3/mvp-product-delivery`.

**Five blocking defects.** The earlier 200-target omission, agent-induced withdrawal and stale planned-gate reproductions are fixed. New combinations still break reopening, change-head selection, current policy authorization and command identity. The requested long sequence runs pass; minimized counterexamples show what they miss.

Reviewer: Codex, GPT-6 Astra, independently exercising the engine written by Claude Opus 5.5. Reader threads were written by Codex GPT-6.1 Sol: check 11 below is functional QA evidence, not a different-provider signoff on that subsystem. No other agents were used and no author-run result was accepted as evidence.

Everything ran locally in this revision's clean archive under `engine-r11/tree`. The shared checkout was read only with `git archive`; it was never edited, installed into or cleaned. The brief's scope exclusions were observed. The only out-of-scope suite failure was the disk-budget test refusing `/tmp` on tmpfs; no performance verdict is offered. Browser drafts, archive semantics and UI behavior are not approved by this review.

The correctness fact under review: a gate must reflect all and only the evidence it admits; an excuse must have an applicable recorded decision; an agent report must not change commit standing; reopening must refresh admitted evidence and decisions; and a command id must identify one request. The five counterexamples below violate these facts through ordinary operations.

All 117 inherited/hunt/oracle probes were run first. Their individual dispositions, including old assertions that now fail as expected, are in [EARLIER.md](EARLIER.md). The current SQL/writer/caller inventory and the four stated exceptions are in [STANDING.md](STANDING.md). Raw outputs and executable reproductions are retained under `logs/` and `scripts/`.

Reproduction commands in this report run from `/home/endqwerty/.cache/casebook-arena/verify/engine-r11`. After cleanup, install dependencies with `bun install --frozen-lockfile` in its `tree/` first. HTTP scripts own ports in 8450–8499 and remove their own temporary data. Each blocking scenario was repeated; B01/B02/B03/B05 were also reproduced over HTTP with two reader threads, and B04 was repeated using a real process stop between report acceptance and application. See [r11-findings-http.log](logs/r11-findings-http.log) and the `*-confirmed.log` files.

## Required checks

### 1. Author tests and the strength of their assertions — issues

Ran `bun test src test --path-ignore-patterns 'test/e2e/**'`, `bunx tsc --noEmit` and `bunx biome check src test bench`, through [author-checks.py](scripts/author-checks.py). Only temporary test ports and the budget data directory were changed to obey the brief; they were restored. Deciding output: **`599 pass`, `1 fail`, `16530 expect() calls`**, across 600 tests/29 files. The failure is out of scope: the on-disk budget fixture rejects tmpfs. Typecheck exited 0. Lint exited 0: **`Checked 182 files ... No fixes applied.`** [Test log](logs/author-tests.log), [check summary](logs/author-checks-progress.log).

Also ran exactly `CASEBOOK_SEQUENCE_SEEDS=300 bun test test/sequences.test.ts` and `CASEBOOK_SEQUENCE_SEEDS=200 bun test test/sequences-extended.test.ts`: each reports **`3 pass`, `0 fail`**, under loose, standard and strict. [300-seed log](logs/sequence-author-300.log), [200-seed log](logs/sequence-extended-200.log). My current-state checker independently reports **`80` seeds, `12000` checks, `problems:0`**; lane enumeration reports **`4500` sequences, `13500` observations, `commitAndSlotAgree:true`**.

Architecture mutations were tested one at a time: upward import, second mint import/call, foreign-table SQL, raw domain SQL, writer ignoring its witness, invalid declared SQL, outside SQLite/undo calls, core I/O, web/server import, duplicate operation and a second operation path. Each makes its intended check fail. A plain structural witness is **not** rejected by the architecture test alone (`12 pass`), but typecheck rejects it with **`TS2739 ... missing ... #decision, #kind, #signers, #expiresAt`**. Removing the runtime witness-kind guard fails both the author's regression and my independent standing probe; removing the mistaken-answer key fails the policy regression. [Mutation summary](logs/architecture-summary.log), [remaining boundaries](logs/rerun-architecture-last.log).

The issue is proof strength, **R11-T01**, not a claim that an in-scope baseline test failed. The original audit accepts B01; both audits accept B03/B05 and a deliberately restored version of the old false signoff after 200 targets. The extended audit detects B01 once supplied that state, but its generator missed it. After restoring all mutations the architecture suite passes **`12 pass`, `0 fail`**. [Final architecture log](logs/architecture-final.log).

### 2. Standing changes require a recorded decision — issues

[STANDING.md](STANDING.md) lists every scoped standing statement and decision/caller path, including case-head copies, placement/tags/state, links, excuses, closing/reopening, policies, coverage and slot corrections/discounts. Runtime construction and second-mint attempts are refused; genuine adopt/failure/signoff witnesses are rejected by wrong-kind writers with **`noLedgerChanges:true`**. Seven missing-ledger foreign keys reject insertion; **`foreignKeyViolations:[]`**. [Standing log](logs/rerun-standing.log), [foreign-key log](logs/rerun-foreign-keys.log).

The four exceptions match their stated authority purpose. Prior undo probes preserve newer links/signoffs/target excuses and corrections made in an open run. **B01** violates the complete reversal promise: a correction made while a discounted result's run is closed is omitted on reopening, so withdrawing the judgment restores evidence its producer already corrected. There is no demonstrated missing witness or ledger row; the wrong history is restored under a valid withdrawal.

### 3. Idempotency and atomicity — issues

Ordinary checks pass: **`firstSeq:2`, `retrySeq:2`, `changedOp:conflict`, `changedActor:conflict`, `lateRollbackUnchanged:true`**; reuse in another project is conflict. An instance project command replays; token creation retry conflicts and stores no token text. The new 10,000-result retry is identical with known-schema properties reordered; changed content conflicts, and stored request digests are 64 characters. [Original probes](logs/rerun-probes.log), [positive commands](logs/r11-positive.log).

150 interleaved in-process commands produce **`events:150`, `unique:150`, `first:2`, `last:151`, `failedCommandsConsumeSeq:false`**. Both live 100,000-result rounds plus 40 case writes produce 41 distinct command sequences and 42 contiguous event sequences. A deliberately late apply failure rolls back its partial result rows, leaves only that batch accepted, and does not prevent recovery of other reports. [Recovery log](logs/rerun-r10-recovery-failure.log).

Two new failures remain: **B02**, identical record content in another JSON key order conflicts; **B04**, recovery applies an accepted batch but loses its command binding, then accepts changed content under that id. Deciding HTTP outputs are **first `200`, retry `409`** for B02, and **`pendingObserved:true`, `commandBefore:null`, changed request `200/fresh:true`, results `100001 → 100002`** for B04.

### 4. Edits never overwrite — pass

Reran `probes`, `new-probes`, `policy-supplements`, the suite tests and integrity tests. Stale disjoint edits merge; same-field conflict preserves both versions. A delayed conflict resolution is based on the version it saw and merged again: **before version 4, after version 5, title `Resolved`, precondition `New work after conflict` preserved**. Multi-case/policy conflict resolution by an unauthorized author is forbidden; standard agent self-adoption is **`forbidden`, `cases:0`**. Restore appends a version; tag proposals apply over current tags (**`[human] → [agent,human]`**); a folder cycle is refused **`invalid`**. The existing tests and probes exercise the actual `invoke`/adopt paths, not just merge helpers. [Probes](logs/rerun-probes.log), [policy supplements](logs/rerun-policy-supplements.log).

### 5. Evidence says what it proves — pass

Reran basis, mixed-method, declined-result, reserved-key, correction and Unicode probes plus the in-scope evidence/integrity tests. Basis counts are **`exact:1`, `assumed:1`, `unresolved:1`**. A conflicting typed case is rejected with both slots missing. An automated bad annotation is retained without a case and listed in `declined`; its failing commit is blocked. Cross-project refs and corrections of another producer/target are refused. Per-result methods are **person `[human,auto]`, pipeline `[auto,auto]`, agent `[agent,agent]`**. A repeat of 100,000 results leaves **`rows:100000`, `batches:1`, `retryFresh:false`**. Unpaired surrogate input is invalid and truncated text remains well formed. [Original probes](logs/rerun-probes.log), [round 3](logs/rerun-round3.log), [final probes](logs/rerun-final-probes.log).

The new one-commit checks resolve a unique prefix to its full hash, admit no later colliding-prefix commit, refuse ambiguous planning, and treat an unknown prefix literally. Typed evidence lands on the resolved hash, **`phantomTargets:0`**. The 201st target remains visible for environment/repository/prefix decisions. [New positive cases](logs/r11-positive.log), [boundary cases](logs/r11-boundaries.log). Reopening a previously discounted correction is a separate failure in checks 2/7/8, not a false annotation accepted during ingest.

### 6. Cause questions, holds and honest re-asking — issues

500 failures produce **one question**, count 500, and all 500 are excused by one applicable answer. Six three-environment answer orders complete **36 decisions**, **`extraQuestions:0`**, **`carryAndUndo:true`**. Both expiry orderings retain **`flaky → expired → defect`**, with the new question linked to its predecessor and no orphan excuse. Stale target evidence conflicts. Distinct causes with the same text, scopes, projects and environments remain separate. All 501 causes across 75 runs are blocked and answerable; all accepted batches finish. [Lifecycle](logs/rerun-lifecycle.log), [answer orders](logs/rerun-lifecycle-positive.log), [load](logs/rerun-r10-load.log), [scope matrix](logs/rerun-round9-scope-matrix.log).

A rule's decision retains its clause. Map withdrawal survives a subsequent report. A person's signoff rejection survives **111** later passing reports; after a person approves, withdrawal and another report allow the rule again. The map variant likewise holds the rule back until a person gives its answer; withdrawing an already adopted proposal remains invalid. Counted-only failure closure was exercised with 501 tests and agent-only reports; agent-only failure questions stay open. [New positive cases](logs/r11-positive.log).

**B05** lets a new answer/withdrawal after a dispute use old nondispute facts. **B01** re-asks a failure its producer has corrected. The original H1-03 answer-before-dispute ordering remains the accepted limit, not another blocker. The 501-test summary count loss is nonblocking N01.

### 7. Gate conservatism — issues

The verdict ordering and pending empty/skip/declined/agent-only cases pass. Expired holds read pending without another report. Lane enumeration covers 4,500 histories; other jobs, producers and skips do not hide a failure. For both live 100,000-result reports, **167 accepted-phase reads per round all return pending**, and reads continue during application. Two ordinary crash/restarts recover exactly once: **`resultsAfter:100001`, `stillAccepted:0`, `retryFresh:false`**. [Live log](logs/rerun-live.log), [lane log](logs/rerun-lane-matrix.log).

The old R10 agent-change reproduction is fixed for both admitted and unadmitted agent results: the entire commit gate stays unchanged. A pipeline promotes an agent-only commit and agent-only failure questions remain open. But **B03** leaves a newly agent-created change on its placeholder head when its first real report names an earlier-seen commit: **change pending, actual commit blocked**. **B01** leaves a reopened run blocked/disputed while its commit correctly passes. These are stronger claims than the evidence supports or inconsistent selected evidence, respectively.

### 8. Runs and slots — issues

Pinned version methods and basis govern admission. Naming a run does not bypass its target; a human-only pinned case stays missing for an agent. An opted-in agent run can pass while its commit stays pending. A fail beside another producer's pass remains disputed after 20 more writes. Job/environment lanes retain every failing cause; results can fill two runs. Closed runs reject directly named reports and preserve their snapshot through later corrections. Required jobs now remain pending for agent, skip-only and blocked-only batches, then pass for decisive pipeline evidence; a self-only run requiring a job is invalid. [Original and final probes](logs/rerun-final-probes.log), [round 3](logs/rerun-round3.log), [new positives](logs/r11-positive.log).

The original reopen-stale correction is fixed. Reopening twice catches a later failure and then a still-standing flaky decision: **first blocked, second passed, heldExcuse:1, still open**. **B01** supplies the missing combination: discounted failure, producer correction while closed, reopening, then undo of that discount. `corrected` remains 0 and the old failure returns. The literal 20,000 broad-selection bound now rejects overflow without a partial run; explicitly named larger selections are complete but unbounded (N02).

### 9. Policy and actor/project access — issues

`policy-matrix` executes all 15 operations and every answer for agent, pipeline and reader under loose/standard/strict: **324 calls, `probeErrors:0`**, with clause selection printed. Supplementary disputed `mistaken` cases yield agent advice only under loose and no decision; pipelines are always forbidden. Standard agent self-adoption is forbidden. Readers cannot write. Cross-project reads/events return 403; the session lists only the authorized project. Forgotten tokens return 401, and their open stream closes. [Policy matrix](logs/rerun-policy-matrix.log), [supplements](logs/rerun-policy-supplements.log), [HTTP](logs/rerun-live.log).

**B05** is the remaining lifecycle hole: `standard` correctly forbids a producer's first answer to an already disputed slot, but lets the same producer replace or withdraw an older answer after that dispute. The newly made `infra` decision names `failure-any`, not `failure-disputed`.

### 10. HTTP surface — pass

Real local requests: absent/same Origin **200**; foreign/null Origin, wrong Host and other scheme **401**. Server-mode anonymous project/session/event requests are **401**; every one of the 15 operation routes was also checked anonymously. Same-origin login cookies are HttpOnly/SameSite=Strict and other-origin cookie use is refused. Scoped token reads/events are **403** outside the project; forget makes the token **401**. Sized and chunked oversized operation bodies each return **413**; the next normal request is **200**. All registry operations have routes and generated OpenAPI entries. [HTTP log](logs/rerun-live.log), [all anonymous operations](logs/rerun-checkpoint-live.log).

Read `serve()` and `handleOp()` as well as running them. The only unguarded responses are the documented health/API-description/login/logout/static UI routes and unknown-path 404; extra routes are wrapped in the session guard. UI and transfer behavior behind those routes are out of scope. The command identity failures through this transport are assigned to check 3, not hidden by this surface verdict.

### 11. Concurrency and reader threads — pass (functional QA; provider qualification above)

Two rounds of 100,000-result HTTP uploads coexist with 40 case writes: **41 unique command sequences, 42 contiguous event sequences, no lost rows**. Readers answer meanwhile. 32 simultaneous clients make **128 committed readbacks**, all worker-completed with **0 fallbacks**. Nine read operations give **27 replies and 10 refusals** identical to inline execution. A denied request never reaches a worker; the worker itself refuses a write. After worker termination, **80 requests all answered**, 8 safely replayed inline; replacement workers run, and shutdown reports **`allWorkerExitsAwaited:true`, `remaining:0`**. [Reader log](logs/rerun-readers-live.log).

The checkpoint test records **576 commits while its thread lives**, then **80** after its termination, and **656** persist after restart. Inline readers are 0; an emulated 16-core default is 8. [Checkpoint log](logs/rerun-checkpoint-live.log). These establish the tested correctness and progress properties, not a timing bound or performance claim; issue #60 remains outside this review.

### 12. Decision 0012 departures — issues

| Departure | Verdict | Current-code evidence |
| --- | --- | --- |
| 1. Integer ids/public refs | pass | The registry/probe flows create integer ids and use C-/Q-/R-/P- refs; cross-project refs are refused. Merge/import ids are out of scope. |
| 2. Test lanes vs slots; one commit; required jobs | pass | 4,500 lane sequences; all 201 targets admitted; prefix resolved once; ambiguous planning refused; agent/skip/blocked batches do not meet jobs. Multi-repository accepts without repo remains documented. |
| 3. Links, pinned methods and agent influence | issues | Method/basis checks pass and agent-only commits have no run. B03 lets an agent-created change retain its placeholder head/metadata over the first real report. B05 uses stored dispute facts for new authority rather than the current slot state. |
| 4. Failure answers and current authority | issues | Human inherited is target-specific and never an automatic rule; mistaken scopes are fixed. The accepted answer-before-dispute limit remains, but B05 grants a new answer/withdrawal after the dispute, wider than stated. |
| 5. Browser drafts | not checked | UI/device behavior is explicitly outside this engine review. |
| 6. Acceptance then sliced application | pass | Live accepted-phase gates are pending, reads continue, recovery finishes, and a failed apply rolls back its partial rows. Command-binding failure B04 is separately a kernel contract defect. |
| 7. Closed snapshots and reopening | issues | Closed snapshots and repeated-reopen positives pass; B01 misses a producer correction when the old result is already discounted. Signoff overrule tests pass. |
| 8. Holds, closure and recomputation | issues | Target/environment, expiry, supersession, current open question and large-cause checks pass. B01 breaks exact reopened evidence under reversal. The claimed sequence checking omits closed-run completeness and accepts its false-signoff mutation (T01). |
| 9. Version plus change-key review basis | pass | Same case/version/change shares a review basis; another change produces a second row. Patch-tree invalidation is expressly deferred. |
| 10. Whole-instance archive | not checked | Transfer/import/export implementation is excluded. The ordinary suite's incidental archive passes are not an archive review. |
| 11. Fifteen operations | pass | 15 registry declarations match all HTTP routes and OpenAPI entries. No separate scoped capability path; architecture mutation fails when one is introduced. Deferred operations are absent. |
| 12. Input-only OpenAPI schemas | pass | `openApi()` generates input schemas; output is a generic typed envelope. No claim of output-schema validation. |
| 13. Conflict resolution makes a proposal | pass | Stale resolution preserves later edits; unauthorized/multi-edit resolution is refused; standard agent cannot adopt itself. |
| 14. Automated contradictory claims retained | pass | Invalid typed claims rejected; invalid test annotations become declined, retain their failure in the gate and fill no slot. |
| 15. Nothing proven remains pending | pass | Empty, skips-only, all-declined and agent-only commit cases; later skip never replaces decisive lane evidence. |
| 16. Change head moves forward on counted reports | issues | Existing-head/late-upload cases pass. B03: agent-created placeholder prevents the first pipeline report from establishing the real head. |
| 17. Repository and canonical failure scope | pass | 29 scope checks; explicit repository gates, no foreign-base hint, and >200-target repository ambiguity refusal. A repo-unspecified planned selector can intentionally span repositories as departure 2 states. |
| 18. Reserved manual test keys | pass | Automated case:n keys refused; genuine manual identity cannot be remapped. |

The kernel's built-table promise that a command id names one request also has **B02/B04**. The four “What is not standing” exceptions and the controlled reversal functions are judged individually in [STANDING.md](STANDING.md).

## Earlier finding status

| Finding | Disposition | What the same input does now |
| --- | --- | --- |
| R10-B01 | fixed | Original expected blocked now returns passed. Both admitted/unadmitted variants leave complete commit gate and ledger unchanged. |
| R10-B02 | fixed | Required lint exits 0, 182 files checked. |
| R10-B03 | fixed | Only the original target's results are discounted; untouched staging remains disputed and its gate stays consistently blocked. When both runs hold the named result, both recompute to passed/closed. |
| R10-B04 | fixed | All 201 targets admitted; planned and specifically selected late-environment gates are blocked/open. Late repository lookup is explicit and correct; ambiguous selectors do not yield false passes. |
| R10-T01 | not fixed | More open-state invariants exist and pass their requested seeds; extended audit detects B01 supplied directly. Both audits still accept a restored false closed signoff and miss B03/B05. See T01. |
| H1-01 | fixed for prefix; not fixed for the documented fork behavior | Prefix planning now resolves one full hash; ambiguous prefix is invalid and typed reports create no phantom hash. The separate fork script still admits a later fork for a repo-unspecified selector; departure 2 now explicitly permits it. |
| H1-02 | fixed | Agent/skips/blocked reports leave required job pending; decisive pipeline evidence satisfies it; self-only required-job plan invalid. |
| H1-03 | recorded as a limit; wider than stated | Original before-dispute answer persists exactly as documented. B05 separately permits a new answer and withdrawal after the dispute. |
| H1-04 | fixed with a new problem | Original corrected result is withdrawn on reopening and newer failure admitted. B01 misses that correction when the result was already discounted. |
| H1-05 | fixed with a new problem | Existing change head stays put after agent reports, and agent-only new commit has no run. B03 finds the initial agent-created change path. |
| H1-06 | fixed | Person rejection keeps run open on new evidence; 111 further reports preserve it, and person approval returns control to the rule. |

Every inherited script's output and any remaining unexecuted tail are recorded individually in [EARLIER.md](EARLIER.md); a script stopping at its now-false defect assertion is not treated as full coverage of its later scenarios.

## Defects

### R11-B05: the recorded dispute limit also permits a new answer after the dispute exists

Blocking policy defect. This is wider than the accepted H1-03 limit, which allows an answer given before a dispute to remain in force. Reproduction: `bun scripts/r11-new-answer-after-dispute.mjs`.

Under `standard`, Alice fails a case, answers `flaky`, and Bob then passes it. The slot is now disputed. Alice submits a new `infra` answer after that dispute. It is accepted and creates a new decision under `failure-any`. Alice can also withdraw her answer during the dispute. As a control, without the earlier flaky answer, Alice's new infra answer on the same disputed slot is `forbidden` by `failure-disputed`.

Deciding output in `logs/r11-new-answer-after-dispute.log`: all three slots are `disputed`; the control has facts `["scope:run","hint:disputed"]` and status `forbidden`; replacement/withdrawal retain facts `["scope:run"]` and return `decided`/`reopened`. The new infra decision names `failure-any`.

Cause: `raise` (`tree/src/server/decisions/decisions.ts:145`) returns early when carrying a standing answer and only updates its refs/counters. `answer` (`:443`) and `undo` (`:696`) select policy from the question's old stored facts. The new `inDispute` lookup is used while raising, but not when authorizing a new answer or withdrawal. Contradicts departure 4's promise that authority is judged when an answer is given and withdrawal follows the current clause. Keeping the old answer standing does not justify granting a new decision under its obsolete dispute facts.

### R11-B04: accepting a report does not durably bind its command id

Blocking idempotency defect, reproduced on a real HTTP server stopped between acceptance and application. Reproduction: `bun scripts/r11-command-crash.mjs`.

Send a 100,000-result report with a command id, observe the commit gate turn pending, stop the server process, and restart it. Recovery correctly applies all 100,000 results. Send a different report under that same command id. The server accepts it as a new batch instead of refusing it.

Deciding output in `logs/r11-command-crash.log`: `pendingObserved:true`, `recovered:100001`, `commandBefore:null`, changed request HTTP `200` with `fresh:true`, and `resultsAfter:100002`. The script kills only its own server and removes its own data directory in `finally`.

Cause: `execute` records the request digest and command id only after the operation finishes (`tree/src/server/ops/registry.ts:212`). The acceptance transaction commits the batch but no command row. `recoverAccepted` applies the batch without recreating that binding. The new digest check therefore cannot enforce request identity after a crash. Contradicts the command-id contract and check 3's idempotency across accepted reports and recovery.

### R11-B01: reopening misses producer corrections of results already discounted by a decision

Blocking correctness defect. Reproduction: `bun scripts/r11-correction-after-mistaken.mjs`. A pipeline fails one case, another producer passes it, and a person answers `mistaken`. The run passes and closes. While it is closed, the pipeline corrects its failure to a skip. Withdraw the signoff, then withdraw the `mistaken` answer.

The reopened run counts the withdrawn failure again and becomes blocked/disputed, while the commit gate correctly passes. Deciding output in `logs/r11-correction-after-mistaken.log`: the original result still has `corrected:0`; after the mistaken answer is withdrawn it also has `discounted_by:null`; the run is `blocked` with `disputed:1`, and the commit is `passed`.

Cause: `catchUp` (`tree/src/server/runs/runs.ts:1262`) iterates `Q.admittedTo` (`:274`), which excludes results with a non-null `discounted_by`. It therefore never sets their correction flag. `restoreFailures` later removes the discount and `refreshSlot` counts the old result. Contradicts decision 0012 departure 7 and the promise that withdrawing a decision preserves a producer's independent correction. Only ordinary `invoke` calls produce this state.

### R11-B03: an agent-created change keeps its placeholder head over the first pipeline report

Blocking change-gate defect. Reproduction: `bun scripts/r11-agent-initial-change.mjs`. A pipeline first reports commit `older001` on trunk. An agent then reports a different commit `agent001` as a new `pr:7`, with its own base/title/files. The pipeline's first report naming `pr:7` fails on `older001` and supplies the real base/title/files.

The commit gate correctly becomes `blocked`. The change gate remains `pending`, pointing at the agent-only commit, and its base/title/files still come from the agent. Deciding output in `logs/r11-agent-initial-change.log`: change head `agent001`, base `agentbase`, title `From agent`, while the real report's gate is `blocked`.

Cause: `upsertChange` (`tree/src/server/evidence/evidence.ts:430`) inserts a normal change head for the first agent report. Later `upsertChange` compares `targets.first_seq` including agent-only targets and refuses the pipeline's head as older. The check does not distinguish an agent placeholder from a head established by evidence a gate counts. Contradicts decision 0012 departures 3 and 16 and the new function's stated promise that the first pipeline or person establishes the head.


### R11-B02: command retries depend on JSON object key order inside a record

Blocking command-contract defect. Reproduction: `bun scripts/r11-command-order.mjs`. Send `propose` with command id `reordered-request-001` and body fields `{a:"one",b:"two"}`. Retry the same JSON request with the fields serialized as `{b:"two",a:"one"}`.

The first reply is adopted at sequence 2. The retry returns `conflict`, saying the id was used for another request. Reordering known schema properties replays correctly; reordering the record's properties does not. See `logs/r11-command-order.log`.

Cause: `ops/registry.ts:80` hashes `JSON.stringify(parsedInput)`. Zod reconstructs known objects in schema order, but preserves insertion order in `CaseBody.fields`, a supported string record which the suite stores. This is the same request serialized differently, with identical field names and values. It contradicts the command-id retry contract in decision 0012 and check 3. The digest needs a canonical representation of objects while preserving meaningful array order.

## The tests do not prove this

### R11-T01: the larger sequence runs pass without exercising several remaining failures

Both requested runs passed on this revision: 300 seeds per preset in `sequences.test.ts` and 200 per preset in `sequences-extended.test.ts`, each reporting `3 pass, 0 fail`. The independent current-state checker also finished 80 seeds and 12,000 checks with no problems. These outcomes do not establish all the contracts above.

`scripts/r11-audit-extract.py` copies each current audit and its scope helper unchanged into `r11-audits.ts`. Executing them on the minimized reproductions gives:

- B01: the original audit returns null. The extended audit correctly reports `11: a slot counts a result its producer has corrected`; its generator did not reach this combination in the requested run.
- B03 and B05: both audits return null on the demonstrated wrong states. They do not judge a change's selected head against agent-only evidence or the clause authorizing a new answer after a dispute.
- R10's 200-target false signoff still escapes both audits. `python3 scripts/r11-audit-mutation.py` temporarily restores that old query cap only in this export, then creates 201 environments. The run is passed/closed with 200 admitted results while its commit is blocked. Both current audits return null because admission and planned tally checks skip closed runs. The source is restored in `finally`. The real revision has removed the cap; this is a demonstrated proof gap, not a newly claimed application defect.

Raw evidence is in `logs/audit-r11-*.log` and `logs/r11-audit-closed-targets.log`. The expanded audits improve open-run coverage, but the old R10-T01 claim is only partly addressed. The findings above need deterministic checks of the missing inputs and boundary conditions.

## Worth doing later

These observations do not add blockers.

- **R11-N01, failure-question count:** in `r11-positive.mjs`'s `counted-mark-large-question`, 501 pipeline failures with one cause produce `count:501` and the intended 50 displayed test entries. An agent's report of one additional test with that cause changes the stored/displayed count to 51, although the commit still counts all 501 failures. This is a summary-count loss, not lost gate evidence. The later pipeline pass closes the counted failure as described in departure 8. Evidence: `logs/r11-positive.log`.
- **R11-N02, selection-limit wording:** `r11-boundaries.mjs` proves a broad selection accepts exactly 20,000 cases and refuses 20,001 without creating a partial run. An explicit `select.cases` list of 20,001 is accepted in full because the early named-selection return bypasses `MAX_SELECTION`. This is not silent omission, so it does not revive R10-B04, but the brief's statement that every selection over 20,000 is refused is broader than the implementation. Evidence: `logs/r11-boundaries.log`.
- The hunt's fork variant still admits a later fork's result when the plan names only `{commit}`. Departure 2 now explicitly describes counting one commit across repositories; specify `repo` to restrict that selection. H1-01 is not fixed in every original sense, although its prefix/phantom-commit defect is fixed. See `EARLIER.md`.

## Export integrity and cleanup

All **408** exported tracked files match the pre-test archive hashes; no temporary source mutations remain. The final clean architecture run passes **12 tests, 0 failures**. Review runtime processes and listeners on ports 8450–8499 are gone. The export's dependencies/test output and the review's remaining `/tmp` budget directory were removed; no `casebook-engine-r11*` temporary data remains. Source, scripts, logs and reports are retained. No cleanup or mutation was performed in the shared checkout. [Integrity evidence](logs/export-integrity.json), [cleanup evidence](logs/cleanup-r11.json).

ISSUES (5 blockers)
