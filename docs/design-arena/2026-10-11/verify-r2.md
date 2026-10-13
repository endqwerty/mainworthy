# Verification report, round 2

**Verdict: issues.** Revision judged: **4d29392495e3dd62da2b7b8aebb8fd00832653da**. Whole change reviewed: **a78b0ad..4d29392**. Round 1 reviewed b5f1feb.

Reviewer: Codex, GPT 6.1 Sol. The design attributes the synthesis to Claude Fable 5.1 at product-design.md:1063. This is an independent documentation review, not approval of an implementation.

I read /tmp/mainworthy-arena/verify-r1.md first, ran the requested diff stat, read all eight changed files in full, and checked the relevant existing decisions, research jobs, competitive-analysis labels, original brief and judge requirements. All eight working files match the requested commit. The repository was clean before review and remains clean. I did not read the author's fix scripts or reasons.

The safety fact is that a gate may qualify evidence only for the stated obligation, immutable basis and target, with all relevant accepted inputs applied and all depended-on decisions still current. The revision makes much of this explicit. It still leaves contradictory instructions and a faulty basis branch that an implementer could copy. Runtime correctness, latency, tokens, persistence, backup and restore are **not checked** because there is no implementation in this change.

References below are repository-relative, with line numbers in the new revision. "Resolved" includes earlier passing findings that remain passing. Risks without demonstrated misleading contracts are reported separately from blocking issues.

## 1. Findings that still need correction

### R2-1. Agreeing exact provenance is downgraded to assumed

product-design.md:899-903:

> "if (claims.length > 1 && !allEqual(claims)) return Rejected('BasisConflict', claims)"
>
> "if (claims.length === 1) return { b: 'exact', ...claims[0], claim: claimOf(claims[0]) }"
>
> "if (test.case) return { b: 'assumed', case: test.case, version: head(test.case), claim: claimOf(head) }"

Slot v7 plus manifest v7 has two equal claims. It passes the conflict test, misses the exact branch and gets the current head as assumed. If the head is now v8, even the version changes. Three agreeing sources do the same. An unmapped test with an explicit agreeing slot and annotation can instead fall to unresolved.

This breaks 0008:21-24's exact-basis contract. Reject disagreements, then use the common claim whenever the set is nonempty. Tests must cover zero, one, two agreeing, three agreeing and disagreeing sources. The disagreement correction itself is good.

### R2-2. The horizon does not specify a contiguous applied watermark

product-design.md:637-644:

> "sets `horizon.accepted` on every run whose `accepts` matches the batch's target"
>
> "`runs.fold` advances `applied` only after the batch's results, signals and questions are applied, in that transaction"
>
> "The gate read compares the two and returns `pending` while they differ"

0008:50-53 similarly says:

> "processing advances `applied`"

Accept A at Seq 10 and B at Seq 11. Process B first, advancing applied to 11 as the stated per-batch rule permits. The two stored values are now equal, but A is still unprocessed. A decision event can fold the visible passes to green. The existence of Batch's accepted-state key at :524 does not prescribe how a scalar watermark accounts for this hole.

E5 at :1010-1013 checks the first batch processed before the second; it does not test the inverse order. Define applied as covering *every relevant accepted batch through that watermark*, with a pending set/count or a safe watermark advancement rule. Alternatively mandate enforced processing order and its recovery behavior. This is a missing concurrency contract, not a claim that an implemented service currently fails.

There is also a surviving opposite ingest description at :764:

> "accept: batch key, raw blob, job, matching open runs → `pending` ... process in one transaction: parse"

It disagrees with normalized staging before acceptance at :778-784 and with closed-run handling at :639. Replace that access-pattern row with the new boundary.

### R2-3. Reopening a closed run bypasses its sole standing writer

product-design.md:572 and :704:

> "state: 'open' | 'closed' ... // WRITER: the effect of a signoff decision"
>
> "Run.signoff, state, frozen ← signoff"

But :639-640 says:

> "open or closed-but-not-frozen (a closed run is reopened `pending`)"

A batch acceptance transaction cannot both directly reopen state and preserve the declared decision-only writer. Pending invalidation is a projection change; reopening the signed-off lifecycle is standing. Specify a recorded signoff supersession/reopening effect, or leave state closed while exposing a fresh pending gate and define how the next signoff replaces the old one. This directly affects P0 and the promised audit trail.

### R2-4. The subject form of decide still lacks a caller-observed basis

product-design.md:798-800:

> "{ q; onEvidence: Hash; answer; reason?; supersede? }"
>
> "| { kind; subject; answer; reason? } // opens and answers in one transaction; onEvidence = the digest computed there"

0008:67-70 says:

> "An answer names the evidence hash it was given on; every form of `decide` carries it"

Generating a current hash in the transaction does not establish that the answerer saw that evidence. A caller can form an answer on an old digest, use kind/subject after it changes, and have the server attach the new hash. No restriction prevents this form from targeting an existing fingerprint; no separate caller acknowledgment or snapshot token is defined.

Require a caller-observed hash for this form too, or constrain it to genuinely new questions with fully supplied immutable evidence and a defined rejection rule for existing questions. Atomicity avoids a race within the transaction, but does not solve stale advice entering the transaction. q and all forms are repaired.

### R2-5. Requirement now names two different contracts and IDs

product-design.md:484:

> "type Requirement = { id; ref; project; title; source: ExternalRef | null; state; rev: Seq }"

product-design.md:584-589:

> "type Requirement = ... kind: 'exercise' ... | ... kind: 'review' ... | ... kind: 'jobs' ... | ... kind: 'signoff'"

These mean a requirements-tracker document and a run obligation respectively. RequirementId is consequently used both in Covers (:485) and Slot.requirement (:593), and the gap subject at :670 is ambiguous. This is the same consequential type-name problem that was fixed for Edit versus Change, introduced under a different name. Rename the run contract and its ID, and update GateRule, Run, plan and gap.

The copyable input examples also remain incompatible with their canonical types. At :385-387, report sends a result with a top-level case. ResultIn at :526-527 requires test, with the manual case nested as test: { case }. Finding suggestions at :302-306 have expected or case at the top level, but Finding.suggest at :554 is Edit, whose variants require op at :467-479. Section 5 explicitly calls these examples "the specification" at :133. Choose and document one normalization boundary or make the examples use the canonical inputs.

### R2-6. Slot conflict retention and agent charter eligibility remain incomplete

product-design.md:595:

> "fills: Fill[] // bounded (<= 16)"

product-design.md:627-631:

> "at least `minActors` distinct actors have a counted pass and no counted fail is uncorrected"
>
> "a counted fail beside a counted pass from another actor is `disputed` ... never averaged"

There is no safe retention/folding rule for 17 or more qualifying results. A bounded projection is reasonable, but satisfaction cannot depend only on a truncated fills array that discards an uncorrected failure. Say explicitly that the verdict folds the complete effective evidence set and that the bounded list is presentation only, or define lossless aggregate state.

The new matcher handles human versus auto and named automated bindings well. For agents, Method declares a charter at :447, but qualifications at :622-626 check only the method kind and automated tests. Result and Batch carry no charter reference, and an exercise requirement cannot name one. Therefore evidence from an unrelated agent attack charter can fill an agent-eligible case merely because its declared kind is agent. Either make charter a qualification input when it determines eligibility, or state that charters are advisory and do not constrain execution proof. The design currently records a charter in eligibility without specifying what it controls.

### R2-7. Rule-only Preview signoff disagrees with the shipped standard preset

product-design.md:677-678 correctly provides a decision closure mechanism:

> "the loose preset's rule answers it the moment the verdict is `passed`"

The normative preset table at :749 says:

> "signoff (close) | rule: approve when passed | role lead | 2 approvers, reason; freeze"

But Preview ships loose and standard with rule-only signoff at :990-998, and :1026 says:

> "runs close by the loose and standard rules"

The standard preset has a lead answer, not a rule. Scope cuts are allowed, but an implementer needs an explicit Preview standard clause override, its name and its supersession boundary. Otherwise following the full standard table adds a role path explicitly excluded from the slice, while following the slice silently changes standard's authority.

E1 at :1005-1006 also says "a review alone never fills a slot", while :633-635 defines review slots that a review fills. Narrow E1 to an exercise slot, as E7 already does at :1016.

### R2-8. The first usable contract is repaired in the design but not fully in the roadmap

product-design.md:979-983:

> "It is named **Preview 1** and ships as the Local layer only."
>
> "first usable ... phase 3 ... the Cloud multi-instance proof with the cache disabled"

This respects decision 0002:42-43's Server and Cloud prerequisite. The roadmap's inserted phase-2 note brings Server, jobs and backup/restore to phase 3 at :68-70. However, Cloud is absent there and from phase 3's operative exit criteria at :99-101. Phase 4 remains titled "Server and Cloud layers" at :103 and still carries the multi-layer job suite and restore exits at :112-115.

Place the pre-first-usable Cloud proof and all required layer/job/backup/restore checks into phase 3's operative exit list, and distinguish phase 4's later scaling/storage work. The new Preview label is clear; the remaining problem is two different phase/check allocations, not absence of the release distinction.

## 2. Round 1 conditions, 1a to 1j

- **1a, canonical constructor: resolved at the documented boundary; implementation unproven.** :528-532 names "evidence.acceptResult(ctx, batch, slot ... in: ResultIn)" for "every result from every entry", with immutable target, basis conflicts and correction authority checks. :813 requires import replay "through the owners' constructors under policy". The input-shape mismatch in R2-5 remains, but the missing constructor itself is supplied.

- **1b, completed review with zero findings: resolved, remains passing.** :296 says "A review with zero findings is still recorded"; :559 says "a zero-finding review writes this row". 0008:56-59 repeats the contract.

- **1c, exact target/binding acceptance: still open in part.** :510 binds a build label immutably; :513-514 requires opt-in attestation for code-in-artifact; :617-626 checks repository, commit, optional environment, case eligibility and automated binding; :627 requires distinct actors. These resolve the named build, repository, manual-versus-DOM and actor/method findings. Agent-charter eligibility and lossless conflict folding remain open under R2-6.

- **1d, acceptance horizon: still open.** :573 supplies accepted/applied; :637-644 includes closed and frozen runs; :647-649 supplies the expiry freshness comparison. Those are improvements. Out-of-order completeness, the old raw-parse row and decision-only reopening remain open under R2-2/R2-3.

- **1e, triage/expiry: resolved for dependency tracking and freshness; still open for lifecycle consistency.** :600 defines DependsOn; :647-650 makes gate reads pending at expiry before a persisted sweep; :693-695 persists hold terms with target, baseline Seq and test. :677-678 makes closure a recorded signoff. R2-3/R2-7 still contradict the lifecycle/preset contract. Quorum repair remains intact at :870: "latestPerActor(q.answers).filter(g => g.onEvidence === q.evidenceHash)".

- **1f, Preview versus first usable: still open only in roadmap reconciliation.** :979-983 explicitly names Preview 1 and requires Server, crash-safe jobs, backup/restore and Cloud before first usable. Roadmap :99-115 still allocates the layer proofs differently. See R2-8.

- **1g, detector-side excuses: resolved, remains passing.** :890-891 places quarantine/base-failure hints in the digest; :880 makes a decision witness the sole standing effect call; :714-717 expressly says detectors suggest and the excuse is a decision.

- **1h, answer evidence basis: still open for the subject form.** The authoritative example at :310 now echoes onEvidence: "e7c1"; the all form at :800 requires each hash; :863 rejects stale q answers. The server-generated hash for kind/subject at :799 does not prove caller-observed evidence and conflicts with 0008:68. See R2-4.

- **1i, wire formats out of operations: still open in one contrary trace.** :778-784 clearly puts vendor parsing in adapters and acceptance after normalized staging; :813 accepts a canonical archive, with policy replay. Those repair report/transfer signatures. :764 still accepts raw before parsing and considers only open runs. See R2-2.

- **1j, manual pins versus CI stamping: regressed in the common basis constructor despite the conflict fix.** :899-900 rejects conflicting slot/annotation/manifest claims, resolving the former precedence bug. :901 accepts only exactly one claim, incorrectly downgrading agreeing multiple exact sources. 0008:21-29 still honestly states exact/assumed/unresolved as a policy choice. See R2-1.

## 3. Round 1 consistency items, 1 to 15

1. **require, plan, saved plans: resolved.** :476 adds an Edit.set saved-selection document; :571 says requirements come from policy defaults, GateRule or plan; :796 accepts Selection or SetId and an optional requirement list or GateId. :364-365 shows the expanded list, though the run-contract name collision is a new problem under R2-5.

2. **methods versus producer kind: resolved for the original missing definitions and write path.** :446 defines MethodKind; :455 versions methods and intent in CaseBody; :456 expands the human shorthand; :520 validates declared method against actor kind; :539 carries both actor and method. Agent-charter qualification is still open under R2-6.

3. **execution basis versus review basis: resolved as a documented construction, implementation unproven.** :556-558 computes review basis from pinned version hash, patch tree and charter hash if any; "the server, not the caller, decides the basis". :298 adds an immutable patch SHA and :313-314 says a changed patch invalidates review. Initial creation and re-review can no longer rely on mutable PR text alone.

4. **review requirements: resolved in the model; one contradictory fixture remains.** :587 provides a review requirement; :633-635 separates Review from runtime Result qualification. E1's "never fills a slot" at :1005-1006 is still too broad. See R2-7.

5. **claimHash/version/fragments: resolved.** :457 pins fragment and version; :459-461 publishes attributable dependent versions via adopt and preserves old pins; :494-495 guarantees unchanged expansion. 0008:78-87 limits claim hash to a reuse signal/policy option, with no automatic proof transfer. :945-947 now ties the proof glyph to the current version and counted basis. An old exact run can reconstruct its expansion.

6. **onEvidence: still open for one public form.** :310 and :800 are repaired; :799 and 0008:68 disagree. See R2-4.

7. **Change type collision: resolved, with a new analogous regression.** :467 calls proposal actions Edit, :516 keeps Change for code/PR metadata, :554 uses Edit for suggestions. Requirement is now declared twice at :484/:584. Suggestion examples are still not Edit inputs. See R2-5.

8. **TargetMatch build/self/from: resolved.** :510-511 supplies immutable build identity; :582 defines from as batch.seq; :583 restricts self to results typed into the run and says it proves nothing about a build.

9. **Slot.best, dispute, independent actors: still open in part.** :595 replaces best with fills; :627-631 names distinct actors, uncorrected failures and disputed outcomes; :667 supplies resolve/trust. This resolves single-best/last-write and the missing decision answer. The <=16 bound has no safe conflict-retention rule. See R2-6.

10. **missing consequential definitions and durable kind table: resolved for the named types/table.** :512 defines Attestation; :525 VersionManifest; :526 ResultIn; :481-482 GateRule and Charter; :657-676 contains the normative closed KindTable; :728-749 contains a normative draft preset table rather than delegating it to /tmp. Predicate's closed vocabulary is still a planned registry, not an implemented or fully enumerated one; that is a design limit, not evidence of a current bypass.

11. **registry size: resolved.** :776 says "Eighteen operations", :825 says "eighteen entries", and 0008:98 says "eighteen operations, ten agent tools". Counts below match.

12. **drafts and append-only answers: resolved.** 0007:31-32 excludes private open drafts from recorded facts; :465 does the same. :683 says answers are append-only; :869 pushes, and :870 derives the latest per actor rather than overwriting earlier answers.

13. **exceptions/floor and projection ownership: resolved.** 0007:55-57 permits an absent whole surface but requires API/MCP reachability for a shipped capability; F5 at :175-176 forbids UI-only capabilities. 0007:93-95 permits one named projection owner consuming other owners' facts; product-design :926-928 assigns run projections to runs.

14. **run closure writer: resolved as a mechanism; still open in new lifecycle and preset uses.** :677-678 makes signoff(close) the common closure path; :990-992 includes rule-only signoff as the fifth Preview kind. R2-3 and R2-7 identify the surviving contradictory uses.

15. **roadmap jobs versus scope: resolved for J11/J12.** Roadmap :71-72 explicitly says "J11 and J12 below no longer apply to phase 2; they move to phase 3". It also names release gate rules at :67, resolving the four-verdict-versus-release-gates confusion. R2-8 is a separate remaining phase allocation problem.

## 4. Round 1 architectural red flags

- **Shallow modules: unchanged risk, no demonstrated violation.** :914 still says views are "stateless; reads others' public readers"; admin at :812 remains a sketch. No implementation exists to assess depth. A short registry is not depth evidence, but this alone is not a blocking finding.

- **Information leakage: wire-format leak resolved; contrary ingest trace still open.** :778-784 moves report/vendor parsing outside operations and :813 uses the canonical archive. :611-613 names one qualification function. :764 still disagrees with the new ingest boundary. R2-2/R2-5 address implementer-facing contradictions.

- **Temporal decomposition: resolved, remains no demonstrated violation.** :915-922 groups modules by owned knowledge, such as Suite versions and Evidence results, rather than accepting/processing stages. Enforcement is not checked.

- **Pass-through methods: resolved, remains no demonstrated chain.** :829-834 validates, authorizes and deduplicates writes in invoke. Read wrappers may still be shallow when implemented; nothing here proves a needless chain.

- **Split ownership: original Policy/projection ambiguity resolved; lifecycle writer still open.** :919 explicitly says "Policy is owned by decisions; adopt calls its writer"; :926-928 names the projection owner; :600 defines dependencies. Reopening at :639 conflicts with signoff-only state at :572/:704. See R2-3.

- **Two ways to do one task: still open in the basis-free decide form and contrary examples.** :799 supplies a generated hash rather than a caller basis; :385 and :526 describe incompatible manual report inputs. Canonical transfer replay at :813 resolves the original unspecified import bypass. See R2-4/R2-5.

- **Importable internals: resolved as an explicit prohibition, enforcement not checked.** :931-932 says "shells cannot import internals (a lint fails the build)". No lint exists yet.

- **Hand-synced lists/relations: operation count and durable KindTable resolved; complete index coverage remains unproven.** :546 adds target/test and signature/Seq keys; :687-688 adds question subject and revision keys. :768 still promises "every hop keyed both ways"; the sketch does not demonstrate every reverse trace index, including a decision's external defect reference. Treat that as a phase-1 key-coverage check, not proof that a missing runtime index has already been added later. The bounded fill semantics are a separate real contract gap under R2-6.

## 5. Guidance, honesty and existing decisions

- **Daniel's speed/capture guidance: resolved, remains passing as intent.** 0007:13-18 records practical speed, capture and "a better product"; :33-34 puts speed above the integrity admission floor; :40-41 makes capture first. :157 prohibits bending P0/P1 hot paths/P3; :171-173 requires measurable superiority. Product-design :99-100 provides input-to-paint and crash-recovery checks. Measurements remain not checked.

- **Draft numbers and implementation status: resolved.** Product-design :5-7 says "a sketch ... before any code" and "Numbers are draft budgets"; :906 explicitly says the pure functions are "not implemented". README:7-10 says stack undecided and nothing built. 0007:149-150 labels 2x a proposed limit, :159 labels three bends a proposed limit, and :177-178 labels five minutes draft until measured. These distinguish proposed normative limits from runtime measurements.

- **Hold-window composition: resolved; clean-run cohort semantics still need implementation specification.** :693 says the hold ends when any term ends; :694-695 stores basis, target, date, baseline Seq and test. This can represent question 25's "or" conditions. Question 25 asks for clean trunk runs; the pseudotype does not yet enumerate the clean cohort rule. Do not infer successful clean-run expiry implementation from this review.

- **Competitor-label honesty: resolved.** :62-63 now says "Hypothesis ... no incumbent reports these numbers"; :1117-1119 labels the producer-model claim a phase-0 hypothesis; M8 at :57 separates verified higher-tier hosting from reported dated open-source UX. This review checks consistency with the repository's research labels. Fresh vendor facts, prices and hands-on UX claims are not checked.

- **Stack remains open: resolved, remains passing.** All eight changed files are Markdown; :6 explicitly says TypeScript-like notation is not a stack choice. No language, framework, database, build manifest or dependencies are introduced.

- **Decision 0002: still open only in roadmap reconciliation.** Design :979-983 now names Preview and requires Server/Cloud/job/backup/restore proof before first usable. Roadmap :99-115 still leaves some proof in phase 4. See R2-8. The release boundary itself is repaired.

- **Decision 0004: base fields and command envelope resolved; stale subject-form decisions remain open.** :467-479 adds bases to the previously named existing-state edits; :784-786 declares the client-generated command envelope; :356-357 preserves side-by-side conflicts. q/all answer forms preserve caller bases; subject form does not. See R2-4. Durable drafts, offline behavior and concurrency are not exercised.

- **Decision 0005: resolved, remains passing.** :949-950 chooses Suite for capture while allowing Queue home; open-questions:29 asks "From your experience across team sizes". No actual-team default is asserted as research. Two-axis profile coverage still awaits phase-0 research.

## 6. Hygiene findings

- **README index: resolved, remains passing.** README:28-30 links the design and both new records. All 29 local clickable Markdown destinations in the changed files resolve; the synthesis anchor resolves too.

- **CHANGELOG description: resolved.** CHANGELOG:13 now says "open questions 20 to 28 added" and "roadmap phase 2 revised ... (Preview 1) with first usable in phase 3". It no longer claims an unmade phase-3 text revision.

- **Question numbering and references: resolved.** open-questions:29-37 runs through 20-28; product-design:1186 now says "(20 to 28)". The complete sequence is unique and continuous, 1-28.

- **Roadmap note: J11/J12 and release-gate distinction resolved; layer-proof allocation still open.** Roadmap:67 names "release gate rules"; :71-72 explicitly moves the unsupported jobs. See R2-8 for Cloud and phase-3 exits.

- **Vision superseded note/count: resolved.** product-vision:222-229 points to 0007 and says "eleven principles (P0 to P10)" while preserving the old draft for history.

- **Durable normative references: resolved.** :657-676 supplies KindTable and :728-749 supplies the normative draft preset table. The future policy-presets file is a future supersession, not the only current definition. Synthesis-history references to the old /tmp brief are provenance, not required implementation definitions.

- **Whitespace: resolved.** git diff --check a78b0ad..4d29392 exits 0 with no output.

- **Secrets: resolved, remains passing within inspected scope.** The private-key, GitHub-token, AWS-access-key, OpenAI-key and credential-URL scan finds no matches. :231 uses "${{ secrets.MAINWORTHY_TOKEN }}" as a CI reference, not a credential. This does not guarantee detection of every encoded secret.

## 7. Exact mechanical outputs

Requested command: git diff a78b0ad..4d29392 --stat. Exit 0:

```text
 CHANGELOG.md                              |    1 +
 README.md                                 |    5 +-
 docs/decisions/0007-guiding-principles.md |  202 +++++
 docs/decisions/0008-one-evidence-model.md |  138 ++++
 docs/open-questions.md                    |   15 +-
 docs/product-design.md                    | 1200 +++++++++++++++++++++++++++++
 docs/product-vision.md                    |   10 +-
 docs/roadmap.md                           |   17 +
 8 files changed, 1585 insertions(+), 3 deletions(-)
```

I compared each changed file's bytes with git show 4d29392:<path>. The link scan covers local clickable Markdown links and anchors, excluding image syntax, external URLs and prose/backtick references. The secret scan covers the eight changed files with the five pattern families named above. The checker exited 0 and printed:

```text
REVISION_MATCH CHANGELOG.md True
REVISION_MATCH README.md True
REVISION_MATCH docs/decisions/0007-guiding-principles.md True
REVISION_MATCH docs/decisions/0008-one-evidence-model.md True
REVISION_MATCH docs/open-questions.md True
REVISION_MATCH docs/product-design.md True
REVISION_MATCH docs/product-vision.md True
REVISION_MATCH docs/roadmap.md True
LINK_SCAN_DONE CHECKED 29 BROKEN 0
OPS 18 ['propose', 'report', 'claim', 'announce', 'attach', 'plan', 'decide', 'inbox', 'get', 'find', 'impact', 'since', 'history', 'gate', 'trace', 'check', 'admin', 'transfer']
STATED_OPS ['Eighteen operations.', 'eighteen entries', 'eighteen operations']
MCP_TOOLS 10
QUESTIONS [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28] CONTIGUOUS True
SECRET_PATTERN_SCAN_DONE MATCHES 0
DIFF_CHECK_EXIT 0
DIFF_CHECK_STDOUT ''
DIFF_CHECK_STDERR ''
STATUS ''
```

HEAD was 4d29392495e3dd62da2b7b8aebb8fd00832653da. Clean status was checked before review and again after writing this /tmp report; both checks returned no output.

## 8. Attempts to break the revised contracts

These are design counterexamples, not execution against a Mainworthy binary.

1. **qualifies, manual versus DOM.** A human-only requirement cannot be filled by auto, because :622-626 checks both requirement and case method kinds. A named auto binding excludes another test. These attacks are now rejected on paper. Distinct actors and uncorrected fail preservation are also explicit. A seventeenth fill and an unrelated agent charter still lack safe rules; see R2-6. Resolve/trust at :667 makes contradictory evidence a recorded decision rather than a later-write choice.

2. **Horizon under inverse processing order.** A=10 and B=11 both accepted, B processed first, A pending. The stated per-batch advancement permits applied=accepted=11. No contiguous-watermark rule prevents green. Existing E5 does not cover this ordering. A batch parse failure before normalized staging is not durable acceptance under the new contract; the old raw-accept row contradicts this choice.

3. **Late uploads and expiry.** An accepted late batch invalidates a closed-but-unfrozen gate; frozen runs keep the new batch as after-freeze. That closes the former silent-ignore hole. Reopening state still lacks its recorded writer. A date expiry with no ingest now returns pending immediately through nextExpiry, and a persisted sweep repairs it. This resolves the cached-green-during-sweep-lag finding. A frozen run's treatment of a depended-on hold that later expires should be specified before implementing immutable frozen verdicts versus a live gate read; I have not counted this unresolved choice as a separate blocker.

4. **Pinned fragments and claim hash.** Pin F@v3 in C@v7, then adopt F@v4. The attributable adopt publishes new user versions; C@v7 retains F@v3. Claim hash is a reuse hint and cannot itself transfer proof. The proof strip now says a pass on the current version with a policy-counted basis, so the former current-claim/old-version shortcut is rejected on paper. These attacks are resolved.

5. **basisFor provenance.** I transcribed the branch conditions at :899-903, replacing external lookups with a test case whose current head is v8. The exact conflict and fall-through outputs were:

```text
slot v7 + annotation v6 => "Rejected(BasisConflict)"
slot v7 alone => {"b":"exact","case":"C-311","version":7}
slot v7 + manifest v7 => {"b":"assumed","case":"C-311","version":8}
slot v7 + manifest v7 + annotation v7 => {"b":"assumed","case":"C-311","version":8}
horizon countermodel: accept A=10; accept B=11; process B => accepted=11 applied=11; A still accepted => two-comparison gate may return passed
```

This small execution checks the documented conditional logic only, not a runtime implementation. It proves the agreeing-source defect without relying on an author summary.

6. **Five-kind slice.** adopt/failure/map/finding plus rule-only signoff can support recorded loose closure, and role/freeze paths are explicitly deferred. Standard's documented role-lead close is not a rule-only clause. E1 additionally rejects a valid review slot in its broad wording. Resolve the Preview clause override and narrow that fixture.

7. **Preview versus first usable.** The design's Local Preview followed by phase-3 Server/Cloud proof matches decision 0002. Reading only the roadmap still leaves Cloud/job-suite/restore exits in phase 4. This is an actual cross-document conflict, not a request for premature implementation or deployment.

## 9. Quiet averaging and editorial notes

The earlier manual-pin versus assumed-CI disagreement is an explicit policy choice, not a quiet average. Pinned fragments resolve the former mutable-expanded-claim versus immutable-version tension. Named bindings and the human-only rule resolve the former broad automated substitution example. Review remains separate from runtime evidence.

Three combinations still read as if both meanings hold:

- B's generation-aware completeness is asserted alongside a scalar applied sequence advanced per processed batch, without a rule for holes.
- P0's decision-only run lifecycle is asserted alongside automatic reopening by acceptance.
- Preview's rule-only standard signoff is asserted alongside standard's lead-signoff table.

The subject-form decide hash also averages "answered on what the caller saw" with "answered on the transaction's latest evidence". These are different safety contracts; atomically stamping the latter does not establish the former.

Editorial and nonblocking cleanup, separate from the verdict:

- :104 still refers to "L5 in candidate D" for an undo job. Give that check a durable repository name.
- The normative preset table says first-match clause lists, but its displayed condition rows are not an ordered executable list. Encode overlapping conditions such as disputed/base-failure precedence when those clause lists are written.
- :1191-1192 says regulated is unexercised until gap and signoff ship, although rule-only signoff ships in Preview. Name the role/freeze signoff paths there.
- Phase-1 next-step fixtures at :1199-1200 still list only D1/D3/E1/E2/E3. Add inverse-order horizon, agreeing multiple provenance and late-reopening cases when prototyping.
- Predicate enumeration, complete reverse-key proof, immutable patch capture validation and clean-run cohort rules remain implementation design work. No successful runtime enforcement is implied.

**Disposition:** issues on 4d29392495e3dd62da2b7b8aebb8fd00832653da. The mechanical checks pass and many round-1 findings are resolved. Correct R2-1 through R2-8 before treating the documented contracts as ready for implementation. The blocking list above is limited to contradictory or unsafe instructions that could mislead a future implementer or violate the recorded decisions; editorial items do not determine the verdict.

Only /tmp/mainworthy-arena/verify-r2.md was written as the review artifact. No repository files were changed.
