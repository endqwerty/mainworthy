# Verification report, round 1

**Verdict: issues.** Revision judged: **b5f1feb9ef617235c3621c036b2fa3dd64dd847b**, against **a78b0ad**. This is a docs review, not implementation approval. The synthesis improves D's evidence honesty and reflects Daniel's capture and speed guidance, but several contracts remain inconsistent or underspecified enough to permit false green gates.

Reviewer: Codex, GPT 6.1 Sol. The synthesis identifies its author as Claude Fable 5.1, so this review uses a different provider from that author.

I ran `git show --stat b5f1feb` and `git diff a78b0ad..b5f1feb`, read the actual changed documents, the brief and judge, relevant original candidate contracts, and the existing repository decisions and competitive analysis. I confirmed all eight changed working files match the committed bytes. HEAD is the requested revision; the actual checked-out branch is `t3/modern-test-management-design`, rather than the supplied `t3/7f035a0d`. That name difference does not change the revision reviewed. The repository was clean before review.

The safety fact is that every gate qualification must be tied to identified evidence, an explicit acceptance rule, and a current processing/decision horizon. The documents state this intent, but do not yet specify enough to establish it. Runtime safety, latency, token savings and job completion are **not checked**: this repository has no implementation, and this change adds none.

## 1. Judge's synthesis conditions and D's red flags

The judge's deciding requirement is in `/tmp/casebook-arena/judge.md:215`:

> "one canonical evidence constructor for direct and parsed reports; an explicit completed-review operation that works with zero findings; an exact target and binding acceptance rule; a gate horizon invalidated at durable upload acceptance; basis-checked triage/expiry; and a staged release plan distinguishing preview from first usable."

### 1(a). Canonical evidence constructor: issues

There is one public operation, but no explicit canonical result constructor or acceptance validator shared by direct and parsed inputs.

`docs/product-design.md:648-650`:

> "Wire formats (JUnit XML, tracker payloads) are parsed by adapters before the operation is invoked; `report` takes normalised results"

`docs/product-design.md:655`:

> "op report ({ target? | run?; job?; attempt?; manifest?; results: ResultIn[] }): ReportReceipt"

`docs/product-design.md:760`:

> "function basisFor(test: Test, batch: Batch, slot: Slot | null, annotation: VersionRef | null): Basis"

`basisFor` constructs only the basis. `ResultIn` is undefined, and there is no shared constructor specifying project checks, immutable target resolution, binding checks, conflicting provenance rejection, correction authority, or publication/completeness validation. A shared operation name is useful, but does not establish the judge's acceptance boundary. Name that constructor and have both entry paths call it.

### 1(b). Completed review with zero findings: pass at the documented operation level

`docs/product-design.md:295`:

> "Record the review and what it found, in one call. A review with zero findings is still recorded."

`docs/product-design.md:656`:

> "op claim ({ lens; about?; reviewed?: `${Ref}@${Hash}`[]; findings }): { opened; known; reviewed }"

`docs/product-design.md:525`:

> "a zero-finding review writes this row"

`claim` with a nonempty `reviewed` set and `findings: []` explicitly records completion. Review is separate from execution results. Its complete basis and its qualification for review requirements still have the issues identified under checks 1(c) and 2; the zero-finding write itself is resolved.

### 1(c). Exact target and binding acceptance: issues

The stronger target vocabulary was copied, but its acceptance semantics were not.

`docs/product-design.md:493-495`:

> "what: { t: 'code'; repo: RepoId; commit: Sha; tree: Hash | null }"
>
> "{ t: 'artifact'; digest: Hash; code: { repo; commit }[]; attested: AttestationId | null }"

`docs/product-design.md:543`:

> "type TargetMatch = { commit: Sha } | { build: string; env?: string } | { line: LineId; env: string; from: Seq } | { self: true }"

`docs/product-design.md:559-562`:

> "A result counts for a slot when its `basis` names the slot's case at the pinned version ... `matches(run.accepts, result.target)`, and its producer's method is in `require.methods`."

Problems:

- `Target` has no `build` label, but the real planning example and `TargetMatch` use one. No immutable label-to-digest resolution is specified.
- Commit matching omits repository and environment. Whether code evidence may qualify for an artifact is undefined; an attestation ID alone is not an acceptance rule.
- `Slot` pins a case and version, but no required binding/test/charter. Any qualifying test linked to the case appears able to fill it. A DOM test could therefore satisfy a case whose missing obligation is a manual accessibility check.
- `Case.methods` declares eligibility, but the matcher does not consult it. `minActors` is also absent from the acceptance prose.
- Actor kind and execution method are conflated by "producer's method." An agent can execute automated tests; its actor kind does not establish what it exercised.
- The run model has no explicit exercise/review/sign-off requirement union, despite claiming to graft it.

The actual B contract makes the missing choice concrete. `b/design.md:249-251,265` says:

> "TargetRequirement = Exact {target: Target} | CodeInArtifact ... provenance: VerifiedBuildAttestationRef"
>
> "The default target requirement is exact."

The actual A contract, `a/design.md:287`, says:

> "One passing automated binding does not prove a required manual accessibility check."

The synthesis needs equivalent explicit rules, not just the target union.

### 1(d). Gate horizon at durable upload acceptance: issues

The pending transition is explicit, but the horizon and completion rule are missing, and two descriptions disagree on when parsing happens.

`docs/product-design.md:564-566`:

> "Accepting a batch for a matching open run sets its verdict to `pending` in the acceptance transaction, before parsing."

`docs/product-design.md:634`:

> "accept: batch key, raw blob, job, matching open runs → `pending` ... process in one transaction: parse"

But `docs/product-design.md:649-650` says:

> "the CLI's `report <files>` is an adapter that parses then calls it."

There is no relevant/applied generation, accepted-input watermark, outstanding-upload set or equivalent invariant in `Run`. The documented job rule is only:

> "pending until each has a processed batch on the target." (`product-design.md:563-564`)

An older processed batch can meet that rule while a newer accepted batch remains unprocessed. Processing another batch or settling a question could then re-fold the gate to green.

The slice makes this worse:

> "runs close by rule when passed" (`product-design.md:870`)

Invalidation covers only open runs, while CI reads the single run keyed by commit. A late upload after closure has no specified reopening/invalidation path.

B's original `design.md:371` explicitly compares "applied and relevant generations"; that safeguard did not survive into the synthesis's types. Define durable acceptance independently of wire parsing, retain all outstanding accepted inputs in the gate horizon, and specify late uploads to closed/frozen runs.

### 1(e). Basis-checked triage and expiry: issues, with the quorum correction resolved

The answer and quorum checks are good.

`docs/product-design.md:725,732`:

> "if (onEvidence !== q.evidenceHash) return { s: 'conflict', current: digest(q) }"
>
> "q.answers.filter(g => g.onEvidence === q.evidenceHash)"

Expiry now has an explicit commitment:

> "re-folds every run that depended on the decision, in the same transaction as the event that noticed it (ingest or a scheduled sweep)." (`product-design.md:610-612`)

But the design lacks the dependent-run relation, persisted expiry schedule/deadline, sweep lag rule, and gate freshness rule during that lag. Because gate reads compute nothing, a date-expired excuse can leave cached green until some event notices it.

`Hold` permits `this-target` and `clean`, but stores neither the held target nor a clean-run baseline/cohort. `stillHolds(d, r.basis, tx.now)` does not explain how those are established.

The slice omits the `signoff` kind while saying passed runs close by rule; that closure must still have a recorded decision under P0. This needs a named mechanism, not an implicit status write.

### 1(f). Preview versus first usable: issues

The synthesis acknowledges the Server prerequisite, which improves D's Local-only release. It still does not define two staged releases with complete exit criteria.

`docs/product-design.md:838-839`:

> "ships as the Local layer, with the same artifact proven against a server database before it is called the first usable version"

`docs/decisions/0002-layered-self-hosting.md:42-43`:

> "Server and Cloud are proven by running the same artifact against the server database before the first usable version."

`docs/product-design.md:852-853`:

> "The regulated workflow itself (gap, signoff, freeze) is not in this slice and the slice says so."

The Local slice is not explicitly named a preview. Its exit list lacks the layer, backup/restore and job-durability proofs, while the roadmap still puts Server/Cloud deployment work in phase 4. Which version is first usable remains ambiguous.

The strict fixture is now honestly distinguished from regulated workflow proof. That red flag is resolved as disclosure, not as completion of the release contract.

### 1(g). Detector-side excuses and standing: pass for removing the demonstrated detector bypass

`docs/product-design.md:752-753`:

> "const hints = [ tx.quarantine.has(r.test) && 'quarantined', ... && 'fails-on-base' ]"
>
> "hints go into the digest; a clause may answer on them"

`docs/product-design.md:739-742`:

> "const d = tx.decisions.insert"
>
> "KINDS[q.kind].effect(tx, witness(d), q)"

`docs/product-design.md:265-267`:

> "The 'failing on base' excuse is a decision row made by a rule clause ... in the ledger with the clause that settled it."

D's direct `excuse(...); continue` path is removed. Automatic rule decisions remain, but they are explicitly recorded. The unsupported slice closure and broader state ownership gaps are separate issues under 1(e) and 3.

### 1(h). Answers carry evidence basis: issues across the public contract; pass for the stored answer and answer function

`docs/product-design.md:580`:

> "type Given<K> = { ... onEvidence: Hash; counts: boolean }"

The deciding check is the equality/filter quoted under 1(e). That fixes stale-signature quorum counting.

However, the specification call site omits the required field:

> "decide({ q: 'Q-2291', answer: { is: 'defect' }, reason: ... })" (`product-design.md:309`)

The public operation has alternate forms without it:

> "{ kind; subject; answer; reason? } | { all }" (`product-design.md:662`)

The example read also supplies no question evidence hash for the agent to echo. Those alternate forms need an explicit safe snapshot/basis contract, or removal. A future implementer copying section 5 would implement an unguarded answer.

### 1(i). Wire formats out of operation contracts: issues

The `report` correction is real:

> "`report` takes normalised results" (`product-design.md:649`)

But another operation still carries importer wire formats:

> "op transfer ... { import: { from; format: 'casebook' | 'testrail' | 'qase' | 'csv' } }" (`product-design.md:675`)

That contradicts the general statement that formats stop at adapters. Define a canonical transfer/import contract and put vendor/CSV decoding in adapters. Also resolve the parsing/acceptance ordering described under 1(d). `get(... as: 'md')` is a representation choice rather than a competing evidence writer, but its adapter ownership should be stated consistently.

### 1(j). Manual pins versus CI stamping: pass for the explicit policy decision; issues in conflict validation

The synthesis does choose a contract rather than silently equating the two:

`docs/decisions/0008-one-evidence-model.md:21-29`:

> "`exact` ... `assumed` ... or `unresolved`"
>
> "loose accepts `exact-or-assumed`; regulated requires `exact`"
>
> "both are allowed, both are honest, policy chooses."

`docs/product-design.md:245` visibly prints:

> "basis: assumed ... add a version manifest for exact"

That is an explicit departure from the judge's exact/unresolved-only recommendation, recorded in 0008's alternatives. It should not be represented as preserving A verbatim, but it is an honest choice in principle.

The unsafe remaining detail is precedence:

> "if (slot) return { b: 'exact', ... }" before "if (annotation)" and the manifest branch (`product-design.md:761-763`).

A slot for v7 with an annotation or manifest naming v6 must conflict, not be relabelled exact v7. Specify that validation at the common constructor.

## 2. Internal consistency: issues

Sections 5-9 and decisions 0007/0008 share the broad thesis. These are the consequential terms/contracts that disagree or are absent:

1. **`require`, `plan`, and saved plans.** The operation exposes `require?`, and the real example supplies only methods/jobs (`product-design.md:363,660`). `Run.require` also requires `minActors` and `basis` (`537`). No defaults or policy resolution are specified. The rationale says "a plan is a saved selection" (`885`), but neither a saved Plan row nor a save operation appears. `plan` currently creates a run.

2. **`methods` and producer kind.** Canonical text says `methods: [human]` (`212`); `Case.methods` is `NonEmpty<Method>`, where auto includes tests and agent includes a charter (`440,444`). `MethodKind` is undefined. Neither `CaseBody` nor the proposal changes can set/version methods or intent (`451,459-470`), although they determine eligibility. A string shorthand needs a canonical expansion and a write/history path.

3. **`Basis` versus review/decision basis.** Result `Basis` is a tagged case/version/claim union (`506-509`). Review basis is a hash of content, fragments and relevant patch (`524`); question basis is `evidenceHash` (`574`). These are legitimate distinct concepts, but the example's `reviewed: ["C-311@a91f"]` (`297`) names the same content hash printed by impact, not a complete review-basis token. `about: "pr:482"` is mutable. Define immutable patch capture and basis construction/validation for both initial review and replay.

4. **Review requirements.** 0008 says "only a run requirement of kind review accepts them" (`45-47`); the synthesis claims "exercise/review/sign-off as distinct requirements on a run" (`product-design.md:933`). The actual Run has only methods, actors, jobs and basis. Slice E1 says "a review alone never fills a slot" (`861`), without distinguishing execution slots from review slots. Introduce the requirement union, or explicitly defer review qualification while retaining review records.

5. **`claimHash`, version hashes, and fragments.** 0008 says the version hash "identifies the document" and the claim hash includes "expanded fragments" (`63-68`). The types instead have `Step.use: CaseId` and say adopting a fragment "re-hashes its users in the same transaction" (`product-design.md:452-453`). No fragment-version pin or attributable dependent-version publication exists. After a shared step changes, an old run's case version cannot reliably reconstruct its executed expansion. The existing J12 job explicitly requires "all users updated as a new version" (`ux-research-plan.md:103`). Restore and review reuse have the same ambiguity.

6. **`onEvidence`.** Required and checked in section 7, absent from the authoritative section 5 example and alternate public variants. See 1(h).

7. **`Change`.** The same type name denotes proposal edit actions (`product-design.md:459`) and a PR/code change object (`499`). `Finding.suggest: Change` (`523`) consequently has two incompatible meanings. Rename them before implementation.

8. **`TargetMatch.build`, `self`, and `from`.** Build strings have no field/resolver in Target; `self` is mentioned as the manual fallback (`990-991`) but not defined in the acceptance rule. It presumably means results typed into this run, not proof of an identified build. The line/from form leaves open whether the boundary is observation time, ingest Seq, or target creation Seq.

9. **`Slot.best`, dispute, and independent actors.** `best` stores one outcome/test/Seq and actor kind (`547`), while the documents promise disagreement preservation and `minActors: 2`. A fold can derive those from all facts, but no selection/conflict-resolution contract or deciding question answer is supplied. The inherited KindTable from D has no distinct conflict-resolution kind. Define what resolves two authoritative outcomes and which evidence remains counted.

10. **`ResultIn`, `VersionManifest`, `AttestationId`, `GateRule`, `Charter`, and typed question kinds.** These are consequential missing definitions, not ordinary ID boilerplate. Exact provenance, target reuse, charter execution and gate policy depend on them. The design points to "Full table: candidate D §6.5, kept as written" (`572`), but that table is not in the repository; the future preset file is explicitly "once reviewed" (`618-619`). Subject/answer unions and supported predicates must be durable.

11. **Registry size.** `product-design.md:646` and 0008:79 say "seventeen operations." The actual declarations contain **18**: propose, report, claim, announce, attach, plan, decide, inbox, get, find, impact, since, history, gate, trace, check, admin, transfer. The ten MCP annotations are correct.

12. **Private drafts and the append-only floor.** `Proposal.state='open'` is amendable (`457`), an intentional exception for uncommitted draft state. P0 should distinguish it from recorded facts. More seriously, `q.answers = upsertBy(...)` (`731`) can replace an actor's earlier advice/answer; no append-only answer history is shown. Preserve every recorded answer even if a current-answer projection uses upsert.

13. **Principle exceptions versus the floor.** P2 permits "a missing surface" (`0007:53`), while F5 forbids a capability in only one surface (`169-170`). State whether dropping a whole surface is allowed while every shipped capability must remain agent-reachable. P6 permits materialisation only by the source-fact owner (`88-90`), whereas `runs.fold` owns projections over facts owned by Evidence and Decisions (`product-design.md:777-782`). Define a projection owner as an authorised consumer, or change that wording.

14. **Run closure.** Run state/freeze are written only by a signoff decision (`product-design.md:593`). Section 9 excludes signoff but closes passed runs by rule (`867-870`). The four-kind slice therefore lacks its stated closure writer.

15. **Roadmap jobs versus scope.** The revision note keeps old exit criteria "on the jobs it still covers" (`roadmap.md:67-69`), but the unchanged exit list still includes J11 and J12 (`81`), while custom fields/fragments move later. These jobs require exactly the omitted features. The qualification reduces the conflict but leaves the operative list ambiguous.

The most material disagreements are acceptance/completeness, fragment immutability and decision lifecycle. They need explicit choices before code; they are not cosmetic pseudotype omissions.

## 3. Brief's architectural red flags: issues

- **Shallow modules: risk remains.** "views ... stateless; reads others' public readers" (`product-design.md:776`) fronts multi-owner joins, and `admin (...)` (`674`) has no defined hidden responsibility. The design has not demonstrated shallow implementations, but depth is not proven by a short operation count.

- **Information leakage: present.** `transfer.import.format` leaks vendor wire formats (`675`); target/binding qualification is spread among methods, TargetMatch, policy, basisFor and Slot.best. The undefined build resolver and evidence constructor force callers or multiple owners to reconstruct the same rules.

- **Temporal decomposition: no demonstrated violation in the proposed module map.** Modules are grouped by owned knowledge, such as "suite ... owns Case, Version, Proposal" and "evidence ... owns ... Result" (`780-782`). Accept/process are lifecycle stages, not separately named knowledge owners. Enforcement in code is **not checked**.

- **Pass-through methods: no demonstrated chain.** `invoke` authorises, validates and provides idempotency (`691-696`); that is a meaningful boundary. The stateless read wrappers remain a design risk, not evidence of a needless service chain.

- **Split ownership: present.** The map says Decisions "owns ... Policy" (`777`) and Suite also "owns ... gates, charters" without Policy listed, but Policy is among Suite's adopt standing effects (`588`). Effect orchestration can legitimately call the owner; P6's source-owner-only projection rule is the actual conflict. Expiry spans Decision holds, Evidence excuses and Runs' cached verdict with no persisted dependence/horizon protocol. Immutable fragment expansion is similarly spread across head hashes and version reads.

- **Two ways to do one task: risk remains.** `decide` has q+basis and kind/subject/all forms without basis (`662`). Import/replay must use owner constructors, but `transfer` does not state whether imported history is validated replay or a new policy bypass. Parsed reports versus durable raw acceptance also describe two incompatible entry orderings.

- **Importable internals: prohibited in the design, enforcement not checked.** "shells cannot import internals (a lint fails the build)" (`791-792`) is an explicit plan; there is no lint or code yet.

- **Hand-synced lists/relations: risk remains.** `OPS` and `KINDS` are described as exhaustive, but the documented operation count already differs. The KindTable is left in temporary candidate material. "every hop keyed both ways" (`638`) is not backed by declared reverse result-by-signature/target/defect keys; the impact path needs base/head result access while Result declares only test/Seq and batch/outcome keys (`516,636`). Question-by-subject/revision and queue rank are also used without corresponding complete declarations. The missing structures are exactly the brief's "add an index later" risk.

## 4. Daniel's guidance: pass as intent and principle ordering

`docs/decisions/0007-guiding-principles.md:13-18` faithfully records the guidance:

> "speed stays a must-have priority, measured where it matters: observable, practical speed"
>
> "getting the contents of a tester's head into artifacts; that must get faster"
>
> "A working product is not enough; it must be a better product."

P0 is an admission floor:

> "Never bent ... above the floor, speed decides." (`31-32`)

P1 makes capture the first hot path:

> "Capture is the first hot path, because moving knowledge from a tester's head into an artifact is the job." (`38-39`)

The floor requires measurable superiority:

> "It is not measurably better than the incumbents on the capture, execution and triage jobs ... Working is not enough." (`165-167`)

The product gives that intent observable commitments: L1 specifies "key-to-caret and key-to-paint ≤ 100 ms p95," L2 kills the tab mid-sentence and checks recovery (`product-design.md:98-99`), and Suite is home "because capture is the job" (`808-809`). The bend rule explicitly forbids bending P0, P1 on hot paths, or P3 (`0007:152-153`).

These express speed as a must-have above an integrity floor. The ≤100 ms p95 budget is a draft operationalisation, not proof that the brain literally never waits. Actual measurements and comparative capture outcomes are **not checked**.

The acceptance gaps elsewhere could violate that floor during implementation; the principle ordering itself is faithful.

## 5. Honesty and existing decisions: issues

### Draft numbers, measurement and implementation

**Pass for the design's budget provenance.**

`docs/product-design.md:5-7`:

> "a sketch, stack-neutral, written before any code ... Numbers are draft budgets"

`README.md:7-10`:

> "No language, framework, database or hosting is chosen yet"
>
> "Nothing here is built"

`product-design.md:768` marks the tricky pure bodies "not implemented." Example CLI output is under a specification/quickstart section, not presented as a measured run.

**Issues for blanket "every number marked draft."** The design has a global draft disclaimer, but 0007's "at most 2x," "At most three bends," and five-minute floor (`144,154,171-172`) have no numerical draft label. Its overall status is "proposed," which is honest but is not the literal requested label. Open question 25 proposes 14 days/20 clean runs/5 clean runs (`open-questions.md:34`), but the Hold union supports only one stopping condition, not the described "or" composition. Identify normative limits separately from proposed budget/default numbers rather than labelling historical counts or example IDs as draft.

No runtime benchmark, implementation or comparative job evidence is claimed to have been collected for the synthesis. Those checks are **not checked**, appropriately.

### Competitor labels

**Issues.** The money table mostly preserves Verified/Reported/Hypothesis distinctions and explicitly names the Testmo counterexample:

> "Testmo's flat tiers are the counterexample." (`product-design.md:50`)

> "V (exist), H (shape; phase 0 audit)" (`56`)

But a previously flagged unsupported claim remains outside that table:

> "The incumbents cannot report any of these." (`product-design.md:62`)

There is no support or H label for that universal assertion. The rationale also states that incumbents model one producer well, one "as an import and the third not at all" (`959-960`) without the table's hypothesis qualification.

M8 bundles "Kiwi and TestLink dated" into a V row (`57`), although TestLink's actual entry is "Reported" and says "Confirm ... before citing" (`competitive-analysis.md:174-176`). Separate verified hosting facts from reported UX judgements. I checked against the repository's dated research; fresh vendor verification is **not checked**.

### Stack

**Pass.** The diff changes only eight Markdown files. The design explicitly says:

> "Types are TypeScript-like notation, not a stack choice." (`product-design.md:6`)

0001 remains open; no language, framework, database, build system or manifest was added.

### Decisions 0002, 0004, 0005

**0002: issues in release reconciliation.** The Server-database prerequisite is stated, so it is not silently dropped. But 0002 also names Server and Cloud before first usable (`42-43`) and requires crash-safe jobs and checked backup/restore (`46-60`). Section 9 does not carry these into its exit checks or distinguish a preview, and roadmap phase 4 still owns the layer deployment proof. A stack benchmark against a server database is not by itself multi-user/layer/backup proof. State the exact pre-first-usable checks and phase.

**0004: pass for the chosen collaboration/offline direction, issues in complete write contracts.**

> "disjoint fields merge; the same field is a conflict, both versions kept and shown side by side" (`product-design.md:355-356`)

This agrees with 0004, and no live text co-editing or full offline replica is introduced. The missing `onEvidence` call-site guard, unspecified command envelope (`invoke` uses `input.cmd` but operations do not declare it), and edits such as `Change.state` without a checked base leave some concurrent writes less specified than 0004 requires. Durable drafts are promised; their implementation is **not checked**.

**0005: pass for audience/provenance.**

> "Home is Suite because capture is the job; a user whose day is triage sets Queue as home." (`product-design.md:808-809`)

Open question 20 asks "From your experience across team sizes" (`open-questions.md:29`), rather than treating Daniel's team as the customer. No new actual-team defaults are justified by his personal workflow. Coverage of both organisation scale and strictness still needs research; it is not asserted as measured.

## 6. Repository hygiene: issues, mostly editorial

- **README index: pass.** Lines 28-30 index the product design and both new decisions; every local Markdown link in the eight changed files resolves to an existing file/directory. The synthesis's self-anchor also has a matching heading.

- **CHANGELOG entry: issues.** The entry exists and describes the design and decisions, but says "open questions 20 to 27 added" (`CHANGELOG.md:13`), while 28 was added too. It also says "roadmap phase 2 and 3 revised"; only the phase-2 revision note changed, while phase 3's old description remains.

- **Question numbering: pass; cross-references: issues.** The actual numbered sequence is exactly 1-28, continuous and unique. Question 28 asks to confirm the principle order/floor (`open-questions.md:37`). `product-design.md:1027` still says "(20 to 27)." Update both that and the changelog.

- **Roadmap note: pass for presence, issues for reconciliation.** `roadmap.md:59` names decisions 0007/0008 and design section 9. Its note says "gates ... move to phase 3" (`66`) despite including a four-verdict gate in phase 2. It needs to say release gates and rewrite the obsolete job/phase lists described in check 2.

- **Vision superseded note: pass for presence, issues for count.** `product-vision.md:222-229` points to 0007 and says the original draft is kept for history. It says "ten principles," but P0-P10 contains eleven. This is a count error, not a changed integrity ranking.

- **Durable references: issues.** Clickable links resolve, but the normative KindTable/presets refer to candidate D and the not-yet-written `docs/ux/policy-presets.md` (`product-design.md:572,618-619`). Temporary arena material cannot be the only definition of supported answers/policy. The future file is honestly marked future, so this is a missing contract rather than a broken clickable link.

- **Whitespace: issues, minor.** `git diff --check a78b0ad..b5f1feb` exits 2 and reports:
  > "docs/open-questions.md:38: new blank line at EOF."

- **Secrets: pass within the inspected scope.** Manual inspection and scans of the eight changed files found no private-key headers, recognizable GitHub/AWS/OpenAI credential patterns or credential-bearing URLs. `CASEBOOK_TOKEN` appears only as a CI secret reference:
  > "${{ secrets.CASEBOOK_TOKEN }}" (`product-design.md:230`)
  Example loopback/example-domain URLs and placeholder IDs are not credentials. This is not a guarantee against every possible secret encoding.

The exact mechanical checks returned:

```text
REVISION_MATCH [all eight changed files] True
LINK_SCAN_DONE [no BROKEN_LINK output]
OPS 18
MCP_TOOLS 10
QUESTIONS [1 through 28] CONTIGUOUS True
SECRET_PATTERN_SCAN_DONE [no SECRET_PATTERN_MATCH output]
STATUS ''
```

## Three weakest points to try to break

1. **Evidence substitution and immutable basis.** Plan a manual accessibility obligation and link an automated DOM test to the same case. Upload its pass on a build label. The documented matcher allows case/version/method membership but lacks the named binding, immutable build resolution and independent-actor rule. Then change a shared fragment: an old pinned version contains only a fragment CaseId, so its exact expanded content is no longer established. These are the first places an implementer copying the types will accidentally make shared storage mean shared proof.

2. **Gate lifecycle under concurrent and late input.** Start green, accept uploads A and B for the same job, process A first, and settle a question while B is pending. The types contain no horizon preventing green. Next close the run because it passed, then upload C containing a failure: acceptance invalidates matching open runs only. Finally let an excuse expire without new ingest. A no-computation gate read has no stated freshness test for any of these cases.

3. **Decision basis and complete public contracts.** Copy section 5's `decide` call, which omits `onEvidence`; combine it with section 7's kind/subject or all variants and a changing digest. Then implement hold expiry, conflict resolution and rule closure from the four-kind slice without the durable KindTable or a signoff writer. The document's strongest guarantees require machinery that the copyable examples and slice do not expose.

These are design counterexamples, not executed failures. Add them to the phase-1 prototype checks alongside missing shards, zero-finding reviews, moves leaving scope and conflicting actors. The judge explicitly required those failure cases; the current listed fixtures do not cover them all.

## Did the synthesis choose, or quietly average?

The assumed-basis policy is an explicit choice in 0008, not a quiet average. It records a third kind and makes policy qualification visible. Likewise, configurable home, review separate from execution, and decision-only excuses are real choices.

Three other tensions were left as combinations of words rather than resolved contracts:

- **A's binding-specific proof versus D's interchangeable slots.** The synthesis says "A's evidence semantics as the invariant layer" (`product-design.md:916`), but the Slot/matcher retains D's case/version substitution without A's binding pin or B's qualifying-binding clauses. Adding an exact/assumed label does not resolve which observation proves which obligation.

- **B's generation-aware invalidation versus D's cached verdict.** The synthesis claims acceptance-time invalidation from B (`933-934`) while keeping a verdict row with no applied/relevant horizon and closing passed runs. A one-time pending assignment is not B's freshness contract.

- **C's expanded claim identity versus A's immutable exact versions.** The synthesis retains current-fragment rehashing while describing versions as immutable exact execution documents. It chooses neither pinned fragment versions nor attributable dependent-version publication. Similarly, the proof strip says "✓ proven on the current claim" (`805-806`) without exposing assumed basis, while 0008 says a claim hash "never transfers proof by itself" (`68`). The UI's proof wording needs a defined qualification/basis rule.

The release boundary is also unresolved: D's Local experiment is described beside 0002's first-usable prerequisite rather than as a named preview followed by an explicit first-usable milestone.

**Disposition:** keep the synthesis as a proposed design, but do not mark all checks passing or treat its evidence/gate contracts as ready for implementation. Resolve the acceptance constructor, binding/target rules, fragment pins, processing/expiry horizon, basis-bearing decide forms and staged release boundary. The editorial count/reference fixes are smaller but should accompany that revision.

Only `/tmp/casebook-arena/verify-r1.md` was written. No repository files were changed.
