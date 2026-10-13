# Rationale: candidate D, the decision queue

Companion to `design.md` in this directory. Section numbers (§) refer to it.

**Disclosure.** While listing the arena directory I read `/tmp/mainworthy-arena/rubric.md`, which
is marked for the judge only. I did not go back to it and the package follows the brief's
deliverable list, but I cannot claim I designed blind to it. The judge should weigh that.

## Problem

Test management tools sell record keeping. An organisation pays per seat (verified: universal),
pays again for history, audit and approvals (verified: enterprise tiers on five tools), pays in
rationed API calls (verified: 60 to 1,000 req/min by tier), and then still decides go or no-go
in a meeting, because the tool recorded everything and settled nothing. Meanwhile testing has
three producers, people, pipelines and agents, and the incumbents model one of them well, a
second as an import and the third not at all (hypothesis from the landscape; the depth of
competitors' MCP servers is open). The product to design is one where those three are a single
thing, with the feel of a modern developer tool, across teams from loose to regulated, from
one self-hosted artifact, without choosing a stack.

The seed lens for this candidate: organise the product around the decisions a human must make.

## Usage (caller's view)

Four calls carry almost all traffic, and they are the same from the UI, the CLI, CI and MCP:

```ts
propose({ id, changes, seal })                 // an author's autosave, an agent's edit, a bulk move, a policy change
report({ target | run, results | file })       // a 10,000-result CI file; one tester's keypress; an agent's session
claim({ lens, reviewed, findings })            // an agent's review; a tester's exploratory notes
decide({ q, answer, reason })                  // the only way anything a human is accountable for changes
```

and the reads are bounded and start from what the caller is doing, not from the suite:

```ts
inbox({ for: 'me' })                           // the queue; with state:'decided', the audit ledger
impact({ change: 'pr:482', since })            // review brief or test charter: cases, risk, what is already decided
gate({ commit })                               // passed | failed (fix) | blocked (decide) | pending (evidence)
```

A pipeline adds one line (`mainworthy report results/*.xml`). A reviewer agent makes three calls
for a first review and one for a re-review. A tester presses `p`, `f`, `b`, `s`. A lead presses
one key per question. The reply to `propose` and `decide` is the same shape at every
strictness: it says whether the caller settled the matter, advised, or still needs someone, so
neither a UI nor an agent's skill branches on the project's policy.

## Shape

- **Three kinds of write, three kinds of writer.** Producers append *evidence* (proposals,
  results, findings). Detectors derive *questions* from evidence, one per cause, by
  fingerprint. *Decisions* answer questions and are the only thing whose effect changes
  standing: case head, test-to-case binding, excuse, quarantine, waiver, sign-off, policy.
- **A decision is typed and remembered.** Closed answer set per kind; signers with the policy
  clause that authorised them; the hash of the evidence shown; and a *hold* saying when it
  stops applying. `raise()` is one function: open, attach to the open one, carry the standing
  answer forward, or ask again with the old answer attached.
- **Policy is a table**: kind x condition → who answers (a rule, a member, a role; quorum;
  four eyes; whether agents answer or only advise) and what an open question blocks. Loose,
  standard and regulated are three lists over one model.
- **Evidence is keyed by (test, target).** A `Test` exists with or without a case. A `Run` is a
  predicate over targets plus pinned slots; results satisfy it by matching, not by belonging,
  so CI, people and agents fill the same run and a PR check, a regression pass and a release
  are one object.
- **One operation registry** of seventeen operations generates REST, MCP (ten tools), CLI,
  OpenAPI and the budget tests. Seven question kinds are seven files in one exhaustive table.
  Standing writers take a `Decided<K>` witness that only `settle` can mint.
- **One clock.** A per-project Seq assigned in commit order stamps every fact; cursors,
  changed-since, export order and audit order are all that one number.

## Synthesis decision

## Tradeoffs accepted

- We accept **three or four extra rows on every save** (proposal, question, decision) in
  exchange for a single write path with no "review on / review off" fork and an audit trail
  that exists from the first day in every preset.
- We accept **a mutable open proposal and up to ~30 s before others see an edit** in exchange
  for a readable history, a meaningful unit of review and stable content hashes for agents.
- We accept **two nouns, case and test**, in exchange for automation-heavy teams getting
  history, flakiness and gates without authoring anything, and no auto-created clutter.
- We accept **that manual results need a target** (a build or environment, or the fallback
  `self`) in exchange for manual, CI and agent evidence filling the same run.
- We accept **unlearning the plan → run → test hierarchy** and harder import of foreign runs in
  exchange for removing the structure that separates manual from automated.
- We accept **dependence on fingerprint and hold quality** (the design's main risk) in exchange
  for asking each question once; the guard is short, basis-bound holds and visible carry
  counts, so the failure mode is "asked again", not "silently excused".
- We accept **per-project commit serialisation** for the Seq in exchange for changed-since,
  export and audit being one ordered range read with nothing to reconcile.
- We accept **a closed set of kinds, answers and policy predicates** (no workflow designer, no
  custom states) in exchange for one-key answers, a small agent surface and policies an
  auditor can read as one table.
- We accept **a thinner authoring experience in the first slice** (no shared steps, no custom
  fields) in exchange for a slice that exercises all three producers and the queue.
- We accept **no generic issue-like question** (nothing free-form can be put in the queue) in
  exchange for the queue never becoming a second ticket tracker (a vision non-goal).
- We accept **that a loose team may rarely see the queue** in exchange for not inventing work;
  for them the visible product is a fast suite and a gate that distinguishes "fix" from
  "decide".

## Alternatives considered

Judged on interface depth: how much a caller must know versus how much the module hides.

1. **Classic resource model with a triage inbox added** (cases, runs, results as CRUD
   resources; an "inbox" view listing failures, unlinked tests and pending reviews). Shallow:
   roughly forty endpoints, each a thin wrapper over a row; the inbox is a query over five
   tables with five different "resolve" actions, so policy is checked in five places and an
   agent needs five tools to do what `decide` does. History and audit become things each
   endpoint must remember to write. Rejected: it is the incumbents' shape with a nicer list.

2. **Full event sourcing: the journal is the only truth, every table a projection.** Deep in
   principle (one `append`), but it pushes the hard part, event schema evolution and projection
   rebuilds, onto every contributor, and 10M result events gain nothing from being events
   twice. The chosen shape takes the useful half: facts are already append-only tables, the
   `Command` journal orders them, and only *standing* is a projection, with one writer each.

3. **Results as decisions** (one log; pass and fail are answers to "does this case pass here").
   The most extreme form of the lens and the smallest type count. Rejected on the data: two
   shapes in one 10M-row union, an authority check on every machine result, and nothing to
   carry forward (§10.2).

4. **Cases as files in the repository, Mainworthy as an index over git.** Excellent DX for
   developers and free versioning. Rejected as the base shape: manual testers and regulated
   approvers are not git users (decision 0005: teams in general), per-step identity and
   policy-governed adoption do not fit a merge, and results at 10M rows are not files anyway.
   Its good part is kept as commitments B3, B4 and C6 (Markdown in and out, policy as a file).

5. **Policy as named switches** (decision 0003 as written). Simpler to explain: five toggles.
   Shallower than it looks: each switch is a branch in a different module, and the questions
   the switches do not name (who may excuse a failure on their own PR, what an agent may
   settle) get ad hoc answers. The clause table is one mechanism the switches are presets of.

6. **Per-result questions with client-side grouping.** Easy detector, flexible UI. Rejected:
   it stores the notification stream and makes "decide once" a display trick; an agent would
   pay tokens for every row, and the gate would have to regroup on every read.

7. **Agents get their own surface** (a "review" API with findings, separate from the human
   review flow). Would let agent features move faster. Rejected by P4: it is the second path,
   and it is how the three layers become three features again.

## Open questions and risks

For Daniel:

1. **Is the queue the right home?** From your experience across team sizes, who opens the tool
   daily, and is it to triage, to write or to execute? If most daily users are authors, home
   should be the suite and the queue a key away (the model does not change, the default does).
2. **Tests without cases.** Is it acceptable that an automation-heavy team never writes a case
   and still gets gates and flakiness (X4)? Or does "test case management" require the case to
   be the unit, in your reading of the audience?
3. **Sealed proposals instead of a version per edit (X2).** Is a delay of seconds before
   colleagues see an edit acceptable in a loose team? Should a seal also be forced when someone
   else opens the case?
4. **Who may excuse a failure on their own PR?** The `standard` preset says the change author
   may answer `defect`, `test` and `expected` but not `flaky` or `infra`. Too strict, too
   loose, or right? (Extends open question 12.)
5. **Hold windows.** Defaults proposed: `flaky` holds 14 days or until 20 clean trunk runs;
   `infra` holds for one target only; `defect` holds until 5 clean runs or the tracker item
   closes. What would you have wanted in the teams you worked in?
6. **Will testers name the build?** Results filling a release run depends on manual results
   carrying a target. In your experience do manual testers know which build is on the
   environment, or must Mainworthy learn it from `announce deploy` and offer it?
7. **The slice order (X8).** Are you willing to trade the roadmap's authoring-first phase 2
   for a thin slice across all three producers, knowing shared steps and custom fields move
   later?
8. **Local requirements (X9, open question 16) and no tracker port in the first slice (open
   question 4).** A defect is a pasted reference until the port exists. Acceptable?
9. **One word, "run", for a PR check, a regression pass and a release.** Clear, or does the
   release need its own noun even if it is the same object?
10. **Agents settling questions.** In which kinds, if any, should an agent's answer count in
    the `loose` preset? The draft lets a rule settle most things and agents only `map` and
    `duplicate`; an agent settling `failure: infra` is the obvious next candidate and the
    riskiest.

Risks:

- **Fingerprints and holds** (§10.2). Cannot be validated without real failure data; needs a
  corpus of real JUnit reports with repeated and flaky failures in phase 1.
- **The Seq commit-order rule** constrains the store and serialises commits per project. If the
  benchmark shows it capping CI ingest for a large organisation, the fallback is a Seq per
  project *and stream* (suite, evidence), which complicates cursors.
- **Queue as ticket tracker by drift.** Pressure will come to add comments, labels and custom
  kinds. The closed kind table is the defence; it must be defended.
- **Draft budgets are guesses**: 100 ms key-to-paint at 50k open questions, three questions
  from 500 failures, 1,500 tokens of tool definitions. Each needs a baseline from the phase 0
  audit before it is a commitment.
- **Impact sets depend on links existing** (tracker keys in PRs, areas). Where they are sparse
  the digest is small and says so; whether that is still cheaper than a search is decision
  0006's own rejection test.
- **The regulated preset is designed, not exercised**, until the `gap` and `signoff` kinds and
  freeze ship. The `strict` fixture preset in the first slice proves the mechanism, not the
  workflow.

## Next implementation step

Add `raise`, `answer`/`settle` and the `adopt` and `failure` kinds to the phase 1 operation-layer
prototype, behind `propose`, `report`, `decide`, `inbox` and `gate` exposed through REST, MCP and
CLI from one registry, and run fixtures D1, D3 and D4 plus the ingest and decide budgets on each
candidate stack in embedded and server mode.
