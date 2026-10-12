# Casebook engine verification, round 1

Revision: **490aaf539c4ae39271ba0bcb9a9741d24db12650**, branch `t3/mvp-product-delivery`.

**ISSUES: 19 blocking findings.** The author's 85 tests pass. Independent reproductions show policy escalation, gates passing without admissible evidence, cross-project event disclosure, lost updates, and incomplete enforcement of the decision ledger.

Verifier: OpenAI Codex, GPT-6 Astra; author identified by the brief as Anthropic Claude Opus 5.5. I ran the checks myself and used no other reviewers. This report judges the exported revision, not the changing checkout.

The safety fact is that a gate's green verdict follows only from evidence admitted for that run's target, case version, method and policy, and that every change to standing follows a recorded decision. That fact is **false at this revision**. In particular, B01–B08 reproduce failures through the operation layer; B15 separately disproves the claimed TypeScript/runtime witness boundary.

## Method and reproduction setup

The complete brief was read, together with the project context, product-design sections 5–7, decisions 0007, 0008, 0009 and 0012, and the architecture document. The requested SHA matched the checkout when verification began. I exported it with `git archive`, installed with `bun install --frozen-lockfile`, and used Bun **1.4.3**. All mutations were confined to the export and restored afterward. I changed nothing in the repository.

Everything needed to rerun the reproductions is retained here:

```sh
cd /home/endqwerty/.cache/casebook-arena/verify/engine-r1/tree
bun install --frozen-lockfile
cd /home/endqwerty/.cache/casebook-arena/verify/engine-r1
bun scripts/probes.mjs
bun scripts/policy-matrix.mjs
bun scripts/support.mjs
bun scripts/live.mjs
python3 scripts/architecture-mutations.py
```

Each `probes.mjs` scenario can be selected by name; individual commands appear below. The script uses the real `invoke` registry through the test harness. SQL in the script observes stored results; only the explicitly named witness-forgery and seed-policy checks call internal writers directly. `live.mjs` uses real HTTP listeners from `start()` and separate processes for crash recovery. Its filters are `auth`, `concurrency`, and `crash`.

Additional live checks used ports 7510–7517 and temporary data directories under `/tmp`. The author's HTTP fixture hardcodes port `0`: the initial exact test invocation used that fixture, then I reran the six suites with only the exported fixture's port changed to 7501 and restored it afterward. Both runs passed. This was a deviation from the requested port restriction in the initial baseline, not a product finding.

This machine was shared. I repeated the adversarial operation scenarios and the live checks before concluding. The retained second live run contains two concurrency rounds and two kill/restart rounds; the first live run also completed both. I make no latency, throughput or performance-budget claim from those timings. Out-of-scope tests, browser behavior, transfer, CLI, MCP and benchmarks were not verified. Type-checking the complete export produced no errors, including in out-of-scope files.

Deciding logs: [author tests](logs/author-tests-port-7501.log), [type-check](logs/typecheck.log), [lint](logs/lint.log), [confirmed operation probes](logs/probes-confirmed.log), [policy matrix](logs/policy-matrix.log), [support checks](logs/support.log), [live rerun](logs/live-rerun.log), and [architecture mutations](logs/architecture-mutations.log).

## Results against the twelve checks

| Check | Verdict | What I ran and the deciding evidence |
| --- | --- | --- |
| 1. Author tests and their strength | **issues** | Ran the six requested suites: `85 pass`, `0 fail`, `406 expect() calls`, twice. `bunx tsc --noEmit` exited 0. Biome checked 36 in-scope files, exited 0, reported three optional-chain warnings, and changed nothing. Upward import, second mint import and invalid declared SQL each made architecture tests fail. Cross-owner SQL, invalid raw SQL and a plain-object witness each left `8 pass / 0 fail`; the plain witness also type-checked. See the test-coverage section and B15. |
| 2. Standing only through recorded decisions | **issues** | Enumerated the writers below. `witness-forgery` left decision rows at `2` while creating a link and an excuse pointing to decision `999999`; `plainAccepted:true`, `mintAccessible:true`. Repeated seeding was refused by the unique policy version constraint. Direct manual-test linkage and producer corrections are additional no-witness paths. Reversion can erase a newer map decision's effect, B16. |
| 3. Idempotency and atomicity | **issues** | A normal repeated project command wrote one case and returned the same result; another actor or operation got `conflict`. A late failing `claim` left all eight observed tables unchanged, including counters and sequence. Fifty creates interleaved with fifty reports and fifty failures produced `150` unique, contiguous events, sequences `2..151`; failed commands consumed none. But reusing a command ID in another project returned the first project's success with `otherCases:0`; admin commands bypass replay handling. B18. |
| 4. Edits never overwrite | **issues** | Stale disjoint body edits merged, queued ordinary accepts re-merged or conflicted, and restore produced version 5 with five retained versions. A stale `merge` answer overwrote newer work; a queued tag addition erased an intervening tag, B10. A merge applied create/archive/policy edits as well as its one body edit, B01. Folder mutation could create an unrecoverable API cycle, B11. |
| 5. Evidence says what it proves | **issues** | Exact/assumed/unresolved counts were `1/1/1`. Same-case version disagreement and nonexistent version 999 were rejected. Foreign-project refs and another producer's correction were rejected; repeated automated reports did not duplicate results. Live 100,000-result uploads completed. SQL-like, script-like, NUL and Unicode input did not drop data. Mixed batches relabel agent results as `auto`, B02; a different case annotation overrides the manual subject and pin, B14. A whitespace-only test key becomes empty after validation. |
| 6. One cause; honest holds and undo | **issues** | The 500-failure author test passed. Independent probes confirmed expiry reads pending without a report, new occurrences link `prior`, stale evidence returns `conflict`, undo retains the original and withdrawal, and a withdrawn rule does not answer again. An inherited decision records `clause:"failure-on-base"`; removing that base-failure fact re-asks and blocks. All four hold predicates passed matching/nonmatching boundary checks. But an infra decision held only for target 2 also excuses target 1, B08; two repositories share one PR scope, B12. Expiry sweep loses the explicit prior/supersedes chain, N01. |
| 7. Gate truth | **issues** | Tested all four verdicts and precedence, and the unknown-commit author test passed. Both live rerun rounds returned pending for every sampled read after acceptance and before application: `126` and `131` such reads. Both kill/restart rounds found exactly one accepted batch and one old result before recovery, then `100001` results, no accepted batch, and a blocked gate; replay added none. Expired holds read pending. But skipped/all-rejected reports, old PR uploads and old planned-run attempts can turn gates green, B04–B06. Completed required jobs can remain pending, B19. |
| 8. Runs and slots | **issues** | A human-only obligation refused an automated result. Default agent results and run-only agent opt-in left slots missing. One result filled two runs. A cross-producer dispute stayed disputed/blocked after 20 more passes. An explicit upload to a closed run conflicted. Exceptions: mixed methods, explicit wrong targets, collapsed failures, cross-target correction of a closed run, current-head methods used for an old pin, and a contradictory case annotation, B02, B03, B06, B07, B13, B14. |
| 9. Policy and actor isolation | **issues** | `policy-matrix.mjs` performed `324` invocations with `probeErrors:0`: all 15 operations and every answer shape for agent, CI and reader under all three presets. Clause selection matched each preset clause. Readers could not write; CI could not decide even with answer capability; standard agents could not adopt their own proposal and failure advice remained advice. The live forgotten-token request became `401`. However a non-admin human can adopt a bundled policy change via a conflict, B01, and a project-scoped reader receives another project's events, B09. |
| 10. HTTP surface | **issues** | Live local requests: absent/same Origin `200`; foreign Origin, `null` Origin and foreign Host `401`. Server-mode anonymous session, events and operations returned `401`. Cookie attributes included HttpOnly and SameSite=Strict; foreign/null Origin with cookie was refused. Honest and streamed 65 MiB bodies both returned actual `413`; a subsequent ordinary request returned `200`. All 15 registry operations appeared in OpenAPI and reached registered routes. Project event authorization fails, B09; scheme is ignored in origin matching, N02. Public health/OpenAPI/logout and unknown-route status are exceptions to the literal “every route 401” claim, N03. Browser cookie enforcement and access from a second physical host were not checked. |
| 11. Concurrency and writer ownership | **pass** | Two repeated live rounds each applied 100,000 new results while 40 simultaneous creates arrived: `results:100010`, `cases:40`, `uniqueCommandSeqs:41`, `eventSeqCount:42`, `contiguous:true`. During the write transaction, reader requests continued; the retained rounds served 256 and 266 additional reads. Failed/passing uploads ended blocked/passed respectively. Static audit of `app.db`, `raw`, command drivers, admin, token-use updates, recovery and sweep found no in-scope public request using the writer outside the command gate. This is a correctness result, not a timing benchmark. |
| 12. Documented departures | **issues** | Numbered assessment follows. The documented cuts were respected. Departures 3, 7 and 8 contain promises contradicted by the reproduced behavior. Browser drafts and transfer were not checked. |

### Standing-writer inventory

Source locations refer to the retained `tree/` export. `settle` at `decisions/decisions.ts:317` inserts the decision at line 336, mints the witness at line 338, calls the handler effect, then stores its effects, all within the command transaction. This is the normal authority path below. The witness requirement is not enforceable as implemented; “takes witness” describes the signature and current call path, not a proven guard.

| Standing mutation / SQL | Reachable path and authority |
| --- | --- |
| `suite/suite.ts:141`, `INSERT cases` including head, copied content, folder, rank, tags and default state | `propose → raiseAdopt → settle → adopt(create)`; takes witness. A nested map-create or accepted finding suggestion also goes through an adopt decision. |
| `suite/suite.ts:158`, `UPDATE cases SET head, head_hash, claim_hash, title, methods, automate, step_count...` | `settle → adopt(edit/restore) → writeVersion`, line 608; witness also recorded on the inserted immutable version. No update/delete of historical versions found. |
| `suite/suite.ts:172`, `UPDATE cases SET folder, rank, tags, state...` | `settle → adopt(place/state) → place`, line 796, which records a placement row with the witness decision. |
| `suite/suite.ts:205–211`, delete/insert case tags and search documents | `adopt(create/edit/place) → writeTags/indexCase`; derived copies of standing. Helpers take no witness themselves but their production call paths stay under `adopt`. |
| `suite/suite.ts:114,117`, insert/update folders | `adopt → ensureFolder/applyFolder`; private helpers do not take a witness. Folder paths created as part of adoption share its decision. B11 shows the missing structural validation. |
| `suite/suite.ts:237,240`, insert-ignore/delete `covers` | `adopt(create/cover) → setCover`, line 872. Insert stores `witness.decision`; deletion is made inside the same adoption and recorded by the proposal/decision. Requirement creation at line 234 is under the same path. |
| `policy/policy.ts:27`, insert policy version | Normal path: `settle → adopt(policy) → writePolicy`, line 88; the decision ID is stored. Current policy is the latest append-only version. Bootstrap path: `createProject → seedPolicy`, line 72, inserts version 1 with a null decision. Repeating seed after initialization raises UNIQUE; the probe left version 1 intact. This is the declared initialization exception. |
| `evidence/evidence.ts:211`, insert `tests.case_id` | `report → processBatchSteps → applySteps → resolveTest → insertTest`, lines 745–768. A new manual test receives its case ID **without a decision or witness**. An automatic test starts unlinked; its annotation sets result basis rather than updating the test's standing link. The manual report probe kept the decision count at 1 while adding `kind:manual, case_id:1`. This is an unencoded exception to the blanket standing rule. |
| `evidence/evidence.ts:215`, update `tests.case_id` | `settle → mapHandler.effect(link/create/unlink) → linkTest`, line 858. The function accepts but does not inspect `_witness`. B15 invokes it with an arbitrarily minted witness and no map decision. |
| `decisions/kinds.ts:196`, raw `UPDATE tests SET case_id` | `mapHandler.revert` restores saved previous values. Production callers are withdrawal, replacing a decision, or hold invalidation. It takes a stored decision, no witness; the SQL is outside the owning evidence module and outside `sql()`. It does not verify the link still belongs to that decision, B16. |
| `evidence/evidence.ts:298`, insert/upsert `excuses` | `settle → failureHandler.effect → setExcuse`, line 867. It copies `witness.decision`; the database has no foreign key from this column to the decision ledger. A plain object can create an excuse referring to a nonexistent decision, B15. |
| `evidence/evidence.ts:302`, delete `excuses` | `failureHandler.revert → dropExcuse`, line 882. No witness parameter; legitimate callers carry the original decision from `raise`, `settle`, `undo`, or `sweepExpired`. Deletion is by project/signature/scope, not by owning decision. No public operation directly exposes this helper. |
| `runs/runs.ts:112`, insert run with default open state/null signoff | `report → ensureChangeRun` or `planRun → plan`, without a decision. This initializes a request for evidence; it does not grant sign-off. |
| `runs/runs.ts:125`, update `runs.state/signoff` to closed | `settle → signoffHandler.effect → closeRun`, line 768; stores the witness decision ID. |
| Same SQL, state open/signoff null | `signoffHandler.revert → reopenRun`, line 774, after recorded sign-off withdrawal or invalidation. No witness parameter. The existing decision authorizes the reversal in the current call paths. |
| `runs/runs.ts:189`, insert-ignore `slot_results` with default corrected=0 | Normal evidence admission in `applyBatchSteps` and `fillFromPrior`, no decision. This creates the result-to-slot projection. |
| `runs/runs.ts:191`, set `slot_results.corrected=1` for a result in every slot | `report → applyBatchSteps`, line 395, when the result supplies `corrects` (including generated supersession for repeat manual evidence). No decision/witness. Same-project, producer and test checks occur in evidence, but target and closed-run checks are missing, B07. Producer correction is intended in the evidence design; its exception to the blanket standing claim needs explicit representation. |
| `runs/runs.ts:193`, set corrected=1 for a slot/result pair | `settle → failureHandler.effect(mistaken) → discountFailures`, line 783; takes witness. |
| `runs/runs.ts:196`, set corrected=0 for a slot/result pair | `failureHandler.revert → restoreFailures`, line 797, using the recorded decision's saved pairs. No witness parameter. |

The reversion call sites are `raise:145`, `settle:328`, `undo:367`, and `sweepExpired:452` in `decisions/decisions.ts`. Undo inserts a withdrawal in the same transaction, so a later failure rolls the reversal back. Expiry deliberately relies on the old decision's hold rather than creating a fresh human answer. That does not make unconditional reversal of a newer effect safe. B16 demonstrates the distinction.

No in-scope hard-delete of cases, versions, results or decisions was found. `setDecisionEffects` fills the newly inserted row within the transaction, rather than rewriting a previously committed decision. The statement inventory and writer-connection search are retained in [sql-and-writer-access.txt](logs/sql-and-writer-access.txt). Transfer/import mutations are outside this round.

### Decision 0012, each numbered departure

| No. | Verdict | Assessment |
| --- | --- | --- |
| 1 | **pass** | Integer storage and project refs are exercised by the suites and probes. Cross-instance merging remains out of scope. |
| 2 | **pass** for the stated storage shape | Change runs use `run_tests`, planned runs use pinned `slots`, and both feed the shared tally/verdict. B04 and B06 are correctness failures in that implementation, not objections to the departure. |
| 3 | **issues** | Automatic evidence is eligible through a map link or annotation, as described. Human/agent eligibility is bypassed by mixed-batch method assignment and read from the current head rather than the pinned body, B02/B13. Manual `tests.case_id` is also initialized directly, as noted in the inventory. |
| 4 | **pass** | The schemas and handlers include inherited and mistaken. The inherited rule records a decision; the author's disputed-slot test exercises mistaken, and failure classifications resolve/attribute the gate through recorded decisions. The deferred quarantine/clean-count work is not required here. |
| 5 | **not checked** | Browser draft persistence belongs to the web author, outside this round. |
| 6 | **pass** for acceptance, slicing and recovery | Real readers observed pending after acceptance and continued during application. Concurrent writes serialized without loss. SIGKILL before application commit left accepted work durable; restart applied it once. This pass excludes any performance claim. |
| 7 | **issues** | Direct uploads to a closed run are refused. A correction sent on another target nevertheless changes the closed run's slot while leaving its passed gate cached, B07. |
| 8 | **issues** | Basis/date/target/fact predicates exist and their boundary checks pass; a changed base-failure fact invalidates inherited standing. But retally applies a target-only excuse to another target, B08, and sweep loses the explicit previous-answer chain, N01. Clean-count and external tracker holds are acknowledged cuts. |
| 9 | **pass** for the stated limited basis | Claim/review code and author tests use case version plus change key. I did not require patch-hash invalidation, which is explicitly deferred. |
| 10 | **not checked** | Full-instance transfer, empty import and token exclusion belong to the separately verified transfer implementation. |
| 11 | **pass** for the engine/HTTP portion | The live registry has 15 operations and matching OpenAPI routes; timeline is among them. Deferred announce/attach/trace and separate transfer streaming are not findings. CLI/MCP/transfer behavior was not checked. |
| 12 | **pass** | Generated OpenAPI describes inputs; output contracts are TypeScript types in `src/core/api.ts`. Missing response schemas are an acknowledged departure. |

## Defects, most severe first

The following 19 findings block acceptance of this engine revision. Each command runs from the reproduction directory above. Expected behavior is stated separately from the observed result; the scripts print observations even when the product behavior is wrong.

### B01. A conflict lets a non-admin adopt a policy change and other cases

**Blocks: yes.** A human member with only `read,produce` can change policy. `adopt-conflict` precedes `adopt-policy` in `src/core/presets.ts:28`, so the proposal's author becomes its decision maker. The merge guard at `src/server/decisions/kinds.ts:108` counts only `op:"edit"`, while `adopt` applies all other operations too.

```sh
bun scripts/probes.mjs merge-multi-case-and-policy
```

Create C-1 and C-2, advance C-1, then have that member propose one stale conflicting edit to C-1 plus a create, an archive of C-2, and `policy:strict`. Answer its conflict with a merged body. Observed: `status:"decided"`, three cases, `secondCaseState:"archived"`, `policy:"strict"`, `policyVersion:2`. The member has neither admin nor answer capability.

Expected: the merge cannot carry a multi-case proposal through, and policy adoption still needs the admin clause. This violates P5 and the explicit single-case merge restriction. Evaluate authority for the complete proposal; counting only body edits does not bound its effects.

### B02. One automatic result relabels an agent's entire batch as automatic

**Blocks: yes.** `src/server/evidence/evidence.ts:441` computes one method for the whole batch with `results.every(test has case)`. Adding any keyed automated result makes every manual result `auto`; line 668 copies that method into each result. `runs.methodsOf` then admits automatic evidence without a case method declaration, as permitted for real automated tests by departure 3.

```sh
bun scripts/probes.mjs mixed-methods
```

Create a human-only C-1 and a default run whose obligation permits human/auto but excludes agents. As an agent, send `{test:{case:"C-1"},outcome:"pass"}` together with an unrelated keyed passing test. Observed stored manual result: `kind:"manual",method:"auto",basis:"exact"`; the slot is satisfied and the gate passes.

Expected: that case result remains agent evidence and cannot fill this run. This violates P3 and both explicit agent opt-ins in decision 0009. Method provenance needs to follow the individual result rather than a batch-wide inference.

### B03. Naming a run bypasses its target, repository and environment

**Blocks: yes.** `src/server/runs/runs.ts:310` returns true when `typedInto === run.id`, before checking the run's accepted commit/repo/environment. The fallback at lines 328–330 also adds the named run.

```sh
bun scripts/probes.mjs target-bypass
```

Plan a run accepting commit `aaaaaaa1`, repo `repo-a`, environment `prod`. Report a manual passing result with that run ID but target `{session:"unrelated session"}`. Observed: no rejection, exact basis, gate `passed`.

Expected: naming a run does not make a contradictory explicit target admissible. This violates P3: the evidence proves a different target from the one the green run claims.

### B04. Skipping the failing test, or rejecting every result, produces a green change gate

**Blocks: yes.** The change-run tally in `src/server/runs/runs.ts:588` counts skip separately without missing proof; an empty effective tally also passes. Rejected evidence can therefore create a green run with zero admitted results.

```sh
bun scripts/probes.mjs skips-and-red-to-green
bun scripts/probes.mjs basis-and-invalid-results
```

Report a failing test and decide it is a defect: the gate is `failed`. Report the same test on the same commit as `skip`: it becomes `passed`, reason `passed: nothing was required`, with `passingResults:0`. Separately, a report whose only result names a nonexistent case/version is rejected at result level but returns a passed gate, tally all zero.

Expected: skipped or wholly rejected evidence cannot prove the target. Preserve missing proof or reject the report rather than reporting green. This violates P3 and check 7's explicit no-red-to-green-without-passing requirement.

### B05. Re-sending an old report moves a PR's gate back to its old green head

**Blocks: yes.** `ensureTarget → upsertChange` (`src/server/evidence/evidence.ts:339,363,399`) overwrites `changes.head_sha` before report deduplication. Even a batch returned as already processed mutates which commit a change gate reads.

```sh
bun scripts/probes.mjs late-report-changes-pr-head
```

Report PR 12 at `head0001` passing, then `head0002` failing. Re-send the first report unchanged. Observed: `retryFresh:false`, `gate(change:"pr:12")` changes from blocked on R-2 to passed on R-1, while `gate(commit:"head0002")` remains blocked.

Expected: a late retry cannot replace the known current head with an older target. This violates P3 and the report promise that a duplicate writes nothing.

### B06. Planned-slot aggregation hides another test's failure and newer attempts

**Blocks: yes.** `src/server/runs/runs.ts:500` reduces fills to one value per `actor:method`. A later row overwrites an earlier failure regardless of test identity or attempt number. The uncorrected failing result remains admitted but no longer affects the tally.

```sh
bun scripts/probes.mjs multi-test-slot-loses-failure
bun scripts/probes.mjs late-attempt-planned
```

In one report, annotate two automatic tests to C-1@1; make the first fail and the second pass. Observed: planned gate passed, slot satisfied, `uncorrectedFailures:1`; the change gate stays blocked. Independently, report attempt 2 failing, then an older attempt 1 passing for the same test: the planned gate turns passed while the change gate retains the failure.

Expected: another test or an older attempt cannot erase the uncorrected failure. This violates P3 and the slot aggregation promise. The separate positive test for two different producers still passes; this defect is within one producer/method group.

### B07. A correction on another target mutates a closed run but leaves its green gate cached

**Blocks: yes.** Correction validation at `src/server/evidence/evidence.ts:648` checks project, actor and test but not target or affected closed runs. `src/server/runs/runs.ts:395–400` marks the old result corrected in every slot. Those slots are refreshed, while the affected old run is omitted from the current batch's gate refold.

```sh
bun scripts/probes.mjs correction-cross-target-closed-run
```

Fill and close a planned run with a passing manual result. On a different target, submit a failing result by the same producer/test with `corrects` set to that original result ID. Observed: no rejection, the closed run's slot becomes `missing`, its original fill has `corrected:1`, yet its gate stays `passed` with `pass:1` and the run stays closed.

Expected: follow departure 7's closed-run refusal, or explicitly reopen/refold under valid authority before accepting such a correction. A closed run and its gate cannot disagree about whether it has evidence. This violates P0/P3 and contradicts the stated MVP departure.

### B08. An infrastructure excuse held for one target excuses another

**Blocks: yes.** `src/server/runs/runs.ts:572` looks up an excuse by project/signature/scope and applies it without checking its target hold against the run being tallied.

```sh
bun scripts/probes.mjs infra-hold-scope
```

Report the same unresolved failure on two successive commits of PR 91 while its question remains open. Decide `infra` on the question's latest evidence. The stored hold is exactly `[{until:"this-target",target:2}]`. Observed: both target 1 and target 2 gates pass with `excused:1`.

Expected: target 1 remains unexplained; the decision covers only target 2. This violates P3/P4 and departure 8. The author test covers a new report after the decision, but misses an older run retallied when the decision is first made.

### B09. A project-scoped token receives another project's events and project listing

**Blocks: yes.** The event route at `src/surfaces/http.ts:311` checks only that some session exists. It never resolves the named project's actor or checks read capability. `sessionInfo:159` likewise lists every project.

```sh
bun scripts/live.mjs auth
```

Create `scratch` and `private-other`, then a reader token scoped only to scratch. The ordinary find operation on private-other correctly returns `403`. With the same token, subscribe to `/api/p/private-other/events`, then write a case there as the owner. Observed event stream status `200` and:

```json
{"project":"private-other","seq":2,"op":"propose","actor":"review-owner","touched":["P-1","Q-1","C-1"]}
```

The token's session response also lists both projects. Expected: the event stream and project list enforce the same project grants as operations. This is a concrete cross-project disclosure of activity, actor identity and refs, violating the authorization boundary; it does not require an unauthenticated request.

### B10. Waiting merge answers and tag proposals overwrite intervening changes

**Blocks: yes.** A merge override skips both conflict and moved-head checks at `src/server/suite/suite.ts:670,675`. The question material is only the proposal ID (`decisions/kinds.ts:95`), so the old evidence hash does not protect a reviewer from a newer head. Placement tags are precomputed at seal time, then installed at `suite.ts:714` without replaying the requested add/remove operation against current tags.

```sh
bun scripts/probes.mjs merge-and-stale-proposal
bun scripts/probes.mjs pinned-methods-and-tag-proposal
```

For the body case, open a title conflict, read it, change the case's precondition in another adopted edit, then submit the previously prepared merge body using the old question hash. Observed: the new precondition `New work after conflict` is replaced by `Independent`; `questionHashChanged:false`.

For tags under standard policy, queue an agent proposal to add `agent`, let a human add `human`, then accept the queued proposal. Observed tags change from `["human"]` to `["agent"]`.

Expected: preserve compatible intervening changes or return a stale/conflict response. This violates the no-overwrite promise. Ordinary queued body accepts do re-merge correctly; the reproductions isolate the paths that do not.

### B11. Moving a folder into a newly created descendant creates a persistent cycle

**Blocks: yes.** `src/server/suite/suite.ts:534` checks ancestry only when the parent already resolves to an ID. A new path bypasses that check. `applyFolder:848` creates the path and then updates the original folder's parent.

```sh
bun scripts/probes.mjs folder-cycle
```

Create root folder `Parent`, then propose `{op:"folder",folder:<Parent ID>,parent:"Parent/NewChild"}`. Observed: adopted; Parent's parent is NewChild and NewChild's parent is Parent. Both `find {in:"folders"}` and a repair proposal moving Parent back to root fail with `Maximum call stack size exceeded.`

Expected: reject the cycle before committing it. The ordinary API can create structural corruption that prevents subsequent proposals from reaching their repair logic. This blocks safe suite editing; historical rows remaining present does not make the current tree usable.

### B12. Equal PR numbers in different repositories share decisions and gates

**Blocks: yes.** Change identity at `src/server/evidence/evidence.ts:339` uses `pr:<number>` (or an unqualified branch name) within the project, omitting repository identity even though targets carry a repository.

```sh
bun scripts/probes.mjs repository-scope-collision
```

In one Casebook project, report repo-a PR 1 failing and answer flaky. Report repo-b PR 1 with the same test key and message. Observed: both targets have `change:1`; the single change row keeps `repo:"repo-a"` but now has repo-b's head. Repo-b's failure inherits the decided question and its gate passes with `excused:1`.

Expected: repository-qualified targets and changes retain separate decision scopes. This violates P3/P4. It is an identity/scope collision, not the acknowledged deferred signature over-merge guard across files.

### B13. Eligibility for an old pinned case is taken from its newer head

**Blocks: yes.** `methodsOf` at `src/server/runs/runs.ts:477` reads `cases.methods`, the current head's copy, instead of the slot's pinned version. The result basis can remain exact at the old version while admission uses permissions from a different body.

```sh
bun scripts/probes.mjs pinned-methods-and-tag-proposal
```

Create C-1@1 with methods `["human"]`; plan a run pinned to it with an agent obligation. Edit the head to version 2 adding agent, then have an agent report C-1 into the old run. Observed: `pinnedVersion:1`, `methodsAtPinned:["human"]`, yet the slot is satisfied and its exact-basis gate passes.

Expected: eligibility for a pinned exercise follows the pinned case body. This violates P3 and departure 3's retained case declaration requirement for agents.

### B14. A different case annotation silently replaces a pinned manual subject

**Blocks: yes.** At `src/server/evidence/evidence.ts:612`, the annotation's case ID replaces the manual test's linked case before the pin is looked up. The consistency check compares only versions for that replacement subject.

```sh
bun scripts/probes.mjs basis-and-invalid-results
```

Plan slots for C-1@2 and C-2@1. Send a manual result naming `test:{case:"C-1"}` with `annotation:{case:"C-2",version:1}`. Observed: `rejected:[]`; the C-1 test's result is stored as `basis:"exact",basis_case:2,basis_version:1`, filling C-2 while C-1 stays missing.

Expected: contradictory case identities are rejected, just as contradictory versions for the same case are. This violates the explicit basis contract in P3; relabelling the proof is not a resolution of the conflict.

### B15. A witness is structurally forgeable and writers accept nonexistent decisions

**Blocks: yes.** `src/server/kernel/witness.ts:8` has only public instance fields. Its private constructor does not give the instance type a private brand; `Witness.mint` is public. The writers neither validate a brand nor require the cited ledger row to exist.

```sh
python3 scripts/architecture-mutations.py
bun scripts/probes.mjs witness-forgery
```

Append to the exported suite module:

```ts
const reviewPlainWitness: Witness = {
  decision: 999999, kind: "adopt", signers: [1]
};
```

Observed: TypeScript exits 0 and all eight architecture tests pass. At runtime the probe passes a plain object to `setExcuse` with decision 999999 and calls `linkTest` with `Witness.mint(999998, "map", ...)`. Both writes succeed, with `decisionRowsBefore:2` and `decisionRowsAfter:2`.

Expected: code outside the decision machinery cannot create a valid authority object, and standing cannot cite a nonexistent decision. This directly disproves the P0 implementation claim. The reproduction is an internal module boundary test, **not a claim that an HTTP client can execute arbitrary code**. Regex-detecting a minter's name does not establish either the type or runtime invariant.

### B16. Undoing an older map decision erases a newer decided link

**Blocks: yes.** `mapHandler.revert` at `src/server/decisions/kinds.ts:191` blindly restores the previous case ID captured by the withdrawn decision. There is no check that the current link still belongs to it, and the write uses raw SQL outside the evidence module.

```sh
bun scripts/probes.mjs map-revert-superseded-link
```

Under standard policy, use one map question to link T-1 to C-1, then a second map question to link T-1 to C-2 (the API accepts that pair). Undo the first question. Observed: T-1 changes from C-2 to null while the second question remains decided and its link decision remains in force in the ledger.

Expected: withdrawing an old effect cannot silently overwrite a newer standing decision. This violates P0 and undo's promise to reverse the identified decision. Correct provenance or an explicit conflict is needed at reversal time.

### B17. The `since` cursor skips the tail of a bulk change permanently

**Blocks: yes.** `src/server/ops/reads.ts:693` limits changed cases, but line 722 always returns the current project sequence as the next cursor. Multiple cases share a single revision number, so even returning the last row's sequence would not safely page within that batch.

```sh
bun scripts/probes.mjs changed-since-drops-bulk-tail
```

Record the initial cursor, create 300 cases in one proposal, request `since` using its default limit 200, and request again using its returned cursor. Observed: `actualCases:300`, `firstChanged:200`, `firstCursor:"s:2"`, `secondChanged:0`, `missing:100`.

Expected: the client can retrieve every change before advancing past it, or receives an explicit truncation/reset contract. This silently leaves agent/client state incomplete during the supported bulk workflow.

### B18. Command replay omits project identity, while admin writes omit replay handling

**Blocks: yes.** `src/server/ops/registry.ts:59` loads a prior command without its project. The replay check at line 150 compares only actor and operation. The instance-operation branch at line 118 returns before command handling altogether.

```sh
bun scripts/probes.mjs idempotency-and-rollback
```

As the owner, propose a create in scratch with a command ID, then propose a different create in another project using the same ID. Observed: the second reply claims the first proposal was adopted with C-1, but `otherCases:0`. Either project-scoped replay or an explicit conflict would avoid this false success. Also repeat `admin project.create` with the same command ID: first success, then `conflict`, rather than the original reply.

A normal project replay also changes the outer envelope's `seq` from 2 to null; its result body is identical and writes once. That envelope discrepancy alone is minor, but the wrong-project success and unprotected administrative replay violate the documented command contract.

### B19. A required job stays missing after its report has fully processed

**Blocks: yes.** `src/server/ops/writes.ts:150` refolds runs before line 172 marks the batch processed. Required-job evaluation in `src/server/runs/runs.ts:613` counts processed batches, so it excludes the report being finalized; there is no subsequent fold.

```sh
bun scripts/probes.mjs jobs-after-report
```

Plan a run accepting `jobs0001`, with an exercise and required job `e2e`. Submit an e2e report with an exact passing result for its case. Observed: the database batch is `job:"e2e",state:"processed"`, but the existing run remains pending with `pass:1,missing:1`. Create an identical run afterward and it immediately passes using the same evidence.

Expected: completion of the required report updates the run's gate without another unrelated write. This blocks the supported required-job workflow and makes the cached tally disagree with durable evidence.

### Other reproduced defects, not counted as blockers

**N01 — expiry sweep loses the explicit previous-answer chain. Blocks: no; the old ledger rows remain and the expired gate stops passing.** Run `bun scripts/probes.mjs expiry-sweep-ledger`. After flaky expires, sweep reopens the same question with decision null. Answering defect leaves one question at `epoch:0,prior:null`; both the flaky and defect decision have `supersedes:null`. `sweepExpired` (`decisions/decisions.ts:447`) differs from the new-occurrence path, which creates a new epoch with `prior`. Departure 8 and the built-decisions description promise the old answer is linked; a consumer now has to infer that relationship from the shared question and ordering. Preserve the explicit history link in both paths.

**N02 — origin comparison ignores scheme. Blocks: no on the reproduced evidence alone.** Run `bun scripts/live.mjs auth`. A request to the HTTP server with an HTTPS Origin having the identical host and port returns `200`, both in local mode and when supplying the session cookie. `sameOrigin` compares `.host`, not `.origin`. The stated same-origin predicate is therefore false. This check used crafted HTTP headers; it does not establish that a browser will send a Strict cookie across that scheme boundary.

**N03 — “no token means 401 on every route” has metadata exceptions. Blocks: no.** The same live command observes anonymous `200` for `/healthz`, `/api/openapi.json`, and POST `/api/logout`, and `404` for an unknown route. Anonymous session, operations and event stream return `401`. The public responses observed expose health/version/schema or clear a cookie, not project records. Align the blanket claim with these deliberate-looking exceptions, or guard them if literal universal authentication is intended.

**N04 — whitespace-only test keys survive as empty keys. Blocks: no.** Run `bun scripts/probes.mjs hostile-strings`. The empty-string key is rejected, but `"   "` passes input validation and is trimmed into `""` at `evidence/evidence.ts:755`; the probe ends with `emptyTestKeys:1`. Validate after normalization. SQL-like, script-like and Unicode strings were stored without breaking the database; browser rendering is out of scope.

## The tests do not prove these claims

I read the six requested suites. They contain useful assertions and no wholly assertion-free test. The following names overstate their checks; the answer-key completeness claim is vacuous with respect to missing entries. These coverage findings are separate from the 19 product blockers.

| Test and location | Missing proof / how it can pass with the named behavior broken |
| --- | --- |
| `the same command twice writes once`, `test/suite.test.ts:61` | It compares result bodies, then counts **folders**, not the created cases, versions, proposals, decisions or command rows. Reusing one folder does not prove one write. My probe counts cases, exercises actor/op/project collisions, and checks rollback. |
| `a bulk move and retag of 300 cases is one proposal, one decision, one point on the clock`, `test/suite.test.ts:158` | It proves one sequence increment, the 300 moved/tagged cases, order and unchanged version count. It never counts proposals or decisions, so the first two cardinality claims are unproved. |
| `every answer has one key...`, `test/policy.test.ts:47` | It iterates values already present in `ANSWER_KEYS`, checks those values are distinct and parse, and never compares against the full answer union. Missing entries are invisible; empty maps satisfy its completeness logic. This is a vacuous completeness check, though uniqueness of present values is meaningful. |
| `with no token configured, one is generated on first start and only then`, `test/http.test.ts:94` | It starts once and validates that token. There is no second start against the same data. “Only then” is untested by this test. |
| `a report accepted before a crash is applied on the next start...`, `test/evidence.test.ts:328` | It stages into the same in-memory app and calls `recoverAccepted` directly. It does not kill a process, reopen the SQLite file or exercise startup. The independent live kill/restart check supplies that missing evidence and passes. |
| `blocked and skipped are not proof`, `test/runs.test.ts:113` | It records blocked, not skipped, and only tests a planned run. It cannot detect the change-gate skip failure B04. |
| `E1...a later write never hides it`, `test/runs.test.ts:230` | It creates the dispute and resolves it by a decision but never makes the promised later evidence write. My cross-producer/20-later-writes probe passes; same-producer different-test/attempt probes fail in B06. |
| `an infrastructure excuse covers the commit it was given for and no other`, `test/evidence.test.ts:226` | It decides, then uploads another commit. It does not create both commits while the question is open and inspect both gates after deciding. B08 exploits that missing ordering. |
| `removes who they were...their token stops working`, `test/policy.test.ts:373` | It checks revoked rows and preserved history, but never attempts authentication with the forgotten actor's old token. The independent live request returns 401, so that behavior is verified separately. |
| Request-size test, `test/http.test.ts:264` | Its streamed request maps **any** fetch rejection to status 413, so that assertion does not establish an actual HTTP limit response. It does check a later normal request. It also makes no memory measurement despite the title's memory claim. My two live runs received actual 413 responses for both body forms and then a 200. |
| `only the decision machinery can mint a witness...`, `test/architecture.test.ts:26` | It detects the spellings `mintWitness` and `Witness.mint`. An ordinary structural object does not use either spelling. The injected plain witness compiles and the test passes, B15. |
| `every statement the server can run prepares against the schema`, `test/architecture.test.ts:98` | It prepares only statements registered through `sql()` by imported modules. The deliberate malformed `ctx.db.raw.query(...)` function remains invisible. The invalid declared SQL mutation correctly fails, so the mechanism works for its narrower domain. |
| Claimed SQL ownership enforcement in the module map | No test associates a SQL statement's table with its owning module. Injecting `sql("DELETE FROM excuses")` in `suite/suite.ts` leaves all eight architecture tests green. The actual raw map reversion is an existing boundary violation. |

The three requested mutation controls all worked: upward import, second mint import, and malformed declared SQL each produced one failed architecture test. Those positive controls matter: the three bypasses were not artifacts of running the wrong suite or an unloaded copy. See each `logs/architecture-*.log`; the mutation runner restores the exported source in `finally`.

## Worth doing later

After fixing the blockers, keep the compact operation and live-process reproductions as repository regression coverage, especially the ordering cases missing from the current suites. A failure should assert the relevant stored rows and the public gate together; either alone misses B07. Separate architecture guarantees into checks that enforce type identity, authorized ledger references, and SQL ownership rather than treating a minter-name regex as proof of all three.

Record the intended initialization and producer-correction exceptions to the blanket standing rule explicitly. They are useful model distinctions already present in the implementation, but should not be hidden behind an unenforceable witness claim.

Generated-token persistence, actual browser cookie behavior, and access from another machine remain unverified here. Browser drafts, CLI/MCP, transfer, budget tests and the listed backlog cuts remain for their assigned verification rounds. I did not classify a documented cut as a blocker or relax a budget because of machine contention.

## Artifact integrity and cleanup

The exported tracked files are checked against the requested commit's Git blob IDs in `logs/snapshot-integrity.log`. Reproduction scripts, the restored source export and logs are retained. Test processes are stopped and their temporary data removed; the export's disposable dependencies are removed after verification. The shared repository and other agents' servers/data are left untouched.

ISSUES (19 blockers)
