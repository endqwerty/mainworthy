# Casebook design arena verdict

Recommend **A as the BASE**, with two ideas each from B, C, and D. A has the safest extension point: an observation preserves its actor, target, executed-version basis, and outcome; a manifest establishes what evidence is missing; review findings remain separate from execution. Its 17-operation contract is smaller than B's 22 without relying on C's ingest-time version guessing or D's automatic excuses.

This recommendation is for synthesis, not implementation approval. A needs a smaller delivery plan, an explicit shared evidence-acceptance boundary, and B's stronger target identity. No candidate has demonstrated its performance claims or a genuinely small first usable release.

## Scope and evidence

I read all eight candidate files end to end, the shared brief and rubric, and the repository grounding, including the decision records, competitive analysis, flows, research plan, and roadmap. Citations below identify a candidate file and its section; line numbers identify specific defects where useful. Competitor evidence is judged against the repository's dated research, without fresh vendor verification.

D disclosed reading the judge-only rubric in `d/rationale.md`, Disclosure. I give no credit for matching rubric language and no automatic score penalty for disclosure; the scores assess the types, operations, examples, and delivery boundaries. Convergence means agreement among the packages, not proof that all four were independently blind to the rubric.

## Scores

Scores use the requested 1-5 scale. Totals are an unweighted comparison, not an extra rubric criterion.

| Candidate | 1. One product | 2. Money | 3. Principles | 4. Depth and ownership | 5. DX/UX | 6. Delivery | Total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| A | 5 | 5 | 5 | 4 | 5 | 3 | 27/30 |
| B | 4 | 5 | 5 | 3 | 5 | 3 | 25/30 |
| C | 2 | 2 | 4 | 2 | 4 | 2 | 16/30 |
| D | 2 | 2 | 3 | 2 | 3 | 2 | 14/30 |

### A

1. **5/5.** Manual and CI execution converge on `Observation`, while F13 produces `Finding` and proposals rather than runtime passes, with exact or explicitly unresolved provenance and common acceptance rules in `design.md`, Usage first and Domain model, Facts, identity, and valid states.
2. **5/5.** The money table ties history, reader pricing, request limits, and hosting to storage and operation choices, explicitly acknowledges Testmo, and labels coordination costs and MCP depth as hypotheses in Why the incumbents are a poor use of money.
3. **5/5.** Principles 1-10 specify exclusions, conflict priorities, immutable evidence floors, and an exception with an owner, rejection test, and expiry in Guiding principles.
4. **4/5.** The 17 operations hide meaningful merge, acceptance, selection, and recovery work with named owners, but broad unions such as `decide_evidence` and coordination across twelve internal modules still need enforceable constructor boundaries in One typed operation catalog and Modules by knowledge and state ownership.
5. **5/5.** Stable editing context, keyboard execution, resumable CI receipts, clean-machine startup, and transport/token checks are concrete commitments in The DX/UX moves, made concrete.
6. **3/5.** All eight required access patterns have durable structures and freshness semantics, but the first slice combines three deployment proofs, CI recovery, review, gates, deployment recording, certificates, and restore into an oversized release in Storage shapes required by the access patterns and First deliverable slice.

### B

1. **4/5.** Manual and automated outcomes share `Evidence` and pinned obligations, but review completion has both `Evidence.outcome = ReviewCompleted` and a separate `ReviewCompletion` representation without an explicit canonical relationship in Evidence preserves its basis and disagreement and Review, flakiness, and decisions.
2. **5/5.** The commercial argument distinguishes verified gates from alleged architectural defects and answers them through immutable proof, free reader identities, batch receipts, and portable archives in Why the incumbents are a poor use of money.
3. **5/5.** Principles 1-9 and the bending rule resolve speed, scope, evidence, and publication conflicts without waiving the false-green or data-loss floors in Guiding principles and The rule for bending a principle.
4. **3/5.** Definition, Proof, Evidence, and Review are useful boundaries, but the 22 operations, seven MCP action unions, and duplicate review-completion representations make the public contract and state authority less local than claimed in Small operations that hide substantial rules and Knowledge boundaries and state ownership.
5. **5/5.** A red PR opens directly to qualifying evidence and unmet clauses, preparation and reporting use existing runners, and startup and token savings have named checks in The DX/UX moves, made concrete.
6. **3/5.** Target attestations, indexed invalidation, and generation-checked gates are unusually concrete, but the initial slice still includes shared steps, three layers, MCP review and exercise, traceability, sign-off, seals, and full archive recovery in Storage shape and access patterns and First deliverable slice.

### C

1. **2/5.** `record` unifies execution mechanically, but `Stamp` uses the claim bound at ingest, `Pinned` omits the exact document version, and F13 skips by claim rather than review basis in §§5.3, 7.2, and 8.3.
2. **2/5.** The structural answers are useful, but §2 incorrectly labels universal seat pricing, dated self-hosting, and a supposed mutable-row cause of history gating as verified, then repeats the architectural claim in `rationale.md`, Problem and Alternatives considered.
3. **4/5.** The eight principles include exclusions, tie-breaks, expiry, and a measurable floor, but their integrity promises conflict with the actual stamping, decision ordering, and supposedly commutative writes in §§3, 7.1, and 7.4.
4. **2/5.** Fourteen operations are economical, but claim identity leaks into version lookup, review reuse, binding, and gates, while the binding-change protocol and permissive write types leave invariants spread across modules in §§6.2, 7.1-7.5, and 8.2-8.3.
5. **4/5.** `fmt`, `check`, registry-derived commands, environment fixtures, and clean-artifact startup are testable improvements, although the one-line reporting promise conceals provenance and completion gaps in §§4-5.
6. **2/5.** Most structures are named, but the manual read cannot recover an exact body from its claim pin, the gate has an explicit tally-later escape, and the slice reserves rather than enforces strict workflow fields in §§7.5 and 12.

### D

1. **2/5.** Producers share `Result` and `Finding`, but current-head stamping, unrestricted slot substitution, and later-Seq selection make their evidence semantically interchangeable without sufficient basis in §§5.4, 6.3-6.4, and 6.6.
2. **2/5.** The queue addresses coordination costs structurally, but §2 repeats universal seat pricing despite Testmo and asserts that incumbents cannot report decision costs without evidence.
3. **3/5.** The ordered principles and bounded bending rules are specific, but P2 elevates avoiding repeated questions above speed and P4 permits missing surfaces while the stated F3 floor forbids them in §3.
4. **2/5.** `Decided<K>` and exhaustive registries are promising, but direct failure excuses bypass the decision witness, expired decisions have no demonstrated tally-refresh path, and format-bearing inputs enter the operation contract in §§6.5, 7.1-7.3.
5. **3/5.** Queue keys, four verdicts, startup, and tool-definition limits are checkable, but automatic green after an infrastructure/flaky answer and unconditional base-failure exclusion are unsafe substitutes for accepted evidence in §4.2.
6. **2/5.** Local-only delivery is smaller than A/B, but it silently contradicts 0002's pre-usable layer proof, defers the promised automatic flaky detector, and uses a strict fixture instead of the regulated workflow in §§9-10.

## Criterion 1: explicit J5, F5, and F13 traces

Distinct findings and execution outcomes are legitimate domain concepts. A second path is a competing way to publish the same fact or decide the same invariant, not simply two adapters accepting different input formats.

### A

- **J5, manual run.** `PlanningView`/a case selection enters `open_scope`; it resolves `ExpectationVersion`, dependency pins, and `ExecutionBinding` into `Manifest`/`Obligation` and `OpenScope`; `assign_work` records coordination; `read_scope` supplies pinned work; `append_observations` creates actor-owned `Observation` with `Origin.Scoped` and `ObservedBinding.Exact`; Analysis derives progress and `Gate`, and `close_scope` records closure. A screenshot is an `ArtifactRef`, not a separate result channel. See Usage first, Call site C, and Domain model.
- **F5, CI ingest and triage.** `open_scope` pins bindings and registers `ProducerSlot`; `accept_report` creates `Report`/a durable receipt and staged normalized observations; publication produces the same `Observation` with `Origin.Imported`; Analysis updates cohort flakiness and evidence/gate projections; `close_scope` accounts for producer completion; `read_scope` reads the gate, and `decide_evidence` or `revise_links` records authorised triage. Legacy observations use `ObservedBinding.Unresolved` until a justified amendment exists. See Call site A, storage structures, and access patterns 3, 4, and 8.
- **F13, adversarial review.** `inspect_change` creates `Inspection` using indexed links and risk summaries; `read_expectations` supplies exact `ExpectationVersion` bodies; `record_findings` appends version-bound `Finding`; triage and accepted changes use findings decisions, `revise_expectations`, and `decide_proposals`; `ReviewReceipt` plus `changes_since` supports reuse with change/dependency basis. Review does not create `Observation.Pass`. See Call site B and Review types.
- **Second path verdict.** No competing policy or result model is described; `accept_report` and `append_observations` are separate entry operations into one evidence contract. Synthesis must make their shared canonical acceptance function explicit so future implementers cannot duplicate validation. Review receipt completion also needs an explicit operation argument, since the call site currently emphasises findings more than recording a zero-finding completed review.

### B

- **J5.** `registerChange` records `Target`/`ChangeRevision`; `planProof` creates `PlanRevision` and `Obligation`/`Clause`; `beginExecution` pins `ExecutionItem`; `claimItems` coordinates work; `recordEvidence` appends `Evidence`; `finishExecution` records completeness; `readChange`/`readGate` expose qualification. Failure corrections and disputes use `Correction`, `Resolution`, and `resolveEvidence`. See Call site C, Plans express obligations, and operation catalog.
- **F5.** The producer variant of `beginExecution` owns target registration, recipe resolution, and exact version-manifest activation; `ingestReport` processes the receipt into canonical `Evidence`; Evidence updates `FlakeAccumulator` and digests; Proof tracks reporter completeness and invalidated generations; `resolveEvidence` triages mapping/quarantine/conflicts, and `readGate` returns a current `GateSnapshot`. See Call site A and access patterns 3, 4, and 8.
- **F13.** `readChange`/`readImpact` establish `ReviewBasis`; `reviewChange` records item acknowledgements, `Finding`, proposals, `ReviewCompletion`, and `Checkpoint`; `decideProposal` publishes through Definition; `readDelta` invalidates the full basis. A `Review` clause may accept review completion but cannot satisfy an `Exercise` clause. See Call site B and Review, flakiness, and decisions.
- **Second path verdict.** CI preparation's two typed variants converge on one activation operation, which is sound. Review completion is the unresolved second path: `recordEvidence` accepts a type whose outcome includes `ReviewCompleted`, while `reviewChange` separately records `ReviewCompletion`. Either make one a strictly derived view or remove review completion from execution evidence; do not retain two authoritative records.

### C

- **J5.** `record` with empty results opens `Run.manual`, resolves the selection, and pins `Pinned{case,claim}`; `status{run}` supplies the cockpit; further `record` calls append `Evidence` under `ProofKey.human` and fold `RunTally`, `Standing`, and `Health`. See §§5.4, 7.2-7.3, and 8.1.
- **F5.** A CLI format parser supplies normalized results to the same `record`; it opens `Run.ci`, looks up `Binding`, stamps `Evidence` from the current binding claim, and folds the same summaries; `status{failures|health|inbox|gate}` supports triage, `commit` changes bindings, and `decide` records quarantine/waivers. See §§5.2, 7.5, and `ops.record` in §8.3.
- **F13.** `impact(skipReviewed)` selects cases; `read(ifNoneMatch)` returns bodies; `flag` records claim-bound `Finding`; `commit` proposes changes, `resolve` adopts them, and `decide` records finding disposition. See §5.3 and §§7.4, 8.1.
- **Second path verdict.** Execution has one named operation, but it has two basis rules: manual pins are selected before execution, whereas CI is stamped from bindings at ingest. The excerpt also re-reads current bindings for each `record` batch, leaving manual pins unenforced there. F13 has no explicit reviewed-item/completion write despite promising `skipReviewed`; inferring completion from a finding fails for a clean review. These are missing or competing semantic paths, not a solved unification.

### D

- **J5.** `plan` creates `Run`/`Slot` pinned to `Version`; prior matching results may fill slots; `report` appends `Batch`/`Result`; `runs.fold` updates `Slot.best`, tally, and verdict; failure events invoke `raise`, create `Question.failure`, and `decide` creates `Decision`/its effects; sign-off is another question in the full design. See §§5.4, 6.4-6.6.
- **F5.** `report(file)` accepts a `Batch` and job; processing resolves `Test`, reads current `Case.head`, and creates `Result`; signatures and `TestSignals` trigger questions; `raise` attaches/carries/reopens them; `decide` attributes or excuses failures; `gate` reads the stored run verdict. See §§5.2, 6.6, and 7.2.
- **F13.** `impact` joins `Case`, `Review`, signals, and question ledger; `get` returns bodies; `claim` writes `Review`/`Finding` and raises finding questions; `decide` records advice or disposition; accepted suggestions create a sealed `Proposal` and an adopt decision; `since`/`impact(since)` supports rereview. See §§5.3, 6.3, 6.5, and 7.1.
- **Second path verdict.** Results nominally share `report`, but manual slots pin a version while CI guesses the current head. Gate authority also has two paths: recorded failure decisions and detector-side `excuse` for quarantine/base failures. Review remains a finding rather than a runtime result, but its reuse record lacks the relevant patch/dependency basis. The thesis's claim that an agent finding can satisfy the same slot is contradicted by the actual `Slot` matcher, which consumes results.

## Red-flag screen

I screened all eight flags from the brief. The findings below distinguish demonstrated defects from design risks; none of these sketches proves import restrictions or module depth through implemented code.

### A

No demonstrated shallow-module, temporal-decomposition, pass-through, importable-internals, or hand-synced-list violation. Fact owners and derived owners are explicitly distinguished.

- **Two ways to do one task, risk:** `accept_report` and `append_observations` claim common acceptance rules but only the direct-write sketch names the validator; implement one evidence constructor for both. Location: One typed operation catalog and Signature sketch and tricky logic, lines 408-422.
- **Information leakage, risk:** `decide_evidence` groups provenance amendment, quarantine, exception, freeze, sign-off, and revocation, so its schemas must not make callers understand projection/checkpoint mechanics. Location: operation catalog, line 353, and module map.
- **Split ownership, risk:** Policy's signed selections and Analysis's selection/gate views need a clear distinction between authoritative certificate facts and rebuildable views; the text mostly makes this distinction, so this is a boundary to preserve, not an established duplicate owner. Location: Modules by knowledge and state ownership and Ordering, concurrency, and corrections.

### B

- **Two ways to do one task; split ownership:** `ReviewCompleted` in Evidence and `ReviewCompletion` in Review both represent completed review, with no derivation or shared authoritative constructor stated. Location: Domain model, lines 287-317, and operations `recordEvidence`/`reviewChange`.
- **Information leakage, risk:** callers face 22 domain operations while MCP hides them inside seven different action unions; catalog generation prevents duplicated implementation, but contract size and action knowledge can still leak orchestration. Location: Small operations that hide substantial rules, especially the paragraph beginning "There are 22 domain operations".
- **Shallow modules, risk:** separate `readChange`, `readImpact`, and `planProof` are justified only if selection and qualification stay in the shared functions promised by the package. Location: operation catalog and `selectImpact`/`qualify` sketches.

No demonstrated temporal decomposition, pass-through service chain, importable internals, or hand-synced registry. The four major knowledge owners are stronger than its operation count suggests.

### C

- **Information leakage:** the claim hash is reused as proof identity, review identity, and purported body lookup although `Blob` is keyed by the different canonical-document hash; `Pinned{case,claim}` cannot identify the exact executed document version. Location: §§6.2, 7.1-7.2, and §7.5's run-execution row.
- **Two ways to do one task:** execution-time manual pins coexist with ingest-time/current-binding CI stamps. Location: §§5.4, 7.2 `Stamp`, and §8.3 `record`.
- **Split ownership/protocol risk:** `tree` owns bindings while `evidence` maintains binding-sensitive inbox state through `Δbindings`; this channel coordinates an unnecessary second representation of resolution, and must also handle unlinking, not just "clear resolved" rows. Location: §§7.3, 7.5, and 8.2.
- **Information leakage into callers:** `Targets.commuting` lets the caller assert that an operation commutes, while including moves and tag add/remove that do not commute on the same object. Location: §7.1, lines 488-496.
- **Hand-synced semantic lists, risk:** claim/meta classification is said to live in one function, but review reuse, `reaffirm`, and standing all depend on callers respecting that classification; the sketches do not encode a validated evidence-reuse basis. Location: §§6.2, 7.4, and 8.3.

Other substantive defects are latest-effective decisions without revision checks, no producer-completion condition in `judgeGate`, and a single integer change cursor without demonstrated removal/dependency handling. The explicit "maintained `GateTally`" fallback in §7.5 is also precisely the deferred access structure the brief warns against. No demonstrated temporal decomposition, pass-through chain, or importable-internals violation.

### D

- **Two ways to do one task:** `decide`/`settle` records excuses with a decision witness, but `detectFailures` calls `excuse(r,'base')` directly; no decision row is shown for that change of standing. Location: §7.2, `detectFailures`, lines 1208-1209.
- **Information leakage; split responsibility for an invariant:** failure fingerprints/holds live in Decisions and kinds, while Runs caches verdicts and Evidence owns excuses; no persisted expiry/invalidation protocol makes an expired hold remove a previously green cached verdict. Location: §§6.4-6.6 and 7.3.
- **Two ways to establish provenance:** manually planned slots pin a version, while report processing reads current `Case.head`. Location: §§6.4 and 6.6, line 979.
- **Information leakage:** the public `report` union contains a file and `Format`, while wire parsing is placed inside Evidence; this couples the domain operation to supported report encodings. Location: §§7.1 and 7.3.
- **Hand-synced relationships, risk:** registries are exhaustive by name, but the sketches do not establish complete keys for their promised queries, such as defect-to-signature-to-results and same-commit outcomes. Location: §6.6 patterns 6, 9, and 10 versus §6.3's declared result keys.
- **Shallow boundary, risk:** stateless `views` contains large joins over others' readers, while synchronous events and kind effects coordinate standing across all owners; the cost and invariant are spread beyond the file where an operation is declared. Location: §§6.6 and 7.3.

No demonstrated temporal-decomposition or pass-through chain. Import boundaries are asserted, but event recursion and decision effects still need enforced dependency rules. In addition, `Given` has no evidence-basis stamp, so a quorum could combine answers given before and after `attach` changes the question's evidence; `decide` needs an expected question revision/basis. A later-Seq `Slot.best` cannot make a disagreement safe merely by displaying it elsewhere.

## Base and grafts

### Why A is the base

A exposes fewer operations than B and avoids making every observation depend on a change/proof-plan hierarchy. Its `Origin` and `ObservedBinding` unions localise the difference between direct execution and imported reports. New formats, actors, or evidence policies can extend acceptance and pure selection without inventing another current-status writer.

The important distinction is preserved knowledge: facts remain intact, obligations determine missing evidence, and policy evaluates the combination. A already handles producer closure, out-of-order evidence, unresolved versions, conflicting actors, scope removals, and frozen-selection revocation. B is close, and has the cleaner broad module grouping, but its review-completion duplication is exactly the kind of locally plausible shortcut a future contributor would copy.

C's 14 operations are fewer by name but expose more semantic machinery. D's 17 operations conceal an expansive decision engine and unsafe inference. Smaller name counts do not outweigh weaker invariants.

### B: graft two ideas

1. **Stronger target identity and controlled reuse.** Graft `Target.Code`, `Target.Artifact`, `NamedSession`, and the `CodeInArtifact` acceptance rule backed by a verified build attestation from Definitions and targets and Plans express obligations. Adapt them to A's `Target`/manifest, without importing a mandatory `Change` hierarchy. This distinguishes PR head, merge tree, packaged artifact, and unidentified local work, and explains exactly when unit-test evidence may support a release.
2. **Transactional gate invalidation on report acceptance.** Graft the relevant/applied generation rule and acceptance-time invalidation from access pattern 8. A has watermarks, but B explicitly makes a previously green gate pending before new report parsing begins; preserve that guarantee in A's acceptance transaction.

Reject B's entire 22-operation/Proof-plan structure as a wholesale graft and reject dual review-completion truth. A change page is a valuable saved view over manifests and targets, not a reason every piece of evidence needs a new planning hierarchy. Keep ordinary case capture and ad-hoc manual work cheap.

### C: graft two ideas

1. **Deterministic suite checking.** Graft `casebook check` from §4.3, with dangling-link, duplicate-binding, missing-expected-result, and stale-binding checks generated from the same rules used by operation validation and attention queries. This gives humans and agents actionable errors without another editable status field.
2. **Canonical text interchange.** Graft `fmt` and stable step-ID-preserving Markdown parse/print from §§5.1 and 6.1 as import/export adapters with round-trip checks. They should call A's operations, rather than become another writable canonical store.

Reject automatic claim-hash proof inheritance, `reaffirm` as a way to transfer execution authority, git-shaped branches as the universal proposal model, and future external-owner mounts in the base contract. Content hashes help reads and deduplication; they do not prove what a runner executed. Also reject its argument that versioned relational storage inherently cannot make history, hashes, or exports first-class.

### D: graft two ideas

1. **An actionable shared attention queue.** Graft the queue's bounded digest, cause-grouping, affected-target links, and keyboard triage from §§6.5 and 8.2 as a derived view over A's findings, proposals, unresolved evidence, and conflicts. A triage decision must name the actual evidence set; grouping is presentation and batching, not automatic permission to excuse every similar future failure.
2. **A validated decision basis.** Graft the intent of `Decided<K>` from §7.2: selected policy-controlled constructors require an authorised, recorded decision with its policy and evidence basis. Apply this to publication, exceptions, quarantine, and freeze; do not route every record through seven question kinds and synchronous detector recursion.

Reject automatic base-failure exclusion, automatic infrastructure/flaky green, actor-insensitive slot substitution, and fingerprint holds as gate authority. Reject "never ask again" as a hard product floor and the one-question-per-cause claim when cause identity has only a normalized-message heuristic. Decision reuse should reduce reading and suggest prior dispositions while the current evidence still determines eligibility.

## Convergence and unresolved brief boundaries

All four packages reach these useful conclusions: immutable execution evidence with provenance; recorded review findings; scoped actor identities; one operation layer; optimistic capture with preserved drafts; bounded reads with hashes; batched/idempotent ingestion; a shared timeline rather than three testing tabs; policy over one model; portable data; and a first integrated human/CI/agent loop rather than a standalone case editor. These are shared design directions, not yet empirical findings.

The meaningful divergences are:

| Question | Divergence | Needed clarification or design test |
| --- | --- | --- |
| What is the daily home? | A saved question, B a change, C a suite, D a queue. | Walk author, executor, triager, and reader jobs separately; make home a configurable view before committing to one universal workflow. |
| What binds CI to a case version? | A/B prepare exact receipts/manifests; C/D stamp current state. | Decide the honest drop-in reporting contract: useful unresolved evidence is allowed, exact-version coverage requires supplied provenance. |
| What evidence can substitute? | A/B require named bindings/clauses; C offers method sets; D fills slots by case/version/target. | Test a manual accessibility requirement alongside an automated DOM check and an agent opinion; shared storage must not imply equivalent proof. |
| What survives an edit? | A/B keep exact version basis; C uses a claim/meta split; D separates placement from versioning. | Distinguish immutable history identity from an optional, explicitly evaluated reuse relation. |
| What is a small release? | A/B insist on broad integrity and layer proof; C reserves strict switches; D drops layers and regulated workflows. | Define an honest preview boundary and separate it from the repository's first-usable exit requirements. |
| How much policy is necessary? | A finite evidence rules, B clauses, C documents, D a question/authority engine. | Enumerate supported decisions and test preset workflows before adopting a general clause interpreter. |

The brief leaves provenance strength, evidence substitution, required rollout breadth, and the daily primary actor under-specified. Synthesis can resolve these explicitly; it should not average conflicting semantics.

## Challenges to repository decisions and my disposition

The table includes explicit challenges and material implicit deviations. An unanswered repository question is identified as a proposed answer rather than misrepresented as an accepted decision being overturned.

| Guidance challenged | Candidate and location | Verdict and reason |
| --- | --- | --- |
| Priority ranking, fast backend before agents before UX | A Guiding principles; B Guiding principles; C §3/§11; D §3/X1 | **Accept** correctness, security, and truthful evidence as admission floors, then retain the existing ranking among admissible designs; it never authorised false records merely to save milliseconds. |
| Latency versus tokens/decision speed | C §3 combines tokens with speed; D P2/P3 and X1 put attention above server speed | **Reject** an unqualified priority reorder; **test** decision time and tokens as additional budgets, preserving 0006's explicit rule that token savings do not buy correctness or latency regressions. |
| Backend budgets and bending principles | C §3 permits a 2x hot-path floor; B permits recorded heavy-operation budget revisions; D §3 permits expected failures for deferred principles | **Test** transparent, bounded exceptions for nonessential or heavy work; **reject** silently replacing agreed hot-path budgets or allowing an expected-failure check to legitimise unsafe evidence. |
| 0002, layered self-hosting before first usable | A/B explicitly retain all layer proofs; C §12 defers Cloud workers; D §9 is Local-only while §10 says 0002 is unchanged | **Accept** A/B's fidelity; **test** C's in-process placement only with multi-instance lease/retry tests; **reject** D's claim of unchanged compliance unless its release is explicitly a Local preview or an ADR revises the exit requirement. |
| 0002, Local files and portable storage | C §11 proposes embedded store only with file projection | **Accept** canonical documents inside the database if export is lossless; **reject** treating that as removal of local attachment storage, consistent backup, restore, or the required blob-storage interface. |
| 0003, software QA and the two profile axes | All retain software scope; C §6.1 rejects git canonical for general teams; D §9 substitutes a strict fixture for regulated delivery | **Accept** broad audience and one model; **reject** presenting a permission/quorum fixture as proof of approval-to-run, evidence freeze, release gaps, and sign-off workflows. |
| 0003, finite policy switches | D X6 replaces switches with clauses and `Ask`; B uses typed acceptance clauses; A uses typed evidence rules | **Accept** explicit authority for exceptions/quarantine as a real missing policy detail; **test** a small typed implementation behind familiar switches; **reject** the assumption that named switches necessarily cause duplicated enforcement or require a general decision engine. |
| 0004, multi-user version-checked writes | C §7.1 labels moves/tag operations commuting and §7.4 makes latest decision effective; D §6.5/§7.2 answers without an expected basis | **Reject** these shortcuts: moves conflict, opposing tag operations do not commute, and changed evidence cannot reuse stale signers; require checked heads/bases and preserve conflict candidates. |
| 0004, live/offline mechanisms | A/B retain safe queues and refetch repair; C §12 defers queued editing; D §10 says queue/run live updates are the required candidates | **Accept** deferring queued edits, which 0004 explicitly leaves open; **test** live queue/run updates, rather than treating their benefit as already established; retain durable unsent drafts and repair after missed notifications. |
| 0005, teams in general and practitioner evidence | All assert it; C emphasises coder tooling; D hardcodes its queue as home | **Accept** optional tooling and actor-specific views; **test** defaults against both strictness and organisation scale; no candidate supplies practitioner confirmation that its chosen home serves every actor. |
| 0006, reusable findings and token cost | A broad review receipts; B full `ReviewBasis`; C §11 advances findings to slice 1; D X7 makes all decisions the ledger | **Accept** early findings and basis-aware reuse; **test** broader decision context as a read optimisation; **reject** using unchanged case/claim hashes alone to skip a review of a changed relevant patch or dependency. |
| 0006, small tool vocabulary | A 17 operations with scoped discovery; B 22 behind seven tools; C 11 default tools; D ten tools/1,500-token target | **Test** complete loaded schemas and actual reference jobs; tool count and short descriptions alone do not establish lower tokens served, particularly with broad action unions. |
| Vision, one immutable version for every edit | D X2 coalesces autosaves into an open proposal and adopted versions; C uses immutable commits | **Accept** mutable private drafts and meaningful committed edit batches; **reject** mutable sealed proposals or unrecorded accepted edits, and specify when acknowledgement means durable draft versus published version. |
| Vision, moves/tags are versioned too | D §6.2 and X2 keep placement outside case versions; C §6.2 separates blob and claim | **Accept** distinct placement history only if exact historical views/export can reconstruct it; **reject** making a move unhistorical or automatically deciding it cannot affect scope, gates, or review context. |
| Vision, manual/automated/both as execution type | A replaces with bindings; B retains declared intent but derives coverage; C uses methods; D X3 derives from recent results | **Accept** B's distinction and A's richer bindings; **reject** recent human execution as the definition of manual eligibility, because it makes an unrun manual case disappear from that classification; keep declared method eligibility separate from observed activity. |
| Vision, exact executed versions for all results | A/B require preparation or explicit unresolved provenance; C §§7.2/8.3 and D §6.6 stamp at ingest | **Accept** A/B's refinement; **reject** current-head guessing, including for a known stable test identifier; the report must establish the version claim or remain unresolved. |
| Vision, case-level flakiness and quarantine | B challenge table uses binding/version/environment keys; A cohorts do likewise; C/D use broader proof/test signals, and D §4.2 excuses failures on base | **Accept** binding-level, environment-aware signals with derived case summaries; **reject** base failure or a human label as sufficient passing evidence for required release checks; **test** permissive PR policies only as explicit, scoped exceptions. |
| Vision, plans/runs as cheap views | A requires immutable manifests; B adds proof plans; C sets; D X5 uses target predicates without a plan object | **Accept** pinned obligation manifests and evidence reuse without copying cases; **test** names and navigation; **reject** unrestricted substitution or floating target predicates for frozen evidence. The existing vision already pins at run start, so a manifest is a refinement rather than a repudiation. |
| Vision, unlinked results inbox/auto-create | D X4 makes unlinked `Test` a first-class subject and mapping optional; C `ProofKey` does similar | **Accept** retaining useful unlinked evidence and optional mapping; **reject** making it satisfy named-case coverage without provenance or hiding it from automation denominators. |
| Vision, external requirement source; open question 16 | C §11 and D X9 introduce native requirements/external mirrors; A/B favour external refs | **Test** lightweight native requirements as a proposed answer to the open question; retain tracker authority for external items, source revision/freshness, and a strict boundary against building an issue tracker. |
| Roadmap, authoring before runs/CI/review | A challenge table; B challenge table; D X8; C §12 also packages these together | **Accept** a thin integrated experiment after research and stack evidence, because it tests the requested product thesis; **reject** calling A/B's broad initial packages the smallest slice or dropping mandated first-usable checks without an explicit roadmap revision. |
| Roadmap, findings in phase 2 or 3 and shared steps/custom fields early | C §11 advances findings; A/B/D delay some authoring breadth | **Accept** early findings and narrower authoring for an identified preview; **test** importer/shared-step deferral against adoption jobs, since they may be more valuable than early certificate or decision-engine breadth. |
| Stack criteria, still undecided | C §11 adds temporal/full-text/batch requirements; D X10 requires commit-order Seq and large single transactions | **Test** equivalent access semantics on competing stores; reject presuming a physical mechanism is mandatory when snapshot publication or a different query structure can meet the same contract. Neither proposal has chosen a stack. |

## Conditions for synthesis

Keep A's exact/unresolved provenance, manifests, per-actor observations, contradiction handling, bounded scope-aware reads, and replayable gates. Add B's target/attestation vocabulary and acceptance-time pending transition. Add C's deterministic checker/text adapters and D's actionable attention view/validated decision basis.

Before treating the synthesis as ready for implementation, resolve these specific contracts: one canonical evidence constructor for direct and parsed reports; an explicit completed-review operation that works with zero findings; an exact target and binding acceptance rule; a gate horizon invalidated at durable upload acceptance; basis-checked triage/expiry; and a staged release plan distinguishing preview from first usable. Test missing shards, late uploads after green, changed shared steps, moved cases leaving scope, conflicting actors, zero-finding reviews, and expired exceptions against that contract.

Only `/tmp/casebook-arena/judge.md` was written. The repository and candidate packages were left unchanged. Repository size at review was `144K`.
