# Candidate B rationale

## Problem

Teams need a defensible answer about a change, but case libraries, manual runs, CI reports, and agent reviews answer different questions. Merely combining their result rows does not establish what they prove. Historical versions, commercial participation limits, and tiered automation access add costs documented in the repository's competitive analysis. The claim that today's tools force a duplicate release spreadsheet remains a hypothesis.

## Usage (caller's view)

A person opens a change and sees what it needs proven. A pinned proof plan selects expectations and acceptance clauses. CI prepares a target-and-version manifest, runs its existing tests, and uploads one idempotent report. A human executes the same obligations and captures missing cases from failures. An agent gets a bounded impact brief, records version-bound findings, and resumes from a checkpoint that includes the target diff and dependencies. The caller reads one freshness-stamped gate with decisive reasons.

## Shape

Change revisions are immutable code, artifact, or named-session targets. Proof plans are immutable obligation sets with scope confidence, exact expectation versions, contexts, and required reporters. Evidence has an independent actor, execution method, target, and version basis. Definition owns reusable expectations and proposals. Evidence owns observations and report processing. Review owns findings and per-actor completion. Proof owns plans and gate decisions. Indexed read structures and incremental projections are required parts of the design, with a freshness check before any green decision.

The thesis is change-centric, but case authoring does not require a change. Named sessions let a tester work without CI metadata while honestly limiting what the resulting evidence proves. Existing decisions about stack neutrality, self-hosting, process policy, concurrency, audience, and token cost remain constraints.

## Synthesis decision

## Tradeoffs accepted

- We accept early work on immutable target identity in exchange for an honest statement of what evidence proves.
- We accept a required start-time version manifest for gate-eligible automation in exchange for avoiding a false claim that code exercised the latest case text.
- We accept pending gates during ingestion and projection lag in exchange for refusing stale green decisions.
- We accept persisted, rebuildable read structures in exchange for bounded case lists, impact sets, traceability, and gate reads under heavy ingestion.
- We accept incomplete impact results and broader fallback runs in exchange for admitting sparse mappings rather than hiding coverage gaps.
- We accept explicit dispute resolution in exchange for preserving a human failure when another source reports a pass.
- We accept a narrower first product and earlier CI work in exchange for testing the integrated product idea before building a broad case editor.
- We accept manual quarantine exit and limited flaky signals in the first slice in exchange for explainable state and a smaller implementation.
- We accept more precise coverage labels in exchange for separating declared automation intent from active bindings and real evidence.
- We accept external requirement and defect links first in exchange for keeping Mainworthy out of the issue-tracker business.
- We accept a bounded operation vocabulary and generated MCP groups in exchange for one policy implementation, subject to actual tool-definition token measurement.

## Alternatives considered

- **Suite first, unified result stream.** This hides ingestion and run mechanics well, but leaves change scope, missing proof, and release decisions to another orchestration layer. Its main public object asks the user to assemble a suite before answering the practical question.
- **Every automated test becomes a case automatically.** The importer has a small interface but creates an enormous maintenance burden and claims expectations that no author specified. Keep unlinked observations and allow explicit creation or reviewed mapping.
- **Newest result wins.** This makes the state machine small by throwing away knowledge the caller needs. It cannot explain a manual failure beside a CI pass, and retries can silently erase a flaky signal.
- **Head commit identity everywhere.** This makes preparation simpler but confuses head tests, merge-tree tests, and deployed artifacts. Exact target manifests cost more at the boundary and remove that decision from every later caller.
- **Runtime result and code review share a pass status.** This has fewer visible states but gives an agent's opinion the authority of exercised behaviour. Use review clauses and exercise clauses in one plan instead.
- **Synchronous ingestion and gate computation in the upload request.** This hides fewer crash and lifecycle details but couples a 10k-result write to interactive latency and timeout limits. Durable acceptance, bounded chunks, and explicit pending state hide the actual recovery machinery without hiding completeness.
- **Fully dynamic gates over all history.** This avoids projections but leaks performance costs into every CI read. Incremental clause state and indexed witnesses keep the public gate request small.
- **Every transport implements its own workflows.** This looks convenient in one adapter and creates repeated policy knowledge. Generated adapters and one domain operation layer keep correctness local to the owning rule.
- **A workflow engine or execution service.** This might coordinate outside tools but changes the product into infrastructure. Mainworthy coordinates proof and records evidence; existing CI, browsers, and agent tools do the execution.

## Open questions and risks

These are questions for Daniel during synthesis, not requests blocking this candidate.

- Will teams tolerate an explicit case-version annotation or start-time manifest for automation that must satisfy a gate? Should unproven-version evidence be allowed by a clearly weaker loose-profile policy, or remain context-only as proposed?
- Does the proof-plan screen fit teams that spend most of their time maintaining cases rather than releasing changes? Do named sessions solve that without making every task a forced planning exercise?
- When source-path and requirement links are sparse, is broader area confirmation acceptable, or is impact selection too expensive to justify the change-centric home screen? The biggest product risk is confident-looking scope with insufficient links.
- Should a fail-then-pass require explicit resolution by default, or may a loose policy accept the final attempt while retaining its unstable label? Which disagreements must always block?
- Should direct human edits and reviewed agent edits be the new-project defaults, or should the first project start entirely loose until the first review job?
- Is migration from TestRail or Qase essential for launch? If so, the narrower slice must replace another item with a verified importer rather than add unbounded scope.
- Which build systems supply trusted deployment identity and case-version manifests first? What does a manual tester use when a staging environment cannot identify its artifact?
- Must a release gate enforce only Mainworthy's recorded facts, or does a deployment system need a signed generation-bound decision token? The design offers the latter without claiming control of deployment.
- Are identity-and-time sign-off and immutable seals enough for the first strict-profile workflow? Qualified signatures and retention certification remain outside the slice.
- Can embedded and server storage candidates meet atomic invalidation, reverse-link queries, and generation publication without divergent semantics? Benchmark this before choosing a stack.
- Can the seven MCP tool groups stay legible and cheaper than exposing narrow operations? The fixed reference-agent measurements must decide, rather than tool-name count.
- Do archived or imported case histories contain reliable executed versions? The product must preserve unknown provenance instead of inventing exactness during migration.

## Next implementation step

Build a stack-neutral interactive mock of one change with a manual failure, a CI retry, an agent finding, an unmapped path, and a moved PR revision, then validate the resulting obligations and gate explanations before the stack benchmark or product implementation.
