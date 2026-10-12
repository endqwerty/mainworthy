# Verification report, round 4

Verdict: **issues on 0dc917095c0f8d322aff4e08767903d6f76a6b69**.

Whole change reviewed: `a78b0ad..0dc9170`. Fix range reviewed: `4d29392..0dc9170`, with the round 4 fixes inspected through `git diff fd6188e..0dc9170`. Reviewer: Codex, GPT 6.1 Sol. The synthesis names Claude Fable 5.1 as its author. This is a read-only independent documentation review, not implementation approval.

R3-1, R3-2, R3-3, R3-4, R3-5 and R3-7 are resolved. R3-6 is repaired across runs but remains open for obligation-specific slot membership, reported below as R4-1. R4-2 identifies a pre-existing contradiction in the aggregate's claimed ability to derive slot state. All requested mechanical checks pass. The round 3 editorial corrections are resolved; implementation limits remain separately listed.

The safety fact is that a gate counts evidence only for its admitted obligation, immutable basis and target, preserves the complete effective conflicting evidence, and waits for every matching accepted batch and current decision. The two blocking findings still leave instructions that can mislead an implementer about that fact.

I read the earlier reports, the current design, the changed decision records, vision, roadmap, questions, index and changelog, and the archived review context. I ran the checks myself. All 30 changed or added Markdown files match the requested commit. I did not read the author's fix scripts or reasons. No repository file was changed.

All line references below identify `0dc9170`. Runtime correctness, persistence, latency, token budgets, backup, restore and deployment are **not checked** because this change contains no implementation. Small Python transcriptions below exercise stated documentation rules; they are not tests of a Casebook binary.

## 1. Disposition of R3-1 through R3-7

### R3-1: resolved

`docs/product-design.md:669-675` now prescribes:

> "sets `applied` to the highest Seq such that every matching batch at or below it is processed, advancing past already-processed higher batches when a hole closes"
>
> "when `outstanding` is 0, `applied` equals `accepted`"

The gate-read trace at :811 now says:

> "the read applies the rules of 6.4 (`outstanding > 0` or `nextExpiry` passed → `pending`, frozen → the frozen verdict plus flags)"

The pure verdict at :613 says:

> `if (h.outstanding > 0 || expired) return 'pending'`

Processing B=11 before A=10 now leaves applied=9 while A is outstanding, then advances to 11 when A closes the hole. Both gate descriptions agree. Decision 0008:54-56 retains contiguous processing and pending while anything is outstanding. E5 at :1064-1068 still explicitly covers either processing order and a decision between batches. The normal order also gives applied=11 after both are processed.

### R3-2: resolved at the documented algorithm level

`product-design.md:897` passes the predecessor question ID when it opens a new epoch:

> `return open(tx, r, fp, q.epoch + 1, q.id)`

`settle` at :922-930 now says:

> "the decision this one replaces: a re-decide of the same question, or the effective decision of the predecessor epoch when this question was re-asked"
>
> `const prior = q.state.s === 'decided' ? tx.decisions.get(q.state.decision)`
>
> `: q.prior ? effectiveDecision(tx, q.prior) : null`
>
> `if (prior) KINDS[q.kind].revert(tx, witness(prior), q)`
>
> "reverses the prior's standing effects; the prior row itself is never edited"
>
> `holds: KINDS[q.kind].holds(a, q), supersedes: prior?.id ?? null`

An open Q1 with prior Q0 no longer loses D0 merely because Q1 is open. The new row names D0 as superseded, reverses its standing effects, and applies D1 through a decision witness. This agrees with :677-685 and 0008:57-59: a late upload invalidates the gate and re-asks signoff while the run remains closed until the next decision. Frozen runs preserve their verdict.

`effectiveDecision`, per-kind `revert`, and the dependency replacement performed by the run fold remain prototype work. Their required meaning is now explicit enough to avoid the earlier null-supersession branch: the predecessor's standing decision must remain available for historical supersession even when its hold has ended. The prototype must demonstrate that D0's dependency entries are replaced by D1's and that expired effects are not reversed twice. These are implementation checks, not an additional contradictory branch in this revision.

### R3-3: resolved

The partial suggestion now has an explicit normalization rule. `product-design.md:557-560` says:

> `type Suggestion = { step?: StepId; action?: Text; expected?: Text } | { case: { title; folder: FolderId; steps: string[] } }`
>
> "step defaults to the step named by the finding's locus (`on: "C-311#s2"`); a step suggestion with no step anywhere is rejected"
>
> "normalises it into an `Edit` on a sealed ... proposal authored by the finder"

This makes the expected-only suggestion at :301-303 valid and leaves a missing step/locus invalid.

The planning input at :839-841 now says:

> `op plan ({ name; select: Selection | SetId; accepts?; require?: ObligationIn[] | GateId; assign? })`
>
> "ObligationIn = Obligation with `id` server-assigned and these defaults from the project policy when omitted"
>
> "bindings 'any', charters 'any', target 'exact', minActors 1, basis the policy's default ('exact-or-assumed' in loose and standard, 'exact' in regulated)"

The exercise and jobs inputs at :366-367 can therefore omit their IDs; the exercise can omit bindings, charters and target. Stored `Run.require` remains `Obligation[]` at :577, and the canonical type at :591-598 still requires those stored values. The shorthand input and complete stored type are distinct, compatible contracts.

### R3-4: resolved

`product-design.md:833-834` now exposes:

> `op report ({ target? | run?; job?; attempt?; method?; charter?: CharterId; manifest?; raw?: BlobRef; results: ResultIn[] })`
>
> "an agent reporting method 'agent' must name the charter document it ran under"

The adversarial-testing example at :327-331 says:

> "the same `impact` digest is the brief"
>
> "the agent runs under a charter document (`h_checkout`, a `charter` edit in the suite)"
>
> `report({ run, method: 'agent', charter: 'h_checkout', results })`

This fits the suite charter edit at :481, Batch validation at :522 and Result's copied charter at :541. Qualification at :638-641 still requires an allowed charter, and under `charters: 'any'` it must be one declared by the case. An absent charter rejects agent-method Batch validation; an unrelated charter does not qualify under `any`; a declared, admitted charter can qualify. The field is batch-wide, consistent with the existing Batch and Result types. It need not also appear in each ResultIn.

### R3-5: resolved

`docs/open-questions.md:17`, question 12, now says:

> "the loose and standard presets release after 20 clean trunk runs by rule, regulated by a lead"

`product-design.md:786` says:

> `| flaky (exit) | rule: release | rule: release | role lead | nothing |`

The release authority now agrees across the two documents. The standard entry remains a member decision at :785; rule-driven exit does not turn quarantine entry into automatic approval. Detailed clean-run cohorts and any configurable duration still require prototype policy clauses.

### R3-6: still open in part

The single-Result.run ownership problem is repaired. `product-design.md:549` now says:

> "`run` is only where a result was typed; slot membership is `SlotResult` (6.4)"

The complete-set rule at :647-649 says:

> "reads the slot's complete effective result set from `SlotResult` ... minus corrected rows; `agg` is its lossless summary and `recent` is presentation only"

The new association at :652-657 says:

> "One immutable Result may qualify for several runs"
>
> `type SlotResult = { run: RunId; case: CaseId; result: ResultId; admitted: Fill['admitted']; corrected: boolean }`
>
> `// KEY (run, case, result) unique · KEY (result) → every slot a correction must revisit`
>
> "at `plan` for prior results on matching targets ... and on a late batch to a closed run"

This supports one CI result filling a change run and two planned runs, including the 171 reused results in section 5.4 and correction fan-out without duplicating the immutable fact.

However, the declared slot/result key omits `Slot.obligation`, despite :602 identifying the exercise or review obligation each slot serves. It cannot distinguish two exercise slots for the same run/case with different admission rules. R3-6 explicitly asked for the appropriate obligation key. See blocking R4-1. The complete-set retention rule also exposes the aggregate-state contradiction described separately in R4-2.

### R3-7: resolved

C5 at `product-design.md:115` now says:

> "Accepting an upload turns a green gate pending before any processing"
>
> "the adapter parses, the operation stages the normalised results durably and marks matching runs outstanding in that acceptance transaction"

The trace at :806 says:

> "the adapter parses first; accept ... stage the normalised results durably ... `outstanding++` ... process in one transaction"

Section 7.1 at :824-826 says:

> "Durable acceptance is the staging of the normalised results under the batch key, so parsing never sits between acceptance and the gate horizon."

These agree with section 6.4:664-675 and 0008:51-56/:106-109. The C5 fixture now reads the gate after durable acceptance and before processing completes. It does not promise pending during parsing of a file that has not yet been accepted.

## 2. Disposition of every round 3 editorial note

1. **Whitespace failure: resolved.** The archived `verify-r1.md:437` ends with "Only `/tmp/casebook-arena/verify-r1.md` was written. No repository files were changed." The surplus blank line is gone. `git diff --check a78b0ad..0dc9170` exits 0 with empty stdout and stderr. The scratch r1 report differs from the archive only by trailing newline bytes; removing the reported excess blank line is the intended change.

2. **Leftover run terminology: resolved.** The deciding replacements in product-design are "where its obligations allow" at :185, "explicit obligations" at :400, "the obligation admits" at :401, "obligation that opts in" at :516, "the obligation allows" at :626, "obligation names `human`" at :1074, and "distinct obligations on a run" at :1148. Decision 0008 says "run obligation of kind review" at :62 and "an explicit obligation option" at :94. Remaining Requirement/requirement references describe tracker items or explicitly historical material.

3. **No leftover proposal Change contract: resolved, no regression.** This was already a passing observation. The current Proposal at :468 still uses `edits: Edit[]`; `propose` at :832 and the example at :353 use `edits`. `type Change` at :518 remains code/PR metadata. Historical candidates and old report quotations are correctly retained as historical.

4. **Arena README path description: resolved.** Its :20-22 now says "Absolute paths inside the candidate files and reports are machine-local ... and are not portable; they are historical, not normative references." It no longer claims all nine worktree links are absent. All nine resolve locally in this checkout; they remain nonportable on GitHub or another machine.

5. **Arena contents and scores: resolved, no regression.** This was also an earlier passing observation. README :15-16 now names "`verify-r1.md`, `verify-r2.md`, `verify-r3.md`, ..." and "each naming the revision it judged". The r3 archive is present and equals its scratch source. The scores at README :9-12 remain 27, 25, 16 and 14; product-design :1119 says "A 27, B 25, C 16, D 14 out of 30 and recommended A as base." Their component sums pass independently. Every candidate design/rationale/seed and the judge/brief/rubric equals its scratch source. R1's intentional trailing-newline cleanup is the sole byte difference among the archived reports.

6. **Preview fixture scope: resolved.** E6 at product-design :1068-1071 now says "a fragment edit through the operation layer, no UI in this slice". The deferred scope at :1083-1084 says "fragments and custom fields (types present, no UI)", and :1220 calls the deferred experience "authoring". Together these specify an operation-layer fixture while fragment authoring UI remains deferred. The phase-1 next step at :1259 now requires "a rule-only `signoff` stub so E5's supersession can run". It no longer lists E5 without identifying its signoff dependency.

7. **Stale late-reopening label: resolved.** The next-step fixture list at :1260-1262 now says "inverse-order horizon, agreeing provenance and late-upload signoff supersession cases". It agrees with :677's "A late batch does not reopen a closed run".

8. **Prototype and provenance review limits: still open, nonblocking implementation work.** Decision 0008:4-5 still says "mechanisms to be proven in the phase 1 prototype". Product-design :749 still uses `Predicate /* closed vocabulary */`; :751 says "First matching clause wins"; :956 still labels the pure bodies "not implemented". Executable clause precedence, predicate enumeration, reverse-key/query proofs, immutable patch validation, clean-run cohorts and complete dependency maintenance must be implemented and tested there. The competitor table still labels its provenance at :44-46 and its hypotheses in the rows. This review does not refresh vendor facts or claim runtime passes. The explicit contradictory slot contracts in R4-1 and R4-2 are different from these acknowledged implementation gaps.

## 3. Blocking issues on 0dc9170

### R4-1. SlotResult still cannot identify the obligation-specific slot it claims to associate

This is the remaining part of R3-6, introduced by the new association's key.

The deciding lines are product-design :602:

> `obligation: ObligationId // the exercise or review obligation this slot serves`

and :652-655:

> "The durable many-to-many between slots and the results that qualify for them."
>
> `type SlotResult = { run: RunId; case: CaseId; result: ResultId; admitted: Fill['admitted']; corrected: boolean }`
>
> `// KEY (run, case, result) unique`

`Run.require: Obligation[]` at :577 and `ObligationIn[]` at :839 allow multiple exercise obligations. There is no one-exercise-obligation-per-case restriction.

Counterexample: R1 has two exercise obligations for C1, one allowing `exact-or-assumed`, the other requiring `exact`. An assumed auto pass E1 qualifies only for the first. The prescribed SlotResult row records `(R1, C1, E1, admitted='assumed')`, with no indication of which obligation admitted it. Both slots obtain the same run/case range if they follow the complete-set instruction at :647. Counting that range as each slot's qualifying set wrongly satisfies the exact obligation; discarding it loses the permissive slot's evidence. Similarly, one human result qualifying for both an all-methods slot and a human-only slot collapses two advertised slot associations into one declared unique key.

The pure `qualifies` function can prevent wrong admission if it is called again for each obligation. But the new table explicitly claims to contain qualifying slot associations, and its prescribed complete-set read only subtracts corrected rows. It does not define a shared candidate union that must be requalified per obligation. Those are different storage contracts, and an implementer should not have to choose between them silently.

Include the obligation or a stable SlotId in SlotResult and its slot-range/unique keys, and make the reverse result key return those distinct slots. Alternatively, explicitly define SlotResult as a run/case candidate association and require per-obligation requalification before every aggregate fold and rebuild. Align Slot identity, correction fan-out, plan reuse and the execution/ingest traces with the chosen contract. Preserve one immutable Result.

This breaks 0008 item 3's obligation-specific admission at :34-41. It is not merely an unspecified query optimization.

### R4-2. The stated lossless aggregate cannot derive the required dispute state

This contradiction predates 0dc9170 and is newly identified in the whole-change review. Round 3 proved that the complete-set rule preserves the seventeenth failure; it did not test whether these aggregate fields preserve actor disagreement.

Product-design :604-606 says:

> `agg: { passActors: number; failsUncorrected: number; counted: number; latest: Seq } // lossless`
>
> `recent: Fill[] // bounded (<= 16), presentation only`
>
> `state: 'missing' | 'satisfied' | 'failing' | 'disputed' | 'waived' // derived from agg and the obligation`

But :643-646 requires:

> "a counted fail is failing ... a counted fail beside a counted pass from another actor is disputed"

Use the same obligation and 17 uncorrected counted results. At Seq 1, history A has actor A's fail; history B has actor B's fail. Both histories then contain actor A's 16 passes at Seq 2 through 17.

Both aggregates are exactly `{passActors: 1, failsUncorrected: 1, counted: 17, latest: 17}`. Even their bounded recent arrays are identical. The complete history requires `failing` for history A and `disputed` for history B. No function of the declared aggregate and obligation can return both correct states.

The complete SlotResult/Result set retains the information, so it can be used to derive state safely. Correct the claimed derivation: either derive and store state from the complete effective set during `runs.fold`, treating agg as counts rather than a lossless state source, or extend the aggregate to preserve the actor-conflict information and prove its fold/rebuild semantics. The recent array must remain presentation-only.

This is a concrete contradiction between the declared projection fields and the acceptance rule, not a demand to write the prototype during a docs-only change.

## 4. Cross-contract regression checks

| Requested relationship | Result on 0dc9170 |
| --- | --- |
| SlotResult, Result.run, Slot.agg/recent and 6.6 | **Issues.** Cross-run reuse, plan backfill and correction fan-out are now representable without duplicating Result. Obligation identity remains absent from the new association, and agg cannot determine actor disputes. See R4-1/R4-2. The :805-806 traces describe folds and Fill projections but do not supply an alternative complete membership contract. |
| ObligationIn defaults, presets and stored Obligation | **Pass at the input-contract level.** Server IDs and omitted exercise values normalize into the stored union. Loose/standard assumed-basis defaults and regulated exact are explicit; the preset table governs decision authority and does not state opposite evidence defaults. Methods and kind-specific required fields remain required. Executable policy clauses await the prototype. |
| Charter input, Batch/Result validation and 5.3 | **Pass.** report can now supply the same CharterId that Batch validates, Result copies and qualifies checks. The impact digest is a brief, not an implicit CharterId. |
| settle prior lookup, raise/open and ledger supersedes | **Pass at the algorithm-contract level.** A predecessor epoch is consulted even when the new question is open, historical rows remain immutable, and the new decision names the old one. Concrete helper/revert/dependency behavior is not implemented. |
| Contiguous watermark, verdict() and 0008 item 4 | **Pass.** Both processing orders advance through completed higher batches when the hole closes. Reads use outstanding/expiry with the frozen exception, matching the pure verdict and decision record. |
| C5 and sections 6.4, 6.6, 7.1 and 0008 | **Pass.** Parsing precedes durable normalized acceptance; acceptance updates every matching nonfrozen run's horizon in that transaction; processing follows. |

The prior passing contracts remain present: agreeing explicit provenance stays exact and disagreements reject (:949-953); subject-form decide refuses an existing fingerprint without writes (:844-846); a review never fills an exercise slot (:660-662/:1057-1058); the named Preview standard signoff override ends with the role path (:1042-1045); first usable remains phase 3 with Server, persisted-job, backup/restore and Cloud correctness prerequisites (:1029-1033 and roadmap :102-107). No stack is chosen.

## 5. Exact mechanical outputs

I compared working bytes with `git show 0dc9170:<path>` for all changed/added paths from `git diff --name-only --diff-filter=ACMR a78b0ad..0dc9170`. All 30 are Markdown. The local link scan checks clickable inline and reference Markdown destinations outside fenced examples, plus destination anchors, across all 30 files. It excludes image syntax and external URLs from local resolution. It does not treat backtick/prose paths as links or claim external URL availability.

The bounded secret scan covers private-key headers, GitHub tokens, AWS access keys, OpenAI-style keys and credential-bearing URLs in all 30 committed files. It prints only match locations, never credential values. Zero matches does not prove absence of encoded or unknown secret formats.

Operation names are counted from `op` declarations; MCP tools are counted from `// mcp` markers, including the multiline decide declaration. Question numbering is checked against exactly 1 through 28. Score arithmetic and scratch/archive comparisons were rerun to assess the corresponding editorial notes.

Exact checker stdout:

```text
HEAD 0dc917095c0f8d322aff4e08767903d6f76a6b69
CHANGED_FILES 30
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
REVISION_MATCH docs/open-questions.md True
REVISION_MATCH docs/product-design.md True
REVISION_MATCH docs/product-vision.md True
REVISION_MATCH docs/roadmap.md True
MARKDOWN_FILES 30
LINK_SCAN_DONE CHECKED 47 BROKEN 0
ABSOLUTE_LOCAL_LINKS 9
ABSOLUTE_LINK docs/design-arena/2026-10-11/candidates/a/design.md:15 /home/endqwerty/.t3/worktrees/casebook/t3-7f035a0d/docs/competitive-analysis.md#cross-cutting-findings
ABSOLUTE_LINK docs/design-arena/2026-10-11/candidates/a/design.md:16 /home/endqwerty/.t3/worktrees/casebook/t3-7f035a0d/docs/competitive-analysis.md#competitors
ABSOLUTE_LINK docs/design-arena/2026-10-11/candidates/a/design.md:17 /home/endqwerty/.t3/worktrees/casebook/t3-7f035a0d/docs/competitive-analysis.md#cross-cutting-findings
ABSOLUTE_LINK docs/design-arena/2026-10-11/candidates/a/design.md:18 /home/endqwerty/.t3/worktrees/casebook/t3-7f035a0d/docs/competitive-analysis.md#what-is-not-checked
ABSOLUTE_LINK docs/design-arena/2026-10-11/candidates/a/design.md:19 /home/endqwerty/.t3/worktrees/casebook/t3-7f035a0d/docs/competitive-analysis.md#testrail
ABSOLUTE_LINK docs/design-arena/2026-10-11/candidates/a/design.md:20 /home/endqwerty/.t3/worktrees/casebook/t3-7f035a0d/docs/competitive-analysis.md#landscape
ABSOLUTE_LINK docs/design-arena/2026-10-11/candidates/b/design.md:13 /home/endqwerty/.t3/worktrees/casebook/t3-7f035a0d/docs/competitive-analysis.md
ABSOLUTE_LINK docs/design-arena/2026-10-11/candidates/b/design.md:16 /home/endqwerty/.t3/worktrees/casebook/t3-7f035a0d/docs/product-vision.md
ABSOLUTE_LINK docs/design-arena/2026-10-11/candidates/b/design.md:16 /home/endqwerty/.t3/worktrees/casebook/t3-7f035a0d/docs/ux/flows.md
OPS 18 ['propose', 'report', 'claim', 'announce', 'attach', 'plan', 'decide', 'inbox', 'get', 'find', 'impact', 'since', 'history', 'gate', 'trace', 'check', 'admin', 'transfer']
MCP_TOOLS 10
STATED_OPS ['Eighteen operations.', 'eighteen entries', 'eighteen operations']
QUESTIONS [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28] CONTIGUOUS True
SECRET_PATTERN_SCAN_DONE MATCHES 0
DIFF_CHECK_EXIT 0
DIFF_CHECK_STDOUT ''
DIFF_CHECK_STDERR ''
STATUS ''
JUDGE_SCORE A COMPONENTS [5, 5, 5, 4, 5, 3] SUM 27 TOTAL 27 README 27 MATCH True
JUDGE_SCORE B COMPONENTS [4, 5, 5, 3, 5, 3] SUM 25 TOTAL 25 README 25 MATCH True
JUDGE_SCORE C COMPONENTS [2, 2, 4, 2, 4, 2] SUM 16 TOTAL 16 README 16 MATCH True
JUDGE_SCORE D COMPONENTS [2, 2, 3, 2, 3, 2] SUM 14 TOTAL 14 README 14 MATCH True
ARCHIVE_MATCH verify-r1.md False
ARCHIVE_MATCH_RSTRIP_NEWLINES verify-r1.md True
ARCHIVE_MATCH verify-r2.md True
ARCHIVE_MATCH verify-r3.md True
ARCHIVE_MATCH judge.md True
ARCHIVE_MATCH brief.md True
ARCHIVE_MATCH rubric.md True
CANDIDATE_ARCHIVE_MATCH a/design.md True
CANDIDATE_ARCHIVE_MATCH a/rationale.md True
CANDIDATE_ARCHIVE_MATCH a/seed.md True
CANDIDATE_ARCHIVE_MATCH b/design.md True
CANDIDATE_ARCHIVE_MATCH b/rationale.md True
CANDIDATE_ARCHIVE_MATCH b/seed.md True
CANDIDATE_ARCHIVE_MATCH c/design.md True
CANDIDATE_ARCHIVE_MATCH c/rationale.md True
CANDIDATE_ARCHIVE_MATCH c/seed.md True
CANDIDATE_ARCHIVE_MATCH d/design.md True
CANDIDATE_ARCHIVE_MATCH d/rationale.md True
CANDIDATE_ARCHIVE_MATCH d/seed.md True
FINAL_ALL_30_FILES_MATCH True
```

`ARCHIVE_MATCH verify-r1.md False` is explained by the intended removal of the surplus final blank line; `ARCHIVE_MATCH_RSTRIP_NEWLINES verify-r1.md True` proves there is no content change. It is not a mismatch against the reviewed commit: its REVISION_MATCH is True.

Direct `git diff --check a78b0ad..0dc9170` reproduction exits 0 and prints no output. The checker reports its empty stdout/stderr exactly above.

Mechanical disposition: **pass** for committed-byte equality, local links/anchors, operation/tool counts, contiguous question numbering, whitespace, score arithmetic and the bounded secret scan. Historical absolute links are locally valid and explicitly documented as nonportable.

## 6. Exact documentation counterexample outputs

I ran transcriptions of the documented rules with fixed data, independently of the author's outputs. The horizon model uses only accepted matching batches and advances over previously completed higher sequences. The membership example follows the new declared run/case/result key. The aggregate example uses exactly the four declared agg fields and identical last-16 presentation rows. Charter checks assume the test, target and other qualification conditions already hold; the point is the missing/unrelated/declared-charter distinction.

Exact stdout:

```text
HORIZON order=(10, 11) process=10 {"accepted": 11, "applied": 10, "gate": "pending", "outstanding": 1}
HORIZON order=(10, 11) process=11 {"accepted": 11, "applied": 11, "gate": "passed", "outstanding": 0}
HORIZON order=(11, 10) process=11 {"accepted": 11, "applied": 9, "gate": "pending", "outstanding": 1}
HORIZON order=(11, 10) process=10 {"accepted": 11, "applied": 11, "gate": "passed", "outstanding": 0}
SLOT_MEMBERSHIP intended ["O-loose"]
SLOT_MEMBERSHIP stored {"admitted": "assumed", "case": "C1", "corrected": false, "result": "E1", "run": "R1"}
SLOT_MEMBERSHIP read_by_run_case_for_each_obligation {"O-exact": ["E1"], "O-loose": ["E1"]}
SLOT_KEY two_qualifying_slots {"slots": 2, "unique_declared_keys": 1}
AGG same_actor {"agg": {"counted": 17, "failsUncorrected": 1, "latest": 17, "passActors": 1}, "state": "failing"}
AGG different_actor {"agg": {"counted": 17, "failsUncorrected": 1, "latest": 17, "passActors": 1}, "state": "disputed"}
AGG comparison {"different_required_state": true, "equal_agg": true, "equal_recent": true}
REUSE before_correction {"associated_runs": ["R-change", "R-plan-1", "R-plan-2"], "immutable_results": 1}
REUSE correction_reverse_key {"effective_old_results": 0, "revisited_runs": ["R-change", "R-plan-1", "R-plan-2"]}
LATE_SIGNOFF predecessor_settle {"prior_question": "Q0", "prior_row_edited": false, "question": "Q1", "supersedes": "D0"}
SUGGESTION locus_default {"expected": "Total shows $90.00", "on": "C-311#s2", "step": "s2"}
OBLIGATION_DEFAULT loose {"basis": "exact-or-assumed", "bindings": "any", "charters": "any", "id": "server-assigned", "kind": "exercise", "methods": ["human", "auto"], "minActors": 1, "target": "exact"}
OBLIGATION_DEFAULT standard {"basis": "exact-or-assumed", "bindings": "any", "charters": "any", "id": "server-assigned", "kind": "exercise", "methods": ["human", "auto"], "minActors": 1, "target": "exact"}
OBLIGATION_DEFAULT regulated {"basis": "exact", "bindings": "any", "charters": "any", "id": "server-assigned", "kind": "exercise", "methods": ["human", "auto"], "minActors": 1, "target": "exact"}
CHARTER {"batch_valid": false, "charter": null, "eligible_under_any": false, "method": "agent"}
CHARTER {"batch_valid": true, "charter": "unrelated", "eligible_under_any": false, "method": "agent"}
CHARTER {"batch_valid": true, "charter": "h_checkout", "eligible_under_any": true, "method": "agent"}
CHARTER {"batch_valid": true, "charter": null, "eligible_under_any": true, "method": "auto"}
```

The horizon, reuse, predecessor, suggestion and default transcriptions support the resolved documentation contracts. The SlotResult and aggregate examples prove the two stated contract inconsistencies. They demonstrate no running-service behavior.

## 7. Final disposition

**Issues on 0dc9170.** Blocking: R4-1, the unresolved obligation key in R3-6; R4-2, the aggregate/state contradiction. Neither is an editorial preference. Both can mislead implementation of the evidence contract in decision 0008.

The round 3 editorial fixes pass. Remaining nonblocking work belongs to the phase-1 prototype: executable policy precedence and predicates, complete read/reverse-key proofs, helper/revert/dependency behavior, patch validation, clean-run cohorts, runtime fixtures and measured budgets. No implementation or production approval is implied.

The full report is saved to `/tmp/casebook-arena/verify-r4.md`. No repository change, commit, push, pull-request mutation or merge was performed.

Final read-only check:

```text
FINAL_HEAD 0dc917095c0f8d322aff4e08767903d6f76a6b69
FINAL_ALL_30_FILES_MATCH True
FINAL_STATUS ''
FINAL_DU 764K	.
```
