# Mainworthy design arena: shared brief

You are one candidate designer in a parallel design exploration (the "architect" skill, Phase B). Other candidates work independently; an independent judge compares all candidates, then an orchestrator synthesises one design. Produce the strongest design you can. Do not hedge toward a safe middle; differences between candidates are the signal.

## The ask (from Daniel, the owner, verbatim)

> explore and design an overall product from the decisions we've made so far. As a base, think about taking Qase and Testrail and making it work. Think about what makes it not a good use of money for orgs and how it can be better. Specifically at combining and helping the different layers of testing together: manual QA, automated testing, and agentic testing. While Qase/Testrail likely has a lot of the necessary features, it's severely lacking in modern DX/UX. Similar to how linear improved github's DX and CircleCI improved Jenkins or even bun/deno improved TS/NPM, we want to improve the user experience. We'll likely need to create some guiding principals help make decisions on architecture and the like. We'll want to be willing to adjust those principals when necessary to ensure the product is deliverable, but we wouldn't want to deliver a bad product.

> the repo's existing docs are good guidelines, but not set in stone. be flexible and willing to explore.

## Grounding: read these first (read-only)

Repository: /home/endqwerty/.t3/worktrees/mainworthy/t3-7f035a0d (do NOT edit anything inside it).

- README.md
- docs/product-vision.md (ranked priorities: fast backend > agent access > instant UX; core capabilities; draft principles 1-7)
- docs/decisions/0001-stack-open.md .. 0006-agent-token-efficiency.md (stack undecided; layered self-hosting; one model + policy switches across loose..regulated; multi-user, no live co-editing, online-first; audience is teams in general; agent token cost as a budgeted property)
- docs/competitive-analysis.md (13 tools, verified pricing and gating: history gated to enterprise tiers almost everywhere, per-seat pricing, API rate limits by tier, MCP servers appearing, self-hosting rare)
- docs/ux/flows.md (F1-F14 flows by actor, all hypotheses), docs/ux-research-plan.md (jobs J1-J15, A1-A6), docs/roadmap.md, docs/open-questions.md

Nothing in the repo is code. The stack is undecided and you must NOT choose one. Your design is stack-neutral: domain types, operations, module boundaries, product surface, principles.

The existing decisions are guidelines. You may challenge any of them, but each challenge must say what it replaces, why, and what it costs. Unchallenged decisions are constraints.

## Deliverable: one candidate design package

Write it as Markdown in your own output directory (given in your task). Files:

1. `design.md` (the package, in this order):
   - **Thesis**: in one paragraph, what Mainworthy is, and the one structural idea that makes manual QA, automated testing and agentic testing one product instead of three features.
   - **Why the incumbents are a poor use of money**: concrete, structural reasons (cite the competitive analysis where it is verified; label hypotheses). Then how the design answers each reason, structurally, not with a feature list.
   - **Guiding principles**: 6 to 10 principles that decide architecture and product questions. Each: the principle in one sentence; what it rules out; a tie-break rule against the others (the product vision ranks speed > agents > UX; keep, replace or refine that). Include an explicit rule for when and how a principle may be bent for deliverability, and what "a bad product" means so the bend has a floor.
   - **The DX/UX moves, made concrete**: what is the Linear move (over GitHub issues), the CircleCI move (over Jenkins), the bun/deno move (over npm/ts) for a test management tool? Each as a design commitment that can be checked, not an adjective.
   - **Usage first**: a README-style quickstart as the user would read it, then three real call sites: (a) a CI pipeline step reporting automated results; (b) an agent through MCP doing adversarial review of a PR; (c) a human executing a manual run and an author capturing cases. Write these BEFORE the types. They are the spec.
   - **Domain model (data structures first)**: the core types in a language-neutral pseudo-type notation (TypeScript-like is fine but it is a sketch, not a stack choice). Encode invariants in types. Trace each dominant access pattern through the structure: case read/list/search, run execution, 10k-result ingest, flaky state on ingest, impact set for a change, changed-since for an agent, traceability chain, gate status read by CI. If you would say "add an index/cache later", the structure is wrong.
   - **Operation layer and module map**: the single operation surface that UI, REST, MCP, CLI and CI ingest all call. List the operations (small, composable, deep). Show module boundaries and ownership of each piece of state (one owner each). `not implemented` bodies and `// TODO` pseudocode where logic is tricky.
   - **Product surface**: the handful of objects and screens the user lives in, and how the three testing layers appear together (not as three tabs).
   - **First deliverable slice**: the smallest version that is not a bad product, and what is deliberately left out.
2. `rationale.md`, per the template below (Problem, Usage, Shape, Tradeoffs accepted, Alternatives considered, Open questions and risks, Next implementation step). Leave "Synthesis decision" empty; the orchestrator fills it.

Keep the package under ~2,500 lines total. Dense and concrete beats long.

## Discipline (from the architect runner prompt)

- Caller's usage first; derive types from usage; reconcile sketch to usage.
- Data structures first; trace access patterns; no "add a map later".
- Interface depth: small public surface hiding much; no transport/wire types on the public API.
- Shared state: if two actors can both write, say what happens; default per-actor state merged at read.
- Make boundaries visible; encode invariants in types; validate at boundaries, trust types inside; business logic as pure functions; thin shell.
- Single source of truth per invariant; derive, don't sync.
- Idempotent operations: what if it runs twice or crashes halfway?
- Short call chains.

## Design red flags (self-screen before finishing)

Shallow modules (big interface, little hidden); information leakage (one internal decision in many places); temporal decomposition (modules by execution order instead of knowledge owned); pass-through methods; split ownership of state; two ways to do one task; importable internals; hand-synced lists.

Assume the next contributor is an agent that sees only the files it opened, copies the nearest example, and takes the shortest path that compiles. Prefer the design where a change that looks right from one file is right for the whole product.

## Rationale template

```
## Problem
## Usage (caller's view)
## Shape
## Synthesis decision   (leave empty)
## Tradeoffs accepted   ("we accept X in exchange for Y", one bullet each)
## Alternatives considered   (concrete alternative shapes, judged on interface depth)
## Open questions and risks   (as questions for Daniel)
## Next implementation step   (one sentence)
```

## Rules

- Read-only on the repository. Write only to your output directory.
- Do not run installs, do not create code projects, do not pick a stack.
- Do not search the web unless a specific competitor claim needs verifying; label anything unverified.
- Finish with a 10-line summary of your design's one big idea and its biggest risk, printed as your final message.
