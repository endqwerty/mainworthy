# Rationale: candidate C (repository-centric, "the suite is a versioned tree of documents")

## Problem

Test management tools are poor value for structural reasons, not missing features
(`docs/competitive-analysis.md`, verified): per-seat pricing that taxes readers;
history, audit and versioning sold as a premium tier because they are bolted onto a
mutable-row model; API limits as a plan lever; self-hosting rare. On top of that
(hypothesis) manual results, CI results and now agent work live in three different
places with three shapes, so no one can answer "is this requirement actually proven,
by what, on which version of the case?" The ask is to make the three layers one
product and to fix the DX the way Linear, CircleCI and bun fixed theirs.

## Usage (caller's view)

Three call sites drive the design (full text in `design.md` §5):

- **CI:** `mainworthy report results.xml --gate pr` after any runner. Context is read
  from the environment; 10k results ack in about a second or two; re-running is a
  no-op; unknown tests are visible, not lost; the output is a digest and a gate
  verdict, and the same text becomes the PR check.
- **Agent via MCP:** `impact({pr})` returns the affected cases ranked by signals
  (not a suite scan), `read` with `ifNoneMatch`, `flag` returns ids not echoes, and
  `commit` lands directly or becomes a proposal depending on policy, with the same
  call. A re-review after one change reads one case.
- **Human:** author types an outline and presses nothing to save; executor runs a
  pinned list with p/f/b/s; the same result row shape as CI and agents.

## Shape

- **One structural idea:** a case is a *claim* with a content-addressed `claim`
  hash; `code`, `human`, `agent` are *methods*; `Evidence` has one shape stamped with
  the claim hash; coverage, flaky, gates and impact are folds over `(claim x
  evidence)`. Proof carries across a merge automatically (same hash).
- **Tree + log:** definitions are canonical plain-text documents in a git-shaped
  commit log owned by Mainworthy (heads and a temporal table are derived in-txn);
  evidence is an append-only log, never a file. Export is the storage format.
- **Decision on the seed's open question:** the tree lives in Mainworthy's store, git
  is a projection and a mount (`Owner` = `native | repo | upstream`); one owner per
  document. Seed lens bends in three places and I say where (design §1).
- **One operation surface:** 14 ops, 11 exposed by default to agents; `commit` and
  `record` are deep (routing, merge, binding, claim re-derivation, six derived
  writes behind one input).
- **Structures are named per access pattern** (design §7.5): `Head`, `DocVersion`,
  `ChangeRow`, `Link`, `Binding`, `Watch`, `Member`, `Health`, `Standing`,
  `RunTally`, `Seen`. Derived state is rebuildable (`reindex` equivalence test).
- **Product:** Suite, Case, Runs, Release, Inbox, command bar; a proof strip
  (H/C/A) on every case row; one timeline per case; no tabs per testing layer.

## Synthesis decision

(left empty for the orchestrator)

## Tradeoffs accepted

- We accept **two representations of the suite (store + git projection)** in exchange for sub-50 ms saves, readers without git seats, policy enforced in our operation layer, field-level merge, and evidence that does not need a repo; the price is a round-trip property (`export . import = identity`) we must defend forever.
- We accept **evidence stamped with a claim hash that breaks on any claim-class edit** in exchange for never showing a pass that was not proven on what is currently asserted; the price is re-runs (or an attributed `reaffirm`) after a typo fix in a step, and a claim/meta field classification that must be right.
- We accept **step ids (`^a1`) in the plain-text form** in exchange for per-step results, step-level merge and finding anchors; the price is noise in raw diffs and in files produced by `export`.
- We accept **a closed set of document kinds (7) and predicates (`StaticPred`)** in exchange for maintained membership and fast gate reads; the price is that gates cannot depend on time-varying state at membership level (only through `within`/`Rule`).
- We accept **gate verdicts computed on read (a set join)** in exchange for no extra tally structure; the price is an O(required set) read, with a pure `GateTally` fold as the designed escape if the benchmark misses.
- We accept **protected documents (policy, gates) requiring `admin` regardless of the review policy** in exchange for closing the "agent loosens its own rules" hole; the price is that a loose team cannot let an agent edit policy even if it wants to.
- We accept **unbound results never counting as proof for the case they are later linked to** in exchange for integrity; the price is that a freshly linked test shows history but needs one new run to turn the gate green.
- We accept **commit-scoped `Standing` rows with a retention window (default 30 days, plus tagged releases)** in exchange for bounded storage; the price is a rebuild-on-demand path for old commits.
- We accept **a native-only first slice (no repo mounts)** in exchange for shipping; the price is that "tests next to my code" teams get it one slice later.
- We accept **Integrity ranked above speed** in exchange for consistent tie-breaks; the price is occasionally a visible conflict step where last-write-wins would be a click faster.

## Alternatives considered

Judged on interface depth (small surface hiding much), ownership clarity and
whether the dominant access patterns are structural.

1. **Git is canonical (the pure seed).** Tree lives in the code repo; Mainworthy is an index and evidence service over it. Deep on authoring-with-code, shallow elsewhere: every write needs git plumbing, enforcement is the host's, readers and approvers need git access, the "base hash on write" contract (0004) has to be rebuilt as commit preconditions, no home for a Local project with no remote. Rejected as the *canonical* store; kept as a mount (`Owner.repo`) and as the export format.
2. **Versioned rows in a relational model (incumbent shape, nicer UI).** `case`, `case_version`, `run`, `result` tables with joins. Simple and familiar. But "add an index/cache" becomes the answer to every access pattern, diffs and exports are second-class, history is possible to gate, and a case has no natural content hash, so proof cannot carry across a merge and agents cannot get conditional reads for free. Rejected: the structure does not make agent tokens or portability cheap.
3. **Event-sourced everything (docs, results, decisions in one log).** One truth, beautiful replay. But results at 10k per push make the log a poor source for "read one case" and mix two lifecycles (definitions are edited and diffed; results are never read as documents). Chosen split instead: commit log for definitions, append-only evidence for results, shared only by hash.
4. **Separate Manual / Automation / Agent modules with a reporting layer on top.** Each module is simple, the surface is large, and the whole is the incumbents' problem again: three shapes to reconcile and a "combined" report that is a join of guesses. Rejected by P1.
5. **Case id on every result (no `ProofKey`).** Simpler row, but automated tests cannot report before they are linked, so ingest either drops results or auto-creates cases. `ProofKey` + `Binding` lets history exist first and link later. Cost is one indirection.
6. **Findings as comments on cases.** Cheap, but not queryable by `(doc, claim)` and cannot drive `skipReviewed`. Rejected for decision 0006 reasons.

## Open questions and risks

Questions for the owner:
1. Is the **claim/meta split** right: is editing an expected result always a new claim, and are tags/titles/links never? Do you want the "reaffirm after typo" escape, or would you rather that every claim edit demands a re-run (regulated-friendly, annoying to automation-heavy teams)?
2. Should an **agent's pass count as proof** in a gate by default, or only when a gate document opts in (my default is opt-in per gate)? Related: a failing required case is `fail` and missing proof is `hold`; is that the verdict split you want (open question 12)?
3. Is **"tests next to the code" a launch need**, or can `repo` mounts wait for the second slice? If it is a launch need, which wins: slimmer authoring UI or the mount?
4. **Requirements:** are native `req` documents with optional external stubs acceptable as the answer to open question 16, or must the tracker be strictly the only source?
5. **CI context for evidence binding:** a CI result is stamped with the case claim at the tree ref the report names (default `main` head at ingest). For a PR that also edits cases, should `mainworthy report` default to the PR's proposal ref when one is linked? (I lean yes; it needs the PR-to-proposal link.)
6. The product name and `mainworthy` as the binary name are placeholders (question 7); the CLI is user-facing, so naming is less cheap here than in other candidates.

Risks (ranked):
1. **Hashing semantics are load-bearing.** If the claim/meta classification, canonical printing, or shared-step re-derivation is wrong, either proof is silently wrong (integrity) or gates are annoyingly red. Mitigation: property tests (`print . parse = id`, `claim` stable under meta edits), a corpus from imported suites, and the `mainworthy check` explanation of why a case lost standing.
2. **Impact sparsity** (decision 0006's own risk): `Watch` globs and requirement trailers may be too sparse in real projects, so `impact` degenerates to search. Mitigation: test-file adjacency and `Binding` keys give a floor; measure coverage of the impact index on imported suites before relying on the token claim.
3. **Two-representation drift** (store vs git projection). Mitigation: the round-trip test is part of the check command from slice 1.
4. **Scope of slice 1** is large for "the smallest non-bad product" (UI + MCP + CI + import). If it must shrink, cut in this order: TestRail importer, GitHub status job (keep the CLI exit code), proposals UI (keep `review: none`), `trace` UI (keep the op).
5. **Derived-state write amplification** on bulk edits (nine derived writes per document). Mitigation: set-based batches; the 1,000-case bulk edit budget is the canary and is in the first benchmark.
6. **Document-plus-log is a bigger conceptual model** than "cases and runs" for casual users. Mitigation: the user never sees commits unless they open History; the quickstart uses none of the vocabulary.

## Next implementation step

Write the decision record (stack-neutral store requirements: temporal rows, ordered range scans, in-transaction full text, set-based inserts) and build the benchmark harness for the canonical document form plus `commit`/`record` against a generated 100k-case / 1M-result dataset, including the `reindex` equivalence and `export . import` round-trip tests, before choosing the stack.
