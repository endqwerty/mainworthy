# Product design

The overall shape of Casebook, synthesised on 2026-10-11 from four independent
candidate designs (see [Synthesis decision](#synthesis-decision)) and the
decisions in `docs/decisions/`. It is a sketch, stack-neutral, written before
any code. Types are TypeScript-like notation, not a stack choice. Numbers are
draft budgets to validate on the phase 1 benchmark.

Companion records: [0007 guiding principles](decisions/0007-guiding-principles.md)
and [0008 one evidence model](decisions/0008-one-evidence-model.md).

Contents: 1 Thesis · 2 Why the incumbents are a poor use of money · 3 Principles
(summary) · 4 The DX moves, made concrete · 5 Usage first · 6 Domain model ·
7 Operation layer and module map · 8 Product surface · 9 First deliverable
slice · 10 What this changes in earlier docs · Synthesis decision · Rationale.

---

## 1. Thesis

Casebook keeps one true record of three things: what the software is expected
to do (**expectations**: versioned cases, shared fragments, requirements), what
was observed against those expectations (**evidence**: results and findings
from people, pipelines and agents, in one shape, each saying exactly what it
proves), and what people decided about it (**decisions**: typed, recorded with
the evidence they were made on, carried forward until that evidence changes).

Manual QA, automated testing and agentic testing are not three features. They
are three **producers** of the same evidence through the same operations, and
they meet in two places: one evidence stream keyed by *(test, target)*, where a
run is a request for evidence that any admitted producer may satisfy, and one decision
queue, where a project's strictness is a table saying who must answer each
kind of question. The same rows serve a loose team (a rule answers most
questions, and the answer is still recorded) and a regulated one (a named
human answers each).

The product's experience is built around one job above all others: **getting
what is in a tester's head into an artifact without waiting for the app.**
Capture, recording a result and answering a question are hot paths with
budgets measured at the point of thought, not at the server.

## 2. Why the incumbents are a poor use of money

Labels as in `docs/competitive-analysis.md`: **V** verified there, **R**
reported, **H** hypothesis. Each row names the structure (not the feature)
that answers it.

| # | Where the money goes | Label | Structural answer |
| --- | --- | --- | --- |
| M1 | Per-seat pricing for a system whose main writers are machines and whose main readers are not testers. Jira apps price on all Jira users; viewer seats are a discount, not an absence (Qase $10, Testiny ~20%). Testmo's flat tiers are the counterexample. | V | **No seat in the model.** An actor (human, agent, CI, rule) is a free row with capabilities. There is nothing to count, so nothing to meter. |
| M2 | History, audit and approvals, the reason to have a system of record, are the top tier (TestRail Enterprise, Xray Enterprise, Qase retention by plan, Testiny and Testomat.io paid). | V | **History is the storage model.** Only append-only facts and decisions exist; "current" is a projection with one writer. There is no code path that saves without history, so nothing can be gated. |
| M3 | Machine access is rationed by tier (60 to 1,000 req/min). | V | Writes are **batches**: a 10,000-result report is one call, a 1,000-case bulk edit is one proposal. Self-hosted, so the limit is hardware; latency and token budgets are tests. |
| M4 | A team buys a case tool for manual results, a CI dashboard for automated ones, and has nowhere for what agents find; it joins them by hand in a spreadsheet. | H (tools are manual- or automation-centred: V) | **One evidence shape, producer as an attribute.** A run does not own results; it is a request for evidence, so a pipeline, a tester's keypress and an agent's session fill the same slots. |
| M5 | The tool is write-only: the same failure is triaged on every run, "automated" is a checkbox someone keeps true, run status is typed by hand. | H (to confirm with practitioner evidence, open question 18) | **Decide once, derive the rest.** A decision carries forward to later occurrences of the same cause until its basis changes. Execution type, coverage, flakiness, staleness and gate status are computed, never typed. |
| M6 | Strict process is an edition: approval workflows, audit and sign-off are bought, so a team pays for strictness or goes without. | V | **Policy is a table over one model.** Kind of question × who must answer. Presets are lists of clauses. |
| M7 | Agent access is bolted on: MCP servers exist (four vendors) but wrap UI-shaped endpoints, so an agent lists and re-reads. | V (exist), H (shape; phase 0 audit) | Reads are **bounded digests** shaped for models: impact sets, changed-since, hashes, counts first, no echo. Findings are evidence with a basis, so reviews are not rediscovered. |
| M8 | You cannot leave, and self-hosting costs more (on-prem from higher tiers: V; the open-source options are dated: R). | V, R | **The export is the log plus canonical text.** Import is replay. One artifact runs Local, Server and Cloud. |
| M9 | Slow and dated at scale, and the authoring UI makes the tester wait: page loads, modals, "loading" editors. | R (no measurement yet; phase 0 audit) | **Speed where thought happens** (principle P1): input-to-paint budgets on capture, execute and decide; optimistic writes against durable drafts; every hot read is a keyed lookup. |

What the organisation buys instead, as a measure: seconds from thought to
artifact, human decisions per release and seconds per decision, and tokens
served per agent job. Hypothesis, to check in the phase 0 audit: no incumbent
reports these numbers.

## 3. Principles (summary)

Full text, tie-breaks, the bending rule and the floor are in
[decision 0007](decisions/0007-guiding-principles.md).

| # | Principle | One line |
| --- | --- | --- |
| P0 | The record is true | A floor, not a rank. Append-only facts; standing changes only through a recorded decision. Never bent. |
| P1 | Never make the brain wait | Speed is measured where thought happens: capture, record, decide. Hard input-to-paint budgets; optimistic writes; durable drafts. Capture is the first hot path. |
| P2 | One stream, one operation layer | Three producers, one evidence shape, one operation registry behind UI, REST, MCP, CLI and CI. A missing surface is an allowed cut; a second path never is. |
| P3 | Evidence says what it proves | Every result carries an explicit basis (exact, assumed or unresolved); a review is never a runtime pass; missing evidence is pending, never green. |
| P4 | Decide once, record why | Questions are derived from evidence, one per cause; decisions carry forward with a hold; reuse suggests, policy decides whether it has authority. |
| P5 | Policy is data over one model | Who answers what, as a clause table with presets. Agents meet the same gates as people. |
| P6 | Derive, don't maintain | Nothing computable from facts is a field a person or a second module writes. |
| P7 | Zero configuration to first value | One artifact, one command, one pipeline line, drop-in inputs. |
| P8 | Free to read, accountable to write, portable by construction | No seats; every write names an actor and a base; export is lossless. |
| P9 | Every promise is a failing test | Budgets in milliseconds, tokens and keystrokes are checks that fail the build. |
| P10 | One place to declare a thing | Operations, question kinds, parsers and policy predicates are each declared once; everything else is generated or exhaustively checked. |

## 4. The DX moves, made concrete

Each move is a commitment with a check. The three analogies from the ask:
Linear over GitHub Issues, CircleCI over Jenkins, bun/deno over the npm
toolchain.

### 4.1 The Linear move: capture-first, keyboard-first, one queue

GitHub Issues gives a list and leaves the workflow to you; Linear made the
workflow the product and made every action instant. Casebook's version: the
tool opens where you write, every action has a key, and everything that needs
a human answer is one queue.

| Commitment | Check |
| --- | --- |
| L1. **Capture never waits.** `c` opens a new case with the caret in the title on the same frame; typing an outline produces steps; paste splits a list; `>` starts the expected result; no field is required before typing. | Browser test: key-to-caret and key-to-paint ≤ 100 ms p95 on a 10k-case project; a case with six steps from a pasted list in one paste, zero dialogs (J1, J2). |
| L2. **Nothing typed is lost.** Autosave into the author's private draft on every pause; the draft survives reload and crash; a failed save keeps the text and the caret. | Job test: kill the tab mid-sentence, reload, text and caret position are back. |
| L3. **Every operation has a palette entry and a default key.** | Build test over the operation registry: an operation with no palette entry fails unless marked `uiExempt` with a reason. |
| L4. **One queue.** Failures, agent findings, proposals, unlinked tests, flaky edges, gaps and sign-offs are one list, `j`/`k` to move, one key to answer, no navigation needed. | Browser test: for each question kind, focus a row, press the key, the row leaves; no navigation event. Twenty mixed questions in ≤ 60 s (draft). |
| L5. **Short IDs and URLs on everything** (`C-311`, `Q-2291`, `R-41`, `T-1904`), reachable from the palette in three keystrokes after typing. | Browser test over 20 fixed targets. |
| L6. **Undo works on everything**, including a decision (supersedes, never erases) and a bulk move (the inverse proposal). | Job test: decide, undo, the standing and the gate return to the prior value and both decisions are in the ledger; J4 for the bulk move. |
| L7. **Zero modal dialogs and zero full page loads on J1 to J8.** | Counted by the job tests. |

### 4.2 The CircleCI move: one line in the pipeline, and the check tells the truth

| Commitment | Check |
| --- | --- |
| C1. **One added line, no plugin, no required annotation in test code:** `casebook report <files>`. Commit, branch, PR, build URL and attempt come from the CI environment (GitHub Actions, GitLab, CircleCI, Buildkite, Jenkins fixtures). | Fixture environments yield a complete target with zero flags; a missing commit is an error unless `--session`. |
| C2. **Four verdicts, four exit codes:** `passed` 0, `failed` 1 (needs a fix), `blocked` 2 (needs a decision), `pending` 3 (needs evidence). | Unit test of the pure verdict function; CLI test. |
| C3. **A decision changes the check without re-running the pipeline.** | Job test: ingest a red report, decide `infra` under a policy that lets a member excuse it, read the gate within seconds. |
| C4. **One cause is one question.** A report with 500 failures sharing a signature opens at most 3 questions (draft); a failure already failing on the base of the change is shown as such and *suggested* as excused, never excused without a decision (which may be a rule's). | Fixture D1; the base-failure hint is visible and the excuse is a decision row. |
| C5. **Accepting an upload turns a green gate pending before any processing**: the adapter parses, the operation stages the normalised results durably and marks matching runs outstanding in that acceptance transaction, so a stale green cannot be read while the evidence is being applied. | Job test: green gate, accept a report, read gate before processing completes → `pending`. |
| C6. **Policy, gates and charters are text** (`casebook policy show`, `policy apply` is a proposal like any edit), diffable and reviewable. | Round-trip: export, apply, no diff. |
| C7. **Ingest of 10,000 results accepted in < 2 s, visible with questions raised in < 5 s** (draft). | Benchmark in the check. |

### 4.3 The bun/deno move: one artifact that runs what you already have

| Commitment | Check |
| --- | --- |
| B1. `casebook` with no arguments starts Local, creates a project, signs you in as the machine user and opens the UI. First case within 5 minutes of download (J15). | Scripted install on a clean machine image. |
| B2. The same executable is the server, the CLI, the MCP server (`casebook mcp` on stdio, `/mcp` over HTTP) and the importer. Zero runtime dependencies. | Artifact test. |
| B3. **Drop-in inputs:** JUnit XML as runners emit it; a pasted list or Markdown file becomes a case; importers keep foreign IDs as aliases so `C1234` from TestRail still resolves. | Parser fixtures; alias lookup. |
| B4. **Text in and out:** every case, policy, gate and charter has a canonical Markdown form (`casebook fmt`); `casebook get C-311 --md` and back. The export is the journal plus these documents. | `print ∘ parse = id`; export-import round trip equal on every head hash, decision and verdict. |
| B5. **`casebook check`** is a type-checker for the suite: dangling links, duplicate bindings, steps with no expected result, cases with no method, stale bindings. The same rules back the structural items in the queue (decision 0006, mechanism 4). | Stable exit code; rules unit-tested. |
| B6. **`casebook bench`** ships in the binary and reproduces the budgets on the user's machine against a generated dataset. | The benchmark is the check. |
| B7. The agent surface is at most 10 tools and ≤ 1,500 tokens of definitions (draft); the shipped skill's main file ≤ 400 tokens. | Token count in the check (decision 0006). |

## 5. Usage first

These are the specification; the types in section 6 are derived from them.

### 5.1 Quickstart, as the user reads it

````markdown
# Casebook

One place where manual, automated and agent testing land, and one queue of
the decisions they leave for you.

## Start (no account, no configuration)

    $ casebook
    Casebook 0.1 · local · data in ~/.casebook · http://127.0.0.1:7357
    project "scratch" · you are daniel@this-machine · policy: loose

## Write a case

Press `c`. Type a title, Enter, then steps as an outline. `>` starts the
expected result. Paste a list and it is split for you. There is no save
button; your draft is kept as you type and becomes version 1 when you
leave it.

    Checkout applies a percentage coupon
      Open the cart with one $100.00 item
      Apply coupon SAVE10            > Total shows $90.00
      Reload the page                > Coupon is still applied

It is `C-1`, version 1.

## Send test results (any runner that writes JUnit XML)

    $ casebook report results/*.xml
    4,812 results for scratch @ 9f3c2ab (main)  ·  4,790 pass  19 fail  3 skip
      16 failures already decided   not blocking
       3 failures are new           Q-12  "expected 90.00, got 100.00"  (3 tests)
       7 tests have no case         tracked (link them from the queue)
    gate: blocked by 1 open question   http://127.0.0.1:7357/q/12

In CI it is the same line. Add `casebook gate` to fail the job on the verdict.

## Decide

`g q` opens the queue. Each row is a question with its evidence and its
answers on single keys: `d` defect, `f` flaky, `i` infrastructure, `e`
expected. Your answer is recorded with your name and applies to later
occurrences of the same cause until the evidence changes.

## Run things by hand

`g r`, `n`, pick cases by folder, tag or search, Enter. Then `p` pass, `f`
fail, `b` blocked, `s` skip. Results from CI and from agents on the same
build fill the same run where its obligations allow, so you only run what
nothing else has shown.

## Let an agent in

    $ casebook token new --agent reviewer --can read,produce
    $ casebook mcp            # stdio; or point the client at /mcp

Ten tools. Start with `impact`.

## Get stricter when you need to

    $ casebook policy use standard      # agent edits need a person; who may excuse a failure
    $ casebook policy show              # the whole policy is one table

## Leave whenever you like

    $ casebook export --out acme.casebook      # every fact, decision, document and attachment
````

What step "write a case" stores, in the canonical form `casebook fmt` prints
(ids are minted by the server; step ids `^xx` are hidden by the editor and
exist so merges, per-step results and findings can anchor to a step):

```markdown
---
id: C-1
kind: case
title: Checkout applies a percentage coupon
methods: [human]
covers: []
tags: [checkout]
---
## Steps
- Open the cart with one $100.00 item ^a1
- Apply coupon SAVE10 ^b7
  > Total shows $90.00
- Reload the page ^c3
  > Coupon is still applied
```

### 5.2 Call site (a): a CI pipeline reports automated results

```yaml
# .github/workflows/test.yml  (any CI works; this is the only Casebook-specific part)
env:
  CASEBOOK_URL: ${{ vars.CASEBOOK_URL }}
  CASEBOOK_TOKEN: ${{ secrets.CASEBOOK_TOKEN }}   # actor kind "ci", capability "produce" on one project
steps:
  - run: npx playwright test --reporter=junit
    continue-on-error: true
  - run: casebook report test-results/*.xml        # commit, branch, PR, build URL, attempt: from the CI env
  - run: casebook gate --wait 120                  # exit 0 passed · 1 failed · 2 blocked · 3 pending
```

```
casebook report  acme/web @ 9f3c2ab  pr #482  attempt 2  job e2e
  4,812 results   4,790 pass   19 fail   3 skip                         (R-507)
  11 excused   failing on base 41d07e1 (main), excused by rule          not this change
   5 excused   Q-2104 flaky, decided by mira 6 days ago, holds 8 more   not this change
   3 new       Q-2291 "expected 90.00, got 100.00" in coupon.ts:41      3 tests, C-311 C-314 C-318
   7 tests have no case (tracked)
   basis: assumed (cases at their current version; add a version manifest for exact)
casebook gate    blocked: 1 question needs an answer    https://casebook.acme.example/acme/web/pr/482
exit 2
```

Properties the call site relies on:

- Sending the same files again prints the same receipt and writes nothing
  (idempotent on the batch key).
- Unknown tests do not fail the upload: a `Test` row exists with history and
  flakiness whether or not it is ever linked to a case.
- A retry (`attempt 3`) is a new batch on the same commit; fail-then-pass is
  recorded as a same-code contradiction, the strongest flaky signal.
- **Basis.** With no version provenance in the report, each result is stamped
  `assumed`: the case's current version at ingest, recorded as an assumption,
  visible on the result and in the gate. A project policy says whether
  assumed results qualify for its gates (loose: yes; regulated: no). Exact
  provenance comes from `casebook prepare` (writes a version manifest before
  the tests run) or from `@C-311@v7` annotations in test names. No path
  guesses silently (decision 0008).
- The "failing on base" excuse is a decision row made by a rule clause of the
  loose preset; under the regulated preset the same failure is a question for
  a named role. Either way it is in the ledger with the clause that settled it.

### 5.3 Call site (b): an agent reviews a PR adversarially through MCP

Token: actor kind `agent`, name `reviewer`, capabilities `read, produce`.
Under the `standard` preset it may record findings and proposals and may
*advise* on questions; it may not settle them.

```jsonc
// 1. Where to look: one bounded read, counts first, nothing the change does not touch.
→ impact({ change: "pr:482" })
← { "change": { "pr": 482, "head": "9f3c2ab", "base": "41d07e1", "files": 5, "requirements": ["WEB-290"] },
    "counts": { "cases": 9, "unreviewed": 3, "changed": 1, "failing": 3, "flaky": 1, "uncovered_paths": 1 },
    "cases": [
      { "id": "C-311", "title": "Checkout applies a percentage coupon", "hash": "a91f",
        "why": ["req:WEB-290", "test:checkout.spec.ts"], "last": "fail@9f3c2ab", "open": [{ "q": "Q-2291", "evidence": "e7c1" }] },
      { "id": "C-314", "hash": "0c2e", "why": ["req:WEB-290"], "last": "fail@9f3c2ab", "open": [{ "q": "Q-2291", "evidence": "e7c1" }] },
      { "id": "C-318", "hash": "77b1", "why": ["area:src/checkout/**"], "last": "pass@41d07e1" }
      // 6 more: "reviewed": "by reviewer at this basis, 2 findings settled" → skip
    ],
    "uncovered": [{ "path": "src/checkout/tax.ts", "why": "no area, no test file, no requirement" }],
    "decided": [{ "q": "Q-1808", "on": "C-312#s3", "category": "cannot-fail", "answer": "reject",
                  "reason": "asserted by C-340", "holds": true }],
    "cursor": "s:88213" }

// 2. Read only the three unreviewed cases, only the fields needed, as text.
→ get({ refs: ["C-311", "C-314", "C-318"], fields: ["pre", "steps"], as: "md" })

// 3. Record the review and what it found, in one call. A review with zero findings is still recorded.
→ claim({ lens: "adversarial-review", about: "pr:482",
          reviewed: ["C-311@a91f", "C-314@0c2e", "C-318@77b1"], patch: "9f3c2ab",   // basis = version hash (fragments pinned) + patch tree hash
          findings: [
            { on: "C-311#s2", category: "cannot-fail",
              note: "'Total updates' is true for any change, including the wrong one.",
              suggest: { expected: "Total shows $90.00 (10% off $100.00)" } },
            { on: "req:WEB-290", category: "uncovered-path",
              note: "coupon.ts:41 adds an expiry branch; no case applies an expired coupon.",
              suggest: { case: { title: "Expired coupon is rejected", folder: "checkout",
                                 steps: ["Apply coupon OLD10 (expired) > Error 'Coupon expired'; total unchanged"] } } } ] })
← { "opened": ["Q-2301", "Q-2302"], "known": [{ "q": "Q-1808", "answer": "reject", "by": "mira" }], "reviewed": 3 }

// 4. It has a view on the failure. Policy lets it advise, not settle.
→ decide({ q: "Q-2291", onEvidence: "e7c1", answer: { is: "defect" }, reason: "All three assert the discounted total; the diff moves the discount after tax." })
← { "status": "advised", "needs": "one member who is not an agent" }

// Re-review after a fix is pushed (job A5): only what moved. A changed patch invalidates the review
// basis even when the case text is unchanged.
→ impact({ change: "pr:482", since: "s:88213" })
← { "counts": { "cases": 2, "unreviewed": 2 },
    "cases": [{ "id": "C-311", "hash": "d402", "changed": ["s2.expected"], "last": "pass@b77e510" },
              { "id": "C-318", "hash": "77b1", "changed": ["patch"], "last": "pass@b77e510" }],
    "settled": [{ "q": "Q-2301", "answer": "accept", "by": "mira" }, { "q": "Q-2291", "answer": "defect", "by": "sam" }],
    "cursor": "s:88390" }
```

Fresh eyes is explicit and pays the full cost on purpose:
`impact({ change, ledger: false })`.

For adversarial testing (F14) the same `impact` digest is the brief; the
agent runs under a charter document (`h_checkout`, a `charter` edit in the
suite), works outside Casebook with its own tools and posts results in one
`report({ run, method: 'agent', charter: 'h_checkout', results })` batch and
findings in one `claim` batch, under its own identity. Whether an agent's result may satisfy a gate slot is a policy
clause, not a code path.

### 5.4 Call site (c): an author captures; a lead plans; an executor runs

**The author** (the hot path).

```
g s            suite outline, cursor where it was
c              new case under the cursor; caret in the title on the same frame
Expired coupon is rejected ⏎
Apply coupon OLD10 (expired) > Error "Coupon expired"; total unchanged ⏎
⌘V             six lines from the spec; six steps appear, " > " / "Expected:" / "=>" split off the expected result
#checkout      tag, inline
@WEB-290       links the requirement, inline
               (move away, or ⌘⏎)
```

Every pause autosaves into the author's **open proposal** (private; others
see "draft by Dana"). Leaving the case, `⌘⏎` or 30 s idle **seals** it:

```ts
propose({ id: 'p_7f3a…', edits: [{ op: 'create', case: 'c_91…', body, place, covers: ['WEB-290'] }], seal: true })
// loose:     → { status: 'adopted', case: 'C-331', version: 1 }        a rule answered; the decision is recorded
// regulated: → { status: 'open', question: 'Q-2310', needs: 'role approver, not the author' }
```

Two authors on the same case: disjoint fields merge; the same field is a
conflict, both versions kept and shown side by side (decision 0004).

**The lead** plans a run in one line:

```ts
plan({ name: '1.4.0 rc3 regression', select: { folders: ['checkout'], tags: ['regression'] },
       accepts: { build: '1.4.0-rc3', env: 'staging' },           // which targets count (the build label was announced with its digest)
       require: [ { kind: 'exercise', methods: ['human', 'auto'], minActors: 1, basis: 'exact-or-assumed' },
                  { kind: 'jobs', jobs: ['e2e'] } ],              // what counts as complete; defaults come from policy
       assign: { split: 'even', to: ['dana', 'sam'] } })
// → { run: 'R-41', slots: 214, already: 171 }
// 171 slots are already satisfied by CI on that build. Nobody runs them by hand.
```

**The executor** opens the run and lands on their first unfilled slot.

```
g r ⏎          R-41 · 43 left for people · 22 mine   (171 filled by CI, 2 by agent "explorer")
p              pass; the next case is already rendered
2 f            step 2 failed; caret in the note
Total shows $100.00 after SAVE10  ⌘V(screenshot) ⏎
               → Q-2315 opened; hint: "same signature as Q-2291 (defect, sam)"   ⏎ accepts the hint
b blocked env down ⏎
```

Each key is the same operation CI used:

```ts
report({ run: 'R-41', results: [{ test: { case: 'C-311' }, outcome: 'fail', steps: [{ step: 's2', outcome: 'fail' }],
                                   note: 'Total shows $100.00 after SAVE10', attachments: ['blob_5c…'] }] })
// basis: exact (the slot pinned C-311 v3 when the run started)
```

Two executors on the same slot: both results are kept; the run shows the
disagreement; it resolves through a decision, never by the later write.

### 5.5 What the usage requires of the types

1. One `report` shape for a 10,000-result file and a single keypress; the
   producer is the token's actor, never a parameter.
2. Results attach to *what was tested* (a target); a run is a predicate over
   targets plus pinned slots with explicit obligations, so CI results fill a
   manual run only where the obligation admits that method and binding.
3. Every result carries an explicit basis: exact, assumed or unresolved.
4. A question exists once per cause and remembers its answer; `decide` has one
   signature at every strictness and says whether the caller settled,
   advised, or still needs someone.
5. Saving a case and proposing a change are the same call; policy decides what
   happens next.
6. Every read an agent makes is bounded, carries hashes and a cursor, and can
   be told what the caller already has.

## 6. Domain model

Notation: `// KEY` names a unique or ordered key the store must support (part
of the structure, not a tuning step); `// WRITER` names the only code allowed
to write a field.

### 6.1 Kernel

```ts
type Seq  = Brand<bigint>     // per-project logical clock, assigned at commit in commit order
type Hash = Brand<string>     // content hash, stable across export/import
type Ref  = string            // C-311 case · T-1904 test · Q-2291 question · R-41 run · P-880 proposal · REQ-17

type Actor = { id: ActorId; kind: 'human' | 'agent' | 'ci' | 'rule'; name: string; onBehalfOf: ActorId | null }
type Grant = { actor: ActorId; project: ProjectId | '*'; can: Capability[]; roles: RoleId[] }
type Capability = 'read' | 'produce' | 'answer' | 'plan' | 'admin'
// produce = propose, report, claim, advise.  answer = may be counted on questions, subject to policy.
// There is no seat, licence or user-count field anywhere.

type Stamp   = { by: ActorId; at: Instant; seq: Seq; cmd: CommandId }   // on every fact
type Command = { id: CommandId; project; op: OpName; actor; at; seq: Seq; touched: Ref[]; outcome: Hash }
// KEY (id) unique        → a retry returns the stored outcome and writes nothing
// KEY (project, seq)     → audit order, change push, export order
```

### 6.2 Suite: what should be true

```ts
type Case = {
  id: CaseId; ref: Ref; project; kind: 'case' | 'fragment'   // fragment = shared steps, same versioning
  // WRITER for the next six: the effect of an 'adopt' decision, nothing else
  head: VersionNo; headHash: Hash          // hash of the resolved body (fragments expanded)
  claimHash: Hash                          // hash of the claim class only: pre, steps, expected (see 0008)
  title: string; methods: NonEmpty<Method>; intent: Intent   // copies of head.body fields, so a list page needs no body
  place: Placement; state: 'active' | 'archived'
  aliases: string[]; rev: Seq
}
type MethodKind = 'human' | 'auto' | 'agent'
type Method = { m: 'human' } | { m: 'auto'; tests: TestId[] } | { m: 'agent'; charter: CharterId }   // declared eligibility, versioned in the body
type Intent = { automate: 'none' | 'wanted' | 'not-applicable' }
type Placement = { folder: FolderId; rank: Rank; tags: TagId[] }   // organisation; versioned as placement history
// KEY (project, ref) unique · KEY (project, folder, rank) · KEY (project, rev) · KEY (project, alias) unique

type Version = { case: CaseId; no: VersionNo; parent: VersionNo | null; body: CaseBody
                 hash: Hash; claimHash: Hash; proposal: ProposalId; decision: DecisionId; seq: Seq }
// KEY (case, no)         → head read, diff, versionAt(seq) by a short backwards walk
type CaseBody = { title: string; pre: Text; steps: Step[]; methods: NonEmpty<Method>; intent: Intent; fields: Record<FieldId, FieldValue> }
// canonical text shorthand `methods: [human]` expands to [{ m: 'human' }]
type Step = { id: StepId; action: Text; expected: Text | null } | { id: StepId; use: { fragment: CaseId; version: VersionNo } }   // PINNED
type Uses = { fragment: CaseId; version: VersionNo; case: CaseId }   // KEY both ways
// Adopting a new fragment version publishes one attributable batch of new versions for every user that followed
// the old one (J12): one proposal authored by the fragment's editor with cause = fragment, through the same adopt
// path and policy. Old case versions keep their pins, so any version's expansion is reconstructible forever.
type PlacementHistory = { case: CaseId; from: Placement; to: Placement; decision: DecisionId; seq: Seq }

type Proposal = { id; ref; project; author: ActorId; reason: string | null
                  state: 'open' | 'sealed'      // open = the author's autosaved draft: uncommitted, amendable only by its author, not a fact
                  edits: Edit[]; cause: { fragment: CaseId; version: VersionNo } | null; stamp: Stamp }
type Edit =                                      // every edit of existing state names the base it was made on (decision 0004)
  | { op: 'create';  case: CaseId; body: CaseBody; place: Placement; covers: RequirementId[] }
  | { op: 'edit';    case: CaseId; base: VersionNo; body: CaseBody }
  | { op: 'place';   case: CaseId; base: Seq; to: Placement }
  | { op: 'state';   case: CaseId; base: Seq; to: 'active' | 'archived' }
  | { op: 'restore'; case: CaseId; base: VersionNo; to: VersionNo }
  | { op: 'cover';   requirement: RequirementId; case: CaseId; on: boolean }
  | { op: 'area';    glob: PathGlob; folder: FolderId; on: boolean }
  | { op: 'folder';  folder: FolderId; base: Seq; to: Partial<Folder> | null }
  | { op: 'set';     set: SetId; base: Seq | null; body: Selection }          // a saved selection ("plan") is a document
  | { op: 'policy';  base: PolicyVersion; body: Clause[] }
  | { op: 'gate';    gate: GateId; base: Seq | null; body: GateRule }
  | { op: 'charter'; charter: CharterId; base: Seq | null; body: Charter }
type Selection = { folders?: FolderId[]; tags?: TagId[]; covers?: RequirementId[]; methods?: MethodKind[]; text?: string }
type GateRule  = { select: Selection; require: Obligation[]; blocks: 'change' | 'release' }   // a named, reusable set of run obligations
type Charter   = { select: Selection; stance: 'review' | 'attack'; brief: Text; budget: { tokens?: number; minutes?: number } }

type Requirement = { id; ref; project; title; source: ExternalRef | null; state; rev: Seq }   // native, or a one-way mirror
type Covers = { requirement: RequirementId; case: CaseId; decision: DecisionId }               // KEY both ways
type Area   = { glob: PathGlob; folder: FolderId; decision: DecisionId }
type SearchDoc = { case: CaseId; project; text: string }   // replaced by the adopt effect in the same transaction
```

Invariants carried by the shape: `Case.head` cannot move without a decision
(`Version` requires one); a version number exists only for adopted content; a
move or retag is placement history, not a new version, but it is history; a
bulk edit of 1,000 cases is one proposal, one question, one decision, one
Seq, with its inverse computable (undo); a fragment is pinned by version in
every user, so a case version's expansion never changes.

### 6.3 Evidence: what was observed

```ts
type Test = { id: TestId; ref: Ref; project; kind: 'manual' | 'auto'
              key: string                 // auto: normalised "file::suite::name[params]"; manual: "case:<CaseId>"
              case: CaseId | null         // WRITER: effect of a 'map' decision
              file: string | null; job: string | null }
// KEY (project, key) unique · KEY (project, case) · KEY (project, file)

type Target = { id: TargetId; project; env: string; line: LineId; change: ChangeId | null
                what: { t: 'code'; repo: RepoId; commit: Sha; tree: Hash | null }
                    | { t: 'artifact'; digest: Hash; code: { repo: RepoId; commit: Sha }[]; attestation: Attestation | null }
                    | { t: 'session'; name: string }     // no build identity: evidence proves nothing about a commit
                build: string | null }                   // a label ("1.4.0-rc3") bound to `what` by `announce`; immutable once bound
// KEY (project, what, env) unique · KEY (project, build) unique where build != null
type Attestation = { by: ActorId /* ci or admin */; at: Instant; digest: Hash; code: { repo; commit }[] }   // "this artifact was built from this code"
// Acceptance of code evidence for an artifact target (B's CodeInArtifact) requires an attestation and a run
// obligation that opts in (`target: 'code-in-artifact'`); the default is exact.
type Line   = { id; name; class: 'trunk' | 'release' | 'change' }
type Change = { id; project; key: string /* "pr:482" | "commit:9f3c…" */; base: Sha; head: Sha; files: Path[]; refs: ExternalRef[]; rev: Seq }
type Deploy = { target: TargetId; env: string; stamp: Stamp }

type Batch = { id; project; key: Hash /* H(target, job, attempt, payload digest) */; target; job; attempt
               method: MethodKind; charter: CharterId | null   // declared by the producer; validated: human → human; ci → auto; agent → auto | agent (agent requires a charter)
               state: 'accepted' | 'processed'; counts; staged: ResultIn[] /* durable until processed */; raw: BlobRef | null
               manifest: VersionManifest | null; seq: Seq; stamp }
// KEY (project, key) unique         → the same report twice is a no-op with the same receipt
// KEY (project, state='accepted')   → the gate horizon (6.4)
type VersionManifest = { test: TestKey; case: CaseId; version: VersionNo }[]   // written by `casebook prepare` before the tests run
type ResultIn = { test: TestKey | { case: CaseId; run?: RunId /* the run whose pinned slot this manual result is for; never a SlotId */ }; outcome; attempt?; durationMs?; failure?: { message; at? }
                  steps?; note?; attachments?: BlobRef[]; annotation?: { case: CaseId; version: VersionNo }; corrects?: ResultId }
// One canonical constructor, used for every result from every entry (manual keypress, agent batch, parsed CI file):
//   evidence.acceptResult(ctx, batch, slot: Slot | null, in: ResultIn): Result | Rejected
// It resolves the test, checks the target is immutable and matches the slot's run if any, derives the basis (7.2,
// conflicts between slot, annotation and manifest are rejected, never relabelled), checks correction authority
// (only the original producer or a decision may correct), normalises the failure signature and stamps the actor.

type Basis =
  | { b: 'exact';      case: CaseId; version: VersionNo; claim: Hash }   // pinned slot, version manifest, or @C-311@v7
  | { b: 'assumed';    case: CaseId; version: VersionNo; claim: Hash }   // the head at ingest; recorded as an assumption
  | { b: 'unresolved'; test: TestId }                                     // no case; history only
type Result = { id: ResultId; project; test: TestId; seq: Seq; ord: number; batch: BatchId; target: TargetId
                method: MethodKind; charter: CharterId | null; by: ActorId   // copied from the batch so a slot can count distinct actors, methods and charters
                basis: Basis; outcome: 'pass' | 'fail' | 'skip' | 'blocked' | 'error'
                attempt: number; durationMs: number | null
                failure: { signature: SignatureId; message: Text; at: StepId | string | null } | null
                steps: { step: StepId; outcome }[] | null; note: Text | null; attachments: BlobRef[]
                run: RunId | null; corrects: ResultId | null }   // a correction is a new result naming the old; both kept
// KEY (project, test, seq desc) → last N results · KEY (project, batch, outcome) → a report's page
// KEY (project, target, test) → base/head comparison for impact · KEY (project, signature, seq desc) → failures by cause
// `run` is only where a result was typed; slot membership is `SlotResult` (6.4), one row per admitting slot · `corrects` KEY (replaced) → corrected rows leave the effective set
// The producer kind is the actor's kind; the method is declared and validated; there is no free "type" column.

type Signature   = { id; project; hash: Hash /* class + normalised message + first frame outside the test */; class: 'assertion' | 'infra' | 'timeout'; sample: Text }
type TestSignals = { test: TestId; trunk: {...}; flips: Ring<{commit; batch}, 16>; lastFail; flaky: { state; score; since } }   // WRITER: the ingest fold
type JobManifest = { job; line; batchNo; tests: TestId[] }   // stale = absent from the latest manifest of its job

type Finding = { id; project; stamp; lens: string; on: Locus; category: FindingCategory; note; repro; suggest: Suggestion | null; basis: Hash }
type Suggestion = { step?: StepId; action?: Text; expected?: Text } | { case: { title; folder: FolderId; steps: string[] } }
// step defaults to the step named by the finding's locus (`on: "C-311#s2"`); a step suggestion with no step anywhere is rejected
// a shorthand an agent can write; the finding kind's `accept {apply: true}` effect normalises it into an `Edit` on a sealed
// proposal authored by the finder (outline grammar as in 5.1), which then goes through `adopt` like any edit
type Review  = { id: ReviewId; reviewer: ActorId; lens; case: CaseId; basis: Hash; seq: Seq }
// basis = H(version hash [fragments are pinned, so it covers the expansion], patch tree hash of the change if any,
//           charter hash if any). `claim` computes it from `reviewed: ["C-311@<version hash>"]` plus `patch`; the
//           server, not the caller, decides the basis.
// KEY (case, basis, lens)      → "already reviewed at this basis, by whom"; a zero-finding review writes this row
```

Derived, never typed: manual/automated/both (from `methods` and linked
tests that report), unlinked (`Test.case === null`), stale (job manifests),
flaky (`TestSignals`), automation rate and backlog (`intent.automate`).

### 6.4 Runs: a request for evidence

```ts
type Run = { id; ref; project; name; origin: 'change' | 'planned'
             accepts: TargetMatch                              // which targets count toward it
             require: Obligation[]                             // what counts as complete; from the policy defaults, a GateRule, or `plan`
             state: 'open' | 'closed'; frozen: boolean; signoff: DecisionId | null   // WRITER: the effect of a signoff decision
             horizon: { accepted: Seq; applied: Seq; outstanding: number }   // WRITER: batch acceptance and runs.fold (6.4 Horizon)
             nextExpiry: Instant | null                        // earliest hold expiry among the decisions this run depends on
             // WRITER for the rest: runs.fold, on processing, on decision events, on expiry
             tally: { pass; excused; attributed; unexplained; missing; waived; disputed }
             blocking: { ids: QuestionId[]; count: number }
             verdict: 'passed' | 'failed' | 'blocked' | 'pending'; stamp; rev: Seq }
type TargetMatch =
  | { repo: RepoId; commit: Sha; env?: string }                 // a change run
  | { build: string; env?: string }                             // a label bound to an immutable `what` by `announce`
  | { line: LineId; env: string; from: Seq }                    // results whose batch.seq >= from
  | { self: true }                                              // only results typed into this run; proves nothing about a build
type Obligation =                                               // what a run needs; not a Requirement (a tracker item)
  | { id: ObligationId; kind: 'exercise'; methods: NonEmpty<MethodKind>
      bindings: 'any' | TestId[]                                  // which linked tests may fill the slot
      charters: 'any' | CharterId[]                               // which charters an agent result must come from
      minActors: 1 | 2; basis: 'exact' | 'exact-or-assumed' | 'same-claim'; target: 'exact' | 'code-in-artifact' }
      // same-claim: a result on another version whose claim hash equals the slot's counts (an explicit policy choice, C's idea)
  | { id: ObligationId; kind: 'review';  lens: string; independent: boolean }            // an agent or human review of the pinned version
  | { id: ObligationId; kind: 'jobs';    jobs: string[] }                                 // required CI jobs must have a processed batch
  | { id: ObligationId; kind: 'signoff'; role: RoleId; stage: 'start' | 'close' }
// KEY (project, repo, commit) unique where origin='change' → the gate read by CI is one lookup
// KEY (project, state='open') → runs an ingest must consider
type Slot = { id: SlotId; run: RunId; case: CaseId; version: VersionNo; claim: Hash   // pinned when the run starts
              obligation: ObligationId                                      // the exercise or review obligation this slot serves
              assignee: ActorId | null; rank: Rank
              agg: Map<ActorId, { passes: number; failsUncorrected: number; latest: Seq }>   // per actor, lossless for state; WRITER: runs.fold
              recent: Fill[]                                                // bounded (<= 16), presentation only
              state: 'missing' | 'satisfied' | 'failing' | 'disputed' | 'waived'   // derived from agg and the obligation
              waiver: DecisionId | null }                                   // WRITER: effect of a 'gap' decision
// agg is keyed by actor because the state rules are about actors: satisfied = at least minActors actors with a pass and
// no actor with an uncorrected fail; failing = an uncorrected fail and no other actor's pass; disputed = an uncorrected
// fail from one actor and a pass from another. Actors per slot are few (unmeasured; never capped, never read from
// `recent`). agg is rebuilt from the slot's SlotResult rows: for an exercise slot from the admitted results' actors and
// outcomes; for a review slot each admitted Review row counts as that reviewer's pass, so one row satisfies it.
type Fill = { evidence: SlotResult['evidence']; by: ActorId; method: MethodKind | 'review'; outcome; basis: Basis['b'] | 'review'; admitted: 'exact' | 'assumed' | 'same-claim' | 'review' | null }
// KEY (id) unique · KEY (run, rank) · KEY (run, assignee, state='missing', rank) → "my next slot" · KEY (case, run) → open runs wanting this case
type DependsOn = { run: RunId; decision: DecisionId; expires: Instant | null }   // KEY both ways; KEY (project, expires)

function verdict(t: Run['tally'], blocking: number, h: Run['horizon'], expired: boolean): Run['verdict'] {
  if (h.outstanding > 0 || expired)                   return 'pending'   // an accepted batch is not yet applied, or a hold ran out
  if (t.attributed > 0)                               return 'failed'    // needs a fix
  if (t.unexplained > 0 || t.disputed > 0 || blocking) return 'blocked'   // needs a decision
  if (t.missing > 0)                                  return 'pending'   // needs evidence (slots, required jobs)
  return 'passed'
}
```

**Acceptance rule (what fills a slot).** A result is a *counted* fill of a
slot when all of these hold, checked by one pure function `qualifies(result,
slot, obligation, run)`:

1. its `basis` names the slot's case at the pinned version (`exact`), or is
   `assumed` at that version and the obligation allows `exact-or-assumed`,
   or names another version with the slot's claim hash and the obligation
   allows `same-claim` (the fill records which rule admitted it);
2. `matches(run.accepts, result.target)`: same repository and commit (and
   environment if named), or the bound build label, or the line window; for
   an artifact target, a code result counts only when the obligation says
   `code-in-artifact` and the artifact carries an attestation naming that
   commit; a `session` target never fills a change run;
3. its `method` is in `obligation.methods`, and the case's declared
   `methods` includes that kind (a manual-only case is never filled by a
   test);
4. for `auto`, its test is in `obligation.bindings` (or `bindings: 'any'`
   and the test is linked to the case); for `agent`, its batch names a
   charter that is in `obligation.charters` (or `'any'` and the charter is
   one the case declares in its `methods`); an agent result with no charter
   never fills a slot;
5. the slot is **satisfied** when at least `minActors` distinct actors have a
   counted pass and no counted fail is uncorrected; a counted fail is
   **failing** (a `failure` question is raised); a counted fail beside a
   counted pass from another actor is **disputed** (a `failure` question with
   the `disputed` hint, answered by `resolve`), never averaged. The fold
   reads the slot's complete effective result set from `SlotResult` (below)
   minus corrected rows; `agg` keeps per-actor counts, which is exactly the
   information the three states need, and `recent` is presentation only, so a
   seventeenth fill cannot hide a failure and one actor's fail beside
   another's pass is always `disputed`.

```ts
// The durable many-to-many between slots and the results that qualify for them. One immutable Result may
// qualify for several runs (a CI result fills a change run and two planned runs on the same build).
type SlotResult = { slot: SlotId; run: RunId; evidence: { t: 'result'; id: ResultId } | { t: 'review'; id: ReviewId }
                    admitted: Fill['admitted']; corrected: boolean }
// One row per (slot, evidence) that qualification admitted. Two branches, never mixed: an exercise slot admits results
// through `qualifies` (a result that qualifies for two obligations on the same case has two rows; one that qualifies
// for only the permissive one has one); a review slot admits a Review row whose case, basis and lens match the slot's
// pinned version and obligation and whose reviewer is not the version's author when `independent` is set. A result
// never produces a review-slot row and a review never produces an exercise-slot row.
// KEY (slot, evidence) unique · KEY (evidence) → every slot a correction must revisit
// WRITER: runs.fold, which qualifies each candidate slot (`Slot (case, run)` for every matching run in
// `Run (project, state='open')`) at ingest and at `claim`, at `plan` for prior results and reviews on matching
// targets and bases (the "already: 171"), and on a late batch to a closed run. The slot's complete effective set is
// its SlotResult rows minus corrected.
```

A review obligation is filled only by a `Review` row at the slot's basis
(and, if `independent`, by an actor other than the version's author),
recorded as a review-branch `SlotResult` row when `claim` writes the review
or when `plan` finds one. It is never filled by a result, and a result never
fills a review obligation.

**Horizon.** Accepting a batch (durable staging of its normalised results,
before any processing) increments `horizon.outstanding` and sets
`horizon.accepted` on every run whose `accepts` matches the batch's target,
open or closed; a frozen run instead records the batch as "after freeze" and
changes nothing. `runs.fold`, after applying a batch's results, signals and
questions in one transaction, decrements `outstanding` and sets `applied` to
the highest Seq such that every matching batch at or below it is processed,
advancing past already-processed higher batches when a hole closes
(`applied` is a contiguous watermark; processing order is not assumed; when
`outstanding` is 0, `applied` equals `accepted`). The gate read returns
`pending` while `outstanding > 0`, so a stale green is never served whatever
order batches are processed in.

A late batch does not reopen a closed run: `state` is standing and only a
`signoff` decision writes it. The closing decision holds `until:
'basis-changes'` with the run's evidence digest as its basis, so the fold
that applies the late batch re-raises `signoff(close)` (the rule or the role
answers again) and the new decision supersedes the old one in the ledger.
Until it is answered, the gate reads `blocked` or `pending` as the evidence
dictates. A frozen run's verdict is immutable: the gate read reports the
frozen verdict and, as a separate flag, whether a depended-on hold has since
expired or a batch arrived after the freeze.

**Expiry.** Every decision a run's tally depends on is a `DependsOn` row;
`nextExpiry` is their minimum. The gate read compares `nextExpiry` to now and
returns `pending` once passed (frozen runs excepted, as above); a persisted
sweep (and any ingest or decision event on the run) re-raises the expired
question and re-folds the run in one transaction.

### 6.5 Decisions: the queue, the ledger and the policy

```ts
type Kind = 'adopt' | 'map' | 'failure' | 'flaky' | 'gap' | 'finding' | 'signoff'

// One table, exhaustive: per kind, its subject and its closed answer set. This is the normative list.
type KindTable = {
  adopt:   { subject: { proposal: ProposalId }
             answer:  { is: 'accept' } | { is: 'reject' } | { is: 'merge'; body: CaseBody } }
  map:     { subject: { file: string } | { test: TestId; stale: true }
             answer:  { is: 'link'; pairs: [TestId, CaseId][] } | { is: 'create'; folder: FolderId }
                    | { is: 'track' } | { is: 'ignore'; pattern: string } | { is: 'unlink' } }
  failure: { subject: { signature: SignatureId; scope: LineId | ChangeId | RunId }
             answer:  { is: 'defect'; ref?: ExternalRef } | { is: 'test' } | { is: 'expected' }   // attributed to the target
                    | { is: 'flaky' } | { is: 'infra' }                                          // excused
                    | { is: 'resolve'; trust: ResultId[] } }                                     // a disputed slot: which fills count
  flaky:   { subject: { test: TestId; edge: 'enter' | 'exit' }
             answer:  { is: 'quarantine'; exit: { cleanRuns: number } | { until: Instant } } | { is: 'keep' } | { is: 'release' } }
  gap:     { subject: { run: RunId; obligation: ObligationId } | { run: RunId; case: CaseId }
             answer:  { is: 'waive'; until: Instant | null } | { is: 'descope' } | { is: 'request'; assign: ActorId } }
  finding: { subject: { on: Locus; category: FindingCategory }
             answer:  { is: 'accept'; apply: boolean }   // apply: the suggestion becomes a sealed proposal authored by the finder
                    | { is: 'reject' } | { is: 'duplicate'; of: QuestionId } | { is: 'defer' } }
  signoff: { subject: { run: RunId; stage: 'start' | 'close' }
             answer:  { is: 'approve'; freeze: boolean } | { is: 'reject' } }
}
// `signoff(close)` is how any run closes, in every preset: the loose preset's rule answers it the moment the
// verdict is `passed`; the regulated preset names two approvers and freezes. Closure is therefore always a decision.

type Question<K extends Kind> = { id; ref; project; kind: K; subject; fingerprint: Hash; epoch; prior
                                  evidence: Digest<K>; evidenceHash: Hash          // what the answerer saw
                                  seen: { count; first; last; carried }; ask: Ask; blocks: RunId[]; owner
                                  answers: Given<K>[]            // append-only; the current answer per actor is derived
                                  state: { s: 'open' } | { s: 'decided'; decision } | { s: 'dissolved'; why }
                                  snooze; rev: Seq }
// KEY (project, fingerprint, epoch desc) → raise(): open / attach / carry / re-ask in one lookup
// KEY (project, state='open', owner, rank) → the queue; index-only count · KEY (subject ref) → questions on a case, run, test, change
// KEY (project, rev) → "what was decided since"
type Given<K>  = { by: ActorId; answer; reason; at; onEvidence: Hash; counts: boolean }   // an answer names the evidence it saw
type Ask       = { who: 'rule' | 'member' | 'role'; role; quorum: 1 | 2; notProducer: boolean; agents: 'answer' | 'advise' | 'none'; reason: 'optional' | 'required'; clause; policy }
type Decision<K> = { id; project; question; kind: K; answer; signers: { by; at; reason; clause; policy }[]
                     basis: Hash; holds: Hold; supersedes: DecisionId | null; stamp }
type Hold = NonEmpty<HoldTerm>                 // the hold ends when any term ends; persisted with the data it needs
type HoldTerm = { until: 'basis-changes'; basis: Hash } | { until: 'this-target'; target: TargetId } | { until: Instant }
              | { until: 'clean'; runs: number; sinceSeq: Seq; test: TestId } | { until: 'closed'; ref: ExternalRef }

// Standing: the only mutable judgment state; each has one writer, a decision's effect, which takes a witness:
type Decided<K> = Brand<Decision<K>>          // minted only by decisions/settle
//   Case.head, place, state, Covers, Area, Policy, Gate, Charter  ← adopt
//   Test.case                                                     ← map
//   Excuse { signature, scope, decision, hold }                   ← failure      KEY (project, signature, scope)
//   Quarantine { test, decision, exit }                           ← flaky
//   Slot.waiver                                                   ← gap
//   Run.signoff, state, frozen                                    ← signoff

type Policy = { project; version; clauses: Clause[]; decision: DecisionId }
type Clause = { id; kind: Kind; when: Predicate /* closed vocabulary */; ask: Ask & { answer?: unknown }
                blocks: 'nothing' | 'change' | 'release' | 'all'; escalate: { after: Duration; to: RoleId } | null }
// First matching clause wins; every preset ends with a catch-all per kind.
```

Rules the judge required and this synthesis adopts:

- **No standing changes outside a decision.** A detector may *suggest* (base
  failure, prior quarantine, similar signature) in the question's digest; the
  excuse itself is a decision, which a rule clause may make instantly. The
  loose preset's rule excuses base failures; the ledger shows the clause.
- **Answers are basis-checked.** A `Given` names the evidence hash it saw; a
  quorum counts only answers on the current evidence; `decide` on a changed
  question returns `conflict` with the new digest.
- **Holds expire visibly.** An expired hold re-raises the question on the next
  occurrence and re-folds every run that depended on the decision, in the same
  transaction as the event that noticed it (ingest or a scheduled sweep).
- **Reuse suggests; policy grants authority.** A carried-forward answer, a
  reviewed basis or an unchanged claim hash reduce what a person or an agent
  reads. Whether they count toward a gate is a clause.

The presets are three clause lists (loose, standard, regulated). The draft
table below is normative until `docs/ux/policy-presets.md` supersedes it
after the phase 0 profile review. "rule: x" means the policy answers x and
records the decision. Decision 0003's five switches are rows of this table.

| Kind (condition) | loose | standard | regulated | blocks |
| --- | --- | --- | --- | --- |
| adopt (human author) | rule: accept | rule: accept | role approver, not author, reason | nothing |
| adopt (agent author) | rule: accept | member | role approver | nothing |
| adopt (stale base, same field) | author | author | author, then approver | nothing |
| adopt (policy, gate, charter) | admin | admin | 2 approvers, reason | nothing |
| map (unlinked) | rule: track | member; agents answer | member; agents advise | nothing |
| failure (on a change) | member; agents advise; rule: excuse when `fails-on-base` | member; `flaky`/`infra` not by the change author | role, reason | change |
| failure (trunk, release, planned run) | member | member | role, reason | release |
| failure (disputed) | member | member, not a producer of the fills | role, reason | all |
| flaky (enter) | rule: quarantine, exit after 20 clean (draft) | member | role lead, reason, `until` required | nothing |
| flaky (exit) | rule: release | rule: release | role lead | nothing |
| gap | not raised | role lead | role approver, reason, expiry | release |
| finding (category defect) | member | member | role | release (regulated) |
| finding (other) | member; agents answer `duplicate` | member | role | nothing |
| signoff (start) | rule: approve | rule: approve | role approver | release |
| signoff (close) | rule: approve when passed | role lead | 2 approvers, reason; freeze | release |


### 6.6 Access patterns, traced

Every read ends in point reads or one bounded range read on a key named above.

| Pattern | Path | Budget (draft) |
| --- | --- | --- |
| Read one case | `Case (project, ref)` → `Version (case, head)`; `unless: hash` stops after the first | p95 < 20 ms |
| List a folder page | range `Case (project, folder, rank)` 50 rows; three batched point reads for glyphs (`Test`, `TestSignals`, open-question counts) | < 50 ms |
| Search | `SearchDoc` scoped by project with folder/tag filters in the same query, then the list reads | < 100 ms |
| Save (seal) one case | one transaction: proposal sealed → `raise('adopt')` → rule clause → `adoptVersion`: Version, head, hashes, SearchDoc, fragment users | < 50 ms |
| Bulk edit 1,000 | one proposal, one decision, set-based writes | < 1 s |
| Execute a run | `Slot (run, assignee, state='missing', rank)` limit 1 → pinned `Version`; client prefetches five; `report` of one result: `acceptResult`, `qualifies` per candidate slot → `SlotResult` rows, per-actor `agg`, slot state, tally delta, `raise('failure')` on fail | no wait after a key |
| Ingest 10k | the adapter parses first; accept: batch key, stage the normalised results durably, job, matching runs (frozen excepted) → `outstanding++` (< 2 s); process in one transaction: `Test.resolve` batched → `acceptResult` per row (basis) → insert results → fold signals for failures and flips only → signatures → runs.fold (`outstanding--`, contiguous `applied`) → raise per cause (< 5 s) | |
| Flaky on ingest | per failing result read last five of `(project, test, seq desc)`; same-commit pass = flip; `classify` pure; state change → `raise('flaky')` | within the ingest |
| Impact for a change | refs → `Requirement` → `Covers`; files → `Test (project, file)` → case; files → `Area` globs → folders; ≤ 200 candidates → batched reads of hash, `Review`, signals, open/held questions, last result on base and head; rank pure; uncovered files listed | agent token budget |
| Changed since | range `Case (project, rev > S)` filtered by scope; `versionAt` backwards walk; step-level diffs; `Question (project, rev > S)` for settled | tokens |
| Traceability | Requirement → Covers → Case → Version → Test → Result → Target → Deploy; failure → Signature → Excuse → Decision → defect ref; every hop keyed both ways | one click per hop |
| Gate read by CI | `Run (project, repo, commit)`: one row; the read applies the rules of 6.4 (`outstanding > 0` or `nextExpiry` passed → `pending`, frozen → the frozen verdict plus flags) and otherwise returns the stored verdict; two comparisons, no scan | < 20 ms |
| The queue | range `Question (project, open, owner, rank)` 50 rows with digests; counts index-only | < 50 ms at 50k open |

## 7. Operation layer and module map

### 7.1 The operation surface

Eighteen operations. Every surface calls these and nothing else; HTTP, MCP
and CLI encodings are generated from the registry. `mcp` marks the ten agent
tools. Wire formats (JUnit XML, TestRail and Qase exports, CSV, tracker
payloads) are parsed by adapters in `surfaces/` *before* the operation is
invoked: `report` takes normalised results and `transfer.import` takes the
canonical archive; the CLI's `report <files>` and `import --from testrail`
are adapters that parse and then call them. Durable acceptance is the
staging of the normalised results under the batch key, so parsing never sits
between acceptance and the gate horizon. Every write input carries a
client-generated `cmd: CommandId` (declared once in the registry envelope,
omitted below).

```ts
// produce evidence (capability: produce)
op propose  ({ id; edits; reason?; seal }): adopted | open{question, needs} | conflict{fields}              // mcp
op report   ({ target? | run?; job?; attempt?; method?; charter?: CharterId; manifest?; raw?: BlobRef; results: ResultIn[] }): ReportReceipt   // mcp
            // method defaults from the actor kind; an agent reporting method 'agent' must name the charter document it ran under
op claim    ({ lens; about?; patch?: Sha; reviewed?: `${Ref}@${Hash}`[]; findings }): { opened; known; reviewed }   // mcp
op announce ({ change } | { deploy }): Ref
op attach   ({ name; bytes }): BlobRef
// request evidence (capability: plan)
op plan     ({ name; select: Selection | SetId; accepts?; require?: ObligationIn[] | GateId; assign? }): { run; slots; already }
            // ObligationIn = Obligation with `id` server-assigned and these defaults from the project policy when omitted:
            // bindings 'any', charters 'any', target 'exact', minActors 1, basis the policy's default ('exact-or-assumed' in loose and standard, 'exact' in regulated)
// decide (produce = advise; answer = counted; then policy)
op decide   ({ q; onEvidence: Hash; answer; reason?; supersede? }
             | { kind; subject; evidence: Digest; answer; reason? }     // a genuinely new question: the caller supplies the evidence it acted on;
                                                                       // if a question with that fingerprint already exists, the reply is
                                                                       // exists{q, evidence} and nothing is written; the caller then uses the q form
             | { all: { q; onEvidence: Hash; answer }[]; reason? }): DecideReply   // mcp
// read (capability: read)
op inbox    ({ for?; kind?; state?: 'open' | 'decided'; on?; since?; limit?; cursor? }): { counts; items; cursor }        // mcp
op get      ({ refs; fields?; unless?; as?: 'data' | 'md' }): Got[]                                        // mcp
op find     ({ in; text?; where?; fields?; limit?; cursor? }): { count; items; cursor }                    // mcp
op impact   ({ change | run | requirement | folder; since?; ledger? }): ImpactDigest                       // mcp
op since    ({ cursor; scope? }): { changed; settled; cursor }                                             // mcp
op history  ({ ref; from?; to? }): VersionDigest[] | Diff
op gate     ({ commit | run; wait? }): GateStatus                                                          // mcp
op trace    ({ from; toward }): Chain
op check    ({ scope? }): Problem[]          // deterministic suite checker; same rules feed structural queue items
// administer (capability: admin)
op admin    (...): AdminReply
op transfer ({ export: { project } } | { import: { archive: BlobRef } }): TransferReply   // archive = the canonical format; import replays it through the owners' constructors under policy
```

Deliberately absent: `createCase`, `updateCase`, `moveCase`, `linkTest`,
`quarantine`, `createRun`, `addResult`, `closeRun`, `approve`. Each would be
a second way to do what `propose`, `report`, `plan` or `decide` do, and a
place for policy to be skipped.

```ts
type OpSpec<I, O> = { name; input: Schema<I>; output: Schema<O>; needs: Capability
                      effect: 'read' | 'write' | 'destructive'; mcp: { describe: string } | null
                      budget: { p95ms: number; tokens?: number }; run: (ctx: Ctx, input: I) => O }
const OPS: Record<OpName, OpSpec> = { /* eighteen entries */ }
// Generated from OPS, never hand-written: HTTP routes and OpenAPI, the MCP tool list, CLI commands and help,
// the palette registry, the shipped skill's reference pages, the latency and token budget tests.

function invoke(surface, name, raw, token) {
  const spec  = OPS[name]
  const input = spec.input.parse(raw)                 // boundary: wire → domain, or a typed error
  const ctx   = authorise(token, spec.needs, input)
  if (spec.effect === 'read') return spec.run(ctx, input)
  return commands.once(ctx, input.cmd, () => { const out = spec.run(ctx, input); ctx.tx.stampSeq(); return out })
}
```

### 7.2 The tricky bodies (pseudocode)

```ts
// decisions/raise.ts: the one algorithm every detector goes through
function raise<K>(tx, r: Raise<K>): Raised {
  const fp = fingerprint(r.kind, r.subject)
  const q  = tx.questions.latest(r.project, fp)
  if (!q)                   return open(tx, r, fp, 0, null)
  if (q.state.s === 'open') return attach(tx, q, r)                         // seen.count++, digest merged, evidenceHash updated
  if (q.state.s === 'decided') {
    const d = tx.decisions.get(q.state.decision)
    if (stillHolds(d, r.basis, tx.now)) return carry(tx, q, d, r)         // seen.carried++, no new item; visible on the run
    return open(tx, r, fp, q.epoch + 1, q.id)                              // asked again, with the old answer attached
  }
  return open(tx, r, fp, q.epoch + 1, q.id)
}
function open(tx, r, fp, epoch, prior) {
  const clause = firstMatch(tx.policy(r.project).clauses, r)              // total
  const q = tx.questions.insert({ ...r, fingerprint: fp, epoch, prior, ask: askOf(clause), blocks: runs.blockedBy(tx, clause, r) })
  if (clause.ask.who === 'rule') return settle(tx, q, [{ by: RULE, clause: clause.id }], clause.ask.answer)   // recorded
  return { s: 'open', q: q.id }
}

// decisions/answer.ts
function answer<K>(tx, actor, q, a, reason, onEvidence, supersede): DecideReply {
  if (onEvidence !== q.evidenceHash)            return { s: 'conflict', current: digest(q) }   // basis-checked
  if (q.state.s === 'decided' && !supersede)    return same(prior(q).answer, a) ? { s: 'already' } : { s: 'conflict' }
  const ask      = askOf(firstMatch(tx.policy(q.project).clauses, q, a))   // re-resolved; may depend on the answer
  const standing = standingOf(actor, ask, q)        // 'counts' | 'advice' | 'forbidden'  (pure; notProducer, agents)
  if (standing === 'forbidden')                 return { s: 'forbidden', needs: describe(ask) }
  if (ask.reason === 'required' && !reason)     return { s: 'invalid', needs: 'reason' }
  q.answers.push({ by: actor.id, answer: a, reason, onEvidence, counts: standing === 'counts' })   // append-only
  const t = tally(latestPerActor(q.answers).filter(g => g.onEvidence === q.evidenceHash), ask)
  if (t.s !== 'met') return { s: standing === 'advice' ? 'advised' : 'pending', needs: t.needs }
  return settle(tx, q, t.signers, a)
}
function settle<K>(tx, q, signers, a): DecideReply {
  // the decision this one replaces: a re-decide of the same question, or the effective decision of the
  // predecessor epoch when this question was re-asked (hold ended, late batch, evidence changed)
  const prior = q.state.s === 'decided' ? tx.decisions.get(q.state.decision)
              : q.prior                 ? effectiveDecision(tx, q.prior) : null
  if (prior) KINDS[q.kind].revert(tx, witness(prior), q)   // reverses the prior's standing effects; the prior row itself is never edited
  const d = tx.decisions.insert({ question: q.id, kind: q.kind, answer: a, signers, basis: q.evidenceHash,
                                  holds: KINDS[q.kind].holds(a, q), supersedes: prior?.id ?? null })
  q.state = { s: 'decided', decision: d.id }
  const effects = KINDS[q.kind].effect(tx, witness(d), q)   // the only call site of any standing writer; may throw Unsettled → rollback
  runs.onSettled(tx, q, d)                                   // re-tally the runs this question blocked
  return { s: 'decided', decision: d.id, effects }
}

// evidence/ingest.ts: the failure detector suggests; it never excuses
function detectFailures(tx, batch, failing: Result[]): Raise<'failure'>[] {
  const scope = scopeOf(batch.target)
  const out = new Map<SignatureId, Raise<'failure'>>()
  for (const r of failing) {
    const hints = [ tx.quarantine.has(r.test) && 'quarantined', scope.is === 'change' && failsOnBase(tx, r.test, batch) && 'fails-on-base' ]
    merge(out, r.failure.signature, r, hints.filter(Boolean))   // hints go into the digest; a clause may answer on them
  }
  return [...out.values()]
  // TODO over-merge guard: one signature over > 50 tests in > 5 files with class 'assertion' is split by file.
}

// evidence/basis.ts: what a result proves. Called only from acceptResult.
function basisFor(test: Test, batch: Batch, slot: Slot | null, annotation: VersionRef | null): Basis | Rejected {
  const claims = [ slot && { case: slot.case, version: slot.version }, annotation, batch.manifest?.get(test) ].filter(Boolean)
  if (!allEqual(claims))           return Rejected('BasisConflict', claims)   // never relabelled; the producer fixes its claim
  if (claims.length >= 1)          return { b: 'exact', ...claims[0], claim: claimOf(claims[0]) }   // one or several agreeing sources
  if (test.case)                   return { b: 'assumed', case: test.case, version: head(test.case), claim: claimOf(head) }
  return { b: 'unresolved', test: test.id }
}

// suite/merge3.ts, evidence/classify.ts, runs/verdict.ts, decisions/tally.ts, decisions/stillHolds.ts: pure; not implemented
```

### 7.3 Module map and ownership

```
surfaces/     rest · mcp · cli · web-api · formats        generated adapters and parsers (JUnit, TestRail, Qase, CSV, Markdown); no logic; import ops only
ops/          the registry (OPS) and invoke()             the only public entry; no state
  ├── views/      impact · since · trace · history · check    stateless; reads others' public readers
  ├── decisions/  raise · answer · settle · tally · holds     owns Question, Decision, Policy
  │     └── kinds/   adopt · map · failure · flaky · gap · finding · signoff   one file each: detect, digest, holds, effect, revert, default clauses
  ├── runs/       plan · fold · verdict                        owns Run, Slot
  ├── suite/      proposals, versions, placement, requirements, search, sets, gates, charters
  │                                                           owns Case, Version, Proposal, PlacementHistory, Folder, Requirement, Covers, Area, Uses, SearchDoc, Set, Gate, Charter (Policy is owned by decisions; adopt calls its writer)
  ├── evidence/   ingest, basis, signals, findings             owns Test, Target, Line, Change, Deploy, Batch, Result, Signature, TestSignals, JobManifest, Finding, Review, Excuse, Quarantine
  └── identity/   actors, grants, tokens                       owns Actor, Grant, Token
kernel/       tx · seq · commands · events · jobs · blobs   owns Command, Job, Blob; knows no domain type
ports/        tracker · vcs-status · notify                 outbound only; persisted jobs; never inside a transaction
```

Rules: one owner per row type, and one named owner per projection (`runs` owns
the run projections it folds from Evidence and Decisions facts, with a rebuild
check); standing writers take a `Decided<K>` witness;
domain modules never import `decisions` (they emit events dispatched
synchronously inside the transaction); `KINDS` and `OPS` are exhaustive maps;
pure core, thin shell; wire formats stop at `surfaces`; shells cannot import
internals (a lint fails the build). Shared state between actors: authors each
have a private open proposal per case; executors write different slots;
producers append; two answers to one question meet in `answer` with a basis
check.

## 8. Product surface

Six nouns with short IDs and pages: **Case** (`C-`), **Question** (`Q-`),
**Run** (`R-`), **Change** (`pr:482`), **Requirement** (`REQ-`), **Test**
(`T-`, secondary). No "manual / automation / AI" tabs anywhere.

1. **Suite (home, `g s`).** Where you write. A folder outline that edits in
   place: `c` creates, typing edits, `⌘↑/↓` reorders, `m` moves, `/` searches.
   Every case row carries a **proof strip**: one glyph per method, `H ✓ 2d  C ✗ 1h  A ·`
   (✓ a pass on the current version with a basis the project's policy counts, ✗ failing, ~ a pass on an older version
   or on an assumed basis the policy does not count, · never; hover shows the basis),
   a flaky mark and an open-question dot. Nothing on this screen is a status
   someone typed. The header shows the queue count. Home is Suite because
   capture is the job; a user whose day is triage sets Queue as home.
2. **Queue (`g q`).** What needs you, most blocking first; the producer glyph
   (◉ person, ▣ pipeline, ◇ agent) on every row; `␣` peeks the evidence
   without leaving the list; one key per answer; `x` multi-select; "settled"
   turns the list into the ledger.
3. **Case (`C-311`).** The body on the left, editable in place. On the right
   **one timeline**: versions (with the proposal's reason and who adopted
   it), results from every producer interleaved with their basis, findings and
   their answers, and the questions the case is part of.
4. **Run (`R-41`, or a PR's page).** Verdict in words, the tally, and the
   slots grouped by verdict class, each showing who or what satisfied it and
   on which basis. `⏎` on a slot enters the execution cockpit. A PR check, a
   regression pass and a release are the same page.
5. **Change (`pr:482`).** Gate, questions this change opened, failures that
   are not this change's fault and the decision that says so, the impact set
   with what an agent reviewed, uncovered paths.
6. **Release / Requirement.** Rows are requirements, columns the proof strip,
   plus the verdict with ranked reasons; the gap list is a filter on the same
   table; the chain to commits and deployments in both directions. Readable
   with a free reader identity.
7. **Command palette (`⌘K`)** reaches every object and every operation.
   **Policy** is the clause table and nothing else.

## 9. First deliverable slice: "one red build, three producers" (Preview 1)

The smallest version that is already the product and already better than the
incumbents on capture, execution and triage: a person, a pipeline and an
agent feed one stream, and one queue settles what they leave. It is phase 2
of the revised roadmap (after phase 0 research and the phase 1 stack
decision). It is named **Preview 1** and ships as the Local layer only. It is
not the first usable version: that is phase 3, which adds the Server layer
proven with the same job suite, persisted crash-safe jobs, checked backup and
restore, the Cloud multi-instance proof with the cache disabled, and the
remaining question kinds (decision 0002's rule stands).

**In.** One artifact; Suite with outline capture, paste splitting, private
drafts, sealed proposals, versions with step-level diff and restore,
placement history, search, bulk move/retag with undo; `report` for JUnit XML
and manual results with explicit basis; targets, changes, batches, signatures,
same-code flips; change runs with the four-verdict gate and acceptance-time
pending; planned runs with pinned slots filled by any admitted producer; the decision machinery in full with five kinds (`adopt`, `failure`, `map`,
`finding`, and `signoff` with rule clauses only, so every run closes by a
recorded decision), presets `loose` and `standard` (with one named override,
`preview-1`: standard's `signoff (close)` clause is `rule: approve when
passed` instead of `role lead` until the role path ships in phase 3, and
the ledger names that clause), and a `strict` fixture preset proving P5;
screens Suite, Queue, Case, Run, Change; CLI; MCP with ten tools and the
skill; `impact`, `since`, `check`, the review ledger; `transfer` export and
import of the full log; budgets in the check (latency set, L1, L2, C5, C7,
B1, B7). The regulated workflow itself (gap, the role and freeze paths of
signoff) is not in this slice and the slice says so.

**Exit.** J1, J2, J4, J5, J8, J15; A1 to A5; and: D1 (500 same-cause
failures → ≤ 3 questions), D2 (20 mixed questions in 60 s by keyboard), D3
(the same failing commit re-run asks nothing new; a failure returning after
its hold is asked again with the old answer shown), D4 (the same data passes
under `loose`, `standard` and `strict` with no migration), D5 (export/import
identical on every head hash, decision and verdict), E1 (a review alone never
fills an exercise slot; a manual fail beside a CI pass is `disputed` until
decided), E2
(accepting an upload makes a green gate pending; a stale green is never
served), E3 (an assumed-basis result qualifies under `exact-or-assumed` and
is `pending` under `exact`; agreeing slot, manifest and annotation sources
yield `exact`, disagreeing ones are rejected); E4 (a run with a required job stays `pending`
until that job's batch is processed, whatever else passed); E5 (two batches
accepted for one job, processed in either order, a question settled between:
the gate stays `pending` until both are applied; a late upload to a closed
run makes its gate `pending` and re-raises `signoff(close)`, whose new
decision supersedes the old; a frozen run never changes); E6 (a fragment edit through the
operation layer, no UI in this slice, publishes new versions for its users as
one attributable batch; an old run's slot still expands to what was
executed); E7 (a case moved out of a selection after a
run started keeps its slot; a review alone never fills an exercise slot; a
manual accessibility slot is not filled by a linked DOM test when the
obligation names `human`); E8 (an excuse with a date hold expires with no
new ingest: the gate read returns `pending` and the next occurrence is asked
again with the old answer shown). Latency budgets hold on the benchmark data
with concurrent ingest.

**Deliberately out, and what stands in:** flaky detector and quarantine
standing (`flaky` is already an answer that carries forward; flips are
recorded); requirements coverage, `gap`, the role and freeze paths of
`signoff`, regulated preset (runs close by the loose and standard rules;
`Requirement` rows exist); fragments and
custom fields (types present, no UI); posting checks to the code host and
creating tracker issues (`casebook gate` exit code and URL; defects as pasted
references); importers (Markdown and lists in, full export out); Cloud
workers, SSO; formats beyond JUnit; dashboards (five counts on the queue
header).

## 10. What this changes in earlier docs

| Replaces | With | Why | Cost |
| --- | --- | --- | --- |
| Vision ranking: fast backend > agents > UX | P0 as a floor; speed defined where thought happens (P1) with budgets in ms, tokens and keystrokes; agents and UX follow from P2. Daniel, 2026-10-11: speed stays a must-have, measured as "the brain never waits", and capture is the job to make faster. | A fast tool with an untrustworthy record has no value; and "fast backend" alone does not say where speed matters | Three kinds of budget to maintain |
| Vision principle 1: every edit is a version | Autosave into a private open proposal; a version exists when a proposal is sealed and adopted | Per-keystroke versions make history unreadable and give reviewers no unit; drafts are durable and visible as drafts | Others see an edit up to ~30 s later; abandoned drafts are sealed by a job |
| Vision: execution type (manual/automated/both) is a versioned field | Declared `methods` (eligibility) plus derived activity; `intent.automate` is the only wish | A declared type drifts from what reports; eligibility and activity are different facts | Importers map the old field to methods and intent |
| Vision: unlinked results inbox, optional auto-create | `Test` is a first-class evidence subject with or without a case; mapping is a `map` question | Automation-heavy teams get history, flakiness and gates without writing a case | Two nouns (case, test); coverage reports say "tests without a case" plainly |
| Vision: plans and runs; results belong to a run | A run is a predicate over targets plus pinned slots; results belong to a target; a plan is a saved selection (a `set` document) | The only shape in which CI, people and agents fill the same run | Manual results need a target (or `self`); a TestRail plan → run tree must be unlearned on import |
| Vision: every result stamps the exact version it executed | Explicit basis: exact, assumed or unresolved; policy says which qualifies | Drop-in CI cannot know the version; guessing silently is wrong, refusing all drop-in evidence is unusable | A second basis kind to explain; strict teams add a manifest step |
| Decision 0003: five policy switches | A clause table (kind × condition → who answers, what it blocks); the switches are rows of it | The table also covers what the switches forgot: who may excuse a failure, what an agent may settle | More ways to misconfigure; mitigated by presets, a closed predicate vocabulary and a totality check |
| Decision 0006 mechanism 5: a findings ledger | The ledger is every decision of every kind; a finding is one kind; review reuse is keyed by a basis that includes the relevant patch | Agents rediscover triage and mapping too; an unchanged case text does not mean an unchanged review | Fingerprints must be good for seven kinds |
| Roadmap phases 2 and 3: authoring first, then runs, CI, agents | One thin slice across all three producers and the queue (section 9), after phase 0 and 1 | An authoring-only slice is a nicer case editor; it tests none of the thesis | Authoring ships thinner at first (no fragments, no custom fields) |
| Open question 16 | A local `Requirement` row that may mirror a tracker item one way | Traceability must work in Local with no tracker; a link needs a row | A mirrored title can go stale; labelled with its source time |
| Decision 0001 stack criteria | Add: a per-project Seq assigned in commit order; batched point reads and writes of 10k keys in one transaction; an index-only count on the open-queue key; in-transaction full-text replacement; canonical text round trip | The traces above depend on them | Per-project commit serialisation is a throughput ceiling the benchmark must measure |

Decisions 0002, 0004 and 0005 are used as written.

---

## Synthesis decision

Four candidates were produced independently from one brief, each from a
different seed lens (brief, seeds, rubric, candidates, the judge's verdict
and the verification reports are kept in `docs/design-arena/2026-10-11/`):
**A** evidence-stream (GPT 6.1 Sol), **B** change-centric (GPT 6.1 Sol),
**C** repository and tooling centric (Claude Sonnet 5.5), **D** decision-queue
centric (Claude Opus 5.5). D disclosed that it read the judge-only rubric
before designing. An independent cross-judge (GPT 6.1 Sol, high effort)
scored them A 27, B 25, C 16, D 14 out of 30 and recommended A as base. The
orchestrator (Claude Fable 5.1) had leaned D as base with C's identity model.

**Resolution of the disagreement.** The judge was right on semantics: C's
ingest-time stamping and D's detector-side excuses guess at facts and bypass
the decision witness, and C's claim-hash proof inheritance and D's "never ask
again" floor assume more than the data proves. The orchestrator was right on
the surface: A's CI preparation step before tests run, its roster and
certificate ceremony and its saved-question home do not deliver the DX the
ask demands, and Daniel's note on the day (speed where thought happens;
capture is the job) weighs the surface heavily. The synthesis therefore uses
**A's evidence semantics as the invariant layer and D's product shape as the
surface**, and turns each place the judge called a guess into an explicit,
recorded basis under policy:

- **Base: D's shape** (evidence / question / decision; runs as predicates
  over targets with slots any producer fills; the clause table; the
  four-verdict gate; `propose / report / claim / decide` plus bounded reads;
  the registry; `Decided<K>`), with the judge's corrections applied:
  detectors suggest and never excuse; answers are basis-checked; holds expire
  visibly and re-fold runs; the public `report` takes normalised results and
  parsers live in adapters; completeness (required jobs) is explicit.
- **From A:** the explicit basis on every observation (exact / assumed /
  unresolved: A's "exact or unresolved" plus one honest middle, which is a
  departure from A recorded in decision 0008), review never
  a runtime pass, contradictions preserved as `disputed`, corrections as new
  results naming the old, required-producer completeness, and the floor
  wording of "a bad product".
- **From B:** the target union (code / artifact / session) with attestation,
  exercise/review/sign-off as distinct obligations on a run, review basis
  that includes the relevant patch, and acceptance-time gate invalidation.
- **From C:** the claim hash beside the version hash (as a reuse signal and
  a policy option, not automatic proof), canonical Markdown documents with
  step ids as the interchange and export form, policy/gates/charters as
  text, `check`, `fmt`, `bench`, the proof strip and the one-line
  `casebook report` with environment autodetection.
- **Rejected:** A's `scope open` before tests run as the default path (kept
  as the optional `prepare` for exact basis); B's proof-plan hierarchy and 22
  operations; C's git-shaped branches as the proposal model and `reaffirm`
  as proof transfer; D's queue as the only home and automatic base-failure
  exclusion.
- **Convergence noted:** all four reached one evidence shape with the
  producer as an attribute, history as the storage model, one operation
  registry, no seats, pending-not-green gates, review ≠ execution, one-line
  CI and a thin cross-producer first slice. No candidate dropped out.
- **Verification:** independent review rounds by GPT 6.1 Sol are in
  `docs/design-arena/2026-10-11/` (`verify-r1.md` found the slot acceptance
  rule, gate horizon, fragment pinning, decide basis and release boundary
  underspecified; the fixes are in sections 6.3 to 6.5, 7.1, 7.2 and 9;
  later rounds are filed beside it) and quoted in the pull request.

## Rationale

### Problem

Test management tools sell record keeping: paid per seat, with history and
approvals in the top tier and machine access rationed, and they still leave
the go/no-go decision to a meeting with a spreadsheet. Testing now has three
producers (people, pipelines, agents) and, as a hypothesis for the phase 0
audit, the incumbents model one well, one as an import and the third not at
all. The ask is one product for all three
with the feel of a modern developer tool, across loose to regulated teams,
from one self-hosted artifact, before a stack is chosen, where the thing to
make fast is getting a tester's thought into an artifact.

### Usage (caller's view)

Section 5. Four writes carry almost all traffic and are the same from UI,
CLI, CI and MCP (`propose`, `report`, `claim`, `decide`); the reads are
bounded and start from what the caller is doing (`inbox`, `impact`, `gate`).

### Shape

Section 6 and 7. Three kinds of write with three kinds of writer; evidence
with an explicit basis keyed by (test, target); runs as requests for evidence;
a typed, remembered decision with a hold; policy as a clause table; one
registry; one clock.

### Tradeoffs accepted

- We accept three extra rows on every save (proposal, question, decision) in
  exchange for one write path with no review on/off fork and an audit trail
  from day one in every preset.
- We accept a private open draft and a delay of up to ~30 s before others see
  an edit in exchange for readable history, a unit of review and stable
  hashes for agents.
- We accept a second basis kind (`assumed`) in exchange for drop-in CI that
  never guesses silently and never refuses useful evidence.
- We accept two nouns, case and test, in exchange for automation-heavy teams
  needing no cases to get history, flakiness and gates.
- We accept that manual results need a target (or `self`) in exchange for
  manual, CI and agent evidence filling the same run.
- We accept dependence on fingerprint and hold quality in exchange for asking
  each question once; the guard is short basis-bound holds, visible carry
  counts and a re-ask on expiry, so the failure mode is "asked again", not
  "silently excused".
- We accept per-project commit serialisation for the Seq in exchange for
  changed-since, export and audit being one ordered range read.
- We accept a closed set of kinds, answers and predicates (no workflow
  designer) in exchange for one-key answers, a small agent surface and
  policies an auditor reads as one table.
- We accept a thinner authoring experience in the first slice (no fragments,
  no custom fields) in exchange for a slice that exercises all three
  producers and the queue.

### Alternatives considered

- **A as written (evidence stream with manifests and certificates).** Deepest
  invariants; rejected as the surface because a prepare step before every CI
  run, producer rosters and a saved-question home cost the DX the ask is
  about. Its semantics are kept.
- **B as written (change-centric proof plans).** Right about targets and
  clauses; rejected because every piece of evidence then hangs off a change
  hierarchy and 22 operations, and authoring-heavy teams would live on a
  screen built for releases.
- **C as written (git-shaped document store).** Right about text, tooling and
  the claim hash; rejected because branches as proposals, `reaffirm` as proof
  and ingest-time stamping move authority away from recorded decisions.
- **D as written.** Right about the shape; rejected in three places the judge
  found: detector-side excuses, unchecked answer bases and the queue as the
  only home.
- **Incumbent shape with a nicer UI** (cases, runs, results as CRUD and an
  inbox view). Shallow: forty endpoints, policy checked in five places,
  history each endpoint must remember to write.

### Open questions and risks

Questions for Daniel are recorded in `docs/open-questions.md` (20 to 28).
Risks: fingerprint and hold quality (needs real failure data in phase 1); the
Seq commit-order rule as a throughput ceiling; the queue drifting into a
ticket tracker (the closed kind table is the defence); draft budgets are
guesses until the phase 0 audit gives baselines; impact sets depend on links
existing; the regulated preset is designed, not exercised, until `gap` and
the role and freeze paths of `signoff` ship.

### Next implementation step

In the phase 1 operation-layer prototype, implement `raise`, `answer`,
`settle`, `basisFor` and the `adopt` and `failure` kinds behind `propose`,
`report`, `decide`, `inbox` and `gate` from one registry on each candidate
stack (with a rule-only `signoff` stub so E5's supersession can run), and
run fixtures D1, D3 and E1 to E8 (including the inverse-order horizon,
agreeing provenance and late-upload signoff supersession cases) with the
ingest and capture budgets in embedded and server mode.
