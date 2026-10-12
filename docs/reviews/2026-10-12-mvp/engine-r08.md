# Casebook engine review, round 8

Revision: `0be06bbb7d78d44c49307b791b8ec431aae259fc`, branch `t3/mvp-product-delivery`.

Reviewer: Codex, GPT-6 Astra. Ordinary local QA against a clean `git archive` export. I ran the checks myself, started no other agents, and changed neither the shared repository nor Git state. This is a different provider from the engine author, Claude Opus 5.5. Reader-thread checks are functional QA from the same provider as their author, GPT 6.1 Sol, and are not a separate-provider signoff for that subsystem.

Four blockers remain. One report sequence exhausts the call stack. Three other defects allow failures to pass without the required current evidence or scope authority.

The correctness fact being checked is that every counted excuse has a live decision which covers that failure's scope and target and whose evidence dependencies still hold. That fact is false in B02, B03 and B04. B01 prevents the engine from reaching a stable result when two live runs need different treatment of the same cause.

`tree/` is the reviewed export. `scripts/` holds reproductions; `logs/` holds the output of this round, not the author's output. Commands below run from `engine-r8` unless they name `tree`. After cleanup, run `bun install --frozen-lockfile` in `tree` before rerunning them. The defect scripts assert the observed wrong behavior; their assertions should fail after a fix. The time-bounded B01 script must return normally after a fix.

## Twelve checks

| # | Check | Verdict | What I ran and the deciding evidence |
| --- | --- | --- | --- |
| 1 | Author tests and architecture | pass in scope; coverage limits below | `python3 scripts/author-checks.py` ran `bun test src test --path-ignore-patterns 'test/e2e/**'`, `bunx tsc --noEmit`, and `bunx biome check src test bench`. Output: `585 pass`, `1 fail`, `16517 expect() calls`, `586 tests across 28 files`; tsc exit 0; Biome `Checked 178 files ... No fixes applied.` The one failure is the excluded disk-budget check, which rejects `/tmp` because it is tmpfs. Architecture mutations for upward imports, a second mint caller, foreign-table SQL, raw SQL and an unused witness all fail their named checks. A structural witness fails tsc for its missing private fields; the architecture test alone does not reject it. Logs: `author-checks-summary.log`, `architecture-summary.log`, `architecture-additional-summary.log`, `architecture-last-summary.log`. |
| 2 | Standing and witnesses | pass | [STANDING.md](STANDING.md) lists the scoped standing statements and their decision call paths, projections and four exceptions. `probes`, `standing`, `round3`, `support`, `ledger-fk`, and the earlier `witness-constructor` and `foreign-keys` probes ran here. Plain/prototype/reflective objects and a second mint are refused. The wrong-kind probe rejects all tested writers; removing its guard fails both the author regression and independent probe. Seven ledger foreign keys reject a missing decision; `foreignKeyViolations:[]`. Undo preserves newer links, signoffs and independent producer corrections. B02–B04 are incorrect authority from recorded decisions, not an unrecorded standing writer. |
| 3 | Idempotency and atomicity | pass for the requested accounting; B01 is a separate application failure | `probes`: `firstSeq:2,retrySeq:2`; operation, actor and project reuse each conflicts; `lateRollbackUnchanged:true`; 150 unique events numbered 2 through 151 and `failedCommandsConsumeSeq:false`. Instance commands replay. `new-probes` stores only the secret-withheld marker, refuses token replay and counts exactly one token. `round3` sends 100,000 results twice: `rows:100000,batches:1,retryFresh:false`. The live write and crash checks preserve distinct sequences and no duplicate results. Logs: `rerun-probes.log`, `rerun-new-probes.log`, `rerun-round3.log`, `rerun-live.log`. |
| 4 | Non-overwriting edits | pass | `probes`, `policy-supplements`, and author suite/integrity tests exercise disjoint stale-field merge, same-field conflict, delayed adoption, resolution after more work, author/adopt policy, restore, tag deltas and folder cycles. Deciding output includes `differentField:merged preserving human pre`, `sameField:conflict`, `restoreVersion:5,versions:5`, delayed tags `[agent,human]`, multi-case/policy resolution `forbidden`, and a cycle refusal. The conflict keeps both sides. |
| 5 | Evidence basis, methods and inputs | pass | `probes`, `new-probes`, `round3`, `final-probes` and author tests exercise exact/assumed/unresolved basis, pinned-version mismatch, foreign refs, other-producer/target corrections, reserved test keys, empty/unusual text and emoji clipping. Invalid case claims are rejected; invalid automated claims remain unresolved and declined with `slotFills:0`, and declined failures still block the commit. Per-result methods are human+auto / auto+auto / agent+agent. The 100,000-result probe records exactly 100,000 rows and one batch on replay. Unicode output is well formed; unpaired surrogates and empty reports/keys are refused. B04 concerns decisions about admitted evidence, not admission or method attribution. |
| 6 | Questions, holds and ledger | issues | Original probes pass for 500 failures becoming one question, cause separation, clock/basis/target expiry, stale ordinary answers, undo chains, rule-clause attribution and withdrawal not being silently overruled. `lifecycle-positive`: six environment orders, 36 answers, no extra questions. `fixed-covered-question`: the R7-N01 question is now closed when covered. B01 cycles between answering and ending inherited decisions. B02 retains dependencies that no longer describe the evidence. B03 uses an answer from another line. B04 accepts inherited on a stale hint when the failure counts only in an agent run. |
| 7 | Gate soundness | issues | Verdict order, unknown/no-proof/skips/refused-only/agent-only pending, lane separation, late/equal attempts, forward-only change heads and pending after clock expiry all pass their probes. In two large live uploads, 335 reads at the accepted sequence all returned pending. Two actual kill/restart runs recover exactly 100,001 results; replay adds none. B02/B03 give false passing commit gates. B04 gives a false passing planned gate. B01's report ends in `internal: Maximum call stack size exceeded.` Logs: `rerun-live.log`, the blocker logs and `round8-findings-http.log`. |
| 8 | Runs and slots | issues | Target, basis, method and pinned-version admission, explicit agent opt-in, human-only obligations, multiple tests/causes, disputes, shared results, closed-run refusal and correction snapshots pass the earlier probes. `lane-matrix`: `sequences:4500,observations:13500,commitAndSlotAgree:true`. Mistaken decisions affect existing and later plans and undo restores all three tested runs. Stale signoff conflicts; valid correction opens a fresh signoff. B01 is triggered by a live planned run on an older commit. B04 excuses the failing evidence of an opted-in agent run without verifying it against the corrected base. |
| 9 | Policy and authorization | pass for who may act under the current clause | `policy-matrix` calls all 15 operations and every answer for agent, CI and reader under loose, standard and strict: `total:324,probeErrors:0`; every clause selector matched its clause. Supplements check valid disputed answers, conflict authorship and agent self-adoption. `round8-positive` gives an applicable inherited question to agent and CI: `advised` and `forbidden`, then a stale ordinary human answer gets `conflict`. The live token checks return 403 for another project's operations/events, filter its project list, and revoke forgotten actors and established streams. R7-N02 now matches departure 4: withdrawal uses the policy currently in force. B04 is a failure to verify the evidence behind an otherwise authorized person's answer. |
| 10 | HTTP | pass | `live` and `checkpoint-live` use real loopback listeners. Local absent/same Origin = 200; foreign/null/other scheme/foreign Host = 401. Server session/events and every one of 15 operations = 401 without a token. All registry operations have routes and OpenAPI entries. Cookie flags include HttpOnly/SameSite=Strict; another origin is refused. Sized and chunked 65 MiB bodies return actual 413, and the next ordinary request returns 200. The public route list in `serve()` matches the observed health/OpenAPI/login/logout behavior; extra routes are guarded and unknown routes are 404. No browser/UI verdict is claimed. |
| 11 | Concurrency and reader threads | pass functionally, with the provider limit stated above | Each large live report preserved 40 simultaneous case writes, 41 distinct command sequences and 42 contiguous events while reads completed. `readers-live`: 128 read-after-write observations; all nine read operations agree inline/worker across 27 replies, including ten refusals; denied reads are not dispatched; worker writes are refused; all 80 requests survive a killed worker; `allWorkerExitsAwaited:true,remaining:0`. Twelve post-forgetting reads contain no old name. Checkpoint probe: 534 commits while present, 80 after termination, 614 persisted after restart; inline readers = 0; default for 16 cores = 8. B01 blocks the writer through recursive application logic, not reader-thread loss. No performance verdict. |
| 12 | Documented departures | issues | The 18 entries are assessed below. B01–B04 contradict inherited-decision and exact-gate promises. Browser drafts and archive correctness are outside scope and are explicitly not checked. None of the listed product cuts is reported as a defect. |

The author-test runner temporarily assigns only ports 8050–8099 and puts budget data under `/tmp`; it restores those test files afterward. This is environmental configuration of the exported tests, not a change to their assertions. The sole excluded failure is `on-disk hot paths stay inside the design budgets`, with the deciding tmpfs rejection in `logs/author-tests.log`. No other out-of-scope compilation or test failure occurred. No performance figures or budget verdict are inferred from this run.

The additional author sequence command was run in `tree`: `CASEBOOK_SEQUENCE_SEEDS=200 bun test test/sequences.test.ts`. It prints `3 pass, 0 fail`: 200 sequences each under loose, standard and strict, 48,000 steps total. The independent scripts also ran: `state-sequences.mjs 100` gives 10,000 audited steps and zero problems; `state-remaining.mjs 60` gives 9,000 and zero problems in its enabled assertions; `R7_CHECK_INHERITED=1 bun scripts/state-extended.mjs 60` gives 7,200 and zero problems, with the covered-question and inherited-fact checks enabled. The remaining script retains its two earlier disabled assertions; they are not claimed as evidence from that script. Extended output records 773 successful plans, 4,992 successful reports, including 971 naming a run, and 1,081 decisions.

## Status of round 7

| Finding | Status | What the current revision prints |
| --- | --- | --- |
| R7-B01 | fixed with a new problem | `inherited-other-commit.mjs` fails its old `passed` assertion with actual `blocked`. However its original HTTP version, which also keeps an older planned run open, now returns `internal: Maximum call stack size exceeded.` This is R8-B01. |
| R7-B02 | fixed with new problems | Both `inherited-base-corrected-late.mjs` and its HTTP version fail the old `passed` assertion with actual `blocked`. Positive tests also cover newer attempts, another environment, a base already on a stacked change, another repository, moved/repeated reports and a mistaken decision on the base. R8-B02 and B04 expose incomplete dependency tracking and planned-agent evidence respectively. |
| R7-N01 | fixed | `covered-question.mjs` fails its old assertion that the first question remains open. `fixed-covered-question.mjs` asserts zero remaining questions and passing gates for both covered targets. |
| R7-N02 | fixed by documented contract | `undo-switched-policy.mjs` still prints `forbidden → reopened` for the original producer and `invalid → reopened` for no reason after strict is changed to loose. Departure 4 now explicitly states that withdrawals follow the current policy. The two ledger entries name policy 1 and policy 2. |

## Earlier reproductions

The earlier probes ran before new exploration and the author-test checks. `rerun-all.py`, `rerun-r6.py` and the round-7 replay produced `logs/rerun-*.log`; the summaries preserve each exit status and deciding output. Old defect probes intentionally assert bad behavior, so assertion failures at their old expectations are evidence of a fix, followed by the positive replacements where necessary. The two additional round-2 scripts and the remaining environment/exploration probes were also run.

| Earlier finding | Status and deciding evidence from this round |
| --- | --- |
| R1-B01 | fixed: multi-case/policy conflict resolution is forbidden and unrelated state is preserved. |
| R1-B02 | fixed: mixed-result methods follow actor kind; agents cannot count as automation. |
| R1-B03 | fixed: naming a run with a different target is invalid and writes no results. |
| R1-B04 | fixed: skips/refused-only evidence cannot clear a failure or establish proof. |
| R1-B05 | fixed: repeated/older reports do not move a change head backward. |
| R1-B06 | fixed: older/equal attempts preserve the failure; correction histories agree. |
| R1-B07 | fixed: other-target correction refused; closed slot remains satisfied and uncorrected. |
| R1-B08 | fixed in its original scope: per-target infra and broad replacement pass. B03 covers the separate two-line case. |
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
| R2-B02 | fixed: agent-only commit pending; agent pass cannot clear pipeline failure. |
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
| R3-B02 | fixed: another job/environment's pass preserves the failing lane. |
| R3-B03 | fixed: a plan over existing failure names an answerable question and responds to its decision. |
| R3-B04 | fixed: trunk answer scope includes repository. |
| R3-B05 | fixed: ingest writes one expired row; a subsequent sweep writes none. |
| R3-B06 | fixed: undo mistaken preserves a later producer correction. |
| R3-B07 | fixed: strict map/create is invalid and leaves proposal/case counts unchanged. |
| R3-B08 | fixed: newer target changes evidence hash and the old answer conflicts. |
| R3-B09 | fixed: established stream closes after forgetting; next request is 401. |
| R3-B10 | fixed: an agent's base failure cannot justify inherited for a pipeline head. B04 is the reverse, an explicitly admitted agent head. |
| R3-B11 | fixed: another repository's trunk does not justify inherited. |
| R3-T01/T02 | fixed: removing the witness-kind check fails its regression; token replay counts the one stored token. |
| R3-N01 | fixed: default readers are cores minus two clamped to 1–8; explicit 0 is inline. |
| R4-B01 | fixed with new problems: original corrected-base/fallback probes remain blocked; B02/B04 cover later dependency changes. |
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
| R5-B05 | fixed in its original case: split/combined reports each show two unexplained failures and no inherited decision. B02 is a new split-report dependency case. |
| R5-B06 | fixed: the new failure gets a new question; the originally mistaken result remains discounted. |
| R5-B07 | fixed: strict producer withdrawal forbidden; independent withdrawal without reason invalid. |
| R5-N01 | fixed: failure filter empty; one-item pages return all four refs. |
| R6-B01 | fixed: the 501-test old probe expects passed and gets blocked; positive and HTTP variants show 501 unexplained failures. |
| R6-B02 | fixed: old later-plan probe expects blocked and gets passed. Positive/HTTP tests and three-run undo confirm the new behavior. |
| R6-B03 | fixed: old expected passed gate is now failed; both affected gates update and the ledger records replacement. |
| R6-B04 | fixed: stale signoff no longer exists and cannot close the run; a new signoff after correction succeeds. |
| R6-N01 | fixed: old expected empty list now has one question, and both runs name Q-4. |
| R6 sequence/tally and actor-label findings | fixed in rerun: enabled sequence audits report zero problems; 12 worker reads after forgetting use the new pseudonym only. |

Two `new-probes` fixtures stop on the now-reserved `case:1` input; `round3` verifies both intended refusal and no writes. `fixed-overlap-stale-gate` is itself stale because its older narrower question has been superseded; `fixed-r7` asserts the current broad question updates both gates. The original R6 `findings-http` stops on its now-false 501-test assertion; `fixed-r6-http` ran all four cases successfully. These are probe expectation changes, not newly counted defects.

## Decision 0012 departures

| # | Verdict | Evidence and limit |
| --- | --- | --- |
| 1 | pass | Operations use project-relative refs and stored integer identities; foreign-project refusal and resolution probes pass. |
| 2 | issues | Ordinary lane accounting, same/equal/late attempts and full slot histories pass. B03 shows the commit run's single scope misclassifying a result whose target was later reported on another line. |
| 3 | pass for admission and method attribution | Pinned methods, linked-test eligibility and agent opt-in pass. Agent-only commits remain pending. B04 is the subsequent failure decision on admitted agent evidence. |
| 4 | issues | Original 501-test/split-report and late-base corrections pass; withdrawal now matches the documented current policy. B01, B02 and B04 contradict the inherited-answer guarantees. |
| 5 | not checked | Device drafts and per-person browser storage are outside the engine scope. Sealed server proposals are covered by check 4. |
| 6 | pass | Durable acceptance produces pending before application; large uploads and two actual crash/restart recoveries pass. Source uses 200-result slices. B01 is a failure in decision application, separately reported. No timing verdict. |
| 7 | pass for the stated snapshot/refusal rule | Closed-run uploads conflict; producer corrections preserve closed snapshots and update open/future runs. Reopening produces an answerable question. |
| 8 | issues | Original target/environment holds, clock expiry, replacement and closure probes pass. R7-N01 is fixed. B01 prevents stable per-target question handling, while B02/B04 leave holds standing without their supporting fact. |
| 9 | pass | `final-probes`: same case/change yields one reviewed-basis row; different change yields two. Patch-hash invalidation is expressly deferred. |
| 10 | not checked | Archive correctness is outside scope. Existing archive tests and the prior foreign-key probe ran, but no whole-archive review is claimed. |
| 11 | pass | Registry/OpenAPI probes find 15 operations and their routes. Deferred operations and separate streaming transfer are described. |
| 12 | pass | OpenAPI schemas describe inputs and generic reply envelopes; typed reply shapes are in `src/core/api.ts`. Full output schemas are not promised. |
| 13 | pass | Resolution creates a new policy-controlled proposal, with single-case/author restrictions and re-merge/conflict behavior tested. |
| 14 | pass | Declined automated claims remain unbound and cannot fill slots, but their failures still block commit gates. Case-typed claims are rejected. |
| 15 | pass | Unknown/no-proof/skips/refused-only/agent-only pending and skip preservation pass. The incorrect excuses in the findings are distinct from empty-evidence behavior. |
| 16 | issues | Forward-only head behavior passes. The exact commit-gate promise fails in B02/B03. |
| 17 | issues | Repository separation and commit-only inheritance of an existing line pass. The documented two-line limitation is not sound: B03 passes a commit after its trunk failure is explicitly attributed. |
| 18 | pass | Reserved automated keys are refused before writes; manual identity fills only its own pinned case. |

## Blocking defects

### R8-B03: A commit reported on two lines can pass after a failure is explicitly decided to be a defect

Blocks: yes. Confirmed twice with `bun scripts/two-lines-gate.mjs`; logs are `logs/two-lines-gate.log` and `logs/two-lines-gate-confirmed.log`.

Report a failure on PR 1's head in environment `ci`, then answer flaky. Report another test failing with the same cause on the same commit after it reaches `main`, in environment `production`. Answer the new trunk question defect. The decision succeeds with `class:attributed, scope:line:trunk@app`, but the commit gate remains `passed`, with `excused:2, attributed:0` and no open question.

The two targets have different line scopes. The commit has one change run whose stored scope is the first target's `change:1`. `runs.count` classifies every result using that run-wide scope, so the change's broad flaky decision also classifies the trunk result, and the trunk defect decision is ignored by the commit gate. The plan counter instead uses each target's scope when its run scope is null.

This is more than the documented duplicate-question cost. It contradicts P3, check 6's scope requirement, and departures 16/17's exact commit-gate promise. The task brief explicitly asks whether the two-line behavior is sound and states that it never passes wrongly; this sequence shows a false passing gate after an explicit defect decision.

### R8-B02: An inherited answer retains old dependencies when its failing tests or base change

Blocks: yes. Confirmed twice with `bun scripts/inherited-moved-base.mjs`; see `logs/inherited-moved-base.log` and `logs/inherited-moved-base-confirmed.log`.

Report one failing test on trunk001 and on stack001, the head of PR 2. Report the same failure on head0001 of PR 1, based on trunk001, which is correctly excused as inherited. Send the same head report with its base changed to stack001. Then correct stack001's failure to pass. PR 1 still passes with one excused failure and `stale:false`, although its explicit base now passes that test.

Deciding output: `movedFresh:false`, `baseAfter.verdict:passed`, `baseAfter.tally.pass:1`, `headAfter.verdict:passed`, `headAfter.tally.excused:1`. The stored PR 1 base is `stack001`. Its inherited decision's `decision_rests` rows still name only `line:trunk@app` and its own change scope, not PR 2's scope.

A second confirmed input reaches the same incomplete-dependency defect without moving the base. Run `bun scripts/inherited-added-test-attempt.mjs`. Report base tests `one` and `two` failing, then report head failures in two separate batches, `one` first. The inherited decision records only test `one`. A newer base attempt passes test `two`; the head still reads `passed, excused:2`. Repeating the head report changes it to `blocked, unexplained:2`. `logs/inherited-added-test-attempt-confirmed.log` records the repeat. An explicit correction happens to recheck the whole scope, so that variant passes; a newer attempt exposes the incomplete test list.

`recheckInherited` leaves a still-valid answer and its old dependency rows unchanged when the base moves. `restOn` runs only at initial settlement, so the subsequent correction on the new base does not find the dependent decision. This contradicts P3/P4, checks 6 and 7, and departure 4's promise that a base correction ends an inherited answer immediately. The simple round-7 base-correction reproduction is fixed, but this supported base-movement sequence preserves the same false passing gate.

### R8-B04: Inherited validation ignores the failing agent results that a planned run admits

Blocks: yes. Confirmed twice with `bun scripts/inherited-agent-stale.mjs`; `logs/inherited-agent-stale-confirmed.log` contains the deciding output.

Under standard policy, create a case admitting agents. Report a pipeline-style base failure and the same test failing on the head from an agent. Plan an exact-basis run explicitly requiring agents. Save its failure question, then correct the base failure to pass. Answer the saved question inherited as a person. The answer succeeds and the planned run passes, although the base no longer fails.

Deciding lines: `before.verdict:blocked`, `baseAfter.verdict:passed`, `answer.status:decided`, `after.verdict:passed, tally.excused:1`; `decision_rests` is empty.

The inherited effect, dependency recording, and recheck all use `failingWithCause`, which reads only the commit's `run_tests`. Agent results correctly do not enter a commit's gate, but they do count in an opted-in planned run. The resulting empty test list makes the inherited validation succeed vacuously and writes no dependencies. `scripts/inherited-agent-plan.mjs` also demonstrates that an earlier rule-made inherited answer persists after base correction. This is distinct from B02's failure to refresh a previously complete dependency list: the initial validation itself does not inspect the failing evidence the question is about.

This contradicts P3, the brief's stale-answer requirement, and departure 4's promise to verify inherited against the base when it is given. Opting a run into agent results must still preserve the answer's evidence requirements.

### R8-B01: Reporting a newer inherited failure exhausts the stack while an older failing planned run is open

Blocks: yes. Reproduced through HTTP in the unchanged round-7 `inherited-other-commit-http.mjs`, then independently reduced through `invoke` in `scripts/inherited-open-plan.mjs`. The final one-result HTTP report eventually returns an internal error, `Maximum call stack size exceeded.` The in-process reproduction was stopped after 12 seconds and again after 5 seconds. Earlier commands return immediately. `logs/rerun-inherited-other-commit-http.log` captures the full stack through `raise → askUnexplained → refold → settle → raise`.

Create one case. On the base, test `old` fails and test `new` passes with the same cause. On head0001 of PR 1, `new` fails. Plan an open run pinned to head0001. Then report `old` failing on head0002 of the same PR. The last report cycles until the call stack is exhausted. Without the planned run, the original in-process R7-B01 probe returns the correct blocked verdict for head0001.

Run from `engine-r8`: `timeout 12s bun scripts/inherited-open-plan.mjs`. Deciding log: `logs/inherited-open-plan.log` ends with `CALL report ... head0002` followed by `TIMED OUT after 12 seconds`, with no `RETURN report`. The unchanged HTTP reproduction is a second execution path and shows the same stuck command.

This contradicts the report-operation contract and departure 8's promise to retain an answerable question for each live unexplained run. It also blocks report processing and subsequent writes on the real server. In `raise`, an occurrence on the old target without the inherited hint lapses the newer target's inherited answer because the basis/fact differs even with `anyTarget`. Refolding the newer run answers inherited again, then revisits the old planned run. The two targets repeatedly invalidate and re-create the answer. No performance-budget claim is made.

HTTP confirmation: `bun scripts/round8-findings-http.mjs` reproduced B02's moved-base and added-test variants, B03, and B04 on a real local server with two reader workers. `logs/round8-findings-http.log` contains the responses. All four scenarios returned the same incorrect outcomes as the in-process reproductions. The server stopped and its data directory was removed in `finally`.

## What the tests do not prove

The author tests and all supplied sequence runs pass in scope while the four reduced cases violate the product contract. The checks prove the paths they run, not these missing transitions.

- The inherited-per-commit regression omits the open planned run present in the earlier HTTP reproduction. The sequence generators plan over their ordinary commit set, not the older changing PR head in B01, and so miss the recursive interaction.
- The simple base-correction regression checks one initially known dependency. It does not move a still-failing base into another scope, or grow a carried decision's test set before a newer base attempt. Those are B02's two variants.
- The generators report their ordinary and PR commit sets on separate lines. They do not report one commit first on a PR and then on trunk in another environment. Their projection audits also use the stored run scope for commit results, reproducing B03's assumption.
- The author's inherited invariant calls the production `failingWithCause` and `failsOnBase`. The former reads commit-counted tests. It returns an empty set for a failure counted only in an agent run, so both production validation and that invariant miss B04. The supplied optional inherited check also restricts itself to rule-signed commit excuses.

The independent round-8 scripts test those absent inputs directly. All four blockers have live HTTP evidence. `round8-positive.mjs` also proves the nearby intended behavior: ordinary correction and newer attempt, invalidation across environments, a base initially recorded on another change, repository isolation, fresh/repeated moves onto a passing base, refusal of a stale ordinary inherited answer, agent advice/CI refusal on an applicable answer, commit-only line preservation, and a mistaken decision that removes the base failure.

The architecture mutation distinction is deliberate: a plain structural Witness passes the architecture test but fails TypeScript with missing private fields. Removing runtime kind checking fails both the author's regression and the independent probe. Removing the mistaken answer key fails the completeness test. These are effective gates, not claims that every guard is enforced by the architecture test itself.

## Worth doing later and review limits

No separate non-blocking product defect was confirmed in this round. Performance, browser behavior, archive correctness and the listed deferred features are not approved by this review. The reader tests are functional evidence, with the same-provider limitation stated at the top. B03 must not be treated as merely the deferred cost of answering the same commit twice: it demonstrates a false passing verdict after an explicit defect decision.

## Cleanup

All review servers and worker processes have stopped. The final audit found no review process, no listener on ports 8050–8099 and no remaining review `/tmp` data. The exported tree's `node_modules`, `.casebook` and `test-results` have been released. `logs/cleanup.json` records the audit. Temporary mutations have been restored: `logs/export-integrity.json` reports `trackedFiles:404`, `mismatches:[]`, `allExportedSourceRestored:true`. Reports, scripts and logs stay under `engine-r8`. No repository change or commit was made.

ISSUES (4 blockers)
