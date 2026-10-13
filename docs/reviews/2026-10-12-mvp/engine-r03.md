# Mainworthy engine verification, round 3

Revision: `9ca6d25126dcaa9f3545251f1469f426f4930ceb`, branch `t3/mvp-product-delivery`.

Verifier: Codex, GPT-6 Astra. Source exported with `git archive` into `engine-r3/tree`; dependencies installed with `bun install --frozen-lockfile`. The shared repository is not edited. Run project checks in `engine-r3/tree`, and `bun scripts/...` or `python scripts/...` from `engine-r3`. Reinstall the export with `bun install --frozen-lockfile` if its dependencies have been released.

Status: Review complete.

The correctness claim is that gates and current standing derive only from admissible evidence and recorded, authorized decisions. Conflicting, incomplete, late, or unrelated evidence must not silently produce a passing gate.

## Twelve checks

| # | Check | Verdict | What ran and deciding evidence |
| --- | --- | --- | --- |
| 1 | Author tests and architecture mutations | issues | Required baseline: 543 pass / 0 fail, 16,398 assertions; tsc exit 0; Biome checked 176 files with no fixes. All twelve architecture tests were challenged with actual violations (logs/architecture-mutations.log, architecture-additional.log, architecture-last.log): wrong imports, extra mint caller, SQL owner/preparation/raw/SQLite access, unchecked witness, unauthorized undo helper, duplicate and second operation. Each fails its intended check. A plain Witness object passes the source scan but tsc reports missing private fields (witness-typecheck-private.log). R3-T01/T02 identify weak author assertions. No out-of-scope baseline failure. |
| 2 | Standing changes and witnesses | issues | [Complete SQL inventory](STANDING.md) traces every scoped head/body/placement/link/excuse/signoff/policy/cover/corrected writer, its decision path, and all four exceptions. Constructor/prototype/second-mint forgeries fail; structural Witness fails tsc; real wrong-kind witnesses are refused by link, excuse, close and policy writers (logs/standing.log). Link/excuse/signoff undo preserves newer decisions. R3-B06 clears a later producer correction; B05 removes an expired excuse during ingest without the promised expiry row. Thus P0's undo guarantee is not proven by the witness gate alone. |
| 3 | Idempotency and atomicity | pass | `bun scripts/probes.mjs` and `bun scripts/new-probes.mjs`: same command replies and seq match; operation, actor and project reuse conflict; late claim failure leaves all audited rows unchanged; 150 events have 150 unique contiguous seqs 2..151 including reports and failed commands. Instance creation replays. Token replay conflicts; stored reply is `(reply not kept: it held a secret)` and exactly one token exists. Live concurrent writes and two crash/retry cycles also preserved counts. |
| 4 | Edits never overwrite | pass | Suite/integrity tests plus `scripts/probes.mjs`: stale disjoint fields merge, overlapping fields conflict, delayed conflict resolution preserves later preconditions, queued edits remerge/refuse, multi-edit/policy smuggling is forbidden, restore makes version 5 while preserving all five versions, queued tags become `[agent,human]`, and attempted descendant folder move returns invalid without creating the child. Strict conflict resolution leaves an adoption question. |
| 5 | Evidence provenance and report inputs | issues | Basis probes produce exact:1/assumed:1/unresolved:1; invalid manual claims are rejected, automated claims remain unresolved/declined and block the commit without filling a slot. Foreign-project refs, other-producer/target corrections are refused. Per-result methods are human:[human,auto], ci:[auto,auto], agent:[agent,agent] (logs/final-probes-complete.log). Report retry writes one batch/100,000 results; live tests also process 100,000. Empty keys/results and lone surrogates are refused; stored strings at real emoji cut boundaries stay well formed. R3-B01 and B06 break valid correction semantics. |
| 6 | Questions, holds, and decisions | issues | 500 same-cause failures produce one question and one decision excuses all 500; different external frames with the same message remain separate. Hold boundaries, rule withdrawal, sweep-first expiry ledger, stale hints and subset-run probes pass. R3-B03 misses an answerable question; B04 crosses repository scopes; B05 duplicates expired epochs without the ingest expiry row; B08 accepts an old evidence hash and excuses a newer build. See lifecycle, support, final-probes and confirming logs. B10/B11 also feed inadmissible agent or foreign-repository evidence into inherited-rule decisions. |
| 7 | Gate soundness | issues | Pure verdict priority and every no-proof case pass. Live 100,000-result HTTP uploads yield 334 observed accepted-horizon reads, all pending; two SIGKILLs between accept/apply recover once to blocked with 100,001 results and no duplicate on retry (logs/live.log). Late attempts, skip retention, foreign producers, agent exclusion and forward-only change heads pass the original probes. R3-B02 hides another job/environment's failure in a planned run; B03 strands an unexplained failure; B04/B08 excuse unrelated or unseen evidence. Expired holds read pending before any sweep/report. B10/B11 make CI gates pass using agent or foreign-repository base evidence. |
| 8 | Runs and slots | issues | Admission rejects other targets and unresolved/declined claims; exact requirements exclude assumed results; pinned methods stay fixed; tests do not fill human-only obligations. Agent inclusion requires both run opt-in and pinned-case permission (positive planned=passed, commit=pending). One result fills two runs; disputes survive 20 later writes; two causes remain blocked until both are answered. Valid same-target correction preserves a closed run while changing an open one (logs/final-probes-complete.log). R3-B01 loses corrections on backfill, B02 collapses jobs/environments, B03 omits plan dependencies and B06 undoes another correction. Same-claim admits an old version with unchanged claims while exact and exact-or-assumed leave it pending (policy-supplements.mjs). |
| 9 | Policy and authorization | issues | policy-matrix.mjs makes 324 operation/answer calls over all three presets and agent/CI/reader actors; every clause selector matches, zero probe errors. policy-supplements.mjs tests valid disputed mistaken answers and conflict-author merge/reject, plus the agent's own standard proposal: CI never decides, advice writes no decision, agent self-adoption/merge is forbidden, own conflict withdrawal is allowed. Live project-scoped operations/events/session are denied outside the grant and new requests after forgetting return 401. R3-B07 loses the strict mapping proposal; B09 leaves a previously opened event stream authorized. B10 shows that the otherwise-authorized inherited rule uses evidence excluded from commit gates. |
| 10 | HTTP surface | pass | `MAINWORTHY_READERS=2 bun scripts/live.mjs`, `bun scripts/checkpoint-live.mjs`: local same/no Origin=200; foreign/null/scheme/Host=401; cookie HttpOnly and SameSite=Strict, foreign cookie requests=401; all 15 unauthenticated registry routes=401; session/events=401; scoped foreign-project event/read=403; 64 MiB limits reject both sized and chunked bodies with 413; all 15 routes appear in OpenAPI. The only anonymous handlers match serve's list; unknown path=404. UI static files are outside scope. |
| 11 | Concurrency and reader threads | issues | Concurrency/recovery checks pass: each live 100,000-result upload preserves 40 writes, 42 contiguous events and 41 unique command seqs; 334 accepted-state reads all pending. 128 reads see prior writes; nine read ops give 27 matching worker/inline replies including 10 refusals; denied reads never dispatch; worker writes fail; killed reader answers all 80 requests; shutdown awaits exits. Checkpoint worker active during 476 commits; 80 more after termination; all 556 survive restart. Readers=0 works. R3-N01: default cap is 8 versus the brief's 4. No performance verdict. |
| 12 | Documented departures | issues | All eighteen entries are assessed in the table below. Defects contradict 2, 3, 4, 8 and 17; remaining in-scope departures match the inspected code and executable probes. Browser persistence (5) and archive implementation (10) are explicitly not checked because the brief excludes their authors/paths. Listed cuts are not defects. |

## Round 2 findings

| Finding | Status and evidence |
| --- | --- |
| R2-B01 | fixed: real constructor and prototype forgeries fail; second claim fails; genuine witnesses sent to wrong-kind writers fail (`logs/standing.log`). Plain object typing fails tsc. |
| R2-B02 | fixed with a new problem: direct agent-only/agent-pass fold probes now preserve pending/CI blocked gates. R3-B10 shows an agent's base failure still makes a CI head pass indirectly through the inherited rule. |
| R2-B03 | fixed with a new problem: original alpha/beta causes remain blocked until both are excused. R3-B02 finds a remaining loss of a cause when the same test/producer reports from different jobs or environments. |
| R2-B04 | fixed: later skip retains disputed=1 and blocked gate. `logs/new-probes.log`. |
| R2-B05 | fixed with new problems: original repository-specific gate/impact/plan reproduction passes. R3-B04 finds shared trunk questions/excuses; R3-B11 finds an unqualified trunk fallback that fabricates an inherited-base fact for another repository. |
| R2-B06 | fixed: reserved key is refused atomically, then ordinary manual C-1 records exact C-1 and fills its slot (`round3.mjs reserved-key-refusal`). The two old scripts stop at the new expected refusal. |
| R2-B07 | fixed in the original reproduction: the subset run passes, while the failure question remains open and the commit stays blocked. `logs/new-probes.log`. |
| R2-B08 | fixed with a new problem: infra excuses only the selected environment and immediately reasks for the other (logs/new-probes.log). R3-B08 finds that an unchanged evidence hash lets a stale infra answer select a new, unseen target. |
| R2-B09 | fixed: scoped Needle search returns C-301. `logs/new-probes.log`. |
| R2-N01 | fixed: full hash and unambiguous prefix both return the same passed run with two environments. `logs/new-probes.log`. |
| R2-N02 | fixed: actual HTTP denied read returns 403 with `workerSawDeniedRequest:false` (`logs/readers-live.log`). |

## Decision 0012: each departure

| # | Verdict | Evidence against the stated departure |
| --- | --- | --- |
| 1 | pass | Actual reports/proposals/plans use integer database ids with public C-/T-/P-/Q-/R- refs; cross-project refs stay project-relative. Observed throughout the invoke/HTTP probes. |
| 2 | issues | Change-run target/job/producer lanes preserve failures (original round-2 probes). Planned slots still collapse another job/environment: R3-B02. Prior correction backfill also diverges from current evidence: B01. |
| 3 | issues | Mixed batches store human+auto for a person, auto+auto for CI, agent+agent for an agent. Pinned methods and agent opt-in both checked; accepted agent evidence passes only the requested planned run and leaves the commit pending. However, the inherited rule uses an agent base result to excuse a CI head (R3-B10), contradicting the absolute commit-gate exclusion. |
| 4 | issues | Inherited rule, fact disappearance, valid mistaken classification and alternate failure classification run in the suite/probes. The added mistaken effect exists, but withdrawing it can erase a later independent correction: R3-B06. |
| 5 | not checked | Browser draft persistence is explicitly outside this engine review. The audited server accepts sealed proposals; no browser durability approval is given. |
| 6 | pass | Real 100,000-result uploads: durable accept precedes apply; 334 accepted-horizon reads are pending, concurrent writes survive, and two crashes at that boundary recover once. Applied in slices of 500 in the inspected generator. |
| 7 | pass | Closed named run returns conflict. A valid same-target, same-producer correction admitted to two runs leaves the closed slot satisfied/uncorrected and changes only the open run to failing (final-probes.mjs). |
| 8 | issues | All four hold types checked at boundaries; infra keeps other environments unexplained and reasks; subset runs cannot dissolve unrelated causes. Ingest-before-sweep expiry loses the promised ledger row and later duplicates questions (B05). Old evidence hash can target a newer build (B08); plans may lack the corresponding question (B03). |
| 9 | pass | Real claim twice across two commits of pr:10 creates one review; changing the key to pr:11 creates a second. The case hash participates in the basis; patch changes under the same key do not. final-probes.mjs review-basis-change-key. |
| 10 | not checked | Whole-instance transfer, token exclusion and empty-instance import are explicitly outside scope. Their baseline tests ran without failure, but are not an independent review of that departure. |
| 11 | pass | All fifteen registry operations are present and reachable over HTTP/OpenAPI. No announce/attach/trace op. HTTP transfer route existence/authentication was inspected; archive/CLI implementation remains outside scope. |
| 12 | pass | Actual OpenAPI has the registry input schemas and generic Ok/Failed reply envelopes; core/api.ts contains response types. No operation-specific reply schemas are claimed. |
| 13 | pass | Conflict resolution creates a separate proposal subject to adoption; strict leaves it open. Concurrent nonconflicting work survives, overlapping work conflicts, and multi-edit/policy smuggling is refused. Agent and CI conflict authors cannot merge; an agent can withdraw its own conflict. |
| 14 | pass | Invalid case-typed claims are rejected; invalid automated claims persist unresolved with declined reasons, never fill slots and still block the commit. All-refused reports stay pending. |
| 15 | pass | Unknown/no-proof/skips-only/refused-only/agent-only commit gates stay pending. Later skip does not replace counted pass/fail in tested commit and slot paths. Other-job replacement is separately a departure-2 defect, B02. |
| 16 | pass | A late report for an older commit keeps the change head at the newer commit. The older commit can still be queried exactly. probes.mjs late-report-changes-pr-head. |
| 17 | issues | Original repository collision is fixed: change gate, impact, prior-slot fill and ambiguous commit lookups select/refuse correctly. Trunk failure questions/excuses still share line:trunk across repositories, letting a decision from a excuse b: R3-B04. Also, the inherited hint reads an unrelated repository’s trunk when b has no base result (R3-B11). |
| 18 | pass | Automated case:1 key is refused before any test/result row is inserted. Subsequent manual C-1 uses its identity test and exact pinned basis. round3.mjs reserved-key-refusal. |

## Defects

### R3-B02: A planned slot lets another job or environment hide a failure

Blocks: yes.

Change runs now separate target/job/producer lanes, but planned slots still collapse results by actor, method and test only. `aggregateSlot` never receives the target or job. A later pass in another job or environment replaces the failing slot result, and the run passes and closes.

Run `bun scripts/round3.mjs slot-job-lanes` or `bun scripts/round3.mjs slot-environment-lanes`. Pin C-1 at one commit; report the same keyed test failing in job e2e and passing in job unit, both exact C-1@1 from the same actor. The planned gate changes from `blocked` to `passed`, with `causes:[]`; the commit gate correctly stays `blocked`. Production fail followed by staging pass has the same result. Both results remain uncorrected. Each variant was rerun in `logs/slot-job-confirmed.log` and `logs/slot-env-confirmed.log`.

Locations: `src/core/runs.ts:148` and `src/server/runs/runs.ts:583`. This contradicts P3, check 7's other-job rule, and 0012 departure 2's promise that slots retain every failing cause.

### R3-B10: An agent's base result indirectly turns a failing CI gate green

Blocks: yes.

The change-run fold excludes agent results, but `failsOnBase` reads raw results without checking their method. An agent's failure on the base supplies the loose preset's `fails-on-base` fact, and its rule then excuses a real CI failure on the head as inherited. No person accepted the agent's evidence.

Run `bun scripts/final-probes.mjs agent-base-excuses-ci-failure`. An agent reports test same-test failing on app/main at agentbase1. Its base gate correctly stays pending. A CI actor reports the same failure on cihead1, PR 9, with base agentbase1. The head immediately becomes `passed`, `excused:1`; Q-3 is `decided by rule`, answer `inherited`, signed under `failure-on-base`. The only base result has `method:agent`; the head result has `method:auto`. Repeated in `logs/agent-base-confirmed.log`.

Locations: `src/server/evidence/evidence.ts:294–295` and `:1035–1048`; `src/server/ops/writes.ts:240–244`. This contradicts decision 0009 and 0012 departure 3: agent evidence never moves a commit gate and requires a person's judgment. P3 applies to evidence used by a rule as well as to evidence counted directly. Round-2 B02's direct fold is fixed, but this indirect route remains.

### R3-B11: A change inherits a failure from a different repository's trunk

Blocks: yes.

If the requested base has no recorded result, `failsOnBase` falls back to the latest trunk result for the project/test. That query omits the repository, so a trunk failure in a can claim that b's change already failed on its own base. Under loose policy the resulting inherited decision makes b's gate pass.

Run `bun scripts/final-probes.mjs foreign-repository-inherited-fallback`. Report one failing keyed test on repository a/main. Report the same signature/key on repository b's PR 9 with an unreported b base. No b trunk or base result exists. Nevertheless its Q-3 is decided by rule as `inherited`, and the head gate is `passed` with `excused:1`. `logs/foreign-base-confirmed.log` repeats the result and lists the only two targets: a/trunk and b/change.

Locations: `src/server/evidence/evidence.ts:290–292` and `:1047`. This violates P3, check 6's scope requirement and departure 17's repository-specific evidence. Unlike R3-B04, this does not reuse any prior excuse: it manufactures the evidence for a new rule decision from the wrong repository. Restrict the fallback to the change's repository.

### R3-B08: An infrastructure answer on stale evidence excuses a newer build

Blocks: yes.

The failure question's evidence hash includes only signature, scope and hints. A new target updates the displayed evidence and the target that an `infra` answer will cover, but leaves that hash unchanged. The caller's old `onEvidence` is accepted and the answer is applied to evidence the caller never saw.

Run `bun scripts/final-probes.mjs stale-target-infra`. Report the same failing test on staletarget1; keep the question and hash. Report it on staletarget2, then answer the saved question `infra` with the old hash. The question and hash are unchanged, but its displayed target changed. The reply is `decided`; the sole excuse names target 2 and staletarget2 passes. The older build remains blocked with `open:[]`. Repeated in `logs/stale-target-confirmed.log`.

Locations: `src/server/ops/writes.ts:269`, `src/server/decisions/decisions.ts:271`, and the infrastructure target selection at `src/server/decisions/kinds.ts:334–341`. This violates check 6's stale-evidence conflict requirement and departure 8's promise that an infrastructure decision excuses the build it was given for. The new target matters to this answer even when the failure signature did not change.

### R3-B04: A trunk excuse from one repository excuses another repository's gate

Blocks: yes.

`scopeOf` returns `line:trunk` for every repository in a project. Failure questions and excuses therefore share the scope even though targets and change gates have repository identities.

Run `bun scripts/round3.mjs trunk-repository-excuse`. Report repository a/main failing, decide it flaky, then report repository b/main failing with the same test key and signature. Repository b's first gate is `passed` with `excused:1`; its receipt says `already decided` and points to a's Q-1. The only excuse has `scope:line:trunk,target:0`. No evidence from b existed when that answer was given. Repeated in `logs/trunk-repo-confirmed.log`.

Location: `src/server/evidence/evidence.ts:476`, also `src/server/runs/runs.ts:630`. This violates P3/P4's scope requirement and the repository isolation exercised by checks 6 and 7. The round-2 repository fix covers change scopes, but leaves trunk shared.

### R3-B09: Forgetting an actor leaves its established event stream authorized

Blocks: yes.

The events route checks authorization only when opening the stream. Its subscription sends every later project event without rechecking the token or grants. Forgetting the actor revokes its tokens, but does not close or deauthorize that stream.

Run `MAINWORTHY_READERS=2 bun scripts/final-probes.mjs forgotten-live-event-stream`. Start the loopback server on port 7574, create a project-scoped reader, and open its events stream. Forget that actor using the owner, then create a case. A new request with the reader token is 401, while its old stream receives the post-revocation `propose` event, including actor, sequence and touched refs. Reproduced with readers disabled and with two reader workers; `logs/revoked-stream-confirmed.log` shows `newRequestAfterForget:401` and the received event. The script closes the stream/server and removes its data.

Location: `src/surfaces/http.ts:204–239`, especially the subscription at 227. This contradicts check 9: a forgotten actor's token must stop working, including the project event surface. Recheck before delivery or terminate subscriptions when authorization is revoked.

### R3-B06: Undoing a mistaken-result decision also undoes a later producer correction

Blocks: yes.

`slot_results.corrected` records only a boolean. `restoreFailures` blindly clears it for the pairs stored by an older decision, even if a producer has since corrected the same result independently. Undo therefore removes standing/evidence that the withdrawn decision did not create.

Run `bun scripts/lifecycle.mjs undo-mistaken-after-producer-correction`. Keep a two-case run open by leaving C-2 missing. Fail C-1 on attempt 2, have another person pass it, and answer the resulting dispute `mistaken`. The original producer then sends a valid passing correction of that failure. Before undo the gate has `pass:1,missing:1`. Undo the mistaken decision: the original failure becomes `corrected:0`, the slot becomes disputed, and the gate becomes `blocked`, although result 3 still records `corrects:1`. Reproduced in `logs/undo-confirmed.log`.

Locations: `src/server/runs/runs.ts:917` and `src/server/decisions/kinds.ts:322`. This contradicts P0 and 0012's promise that withdrawing a decision changes only what that decision made. This is distinct from R3-B01: it occurs in an existing run whose correction was already applied correctly.

### R3-B01: An accepted correction is not honored by the commit gate or a new planned run

Blocks: yes.

The correction path marks existing open slots, but the change-run fold still selects by attempt, and `fillFromPrior` admits every historical result without applying `corrects`. The same evidence therefore passes an existing planned run and blocks an equivalent new one.

Reproduce from `engine-r3`: `bun scripts/new-probes.mjs correction-rebuild-and-attempt`. Create C-1 and a planned run at `correct2`; report test `corrected` failing on attempt 2, then send a passing result with `corrects` naming that failure and the default attempt 1. The correction is accepted with `rejected:[], declined:[]`. The existing run is `passed`, the commit gate is `blocked`, and a new identical plan is `blocked`. In the first run the failure has `corrected:1`; in the new run it has `corrected:0`. Both the original and confirming runs are in `logs/new-probes.log` and `logs/correction-confirmed.log`.

Locations: `src/server/runs/runs.ts:454`, `:472`, `:847`; `src/server/evidence/evidence.ts:983`. This violates P3 and 0012's correction exception: the same producer's valid correction must change which of its results counts in open runs. A correction must not silently require an unrelated attempt number to take effect.

### R3-B03: A run planned after a failure misses its question and future decision

Blocks: yes.

Planning over existing failing evidence fills the slots and tallies the failure, but never attaches the new run to the failure question. Answering that question later does not recompute the run, because it is absent from both the question's refs and the decision's dependents. The run stays blocked after the cause is excused, with no open question to answer.

Run `bun scripts/round3.mjs posthoc-plan-failure-question`. Create C-1, report an exact failing test at `posthoc1`, then plan a run for C-1 at that commit. Its gate is `blocked` with `open:[]`. Answer the existing failure question `flaky`; the answer is `decided`, the inbox is empty, and the new run remains `blocked`, `unexplained:1`, `open:[]`. Repeated in `logs/posthoc-confirmed.log`.

Locations: `src/server/runs/runs.ts:831` and `:847`; `src/server/decisions/decisions.ts:480` (`runsAbout`). This violates P3/P4 and checks 6 and 7: an unexplained failure must have an answerable question, and a recorded decision must update every run whose counted cause it covers.

### R3-B05: Expiry on ingest leaves an old decided question that the sweep reopens again

Blocks: yes.

When ingest sees an expired hold, `raise` removes the old excuse and creates the next question epoch, but it neither records expiry nor retires the previous epoch's decided state. The later sweep then reopens that previous question. The inbox contains two open questions for one cause, and `askedAgain` refuses answers on the old one.

Run `bun scripts/lifecycle.mjs ingest-expiry-ledger`. Decide Q-1 flaky, advance 15 days, and report the same cause again. The gate first reads `pending`; ingest opens Q-3 with `prior:1` and removes the excuse. Before the sweep the failure ledger still contains only `flaky`. Run the real `sweep`: it returns 1 and the inbox becomes `[Q-3,Q-1]`. Answering Q-1 after that sweep returns `conflict`, directing the caller to Q-3. `logs/expiry-confirmed.log` repeats both results.

Locations: `src/server/decisions/decisions.ts:158` and `:549`. This violates P4, check 6's expiry-ledger requirement, and 0012 departure 8's single visible expiry chain. Both ingest and sweep must agree about which epoch remains actionable.

### R3-B07: Create-cases mapping under strict policy points to a proposal that was rolled back

Blocks: yes.

The `map` create handler seals and raises an adoption proposal, then throws when adoption needs review. `settle` runs in a savepoint, so that throw rolls the proposal back too. The reply tells the caller to accept a proposal which does not exist.

Run `bun scripts/lifecycle.mjs map-create-strict`. Switch to strict, report one unlinked test with a source file, and answer its map question `{is:'create'}` as the owner with a reason. The reply is `invalid` with `needs:'the new cases need a person to adopt them first; accept that proposal, then link'`; `proposalDelta:0`, `openAdopts:[]`, `cases:0`. Repeated in `logs/map-create-confirmed.log`.

Location: `src/server/decisions/kinds.ts:223`, called in `decisions.ts:321`'s savepoint. This breaks the exposed create-and-review path under P5. Needing review must leave an actual reviewable proposal, or the operation must offer an accurate supported workflow.


## The tests do not prove this

### R3-T01: The wrong-kind witness test passes without the kind guard

Blocks: no.

`test/integrity.test.ts:596` performs a normal map and checks that stored decisions have normal kinds. It never presents a genuine witness to the wrong writer, despite its name and opening comment.

Run `python scripts/test-strength.py`. In the export only, it removes both lines that reject `value.#kind !== kind`. The named author test still reports `1 pass`, `0 fail`, `2 expect() calls`. The independent `scripts/standing.mjs` probe fails on that same mutation, demonstrating the missing protection, and the script restores the original source in `finally`. The unmodified implementation passes genuine adopt-to-link/excuse, failure-to-close, and signoff-to-policy refusal tests. This is a test gap, not an additional implementation blocker.

### R3-T02: The token replay test's count assertion is vacuous

Blocks: no.

`test/integrity.test.ts:671` checks `rows('SELECT count(*) AS n FROM tokens ...').length === 1`. An aggregate count always returns one row, whether there are zero, one, or several tokens. Assert that row's `n` instead. The replay refusal and no-secret assertions still test useful behavior; the independent replay probe also checks the actual token count and passes. This does not add an implementation blocker.


## Worth doing later

### R3-N01: Reader-count default disagrees with the round-3 brief

Blocks: no.

The brief says the default is capped at four reader workers. `src/server/readers.ts:14` uses `Math.min(8, Math.max(1, cores - 2))`; the actual `readerCount({}, 16)` probe returns 8. Explicit counts and zero work, and this is not a measured performance issue. Reconcile the default and its documentation; no additional blocker.


## Review notes

Scope: no review of web/e2e, transfer/archive, CLI/MCP/formats, excluded core utilities or benchmarks. The required broad test command includes some excluded tests; none failed. Performance, including the tracked continuous-report read-latency issue #60, is not a verdict here.

Probe-method corrections: two legacy reserved-key collision probes stop at the new expected invalid refusal; the dedicated atomic-refusal/manual-identity probe passes. Initial support hold syntax, one Unicode query/length assumption one final-probe obligation missing minActors, and an initially wrong scratch mutation target path were corrected before relying on their results. Confirming logs and current scripts contain the corrected checks; none of those fixture errors is a finding.

The report separates current implementation defects from tests that could pass with wrong behavior and from a nonblocking default/documentation mismatch. Findings are reproduced through the public operation registry or a loopback HTTP server; SQL reads inspect their durable effects.

Defects are ordered by their effect on gate correctness and authorization, followed by lost correction/decision state and broken workflows; finding ids stay stable as the report grew.

Final integrity audit: all 464 exported archive files match revision 9ca6d25126dcaa9f3545251f1469f426f4930ceb byte for byte, including every temporarily mutated file (logs/final-audit.log). No changes were made to the shared repository.

Cleanup audit: no review server processes, no listeners on the used review ports, and no /tmp/mainworthy-engine-r3-* directories remain (logs/cleanup-audit.log). The forced reader exit in readers-live.log is deliberate fault injection; all queued requests completed.


ISSUES (11 blockers)
