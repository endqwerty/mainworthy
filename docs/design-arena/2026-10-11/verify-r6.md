# Verification report, round 6

Verdict: **pass on b8ec413f3ad46d9e5deb86cbd623b322f90f8397** for this documentation change.

Whole change reviewed: `a78b0ad..b8ec413`. Round 5 fix reviewed: `git diff c93e993..b8ec413`. Reviewer: Codex, GPT 6.1 Sol. The synthesis names Claude Fable 5.1 as its author, so this review is independent of that provider. No author's reasons or fix scripts were supplied or used.

R5-1 is resolved. The round 5 ResultIn selector naming note is resolved. Neither is regressed. All requested mechanical checks pass. No blocking contradiction was found on this revision. One optional wording nit and the unimplemented prototype checks are separate below.

The safety fact for this fix is that a slot's durable membership identifies its particular obligation and the evidence kind it admits. Rebuilding from that membership must preserve a qualifying zero-finding review, without manufacturing execution evidence or losing actor disagreement. The documented union and qualification branches now support that fact. The fixed-data checks below exercise those written contracts; they are not tests of a Mainworthy implementation.

I inspected the actual fix diff, the current design and decision records, the earlier findings and their dispositions, and the surrounding usage, operation inputs, projection ownership and release contracts. Mechanical scans cover all 32 changed or added Markdown files, including the historical arena material and the newly archived round 5 report. Their working bytes match b8ec413. Historical candidates are nonnormative. This round does not refresh competitor claims or re-rank the candidates.

All line references below are at b8ec413. Runtime correctness, persistence, concurrency, latency, token budgets, backup/restore and deployment are **not checked**, because this change contains no implementation.

## 1. Round 5 findings

### R5-1 is resolved

The deciding lines in `docs/product-design.md` section 6.4 now agree about the source and the fold.

At :661-662, SlotResult admits both typed evidence IDs:

```ts
type SlotResult = { slot: SlotId; run: RunId; evidence: { t: 'result'; id: ResultId } | { t: 'review'; id: ReviewId }
                    admitted: Fill['admitted']; corrected: boolean }
```

At :663-667, its admission comment says:

> "Two branches, never mixed: an exercise slot admits results through `qualifies`"
>
> "a review slot admits a Review row whose case, basis and lens match the slot's pinned version and obligation and whose reviewer is not the version's author when `independent` is set."
>
> "A result never produces a review-slot row and a review never produces an exercise-slot row."

The Slot aggregate comment at :610-612 gives the rebuild rule explicitly:

> "Actors per slot are few (unmeasured; never capped, never read from `recent`)."
>
> "agg is rebuilt from the slot's SlotResult rows: for an exercise slot from the admitted results' actors and outcomes; for a review slot each admitted Review row counts as that reviewer's pass, so one row satisfies it."

Fill at :613 uses the same evidence union and permits review presentation values:

```ts
type Fill = { evidence: SlotResult['evidence']; by: ActorId; method: MethodKind | 'review'; outcome; basis: Basis['b'] | 'review'; admitted: 'exact' | 'assumed' | 'same-claim' | 'review' | null }
```

The review-obligation paragraph at :675-679 supplies the durable write paths:

> "A review obligation is filled only by a `Review` row at the slot's basis (and, if `independent`, by an actor other than the version's author), recorded as a review-branch `SlotResult` row when `claim` writes the review or when `plan` finds one."
>
> "It is never filled by a result, and a result never fills a review obligation."

Review remains a separate fact in section 6.3 at :561-565:

```ts
type Review = { id: ReviewId; reviewer: ActorId; lens; case: CaseId; basis: Hash; seq: Seq }
```

Its comment says the server computes the basis from the version hash and relevant patch tree/charter hash, and that "a zero-finding review writes this row".

In the requested counterexample, S-review is an independent security-review obligation for C1. A authored the pinned version. B records RV1 at the matching case, basis and lens with zero findings. The revised source legally stores `(S-review, { t: 'review', id: 'RV1' })`, admitted as review. Rebuilding reads RV1, counts B once, and produces `satisfied`. It needs neither a Result row nor a recent-array entry. The old ResultId-only source produces an empty aggregate and `missing` on the same fixture, reproducing round 5's failure before checking the repair.

The negative fixtures reject A's self-review, a different basis, a different lens and a different case. Review evidence cannot create an exercise membership; runtime result evidence cannot create a review membership. R5-1 is not still open or regressed.

### The ResultIn naming note is resolved

Section 6.3 at :528 now says:

```ts
type ResultIn = { test: TestKey | { case: CaseId; run?: RunId /* the run whose pinned slot this manual result is for; never a SlotId */ }; outcome; attempt?; durationMs?; failure?: { message; at? }
```

The former `slot?: RunId` selector is now `run?: RunId`, with an explicit distinction from SlotId. The manual example at :387-389 still supplies run plus case, and acceptResult at :531-534 receives the resolved Slot and rejects conflicting provenance. Result.run at :549 remains the entry location; SlotResult owns admitted membership. The editorial ambiguity is removed. Actual input normalization and rejection behavior remain prototype checks.

## 2. Cross-contract checks

| Relationship | Result on b8ec413 |
| --- | --- |
| Evidence union, claim and plan | **Pass at the documented contract level.** :669-672 names runs.fold as the sole membership writer, invoked at ingest and claim, at plan for prior results/reviews, and for late closed-run batches. :677-678 describes claim writing the Review fact and plan discovering an existing one. This does not add competing writers of SlotResult. The operations at :852/:856 already expose claim and plan. No new operation is required. |
| Fill and the aggregate rebuild | **Pass.** Fill.evidence uses SlotResult's tagged union; its method, basis and admitted fields now represent review presentation. The rebuild reads uncorrected durable membership at :671-672. Slot.recent remains bounded presentation at :605 and explicitly cannot supply the aggregate at :610-611. |
| Decision 0008 item 3 | **Pass.** :34-43 requires distinct exercise/review obligations, obligation-specific result admission, review-only review admission, and complete per-actor evidence folding. The two branches preserve those restrictions. The review branch adds the previously missing durable source without loosening result qualification. |
| Decision 0008 item 5 and runtime-pass separation | **Pass.** :62-65 says review evidence is accepted only by review obligations and records zero-finding reviews. The phrase "reviewer's pass" at design :612 is a count inside a review slot's aggregate. It creates no Result, no runtime outcome, and no exercise membership; :667 and :675-679 explicitly forbid that crossover. Sharing an internal count field does not make a Review a runtime pass. |
| Unique membership and correction reverse lookup | **Pass at the key-contract level.** :668 declares `KEY (slot, evidence) unique` and `KEY (evidence)` for every slot a correction revisits. The tag and ID together identify evidence. A Result correction therefore looks up `{ t: 'result', id: oldResultId }`, reaches every admitting slot, and cannot match a review with the same textual ID. Each slot rebuild excludes its corrected association. Result.corrects at :546/:549 remains ResultId-only; widening the membership source does not introduce a review-correction operation. |
| Earlier obligation-specific membership repair | **Pass; no regression found.** Slot.id and Slot.obligation remain at :601-602. One exact result admitted to two obligations has two distinct `(slot, evidence)` keys and one immutable Result. An assumed result admitted only to the permissive obligation leaves the exact slot empty. |
| Earlier actor-disagreement repair | **Pass; no regression found.** Slot.agg remains per actor at :604. :647-656 retains complete evidence, corrected-row exclusion and the different-actor dispute rule. The 17-result histories still have equal recent samples but distinct aggregates and states. Correction rebuild and the two-actor exercise requirement still behave as specified. |
| Surrounding horizon, standing and slice contracts | **No new contradiction found.** Outstanding-first pending, contiguous applied watermark, expiry/frozen exceptions and decision-only closure remain in :617-622/:681-708 and 0008 item 4. Section 7.2 retains agreeing-provenance rejection rules and predecessor-aware supersession. Section 9 retains the named Preview signoff override, first-usable prerequisites, and E1/E7's exclusion of review evidence from exercise slots. This fix does not change those contracts. |

The key check also deliberately uses ResultId `E1` and ReviewId `E1`. The reverse lookup corrects both exercise associations and leaves the review association effective. This checks the full evidence key, rather than assuming that untagged ID text is globally unique.

## 3. Exact counterexample outputs

Command run: `python /tmp/mainworthy-arena/verify-r6-counterexamples.py`. Exit 0. Exact stdout:

```text
REVIEW_OLD_SOURCE {"agg": {}, "legal_ResultId_only_rows": [], "state": "missing"}
REVIEW_REBUILD {"SlotResult_rows": [{"admitted": "review", "corrected": false, "evidence": {"id": "RV1", "t": "review"}, "run": "R1", "slot": "S-review"}], "agg": {"B": {"failsUncorrected": 0, "latest": 1, "passes": 1}}, "author": "A", "case": "C1", "findings": 0, "independent_reviewer": true, "matching_basis": true, "matching_lens": true, "reviewer": "B", "slot": "S-review", "state": "satisfied"}
REVIEW_WRITERS {"claim": "satisfied", "plan_prior_review": "satisfied", "rebuild_with_empty_recent": "satisfied", "same_membership": true}
REVIEW_REJECTIONS {"author_review": {"rows": 0, "state": "missing"}, "wrong_basis": {"rows": 0, "state": "missing"}, "wrong_case": {"rows": 0, "state": "missing"}, "wrong_lens": {"rows": 0, "state": "missing"}}
BRANCH_SEPARATION {"result_in_exercise_rows": 1, "result_in_review_rows": [], "review_in_exercise_rows": [], "review_in_review_rows": 1}
SLOT_MEMBERSHIP_ASSUMED {"S-exact": 0, "S-loose": 1}
SLOT_KEY {"immutable_results": 1, "rows": 2, "slots": ["S-exact", "S-loose"], "unique_slot_evidence_keys": 2}
CORRECTION_REVERSE_EVIDENCE_KEY {"all_result_rows_corrected": true, "colliding_review_row_corrected": false, "exercise_states_after_rebuild": ["missing", "missing"], "lookup": {"id": "E1", "t": "result"}, "review_state_after_rebuild": "satisfied", "revisited_slots": ["S-exact", "S-loose"]}
AGG_SAME_ACTOR {"agg": {"A": {"failsUncorrected": 1, "latest": 17, "passes": 16}}, "state": "failing"}
AGG_DIFFERENT_ACTOR {"agg": {"A": {"failsUncorrected": 0, "latest": 17, "passes": 16}, "B": {"failsUncorrected": 1, "latest": 1, "passes": 0}}, "state": "disputed"}
AGG_COMPARISON {"equal_agg": false, "equal_recent": true, "rebuild_independent_of_order": true, "recent_not_read": true}
AGG_CORRECTION_REBUILD {"agg": {"A": {"failsUncorrected": 0, "latest": 17, "passes": 16}}, "state": "satisfied"}
AGG_MIN_ACTORS {"one_actor_min2": "missing", "two_actors_min2": "satisfied"}
COUNTEREXAMPLE_ASSERTIONS PASS
```

This is an independent Python transcription of the written membership and rebuild rules with fixed fixtures. Both exercise fixtures already match the target, pinned version and declared human method; the permissive/exact fixture varies only basis policy. The review fixtures supply an already computed immutable review basis and vary case, lens and independence separately. Claim and plan are modeled as the two documented times when runs.fold admits the same existing Review fact. They are not executed operations. The recent array is never a rebuild input.

## 4. Mechanical checks and exact outputs

Command run: `python /tmp/mainworthy-arena/verify-r6-checks.py`. Exit 0. The checker enumerates `git diff --name-only --diff-filter=ACMR a78b0ad..b8ec413` and reads each reviewed file with `git show b8ec413:<path>`. All 32 changed/added files are Markdown and match the committed bytes.

The local link scan covers all those Markdown files. It checks inline and reference destinations outside fenced and inline code, including local heading/explicit anchors. It finds 47 local destinations and no broken path or anchor. Reference-link uses are zero. It skips image syntax and external URL resolution. The nine absolute local links resolve on this machine; the arena README explicitly describes them as historical and nonportable. This is not a claim of GitHub portability or external availability.

Operation count comes from declarations in section 7.1; MCP count comes from its `// mcp` markers, including multiline decide. The questions are compared with exactly 1 through 28.

The bounded secret scan checks committed bytes for private-key headers, GitHub token formats, AWS access-key formats, OpenAI-style keys and credential-bearing HTTP(S) URLs. It prints locations, never matched values. Zero matches establishes only that these patterns were absent; it does not prove absence of unknown or encoded secret formats.

Exact stdout:

```text
HEAD b8ec413f3ad46d9e5deb86cbd623b322f90f8397
REVIEWED_COMMIT b8ec413f3ad46d9e5deb86cbd623b322f90f8397
CHANGED_FILES 32
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
REVISION_MATCH docs/design-arena/2026-10-11/verify-r5.md True
REVISION_MATCH docs/open-questions.md True
REVISION_MATCH docs/product-design.md True
REVISION_MATCH docs/product-vision.md True
REVISION_MATCH docs/roadmap.md True
ALL_CHANGED_FILES_MATCH True
MARKDOWN_FILES 32
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
SECRET_PATTERN_SCAN_DONE FILES 32 MATCHES 0
DIFF_CHECK_EXIT 0
DIFF_CHECK_STDOUT ''
DIFF_CHECK_STDERR ''
STATUS ''
```

The direct command `git diff --check a78b0ad..b8ec413` was also run separately. Exact result:

```text
EXIT 0
STDOUT ''
STDERR ''
```

Every requested mechanical check is **pass**: committed-byte equality, local links/anchors, 18 operations, 10 MCP tools, contiguous questions 1 through 28, whitespace and the bounded secret scan.

## 5. Blocking issues, editorial nits and prototype work

**Blocking issues: none found on b8ec413.** No unresolved round 5 blocker remains, and no new contradiction was found that would mislead an implementer or break decision 0008 items 3 or 5.

One optional editorial nit remains. The opening SlotResult comment at :659 says "between slots and the results that qualify for them", while the table now also stores Review evidence. "Evidence" would describe both branches more precisely. The type and the following comments make both branches explicit, so this wording does not obscure the storage or admission contract and does not block the verdict. The ResultIn naming note is resolved, not carried forward as a nit.

Prototype work remains **not checked**. It includes executable qualification and policy predicates; server review-basis derivation and immutable patch validation; transactionally admitting reviews on claim and reusing them on plan; enforcing tagged keys and `SlotResult.run === Slot.run`; idempotency and correction fan-out/recovery; branch-specific Fill projection; actor cardinality and aggregate rebuild cost; decision revert/dependency maintenance; persisted horizon recovery; clean-run cohorts; query plans; and measured latency/token budgets. The new comment explicitly marks actor cardinality unmeasured and forbids capping actors. These are implementation and measurement obligations, not further documentation blockers.

## 6. Final disposition

**Pass on b8ec413f3ad46d9e5deb86cbd623b322f90f8397 for the documentation change.** R5-1 and the ResultIn editorial note are resolved. The requested review counterexample and all mechanical checks pass. Exercise-slot membership, actor disagreement and correction lookup retain their stated behavior. This verdict provides no runtime or deployment approval.

The full report is saved to `/tmp/mainworthy-arena/verify-r6.md`. No repository file, commit, branch, pull request or remote was changed. No service was started. This review creates or lands no commit; b8ec413 remains in the existing checkout. Temporary checker scripts are removed after their outputs are captured in this report.

Final read-only checks:

```text
FINAL_HEAD b8ec413f3ad46d9e5deb86cbd623b322f90f8397
FINAL_ALL_32_FILES_MATCH True
FINAL_STATUS ''
FINAL_DU 820K	.
```
