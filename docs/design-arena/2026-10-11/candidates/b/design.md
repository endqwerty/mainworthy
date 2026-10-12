# Casebook candidate B: prove the change

## Thesis

Casebook is the place a team answers "what does this change need proven, and what has proven it?" Its structural idea is a versioned proof plan for an immutable change revision: each obligation names an expectation, the conditions under which it matters, and the evidence it accepts. Manual runs, CI builds, and agent sessions supply evidence to those same obligations. Cases are the durable expectations behind the plan. A PR, commit, release, or named exploratory session is the working context. The product joins the three testing layers at the decision about a change, rather than merely storing their results together.

## Why the incumbents are a poor use of money

The verified facts below are the repository's research dated 2026-10-10, not fresh pricing checks. They establish commercial constraints, not proof that every incumbent has poor architecture. Product friction remains a hypothesis until the planned audits.

| Structural cost | Evidence and limit | Casebook's structural answer |
| --- | --- | --- |
| A team must buy permission to explain an old decision. | [Competitive analysis, TestRail, Qase, Xray, Testiny, Testomat.io](/home/endqwerty/.t3/worktrees/casebook/t3-7f035a0d/docs/competitive-analysis.md): versioning, audit, or retention are gated on these tools. The gates differ. | Every obligation pins its case version, policy, target, and evidence. History and reproducible decisions are part of the base storage model, exportable in every deployment. Storage retention is an explicit project policy, never a feature tier that hides lineage. |
| Inviting the people who need a release answer adds licence cost. | The analysis verifies Qase's collaborator price, Testiny's discounted viewers, and Xray's total-Jira-user basis. Testmo's plan pricing is a counterexample to a universal per-seat claim. | A principal is an identity and permission record, never a paid seat. Readers and automation principals do not trigger a purchase. Any later hosted price must relate to service capacity or support, not the number of people allowed to see the answer. No price or billing system is selected here. |
| Bulk automation fights a business-imposed request budget. | The analysis verifies tiered request rates for TestRail, Qase, and Xray. It does not measure actual integration throughput. | A durable report upload is one operation, with resumable processing and a receipt. Cases, findings, and evidence support bounded batches. Resource quotas protect the instance and give explicit backpressure; permissions and throughput are not feature upgrades. |
| Teams pay for maintaining duplicate representations of the same test knowledge. | Hypothesis from [product vision](/home/endqwerty/.t3/worktrees/casebook/t3-7f035a0d/docs/product-vision.md) and [F4, F5, F7, F13](/home/endqwerty/.t3/worktrees/casebook/t3-7f035a0d/docs/ux/flows.md), not an audited competitor defect. | A human's run list and an agent's impact set use the same proof-plan selection. CI maps into those obligations. Views derive coverage, gaps, and the gate from the same pinned plan. There is no second release spreadsheet to synchronise. |
| A green automation dashboard can coexist with an unexplained release decision. | Hypothesis. Competitor traceability and MCP depth have not been audited. | The default screen lists unmet obligations and conflicting evidence, with the exact target and why each item is in scope. A pass count cannot hide an untested requirement, missing reporter, or manual failure. |
| The tool makes adoption and exit expensive. | The analysis verifies several commercial on-prem offerings and cloud-only entries. Claims that all self-hosted alternatives are dated are not established. | One build, equivalent Local, Server, and Cloud semantics, and a complete portable archive. External CI and trackers remain external. Casebook supplies context and records evidence; it does not sell an execution platform that the customer must migrate into. |

An MCP badge alone is not a differentiator. A4 and A5 must demonstrate fewer tokens served to finish a review than naive suite reads, while preserving review quality. The hypothesis is that change-bound context and remembered review basis achieve this.

## Guiding principles

Within the correctness floor below, retain Daniel's order: backend speed, then agent access and token cost, then UI polish. Required task completion is a floor for all three. A fast backend that cannot express a release decision fails before that ranking applies.

1. **Organise work around the change, and keep the suite as reusable knowledge.** This rules out making teams construct folders, suites, and copied run cases before their first useful answer. In a tie with convenience, create a named session automatically rather than inventing a commit. Case capture may happen without a change; evidence may not.
2. **Only evidence with an exact, inspectable basis can satisfy a gate.** This rules out treating yesterday's pass, an unmapped CI row, or a prose review as proof of today's build. This principle outranks speed and optimistic UX. Unknown basis is visible evidence with limited authority, never guessed proof.
3. **Use one expectation and one evidence model, with explicit acceptance rules.** This rules out separate manual and automated status columns that overwrite each other, and treating agent authorship as a testing method. In a tie with interface simplicity, keep contradictory observations visible and require an explicit resolution.
4. **Give each invariant one owner and derive every decision from recorded facts.** This rules out gates recomputed differently in CI and the UI, independently mutable dashboards, and transport-specific business rules. In a tie with backend speed, allow persisted incremental projections with a freshness stamp and a rebuild path; never allow a stale projection to say green.
5. **Buy speed with bounded work, not lost meaning.** This rules out suite scans on interactive reads, unbounded MCP replies, and an aggregate that erases individual failures. Backend speed wins over smaller agent replies when both preserve meaning. If a complete result exceeds a budget, return a cursor and its total, not a falsely complete answer.
6. **A person, CI, and an agent use the same operations under their own identities.** This rules out UI-only powers and agent bypasses around review, permission, or concurrency checks. Speed wins over elaborate transport affordances, but removing a required actor's ability is below the floor. Token savings beat decorative UI improvements.
7. **Capture thought immediately and make publication state explicit.** This rules out mandatory metadata forms before typing, invisible autosave failures, and silent last-write-wins. Correctness beats apparent immediacy. Save the local draft immediately, show the pending state, and publish only after the operation confirms it.
8. **Make stricter process a policy on the same facts.** This rules out a regulated edition with a second model and universal sign-off ceremony. The evidence floor wins over loose defaults. Otherwise the lighter workflow wins; strictness adds approvals, acceptance conditions, and freezes without making capture harder.
9. **Deliver fewer complete workflows before delivering more partial ones.** This rules out shipping a fast case editor as the claimed integrated product. Scope reduction wins over breadth and cosmetic polish. The first usable slice must still prove a change through human, CI, and agent work, survive retries and concurrency, and export its decision.

### The rule for bending a principle

A bend needs a decision record naming the blocked user job, the principle, a measured or testable constraint, the smaller alternative, the accepted cost, and a condition for revisiting it. Change the scope before weakening semantics. A temporary slower heavy operation is allowed only with an honest pending state, bounded work, and a recorded benchmark budget revision. A repeated budget miss is evidence to change the design, not a permanent "temporary" exception.

"A bad product" loses a draft or accepted result, silently substitutes another version or target, fabricates green, hides incomplete coverage, bypasses identity or policy, requires a separate model for an actor, cannot reconstruct a decision from an export, or cannot complete the slice's jobs within agreed interaction budgets. These are the floor and cannot be waived for a deadline. Do not promise a regulated certification or legally qualified signature this design does not provide.

### Challenges to the existing guidance

The six decision records remain constraints. Three draft positions are refined or replaced explicitly.

| Replaces | Proposed change and reason | Cost |
| --- | --- | --- |
| The roadmap's case-editor slice, followed later by execution, CI, and gates. | Deliver a narrower complete change-proof slice first. The main structural hypothesis cannot be tested by a case editor alone. Keep research and stack benchmarks ahead of product implementation. | Earlier work on target identity and evidence ingestion. Delay broad customisation, importers, and rich reports. |
| The vision's case-level flaky state as the primary fact. | Compute flakiness per automated test binding, relevant case version, and environment class. Derive the case's summary from those states. Two tests attached to one case can have different reliability. | More aggregate keys and a case row that may say "1 of 3 checks flaky" instead of one unexplained score. |
| The vision's "manual, automated, or both" as sufficient coverage description. | Keep that versioned field as declared execution intent. Actual coverage comes from active bindings and accepted evidence. Agent identity is independent of execution method. | More precise labels: "automatable, no active binding" and "agent reviewed, not exercised". A single automation percentage needs a declared denominator. |

Suggested unresolved defaults, not accepted decisions: direct human publication, reviewed agent case edits, no required sign-off, quarantine by explicit human decision, and a gate that treats quarantine as an uncovered required obligation unless the policy or a recorded exception allows it.

## The DX/UX moves, made concrete

### The Linear move: make the next decision the object of work

Opening a PR link or selecting a release opens its change page. The first view shows the target, needed proof, received proof, and the smallest action that closes each gap. There is no prerequisite plan wizard. `Start manual check`, `Inspect failure`, `Ask agent to challenge`, and `Capture missing expectation` operate on the same rows. Keyboard search opens cases and changes without moving through the hierarchy. The suite still has a dedicated maintenance view.

Check this with F5 to F7: starting from a red PR, a person can reach the failing expectation, its executed version, its evidence, and the unmet gate clause without choosing a suite or exporting a report. Target updates preserve the selected row and label old evidence as belonging to the old revision. A changing list never reorders under the executor's cursor.

### The CircleCI move: describe proof once and let external execution report it

A small project proof recipe identifies areas, required reporters, contexts, and acceptance clauses. A change resolves that recipe to a pinned plan. Existing CI runners and people execute outside the planner. A report upload names its execution identity and target, produces one durable receipt, and returns the same receipt on a retry. PR status is an export of the gate snapshot, not a separate CI configuration language.

Check this by connecting a second CI vendor with the same CLI and report, resending an upload, killing processing mid-report, and reading the resulting gate. No vendor plugin, duplicate rows, or false completion is allowed. The recipe is a policy input, not a competing source of case content.

### The bun/deno move: eliminate glue needed for a normal job

Download the future artifact, start it, paste a case, and prove it on a named session without accounts or external services. CI gets one prepare command and one report command. Agents get a bounded change brief, field-selected reads, batched writes, and a checkpoint that includes the whole review basis. UI, MCP, CLI, and REST descriptions come from the same operation definitions. Full project export preserves those identities.

Check J15 in under five minutes on a clean supported machine. Check A4 against naive list-and-read, and A5 after one case edit. Check that a readonly token cannot mutate through any transport. These are commitments to test, not claims about work that has already shipped.

## Usage first

The commands, MCP names, and file format below specify future caller behaviour. They are not installed software, a selected implementation language, or a commitment to a package manager.

### Quickstart as the user reads it

Start Casebook from the downloaded artifact.

```text
casebook start
# Opens the local project chooser. Stores data locally. Binds to loopback.
```

Create a project called Shop. Select `New expectation` and paste:

```text
An expired checkout link cannot place an order
Given a checkout link whose expiry time has passed
Open the link
Expect a clear expiry message and no new order
```

Casebook saves your draft as you type. The editor proposes a title, precondition, action, and expected result. Accept the split or keep editing the outline. Select the Checkout area when you know it. Area and tracker links are optional during capture. The saved case receives the stable ID `CB-17`; its published version is `v1`.

Select `Prove a change`. Paste a PR URL, commit, or release identifier. For a trial without a repository, choose `Named session` and enter "Checkout expiry rehearsal". Casebook records that session as an explicit target. It does not claim the session proves a commit.

Add `CB-17` to the plan. Select `Start manual check`, record the target environment, execute the case, and press `P` to pass. The row now says "manual pass on v1, named session, local environment". Open the row to see who recorded it. Select `Export decision` to save the plan and evidence with their history.

Connect CI or an agent when you need them. In Local, `Connect agent` issues an identity and scoped token. Save the credential in the agent client's secret store. The UI never offers a shared anonymous agent identity. Project policies remain out of the capture path.

### Call site A: an existing CI pipeline reports automated results

Before this example, a maintainer links the test ID `checkout/expiry::expired-link` to `CB-17 v1` and commits that exact reference in the test annotation or a version manifest. Casebook's latest case version is not a substitute for what the code tests. The proof recipe requires the reporter `unit-and-integration` in `linux-test`, and the stable build attempt identity comes from CI.

```yaml
# Illustrative GitHub Actions fragment; the Casebook executable is already available.
steps:
  - name: Prepare proof execution
    run: >-
      casebook prepare --project Shop
      --repository "$REPOSITORY_ID" --revision "$CHECKOUT_SHA"
      --branch "$BRANCH" --pr "$PR_NUMBER" --build-url "$BUILD_URL"
      --reporter unit-and-integration --build "$BUILD_ID" --attempt "$ATTEMPT"
      --environment linux-test --case-manifest tests/casebook-versions.json
      --output casebook-execution.json
  - name: Run existing tests
    run: ./run-tests-with-junit
  - name: Upload outcomes even when tests fail
    if: always()
    run: >-
      casebook report results.xml --execution casebook-execution.json
      --format junit --final --wait processed
```

The upload credential comes from CI's secret store. `prepare` verifies a repository-qualified commit and records the producer's start-time manifest. It resolves to an immutable change revision, pins the case versions and bindings, and creates an execution. If PR tests run on a synthetic merge commit, the tested tree is that merge tree, and a head-only result cannot satisfy a merge-tree gate.

`report` returns a receipt immediately after durable acceptance. `--wait processed` waits for the promised counts and analysis watermark, not only a successful HTTP upload. A failed runner with no valid report closes the execution as incomplete, with a setup failure. A recipe-required reporter that never finishes remains a gate gap.

Unknown test IDs become unlinked observations without rejecting known results. They count in the producer's completeness check but do not satisfy case obligations. The row for `CB-17` now has both manual and automated evidence if both target and context qualify. Linking an unknown row later records the mapping decision; it never silently rewrites the original report or asserts a case version the producer did not name.

Re-running an upload with the same producer identity and content returns the original receipt. Different bytes under that identity cause `IdentityConflict`. An actual test rerun increments the attempt, so a fail-then-pass is retained and contributes to flaky evidence.

### Call site B: an agent challenges a PR through MCP

The agent already has repository tools. Casebook does not fetch arbitrary code or run the application for it.

```text
casebook_read({view: "change", ref: "Shop/pr/84", fields: "review_brief",
	limit: 20, fresh_eyes: true})
=> target cr-84-3 at repo R, tree T; plan pp-9; 8 obligations;
	6 linked expectations; 2 unmapped paths; scope confidence incomplete;
	review basis rb-44; tokens-served counter

casebook_read({view: "impact", change_revision: "cr-84-3", limit: 20,
	fields: ["case_ref", "body", "dependencies", "impact_reason", "failure_digest"]})
=> CB-17 v1 and its pinned shared steps; other relevant expectations;
	rules that selected them; unresolved scope; no prior reviewer opinions

# Agent reads the PR diff with its repository tool and challenges the assertions.
casebook_review({action: "record", mutation: "review-84-round1",
	basis: "rb-44", completed_items: ["ob-1", "ob-2"],
	findings: [{key: "expiry-boundary", subject: "CB-17@v1",
		claim: "Expiry equality is unspecified", severity: "medium",
		reproduction: "Compare now == expires_at against now > expires_at",
		proposed_edit: {expected: "Reject when now >= expires_at"}}]})
=> finding f-12; proposal p-8; checkpoint ck-22; remaining review count 6

# Later, after the human accepts the proposal and another push lands:
casebook_read({view: "delta", checkpoint: "ck-22", change_ref: "Shop/pr/84",
	fields: "review_delta", limit: 20})
=> CB-17 v2 diff; changed patch and plan facts; invalidated review items;
	unchanged applicable review items; unresolved findings; next checkpoint
```

A code review records findings and review completion. It does not record a runtime pass. Only an explicit `review` obligation accepts that completion, and its policy can require an independent human or agent identity. The agent's own case edits remain proposals if project policy requires review.

The agent cannot declare the entire plan reviewed by writing one checkpoint. It acknowledges item-specific basis hashes. The checkpoint includes target diff, case and requirement versions, expanded shared-step content, bindings, and policy. An unchanged case on a changed relevant patch needs another code review. Unchanged artifacts can still avoid repeated body reads. A shared prior-review ledger is optional; `fresh_eyes` suppresses subjective findings and completion suggestions, not objective failures or scope gaps.

For adversarial testing, the same impact query supplies a charter. `casebook_execute` starts an `adversarial` execution against a verified deployment target; the agent batches outcomes and reproduction findings. The actor is an agent, the method is adversarial exercise, and the execution is separate from the review above. An agent following an ordinary case procedure can instead declare the manual method. Actor identity does not decide the method.

### Call site C: a human executes while an author captures new knowledge

A lead opens PR 84 and selects the Checkout area plus the two unmapped paths. The lead confirms the scope or leaves it visibly incomplete, then starts a manual execution from the plan. Each selected item pins its case version at start. Testers claim separate items, and each tester sees an ordered queue that stays still as colleagues work.

The executor opens the first case, types a note, attaches a screenshot, presses `F`, and sees the next item immediately. The submitted result retains the failed case on `v1`. An upload-in-progress attachment is shown as pending and cannot satisfy an evidence-required clause. Pressing Undo creates a correction linked to that result, with the same target and a reason. It does not erase the failure.

Two testers may record observations for the same obligation. Both survive. A lease prevents accidental duplicated work but grants no authority over evidence. Incompatible observations show "disputed" until an authorised resolution names the observations and explains whether the cause was environment, test procedure, or a defect. A new pass alone never erases another source's fail.

From the failure, the author selects `Capture expectation`. The current change, case, and evidence are already linked. The author pastes reproduction steps, adds an expected result, and saves a new regression case. If review is required, it remains a proposal and the change page shows a proposed scope addition. Publishing the case does not mutate the running execution. The lead creates a new plan revision and a supplemental execution for the added item. Existing evidence remains usable only for obligations whose exact case, target, and acceptance basis still match.

## Domain model

This is language-neutral pseudotype notation. Types describe semantics, not storage technology. Constructors validate project scope, referenced versions, and permissions. IDs are nominal, project-qualified values. `NonEmpty`, `Positive`, `Digest`, and `Pinned<T>` are validated types. Internal code cannot manufacture a gate-eligible evidence record from a raw report row.

### Definitions and targets

```text
Actor = Human {id} | Agent {id, client} | CI {id, reporter}
CaseRef = {project: ProjectId, case: CaseId, version: CaseVersionId}
RequirementRef = {external_uri, source_revision?, recorded_snapshot_digest}

CaseVersion = {
	ref: CaseRef, parents: NonEmpty<CaseVersionId> | Initial,
	author: Actor, reason?, content_hash: Digest,
	content: {
		title, preconditions, steps: Ordered<StepId, Step>,
		area_refs: Set<AreaId>, requirement_refs: Set<RequirementRef>,
		folder: FolderId, tags: Set<TagId>,
		fields: {schema: FieldSchemaVersionId, values: TypedFieldValues},
		intent: Manual | Automated | Both
	}, seq: ProjectSequence
}
Step = Inline {id, action, expected?} | Shared {id, ref: SharedStepVersionRef}
CaseHead = {case, published: CaseVersionId?, state: Active | Archived}
Proposal = {id, base: CaseRef?, candidate: CaseVersionId,
	state: Pending | Accepted {decision} | Rejected {decision}}
Draft = {actor, draft_id, base?, text, pending_mutations} // Private actor state.
DefinitionEdit = {mutation_id, base, patch, actor}
EditResult = Published {ref} | Proposed {id} | Conflict {base, current, candidate}

Target =
	Code {repository: RepositoryId, commit: CommitId, tree: Digest}
	| Artifact {artifact: Digest, code: NonEmpty<CodeTarget>, deployment?: DeploymentId}
	| NamedSession {id: SessionId, description, created_by: Actor}
Change = {id, project, kind: PullRequest | Commit | Release | Session, external_ref?}
ChangeRevision = {
	id, change, predecessor?, target: Target,
	baseline: Target?, changed_paths: Set<RepositoryQualifiedPath>,
	requirements: Set<RequirementRef>, manifest_hash: Digest
}
```

PR identity is a mutable navigation handle over immutable revisions. A PR ref moving to another commit creates a new revision. Release membership pins code and artifact targets, never a branch name. A manual tester must declare what they tested: verified deployment identity when available, a pinned code target when credible, or a named session. Unknown build identity has no code-gate authority. A deployment can attest that a target was installed; an environment name alone cannot.

Folders, tags, field schemas, shared steps, binding definitions, area rules, and project policy have stable IDs and immutable versions. Definition owns folders, tags, shared steps, bindings, and area rules. Project authority owns schemas and policy. Moving or retagging cases creates case versions in one attributed batch. Renaming a folder creates a folder version without copying every case. The read returns both recorded and current display names, so old decisions remain reproducible.

Changing a shared step produces an affected-case set through its reverse dependency index. The edit creates new dependent case versions in a crash-safe batch under the review policy. A batch becomes published atomically after all its versions are ready. Old cases and executions keep their old shared-step references. Unfinished propagation never changes a published body halfway.

### Plans express obligations, not pass-rate targets

```text
Coverage = Complete {basis: ScopeBasis, confirmed_by: Actor?}
	| Incomplete {unmapped_paths, missing_requirements, reasons, continuation?}
ScopeBasis = {catalog_seq, area_rule_versions, link_versions, selector_hash}
PlanRevision = {
	id, change_revision: ChangeRevisionId, parent?, scope: ScopeBasis,
	coverage: Coverage, policy: PolicyVersionId, obligations: Ordered<Obligation>,
	required_reporters: Set<ReporterRequirement>, digest: Digest
}
Obligation = {
	id, expectation: CaseRef | RequirementGap {ref} | ReviewCharter {digest},
	target_requirement: TargetRequirement, context: ContextPredicate,
	reason: NonEmpty<ImpactReason>,
	acceptance: NonEmpty<Clause>, required: Boolean
}
TargetRequirement = Exact {target: Target}
	| CodeInArtifact {artifact: Digest, code_tree: Digest, repository,
		provenance: VerifiedBuildAttestationRef}
Clause =
	Exercise {methods: NonEmpty<Set<Manual | Automated | Adversarial>>,
		qualifying_binding_ids?,
		min_independent_actors: Positive, required_artifacts: Set<ArtifactKind>}
	| Review {charter_digest, reviewer_rule: ActorPredicate}
	| SignOff {role, separation_of_duties: Boolean}
ReporterRequirement = {reporter, context, test_inventory_digest?, completion_rule}
ImpactReason = PathRule {rule, path} | RequirementLink {ref}
	| ExplicitSelection {actor} | SharedDependency {ref} | ConservativeFallback {reason}
```

All clauses in one obligation must pass. An exercise clause can accept several methods. Any listed method may supply a qualifying pass, but an unresolved qualifying failure blocks it by default. The default set is manual and automated; adversarial exercise requires explicit acceptance. Two automated checks linked to one case do not imply that either alone is sufficient; policy or the author identifies the required binding set. A case's declared intent is not an acceptance rule. A requirement with no case creates a gap obligation, rather than disappearing from the denominator.

The default target requirement is exact. A release may explicitly accept code-level CI evidence for the tree inside its artifact through `CodeInArtifact`, but only with a recorded build attestation from an authorised producer. Runtime deployment obligations still require the exact artifact and qualifying environment. This permits honest reuse of unit-test evidence at release without claiming that unit tests exercised the packaged artifact. Mere ancestry, branch equality, or an artifact label is insufficient. Proof owns the attestation records and checks their producer authority.

Planning selectors are saved queries over cases. Starting an execution resolves versions and produces pinned items. Large selectors are materialised with a durable recipe and catalog sequence before activation. Edits published after that sequence belong to the next plan revision. Replanning is an explicit operation that returns added, removed, and changed obligations with reuse reasons. A release approval is over a plan digest, not a mutable query.

### Evidence preserves its basis and disagreement

```text
BindingVersion = {
	id, test: StableTestId, case: CaseRef, repository, source_locations,
	context_class, producer_identity_rule, version_hash: Digest
}
Execution = {
	id, plan: PlanRevisionId, target: Target, actor: Actor,
	method: Manual | Automated | Adversarial | Review,
	context: VerifiedContext | DeclaredContext,
	source: HumanSession | AgentSession | CIJob {build_id, reporter, shard, attempt},
	items: Pinned<ItemSet>, lifecycle: Open | Complete {receipt_set} | Incomplete {reason}
}
ExecutionItem = {id, obligation_id?, case: CaseRef?, expanded_body_hash?, binding_ref?}
ObservedOutcome = Pass | Fail {failure_kind, signature, excerpt_ref}
	| Blocked {reason} | Skipped {reason} | InfrastructureFailure {reason}
Evidence = {
	id, execution, item?, observed_target: Target,
	outcome: ObservedOutcome | ReviewCompleted {basis_hash, findings},
	actor, occurred_at, recorded_at, artifacts: Set<ReadyArtifactRef>,
	basis: Exact {case: CaseRef, dependencies: Digest, binding_ref?}
		| Unlinked {test_id} | UnprovenVersion {candidate_case?},
	producer_key: StableProducerRowKey, seq
}
Correction = {id, replaces: EvidenceId, reason, replacement: EvidenceId, actor, seq}
Resolution = {id, conflicting: NonEmpty<EvidenceId>, decision,
	reason, actor, policy_ref, seq}
Exception = {id, obligation, plan_digest, reason, actor, expires_at, policy_ref, seq}
ReadyArtifactRef = {digest, media_type, bytes, retention_class}
PendingArtifact = {upload_id, actor, deadline} // Cannot enter ReadyArtifactRef.
```

One evidence stream holds all outcomes. Basis, method, and actor remain independent axes. Corrections and resolutions are append-only records; raw observations remain readable. An attempt orders results within one source, not across humans, agents, and CI. An earlier CI failure followed by a pass remains a fail-then-pass history; whether the final attempt qualifies follows explicit policy. Default behaviour shows it as unstable and requires resolution or a quarantine exception for a required gate.

An unmatched automated result is retained as evidence without a case version. Later linking adds a mapping assertion with its author and confidence. If the producer did not pin a version at test start, the row stays `UnprovenVersion` for gate purposes. It can inform failure triage, automation inventory, and future planning. This is an intentional cost of honest versioning.

### Review, flakiness, and decisions

```text
ReviewBasis = {
	target_manifest_hash, patch_hash, plan_digest, subject_ref,
	subject_content_hash, dependency_hash, relevant_link_hash,
	policy_hash, charter_hash
}
ReviewCompletion = {actor, basis: ReviewBasis, reviewed_items, method, seq}
Finding = {id, origin: ReviewBasis | EvidenceId, subject, claim, severity,
	reproduction?, proposal?, state: Open | Accepted {decision}
		| Rejected {reason, decision} | Deferred {reason, owner}, actor, seq}
Checkpoint = {actor, project, scope_hash, authorised_scope_version,
	last_seq, acknowledged_basis: Set<Digest>, expires_at}

FlakeKey = {binding: BindingVersionId, environment_class, case: CaseRef}
FlakeAccumulator = {
	key: FlakeKey, same_commit: BoundedRecentCommitGroups,
	stable_branch_window: BoundedOutcomeRing, signature_counts: BoundedTopSignatures,
	state: Stable | Suspected | Flaky, witnesses: Bounded<EvidenceId>,
	threshold_version, applied_seq
}
Quarantine = {binding, environment_class, owner, reason, decision, seq}

CurrentGateStamp = Validated {
	plan_digest, target_manifest_hash, generation, evidence_digest, policy_ref
} // Constructible only after applied_generation == relevant_generation.
GateSnapshot =
	Pending {plan_digest, target_manifest_hash, relevant_generation,
		applied_generation, lag_or_missing, clause_counts}
	| Evaluated {stamp: CurrentGateStamp, clause_counts, reporter_completeness,
		evaluated_at, decision: Blocked {reasons} | Allowed {witnesses: ProofWitnessSet}}
ProofWitnessSet = Validated<NonEmpty<ClauseWitness>> // Only the evaluator constructs it.
ReleaseSeal = {target, plan_digest, evidence_digest, gate_snapshot_digest,
	signoffs: Set<SignOffRecord>, sealed_at, archive_manifest_digest}
DeploymentEvent = {id, artifact_digest, release_seal?, environment, actor, occurred_at}
```

Same-test, same-code disagreement is the strongest automatic flaky signal. Infrastructure failures do not classify all cases as flaky. The branch-window signal considers declared relevant code paths and exact case version. Sparse change mapping weakens that signal and labels the uncertainty. Thresholds and quarantines are versioned decisions; the accumulator is a rebuildable derivation. Quarantine suppresses the failure headline only according to policy and still leaves the required proof gap unless an allowed exception covers it. Leaving quarantine needs an explicit decision, even when a clean-window suggestion exists.

Sign-off is a recorded identity, time, and digest. It has no claim to a legally qualified signature. A seal fixes the decision's evidence set and attachment digests. Later observations remain separate events and may contradict the seal, but never modify its content. A relevant new observation invalidates a current mutable gate until evaluated. Deploy reads require a gate token bound to the exact artifact and generation; an old PR status is not a deploy authorisation.

### Storage shape and access patterns

The following relations and ordered indexes are part of the design now. They are persisted read structures derived by their owning module, not optional caches. Canonical facts remain the immutable records above. Each projection records its source sequence or generation. The indexes describe required access behaviour without choosing a database.

| Owner | Required keyed or ordered structures |
| --- | --- |
| Definition | `CaseVersionByRef`; `CaseHeadByProjectCase`; `CaseSummaryByProjectFolderSortCase`; postings by project, tag, area, requirement, field, and search term; `CaseVersionByCaseSeq`; `CaseDependentBySharedVersion`; `BindingByRepositoryTestContext`; `BindingHistoryByCase`; `AreaRuleByRepositoryPathPrefix`; versioned forward and reverse requirement links. |
| Proof | `ChangeRevisionById`; `ChangeHeadByExternalRef`; `PlanByRevision`; `ObligationByPlanOrder`; `ObligationByPlanCaseBindingContext`; `AffectedPlanByCaseBindingTarget`; `AffectedPlanByCodeTree`; `AttestationByArtifactProducer`; `ClauseStateByObligation`; `GateByPlan`; `RequiredReporterByPlan`; `SealByArtifact`. |
| Evidence | `ExecutionByProducerIdentity`; `ItemsByExecutionOrder`; `EvidenceByExecutionItemAttempt`; `EvidenceByCaseContextSeq`; `EvidenceByTargetBindingContextAttempt`; `ReceiptByProducerReportKey`; `UnlinkedByProjectTestTarget`; `DigestByTargetSignature`; `FlakeAccumulatorByKey`; `FlakeWitnessByKeyCommit`; producer inventory and last-report sequence. |
| Review | `FindingBySubjectBasisState`; `ReviewCompletionByActorBasis`; `CheckpointByActorScope`; proposal references, not copied proposals. |
| Common durability | `MutationReceiptByProjectActorId`; ordered `JournalByProjectSeq`; scope postings by case, folder, requirement, area, change, and link endpoint; `JobByStateLease`; `OutboxByDestinationSequence`. |

Case summaries include the published version, its search fields, and references to derived automation and flake summaries. The listing query retrieves a bounded page and joins by keys, never computes a history window per row. Summary joins carry freshness and may say "analysis pending". The browser caches pages for responsiveness; correctness does not depend on that cache.

Dominant paths through this structure are explicit.

1. **Case read, list, search.** A read goes from case head to one version and its pinned shared-step refs. List intersects scoped postings and keyset-pages `CaseSummary`; search intersects text postings with the same scope. Project scope is applied before items or counts. Version hashes support conditional reads. Draft server budgets remain 20 ms for one case, 50 ms for a list, 100 ms for search, and 50 ms for save on the specified benchmark, subject to measurement.
2. **Run execution.** Plan order produces a pinned item set. An executor reads `ItemsByExecutionOrder` and its bounded evidence summaries. Results append against an item ID; a claim is per actor and expires. Other actors' observations merge at read. Progress counts update per changed item. No plan or case-body scan accompanies each result.
3. **A 10,000-result report.** Durable blob acceptance stores a digest and receipt, then one persisted parse job. Processing converts bounded chunks, looks up binding keys in batches, appends evidence under unique producer row keys, and writes journal events in the same transaction. The receipt tracks chunk positions, expected row count, and parse diagnostics. `final` publishes completion only after all shards and counts reconcile. Invalid rows become explicit diagnostics; known results still arrive. A malformed or truncated report never marks its reporter complete. Acceptance under 2 s and report visibility within 5 s remain draft benchmark targets, measured with concurrent interactive work.
4. **Flaky state on ingest.** Each chunk updates only touched binding-context accumulators. Same-commit groups use the target-binding index, and the recent branch ring is bounded by configured windows. Duplicate row keys cannot update it twice. Late attempts update their code group before the window is reevaluated. The classifier preserves witnesses and threshold version. A nightly suite scan is unnecessary. Case summaries derive the worst active binding state and disclose the number of affected bindings.
5. **Impact set for a change.** Changed paths use repository-prefix area rules, then area-case postings. Requirements use reverse links. Shared-step changes use reverse dependency postings. Union and deduplicate case refs, then attach bounded recent evidence and impact reasons. The query materialises its scope basis and returns counts before rows. Unmapped paths produce explicit scope gaps. A fallback may select the touched areas or the whole project for proof; it never labels an incomplete linkage result complete. Broad selection costs execution and tokens but is safer than fabricated precision.
6. **Changed-since for an agent.** The checkpoint identifies the authorised scope and journal position. Scope postings return new events and tombstones without scanning versions. Changes to shared steps, policies, requirement snapshots, bindings, and change revisions invalidate affected basis hashes. The response gives diffs or hash-only unchanged answers. Expired or incompatible cursors return `ResnapshotRequired`, never an empty "nothing changed". A new access scope also requires a resnapshot.
7. **Traceability.** Requirement links lead to pinned case refs, obligation rows, qualifying or rejected evidence, target code, builds, seals, deployments, and defect links. Reverse indexes support the reverse walk. Each edge includes recorded revision and provenance. Tracker state is a recorded snapshot with source time; Casebook does not claim a tracker is current while disconnected. Matrix pages use obligation summaries under the selected plan, not every historical result joined live.
8. **Gate read by CI.** A keyed `GateByPlan` read compares applied and relevant generations, checks required-report completeness, and returns counts and decisive witnesses. Accepted uploads invalidate affected gates transactionally before their evidence is parsed, so a previous green becomes pending. Analysis jobs advance the generation only after matching, flake updates, and clause evaluation for that generation finish. Pending or lagging gates fail closed. A deploy read requires the caller's artifact and expected plan digest and returns a short-lived, generation-bound decision token. The gate's fast path does not scan the suite or reconstruct a million results.

The store must atomically append facts, deduplication receipts, journal entries, relevant gate invalidations, and job intents. This is a stack-selection requirement. A case edit dirties plans that follow current definitions or depend on its scope; it does not rewrite an already pinned execution. A result arriving for an old revision never replaces a new revision's evidence. Plans with immutable pins can reuse that fact only under an explicit matching basis.

An affected-plan reverse relation makes invalidation bounded to active targets. Inactive plans retain historical snapshots. Bulk changes mark a generation pending once, then build shadow projections in bounded jobs and publish the completed generation. Gate freshness cannot depend on an asynchronous notification reaching a browser or a CI callback.

## Operation layer and module map

The operation definitions own typed requests, permission requirements, result projections, idempotency rules, and error variants. UI, REST, MCP, CLI, and CI use them. Adapters handle authentication, pagination encoding, XML parsing input, and wire errors. They cannot choose policy, map a case version to "latest", or decide a gate.

### Small operations that hide substantial rules

Reads take project scope, requested fields, a maximum page size, and a stable cursor. Writes take an actor-bound mutation ID and an expected version or digest when they replace a mutable head. Responses return IDs, diffs, receipts, and errors rather than echoing whole objects.

| Operation | Request and result | Hidden knowledge |
| --- | --- | --- |
| `readCases` | Selector and fields to page of pinned refs, summaries, or bodies. | Visibility, search, dependency expansion, current versus recorded names, conditional hashes. |
| `editDefinitions` | Bounded case, shared-step, folder, tag, binding, and field edits with bases to publication, proposal, or conflict receipts. | Typed fields, disjoint-field merge, dependent-case propagation, review policy, atomic bulk publication, undo as compensating versions. |
| `decideProposal` | Proposal, expected head, accept, reject, or revise to decision receipt. | Separation of duties, rebasing a proposal against current content, conflict preservation, publication. |
| `compareVersions` | Exact refs to structured diff. | Stable step identity and shared-content expansion. Restore uses `editDefinitions` with an old body and current base, so there is one publication path. |
| `registerChange` | External identity, immutable target manifest with any build attestations, base and paths to revision ref. | Identity deduplication, head movement conflicts, repository qualifications, target and producer trust. |
| `planProof` | Revision, selector or prior plan, scope confirmation, and policy base to pinned plan and delta. | Impact selection, scope gaps, required reporters, acceptance clauses, approval to activate, evidence reuse. |
| `readChange` | Revision or navigation ref, fields to proof board, scope, gate, and digests. | Unified obligation state, freshness, contradictory evidence, concise next actions. |
| `readImpact` | Revision or requirement and fields to explained candidate set. | Indexed impact rules, conservative fallback, confidence, deterministic risk signals. Uses the same selection function as `planProof`. |
| `beginExecution` | Pinned-plan request, or producer-change manifest with recipe and exact version manifest, to execution receipt. | Start permission, target registration, default proof-plan resolution for CI, exact pins, producer uniqueness, approved context. |
| `claimItems` | Execution, actor, item IDs, lease to claim receipt. | Expiring advisory assignment. Never locks a case or grants exclusive evidence authority. |
| `recordEvidence` | Execution, bounded outcomes, correction references, artifact refs to IDs and errors. | Exact basis, target checks, unique producer rows, ready attachments, append-only corrections, invalidation. |
| `ingestReport` | Durable report ref, execution, producer report key, final flag to receipt. | Report format validation, chunk recovery, binding resolution, unknown rows, completeness and flake update. Produces the same canonical evidence as `recordEvidence`. |
| `finishExecution` | Execution, expected generation, complete or incomplete declaration to receipt. | Producer counts, missing shards, approval/freeze policy. Cannot invent missing outcomes. |
| `reviewChange` | Review basis, item acknowledgements, findings, triage decisions to checkpoint and proposal IDs. | Per-actor review basis, deduplication, findings history, role checks, proposal creation through Definition. |
| `resolveEvidence` | Evidence conflicts, mapping assertions, quarantine or exception decision to receipt. | What authority a late mapping has, retry eligibility, scope and expiry of exceptions, explicit policy enforcement. |
| `readDelta` | Checkpoint or scoped sequence to changes and invalidated basis hashes. | Permission-safe journals, scope changes, retention, dependency invalidation. |
| `readTrace` | Exact requirement, case, evidence, or seal ref to bounded chain or matrix page. | Revision-qualified links, both directions, source freshness, gap semantics. |
| `readGate` | Target, plan digest, optional decision-token request to freshness-stamped gate. | One acceptance evaluator, required reporters, no stale green, exact deploy basis. |
| `sealRelease` | Exact artifact, plan, expected gate generation, sign-offs to immutable seal. | Recheck in transaction, separation of duties, artifact readiness, evidence set freeze. |
| `recordDeployment` | Artifact and optional seal, verified environment event to receipt. | Provenance and reverse links, not execution or deployment control. |
| `transferProject` | Export snapshot or staged import archive to manifest or validation receipt. | Consistent database-and-artifact snapshot, identity preservation, checksums, review of import losses, atomic activation. |
| `configureProject` | Versioned policies, proof recipe, access scope, and credentials lifecycle to receipts. | Field and permission validation, local security defaults, token revocation, audit events. |

There are 22 domain operations, not 22 mandatory MCP definitions. MCP exposes seven job-sized tools: `read`, `edit`, `plan`, `execute`, `review`, `ingest`, and `admin`. Each has a closed discriminated action schema generated from these operations, not a free-form query or generic arbitrary command. `read` covers bounded views; `execute` covers the execution lifecycle and explicit evidence decisions. Scoped discovery omits unavailable mutation and admin tools. Measure the actual definitions clients load; consolidation is a hypothesis, not a claim that fewer tool names always cost fewer tokens.

REST endpoints and CLI verbs are generated adapters to these definitions. MCP grouping does not implement another workflow. In particular, an "AI accept" endpoint and a "human accept" endpoint are forbidden.

`prepare` calls the producer-change variant of `beginExecution`. The operation, not the CLI, registers the target, resolves the project recipe, and creates the pinned execution. It returns `Preparing` with a receipt when scope materialisation needs a job; the CLI waits before writing the execution manifest or starting tests. A pinned-plan caller uses the other typed variant. Both enter the same activation rules, with idempotent owner commands, so CI cannot observe a half-activated plan.

### Knowledge boundaries and state ownership

```text
UI / CLI / REST / MCP / CI format adapters
	-> operation definitions + access validation
	-> Definition | Proof | Evidence | Review
	-> durable store transaction and artifact store

Project authority: identities, scopes, policy versions, field schemas, credentials.
Definition: case and shared-step versions, heads, proposals, folders, tags,
	bindings, requirements snapshots, area rules, and their indexes.
Proof: change revisions, plans, clauses, gate projections, exceptions,
	sign-offs, seals, verified build attestations, deployment links,
	and affected-plan reverse relations.
Evidence: executions, advisory claims, observations, corrections, report receipts,
	producer inventory, flake projections, quarantine, and failure digests.
Review: findings, triage history, per-actor completion, review bases, checkpoints.
Durability: journal, mutation receipts, jobs, leases, transactional outbox,
	consistent archive coordination. It decides no business rules.
Artifact store: immutable ready blobs and staged uploads, with retention metadata.
```

Project authority owns field schemas; Definition validates case values using a pinned schema. Definition owns proposals, including proposals suggested by Review. Evidence owns quarantine; Proof owns exceptions and accepts quarantine as an input. A cross-module decision is one operation transaction using each owner's validated command, never two transport calls the client must sequence safely. Internals cannot be imported by adapters. Projections stay with the owner of the rule they derive. The shared store is a commit mechanism, not another domain owner.

Pure functions select impact, merge disjoint field patches, match evidence to clauses, classify flakes, diff versions, and decide gate status. Time, identity, I/O, and transactions are supplied by the operation shell. A call chain ends at one owner's command or a deliberate multi-owner transaction, not a chain of pass-through services.

### Tricky logic remains explicit

These sketches define the hard boundaries without pretending the logic is implemented.

```text
selectImpact(revision, scopeBasis, areaRules, links) -> ImpactSelection {
	// TODO: union indexed candidates and retain every selection reason.
	// TODO: report unmapped paths and missing requirement coverage separately.
	// TODO: include dependency changes without treating sparse mapping as complete.
	not implemented
}

qualify(evidence, obligation, plan, resolutions, policy) -> Qualification {
	// TODO: compare exact target or attested code-in-artifact requirement,
	// case version, dependencies, context, actor, and binding.
	// TODO: separate review completion from exercised behaviour.
	// TODO: resolve within-source attempts without hiding cross-source disagreement.
	not implemented
}

evaluateGate(plan, clauseStates, reporters, findings, generation) -> GateSnapshot {
	// TODO: pending if accepted evidence or dependency updates are not yet applied.
	// TODO: block scope gaps, unfinished reporters, expired exceptions, and disputes.
	// TODO: emit minimal witnesses and rejection reasons for every decisive clause.
	not implemented
}

ingestChunk(receipt, chunk) -> ChunkReceipt {
	// TODO: unique row keys, canonical evidence, flake increments, journal,
	// gate invalidation, and processing position commit together or not at all.
	not implemented
}

sealRelease(request, authorisedActor) -> ReleaseSeal {
	// TODO: transaction checks target, plan digest, current applied generation,
	// required artifacts, approvals, and sign-offs before publishing the seal.
	not implemented
}
```

### Retries, crashes, and concurrent actors

Every mutation receipt binds actor, project, ID, and request digest. An identical retry returns the original outcome. A different request with the same ID fails. A result receipt and its state effects commit atomically. An abandoned transaction has no visible effect.

For case editing, compare the supplied base to the published head. Disjoint field patches merge into a new version with both parents. Same-field patches preserve the candidate as a proposal and return the two versions for resolution. Publication and plan-head updates use compare-and-swap. A current plan cannot be replaced by a late agent edit without an explicit new revision.

Executors and reviewers write their own observations and completions. Read views merge them. Lease expiry affects assignment only. Findings use reviewer-local keys, so two reviewers' independent findings survive even when their text is similar. Suggested deduplication never deletes either author's record.

Accepted uploads are durable before acknowledgement. Chunk deduplication, persisted positions, and leased jobs recover after a crash. Receipt completion follows actual row accounting. Blob cleanup removes only abandoned staging uploads after a retention period, never a receipt's blob. CI callbacks come from a transactional outbox. Delivery retries are idempotent and check the currently selected revision before updating a PR status, so an old green callback cannot overwrite a newer revision's status.

Notifications carry sequence IDs and invalidate client views. Refetch or `readDelta` repairs missed pushes. A browser stores unsent drafts and pending mutations with bases. It may queue safe edits during a short connection loss, but approval, execution activation under freeze policy, and release sealing require the authoritative store. This preserves decision 0004 without a replica or live co-editing system.

## Product surface

Five objects are enough for everyday work: Change, Expectation, Proof plan, Execution, and Finding. Requirements, areas, bindings, and policies provide context and organisation. An evidence item is a record inside the work, not another top-level navigation destination.

The home page is a change inbox. Rows answer "ready", "needs proof", "disputed", or "scope unknown", with a named owner and an explicit target. A project without repository links still has named sessions. The first action is capture or prove, not configure.

The change page is the principal screen. Its header shows the exact revision or artifact, plan digest, target environment, freshness, and gate explanation. The central list groups obligations by product area. Each row has the expectation, reason it is required, accepted methods, latest qualifying observations, remaining clauses, and the next action. Manual, automated, and agent evidence appear in the same row with method and identity labels. Review completion appears beside a review clause, never as a runtime pass badge.

A selected row opens a stable right-hand detail pane: pinned steps, version diff, observation timeline, failure excerpt, findings, and provenance. Evidence for earlier revisions appears in a labelled history section. It does not enter the current totals. The plan editor previews scope deltas and reuse decisions before activating them.

The execution screen is a keyboard queue over that plan. Notes autosave, P/F/B/S record outcomes, the selected item stays still, and colleagues' progress updates as counts. The author can capture a missing expectation without leaving the failure context. A pending save is distinct from a recorded outcome.

The expectation library supports search, outline capture, bulk organisation, shared steps, version diffs, and review. It is the slower-changing knowledge view. A case detail shows where this expectation is needed now and which bindings actually report. Library authoring never requires a PR.

The triage inbox merges new failures, unlinked tests, stale bindings, and proposed findings by affected change and owner. Each item asks for a decision: reproduce, map, revise, reject, quarantine, or record an exception. Staleness compares a completed reporter inventory against its expected bindings; a missing whole build is a reporter gap, not 10,000 stale test notifications.

Traceability is a view of the selected plan or seal. A requirement matrix shows missing cases, missing qualifying evidence, disputed evidence, and accepted proof. Clicking a cell opens the exact chain to build and deployment. Basic report rollups reuse these same summaries and state their denominator and scope.

Administrative settings hold policy presets, proof recipe, access, export, and import. Loose teams see ordinary capture and execution. Standard teams see proposals and review queues. Regulated teams add activation approvals, identity-and-time sign-off, and immutable release seals. No separate product or execution model appears.

## First deliverable slice

The smallest acceptable product proves one change end to end. It supports a local project and multi-user Server deployment from the same artifact, simple areas and folder organisation, outline case capture, immutable versions, field-conflict handling, a minimal shared-step reference, direct publication or reviewed proposals, an explicit code or named-session target, pinned obligations, keyboard manual execution, JUnit ingest, version manifests, unknown-test triage, same-commit flaky evidence, explicit quarantine decisions, MCP review and exercise, a requirement-link matrix, one exact-target gate, identity-and-time sign-off and a release seal when enabled, and a complete archive export/import.

Cloud scale uses the same semantics and persisted-job placement, and must run the same job suite before this is called the first usable version, as decision 0002 requires. Do not promise high availability or a large-organisation rollout until its concurrency, backup, and restore checks pass. Secure scoped tokens and free reader identities are part of the slice, not later account administration.

Deliberately leave out broad custom-field builders, advanced report designers, sophisticated branch-window scoring, automated quarantine exit, native Jira or ADO issue creation, native requirement authoring, vendor-specific test reporters beyond JUnit, broad legacy importers, cross-project shared standards, qualified electronic signatures, billing, generated test code, and execution infrastructure. Use external requirement and defect links first. A staged generic archive importer validates counts and unsupported fields; it does not claim to import a proprietary history it has not read.

The slice's acceptance checks must be written before implementation:

- A manual failure, CI pass, and agent review on the same target remain visible; the runtime obligation stays blocked until an authorised resolution. A review alone cannot pass it.
- A new PR revision receives no proof from the old revision by accident. A changed case or shared step does not rewrite a started execution. A result without a start-time version is visibly unproven.
- Duplicate upload, crash after a chunk commit, delayed shard, malformed report, and out-of-order callback produce no duplicate counts or false green. An accepted but unprocessed upload makes the relevant gate pending.
- An unmapped changed path produces a scope gap. Confirmed broader scope and explicit gap resolution can close it; a bounded impact page alone cannot.
- Two writers preserve conflicting edits. Two testers preserve both observations. Replayed offline drafts retain their bases and cannot seal a release.
- A1 to A6 finish through scoped MCP. A4 and A5 measure tool definitions, requests, replies, and calls under a fixed reference agent. A5 avoids unchanged body reads but reevaluates changed review bases.
- J1 to J10, J12 to J15, CI setup, and the unlinked inbox job run on the real screens. The benchmark retains the case/read/search/save budgets and 10k-ingest targets on 100k cases and 1M then 10M results, under mixed CI, execution, and authoring load. J11's broad field builder is explicitly outside this slice.
- Local, Server, and Cloud use the same operations and archive. Export/import and backup/restore preserve target identity, case versions, ready attachments, policies, findings, and the exact sealed decision. Permission failures apply to counts, reads, and writes in every transport.

This is a design proposal. No benchmark, interaction result, implementation, or independent verification has been claimed. The next design test should try to break the proof plan with sparse links and conflicting evidence, because those are the highest costs of organising around changes.
