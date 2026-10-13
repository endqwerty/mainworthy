# Mainworthy, candidate D: the decision queue

Stack-neutral. Type sketches are TypeScript-like notation, not a stack choice. Numbers marked
*(draft)* are budgets to validate on the phase 1 benchmark, not measurements. Competitor facts
are cited from `docs/competitive-analysis.md` with its labels (Verified / Reported / Open);
anything else is marked *hypothesis*.

Contents: 1 Thesis · 2 Why the incumbents are a poor use of money · 3 Guiding principles ·
4 The DX/UX moves · 5 Usage first · 6 Domain model · 7 Operation layer and module map ·
8 Product surface · 9 First deliverable slice · 10 Challenges to existing decisions, and where
the seed lens was bent.

---

## 1. Thesis

Mainworthy is a test management system that keeps one true record of what was tested and what
was decided about it, and spends human attention only on the decisions. Its one structural
idea is that every write is exactly one of three things, **evidence, question or decision**,
and they have different writers. *Producers* (a person authoring or executing, a CI pipeline,
an agent) can only add **evidence**: proposals, results and findings, as immutable facts under
their own identity. Nobody writes **questions**: they are derived from evidence by
deterministic detectors and deduplicated by a fingerprint. And the project's *standing* (which
version of a case is current, which automated test belongs to which case, whether a failure is
explained, whether a test is quarantined, whether a gap is waived, whether a run is signed
off) changes only as the effect of a recorded **decision**: one answer from a closed set, by
an actor the project's policy allows, with a reason, a time and the hash of the evidence it
was made on. Manual QA, automated testing and agentic testing are therefore not three
features; they are three producers of the same evidence types through the same operations,
and they meet in exactly two places: **one evidence stream** keyed by *(test, target)*, where
a run is a request for evidence that any producer may satisfy, and **one decision queue**,
where strictness is a table saying who must answer each kind of question (a rule for the loose
team, a named human for the regulated one, the same rows for both). The queue is what a person
opens in the morning, the audit trail an auditor exports, and the ledger that tells an agent
"already decided, do not rediscover".

---

## 2. Why the incumbents are a poor use of money

The licence is the visible cost. The larger cost is that these tools are systems of *record
keeping* that create clerical work and do not remove a single decision: someone still decides
go or no-go in a meeting with a spreadsheet. Eight structural reasons, each with its evidence
label and the structure (not feature) that answers it.

| # | Why the money is badly spent | Evidence | Structural answer in this design |
| --- | --- | --- | --- |
| M1 | You pay per human seat for a system whose main writers are machines and whose main readers are not testers. | **Verified**: per-seat pricing is universal (finding 2); Xray and Zephyr price on *all Jira users on the site*; Qase sells a $10 collaborator seat, Testiny a ~20% viewer seat; ADO Basic users cannot manage plans. | The model has **no seat**. An actor (human, agent, CI, rule) is a free row. The only gradient is *authority*: which kinds of question an actor may answer (§6.5). There is nothing to count, so nothing to meter. |
| M2 | History and audit, the reason to have a system of record, are the top pricing tier. | **Verified** on five tools (finding 1): TestRail versioning, audit log and approvals only on Enterprise (~2x Professional); Xray versioning Enterprise-only and it stops on downgrade; Qase retention 30 days / 2 years / unlimited by plan. | History is **the storage model, not a feature**. Only append-only facts and decisions exist; "current" is a projection with exactly one writer (a decision's effect). There is no code path that saves without history, so there is nothing that could be gated. |
| M3 | Machine access is rationed. | **Verified**: API limits by tier, 60 to 1,000 req/min (finding 4). | Operations are shaped for machines: a 10,000-result report is **one call**; an agent's review starts from **one bounded `impact` read**. Self-hosted, so the limit is your hardware, and latency and token budgets are tested (P3). |
| M4 | You buy three things and join them by hand: a case tool for manual results, a CI dashboard or results tool for automated ones, and nowhere at all for what agents find. | *Hypothesis* from the landscape: TestRail is manual-centred, Allure TestOps is "automation-centred" (**Verified** wording); depth of competitors' MCP surfaces is **Open**. | **One evidence stream** keyed by *(test, target)*; the producer is an attribute. A run does not own results: it is a request for evidence, so a CI result, a tester's keypress and an agent's finding satisfy the same slot (§6.4). |
| M5 | The tool is write-only: it records, then asks again. The same failure is triaged on every run, "automated" is a checkbox someone must keep true, run status is typed by hand. | *Hypothesis* (practitioner experience to confirm, open question 18). **Reported**: slow at scale, traceability and reporting are manual chores. | **Decide once.** A decision carries forward to every later occurrence of the same fingerprint until its *basis* changes (§6.5). **Derive, don't maintain**: execution type, coverage, flakiness, staleness and gate status are computed, never typed. |
| M6 | Strict process is an edition. Approval workflows, audit and sign-off are bought, so a team either pays for strictness or goes without it. | **Verified**: TestRail approval workflows on Enterprise; PractiTest audit log in a separate "Control & Compliance" pack; SSO tiers almost everywhere. | **Policy is a table over one model**: kind of question x who must answer. The loose preset answers by rule and still records the decision; the regulated preset names a human. Same rows, same build. |
| M7 | Agent access is bolted on. | **Verified** only that MCP servers exist at four vendors (finding 5). *Hypothesis*, to test in the phase 0 audit: they wrap CRUD endpoints, so an agent lists and re-reads, and what it finds lands in a comment. | Questions carry a **bounded evidence digest**; findings are evidence with a fingerprint; `impact` and `since` replace scans; and an agent may *answer* a question where policy allows, or *advise* where it does not, with the same call. |
| M8 | You cannot leave and you cannot host it yourself without paying more. | **Verified** (finding 6): self-hosting is rare, on-prem starts at higher tiers (TestRail Professional, Testomat.io Enterprise, Testiny $300/user/year). | **The export is the log.** Import is replay. One artifact runs Local, Server and Cloud (decision 0002); no feature, limit or history window depends on layer or plan. |

What an organisation gets for the money instead, stated as a measure: **human decisions per
release, and seconds per decision**. Incumbents cannot report either number. Mainworthy reports
both, because the decision is a row.

---

## 3. Guiding principles

Nine principles, in tie-break order: when two conflict, the lower number wins. Each names what
it rules out.

**P1. The record is true.** Facts are append-only; standing changes only through a recorded
decision; nothing is rewritten, silently dropped or unattributed.
*Rules out:* in-place edits of history, last-write-wins, hard delete, an "admin fix" back door,
a quarantine or link that appears without a decision row, any writer of standing other than a
decision's effect. *Tie-break:* beats everything. Never bent.

**P2. Ask a human only what the system cannot derive, and ask it once.** Every prompt to a
person is a typed question with its evidence and a closed set of answers; an answer carries
forward until the evidence it stood on changes.
*Rules out:* notifications with no answer, dashboards as the place work is found, re-triage of
a known failure, free-form workflow states, per-item prompts where one cause explains many.
*Tie-break:* loses only to P1 (when it is unsure whether an old answer still holds, it asks
again). Beats feature breadth and configurability.

**P3. Fast is a budget, not an adjective.** Latency, tokens served and keystrokes per job have
numbers, and the check command fails when one is broken.
*Rules out:* a spinner on a keypress, fetch-everything-then-filter, unbounded responses,
"optimise later", a merged change that breaks a budget. *Tie-break:* beats P4 to P9; a feature
that cannot meet its hot-path budget is not shipped. Loses to P1 and P2: a budget is never met
by losing a fact or by asking the human again.

**P4. One stream, one operation layer.** Manual, CI and agent output are the same types
through the same operations; UI, REST, MCP, CLI and CI ingest are projections of one operation
registry.
*Rules out:* an "automation" module, agent-only tables, a manual-run type next to an automated
one, UI-only capability, a bulk or import path that skips policy, per-surface validation.
*Tie-break:* a missing surface is an allowed cut; a second path is never allowed.

**P5. Policy is data over one model.** A team's strictness is a list of clauses saying who
answers which kind of question; presets are lists.
*Rules out:* editions, modes, `if (regulated)` in code, a feature that exists only under one
preset, model fields added for one profile. *Tie-break:* beats P7: a default may be loose, but
the strict path must already work on the same data.

**P6. Derive, don't maintain.** Anything computable from facts and decisions is never a field
a person or a second module writes.
*Rules out:* an "is automated" checkbox, a hand-set run status, a coverage number that is
stored and edited, a flaky tag. *Tie-break against P3:* derive at read first; if the read
misses its budget, materialise it as a projection written in the same transaction by the one
module that owns the source facts, with a rebuild check. Never a cache with its own writer.

**P7. Zero configuration to first value.** One artifact, one command, one pipeline line; every
default is a policy clause you can read and change later.
*Rules out:* setup wizards, a required field schema, a plugin per CI vendor, required case-ID
annotations in test code, an account before the first case.

**P8. Portable by construction.** The export is the complete log; nothing is gated by plan,
layer or count.
*Rules out:* retention windows, rate tiers, cloud-only features, proprietary attachment
stores, an import that drops history.

**P9. A change that looks right from one file is right for the whole product.** Each concept
(operation, question kind, policy clause, parser) is declared once in one registry and
everything else is generated or exhaustively checked from it.
*Rules out:* hand-synced lists, importable internals, a second place to add a tool or a kind.
*Tie-break:* lowest rank, but it is the one that keeps the others true once agents write most
of the code.

### How this refines the product vision's ranking

The vision ranks *fast backend > agent access > UX*. That stays as the order of engineering
constraints (P3, then P4), with two changes:

- **A floor above speed.** P1 is rank zero. A fast tool with an untrustworthy record has no
  value to any profile, and "speed first" alone would permit trading it away.
- **UX is not third; it is what the first two are measured in.** The owner's ask is that the
  incumbents fail on DX/UX. So speed is defined by what it is for (P2: seconds per decision)
  and budgets include keystrokes and tokens, not only server milliseconds (P3). Agent access
  stops being a rank and becomes a consequence of P4.
- *Cost:* one more rule above the top priority, and "fast" now has three kinds of budget to
  maintain instead of one.

### Bending a principle for deliverability

1. **Cut before you corrode.** First ship less: fewer question kinds, formats, presets,
   screens. A missing thing is honest; the same thing done worse is not.
2. **Then relax a number.** A non-hot-path budget may be relaxed by at most 2x, with the new
   number written down. Hot paths are never relaxed: *decide, record a result, open a case,
   read a gate, accept an ingest*.
3. **Then defer a principle from P5 to P9**, by a decision record that names the principle,
   what ships instead, who is hurt, the test that now fails (kept in the check as an expected
   failure, so the bend stays visible in every run) and the condition that ends it.
4. **Never:** bend P1; create a second path (P4); let a bend outlive its condition.
5. **At most three bends open at once.** A fourth needs one closed first.

**The floor: what "a bad product" means.** If shipping would make any of these true, cut scope
until none is; if no cut works, do not ship.

- F1. It loses or rewrites a recorded fact or decision.
- F2. It asks a person a question it already holds a valid answer to.
- F3. A capability exists in one surface only (UI-only, or not reachable by an agent).
- F4. A hot path misses its budget (a wait after a keypress on decide, record or open).
- F5. First value needs an account, a configuration step or more than five minutes.
- F6. A team cannot leave with all of its data and history.
- F7. A strict team needs a different build, edition or data model than a loose one.
- F8. Answering "is this change tested?" requires looking in more than one place.

---

## 4. The DX/UX moves, made concrete

Each move is stated as what the predecessor did, what the successor changed, and the
commitments that can be checked in this product.

### 4.1 The Linear move (over GitHub Issues): home is a triage inbox with one-key answers

GitHub Issues gives you a list and a label system and leaves the workflow to you. Linear made
the workflow the product: a triage inbox, opinionated states, IDs on everything, a keyboard for
every action, and no waiting. The equivalent here: **you do not open Mainworthy to a folder tree
or a dashboard, you open it to the decisions waiting for you**, each answerable where it lies.

| Commitment | Check |
| --- | --- |
| L1. Every question is answerable from the list with one key, without opening it. | Browser test: for each of the seven kinds, focus a row, press the key, the row leaves; no navigation event, no dialog. |
| L2. Key to next paint <= 100 ms p95 with 50,000 open questions *(draft)*; the decision is applied optimistically and reconciled. | Instrumented browser test in the check command. |
| L3. Answer sets are closed and built in. There is no workflow designer and no custom status. | The answer union per kind is a type (§6.5); no admin screen edits it. |
| L4. Everything has a short ID and a URL (`C-311`, `Q-2291`, `R-41`, `T-1904`), and the command palette reaches any object or action in at most three keystrokes after typing. | Browser test over a fixed list of 20 targets. |
| L5. Undo works on everything, including a decision (ten-second toast, and later "re-decide", which supersedes and never erases). | Job test: decide, undo, the standing and the gate return to the prior value and both decisions are in the ledger. |
| L6. Zero modal dialogs and zero full page loads on jobs J1 to J8. | Counted by the job tests. |
| L7. Twenty mixed questions decided in <= 60 s, keyboard only *(draft)*. | Job D2 (§9). |

### 4.2 The CircleCI move (over Jenkins): one line in the pipeline, and the check tells the truth

Jenkins made you run a server, pick plugins and click configuration; a red build meant "read
the log". CircleCI put configuration in the repository, needed no plugin for test results, and
told you which tests failed and which were flaky. The equivalent here: **connecting CI is one
line, and the status it returns is a function of evidence and decisions, not of one exit
code.**

| Commitment | Check |
| --- | --- |
| C1. One added line, two environment variables, no plugin, no annotation in test code: `mainworthy report <files>`. Commit, branch, PR, build URL and attempt are read from the CI environment. | Fixture pipelines for three CI vendors pass with only that line. |
| C2. The gate has four verdicts with different meanings and exit codes: `passed` 0, `failed` 1 (needs a fix), `blocked` 2 (needs a decision), `pending` 3 (needs evidence). | Unit test of the pure verdict function; CLI test. |
| C3. A decision changes the check without re-running the pipeline: answering "infra" or "flaky" turns `blocked` into `passed` in seconds. | Job test: ingest a red report, decide, read the gate. |
| C4. A failure already failing on the base of the change never blocks the change. Re-running the same failing commit asks nothing new. | Jobs D1 and D3 (§9). |
| C5. One cause is one question: a report with 500 failures sharing a signature opens at most 3 questions *(draft)*. | Fixture test D1. |
| C6. Policy can live in the repository as a text file, applied by `mainworthy policy apply`, which is a proposal like any other edit. | Round trip: export policy, apply, no diff. |
| C7. Ingest of 10,000 results is accepted in < 2 s and its questions are in the queue in < 5 s *(draft, from the vision)*. | Benchmark in the check. |

### 4.3 The bun/deno move (over npm + tsc + jest + ...): one binary that runs what you already have

Bun and Deno replaced a toolchain you had to assemble with one fast executable that needs no
configuration and still runs your existing code. The equivalent here: **one artifact is the
server, the UI, the CLI and the MCP server, and it accepts what teams already produce.**

| Commitment | Check |
| --- | --- |
| B1. `mainworthy` with no arguments starts Local, creates a project, signs you in as the machine user and opens the UI. First case within 60 s of the binary being on disk, within 5 min of download (J15) *(draft)*. | Scripted install test on a clean machine image. |
| B2. The same executable is the CLI (`mainworthy report`), the MCP server (`mainworthy mcp` on stdio, `/mcp` over HTTP) and the server. Nothing else to install. | Artifact test. |
| B3. Drop-in inputs: JUnit XML as produced by existing runners; a pasted list or a Markdown file becomes a case; importers keep foreign IDs as aliases so `C1234` from TestRail still resolves. | Parser fixtures; alias lookup test. |
| B4. Text out as well as in: every case, question and run renders to Markdown (`mainworthy get C-311 --md`) and back. | Round-trip test. |
| B5. It replaces a stack, not one tool: case management, results history, flaky handling, release gate and agent surface in one process with no required companion service. A cache is never needed for correctness (decision 0002). | Local-layer job suite runs with no other process. |
| B6. The whole agent surface is at most 10 tools and <= 1,500 tokens of definitions *(draft)*; the shipped skill's main file is <= 400 tokens with references read on demand. | Token count in the check (decision 0006). |

---

## 5. Usage first

These are the specification. The types in §6 are derived from them.

### 5.1 Quickstart, as the user reads it

````markdown
# Mainworthy

One place where manual, automated and agent testing land, and one queue of the
decisions they leave for you.

## Start (no account, no configuration)

    $ mainworthy
    Mainworthy 0.1 · local · data in ~/.mainworthy · http://127.0.0.1:7357
    project "scratch" · you are robin@this-machine · policy: loose

## Write a case

Press `c`. Type a title, Enter, then steps as an outline. `>` starts the
expected result. Paste a list and it is split for you. There is no save button.

    Checkout applies a percentage coupon
      Open the cart with one $100.00 item
      Apply coupon SAVE10            > Total shows $90.00
      Reload the page                > Coupon is still applied

It is `C-1`, version 1.

## Send test results (any runner that writes JUnit XML)

    $ mainworthy report results/*.xml
    4,812 results for scratch @ 9f3c2ab (main)  ·  4,790 pass  19 fail  3 skip
      16 failures already decided   not blocking
       3 failures are new           Q-12  "expected 90.00, got 100.00"  (3 tests)
    gate: blocked by 1 open question   http://127.0.0.1:7357/q/12

In CI it is the same line. Add `mainworthy gate` to fail the job on the verdict.

## Decide

Open the queue (`g q`). Each row is a question with its evidence and its
answers on single keys. `d` it is a defect, `f` it is flaky, `i` it was
infrastructure. Your answer is recorded with your name and applies to every
later occurrence until the evidence changes.

## Run things by hand

`g r`, `n`, pick cases by folder, tag or search, Enter. Then `p` pass, `f`
fail, `b` blocked, `s` skip. Results from CI and from agents for the same
build fill the same run.

## Let an agent in

    $ mainworthy token new --agent reviewer --can read,produce
    $ mainworthy mcp            # stdio; or point the client at /mcp

Ten tools. Start with `impact`.

## Get stricter when you need to

    $ mainworthy policy use standard      # agent edits need a person; who may excuse a failure
    $ mainworthy policy show              # the whole policy is one table

## Leave whenever you like

    $ mainworthy export --out acme.mainworthy      # every fact, decision and attachment
````

### 5.2 Call site (a): a CI pipeline step reporting automated results

```yaml
# .github/workflows/test.yml  (any CI works; this is the only Mainworthy-specific part)
env:
  MAINWORTHY_URL: ${{ vars.MAINWORTHY_URL }}
  MAINWORTHY_TOKEN: ${{ secrets.MAINWORTHY_TOKEN }}   # actor kind "ci", capability "produce" on one project
steps:
  - run: npx playwright test --reporter=junit      # exits non-zero on failure; that is fine
    continue-on-error: true
  - run: mainworthy report test-results/*.xml        # commit, branch, PR, build URL, attempt: from the CI env
  - run: mainworthy gate --wait 120                  # exit 0 passed · 1 failed · 2 blocked · 3 pending
```

What the developer sees in the job log:

```
mainworthy report  acme/web @ 9f3c2ab  pr #482  attempt 2  job e2e
  4,812 results   4,790 pass   19 fail   3 skip                         (R-507)
  11 excused   failing on base 41d07e1 (main)                           not this change
   5 excused   Q-2104 flaky, decided by mira 6 days ago, holds 8 more   not this change
   3 new       Q-2291 "expected 90.00, got 100.00" in coupon.ts:41      3 tests, C-311 C-314 C-318
   7 tests have no case (tracked)
mainworthy gate    blocked: 1 question needs an answer    https://mainworthy.acme.example/acme/web/pr/482
exit 2
```

Sending the same files again prints the same receipt and writes nothing. The retry of the job
(attempt 3) is a new batch on the same commit; a test that fails in attempt 2 and passes in
attempt 3 is recorded as a same-code contradiction against that test.

The three operations behind it (§7):

```ts
report({ target: { commit, branch, pr, build, env: 'ci' }, job: 'e2e', attempt: 2, file })
gate({ commit: '9f3c2ab' })     // one keyed read
// and when the developer presses `d` in the queue:
decide({ q: 'Q-2291', answer: { is: 'defect' }, reason: 'coupon applied before tax' })
// gate becomes `failed` (needs a fix), no pipeline re-run. With { is: 'infra' } it becomes `passed`.
```

### 5.3 Call site (b): an agent through MCP doing adversarial review of a PR

The agent's token: actor kind `agent`, name `reviewer`, capabilities `read, produce`. Under the
`standard` preset it may produce findings and proposals and may advise on questions; it may not
settle them.

```jsonc
// 1. Where to look. One bounded read; counts first; nothing the change does not touch.
→ impact({ change: "pr:482" })
← { "change": { "pr": 482, "head": "9f3c2ab", "base": "41d07e1", "files": 5, "requirements": ["WEB-290"] },
    "counts": { "cases": 9, "unreviewed": 3, "changed": 1, "failing": 3, "flaky": 1, "uncovered_paths": 1 },
    "cases": [
      { "id": "C-311", "title": "Checkout applies a percentage coupon", "hash": "a91f",
        "why": ["req:WEB-290", "test:checkout.spec.ts"], "last": "fail@9f3c2ab", "open": ["Q-2291"] },
      { "id": "C-314", "hash": "0c2e", "why": ["req:WEB-290"], "last": "fail@9f3c2ab", "open": ["Q-2291"] },
      { "id": "C-318", "hash": "77b1", "why": ["area:src/checkout/**"], "last": "pass@41d07e1" }
      // 6 more, each: "reviewed": "by reviewer at this hash, 2 findings settled"  -> skip
    ],
    "uncovered": [{ "path": "src/checkout/tax.ts", "why": "no area, no test file, no requirement" }],
    "decided": [{ "q": "Q-1808", "on": "C-312#s3", "category": "cannot-fail", "answer": "reject",
                  "reason": "asserted by C-340", "holds": true }],
    "cursor": "s:88213" }

// 2. Read only the three unreviewed cases, only the fields needed, as text.
→ get({ refs: ["C-311", "C-314", "C-318"], fields: ["pre", "steps"], as: "md" })
← "C-311 a91f\n1. Open the cart with one $100.00 item\n2. Apply coupon SAVE10 > Total updates\n..."

// 3. Record the review and what it found, in one call.
→ claim({ lens: "adversarial-review", about: "pr:482",
          reviewed: ["C-311@a91f", "C-314@0c2e", "C-318@77b1"],
          findings: [
            { on: "C-311#s2", category: "cannot-fail",
              note: "'Total updates' is true for any change, including the wrong one.",
              suggest: { expected: "Total shows $90.00 (10% off $100.00)" } },
            { on: "req:WEB-290", category: "uncovered-path",
              note: "coupon.ts:41 adds an expiry branch; no case applies an expired coupon.",
              suggest: { case: { title: "Expired coupon is rejected", folder: "checkout",
                                 steps: ["Apply coupon OLD10 (expired) > Error 'Coupon expired'; total unchanged"] } } },
            { on: "C-312#s3", category: "cannot-fail", note: "No assertion on the stored order total." } ] })
← { "opened": ["Q-2301", "Q-2302"],
    "known":  [{ "q": "Q-1808", "answer": "reject", "reason": "asserted by C-340", "by": "mira" }],
    "reviewed": 3 }

// 4. It also has a view on the failure. Policy lets it advise, not settle.
→ decide({ q: "Q-2291", answer: { is: "defect" },
           reason: "All three assert the discounted total; diff moves the discount after tax." })
← { "status": "advised", "needs": "one member who is not an agent" }
```

The re-review after the author pushes a fix (job A5) is one call, and returns only what moved:

```jsonc
→ impact({ change: "pr:482", since: "s:88213" })
← { "counts": { "cases": 1, "unreviewed": 1 },
    "cases": [{ "id": "C-311", "hash": "d402", "changed": ["s2.expected"], "last": "pass@b77e510" }],
    "settled": [{ "q": "Q-2301", "answer": "accept", "by": "mira" }, { "q": "Q-2291", "answer": "defect", "by": "sam" }],
    "cursor": "s:88390" }
```

Asking for fresh eyes is explicit and pays the full cost on purpose: `impact({ change, ledger: false })`.

### 5.4 Call site (c): an author capturing cases and a person executing a manual run

**The author.** No form, no mode, no save.

```
g s            suite outline, cursor where it was
c              new case under the cursor; caret is in the title on the same frame
Expired coupon is rejected ⏎
Apply coupon OLD10 (expired) > Error "Coupon expired"; total unchanged ⏎
⌘V             pastes six lines from the spec; six steps appear, " > " / "Expected:" / "=>" split off the expected result
#checkout      tag, inline
@WEB-290       links the requirement, inline
⌘⏎             (or just move away)
```

Every pause autosaves into the author's *open proposal* (theirs alone, visible to others as
"draft by Dana"). Leaving the case, `⌘⏎`, or 30 s of idle *seals* it:

```ts
propose({ id: 'p_7f3a…',                      // client-generated; resending is harmless
          changes: [{ op: 'create', case: 'c_91…', body: { title, steps },
                      place: { folder: 'checkout', tags: ['checkout'] }, covers: ['WEB-290'] }],
          seal: true })
// loose:     → { status: 'adopted', case: 'C-331', version: 1 }                 a rule answered; the decision is recorded
// regulated: → { status: 'open', question: 'Q-2310', needs: 'role approver, not the author' }
```

The same call from an agent in the `standard` preset returns `open`, and a person sees
`Q-2310 adopt` in the queue with the diff; `a` accepts, `x` rejects with a reason.

**The lead** plans a run in one line and one call:

```
g r  n   "1.4.0 rc3 regression"   folder:checkout tag:regression   on build 1.4.0-rc3 @ staging   assign dana, sam   ⏎
```
```ts
plan({ name: '1.4.0 rc3 regression',
       select: { folders: ['checkout'], tags: ['regression'] },      // pinned to current versions now
       accepts: { build: '1.4.0-rc3', env: 'staging' },              // which results count
       assign: { split: 'even', to: ['dana', 'sam'] } })
// → { run: 'R-41', slots: 214, already: 171 }
// 171 slots are already satisfied: CI reported those cases on that build. Nobody runs them by hand.
```

**The executor** opens the run and lands on their first unfilled slot.

```
g r ⏎          R-41 · 43 left for people · 22 mine           (171 filled by CI, 2 by agent "explorer")
p              pass; next case is already rendered
p
2 f            step 2 failed; caret in the note
Total shows $100.00 after SAVE10 ⌘V(screenshot) ⏎
               → Q-2315 failure opened; hint: "same signature as Q-2291 (defect, sam)".  ⏎ accepts the hint
b blocked env down ⏎
…              22 keypress groups later: "R-41: your part is done"
```

Each key is the same operation CI used:

```ts
report({ run: 'R-41',                          // target comes from the run
         results: [{ case: 'C-311', outcome: 'fail',
                     steps: [{ step: 's2', outcome: 'fail' }],
                     note: 'Total shows $100.00 after SAVE10', attachments: ['blob_5c…'] }] })
// → { results: 1, opened: ['Q-2315'], hints: [{ q: 'Q-2315', like: 'Q-2291', answer: 'defect' }] }
```

**The lead** signs off from the queue: `Q-2330 signoff R-41 · 212/214 pass · 2 waived (Q-2318,
Q-2319) · evidence from 2 people, 1 pipeline, 1 agent`. Under `loose` a rule closed the run the
moment its verdict became `passed`; under `regulated` an approver presses `a`, types a reason,
and the run and its pinned versions freeze.

### 5.5 What the usage requires of the types

1. One `report` shape for a 10,000-result file and a single keypress; the producer is the
   token's actor, never a parameter.
2. Results attach to *what was tested* (a target), not to a run; a run is a predicate over
   targets, so CI results fill a manual run.
3. A question exists once per cause, not once per result, and remembers its answer.
4. `decide` has one signature at every strictness; the return says whether the caller settled
   it, advised, or still needs someone.
5. Saving a case and proposing a change are the same call; policy decides what happens next.
6. Every read an agent makes is bounded, carries hashes and a cursor, and can be told what the
   caller already has.

---

## 6. Domain model (data structures first)

Notation: `Brand<T>` is an opaque type; `// KEY` lines name the ordered or unique keys a
collection must support, because they are part of the structure, not a tuning step;
`// WRITER` names the only code allowed to write a field.

### 6.1 Kernel: identity, clock, command

```ts
type Seq  = Brand<bigint>   // per-project logical clock. Assigned at commit, in commit order:
                            // a reader never sees n+1 before n is visible. Every fact carries one.
type Hash = Brand<string>   // content hash, stable across export and import
type Ref  = string          // short per-project id: C-311 case, T-1904 test, Q-2291 question,
                            // R-41 run, P-880 proposal, REQ-17 requirement; change keys "pr:482", "commit:9f3c2ab"

type Actor = {
  id: ActorId
  kind: 'human' | 'agent' | 'ci' | 'rule'   // 'rule' is the policy itself answering
  name: string
  onBehalfOf: ActorId | null                // an agent started by a person
}
type Grant = { actor: ActorId; project: ProjectId | '*'; can: Capability[]; roles: RoleId[] }
type Capability = 'read' | 'produce' | 'answer' | 'plan' | 'admin'
// 'produce' = propose, report, claim, and advise on a question (advice is evidence).
// 'answer'  = may be counted on questions, subject to policy.
// There is no seat, licence or user-count field anywhere.

type Stamp = { by: ActorId; at: Instant; seq: Seq; cmd: CommandId }   // on every fact

type Command = {              // one row per write operation invoked: the journal
  id: CommandId               // client-generated → idempotency key
  project: ProjectId; op: OpName; actor: ActorId; at: Instant
  seq: Seq                    // the single Seq every fact written by this command carries
  touched: Ref[]              // bounded (<= 64, then a count): what to tell subscribers
  outcome: Hash               // digest of the reply, so a replay returns the same answer
}
// KEY (id) unique                → retry or replay returns the stored outcome, writes nothing
// KEY (project, seq)             → audit order, change push, export order
```

One Seq per command means a 10,000-result batch, a 1,000-case bulk edit and one keypress are
each one tick of the clock and one journal row. The commit-order rule is a stack criterion
(§10): it is what makes "changed since" a plain range read with no missed rows.

### 6.2 Suite: what should be true

```ts
type Case = {
  id: CaseId; ref: Ref; project: ProjectId
  kind: 'case' | 'fragment'          // a fragment is a shared-steps block; same versioning
  // WRITER for the next five: the effect of an 'adopt' decision, nothing else
  head: VersionNo
  headHash: Hash                     // = hash of the resolved body (fragments expanded)
  title: string                      // copy of head.body.title, so a list page needs no body
  place: Placement
  state: 'active' | 'archived'
  intent: { automate: 'none' | 'wanted' | 'not-applicable' }   // declared wish; never "is automated"
  aliases: string[]                  // foreign ids from an import: "C1234"
  rev: Seq                           // Seq of the last adopted change to this row
}
// KEY (project, ref) unique
// KEY (project, folder, rank)       → list a folder page
// KEY (project, rev)                → changed-since
// KEY (project, alias) unique

type Placement = { folder: FolderId; rank: Rank; tags: TagId[] }   // organisation, not content
type Folder    = { id: FolderId; parent: FolderId | null; name: string; rank: Rank; rev: Seq }

type Version = {                     // immutable; exists only once adopted
  case: CaseId; no: VersionNo        // 1, 2, 3 … with no holes
  parent: VersionNo | null
  body: CaseBody; hash: Hash
  proposal: ProposalId               // who wrote it and why
  decision: DecisionId               // who let it become current
  seq: Seq
}
// KEY (case, no)                    → head read, diff, versionAt(seq) by a short backwards walk

type CaseBody = {
  title: string
  pre: Text
  steps: Step[]
  fields: Record<FieldId, FieldValue>
}
type Step =
  | { id: StepId; action: Text; expected: Text | null; hash: Hash }   // StepId survives edits and reorders
  | { id: StepId; use: CaseId }                                       // a fragment, followed at its head
type Uses = { fragment: CaseId; case: CaseId }
// KEY both ways                     → "what uses this fragment" (J12); adopting a fragment version
//                                     bumps headHash and rev of its users in the same transaction

type Proposal = {                    // evidence of intent to change the suite. 1..n changes, all or nothing
  id: ProposalId; ref: Ref; project: ProjectId
  author: ActorId; reason: string | null
  state: 'open' | 'sealed'           // open = the author's autosaved draft, amendable only by the author
  changes: Change[]
  stamp: Stamp                       // of the seal
}
type Change =
  | { op: 'create';  case: CaseId; body: CaseBody; place: Placement; covers: RequirementId[] }
  | { op: 'edit';    case: CaseId; base: VersionNo; body: CaseBody }
  | { op: 'place';   case: CaseId; from: Placement; to: Placement }       // move, retag, reorder
  | { op: 'state';   case: CaseId; to: 'active' | 'archived' }
  | { op: 'restore'; case: CaseId; to: VersionNo }                        // becomes a new version
  | { op: 'cover';   requirement: RequirementId; case: CaseId; on: boolean }
  | { op: 'area';    glob: PathGlob; folder: FolderId; on: boolean }      // code path → suite area
  | { op: 'folder';  folder: FolderId; to: Partial<Folder> | null }
  | { op: 'policy';  body: Clause[] }                                     // policy changes are proposals too
// KEY (project, author, state='open', case) → the author's draft overlay when they open a case

type Requirement = {                 // a thing that needs evidence. Local row, optionally mirroring a tracker
  id: RequirementId; ref: Ref; project: ProjectId; title: string
  source: ExternalRef | null         // { system: 'jira' | 'github' | …, key: 'WEB-290', url }
  state: 'open' | 'done' | 'dropped'; rev: Seq
}
type Covers = { requirement: RequirementId; case: CaseId; decision: DecisionId }   // KEY both ways
type Area   = { glob: PathGlob; folder: FolderId; decision: DecisionId }           // small; matched in memory

// Search: one document per case, replaced by the adopt effect in the same transaction.
type SearchDoc = { case: CaseId; project: ProjectId; text: string /* title, pre, steps, expected, tags, aliases */ }
// KEY full-text with prefix and typo tolerance over (project, text). The engine is a stack decision;
// that it is written by the adopt effect and by nothing else is not.
```

Invariants carried by the shape:

- `Case.head` cannot move without a `Decision` (the `Version` row requires its id).
- A version number exists only for adopted content, so "version 8" never names something that
  was rejected; rejected proposals stay as proposals.
- A move or retag is a `place` change, not a new version, so it does not invalidate a review,
  a pinned run or an agent's hash of the content.
- A bulk edit of 1,000 cases is one proposal, one question, one decision, one Seq, and its
  inverse is computable from the row (`from`/`base`), which is what undo proposes.

### 6.3 Evidence: what was observed

```ts
type Test = {                        // the unit that can pass or fail; the identity of evidence
  id: TestId; ref: Ref; project: ProjectId
  kind: 'manual' | 'auto'
  key: string                        // auto: normalised "file::suite::name[params]"; manual: "case:<CaseId>"
  case: CaseId | null                // WRITER: effect of a 'map' decision (manual: fixed when the case is created)
  file: string | null; job: string | null
}
// KEY (project, key) unique         → resolve 10k reported names in one batched lookup; first sight creates the row
// KEY (project, case)               → tests of a case
// KEY (project, file)               → impact: changed test file → tests → cases

type Target = {                      // what software was under test
  id: TargetId; project: ProjectId
  commit: Sha | null; branch: string | null; line: LineId
  pr: number | null; build: string | null; env: string
  change: ChangeId | null
}
// KEY (project, commit, env, build) unique
type Line   = { id: LineId; name: string; class: 'trunk' | 'release' | 'change' }   // main · release/1.4 · pr/482
type Change = {                      // a PR or a pushed commit range
  id: ChangeId; project: ProjectId; key: string   // "pr:482" | "commit:9f3c2ab"
  base: Sha; head: Sha; files: Path[]; refs: ExternalRef[]; rev: Seq
}
type Deploy = { target: TargetId; env: string; stamp: Stamp }          // "this build reached that environment"

type Batch = {                       // one report() call; the unit of idempotency
  id: BatchId; project: ProjectId
  key: Hash                          // H(target key, job, attempt, payload digest)
  target: TargetId; job: string | null; attempt: number
  state: 'accepted' | 'processed'
  counts: Counts; raw: BlobRef | null; stamp: Stamp
}
// KEY (project, key) unique         → the same report twice is a no-op with the same receipt

type Result = {                      // immutable; never updated, never deleted
  project: ProjectId; test: TestId; seq: Seq; ord: number
  batch: BatchId; target: TargetId
  case: { id: CaseId; version: VersionNo } | null    // stamped at write: what it was evidence for, then
  outcome: 'pass' | 'fail' | 'skip' | 'blocked' | 'error'   // error: never reached an assertion
  attempt: number; durationMs: number | null
  failure: { signature: SignatureId; message: Text; at: StepId | string | null } | null
  steps: { step: StepId; outcome: Outcome }[] | null         // manual, optional
  note: Text | null; attachments: BlobRef[]
  run: RunId | null                  // the run it was typed into; a convenience, not ownership
}
// KEY (project, test, seq desc)     → "last N results for this test"
// KEY (project, batch, outcome)     → a report's page; its failures first
// The producer and its kind (person, CI, agent) are batch.stamp.by; there is no "type" column to drift.

type Signature = {                   // a failure cause, as far as the report lets us tell
  id: SignatureId; project: ProjectId
  hash: Hash                         // H(class, normalised message, first frame outside the test file,
                                     //   or the test key when there is no such frame)
  class: 'assertion' | 'infra' | 'timeout'
  sample: Text                       // one bounded excerpt; full logs stay in the blob, read by range
}
// KEY (project, hash) unique

type TestSignals = {                 // derived; one row per test; WRITER: evidence fold during ingest
  test: TestId
  trunk: { last: Outcome; lastSeq: Seq; transitions: Ring<{ batchNo: number; commit: Sha; to: Outcome }, 16> }
  flips: Ring<{ commit: Sha; batch: BatchId }, 16>     // same code, different outcome, on any line
  lastFail: { commit: Sha; seq: Seq; signature: SignatureId } | null
  flaky: { state: 'stable' | 'suspected' | 'flaky'; score: number; since: Seq }   // = classify(signals, thresholds), pure
}
// Stores *transitions*, not outcomes: a stable test that passes writes nothing here. The window
// is measured in the project's trunk batch counter, so the score needs no per-test history scan.

type Finding = {                     // a producer's claim about the suite or the software
  id: FindingId; project: ProjectId; stamp: Stamp
  lens: string                       // "adversarial-review", "exploratory", "adversarial-test"
  on: Locus                          // { case, step? } | { requirement } | { change } | { target }
  category: 'cannot-fail' | 'missing-expected' | 'ambiguous-step' | 'duplicate'
          | 'uncovered-path' | 'outdated' | 'defect'
  note: Text; repro: Text | null
  suggest: Change | null             // accepted → becomes a sealed proposal authored by the finder
  basis: Hash                        // hash of the step, case or diff it was made on
}
type Review = { reviewer: ActorId; lens: string; case: CaseId; hash: Hash; seq: Seq }
// KEY (case, hash, lens)            → "already reviewed at this content, by whom"
```

Three things the incumbents model as fields are derived here (P6):

- **Manual / automated / both** is not a field. It is "does this case have an auto test that
  reports" plus "was it executed by a person recently". What a person may *declare* is the wish
  (`intent.automate`), which is what the automation backlog ranks.
- **Unlinked** is not an inbox table. It is `Test.case === null`. Such a test still has
  history, flakiness and a place in the gate; an automation-heavy team may never map it.
- **Stale** is derived per reporting job by comparing the set of tests in this trunk batch with
  the last one (`JobManifest { job, line, batchNo, tests: sorted TestId[] }`, one row per job)
  and keeping `Missing { test, sinceBatchNo }` only for the absentees. Cost is proportional to
  what changed, not to the size of the report.

### 6.4 Runs: a request for evidence

```ts
type Run = {
  id: RunId; ref: Ref; project: ProjectId; name: string
  origin: 'change' | 'planned'       // change: opened by the first report for a commit. planned: by plan()
  accepts: TargetMatch               // which results count toward it
  rule: GateRule                     // { required: 'slots' | 'reported'; minPass?: number }
  state: 'open' | 'closed'; frozen: boolean
  signoff: DecisionId | null         // WRITER: effect of a 'signoff' decision
  // WRITER for the rest: runs.fold, called on ingest and on question events
  tally: { pass: number; excused: number; attributed: number; unexplained: number; missing: number; waived: number }
  blocking: { ids: QuestionId[] /* <= 32 */; count: number }
  verdict: 'passed' | 'pending' | 'blocked' | 'failed'     // = verdict(tally, blocking), pure
  stamp: Stamp; rev: Seq
}
type TargetMatch =
  | { commit: Sha }                  // a change run
  | { build: string; env?: string }
  | { line: LineId; env: string; from: Seq }
  | { self: true }                   // no build declared: only results typed into this run
// KEY (project, commit) unique where origin='change'   → the gate read by CI is one lookup
// KEY (project, state='open')                          → the handful of runs an ingest must consider

type Slot = {                        // a pinned requirement for evidence; exists for planned runs,
  run: RunId; case: CaseId           // and for the required manual cases of a change run
  version: VersionNo                 // pinned when the run starts
  assignee: ActorId | null; rank: Rank
  best: { outcome: Outcome; test: TestId; seq: Seq; by: 'human' | 'ci' | 'agent' } | null   // WRITER: runs.fold
  waiver: DecisionId | null          // WRITER: effect of a 'gap' decision
}
// KEY (run, rank)                   → the run page
// KEY (run, assignee, best=null, rank)  → "my next slot", one read
// KEY (case, run)                   → ingest: which open runs want this case
```

A result counts for a slot when `result.case` is the slot's case at the pinned version and
`matches(run.accepts, result.target)`. Membership is by match, not by ownership, so:

- the nightly pipeline on build `1.4.0-rc3` fills 171 of the 214 slots of the release run
  before any tester opens it;
- a tester's quick smoke run on the same build fills the release run's slots for those cases;
- an agent's adversarial session on that build does the same;
- the PR check, a manual regression and a release sign-off are the same object with a
  different `origin` and `rule`. There is no "plan" object: a plan is a saved `Selection`.

Each failing result in a run is exactly one of: **excused** (a holding decision says it is not
this target's fault: flaky, infrastructure, or already failing on the base of the change),
**attributed** (a decision says it is: defect, broken test, behaviour changed on purpose) or
**unexplained** (its question is open).

```ts
function verdict(t: Run['tally'], blocking: number): Run['verdict'] {
  if (t.attributed > 0)                  return 'failed'    // needs a fix
  if (t.unexplained > 0 || blocking > 0) return 'blocked'   // needs a decision
  if (t.missing > 0)                     return 'pending'   // needs evidence
  return 'passed'
}
```

### 6.5 Decisions: the queue, the ledger and the policy

```ts
type Kind = 'adopt' | 'map' | 'failure' | 'flaky' | 'gap' | 'finding' | 'signoff'

// Per kind: what it is about, what it shows, what may be answered. One table, exhaustive.
type KindTable = {
  adopt:   { subject: { proposal: ProposalId }
             answer:  { is: 'accept' } | { is: 'reject' } | { is: 'merge'; body: CaseBody } }
  map:     { subject: { file: string } | { test: TestId; stale: true }
             answer:  { is: 'link'; pairs: [TestId, CaseId][] } | { is: 'create'; folder: FolderId }
                    | { is: 'track' } | { is: 'ignore'; pattern: string } | { is: 'unlink' } }
  failure: { subject: { signature: SignatureId; scope: LineId | ChangeId | RunId }
             answer:  { is: 'defect'; ref?: ExternalRef } | { is: 'test' } | { is: 'expected' }   // attributed
                    | { is: 'flaky' } | { is: 'infra' } }                                          // excused
  flaky:   { subject: { test: TestId; edge: 'enter' | 'exit' }
             answer:  { is: 'quarantine'; exit: { cleanRuns: number } | { until: Instant } }
                    | { is: 'keep' } | { is: 'release' } }
  gap:     { subject: { run: RunId; requirement: RequirementId } | { run: RunId; case: CaseId }
             answer:  { is: 'waive'; until: Instant | null } | { is: 'descope' } | { is: 'request'; assign: ActorId } }
  finding: { subject: { on: Locus; category: Finding['category'] }
             answer:  { is: 'accept'; apply: boolean } | { is: 'reject' } | { is: 'duplicate'; of: QuestionId } | { is: 'defer' } }
  signoff: { subject: { run: RunId; stage: 'start' | 'close' }
             answer:  { is: 'approve' } | { is: 'reject' } }
}

type Question<K extends Kind = Kind> = {
  id: QuestionId; ref: Ref; project: ProjectId; kind: K
  subject: KindTable[K]['subject']
  fingerprint: Hash                  // H(kind, subject): "the same question"
  epoch: number; prior: QuestionId | null     // asked again after an answer stopped holding
  evidence: Digest<K>                // bounded: counts, <= 10 refs, one excerpt, hashes. Never raw logs
  seen: { count: number; first: Seq; last: Seq; carried: number }
  ask: Ask                           // who must answer: resolved from policy when opened, re-resolved on each answer
  blocks: RunId[]                    // bounded; the runs whose verdict waits on this
  owner: ActorId | RoleId | null     // routing: whose queue it shows in first
  answers: Given<K>[]                // <= 16: everything said so far, including advice
  state: { s: 'open' } | { s: 'decided'; decision: DecisionId } | { s: 'dissolved'; why: string; seq: Seq }
  snooze: { until: Instant; by: ActorId } | null
  rev: Seq
}
// KEY (project, fingerprint, epoch desc)        → raise(): one lookup decides open / attach / carry / re-ask
// KEY (project, state='open', owner, rank)      → the queue; an index-only count gives "counts first"
// KEY (subject ref)                             → questions on a case, run, test or change page
// KEY (project, rev)                            → "what was decided since"

type Given<K> = { by: ActorId; answer: KindTable[K]['answer']; reason: string | null; at: Instant
                  counts: boolean }  // false = advice: shown, never tallied

type Ask = {
  who: 'rule' | 'member' | 'role'
  role: RoleId | null
  quorum: 1 | 2
  notProducer: boolean               // four eyes: the author of the evidence may not settle it
  agents: 'answer' | 'advise' | 'none'
  reason: 'optional' | 'required'
  clause: ClauseId; policy: PolicyVersion
}

type Decision<K extends Kind = Kind> = {       // immutable; the ledger row
  id: DecisionId; project: ProjectId; question: QuestionId; kind: K
  answer: KindTable[K]['answer']
  signers: { by: ActorId; at: Instant; reason: string | null; clause: ClauseId; policy: PolicyVersion }[]
  basis: Hash                        // the evidence it was made on
  holds: Hold                        // when it stops applying to new occurrences
  supersedes: DecisionId | null      // re-deciding never edits
  stamp: Stamp
}
type Hold =
  | { until: 'basis-changes' }       // finding on a step, adopt, map
  | { until: 'this-target' }         // infra: says nothing about the next run
  | { until: Instant }               // flaky window, waiver expiry
  | { until: 'clean'; runs: number } // defect or broken test: reappearing after N clean runs is a regression
  | { until: 'closed'; ref: ExternalRef }   // while the linked defect is open (needs the tracker port)

// Standing: the only mutable judgment state. Each has one writer, a decision's effect.
//   Case.head, Case.place, Case.state, Covers, Area, Policy   ← adopt
//   Test.case                                                 ← map
//   Excuse     { signature, scope, test?, decision, hold }    ← failure   KEY (project, signature, scope)
//   Quarantine { test, decision, exit }                       ← flaky     KEY (project, test)
//   Slot.waiver                                               ← gap
//   Run.signoff, Run.state, Run.frozen                        ← signoff
//   (a finding's disposition is its question's state; 'accept' with apply chains into adopt)

type Policy = { project: ProjectId; version: PolicyVersion; clauses: Clause[]; decision: DecisionId }
type Clause = {
  id: ClauseId; kind: Kind
  when: Predicate                    // closed vocabulary per kind: producer.kind, scope.class, answer.is,
                                     // category, changes.count, touches ('content'|'placement'|'policy')
  ask: Omit<Ask, 'clause' | 'policy'> & { answer?: unknown }   // who = 'rule' carries the answer the rule gives
  blocks: 'nothing' | 'change' | 'release' | 'all'
  escalate: { after: Duration; to: RoleId } | null
}
// First matching clause wins; every preset ends with a catch-all per kind, so resolution is total.
```

**What a question carries, and why each part is there.** This is the seed's central
requirement: one item type that serves the team that auto-resolves nearly everything and the
team that needs a named human on each.

| Field | Loose team | Regulated team |
| --- | --- | --- |
| `subject` + `fingerprint` | groups 500 failures into one item | the same; also the unit an auditor follows |
| `evidence` digest + `basis` hash | what the person sees in one row | proof of *what was shown* to the signer |
| closed `answer` union | one key | no free-text outcome to interpret later |
| `ask` (from the matching clause) | `who: 'rule'`: settled as it opens, still recorded | `who: 'role'`, `notProducer`, `quorum: 2`, `reason: 'required'` |
| `answers` with `counts` | an agent's advice is one Enter away | advice is visible but never tallied |
| `Decision.signers` with clause and policy version | "a rule did it, here is the rule" | named identity, time, reason, and the rule that authorised them |
| `holds` | long windows, so few repeat questions | short or basis-only, so nothing is excused by inertia |
| `blocks` | change runs only | change and release runs |

Moving between profiles changes clauses, never data. A loose team that turns strict keeps
every earlier decision, each marked with the clause that settled it.

**The presets are three lists of clauses** (abridged; "rule: x" means the policy answers x).

| Kind (condition) | loose | standard | regulated | blocks |
| --- | --- | --- | --- | --- |
| adopt (human author) | rule: accept | rule: accept | role approver, not author, reason | nothing |
| adopt (agent author) | rule: accept | member | role approver | nothing |
| adopt (stale base, same field) | author | author | author, then approver | nothing |
| adopt (policy) | admin | admin | 2 approvers, reason | nothing |
| map (unlinked) | rule: track | member; agents answer | member; agents advise | nothing |
| failure (on a change) | member; agents advise | member; `flaky`/`infra` not by the change author | role, reason | change |
| failure (trunk, release, planned run) | member | member | role, reason | release |
| flaky (enter) | rule: quarantine, exit after 20 clean | member | role lead, reason, `until` required | nothing |
| flaky (exit) | rule: release | rule: release | role lead | nothing |
| gap | not raised | role lead | role approver, reason, expiry | release |
| finding (category defect) | member | member | role | release (regulated) |
| finding (other) | member; agents answer `duplicate` | member | role | nothing |
| signoff (start) | rule: approve | rule: approve | role approver | release |
| signoff (close) | rule: approve when passed | role lead | 2 approvers, reason; freeze | release |

The five policy switches of decision 0003 are rows of this table (review required = the adopt
rows; approval to run = signoff start; release gates = the `blocks` column and `Run.rule`;
evidence freeze and sign-off = signoff close).

**The one algorithm every detector goes through.**

```ts
type Raise<K> = { project; kind: K; subject: KindTable[K]['subject']; evidence: Digest<K>; basis: Hash }

function raise<K extends Kind>(tx: Tx, r: Raise<K>): Raised {
  const fp = fingerprint(r.kind, r.subject)
  const q  = tx.questions.latest(r.project, fp)                       // KEY (project, fingerprint, epoch desc)
  if (!q)                     return open(tx, r, fp, 0, null)
  if (q.state.s === 'open')   return attach(tx, q, r)                 // seen.count++, digest merged, still one row
  if (q.state.s === 'decided') {
    const d = tx.decisions.get(q.state.decision)
    if (stillHolds(d, r.basis, tx.now)) return carry(tx, q, d, r)     // seen.carried++, no new item
    return open(tx, r, fp, q.epoch + 1, q.id)                         // asked again, with the old answer attached
  }
  return open(tx, r, fp, q.epoch + 1, q.id)                           // was dissolved, evidence is back
}

function open<K extends Kind>(tx, r, fp, epoch, prior): Raised {
  const clause = firstMatch(tx.policy(r.project).clauses, r)          // total
  const q = tx.questions.insert({ ...r, fingerprint: fp, epoch, prior, ask: askOf(clause),
                                  blocks: runs.blockedBy(tx, clause, r), state: { s: 'open' } })
  if (clause.ask.who === 'rule')
    return settle(tx, q, [{ by: RULE, reason: null, clause: clause.id }], clause.ask.answer)
  return { s: 'open', q: q.id }
}
```

Running a detector twice attaches twice to the same row, and detectors run inside the
transaction of the evidence that triggered them, so a crash leaves neither.

**Dissolving.** A question whose reason has gone closes without a decision and says why: a gap
when evidence arrives, an adopt when its author withdraws the proposal, a failure on a change
when the head commit no longer fails it. Dissolved is not decided: nothing carries forward.

### 6.6 Access patterns, traced

Every read below ends in point reads or one bounded range read on a key named above.

**1. Read one case.** `Case` by `(project, ref)` → `Version` by `(case, head)`. Two point
reads. A conditional read (`unless: hash`) compares `Case.headHash` and stops after the first.

**2. List a folder page.** Range on `Case (project, folder, rank)`, 50 rows; the row already
has `title`, tags, `intent`. Glyphs for the page come from three batched point reads over the
same 50 ids: `Test (project, case)` → `TestSignals (test)` (last outcome, flaky state),
`Quarantine (test)`, and open-question counts by subject. No per-row query; nothing scans a
result. A subtree is the union of a few folder ranges (folders number in the thousands, cases
are not copied under them).

**3. Search.** One query on `SearchDoc` scoped by project, with folder-set and tag filters
applied in the same query, returning ids and the matched fragment; then pattern 2's batched
reads for the page. The document is replaced by the adopt effect in the same transaction, so
search is never behind the suite.

**4. Execute a run.** Next slot: `Slot (run, assignee, best=null, rank)`, limit 1, then the
pinned `Version (case, version)`. The client holds the next five. Recording a result is
`report` with one result, in one transaction: insert `Result`; set `Slot.best`; adjust
`Run.tally` by a delta; on a failure, upsert `Signature` and `raise('failure')`. Two executors
on different slots touch different rows. Two on the same slot: both results are kept, `best`
is the later Seq, and the run page shows the disagreement.

**5. Ingest 10,000 results.** *Accept* (synchronous, the < 2 s budget): compute `Batch.key`;
if it exists return its receipt; else store the raw file, insert `Batch(accepted)` and a job.
*Process* (one transaction, one Seq; a crash rolls back and the job reruns from the raw file):

```
parse raw → Report                                   // evidence/parsers; the only code that knows a wire format
tests   = Test.resolve(keys)                         // batched lookup on (project, key); insert the unseen
stamp   = Case.head for tests with a case            // batched point reads
insert 10,000 Result rows                            // the only write proportional to volume
signals = TestSignals.get(failing ∪ lastFail==this commit)   // reads proportional to failures
fold    → write TestSignals only for failures, transitions and flips
upsert Signature for distinct failure hashes
runs    = Run (project, open) where matches(accepts, target)  // a handful; create the change run on first sight
runs.fold: Slot.best via Slot (case, run); tally deltas
raise 'failure' per (signature, scope) · 'map' per file with unseen tests · 'flaky' per state change
Batch.state = processed; Command row; push "changed" for touched refs
```

Everything except the result rows is proportional to failures and changes, which is what makes
the 5 s visibility budget plausible at 10k. Reports of 200 results or fewer (every manual
keypress) are processed inline in the accept call.

**6. Flaky state on ingest.** Inside the fold above, per failing result: read the test's last
five results `(project, test, seq desc)`; a pass on the same commit is a *flip*. Per passing
result whose `TestSignals.lastFail.commit` equals this commit: a flip. Two outcomes for one
test inside one batch (retries): a flip with no read at all. On a trunk line, an outcome
different from `trunk.last` appends a *transition*. `classify(signals, thresholds)` is pure;
when its state changes, `raise('flaky', { test, edge })`. Reading the state is a point read on
`TestSignals`, which pattern 2 already batches.

**7. Impact set for a change.** Input: `Change { files, refs, base, head }`.

```
refs  → Requirement (project, source.key) → Covers (requirement → case)
files → Test (project, file) → Test.case                       // a changed test file
files → Area globs, matched in memory → folder → Case (project, folder, rank), capped
candidates (<= 200) → batched point reads:
   Case (hash, title) · Review (case, hash, lens) · TestSignals · Question (subject) open and decided-and-holding
   · last Result on the base line and on this change (2 x limit-1 range reads per test)
rank: failing on this change > changed since last review > flaky > never reviewed > long unrun
uncovered = files matched by nothing
```

No step reads the suite. If links are sparse the answer is honestly small and `uncovered` says
so; that list is itself what makes people add areas.

**8. Changed since, for an agent.** Cursor `S`. Range on `Case (project, rev > S)`, filtered
by scope (a folder set; or, for a requirement, start from `Covers` and filter `rev > S`). For
each, `versionAt(case, S)` is a backwards walk on `Version (case, no)`, a few rows, and the
reply is the step-level diff against head, not the body. Settled questions: range on
`Question (project, rev > S)`. The new cursor is the current Seq. Each changed object appears
once however many times it changed.

**9. Traceability chain.** Requirement → `Covers` → Case → `Version (case, no)` →
`Test (project, case)` → `Result (project, test, seq desc)` → `Result.target` → `Target`
(commit, build) → `Deploy (target)`; and a failing result → `Signature` →
`Excuse (project, signature, scope)` → `Decision` → defect ref. Backwards, each hop has the
reverse key: defect ref → `Excuse` → signature → results by `(project, batch, outcome)` →
`Result.case` → `Covers (case → requirement)`. Every hop is a keyed read in both directions.

**10. Gate status read by CI.** `Run` by `(project, commit)`: one row holding `verdict`,
`tally` and the first 32 blocking question ids. It was written when the evidence or the
decision arrived, by the one module that owns it; reading it computes nothing.

**11. The queue itself.** Range on `Question (project, open, owner, rank)`, 50 rows; each row
already carries its digest, answers and advice. Counts per kind are an index-only count over
the same key. The open set is the thing the product exists to keep small; the benchmark still
runs it at 50,000 open.

---

## 7. Operation layer and module map

### 7.1 The operation surface

Seventeen operations. Every surface calls these and nothing else. Inputs and outputs are domain
values; HTTP, MCP and CLI encodings are generated from the registry. Marked `mcp` are the ten
agent tools.

```ts
// ---- produce evidence (capability: produce) -------------------------------------------------
op propose (i: { id: ProposalId; changes: Change[]; reason?: string; seal: boolean }): ProposeReply          // mcp
   // Upsert while open (autosave). seal → raise('adopt'). Reply: adopted | open{question, needs} | conflict{fields}
op report  (i: { target?: TargetSpec; run?: Ref; job?: string; attempt?: number;
                 results: ResultIn[] } | { file: Blob; format?: Format; ...same }): ReportReceipt             // mcp
   // One shape for a 10k CI file and one keypress. Idempotent on Batch.key.
op claim   (i: { lens: string; about?: Ref; reviewed?: `${Ref}@${Hash}`[]; findings: FindingIn[] }): ClaimReply   // mcp
   // Reply separates opened questions from findings already decided ('known'), which write nothing.
op announce(i: { change: ChangeSpec } | { deploy: { build: string; env: string } }): Ref
   // A PR opened with its files; a build reached an environment.
op attach  (i: { name: string; bytes: Stream }): BlobRef

// ---- request evidence (capability: plan) ----------------------------------------------------
op plan    (i: { name: string; select: Selection; accepts?: TargetMatch; assign?: Assign; rule?: GateRule }): PlanReply
   // Pins slots to current versions; reports how many are already satisfied. May raise signoff(start).

// ---- decide (capability: produce to advise, answer to be counted; then policy) --------------
op decide  (i: { q: Ref; answer: Answer; reason?: string; supersede?: boolean }
              | { kind: Kind; subject: Subject; answer: Answer; reason?: string }                              // mcp
              | { all: { q: Ref; answer: Answer }[]; reason?: string }): DecideReply
   // The only way standing changes. Second form: decide something nobody was asked (a person
   // quarantines a test by hand): the question is opened and answered in one transaction.
   // Reply per question: decided{effects} | advised{needs} | pending{needs} | already | conflict{current} | forbidden{needs}

// ---- read (capability: read) ----------------------------------------------------------------
op inbox   (i: { for?: ActorId | 'me' | 'all'; kind?: Kind[]; state?: 'open' | 'decided'; on?: Ref;
                 since?: Cursor; limit?: number; cursor?: Cursor }): { counts; items: QuestionDigest[]; cursor }   // mcp
   // The queue, and with state:'decided' the ledger.
op get     (i: { refs: Ref[]; fields?: Field[]; unless?: Record<Ref, Hash>; as?: 'data' | 'md' }): Got[]       // mcp
op find    (i: { in: 'cases' | 'tests' | 'runs' | 'requirements'; text?: string; where?: Filter;
                 fields?: Field[]; limit?: number; cursor?: Cursor }): { count; items; cursor }               // mcp
op impact  (i: { change: Ref } | { run: Ref } | { requirement: Ref } | { folder: Ref };
               since?: Cursor; ledger?: boolean): ImpactDigest                                                 // mcp
   // The review brief for a change and the charter for a test session are the same digest.
op since   (i: { cursor: Cursor; scope?: Ref }): { changed: Diff[]; settled: DecisionDigest[]; cursor }        // mcp
op history (i: { ref: Ref; from?: VersionNo; to?: VersionNo }): VersionDigest[] | Diff
op gate    (i: { commit: Sha } | { run: Ref }; wait?: Duration): GateStatus                                    // mcp
op trace   (i: { from: Ref; toward: 'evidence' | 'requirement' }): Chain

// ---- administer (capability: admin) ---------------------------------------------------------
op admin   (i: { project?: …; actor?: …; grant?: …; token?: …; field?: … }): AdminReply
op transfer(i: { export: { project: Ref } } | { import: { from: Blob; format: 'mainworthy' | 'testrail' | 'qase' | 'csv' } }): TransferReply
   // 'mainworthy' export is the journal in Seq order plus blobs; import replays it through the same effects.
```

What is deliberately absent: `createCase`, `updateCase`, `moveCase`, `linkTest`, `quarantine`,
`createRun`, `addResult`, `closeRun`, `approve`. Each would be a second way to do something
`propose`, `report`, `plan` or `decide` already does, and a place for policy to be skipped.

```ts
// The registry: the one place an operation is declared (P9).
type OpSpec<I, O> = {
  name: OpName
  input: Schema<I>; output: Schema<O>           // validated at the boundary; handlers trust the types
  needs: Capability
  effect: 'read' | 'write' | 'destructive'      // → MCP annotations, HTTP verb, CLI confirmation
  mcp: { describe: string /* <= 40 words, counted */ } | null
  budget: { p95ms: number; tokens?: number }    // → generated latency and token tests
  run: (ctx: Ctx, input: I) => O                // ctx = { actor, grant, project, tx, now, cmd }
}
const OPS: Record<OpName, OpSpec<any, any>> = { /* seventeen entries */ }
// Generated from OPS, never written by hand: HTTP routes and the OpenAPI document, the MCP tool
// list, the CLI commands and their help, the shipped skill's reference pages, the budget tests.
```

The shell around every operation is the same four steps and lives in one place:

```ts
function invoke(surface: Surface, name: OpName, raw: unknown, token: Token): Reply {
  const spec  = OPS[name]
  const input = spec.input.parse(raw)                         // boundary: wire → domain, or a typed error
  const ctx   = authorise(token, spec.needs, input)           // actor, grant, project scope
  if (spec.effect === 'read') return spec.run(ctx, input)
  return commands.once(ctx, input.cmd, () => {                // idempotency: a known CommandId returns its outcome
    const out = spec.run(ctx, input)                          // pure domain functions + this one transaction
    ctx.tx.stampSeq()                                         // last statement: Seq in commit order
    return out
  })                                                          // after commit: push `touched`, run ports' jobs
}
```

### 7.2 The tricky bodies

```ts
// decisions/answer.ts
function answer<K extends Kind>(tx: Tx, actor: Actor, q: Question<K>, a: KindTable[K]['answer'],
                                reason: string | null, supersede: boolean): DecideReply {
  if (q.state.s === 'decided' && !supersede) {
    const d = tx.decisions.get(q.state.decision)
    return same(d.answer, a) ? { s: 'already', decision: d.id }        // a retry, or two people agreeing
                             : { s: 'conflict', current: digest(d) }   // someone answered differently first
  }
  const ask      = askOf(firstMatch(tx.policy(q.project).clauses, q, a))   // re-resolved: policy may have tightened,
                                                                           // and a clause may depend on the answer
  const standing = standingOf(actor, ask, q)        // 'counts' | 'advice' | 'forbidden'   (pure)
  if (standing === 'forbidden')                 return { s: 'forbidden', needs: describe(ask) }
  if (ask.reason === 'required' && !reason)     return { s: 'invalid', needs: 'reason' }
  q.answers = upsertBy(q.answers, { by: actor.id, answer: a, reason, at: tx.now, counts: standing === 'counts' })
  const t = tally(q.answers, ask)                   // pure: same answer from `quorum` distinct counted signers
  if (t.s !== 'met') return { s: standing === 'advice' ? 'advised' : 'pending', needs: t.needs }
  return settle(tx, q, t.signers, a)
}

function settle<K extends Kind>(tx, q: Question<K>, signers, a): DecideReply {
  const prior = q.state.s === 'decided' ? tx.decisions.get(q.state.decision) : null
  if (prior) KINDS[q.kind].revert(tx, witness(prior), q)             // superseding: undo the old effect first
  const d = tx.decisions.insert({ question: q.id, kind: q.kind, answer: a, signers,
                                  basis: q.evidence.hash, holds: KINDS[q.kind].holds(a, q),
                                  supersedes: prior?.id ?? null })
  q.state = { s: 'decided', decision: d.id }
  const effects = KINDS[q.kind].effect(tx, witness(d), q)            // the only call site of any standing writer
  // effect may throw Unsettled (an adopt that no longer merges): the whole transaction rolls back
  // and the reply is { s: 'conflict', fields } with the question still open.
  runs.onSettled(tx, q, d)                                           // re-tally the runs this question blocked
  return { s: 'decided', decision: d.id, effects }
}

// A standing writer cannot be called without proof that a decision exists:
type Decided<K extends Kind> = Brand<Decision<K>>                    // minted only by decisions/settle.ts
// suite:     function adoptVersion(tx, by: Decided<'adopt'>, c: CaseId, body: CaseBody): Version
// evidence:  function bindTest    (tx, by: Decided<'map'>, t: TestId, c: CaseId | null): void
// runs:      function closeRun    (tx, by: Decided<'signoff'>, r: RunId, freeze: boolean): void
```

```ts
// kinds/adopt.ts  (one file per kind; this is the whole of what "review" means)
const adopt: KindSpec<'adopt'> = {
  detect(ev) { return ev.is === 'proposal.sealed' ? [{ kind: 'adopt', subject: { proposal: ev.id }, … }] : [] },
  holds: () => ({ until: 'basis-changes' }),
  effect(tx, by, q) {
    const p = suite.proposal(tx, q.subject.proposal)
    if (by.answer.is === 'reject') return []
    for (const c of p.changes) switch (c.op) {
      case 'edit': {
        const head = suite.head(tx, c.case)
        const body = by.answer.is === 'merge' ? by.answer.body
                   : c.base === head.no       ? c.body
                   : merge3(suite.version(tx, c.case, c.base).body, head.body, c.body)   // pure; field- and step-wise
        if (isConflict(body)) throw new Unsettled(conflictsOf(body))    // decision 0004: both sides kept, shown side by side
        suite.adoptVersion(tx, by, c.case, body)                        // also: headHash, title, SearchDoc, users of a fragment
        break
      }
      // create · place · state · restore · cover · area · folder · policy: each one suite writer taking `by`
    }
  },
  revert(tx, by, q) { throw new Error('not implemented') },   // TODO: undo of an adopted proposal is a NEW proposal built from
                                                              // the inverse of each change; revert here only applies to a
                                                              // superseded *reject* (nothing to undo)
  digest(q) { throw new Error('not implemented') },           // TODO: "2 steps changed, 1 added" + the step-level diff, bounded
}
```

```ts
// kinds/failure.ts  (the detector that decides how noisy the product is)
function detectFailures(tx, batch: Batch, failing: Result[]): Raise<'failure'>[] {
  const scope = scopeOf(batch.target)                       // ChangeId for a change line, LineId for trunk/release,
                                                            // RunId when the result was typed into a planned run
  const out = new Map<SignatureId, Raise<'failure'>>()
  for (const r of failing) {
    if (tx.quarantine.has(r.test))                              { excuse(r, 'quarantined'); continue }
    if (scope.is === 'change' && failsOnBase(tx, r.test, batch)) { excuse(r, 'base');        continue }
    // TODO: failsOnBase = TestSignals.trunk.last === 'fail' at or before the change's base commit.
    //       When the base is older than the last trunk transition, read the one result at the base instead.
    merge(out, r.failure.signature, r)                      // one Raise per signature; evidence lists <= 10 tests + a count
  }
  return [...out.values()]
  // TODO: over-merge guard. If one signature covers > 50 tests across > 5 files and its class is 'assertion',
  //       split by file: a generic message is not one cause. The threshold is a policy value with a test fixture.
}
```

### 7.3 Module map and ownership

```
surfaces/        rest · mcp · cli · web-api        generated adapters; no logic; import ops only
   │
ops/             the registry (OPS) and invoke()   the only public entry; no state
   │
   ├── views/        impact · since · trace · history · reports        stateless; reads others' public readers
   ├── decisions/    raise · answer · settle · tally · stillHolds      owns Question, Decision, Policy
   │      └── kinds/     adopt · map · failure · flaky · gap · finding · signoff
   │                     one file each: detect, digest, holds, effect, revert, default clauses
   ├── runs/         plan · fold · verdict · publish                   owns Run, Slot
   ├── suite/        proposals, versions, folders, requirements, search owns Case, Version, Proposal, Folder,
   │                                                                    Requirement, Covers, Area, Uses, SearchDoc
   ├── evidence/     ingest, parsers, signals, findings                 owns Test, Target, Line, Change, Deploy, Batch,
   │                                                                    Result, Signature, TestSignals, JobManifest,
   │                                                                    Missing, Finding, Review, Excuse, Quarantine
   └── identity/     actors, grants, tokens                             owns Actor, Grant, Token
   │
kernel/          tx · seq · commands · events · jobs · blobs           owns Command, Job, Blob; knows no domain type
ports/           tracker · vcs-status · notify                          outbound only; run from persisted jobs; never in a tx
```

Rules that make the boundaries visible:

- **One owner per row type.** Only the owning module's files touch its storage. Other modules
  call its exported readers, or its *writers that take a `Decided<K>` witness*.
- **Domain modules never import `decisions`.** They emit events through `kernel/events`
  (dispatched synchronously inside the same transaction). `kinds/*` import the domain modules
  and the decision machinery; nothing imports `kinds/*` except the `KINDS` table.
- **`KINDS: Record<Kind, KindSpec>` and `OPS: Record<OpName, OpSpec>` are exhaustive maps**, so
  a kind or an operation that is declared but not registered does not compile, and one that is
  registered is automatically in the queue UI, the MCP schema, the policy editor, the presets'
  totality check and the export.
- **Pure core, thin shell.** `merge3`, `classify`, `verdict`, `tally`, `standingOf`,
  `stillHolds`, `fingerprint`, `firstMatch`, `matches` and every parser are pure functions of
  their arguments. Transactions, clocks and I/O exist in `invoke`, `kernel` and `ports`.
- **Wire formats stop at the edge.** JUnit XML, tracker payloads and VCS webhooks are parsed in
  `evidence/parsers` and `ports` into domain values; no other file knows they exist.
- **Shared state between actors.** Authors each have their own open proposal per case (merged
  at read as an overlay for its author); concurrent sealed proposals meet in `merge3` at adopt.
  Executors write different `Slot` rows. Producers append. Two people answering one question:
  the second gets `already` or `conflict` and nothing is overwritten.
- **Idempotency.** Every write operation is keyed by its `CommandId`; `report` additionally by
  the content key of the batch; `raise` by fingerprint. Background jobs (process a batch, post
  a status, seal an abandoned draft) are persisted, do their work in one transaction and are
  safe to run twice.

---

## 8. Product surface

### 8.1 The objects a user lives in

Five nouns, each with a short ID and a page: **Question** (`Q-`), **Case** (`C-`), **Run**
(`R-`), **Change** (`pr:482`, a commit) and **Requirement** (`REQ-`, or the tracker's own key).
Tests (`T-`) are visible but secondary: they appear on cases, runs and questions.

### 8.2 The screens

**1. Queue (home, `g q`).** What needs you, most blocking first.

```
 Queue · acme/web                              7 for you · 12 open · 41 settled by rule today
 ───────────────────────────────────────────────────────────────────────────────────────────────────────
 ▸ Q-2291 failure  pr:482     3 tests: expected 90.00, got 100.00        ▣×3   ◇ advises: defect   blocks R-507
   Q-2315 failure  R-41       C-311 step 2: total $100.00 after SAVE10   ◉ dana  like Q-2291       blocks R-41
   Q-2301 finding  C-311#s2   cannot fail: "Total updates"               ◇ reviewer  + suggested edit
   Q-2288 adopt    C-340      2 steps changed, 1 added                   ◇ author-bot
   Q-2279 flaky    T-1904     4 flips in 30 trunk runs                   ▣           rule quarantines in 2d
   Q-2270 map      checkout.spec.ts   7 tests without a case             ▣
   Q-2330 signoff  R-41       212/214 pass · 2 waived                    ◉4 ▣1 ◇1
 ───────────────────────────────────────────────────────────────────────────────────────────────────────
 Q-2291   d defect   t test   e expected   f flaky   i infra   │  ␣ peek   ⏎ open   r reason   x select   z snooze   u undo
```

`◉` person, `▣` pipeline, `◇` agent: the producer of the evidence, on every row of every
screen. `␣` opens a side peek with the evidence (the three tests, the excerpt, the diff of the
change at `coupon.ts:41`, the last ten outcomes on trunk) without leaving the list. `x` on
several rows of one kind answers them together. The bar at the bottom is generated from the
kind's answer union, so a new kind brings its own keys. Filters are one key each: mine, by
kind, by run, by change; "settled" turns the same list into the ledger.

**2. Suite (`g s`).** An outline of folders and cases that edits in place: `c` creates, typing
edits, `⌘↑/↓` reorders, `m` moves the selection, `/` searches from anywhere. Each case row
carries one small strip: its last outcomes with producer glyphs, a flaky mark, an open-question
dot. Nothing on this screen is a status someone typed.

**3. Case (`C-311`).** The body on the left, editable where it is. On the right, **one
timeline**, not tabs: versions (with the proposal's reason and who adopted it), results from
every producer interleaved by time, findings and their answers, and the questions the case is
part of. "Failed on v7 at 9f3c2ab by CI; v8 changed step 2 (accepted by mira from agent
reviewer's finding Q-2301); passed on v8 at b77e510 by dana, by hand" is one column read top to
bottom.

**4. Run (`R-41`, or a PR's page).** A header with the verdict in words (`blocked: 1 question
needs an answer`, `failed: 3 results attributed to this change`, `pending: 12 slots need
evidence`) and the tally. Below, the slots or reported tests, grouped by verdict class, each
showing *who or what satisfied it*. `⏎` on a row enters execution at that slot; `p f b s` and
step numbers work as in §5.4. The same page serves a PR check, a regression pass and a release.

**5. Change (`pr:482`).** What an author of a PR wants in one place: the gate, the questions
this change opened, failures that are *not* this change's fault and why (base, quarantine,
excuse, each a link to the decision), the impact set with which cases an agent reviewed, and
uncovered paths.

**6. Requirement.** Its cases, the best evidence per open run, gaps, and the chain to commits
and deployments in both directions (`trace`).

**7. Command palette (`⌘K`) and policy table.** The palette reaches every object by ID or
text and every operation. The policy screen is the clause table of §6.5 and nothing else.

### 8.3 How the three layers appear together

Not as three tabs, because there is no third or second model to give a tab to:

- **A slot is filled by whoever gets there.** The run page shows 171 `▣`, 41 `◉`, 2 `◇`. A
  tester's list is "what no pipeline and no agent has shown yet".
- **A case's timeline interleaves them.** A manual pass after an automated fail on the same
  build is visible as a disagreement, not hidden in another tool.
- **A question shows who produced the evidence and who advises.** A CI failure with an agent's
  advice and a tester's manual reproduction is one row with three glyphs.
- **The gate does not care.** `verdict` counts evidence by target and decision, never by
  producer; policy may say an agent's result does not satisfy a regulated slot
  (`Slot.best.by`), which is a clause, not a code path.
- **Reports are counts over decisions and evidence**: decisions per release, median seconds per
  decision, share settled by rule, share of slots filled by each producer, questions re-asked
  (answers that did not hold). Automation rate and flaky rate fall out of the same rows.

---

## 9. First deliverable slice

**Name: "one red build, three producers".** The smallest version that already is the product:
a person, a pipeline and an agent feed one stream, and one queue settles what they leave. It
follows the stack decision (roadmap phase 1) and runs as the Local layer.

**In.**

- One artifact; `mainworthy` starts Local with a project, a machine user and the `loose` preset.
- Suite: folders, cases with steps and expected results, outline capture with paste splitting,
  tags, open proposals as autosave, sealed proposals, versions with step-level diff and
  restore, search over title and steps, bulk move and retag as one proposal with undo.
- Evidence: `report` for JUnit XML and for manual results; tests registered on first sight;
  targets, changes and batches with idempotent ingest; signatures; same-code flips recorded.
- Runs: change runs opened by ingest with the four-verdict gate; planned runs with pinned slots
  satisfied by any producer; the execution keys of §5.4; attachments on local disk.
- Decisions: the machinery in full (`raise`, `answer`, `settle`, carry-forward, supersede,
  advice, quorum) with **four kinds: `adopt`, `failure`, `map`, `finding`**; presets `loose`
  and `standard`, plus a `strict` fixture preset used only by tests to prove P5 (named role,
  four eyes, quorum 2, required reason).
- Surfaces: queue, suite, case, run and change screens; CLI; MCP with the ten tools and the
  skill; all generated from `OPS`.
- `impact` from tracker keys in the change, changed test files and areas; `since`; the review
  ledger (`Review`, finding fingerprints).
- `transfer`: export and import of the full log (also the Local to Server path).
- Budgets in the check: the vision's latency numbers, L2, C5, C7, B1, B6.

**Exit: these jobs pass on the real product.** J1, J2, J4, J5, J8, J15; A1, A2, A3, A4, A5;
and five that are specific to this design:

- D1. A report with 500 failures from one cause opens at most 3 questions; the same report
  with 12 distinct causes opens 12.
- D2. Twenty mixed questions decided in 60 s by keyboard, none opened.
- D3. Re-running the same failing commit, and the next commit failing the same way after a
  `flaky` answer, ask nothing new; a failure that returns after its hold ended is asked again
  and shows the earlier answer.
- D4. The same data passes its job suite under `loose`, `standard` and the `strict` fixture
  with no migration; every decision names the clause that settled it.
- D5. Export, import into an empty instance: every case head hash, decision and run verdict is
  identical.

**Deliberately out, and what stands in until then.**

| Left out | Meanwhile |
| --- | --- |
| Flaky *detector*, stale-test detector, quarantine standing (`flaky` kind) | `flaky` is already an answer to a failure and carries forward for its window; flips are recorded so the detector has history when it arrives |
| Requirements coverage, `gap` and `signoff` kinds, evidence freeze, regulated preset | runs close by rule when passed; `Requirement` rows and `cover` changes exist so links made now are kept |
| Shared steps (fragments), custom fields | the `Step` union and `fields` map are in the body type; no UI |
| Posting a check to the code host, creating tracker issues (`ports`) | `mainworthy gate` exit code and URL in the job log; a defect is a pasted reference |
| Importers for TestRail, Qase, CSV | Markdown and pasted lists in; full export out |
| Server and Cloud layers, SSO, roles beyond admin, member, reader | Local only; tokens with capabilities and project scope |
| Report formats beyond JUnit XML | the parser registry has one entry |
| Dashboards | the five counts of §8.3 on the queue header |

Why this is not a bad product (§3 floor): nothing is lossy (F1); answers carry forward from day
one (F2); every capability is an operation (F3); the hot paths are in the check (F4); first
value is one command (F5); export ships (F6); the strict path is exercised by a fixture on the
same model (F7); a change has one page (F8). What it is *not* yet is a replacement for a
regulated team's current tool, and it says so.

---

## 10. Challenges to existing decisions, and where the seed lens was bent

### 10.1 Challenges

Everything not listed here is taken as a constraint.

| # | Replaces | With | Why | Cost |
| --- | --- | --- | --- | --- |
| X1 | Vision: priorities ranked speed > agents > UX | P1 as a floor above speed; speed defined by seconds per human decision; budgets in ms, tokens and keystrokes (§3) | "Fast" alone permits trading away the record, and the ask says UX is where incumbents fail | Three kinds of budget to maintain |
| X2 | Vision principle 1: every edit is a version; "writes are append-only versions" | Autosave goes to the author's *open proposal*; a version exists when a proposal is sealed and adopted | With autosave, per-edit versions make history unreadable, give reviewers no unit to approve, and make every hash an agent holds stale within seconds | One mutable row type (an open proposal); others see an edit up to ~30 s later; a job must seal abandoned drafts |
| X3 | Vision: execution type (manual / automated / both) is a versioned field | Derived from linked tests and recent human results; the only declared part is `intent.automate` | A declared type drifts from what actually reports (P6); the vision already wants the link "checked from the other direction" | Nobody can mark a case automated by hand; importers map the old field to intent |
| X4 | Vision: unmatched results go to an "unlinked inbox", optional auto-create | A `Test` is a first-class evidence subject with or without a case; mapping is a `map` question raised only if policy asks | An automation-heavy team should get history, flakiness and gates without writing a case; auto-created empty cases are clutter | Two nouns (case, test); coverage reports must say "tests without a case" plainly |
| X5 | Vision: "plans and runs"; results belong to a run | A run is a predicate over targets plus pinned slots; results belong to a target; no plan object | It is the only shape in which CI, people and agents fill the same run; TestRail's plan → run → test tree is where the manual / automated split comes from | Manual results need a target (a build or environment), or fall back to `self`; TestRail users must unlearn a hierarchy; importing foreign runs needs synthetic targets |
| X6 | Decision 0003: five named policy switches | A clause table: kind x condition → who answers, what it blocks; presets are clause lists | The switches are five rows of one table; the table also covers what the switches forgot (who may excuse a failure, who may quarantine, what an agent may settle) | More expressive means more ways to misconfigure; mitigated by presets, a closed predicate vocabulary and a totality check |
| X7 | Decision 0006, mechanism 5: a review ledger for findings | The ledger is every decision of every kind; a finding is one kind | An agent rediscovers failure triage and mapping too, not only review findings | Fingerprints must be good for seven kinds, not one (§10.2, risk) |
| X8 | Roadmap phases 2 and 3: authoring slice first, then runs, CI and agents | One thin slice across all three producers and the queue (§9) | An authoring-only slice is a nicer case editor: it tests none of this design's risk and cannot show the thesis | Authoring ships thinner at first (no shared steps, no custom fields); J11 and J12 move later |
| X9 | Open question 16: requirements external only, or local too | A local `Requirement` row that may mirror a tracker item | Traceability and gaps must work in Local with no tracker (P7), and a link needs a row to point at | A second place a requirement title can go stale; the mirror is one-way and labelled |
| X10 | Decision 0001 criteria | Add: Seq assigned in commit order per project; batched point reads and writes of 10k keys inside one transaction; an index-only count on the open-queue key | The model's "changed since" and ingest traces depend on them | Per-project commit serialisation is a throughput ceiling the benchmark must measure |

Decisions 0002, 0004 and 0005 are used as written. 0004's conflict flow is the `adopt` question
with a stale base; its live-update candidates reduce to two that this design needs (the queue
and run progress update without reload).

### 10.2 Where the lens was pushed, and where it broke

**Pushed, and it held.**

- *Saving a case is a decision.* In every preset an edit is a proposal and a decision adopts
  it; the loose preset's decision is a rule. This removes the "review on / review off" fork
  entirely, which is the fork an agent contributor would otherwise implement twice.
- *Policy is who answers.* All of decision 0003's spectrum fits in `Ask`.
- *The gate is a function of decisions*, which gives the `blocked` versus `failed` distinction
  and lets a human answer change a PR check without burning CI minutes.
- *Undo, conflict, quarantine, waiver, sign-off* all turned out to be answers, so none needed
  its own mechanism.

**Broke, and was abandoned there.**

- *"A manual result is a decision."* Tempting, since a tester judges pass or fail. It fails:
  results are 99.9% machine-written, need no authority check, never carry forward, and are
  what decisions are *about*. Folding them into the decision log would make a 10M-row union of
  two shapes. A result is evidence from every producer; what remains of the idea is that an
  unfilled slot is something a person owes, shown in the run rather than as one queue item per
  case.
- *"The queue is the whole product."* It is home for whoever triages. It is not where an
  author writes or an executor executes; those are the suite and the run, with their own
  keyboards. The lens contributes their *write path* (propose, report) but not their screens.
  A loose team with good tests may see an almost empty queue for days; then the product they
  experience is a fast suite and an honest gate, and the ledger fills quietly.
- *"One question per thing that happened."* Would rebuild the notification stream this design
  exists to replace. Questions are per cause (fingerprint), and results that are excused by an
  earlier answer raise nothing.

**The risk the lens creates.** Everything rests on fingerprints and holds being right. Merge
too much and a real regression is excused by an old "flaky" answer because it shares a message;
merge too little and the queue floods and is ignored. Guards in the design: holds default to
short and basis-bound; `carried` counts are visible on the run and the question; an excused
failure on a change is always listed with its decision one key away from "re-decide"; the
over-merge split in `detectFailures`; and D1 and D3 as fixtures. It remains the thing most
likely to need tuning on real data, and it cannot be validated without it.
