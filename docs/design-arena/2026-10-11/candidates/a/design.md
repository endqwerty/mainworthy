# Mainworthy candidate A: evidence first

## Thesis

Mainworthy is a team's record of what its software promises and what evidence supports those promises at a particular build. Its central fact is an immutable observation against an addressable expectation, made by a person, a CI runner, or an agent. Cases define expectations; a run selects observations against a pinned set of obligations; a release decision evaluates whether that evidence meets the project's policy. Manual checks, automated tests, and agent explorations contribute to the same expectation and build without pretending their evidence is interchangeable. The structural idea is one evidence stream with explicit provenance and reproducible selection, plus a link graph that identifies what each observation actually supports.

This is a proposed design, not implemented behavior. Command examples specify a future interface. No language, framework, database, or build tool is selected.

## Why the incumbents are a poor use of money

The cited facts below are the repository's verified research as of 2026-10-10, not new vendor research. Prices and plan limits need another check before a buying decision.

| Structural cost | Evidence and its limits | Mainworthy's structural answer |
| --- | --- | --- |
| The organization pays extra to recover the meaning of its own old results. | TestRail and Xray gate case versioning to Enterprise; Qase limits history by tier; Testiny gates history on the free tier. [Competitive analysis, cross-cutting finding 1](/home/endqwerty/.t3/worktrees/mainworthy/t3-7f035a0d/docs/competitive-analysis.md#cross-cutting-findings). | Every result names an immutable expectation version. History is required to interpret results, so it belongs to the base model and every deployment. Retention is an explicit storage policy, never a commercial permission to inspect history. |
| Sharing evidence expands the license bill. | Qase charges for collaborator seats, Testiny discounts viewers, and Xray prices against total Jira users. Testmo is a counterexample to universal per-seat pricing. [Competitive analysis, Qase, Testiny, Xray, Testmo](/home/endqwerty/.t3/worktrees/mainworthy/t3-7f035a0d/docs/competitive-analysis.md#competitors). | Readers, agents, and runners are identities with scopes, not billable test authors. The self-hosted model has no seat counter. If hosting is sold later, charge for measured resources or service, with no reader tax. Pricing remains undecided. |
| High-volume integrations consume scarce API calls and engineering time. | TestRail, Qase, and Xray have tier-dependent API limits. Their integration labor and total cost are hypotheses, not measured findings. [Competitive analysis, finding 4](/home/endqwerty/.t3/worktrees/mainworthy/t3-7f035a0d/docs/competitive-analysis.md#cross-cutting-findings). | One report is a resumable, idempotent append job. One bounded change read replaces repeated polling of individual cases. Limits protect resources by bytes and concurrent jobs, not by purchase of operations needed for correctness. |
| The organization maintains separate explanations of the same failure. | Hypothesis: case documents, CI artifacts, exploratory notes, and agent conversations drift because no shared evidence identity connects them. Existing MCP availability is verified; its depth and this alleged gap are open. [Competitive analysis, finding 5 and unchecked items](/home/endqwerty/.t3/worktrees/mainworthy/t3-7f035a0d/docs/competitive-analysis.md#what-is-not-checked). | Every accepted observation has one identity, version binding, build, environment, and actor. A finding points to those facts. A report and an agent response select the same evidence instead of copying its status. |
| Administrative workflow interrupts the act of writing or executing tests. | Hypothesis: slow suites, rigid forms, and confusing run setup cost more than the subscription. Reviews report these problems, but no latency or job audit exists. [Competitive analysis, TestRail and Azure DevOps](/home/endqwerty/.t3/worktrees/mainworthy/t3-7f035a0d/docs/competitive-analysis.md#testrail). | Capture and execution work in place. The data path supports a small page or a single pinned case without suite-wide loads. Browser job tests decide whether these interactions save time. |
| Self-hosting requires an expensive edition or an operational burden. | The analysis verifies several Enterprise or priced on-prem offers and Kiwi's self-hosting; it does not prove that every self-hosted alternative is dated. [Competitive analysis, hosting table](/home/endqwerty/.t3/worktrees/mainworthy/t3-7f035a0d/docs/competitive-analysis.md#landscape). | One artifact, identical operations in Local, Server, and Cloud, persisted work, optional cache, and portable evidence bundles. Storage and operating costs remain real and visible. |

The economic bet is lower coordination and integration work per defensible decision. Cheap storage alone does not prove it. Measure the human jobs and tokens served for A4 to A6 before claiming savings.

## Guiding principles

The priority order is refined, not reversed: correctness, access control, and truthful evidence are admission requirements; among admissible designs, backend speed wins over agent convenience, which wins over UI convenience. Each principle below resolves a concrete conflict.

1. **A recorded observation must retain what was observed, by whom, and against what.** Rules out edits to past results, binding old results to today's case, or turning a review opinion into a pass. Tie-break: this is a floor; speed cannot waive it. Correction appends an explicit invalidation or replacement.
2. **Store facts once and derive every status with a named, versioned rule.** Rules out independent manual, automation, and agent status fields or mutable release percentages. Tie-break: a durable derived table is allowed for speed; it must be replayable and carry its rule version and watermark.
3. **An empty stream is unknown until obligations establish what is missing.** Rules out a green gate because no failures were uploaded or a partial shard completed. Tie-break: honest pending status beats a faster green answer. Freeze the obligations and producer roster before a gate can pass.
4. **Bound the work of every common read before choosing storage.** Rules out full-suite downloads, stream replay on a case read, and recursive graph walks with no limit. Tie-break: preserve the vision's backend budgets even if an agent must page or the UI must show a partial answer. Never label a bounded impact result complete when traversal stopped.
5. **Agents receive the same authority and less repeated context.** Rules out UI-only actions, shared human identity, giant tool catalogs, and automatic model summaries. Tie-break: correctness and latency beat token savings; agent convenience beats a special UI path. Fresh review can intentionally spend more context.
6. **Capture knowledge before requiring taxonomy.** Rules out mandatory folders, elaborate plan setup, and publishing on every keystroke. Tie-break: a runnable expectation needs an observable criterion; incomplete captures remain visible drafts. Review policy may delay publication, never erase the draft.
7. **Independent writers append their own evidence; shared definitions use explicit revision checks.** Rules out one global latest-result winner, silent overwrites, and stale checkout locks. Tie-break: preserve both actors' observations even if resolving contradictory evidence costs a click. Merge edits only where stable field identities prove disjoint changes.
8. **A project policy chooses acceptable evidence, not a separate edition or data model.** Rules out a regulated fork and a boolean that treats all agent activity as trusted testing. Tie-break: prefer a finite typed policy vocabulary over a custom rule engine. Unsupported policy expresses an explicit unmet need.
9. **Every accepted fact must survive export, restore, and deployment changes.** Rules out correctness in a cache, opaque remote summaries as the sole evidence, and history paywalls. Tie-break: portable fidelity beats a new convenience feature. An external attachment whose bytes were not retained is labeled unavailable, not exported as if preserved.
10. **Bend a principle only through a recorded, testable exception with an expiry.** Rules out accumulating hidden exceptions to get a demo shipped. Tie-break: reduce scope before reducing the floors in principles 1, 3, 7, and 9 or access control. An exception record names the missed budget or capability, affected jobs, substitute, owner, rejection test, and revisit milestone. A release with lost input, silent overwrites, false green gates, inaccessible evidence, or divergent transport rules is a bad product. A smaller release that states its limits is deliverable.

### Decisions kept and challenged

Keep decisions 0001 to 0006: stack-neutral design; all self-hosting layers; one software-QA model with policy switches; calm multi-user concurrency and online-first operation; teams in general; measured agent context cost. The following refinements challenge draft mechanisms, not those decisions.

| Replaces | Proposed replacement and reason | Cost |
| --- | --- | --- |
| A run as only a cheap dynamic view over cases or events. | A planned run resolves to an immutable obligation manifest and evidence selector. The displayed progress is a query; the obligation set cannot float after execution starts. Otherwise missing evidence and reproducible sign-off are impossible. | Persisted manifests and explicit extensions instead of a completely stateless run. |
| Manual, automated, or both as the sufficient case execution model. | Derive that compatibility label from versioned execution bindings. Each binding names what it can demonstrate and who may execute it. Agent exploration is another binding, while agent review remains a finding. | More explicit binding semantics and a migration rule for simple type labels. |
| Any path-and-name matched report can have an exact historical case version. | CI prepares a binding manifest before execution; late imports retain unresolved version provenance until justified by an attestation. The current case is never guessed. | A preparation call for strong traceability, and an honest unresolved inbox for legacy uploads. |
| The roadmap delivers case authoring before the common result path. | First usable slice includes a narrow expectation-to-evidence-to-gate loop for all actors. Authoring alone cannot validate the product thesis. | Later delivery of shared steps, rich bulk editing, importer breadth, and report customization. |

## The DX/UX moves, made concrete

### The Linear move: act on the question in front of you

The default workspace is a saved question, such as "what blocks this build?" or "which checkout expectations lack evidence?" Its rows are expectations with evidence summaries. Open a row in a fixed detail pane; edit text, inspect the failure, record a result, or propose a fix there. Navigation preserves the list position, selection, and draft. URLs preserve the question, build, and selected expectation. Keyboard search, capture, result recording, and undo work without opening a setup modal.

Check J1, J3, J5, and J8 on the actual UI. A 30-case run records its result and advances with one key chord per case. A failed save leaves the user's text and position intact. Input accepts text immediately and meets the vision's paint budget. A result waiting for confirmation displays pending, not passed.

### The CircleCI move: a build receipt, not a plugin installation project

One portable CLI prepares a CI evidence scope, uploads JUnit, and reads its gate. CI vendors provide credentials and metadata, not separate business logic. The server turns the report into a receipt with completeness, unlinked tests, failing expectations, and next actions. Restarting the CLI resumes the same upload. The PR link opens the receipt at the current build; it never opens an unrelated global dashboard.

Check the identical scenario from a GitHub Actions step and a generic shell pipeline. Repeat an upload, crash between chunks, finish two shards out of order, and verify one fact per observation and one final gate. Accept 10k results in under 2 seconds and make them visible within 5 seconds on the agreed benchmark. Until measured, these remain draft budgets.

### The bun/deno move: a usable default path with one contract

Download one artifact, start Local, write one expectation, report one outcome, and connect one scoped agent without configuring a database or installing a vendor plugin. Local generates an owner identity and scoped credentials rather than disabling authorization. The CLI, MCP, UI, and API invoke the same operation contracts. Export is part of the artifact and preserves evidence, not just the latest cases.

Check J15 in under five minutes on a clean machine. Run the same contract fixtures through every transport and storage mode. Measure every token of tool definitions, requests, and responses for the reference agent; a small JSON payload is not itself a cost reduction claim.

## Usage first

### Quickstart as the user reads it

Create a small project and record evidence for checkout.

```sh
mainworthy start
# Opens the local workspace. The store binds to loopback.
mainworthy project create shop
mainworthy auth issue --project shop --actor agent --rights read,propose,observe
# Store the returned secret in your agent client's credential store.
```

In the browser, press `C`, type `Saved cards never expose the full card number`, and paste:

```text
Sign in with a saved test card.
Open checkout and expand the saved card summary.
Expect: only the last four digits are visible, including in the accessibility tree.
```

The draft survives a reload. When the observable expectation is present, autosave commits version 1. The title and steps stay editable. Your project uses review for agent proposals by default; human edits publish directly. Set stricter policies later without changing the case format.

Select **Check this build**, enter a commit or an identified local build, and choose **Manual check**. Mainworthy pins version 1, shows its steps, and records pass, fail, block, or skip. Fail asks for what happened; block and skip ask for a reason. The expectation now shows the actor, version, environment, and observation. Attach a screenshot if it helps. A green badge describes this build and binding, not every future release.

Add a stable Mainworthy ID to the matching automated test or link its runner identifier once. The next CI upload appears beside your manual observation. Connect the MCP URL and scoped credential from **Agent access**. Ask the agent to challenge checkout; proposals and findings appear on the same expectations. Mainworthy supplies context and records evidence; your agent's own tools run the software.

### Call site A: CI reports automated results

The CLI adapter obtains a scoped runner identity. None of these commands select a storage engine. Secrets are supplied by the CI credential store.

```sh
mainworthy scope open \
	--project shop --purpose pr --commit "$COMMIT_SHA" \
	--branch "$BRANCH" --pr "$PR_NUMBER" --build-url "$BUILD_URL" \
	--environment staging-chromium --configuration-digest "$CONFIG_DIGEST" \
	--producer checkout-tests --attempt "$ATTEMPT" \
	--shards 1 --request-id "$BUILD_ID:checkout:$ATTEMPT:prepare" \
	--write-receipt scope.json
# Receipt pins expectation versions and bindings BEFORE the runner starts.

run_existing_test_command --junit report.xml

mainworthy report junit report.xml --scope-receipt scope.json \
	--shard 0 --request-id "$BUILD_ID:checkout:$ATTEMPT:0"
# Example receipt: 10000 accepted, 9948 bound, 52 unlinked, processing.

mainworthy scope complete --scope-receipt scope.json --shard 0 \
	--executed-count 10000 --request-id "$BUILD_ID:checkout:$ATTEMPT:finish"

mainworthy gate read --scope-receipt scope.json --wait --timeout 30s
# Either a terminal verdict, or pending with the exact missing producer/job.
```

For CI, `scope open` defaults to the published automated bindings owned by the named producer. Its receipt contains the resolved test-to-version mapping, so the reporting adapter does not have to read every body. A project can provide an explicit selection instead. The reporting step runs after test-command failure too. Completing the last declared slot closes the CI scope. The gate read waits at most 30 seconds through all report receipts for that scope, then returns pending if work remains. Its exit status distinguishes a failed test gate, pending processing, and an upload failure. Losing the report leaves a pending gate. An unknown test is accepted and triageable; its failure still contributes to the producer's all-reported-tests rule. It cannot satisfy a pinned named expectation until its identity and executed version are established.

A report from a pipeline without `scope open` is still accepted as legacy evidence. The receipt says `version unresolved`, offers a bulk linking action, and cannot claim pinned-case coverage. Stable identifiers alone prove identity, not the version executed.

### Call site B: an agent challenges a PR through MCP

Tool names below are typed operation names. No generic SQL, arbitrary query language, or case-per-tool catalog is exposed.

```text
inspect_change({project:"shop", change:{base:"c80", head:"c81",
  paths:["src/checkout/card.ts"], requirements:["tracker:PAY-17"]},
  context:{review:"fresh", maxItems:20, maxBytes:24000}})
=> {inspection:"I7", asOf:"q420", candidateCount:8,
    completeness:"linked-subset", unmappedPaths:[],
    cautions:["links do not prove exhaustive code coverage"],
    items:[{expectation:"CB-42", version:"v7", risk:["changed","failed"],
      evidence:["O91"], bodyAvailable:true}], next:null}

read_expectations({refs:[{expectation:"CB-42",version:"v7"}],
  fields:["body","criterion","dependencies"], inspection:"I7"})
=> exact bodies and dependency versions, with content hashes

record_findings({inspection:"I7", requestId:"review81-findings",
  findings:[{key:"full-pan-a11y", subject:{expectation:"CB-42",version:"v7"},
    kind:"coverage-gap", text:"The DOM check can miss the accessibility tree.",
    reproduction:"Inspect the saved card's accessible name.",
    proposedPatch:{addCriterion:"Accessible names expose only the last four digits."}}]})
=> {findingIds:["F3"], disposition:"open"}
```

The agent reads the PR diff with its own tools. Its finding is a review claim, never a failed execution result. A human opens the finding, reviews its suggested patch, and accepts a proposal. Publishing creates v8; v7's evidence remains attached to v7.

For a repeat review, call `changes_since` with `q420` and scope `I7`. It includes changed expectations, link changes that bring new expectations into scope, policy changes, and review-ledger changes. Ask `inspect_change` again with `review:"reuse"` and the prior inspection. Review receipts bind subject version, dependency hashes, change fingerprint, reviewer method version, and finding state. They never suppress a review solely because the case body is unchanged. For independent review, `review:"fresh"` omits previous findings from context while retaining the ordinary evidence needed to assess the change.

For adversarial testing, the agent opens an exploration scope at the build, reads its pinned charter, executes with its own browser or API tools, and calls `append_observations` once for the results. New discoveries without a case enter `record_findings`; they do not become passing coverage until an expectation and binding exist.

### Call site C: a human executes and an author captures cases

A lead saves the question `checkout + required + not checked on build c81`. Select 30 expectations and **Start check**. Mainworthy resolves the published versions, expected bindings, environment, and required actors into manifest M8. The lead assigns work to Alex and Bea. Both see the same progress question, with their own work list first.

Alex opens item 1. Its pinned steps and criterion appear without another edit mode. `P` records pass and advances; `F` records fail, retains focus for actual behavior and an attachment, then advances. The actor's attempt key is allocated before submission, so a network retry cannot double-count it. Bea recording the same obligation adds another observation. A disagreement shows both; no latest-writer rule makes the failure vanish. Assignment is a coordination hint, never evidence.

The author presses `C` while reading a finding, pastes notes, and keeps typing while autosave queues. A save carries the base version and stable field IDs. Independent title and tag edits can merge; two edits to the same step return a preserved conflict proposal. Undo appends a compensating version if its touched fields are still unchanged. Otherwise it opens the existing diff conflict flow.

The operations used here are `find_expectations`, `open_scope`, `assign_work`, `read_scope`, `append_observations`, `revise_expectations`, and `decide_proposals`. The UI has no private execution endpoint. Draft text on the device remains separate from published project truth.

## Domain model

### Facts, identity, and valid states

Notation describes logical types and constraints. Opaque IDs are project-scoped unless explicitly organization-scoped. Constructors validate lengths, permissions, references, and invariants at the operation boundary. Interior functions accept validated types.

```text
Actor = Human {identity} | Runner {identity, producer} | Agent {identity, client, modelLabel?}
Context = {authenticatedActor, authorizedProject, requestId, policyRevision}
RequestKey = (project, actorIdentity, requestId)
Revision = opaque monotonically increasing committed project position
Mutation = {key: RequestKey, payloadHash, outcome, revision}
// Same key + same hash returns original outcome. Different hash is an error.

Software = Source {repository, commit} | Build {artifactDigest, sourceCommit?}
Environment = {name, configurationDigest}
Target = {software: Software, environment: Environment}

Expectation = {id, publishedHead: VersionId?, archived: Boolean}
ExpectationVersion = {id, expectation, parent: VersionId?, author: Actor,
  acceptedAt, contentHash, reason?, body: ExpectationBody, revision}
ExpectationBody = {
  title, criterion: NonEmptyText, preconditions: Text,
  steps: OrderedMap<StepId, {action, expected?}>,
  sharedSteps: OrderedMap<UseId, SharedStepVersionRef>,
  folder: FolderId?, tags: Set<TagId>, fields: ValidatedFieldValues,
  bindings: NonEmptySet<ExecutionBinding>
}
ExecutionBinding = Manual {id, instructionsRef, proves: CriterionRef}
  | Automated {id, test: TestKey, identityEpoch, proves: CriterionRef}
  | Exploration {id, charter, proves: CriterionRef}
// A case may have multiple bindings. A review is not an execution binding.
// Body includes the criterion; pins include shared-step and schema versions.
// A capture without a criterion lives as Draft, not ExpectationVersion.
Draft = {owner, device, draftId, text, baseVersion?}
Proposal = {id, author, baseHeads, proposedBodies, reason?, state:
  Open | Accepted {newVersions} | Rejected {by, reason}}
TestKey = {producer, explicitStableId} | {producer, normalizedPath, fullName, parametersDigest}

PlanningView = {id, revision, query, versionRule: FollowPublished | Pin {refs}}
Scope = OpenScope | ClosedScope | FrozenScope
OpenScope = {id, manifest: ManifestId, generation, producerRoster, purpose}
ClosedScope = {id, manifest, generation, closure: ClosureId}
FrozenScope = {id, manifest, generation, closure, certificate: CertificateId}
Manifest = {id, target: Target, policyRevision, graphRevision, createdBy,
  obligations: OrderedMap<ObligationId, Obligation>, contentHash}
Obligation = {expectation: VersionRef, dependencyHash, binding: BindingRef,
  evidenceRule: RuleId, required: Boolean}
// Immutable manifest. An extension creates a new generation and reopens gates.
// Only a closed generation with no in-flight registered producer may freeze.
ProducerSlot = {producer, attempt: NonNegativeInt, shard: NonNegativeInt,
  state: Registered | Complete {reportIds, executedCount} | Aborted {reason}}
WorkAssignment = {obligation, revision, assignedTo: Set<Identity>}

Observation = {id, actor: Actor, observedAt, receivedRevision,
  target: Target, origin: Origin, outcome: Outcome,
  binding: ObservedBinding, evidence: List<ArtifactRef>}
Origin = Scoped {scope, generation, obligation, actorAttemptKey}
  | Imported {report, itemKey, producerAttempt, shard, runnerRetry}
ObservedBinding = Exact {expectation: VersionRef, binding: BindingRef, dependencyHash}
  | Unresolved {test: TestKey, reason: UnknownTest | MissingExecutedVersion}
Outcome = Pass {actual?} | Fail {actual: NonEmptyText, category, signature?}
  | Blocked {reason: NonEmptyText} | Skipped {reason: NonEmptyText}
Category = Assertion | Infrastructure | Environment | Unknown
// Actor kind is provenance, not a confidence or pass multiplier.
// Uploaded test failures need not know their eventual Mainworthy expectation.

EvidenceAmendment = Invalidate {observation, by, reason}
  | Bind {observation, exact: Exact, basis: ManifestProof | VersionAttestation}
  | Replace {observation, replacement, by, reason}
// Original is intact. Only authorized amendments affect the effective view.
// Bind preserves the target and outcome; a mere identity link is not a proof.
Report = {id, requestKey, contentDigest, scope?, producer, target, metadata,
  state: Receiving | Accepted {blob, itemCount} | Projected {through} | Rejected {reason}}
CIMetadata = {commit, branch, pr: Number | NotApplicable,
  buildUrl, attempt, shard, configurationDigest}
ArtifactRef = {digest, byteCount, mediaType, retentionClass}
ArtifactState = Available {location} | Removed {policy, at, digest} | MissingExternal {url}

GraphNode = ExpectationId | VersionRef | RequirementRef | CodeRegionRef
  | TestKey | SoftwareRef | BuildRef | DeploymentRef | ObservationId | FindingId
LinkFact = {id, from: GraphNode, relation: TypedRelation, to: GraphNode,
  author, revision, state: Added | Retracted {previousLink}}
// Structural result/version/build edges derive from source facts.
// Authored edges supply requirement coverage, code impact, and defect links.
RequirementRef = {system, stableExternalId, sourceRevision?, displaySnapshot?}
CodeRegionRef = {repository, normalizedPathPrefix, symbol?}

Finding = {id, author, subject: VersionRef | Target | ObservationId,
  text, reproduction?, proposedPatch?, kind, stateRevision}
FindingDecision = Open | Accepted {proposalOrDefectRef} | Deferred {reason}
  | Rejected {by, reason}
ReviewReceipt = {reviewer, methodVersion, subjectVersion, dependencyHash,
  changeFingerprint, findingRevision, completedAt}
Inspection = {id, changeFingerprint, scopePredicate, graphRevision,
  subjectRefs, continuation?, completeness: LinkedSubset | Truncated | ExplicitScope}

PolicyRevision = {id, review: None | Agents | All,
  startApproval: Boolean, gateRules: List<TypedEvidenceRule>,
  freezeRequired: Boolean, signoff: None | NamedDifferentHuman,
  quarantineRule: RequireException | ExcludeWithDisclosure}
TypedEvidenceRule = RequiredBindingPassed | AllReportedAssertionsPassed
  | NoUnresolvedRequiredEvidence | NoConflictingEvidence
  | RequiredSignoff | NoOpenQuarantineExceptions
Gate = Pending {reasons, through} | Blocked {reasons, through}
  | Eligible {basis: EvidenceSelection, through, policyRevision}
EvidenceSelection = {manifest, closure, selectedObservationIds,
  amendmentRevision, graphRevision, ruleVersion, exceptions, contentHash}
Certificate = {selection: EvidenceSelection, by, at, signatureLevel: IdentityAndTime}
QuarantineDecision = {binding, owner, reason, issue?, until?, policyRevision}
// Quarantine does not edit outcomes. Automatic recovery suggests a decision.
// First slice never silently removes quarantine.
```

Logical types keep separate concepts separate. An observation exists independently of a run; `Origin` never requires CI to fabricate a human run. A manifest is needed only when a question promises completeness, assignments, or a decision. Run screens query effective observations for that manifest and target. Findings and links are append-only records, but remain distinct from execution outcomes.

A planned set with no results has 30 pending obligations, not zero failures. One passing automated binding does not prove a required manual accessibility check. A policy may accept either binding for a criterion if explicitly configured. Default rules require the manifest's named binding and reject conflicting authoritative evidence.

### Storage shapes required by the access patterns

These are durable query structures, not optional cache proposals. Each owner updates its structures transactionally or through a replayable projector. Physical implementation must demonstrate equivalent bounds in embedded and server modes.

| Owner and authoritative facts | Required structure | Bound and update rule |
| --- | --- | --- |
| Catalog: versions, publication decisions, field schemas, folder versions | Head lookup `(project, expectation)`; immutable lookup `(expectation, version)`; ordered head rows `(project, folder, sortKey, id)`; tag and validated-field postings; full-text postings and rank cursor | Head rows, facet membership, and searchable published text change in the same commit. Lists page at a fixed revision; no fetch-all filtering. Save appends a full version and advances the checked head. |
| Catalog: shared-step versions | Reverse dependents `(sharedStepId, expectationId)` with pinned use refs | Publishing a shared step produces one attributable batch of new dependent case versions or proposals. Existing results and manifests keep old pins. Large batches use a staged atomic publication. |
| Evidence: observation and amendment facts | Immutable observation lookup; time series `(project, expectation, binding, target, attemptOrder, id)`; unresolved series `(producer, testKey, receivedRevision)`; origin uniqueness `(report, itemKey)` and `(scope, actor, actorAttemptKey)` | Append once. Effective bindings are derived with amendment revision. No history scan to read last N results. Amendments trigger correction of affected derived rows. |
| Scope: manifest, roster, closure | Ordered manifest items `(scope, generation, ordinal)`; obligation membership reverse lookup `(expectationVersion, target, scope)`; slots `(scope, generation, producer, attempt, shard)` | Run reads fetch a page of obligations plus outcome projection rows. Roster completeness uses exact slots, never elapsed time. |
| Analysis: derived current evidence | Outcome row `(manifest, obligation, actorStream)`; count row `(manifest, actorStream, status)`; target summary `(expectation, binding, target)` | Update each affected obligation and aggregate delta once per fact. Read merges actor streams using one named selection rule. Multiple observations remain addressable. |
| Analysis: flakiness | Cohort row `(testKey, identityEpoch, expectationVersionOrUnresolved, commit, environmentDigest)` containing pass/fail counts and representative IDs; recent-cohort ordering by commit ancestry/run sequence; binding summary with rule version and evidence IDs | Same-cohort contradiction updates on arrival, independent of upload order. Keep deterministic recent windows and exact cohort evidence. No nightly full-history calculation. |
| Links: authored edges | Forward and reverse active adjacency `(node, relation, neighbor)`; historical edge revision rows; path-prefix posting `(repository, pathPrefix, expectation)`; requirement posting `(requirement, expectation)` | Add/retract atomically updates both directions in Links. Prefix lookup follows path ancestors; traversal is bounded by depth, node count, and time. Structural edges are queried from source-owner relations, not copied into mutable link rows. |
| Review: findings, decisions, receipts | Findings `(subjectVersion, state, id)`; receipts `(reviewer, method, subjectVersion, dependencyHash, changeFingerprint)` | Decisions append once. Fresh review suppresses ledger presentation, not execution evidence. |
| Journal: committed change envelopes | Ordered feed `(project, revision)` plus scope postings `(scopeKind, scopeId, revision)`; dependency invalidation postings | Domain commit and feed envelope are atomic. A scoped feed includes removals and dependencies that change membership, not only objects still in the current scope. |
| Analysis: gate and certificate views | Decision row `(manifest, closure, policyRevision)`; required-input watermarks; selected evidence IDs stored for terminal selection | Gate read is a point read. A known revision gap returns pending and never a stale eligible verdict. Certificate keeps a finite immutable selection. |
| Runtime: retry and work facts | Mutation receipt `(project, actor, requestId)`; job key `(kind, sourceId, sourceRevision)`; lease, attempts, projector checkpoint | Work survives process failure; leases coordinate Cloud workers; uniqueness makes retry harmless. Optional caches mirror these structures, never own them. |

A derived structure's dependency revision is not just a timestamp. Projectors publish a row with a source revision, rule version, and contiguous checkpoint. A query requiring facts through `q420` cannot answer from a projection through `q417`. Unrelated projections need not wait. Gate evaluation names the exact inputs it requires.

### Trace every dominant access pattern

1. **Read, list, search cases.** Resolve the head or explicit version through Catalog lookup. Page the head index or text postings; join precomputed evidence and flaky rows for those IDs only. Request body fields only for opened cases. The search snapshot and cursor fix ordering. The backend targets remain p95 under 20 ms for one case, 50 ms for a page, and 100 ms for search on the vision dataset.
2. **Execute a run.** Resolve query membership and published versions once into a manifest. Read 30 or fewer ordered items, their pinned bodies, and actor outcome rows. Append each actor's result with its preallocated key. Update that actor's rows and the merged progress. A failure and another actor's pass remain a conflict until an explicit resolution or accepted rerun rule applies.
3. **Ingest 10k results.** Persist the report bytes and deduplication receipt first, within the acceptance budget; acceptance is not completed parsing. A persisted job parses bounded chunks into staged normalized observations. Chunk keys and item positions survive retries. Validate counts and input limits, then expose the report with one publication marker. Projectors process published items and publish readiness through the report. The UI says processing until that point. Malformed input never exposes a partial successful report. Multiple shards remain separate receipts but one complete roster.
4. **Update flaky state on ingest.** For each automated observation, update its exact cohort counts, derive same-commit contradiction, and update the binding summary plus representative evidence. Assertion outcomes drive flakiness; setup failures remain separate. Weak signatures can support suspicion, never substitute for stronger contradictory evidence. Version or environment changes split cohorts. Stable-branch alternation is only a suspicion when code relevance is unknown. Discovered late amendments repair affected cohorts by keyed reads, not a project scan.
5. **Find an impact set.** Normalize changed paths, look up path-prefix and requirement postings, follow shared-step dependents, and union the reachable expectation IDs. Page ranked head rows and bounded evidence summaries. Return edge provenance, unmapped paths, and truncation. Sparse links yield a linked subset, never a claim of complete coverage. Fallback search can be offered explicitly; it does not silently widen the set and inflate confidence.
6. **Read changed-since for an agent.** Decode a cursor bound to project, query fingerprint, authorization epoch, and source revision. Read scope postings after that revision, including graph-membership changes and review receipts. Return hashes and small diffs before bodies. If the cursor predates retained feed history or authorization changed, return `ResetRequired` and a bounded snapshot path. Losing a notification is harmless.
7. **Follow traceability.** Requirement reverse adjacency yields expectations; version/result relations yield selected observations; target relations yield commits/builds; deployment facts yield environments; defect edges yield tracker IDs. Historical views fix graph and amendment revisions. Each hop is separately paginated, and a release matrix reads its fixed manifest and per-obligation state rather than performing an unbounded traversal.
8. **Read a gate in CI.** Resolve its manifest generation, policy, and producer roster. Read the decision row and compare required-input checkpoints with the committed horizon. Missing shard, unprojected report, absent obligation evidence, unknown required version, or conflicting evidence yields pending or blocked with a code and source ID. When eligible, return the selected evidence hash. A deploy consumes a certificate for the exact build and environment, not a moving pass-rate percentage.

### Ordering, concurrency, and corrections

Evidence selection never uses received time as a truth ranking. CI has declared producer attempts, shards, and runner retries. A retry policy may accept a final pass while preserving the first failure and marking the test flaky. Manual and agent streams have actor-local attempt order. Cross-actor disagreement remains visible. If a person wants a retest to replace a result, they name the prior observation explicitly and append the replacement.

The transport cannot declare its own trusted actor or executed version. Authentication establishes the actor. The operation checks scoped authority, validates the receipt and manifest, and stamps the accepted revision. CI evidence can still be dishonest; Mainworthy records producer claims and provenance, not a guarantee that the runner truly executed code.

Two proposals accepting against the same head compete in one version-checked transaction. A disjoint field patch can rebase by stable field IDs, including tag-set deltas. Step order edits share an order field and conflict. Publication recomputes the content hash after the merge. Assignment changes are version-checked Scope facts and do not lock execution. A manifest pins policy for reproducibility. Changing project policy applies to new scopes by default; applying it to an active check explicitly creates a new generation. Tightened authorization applies immediately. An emergency rule change can revoke existing eligibility rather than reinterpret an old certificate silently.

A frozen certificate never changes after a late observation or correction. A separate eligibility or revocation fact marks a superseded or compromised certificate; consumers check it before deployment. Freeze fixes evidence IDs, link revision, rule revision, and dependency versions. Artifacts retained by that certificate cannot disappear through ordinary garbage collection. A declared retention action must preserve its removal record and change the certificate's availability status. The team can still append later observations after release.

## Operation layer and module map

### One typed operation catalog

All transports adapt to this catalog. Wire parsing, authentication, pagination encoding, and attachment streaming belong to adapters. Operations accept domain arguments and return domain outcomes; no HTTP request, MCP result, CLI flag, or XML node enters business logic. Exported contracts have bounded pages and typed errors.

| Operation | Caller-visible depth |
| --- | --- |
| `configure_project` | Creates a project or revises its policies, schemas, folder definitions, or scoped identities under checked revisions. Validates cross-policy invariants. |
| `find_expectations` | Searches or pages a typed selection with chosen fields, summaries, and stable cursor. |
| `read_expectations` | Reads exact versions, conditional hashes, history ranges, or diffs for bounded references. |
| `revise_expectations` | Applies one attributable bounded batch of domain edits with base heads; handles disjoint merge, proposals, publish, restore, and compensating undo through the same revision path. |
| `decide_proposals` | Accepts or rejects proposals, checks reviewer independence and current heads, records one decision. |
| `revise_links` | Applies typed add/retract edges and identity mapping; validates endpoints and records provenance. Does not retroactively assert an executed version. |
| `inspect_change` | Produces a bounded impact context, explicit uncertainty, evidence digests, optional review reuse, and an inspection reference. |
| `changes_since` | Returns a scope-aware feed with hashes, invalidations, and removals; repairs missed live notifications. |
| `record_findings` | Appends a finding batch or checked decisions; retains proposal and defect references. |
| `open_scope` | Resolves planning selection, pins obligations, registers producer roster, checks start approval, and returns a usable receipt. |
| `assign_work` | Changes coordination ownership under a checked revision; no evidence mutation. |
| `read_scope` | Pages pinned work and merged evidence, or reads a gate with its required horizon and reasons. |
| `append_observations` | Validates provenance and pins, deduplicates actor attempts, appends a bounded batch of direct observations, schedules projections. |
| `accept_report` | Owns upload receipt, bounded parsing, normalization, idempotent publication, unresolved evidence, and processing state. Same evidence acceptance rules as direct writes. |
| `close_scope` | Completes or aborts a producer slot, or closes the manifest once all slots are settled. Retries return the same closure. |
| `decide_evidence` | Records authorized invalidation, replacement, version attestation, quarantine, exception, freeze/sign-off, or certificate revocation. Each is a typed command with its own preconditions. |
| `transfer_project` | Produces or validates/imports a versioned portable bundle with identities, facts, artifacts, rules, and checksums. Rebuilds derived structures rather than importing them as truth. |

The catalog has 17 operations, not 17 tools for every subtype. The initial MCP advertises only the operations permitted by the token's capabilities; its total definition cost is measured. If typed unions inflate context, shorten definitions or expose task-specific subsets, not a second implementation. The CLI `gate read` is an adapter to `read_scope({view: Gate})`, not a competing gate evaluator. `scope complete` adapts to `close_scope`.

### Modules by knowledge and state ownership

```text
adapters/{ui,rest,mcp,cli,ci-formats}
	decode inputs, invoke operations, render outcomes
operations
	public contracts + authorization + transaction boundary
catalog
	expectations, versions, proposals, schemas, folders, shared-step dependencies
scope
	planning views, manifests, roster, assignment, closure, approval-to-start
evidence
	observations, provenance amendments, reports, normalized test identities
links
	authored relation facts and adjacency; no copied result truth
review
	findings, decisions, reusable review receipts, inspections
policy
	policy revisions, exceptions, quarantine decisions, signed selections, revocations
analysis
	replayable evidence, flaky, impact-risk, coverage, and gate projections
artifacts
	artifact references, retention, bytes, verified storage adapter
identity
	principals, project grants, token scopes, authorization epochs
runtime
	mutation receipts, journal envelopes, persisted jobs, projector checkpoints
transfer
	portable format and restore validation; imports through owner constructors
```

Every module owns only the state named beside it. Policy owns decisions and Analysis owns their reproducible evaluations. Scope owns assignments and Evidence owns observations. Catalog owns automated bindings; Evidence's test identity directory tracks reported producer identities but cannot publish a binding. Links owns authored edges. Structural edges are read relations from their source owners through a fixed traceability contract.

Only `operations` and the contract types are importable by adapters. Storage implementations and projectors cannot be called from UI or MCP. Modules expose a few deep internal functions to Operations, not their tables. Pure `selectEvidence`, `classifyFlakiness`, `mergePatch`, and `evaluateGate` functions contain the business rules. Shell code loads bounded facts, commits writes, and dispatches persisted work. No layer of pass-through services exists between Operations and the owning module.

A domain write, mutation receipt, and journal envelope commit atomically. Evidence publication also commits its projection job key. Operations coordinates multi-owner transactions; the owners never independently synchronize duplicate truth. A replay can reconstruct every Analysis row from facts and rule versions.

### Signature sketch and tricky logic

```text
find_expectations(ctx, selection: ValidSelection, fields: FieldSet,
  page: BoundedPage) -> SnapshotPage<ExpectationSummary>
	= not implemented

revise_expectations(ctx, batch: NonEmptyBounded<RevisionEdit>, bases: BaseHeads)
  -> Published {versions, revision} | Proposed {id} | Conflict {proposal, changedFields}
	= not implemented
	// TODO load checked heads, merge only provably disjoint fields,
	// then apply publication policy inside the same transaction.

append_observations(ctx, inputs: NonEmptyBounded<ObservationInput>) -> Receipt
	= transaction {
		replay = runtime.lookupMutation(ctx.key, hash(inputs))
		if replay exists: return replay
		validated = evidence.validatePinsAndOrigins(ctx, inputs)
		facts = evidence.appendUnique(validated)
		runtime.appendEnvelopeAndProjectionJob(facts)
		runtime.recordMutation(ctx.key, hash(inputs), ids(facts))
	}

accept_report(ctx, source: VerifiedUpload, meta: ValidReportMetadata) -> ReportReceipt
	= not implemented
	// TODO atomically persist the bytes reference, report receipt, and job.
	// Parsing is resumable and bounded; a publication marker hides staged rows.
	// Retry after losing the response returns the same receipt.

classifyFlakiness(cohort: Cohort, recent: BoundedCohorts,
  rules: FlakyRuleVersion) -> FlakySummary
	= not implemented
	// TODO exact same-commit assertion contradiction is strongest.
	// Infrastructure, unknown version, environment drift, and weak signatures
	// must not silently become equivalent assertion evidence.

selectEvidence(manifest: Manifest, observations: ActorStreams,
  amendments: EffectiveAmendments, policy: PolicyRevision) -> EvidenceSelectionOrGap
	= not implemented
	// TODO retain contradictory streams; select ordered reruns only under
	// declared rules; distinguish no evidence, blocked, skipped, and failure.

read_scope(ctx, scope: ScopeRef, view: WorkPage | GateView) -> ScopeAnswer
	= not implemented
	// TODO gate reads compare required-input checkpoints and closure generation.
	// A pending projection cannot return a previously eligible verdict.

freezeSelection(ctx, scope: ClosedScope, expectedSelectionHash: Digest) -> Certificate
	= not implemented
	// TODO revalidate policy, checkpoints, reviewer independence, and hash
	// in one transaction before persisting the immutable selected IDs.
```

A failed transaction leaves no visible facts. A failed worker leaves persisted staged work and a checkpoint. A failed artifact upload leaves a temporary artifact eligible for collection, never a dangling available reference. Notification delivery and outbound CI status updates use persisted jobs keyed by source revision. An old callback cannot overwrite a newer status; update the integration's stable check identity with its generation and revision.

## Product surface

Users live in five objects: expectations, build checks, findings/proposals, linked requirements, and project settings. A planning view is a saved question; a run is a check against its pinned manifest. The event stream is available as evidence history, not imposed as the default screen.

| Screen | Main question and shared representation |
| --- | --- |
| Workspace | "What needs attention?" A saved list of expectations with current-build gaps, new failures, conflicting evidence, stale bindings, or drafts. Actor kinds are small provenance labels in the row, not separate tabs. |
| Expectation pane | "What do we promise, and why do we believe it?" Editable body, version diff, required bindings, evidence on the selected build, and findings. Manual pass, CI failure, and agent reproduction appear together in the same ordered evidence list. |
| Build check | "What blocks this PR or release?" Required obligations, producer completeness, new assertion groups, infrastructure failures, quarantines, and unresolved imports. A keyboard work queue uses this same screen for manual and agent-targeted assignments. |
| Change review | "What changed, and what remains unproved?" Impacted expectations, edge provenance and uncertainty, version diffs, agent findings, and proposals. Review acceptance never records execution. |
| Requirement/release view | "Can we justify this decision later?" Requirement matrix at a pinned build, gap list, evidence chain, gate reasons, and certificate/export. Empty cells show unknown, and quarantine exceptions remain visible. |

Settings contains policy and access controls; it is not an onboarding prerequisite for first capture. Readers can deep-link into a build or requirement with results-only access. A result-view role redacts unpublished drafts, private finding content, and inaccessible attachments consistently through all transports.

The default case summary says `manual + automated`, `manual`, or `automated` for compatibility with common reporting; exploration eligibility is explicit alongside those labels. Automation rate counts eligible bindings on published expectations and distinguishes ever-linked from recently reporting. Staleness is measured against declared producer cadence or recent producer runs, not mere calendar silence when CI did not run. An automation backlog ranks manual effort by recorded duration and run frequency, with no fabricated estimate when those facts are missing.

Live notifications update counts and show a cue for changed content. They do not replace an open pinned body, reorder the active execution queue, or steal focus. Pending offline edits keep their base versions. Approval, freeze, and other operations requiring current server state are unavailable during a disconnect.

## First deliverable slice

Ship one credible loop, not an isolated case editor: capture an expectation, link an automated identifier, pin a build check, collect human and CI observations, give an agent a bounded impact context, retain its findings and proposal, and explain a gate. This is the smallest slice that tests whether the three actors truly share evidence.

The slice includes:

- Local's zero-configuration artifact and Server using the same contracts. Prove the same artifact's multi-instance Cloud correctness with persisted jobs and cache disabled before calling it the first usable version, as decision 0002 requires. An elaborate Cloud installer is deferred.
- Multi-user project identities, reader/author/reviewer roles, scoped runner and agent credentials, versioned cases, diff, restore, conflict proposals, and a conservative review-for-agents default.
- Draft capture and durable text, virtualized search, fixed detail pane, one folder level and tags, manual execution with screenshot, and version-stamped observations. Backend and input latency checks remain mandatory.
- JUnit reporting, pre-execution binding receipts, resumable ingestion, unresolved inbox with identity linking and explicit version attestation, shard completeness, exact-commit flaky detection, manual quarantine decisions, failure digests, and a deep CI receipt link.
- Support for authored code-path and external requirement links; bounded impact reads, changed-since, findings ledger with fresh-review option, all required write operations through MCP, and the shipped agent skill.
- Typed required-binding and all-reported-assertions gates, explicit quarantine exceptions, build/deployment recording, identity-and-time sign-off, and freeze/export of a fixed evidence selection. Loose projects bypass approval ceremony through policy, not through a different model.
- Portable project export/import, attachment bytes and tombstones, tested backup/restore, migration failure handling, and replay equivalence for derived evidence and gates.

Deliberately defer reusable shared-step authoring, arbitrary custom fields, advanced bulk undo, symbol-level code integration, automatic code-impact inference, duplicate-case detection, weak-signature flaky models, automatic quarantine release, tracker synchronization, broad importer support, rich analytics, notifications, SSO, legal signatures, hosted billing, and a full offline replica. The types reserve dependency pins and policy boundaries without claiming these capabilities ship. Imports from existing tools may be an adoption blocker; the first slice is for a new or CSV-seeded project, and its positioning must say so.

### Evidence required before implementing or calling the slice done

Before edits, write executable specifications for these contracts after the stack decision. This package proposes checks and does not claim they have run.

| Check | Deciding observation |
| --- | --- |
| Shared three-actor build | Human, runner, and agent observations for one pinned expectation appear in one read; a review finding alone leaves the obligation pending. |
| Missing and contradictory evidence | Empty stream, omitted shard, blocked case, unresolved version, and person/agent disagreement cannot produce an eligible gate under the default policy. |
| Crash and retry | Kill at byte acceptance, staged chunk, publication, projection, and response loss. Resume with the same keys; effective facts and selected evidence IDs equal the uninterrupted run. |
| Late and corrected facts | Reverse ingest order and append invalidation. Same-commit flaky evidence and gate selection match replay; the frozen certificate stays identical and its revocation is separate. |
| Concurrent edits | Two disjoint patches merge with attribution; two patches to one step preserve both versions in a conflict. Undo never discards another author's subsequent edit. |
| Bounded agent jobs | A4 and A5 retain impact uncertainty, discover link-membership changes, avoid unrelated bodies, and stay within budgets established against naive reads; fresh review omits ledger findings. |
| Transport and access equivalence | The same scope and policy reject forbidden operations through UI, REST, MCP, CLI, and ingest. No forbidden data appears in summaries or change feeds. |
| Portability and replay | Move Local to Server, restore a backup, and rebuild projections. IDs, hashes, pinned dependencies, selected evidence, and gates agree. Cloud concurrent workers produce the same facts. |
| Performance and real UI | Existing vision budgets hold at 100k cases and 1M then 10M results with concurrent ingestion; J1/J3/J5/J8 and failure recovery meet browser budgets without lost input. |

The biggest failure mode is projection complexity becoming a hidden distributed system. Reject the design if replay cannot match incremental results or if a point gate read needs a stream scan. Start with exact-cohort flakiness and narrow typed gate rules, and prove the closure/watermark protocol before widening policy or analytics.
