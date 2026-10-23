# Verification report, round 5

Verdict: **issues on c93e9933c27a4878b1b81fe32010f62a7af261e0**.

Whole change reviewed: `a78b0ad..c93e993`. Round 4 fix reviewed: `git diff 0dc9170..c93e993`. Reviewer: Codex, GPT 6.1 Sol. The synthesis identifies Claude Fable 5.1 as its author. This is an independent, read-only documentation review.

**R4-1 and R4-2 are resolved.** Both requested counterexamples now produce the required results. All requested mechanical checks pass. One blocking contradiction remains in the new aggregate-rebuild instruction for review slots, reported as R5-1 below. Input naming and prototype work are listed separately.

The safety fact is that every gate counts only evidence admitted for its particular obligation, immutable basis and target; rebuilding preserves every admitted effective fact and actor disagreement; accepted uploads and current decisions govern the gate horizon. The exercise-slot corrections now support that fact. The unconditional rebuild instruction does not support the separately promised review slots.

I read the round 1 through round 4 findings, the current normative design and decision records, the surrounding usage, projection ownership and slice contracts, and the actual fix diff. Mechanical scans cover the whole change, including all historical arena Markdown. All 31 changed or added files match c93e993. I did not read the author's fix scripts or reasons. Historical candidates remain nonnormative; this round does not re-rank them or refresh competitor claims.

All line references below are at **c93e993**, unless identified as historical. Python transcriptions exercise documentation contracts with fixed fixtures; they do not run a Mainworthy implementation. Runtime correctness, persistence, latency, token budgets, backup/restore and deployment are **not checked** because this change contains no implementation.

## 1. Round 4 findings

### R4-1: resolved

The deciding lines in `docs/product-design.md` are:

- Section 6.3, :549: "slot membership is `SlotResult` (6.4), one row per admitting slot".
- Section 6.4, :601-602: `type Slot = { id: SlotId; run: RunId; case: CaseId; version: VersionNo; claim: Hash` and `obligation: ObligationId`.
- :612: `KEY (id) unique` and `KEY (case, run)`.
- :659: `type SlotResult = { slot: SlotId; run: RunId; result: ResultId; admitted: Fill['admitted']; corrected: boolean }`.
- :660-662: "a result that qualifies for two obligations on the same case has two rows; a result that qualifies for only the permissive one has one" and `KEY (slot, result) unique`.
- :663-665: "calls `qualifies` per candidate slot" at ingest, plan-time reuse and late batches; "The slot's complete effective set is its SlotResult rows minus corrected."
- Section 6.6, :813: "`qualifies` per candidate slot → `SlotResult` rows, per-actor `agg`, slot state, tally delta".

Decision 0008 item 3, :38-43, now says:

> "A result from any producer fills a slot only when the obligation admits its method, binding or charter, basis and target"
>
> "The admission is recorded per slot (one row per slot a result qualifies for), and a slot's state folds its complete effective result set per actor, never a bounded sample"

In R1, C1 now has distinct slots S-loose/O-loose and S-exact/O-exact. An assumed pass E1 produces only `(S-loose, E1)`. A read by S-exact returns no membership. An exact pass E2 qualifying for both produces two unique association keys while retaining one immutable Result. The reverse result key can return both distinct slots for correction. The earlier obligation collision is gone.

### R4-2: resolved for exercise-slot state

The deciding lines in `docs/product-design.md:604-610` are:

> `agg: Map<ActorId, { passes: number; failsUncorrected: number; latest: Seq }>`
>
> "per actor, lossless for state"
>
> "failing = an uncorrected fail and no other actor's pass; disputed = an uncorrected fail from one actor and a pass from another"

Section 6.4, :645-654, retains the complete effective set and says:

> "`agg` keeps per-actor counts"
>
> "`recent` is presentation only"
>
> "one actor's fail beside another's pass is always `disputed`"

Decision 0008 item 3, :42-43, likewise says the fold is "per actor" and "disagreement between actors is never lost". Section 6.6 :813 explicitly updates the per-actor aggregate in the execution trace.

For the 17-result histories, actor A's fail followed by A's 16 passes now yields one actor entry and `failing`. Actor B's fail followed by the same A passes yields two actor entries and `disputed`. The recent 16 rows remain identical, but the aggregates are different. The previous information-loss counterexample no longer applies. Removing the corrected B failure yields `satisfied`; two required actors still require two actors with passes. Reversing input order does not change the rebuilt counts or latest sequences.

Neither round 4 finding is still open or regressed. R5-1 concerns the scope of the rebuild source, not a return of either failed counterexample.

## 2. Blocking issue on c93e993

### R5-1. The new unconditional aggregate-rebuild source cannot preserve a qualifying review

`docs/product-design.md:602` explicitly makes Slot serve "the exercise or review obligation". Its :606 says state is "derived from agg and the obligation". The new :610 instructs:

> "it is rebuilt from SlotResult"

But :659 restricts that source to:

> `result: ResultId`

and :660-665 defines associations only for results admitted by `qualifies`, with the complete effective set consisting of those rows minus corrected rows.

The same section, :668-670, requires the opposite evidence source for a review slot:

> "A review obligation is filled only by a `Review` row at the slot's basis"
>
> "It is never filled by a result, and a result never fills a review obligation."

Section 6.3 :561-565 defines Review separately, keyed by `(case, basis, lens)`, and says "a zero-finding review writes this row". `Fill.result` at :611 allows `ResultId | ReviewId`, while `SlotResult.result` allows only ResultId. Decision 0008 item 3 :40 and item 5 :62-65 retain the distinct review obligation and explicitly allow a zero-finding review.

Counterexample: S-review serves an independent security-review obligation for C1. Reviewer B, distinct from the version's author A, records RV1 at the matching basis and lens with zero findings. By :668-669, this fills the review obligation. There is no legal SlotResult association for RV1: it is a ReviewId, and runtime results are expressly barred from this obligation. Rebuilding this slot's aggregate exclusively from the declared SlotResult source gives an empty map and loses the qualifying review. Reading the bounded recent array would violate its presentation-only rule and would not repair a rebuild.

This is a contradictory source instruction, not a request to implement the prototype. The new comment can mislead an implementer into rebuilding a satisfied review slot as missing. The separate review-admission paragraph and the general Evidence-and-Decisions projection rule at :984-986 do not explain an exception to the newly unconditional source instruction.

Scope the SlotResult/per-actor pass/fail rebuild instructions explicitly to exercise slots and state how review-slot projections rebuild from qualifying Review rows, including basis, lens and independence. Alternatively, define a typed durable membership union for ResultId and ReviewId, with separate qualification branches. Either correction must preserve the rule that a review is never a runtime result or exercise pass. No new operation, implementation or stack decision is required to repair the documentation.

## 3. Cross-contract checks

| Relationship | Result on c93e993 |
| --- | --- |
| SlotId and Slot keys | **Pass.** Slot has an explicit unique ID; `(case, run)` is candidate discovery, not unique slot identity. `(slot, result)` distinguishes obligations and supports a range read for one slot; the result reverse key returns each distinct admitting slot. |
| Result.run and reuse | **Pass.** :549 keeps Result.run as the entry location. It does not own membership. Plan reuse and multi-run admission use distinct SlotResult associations without duplicating the Result. |
| Section 6.6 execution and ingest traces | **Pass for runtime results.** :813 now names the per-slot membership and aggregate writes. :814 calls runs.fold after inserting results; :663-665 supplies its per-candidate qualification contract, including prior evidence and late closed-run batches. The open-run discovery key is supplemented explicitly by the closed-run late-batch path; horizon acceptance still covers open and closed nonfrozen runs at :672-693. |
| qualifies versus the acceptance rule | **Pass for exercise admission.** The function is supplied each candidate slot and that slot's obligation, so basis, target, methods, bindings and charter restrictions are checked separately. Aggregate satisfaction/dispute rules apply after admission; a failing result remains counted. :668-670 separately excludes runtime results from review obligations. |
| agg rebuild from SlotResult | **Pass for exercise slots; issues for review slots.** Association rows select the complete effective runtime set, corrected rows are excluded, and Result supplies actor/outcome/Seq. R5-1 identifies the source mismatch for reviews. |
| Fill and recent | **Pass as presentation for runtime results.** Fill is a projection, not membership identity or the authoritative set. The 16-row bound cannot affect the new actor map. **Issues for universal rebuild**, because Fill permits ReviewId but the declared source cannot store it; see R5-1. |
| Correction fan-out | **Pass at the documentation-key level.** Reverse lookup by result reaches both admitting slots, each association is corrected, and rebuilding excludes the old result in each slot. Transactional fan-out and duplicate-command recovery still require prototype checks. |
| Gate horizon and standing | **No regression found.** :615-620/:672-699/:819 retain outstanding-first pending, contiguous completion, expiry and frozen exceptions. A late batch re-asks signoff while only a signoff decision writes run lifecycle. |
| Earlier repaired inputs and slice scope | **No regression found.** The normalized Suggestion and ObligationIn inputs, charter-bearing report, agreeing exact provenance, predecessor-aware supersession and named Preview signoff override remain present. The stack is still undecided. |

### Editorial note

`ResultIn` at :528 still names `slot?: RunId`, whereas stored slots now have SlotId. The stated type can mean a run selector used together with the case to find its pin. The manual example at :387-389 supplies run plus case and does not pass a stored slot ID. No line requires this input to take SlotId, so this is **not a demonstrated type contradiction or blocker**. Renaming the input to `run`, or documenting its normalization, would prevent confusion with the new stored identity. The prototype should reject conflicting provenance and avoid accidentally treating this RunId as SlotId.

### Prototype work and review limits

The small-map claim at :610 is unmeasured. It is not a bound, and correctness must never cap actors or fall back to recent. Measure actor cardinality, fold/rebuild work and correction fan-out against the ingest and execution budgets.

Still unimplemented: full qualifies branches and policy predicates, Review projection/rebuild behavior after the documentation source is corrected, transactional membership consistency (`SlotResult.run` equals its referenced Slot.run), decision effects including dispute resolution and waiver, helper/revert/dependency maintenance, persisted horizon recovery, clean-run cohorts, complete query plans and measured budgets. These are **not checked** as runtime properties. They are not additional blockers unless the written contracts conflict; R5-1 does.

## 4. Exact documentation counterexample outputs

I ran a fixed-data Python transcription. For the admission fixture, target, case version, declared method and linked binding already match; only exact versus assumed admission differs between the two obligations. Exercise state uses sets of actors with positive pass/fail counts. Rebuild selects uncorrected membership rows and reads their immutable Result facts. The recent array does not participate. The review counterexample uses the documented ResultId/ReviewId distinction and separate matching-basis/lens/independence rule.

Command run: `python /tmp/mainworthy-arena/verify-r5-counterexamples.py`. Exit 0. Exact stdout:

```text
SLOT_MEMBERSHIP assumed_qualification {"S-exact": false, "S-loose": true}
SLOT_MEMBERSHIP assumed_rows [{"admitted": "assumed", "corrected": false, "result": "E1", "run": "R1", "slot": "S-loose"}]
SLOT_MEMBERSHIP read_by_slot {"S-exact": [], "S-loose": ["E1"]}
SLOT_KEY two_qualifying_slots {"immutable_results": 1, "rows": [{"admitted": "exact", "corrected": false, "result": "E2", "run": "R1", "slot": "S-loose"}, {"admitted": "exact", "corrected": false, "result": "E2", "run": "R1", "slot": "S-exact"}], "slots": 2, "unique_declared_keys": 2}
CORRECTION reverse_result_key {"all_old_memberships_corrected": true, "result": "E2", "revisited_slots": ["S-exact", "S-loose"]}
AGG same_actor {"agg": {"A": {"failsUncorrected": 1, "latest": 17, "passes": 16}}, "effective_results": 17, "state": "failing"}
AGG different_actor {"agg": {"A": {"failsUncorrected": 0, "latest": 17, "passes": 16}, "B": {"failsUncorrected": 1, "latest": 1, "passes": 0}}, "effective_results": 17, "state": "disputed"}
AGG comparison {"different_required_state": true, "equal_agg": false, "equal_recent": true, "rebuild_independent_of_order": true}
RECENT presentation_only {"different_actor_states": ["disputed", "disputed"], "recent_lengths": [16, 0], "same_actor_states": ["failing", "failing"]}
AGG correction_rebuild {"agg": {"A": {"failsUncorrected": 0, "latest": 17, "passes": 16}}, "effective_results": 16, "state": "satisfied"}
AGG minActors {"one_actor_min2": "missing", "two_actors_min2": "satisfied"}
REVIEW_REBUILD {"admitted_review": "RV1", "agg_from_declared_SlotResult_source": {}, "findings": 0, "independent_reviewer": true, "legal_SlotResult_rows": [], "matching_basis": true, "matching_lens": true, "obligation_kind": "review", "rebuilt_state_without_review": "missing", "required_state_with_qualifying_review": "satisfied", "slot": "S-review"}
```

The two requested attacks now pass. The additional review fixture exposes R5-1. These outputs prove properties of the transcribed documentation, not a running service.

## 5. Mechanical checks and exact outputs

Command run: `python /tmp/mainworthy-arena/verify-r5-checks.py`. Exit 0. The checker reads committed bytes with `git show c93e993:<path>`, enumerates all changed/added paths with `git diff --name-only --diff-filter=ACMR a78b0ad..c93e993`, and compares working bytes for each path.

The local link scan covers all 31 changed/added Markdown files. It checks inline/reference destinations outside fenced/inline code and validates local paths and heading/explicit anchors. It skips image syntax and external URL resolution; it does not treat plain/backtick paths as clickable links. The nine absolute links resolve on this machine and are explicitly historical/nonportable in the arena README. No external availability claim is made.

Operation count comes from op declarations in section 7.1; tool count comes from its mcp markers, including multiline decide. Question numbers are compared with exactly 1 through 28. `git diff --check a78b0ad..c93e993` is run directly and through the checker.

The bounded secret scan checks all 31 committed files for private-key headers, GitHub token formats, AWS access-key formats, OpenAI-style keys and credential-bearing HTTP(S) URLs. It prints locations rather than values. Zero matches is a pass for these patterns, not proof against unknown/encoded formats.

Exact stdout:

```text
HEAD c93e9933c27a4878b1b81fe32010f62a7af261e0
REVIEWED_COMMIT c93e9933c27a4878b1b81fe32010f62a7af261e0
CHANGED_FILES 31
REVISION_MATCH CHANGELOG.md True
REVISION_MATCH README.md True
REVISION_MATCH docs/decisions/0001-stack-open.md True
REVISION_MATCH docs/decisions/0003-scope-software-qa-and-process-spectrum.md True
REVISION_MATCH docs/decisions/0006-agent-token-efficiency.md True
REVISION_MATCH docs/decisions/0007-guiding-principles.md True
REVISION_MATCH docs/decisions/0008-one-evidence-model.md True
REVISION_MATCH docs/design-arena/2026-10-11/README.md True
REVISION_MATCH docs/design-arena/2026-10-11/brief.md True
REVISION_MATCH docs/design-arena/2026-10-11/candidates/a/design.md True
REVISION_MATCH docs/design-arena/2026-10-11/candidates/a/rationale.md True
REVISION_MATCH docs/design-arena/2026-10-11/candidates/a/seed.md True
REVISION_MATCH docs/design-arena/2026-10-11/candidates/b/design.md True
REVISION_MATCH docs/design-arena/2026-10-11/candidates/b/rationale.md True
REVISION_MATCH docs/design-arena/2026-10-11/candidates/b/seed.md True
REVISION_MATCH docs/design-arena/2026-10-11/candidates/c/design.md True
REVISION_MATCH docs/design-arena/2026-10-11/candidates/c/rationale.md True
REVISION_MATCH docs/design-arena/2026-10-11/candidates/c/seed.md True
REVISION_MATCH docs/design-arena/2026-10-11/candidates/d/design.md True
REVISION_MATCH docs/design-arena/2026-10-11/candidates/d/rationale.md True
REVISION_MATCH docs/design-arena/2026-10-11/candidates/d/seed.md True
REVISION_MATCH docs/design-arena/2026-10-11/judge.md True
REVISION_MATCH docs/design-arena/2026-10-11/rubric.md True
REVISION_MATCH docs/design-arena/2026-10-11/verify-r1.md True
REVISION_MATCH docs/design-arena/2026-10-11/verify-r2.md True
REVISION_MATCH docs/design-arena/2026-10-11/verify-r3.md True
REVISION_MATCH docs/design-arena/2026-10-11/verify-r4.md True
REVISION_MATCH docs/open-questions.md True
REVISION_MATCH docs/product-design.md True
REVISION_MATCH docs/product-vision.md True
REVISION_MATCH docs/roadmap.md True
ALL_CHANGED_FILES_MATCH True
MARKDOWN_FILES 31
LINK_SCAN_DONE CHECKED 47 BROKEN 0
REFERENCE_LINKS_USED 0
ABSOLUTE_LOCAL_LINKS 9
ABSOLUTE_LINK docs/design-arena/2026-10-11/candidates/a/design.md:15 docs/competitive-analysis.md#cross-cutting-findings
ABSOLUTE_LINK docs/design-arena/2026-10-11/candidates/a/design.md:16 docs/competitive-analysis.md#competitors
ABSOLUTE_LINK docs/design-arena/2026-10-11/candidates/a/design.md:17 docs/competitive-analysis.md#cross-cutting-findings
ABSOLUTE_LINK docs/design-arena/2026-10-11/candidates/a/design.md:18 docs/competitive-analysis.md#what-is-not-checked
ABSOLUTE_LINK docs/design-arena/2026-10-11/candidates/a/design.md:19 docs/competitive-analysis.md#testrail
ABSOLUTE_LINK docs/design-arena/2026-10-11/candidates/a/design.md:20 docs/competitive-analysis.md#landscape
ABSOLUTE_LINK docs/design-arena/2026-10-11/candidates/b/design.md:13 docs/competitive-analysis.md
ABSOLUTE_LINK docs/design-arena/2026-10-11/candidates/b/design.md:16 docs/product-vision.md
ABSOLUTE_LINK docs/design-arena/2026-10-11/candidates/b/design.md:16 docs/ux/flows.md
OPS 18 ['propose', 'report', 'claim', 'announce', 'attach', 'plan', 'decide', 'inbox', 'get', 'find', 'impact', 'since', 'history', 'gate', 'trace', 'check', 'admin', 'transfer']
MCP_TOOLS 10
QUESTIONS [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28] CONTIGUOUS True
SECRET_PATTERN_SCAN_DONE FILES 31 MATCHES 0
DIFF_CHECK_EXIT 0
DIFF_CHECK_STDOUT ''
DIFF_CHECK_STDERR ''
STATUS ''
```

Each requested mechanical check is **pass**: committed-byte equality, local links/anchors, 18 operations, 10 MCP tools, contiguous questions 1 through 28, whitespace and the bounded secret scan. Direct `git diff --check a78b0ad..c93e993` also exits 0 with no stdout or stderr.

## 6. Final disposition

**Issues on c93e993.** R4-1 and R4-2 are resolved. The sole blocker is **R5-1**, the unconditional aggregate-rebuild instruction that cannot preserve Review-only evidence. The ResultIn selector naming is an editorial note. The remaining implementation and measurement obligations are prototype work, with no runtime approval implied.

The full report is saved to `/tmp/mainworthy-arena/verify-r5.md`. No repository file, commit, branch, pull request or remote was changed. No service was started. Temporary checker files were removed after their exact outputs were copied into this report. Reviewed commit c93e993 remains in the existing checkout; this review creates or lands no commit.

Final read-only checks:

```text
FINAL_HEAD c93e9933c27a4878b1b81fe32010f62a7af261e0
FINAL_ALL_31_FILES_MATCH True
FINAL_STATUS ''
FINAL_DU 796K	.
```
