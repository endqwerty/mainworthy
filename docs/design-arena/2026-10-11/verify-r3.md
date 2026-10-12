# Verification report, round 3

Verdict: **issues on fd6188ea5d8dcbd26e44cf104e82eb4aea8954f7**.

Whole change reviewed: `a78b0ad..fd6188e`. Fix range reviewed: `4d29392..fd6188e`, including 9764393 and fd6188e. Reviewer: Codex, GPT 6.1 Sol. This is a read-only documentation review of the Claude-authored synthesis. It does not certify an implementation.

I read the earlier reports, the current design and decision records, the changed roadmap, questions, vision and index, and the archived brief, rubric, judge verdict and package provenance. All 29 changed or added files match the requested commit. The archived source files match their scratch originals. The author's reasons and fix scripts were not read. No repository file was changed.

The safety fact is that a gate counts evidence only for the admitted obligation, immutable basis and target, preserves all effective conflicting results, and waits for all matching accepted batches and current decisions. Several fixes establish this contract more clearly, but remaining examples and pseudocode still contradict it. Runtime correctness, persistence, performance, token budgets, migrations, backup and restore are **not checked**: this change contains no implementation.

Line references below identify fd6188e unless explicitly marked as historical.

## 1. Disposition of round 2 findings

### R2-1: resolved

`docs/product-design.md:931-934` now says:

> `if (!allEqual(claims)) return Rejected('BasisConflict', claims)`
>
> `if (claims.length >= 1) return { b: 'exact', ...claims[0], claim: claimOf(claims[0]) }`
>
> `if (test.case) return { b: 'assumed', case: test.case, version: head(test.case), claim: claimOf(head) }`

One, two agreeing and three agreeing sources select the same exact version. Disagreement rejects. No sources yields assumed for a mapped test and unresolved otherwise. `allEqual` must mean pairwise agreement, including an empty or singleton set; it is not implemented here. E3 at :1042-1044 now explicitly includes agreeing and disagreeing provenance. This matches 0008:21-29.

### R2-2: still open in part

The false-green hole is repaired in the primary verdict rule. `product-design.md:611` says:

> `if (h.outstanding > 0 || expired) return 'pending'`

The new staging row at :793 also says:

> "the adapter parses first; accept ... stage the normalised results durably ... matching runs (frozen excepted)"

However, :658-660 prescribes setting applied to the currently processed batch's Seq when no older batch remains. Processing B=11 then A=10 leaves applied=10 after both are applied. The old gate-read row survives at :798:

> "the read compares `horizon.applied` to `accepted` and `nextExpiry` to now"

That row returns pending forever in this two-batch example, while :611 and :661 say the gate can pass once outstanding is zero. 0008:50-56 instead requires a contiguous watermark and pending while anything is outstanding. See blocking R3-1. The old parse-after-accept row is gone, but C5 still says "before parsing starts" at :115; see R3-7.

### R2-3: still open in part

The direct lifecycle violation is resolved. `product-design.md:664-668` says:

> "A late batch does not reopen a closed run: `state` is standing and only a `signoff` decision writes it."
>
> "the new decision supersedes the old one in the ledger."

This agrees with the standing-writer declaration at :576 and 0008:57-59. Frozen verdicts and live post-freeze flags are now distinguished at :670-672.

The implementation sketch does not preserve that supersession when `raise` creates a new epoch. `settle` sees the new open question and records `supersedes: null`, leaving the old run signoff outside its prior-decision handling. See blocking R3-2.

### R2-4: resolved

`product-design.md:828-831` now requires:

> `{ kind; subject; evidence: Digest; answer; reason? }`
>
> "if a question with that fingerprint already exists, the reply is exists{q, evidence} and nothing is written; the caller then uses the q form"

0008:73-75 repeats that a genuinely new question supplies its evidence and an existing question refuses this form. The q and all forms carry `onEvidence`; :894 rejects a stale hash. An answer against an existing fingerprint can no longer acquire a server-generated current basis through the subject form.

### R2-5: still open in part

The type and ID collision is resolved. `product-design.md:485` retains `type Requirement` for tracker items. :588-600 now defines `Obligation`, `ObligationId` and `Slot.obligation`; GateRule at :482, gap at :698 and plan at :825 use the new name.

The manual example at :386 now correctly uses:

> `test: { case: 'C-311' }`

The suggestion fix creates a normalization boundary at :555-558:

> `suggest: Suggestion | null`
>
> `type Suggestion = { step: StepId; action?: Text; expected?: Text } | { case: { title; folder: FolderId; steps: string[] } }`
>
> "normalises it into an `Edit` on a sealed ... proposal authored by the finder"

The second suggestion now fits that shorthand. The first suggestion at :303 supplies only `expected`, omitting the required `step`. The plan example also supplies partial obligations against a required `Obligation[]` input. See blocking R3-3. The executor display identifies an agent actor, which can legitimately produce method auto under :521; that display alone is not an incompatible method input.

The remaining lowercase uses of run "requirement" are terminology nits, listed below. There is no remaining second capitalized Requirement declaration.

### R2-6: still open in part

The bounded-fill loss is expressly rejected. `product-design.md:603` calls recent "presentation only"; :645-647 says:

> "The fold reads the slot's complete effective result set ... `agg` is its lossless summary and `recent` is presentation only, so a seventeenth fill cannot hide a failure."

0008:41-42 says the slot folds the complete set. The seventeenth-fill attack therefore fails under the intended contract. But the prescribed source query uses Result's single run reference, which cannot represent reused CI evidence across multiple matching runs. See blocking R3-6.

Agent eligibility is now explicit at :636-639:

> "its batch names a charter that is in `obligation.charters` ... an agent result with no charter never fills a slot"

Batch and Result carry a charter at :521/:540. However, report's input at :820 cannot supply one. The intended validation is improved, but the public route to a valid agent batch is absent. See blocking R3-4.

### R2-7: resolved

`product-design.md:1023-1026` names the override and its end:

> "`preview-1`: standard's `signoff (close)` clause is `rule: approve when passed` instead of `role lead` until the role path ships in phase 3, and the ledger names that clause"

The full standard table at :778 still says role lead, with the slice explicitly overriding it. E1 at :1038-1039 now says:

> "a review alone never fills an exercise slot"

This permits the separate review obligation at :649-651. The Preview override and review fixture no longer contradict those full-model contracts.

### R2-8: resolved

`product-design.md:1010-1014` keeps Local Preview separate from phase-3 first usable. `docs/roadmap.md:102-107` now requires:

> "the same artifact runs the Server layer ... and passes the same job suite; jobs are persisted and crash-safe; backup and restore are checked ... the Cloud layer's multi-instance correctness is proven with the cache disabled. Only when these pass ... first usable"

Roadmap :109-115 renames phase 4 "Scaling, storage, migration import, reports" and moves the layer proofs and backup/restore prerequisites to phase 3. Decision 0002's release prerequisite is preserved. Decision 0001:83-92 adds storage criteria without choosing a stack. No language, framework, build manifest or dependency is introduced.

## 2. Disposition of every round 2 editorial note

1. **Durable undo check: resolved.** `product-design.md:104` replaces "L5 in candidate D" with the local L6 job assertion and "J4 for the bulk move". The check no longer depends on an uncommitted candidate reference.
2. **Ordered overlapping preset clauses: still open, nonblocking design work.** :738 says "First matching clause wins", but the table still places general adopt rows at :764-765 ahead of stale-base/admin rows at :766-767, and general failure rows at :769-770 ahead of disputed at :771. The table is not an executable clause list. Preserve the R2 instruction to specify precedence when those lists are implemented. This report does not claim the displayed row order is executable.
3. **Regulated signoff wording: resolved.** :1231-1232 now says the regulated preset is unexercised until "`gap` and the role and freeze paths of `signoff` ship". This correctly distinguishes Preview's rule-only signoff.
4. **Broader phase-1 fixtures: resolved as requested.** :1239-1240 now names "D1, D3 and E1 to E8", including "inverse-order horizon, agreeing provenance and late-reopening cases". E3 and E5 include the requested cases at :1042-1049. "Late-reopening" is now a misleading label because :664 forbids reopening; that new wording nit is separate from the expanded coverage.
5. **Predicate enumeration, reverse-key proof, immutable patch validation and clean-run cohorts: still open, nonblocking implementation work.** Predicate remains a closed-vocabulary placeholder at :736. The claim of keyed reverse hops at :797, Review hash construction at :560-562, and clean hold cohort fields at :723-724 still require a concrete registry, queries and validation tests. Decision 0008:4-5 calls these proposed mechanisms "to be proven in the phase 1 prototype". No runtime enforcement has been demonstrated or claimed by this review.

## 3. Blocking issues on fd6188e

These issues can mislead an implementer or break a recorded contract. They determine the verdict.

### R3-1. Inverse processing order still gives two different gate answers

`product-design.md:658-660`:

> "sets `applied` to the batch's Seq only if no older matching batch is still outstanding"

Accept A=10 and B=11 with applied initially 9. Process B first: applied stays 9, outstanding becomes 1. Process A: applied becomes 10, outstanding becomes 0. There is no instruction to advance through already-applied B to 11.

At :611/:661 the gate can pass. At :798 the gate still compares applied and accepted, so it remains pending. This contradicts E5 and 0008:50-56. The outstanding count prevents the old false green, but the literal watermark update and the access-pattern read remain wrong.

Advance to the largest contiguous completed matching prefix, including previously processed higher batches when a hole closes. Make :798 use the same outstanding/expiry/frozen rules as section 6.4. Keep E5's inverse-order fixture.

### R3-2. A late batch's new signoff epoch does not supersede the old decision

`product-design.md:881` opens a new question with `prior: q.id` after its hold changes. At :906-909:

> `const prior = q.state.s === 'decided' ? tx.decisions.get(q.state.decision) : null`
>
> `supersedes: prior?.id ?? null`

The newly opened epoch is open, so prior is null even though `q.prior` points to the old question. Settling it records no supersession and does not use the old signoff in `revert`. This contradicts :668, E5 at :1048-1049 and 0008:59.

Resolve the prior decision through the predecessor epoch or the currently effective signoff, and specify how its standing and dependencies are replaced. Distinguish a historical supersession from the effects that need reversal. The new decision must name the old one in the ledger.

### R3-3. Section 5 still contains incompatible canonical inputs

Section 5 calls its examples "the specification" at :133.

- At :303, `suggest: { expected: ... }` omits the required `step` in Suggestion at :556. Locus :301 can identify the step, but no rule makes `step` optional or derives it from `on`. Either include the step or document that shorthand in the input type and normalization rule.
- At :365-366, the exercise obligation omits `id`, `bindings`, `charters` and `target`; the jobs obligation omits `id`. Those fields are required at :589-596, while :825 takes `Obligation[]`. The example comment says "defaults come from policy", but no partial-input type or normalization rule defines those defaults or server-assigned IDs. Define an ObligationIn shape with explicit defaults, or use complete canonical inputs.

The manual `ResultIn` and second finding suggestion are repaired. The above mismatches remain. Other illustrated get, impact, propose, q-form decide, build target and result inputs fit their sketched operation contracts. An agent actor can supply auto-method evidence, so the executor display does not by itself violate the human/auto method list.

### R3-4. report cannot supply the charter its agent validation requires

`product-design.md:521` says agent method requires a producer-declared charter. :636-639 requires that charter for qualification. But :820 exposes:

> `op report ({ target? | run?; job?; attempt?; method?; manifest?; raw?: BlobRef; results: ResultIn[] })`

There is no charter field in report or ResultIn. Section 5.3:327 calls an impact digest "the charter" and :329 sends `report({ run, results })`, while the canonical Batch needs a CharterId.

No documented input or resolver binds that digest to the required charter ID. Add the charter input and validation, or specify a single unambiguous resolution rule. A valid admitted agent-method result must be representable through the shared operation.

### R3-5. The proposed standard quarantine-release authority disagrees across documents

`docs/open-questions.md:17`, question 12, says:

> "the loose preset releases after 20 clean trunk runs by rule, standard and regulated by a person"

The normative preset table at `product-design.md:773` says:

> `flaky (exit) | rule: release | rule: release | role lead`

Standard is rule-driven in one normative description and person-driven in the proposed-default description. The new Preview override concerns signoff, not flaky exit, so it does not reconcile this conflict. Choose one authority and update both documents. This is a policy-contract discrepancy, not merely naming.

### R3-6. The complete-fill query cannot represent evidence reused across runs

`product-design.md:645-647` mandates reading the complete effective set from:

> `Result (project, run, case)`

But Result at :545 has one `run: RunId | null`. The same result may qualify for several runs: :31 describes a run as a request, 0008:31-40 says results belong to targets, and the plan at :368-369 reuses 171 prior CI fills.

Create two planned runs selecting the same pinned case and target. A CI result without a run, or carrying its change-run ID, can qualify for both. Its single run field cannot put it in both prescribed Result ranges. Slot only retains a bounded recent list plus aggregate counts, so that list does not repair the complete-set query for later corrections or dispute resolution.

Define a durable many-to-many slot/result association with the appropriate obligation key, or read the complete matching target/test evidence through a specified query. Keep one immutable Result fact. The seventeenth-fill protection needs a source that includes every qualifying reused result, not just results originally submitted to that run.

### R3-7. C5 still puts durable acceptance before parsing

`product-design.md:115` promises:

> "Accepting an upload turns a green gate pending before parsing starts"

Sections 6.6:793 and 7.1:808-813 say adapters parse before the operation and durable acceptance stages normalized results. Decision 0008:106-109 states the same boundary.

Under that boundary a gate need not turn pending while the adapter parses an unaccepted file. C5's opposite sequencing requirement cannot be met by the stated operation. Change the commitment to pending before processing normalized accepted evidence, or deliberately revise the acceptance boundary everywhere. The C5 fixture must exercise the chosen boundary.

## 4. Editorial nits and review limits

These do not determine the semantic verdict.

- **Whitespace check fails.** The newly archived `verify-r1.md` has a blank line at EOF. Remove only the surplus blank line when fixing the archive. The failure is reproduced below.
- **Leftover run terminology.** Capitalized Requirement now consistently means the tracker item, but run obligations are still called "requirement" at product-design :515, :624 and :1054 and 0008:62/:94. There are also lowercase run uses at product-design :185, :399-400 and :1128. Use obligation where it refers to that contract. Historical candidates and earlier reviews retain their old vocabulary appropriately.
- **No leftover proposal Change contract.** The live proposal type uses `edits: Edit[]` at :467-468 and propose uses edits at :352/:819. Change at :517 and the Change page are code/PR metadata. `changes:` for proposal inputs survives only in the explicitly historical candidate packages and review quotations, not the live contract.
- **Arena README path description is inaccurate.** README :20-21 says "Absolute paths inside the candidate files point at the scratch directory ... and no longer resolve." The nine clickable absolute paths point to this repository's worktree, not scratch, and all resolve here. Candidate D's backtick scratch reference also still exists. Say those machine-local paths are historical and not portable rather than claiming every one is absent. They are not broken normative dependencies.
- **Arena contents and scores are otherwise accurate.** All four packages contain design, rationale and seed, alongside brief, rubric, judge and rounds 1/2. All archived bytes match the scratch sources. The scores sum to A=27, B=25, C=16, D=14 and match both README and synthesis :1099. A is the judge's recommended base; the synthesis clearly records its different choice. No r3 archive exists in this revision, and the README's ellipsis is a convention for later rounds, not a claim that r3 is already committed.
- **Preview fixture scope needs clarification.** Preview exit E6 at :1049-1051 tests fragment adoption, while :1063-1064 leaves fragments as types with no UI and :1200-1202 describes no fragments in the first slice. State whether E6 is a backend-only model fixture or moves to phase 3. The phase-1 next step names only adopt/failure implementations at :1237 but includes E5's signoff behavior at :1239. Identify the signoff fixture implementation or stub needed there.
- **The label late-reopening is stale.** :1240 should say late-upload signoff supersession, consistent with :664.
- Ordered executable clauses, predicate enumeration, full query/key proofs, patch validation and cohort rules still await the prototype. They are not runtime passes. Competitor claims were checked for provenance labels and consistency with the repository's dated research; this review did not independently refresh vendor facts.

## 5. Exact mechanical outputs

I ran the checks against all 29 changed and added Markdown files, including the archive. Byte comparisons use `git show fd6188e:<path>`. The local link scan covers clickable Markdown destinations and anchors, including absolute paths, and excludes external URLs, image syntax and backtick/prose references. The secret scan covers private-key headers, GitHub tokens, AWS access keys, OpenAI keys and credential-bearing URLs; matching credential values would not be printed. It cannot guarantee detection of encoded or unrecognized credentials.

The checker printed exactly:

```text
HEAD fd6188ea5d8dcbd26e44cf104e82eb4aea8954f7
CHANGED_FILES 29
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
REVISION_MATCH docs/open-questions.md True
REVISION_MATCH docs/product-design.md True
REVISION_MATCH docs/product-vision.md True
REVISION_MATCH docs/roadmap.md True
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
DIFF_CHECK_EXIT 2
DIFF_CHECK_STDOUT 'docs/design-arena/2026-10-11/verify-r1.md:438: new blank line at EOF.\n'
DIFF_CHECK_STDERR ''
STATUS ''
JUDGE_SCORE A COMPONENTS [5, 5, 5, 4, 5, 3] SUM 27 TOTAL 27 README 27 MATCH True
JUDGE_SCORE B COMPONENTS [4, 5, 5, 3, 5, 3] SUM 25 TOTAL 25 README 25 MATCH True
JUDGE_SCORE C COMPONENTS [2, 2, 4, 2, 4, 2] SUM 16 TOTAL 16 README 16 MATCH True
JUDGE_SCORE D COMPONENTS [2, 2, 3, 2, 3, 2] SUM 14 TOTAL 14 README 14 MATCH True
ARCHIVE_MATCH verify-r1.md True
ARCHIVE_MATCH verify-r2.md True
ARCHIVE_MATCH judge.md True
ARCHIVE_MATCH brief.md True
ARCHIVE_MATCH rubric.md True
```

Candidate archive comparison printed exactly:

```text
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
```

Direct reproduction of `git diff --check a78b0ad..fd6188e`, exit 2:

```text
docs/design-arena/2026-10-11/verify-r1.md:438: new blank line at EOF.
```

Mechanical disposition: file equality, local link resolution, operation/tool counts, question numbering, score arithmetic and the bounded secret scan **pass**. Whitespace has **issues**. Absolute links are locally valid but not portable to GitHub or another checkout.

## 6. Attempts to break the final revision

I executed small transcriptions of the stated branch logic, replacing storage lookups with fixed values. These are counterexamples to documentation, not tests against a Casebook binary. For allEqual I used pairwise equality, with empty and singleton sets agreeing.

Exact output:

```text
BASIS 0 sources, mapped => {"b": "assumed", "case": "C-311", "version": 8}
BASIS 0 sources, unmapped => {"b": "unresolved", "test": "T-1"}
BASIS 1 source => {"b": "exact", "case": "C-311", "version": 7}
BASIS 2 agreeing => {"b": "exact", "case": "C-311", "version": 7}
BASIS 3 agreeing => {"b": "exact", "case": "C-311", "version": 7}
BASIS 2 disagreeing => "Rejected(BasisConflict)"
BASIS 3 disagreeing => "Rejected(BasisConflict)"
BASIS 2 agreeing, unmapped test => {"b": "exact", "case": "C-311", "version": 7}
HORIZON process 11 => {"accepted": 11, "applied": 9, "outstanding": 1} gate_6_4=pending gate_6_6=pending
HORIZON process 10 => {"accepted": 11, "applied": 10, "outstanding": 0} gate_6_4=passed gate_6_6=pending
LATE_SIGNOFF raise changed basis => open epoch=1 prior=Q-old; settle => supersedes=null
SUBJECT_DECIDE existing fingerprint => exists{q,evidence}; writes=0; q form with stale hash => conflict
SLOT 17 fills => recent_fails=0 complete_fails=1 passActors=1 state=disputed
AGENT charters=any case_declares=[declared] batch_charter=None => not eligible
AGENT charters=any case_declares=[declared] batch_charter=unrelated => not eligible
AGENT charters=any case_declares=[declared] batch_charter=declared => eligible
AGENT_INPUT report signature => charter field absent; named charter cannot be supplied through documented canonical input
PREVIEW_STANDARD signoff(close) => rule:approve-when-passed clause=preview-1; role path ships in phase 3
```

- **basisFor: pass on the documented branches.** Zero mapped/unmapped, one source, two agreeing, three agreeing, disagreements and agreeing sources for an unmapped test behave as intended. An advanced head v8 no longer replaces explicit v7 provenance.
- **Inverse horizon: issues.** The outstanding rule remains pending after B, correctly protecting against an interleaved decision. After A, the two prescribed gate readers disagree because the literal watermark stays 10. See R3-1.
- **Late batch to a closed run: issues in the ledger.** Acceptance makes the gate pending and leaves standing closed. Processing re-raises signoff and the current-epoch settle code loses the old supersession ID. Frozen runs retain the frozen verdict and expose after-freeze/expiry flags. See R3-2.
- **Subject-form decide against an existing question: pass as a stated input contract.** It returns exists without writes and requires the q form next. A stale q basis conflicts. The subject dispatch is not implemented, so runtime enforcement is unproven.
- **Seventeenth fill: pass for the retention rule, issues for its query source.** Sixteen recent passes cannot hide an uncorrected first failure when the full effective set is read. Different actors make the slot disputed. The reused-result counterexample shows that the specified run-keyed full set is incomplete across runs. See R3-6.
- **No charter or unrelated charter: pass for the intended matcher, issues for the input route.** An agent-method batch without a charter rejects at Batch validation or cannot fill. With charters=any, a charter not declared by the case cannot fill. A permitted declared charter can fill, but report cannot name it. An explicit charter allowlist is a deliberate policy grant, not the same attack as an unrelated charter under any. See R3-4.
- **Preview standard override: pass as a documented scope override.** It is named preview-1, recorded in the ledger and ends when the phase-3 role path ships. The ordinary standard role-lead clause is not silently changed. This does not resolve the separate quarantine-release discrepancy in question 12.

## 7. Final disposition

**Issues on fd6188e.** R2-1, R2-4, R2-7 and R2-8 are resolved. R2-2, R2-3, R2-5 and R2-6 are partially repaired but still open for the reasons above. The blocking list is R3-1 through R3-7. Editorial nits and implementation limits are listed separately.

This report and two supporting output files were written under `/tmp/casebook-arena/`. The repository remains unchanged. No commit, push, PR mutation or merge was performed.

Final read-only check:

```text
FINAL_HEAD fd6188ea5d8dcbd26e44cf104e82eb4aea8954f7
FINAL_ALL_29_FILES_MATCH True
FINAL_STATUS ''
FINAL_DU 728K	.
```
