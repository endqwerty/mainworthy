## Problem

The team's useful knowledge is split between test definitions, CI reports, manual runs, and agent conversations. Purchasing more seats or a history tier does not join that knowledge. The repository verifies history gating, viewer pricing, and API tiers, but has not measured the incumbents' coordination cost or speed. This candidate tests a structural answer: every actor contributes immutable evidence against the same addressable expectations and build context.

## Usage (caller's view)

A human captures an observable expectation in place and runs a pinned manual check. A CI pipeline prepares a version-binding receipt before execution, sends one resumable JUnit report, completes its declared producer slots, and reads a gate with explicit reasons. An agent receives a bounded PR impact context, reads exact relevant versions, and appends findings or actual execution observations through the same operations. A lead freezes a finite evidence selection; an auditor can reproduce its requirement-to-deployment chain after export and restore.

The quickstart and all three call sites precede the types in `design.md`. The examples intentionally distinguish review claims from execution outcomes and unknown test identity from unknown executed version.

## Shape

An immutable observation is the central execution record. It carries actor, target, outcome, provenance, and an exact or explicitly unresolved version binding. Expectation versions define observable promises and execution bindings. A manifest pins the obligations needed to interpret missing evidence. A run is a read over observations against that manifest, not a copy of cases or another mutable result model.

Typed links supply impact and traceability. Findings and reusable review receipts preserve agent work without manufacturing test coverage. Durable query structures give bounded case, evidence, cohort, graph, change-feed, and gate reads. Replayable projections select evidence and derive flakiness, coverage, and gates under versioned rules. Closure and input checkpoints prevent partial ingestion from producing a false green verdict.

Seventeen domain operations hide merge, provenance validation, idempotency, parsing, policy, and projection coordination. Transport adapters invoke those operations without access to internal tables. One module owns each fact. Business rules are pure functions over bounded validated inputs. The design chooses no stack.

## Synthesis decision

## Tradeoffs accepted

- We accept immutable obligation manifests in exchange for honest missing-evidence detection and reproducible release decisions.
- We accept a CI preparation step in exchange for exact executed-version provenance; legacy uploads remain useful but cannot guess that provenance.
- We accept durable derived structures and checkpoint coordination in exchange for fast reads over millions of facts.
- We accept visible processing and pending gates in exchange for crash-safe 10k-result uploads without exposing partial success.
- We accept an explicit disagreement state in exchange for preserving observations from independent human and agent executors.
- We accept bounded impact sets with uncertainty in exchange for token-efficient agent work without claiming incomplete links prove full coverage.
- We accept a narrow typed policy vocabulary in exchange for one model spanning loose and strict teams without a custom policy language.
- We accept fewer authoring and importer capabilities initially in exchange for proving the shared human, CI, and agent evidence loop before expansion.
- We accept retained immutable history and storage costs in exchange for interpretable old results and portable audit evidence.
- We accept a finite immutable certificate plus separate revocation facts in exchange for retaining a truthful historical decision after later corrections.

## Alternatives considered

- A case-centered mutable status model puts latest manual, automated, and agent outcomes directly on cases. Reads look short, but every caller must understand precedence, retries, contradictory actors, and historical pins. Its shallow interface distributes interpretation rules and makes past decisions hard to reconstruct.
- A pure stream without obligation manifests treats runs as arbitrary event queries. It hides append mechanics but cannot answer what has not arrived, prevent a missing shard from looking green, or provide stable execution assignments. Adding obligations is a necessary limit to the seed lens, not abandoning it.
- Event-source every detail, including device drafts, assignment hints, and authentication internals. One universal append API appears small but pushes type validation and invariants into every caller. This candidate uses a narrow immutable evidence contract and ordinary owned state where immutability buys little.
- Separate manual execution, automated result analysis, and agent session services each own their own verdicts and link summaries into a dashboard. Each local interface is convenient, but cross-layer gates require synchronization of competing truth. The common evidence operations hide more behind fewer contracts.
- Scan the stream on every read and add caches later. This creates a deceptively deep query interface whose work is unbounded. Required durable query structures make the cost model and replay contract part of the design now.
- Automatically map every uploaded result to the current case version. This removes the preparation call but asserts facts the report did not supply. Exact or unresolved provenance is a better boundary.
- One generic query endpoint and one generic mutation endpoint. Few operation names do not make a deep interface when callers must know storage shapes, event kinds, and policy preconditions. Named domain operations hide those rules and permit transport generation.

## Open questions and risks

- Daniel, does the evidence-first workspace fit the differences you saw across loose, standard, and strict teams, or do some require a plan hierarchy as their primary navigation?
- Is a preparation call before CI execution acceptable, and which existing report workflows can supply reliable version attestations during migration?
- Which required bindings may substitute for one another, and must independent actors' conflicting outcomes always block a release by default?
- Is a new-project or CSV-seeded first slice useful, or is a faithful TestRail or Qase import a launch requirement despite the added scope?
- Does review-for-agents provide the right default without making routine agent maintenance unnecessarily ceremonial?
- Are identity-and-time sign-off and explicit certificate revocation sufficient for the first strict-team workflow without legal signature claims?
- How should code links be established cheaply enough that impact queries beat search while preserving honest completeness labels?
- Can the first selected storage candidates satisfy atomic publication, snapshot pagination, projection replay, and bounded reads in both embedded and server modes without an elaborate infrastructure layer?
- Do scoped MCP tool subsets save context in the reference clients, or do negotiation and repeated definitions erase the benefit?
- The highest implementation risk is incorrect incremental projection after out-of-order arrivals, amendments, or policy changes. Replay equivalence and a false-green gate test must decide that risk before broader reporting work.

## Next implementation step

After synthesis, specify the missing-shard, unresolved-version, contradictory-actor, crash-retry, and replay-equivalence fixtures, then use them to benchmark the stack-neutral evidence and gate contract before choosing a stack.
