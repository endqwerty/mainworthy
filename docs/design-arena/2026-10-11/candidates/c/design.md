# Casebook, candidate C: the suite is a versioned tree of documents

Seed lens: repository-centric, bun/deno-style tooling first. Stack-neutral: types
below are a sketch in TypeScript-like notation, not a stack choice.

---

## 1. Thesis

Casebook is a **versioned knowledge repository for software checks**: a tree of
plain-text documents (cases, shared steps, requirements, charters, gates, policy)
plus an append-only log of evidence, owned by **one binary** that is CLI, server,
editor UI and MCP server at once. The one structural idea: **a case is a claim, and
manual, automated and agentic testing are three *methods* of proving that claim.**
A claim has a content-addressed identity (its *claim hash*); every method produces
the same `Evidence` row stamped with that hash; and everything the product shows
(coverage, flakiness, gates, impact sets, release readiness) is a fold over
`(claim hash × evidence)`. There are no three testing modules; there is one claim
and three ways to witness it. The same hash makes proof carry over for free: a
result recorded against a proposed edit counts the moment that edit merges.

**Where the seed lens bends (stated up front).**
1. *Results are not documents.* A tree of files cannot hold 10k results per push.
   The tree holds *definitions*; evidence is an append-only log pinned to the tree
   by hash. "Runs record evidence against a tree revision" is kept; "everything is a
   file" is not.
2. *Git is not the canonical store* (decided in §6.1). Casebook owns a git-*shaped*
   store (commits, branches as proposals, three-way merge, content hashes) and
   projects it to git byte-for-byte. Git is a mount and an export, not the database.
3. *The CLI is not the primary surface for executors and readers.* Testers running
   a 30-case run and product owners reading a gate need a keyboard-first UI; the
   CLI is primary for authors-who-code, CI and `casebook check`.

---

## 2. Why the incumbents are a poor use of money

Labels: **V** verified in `docs/competitive-analysis.md`; **R** reported; **H**
hypothesis (mine or the repo's, unchecked).

| # | Structural reason | Label | How this design answers it (structurally) |
|---|---|---|---|
| 1 | **Per-seat pricing taxes people who only read** (universal; viewer seats are a discount, Jira apps charge all Jira users). Seat metering forces a user-class model into the product. | V | There is **no seat concept in the model**: only `Principal` + `Scope`. Readers, CI and agents are scopes, not licences. The cost an org pays is a binary and a database. (Pricing itself is outside this design; the architecture just cannot meter seats.) |
| 2 | **History is a premium tier** (TestRail, Xray: Enterprise; Qase: retention by plan; Testiny, Testomat.io paid). History is bolted on to a mutable-row model, so it can be gated. | V | History *is* the storage: the tree is an append-only commit log; "current" is a derived view. You cannot gate history without removing the product. |
| 3 | **Manual, automated and agentic are three data models.** Manual lives in the TCM, automated in CI dashboards or automation-centred tools (Allure TestOps, Testomat.io), agents in nothing. Teams run a TCM *plus* a report tool *plus* a spreadsheet. | V (tools are automation-centred); H (teams combine them) | One claim, three methods, one `Evidence` shape. Coverage and gates are computed over claims, so "covered by Playwright" and "covered by a tester on Tuesday" are the same fact. |
| 4 | **API rate limits are a pricing lever** (60-300 req/min on TestRail/Xray tiers, up to 1,000 on Qase Enterprise). Ingest and agent traffic are metered like UI clicks. | V | Every write is a *batch* (10k results = one op, 1,000 case edits = one op). Rate limiting is by cost unit per token, set by the operator, never by plan. |
| 5 | **MCP servers are appearing; depth unknown.** Likely thin wrappers over a UI-shaped REST API, so agents pay tokens for list-everything reads. | V (exist), H (shape) | The operation surface is designed for model consumption first (field selection, conditional reads, impact, changed-since, findings ledger) and the UI is a client of it (decision 0006). |
| 6 | **Self-hosting is rare, expensive or dated** (Kiwi, TestLink dated; on-prem priced per seat). | V | One artifact, three layers, same build (decision 0002). Layer is config. |
| 7 | **The data is trapped.** Migration cost is the moat. Import/export formats are unverified. | H | The canonical storage format *is* the export format (plain text + JSONL). Leaving costs one command, so staying has to be earned. |
| 8 | **Slow and dated at scale; traceability is a paid extra or a Jira clutter problem.** | R | Speed is a property of the structures in §7 (every hot read is a keyed lookup or range scan). Tests are not tickets; requirements are documents with optional external stubs. |
| 9 | **Config is click-ops in an admin UI**: unreviewed, undiffable, unauditable. | H | Policy, gates and sets are documents in the same tree: reviewed, diffed, history for free. |

---

## 3. Guiding principles

Ranking. The vision ranks speed > agents > UX. **Refined:** put **Integrity** first
(the record never lies), then speed (latency *and* tokens served), then agents, then
UX. This does not change daily trade-offs; it makes decision 0004 ("detected, not
hidden"; no silent last-write-wins) a rank instead of a footnote. Agents move from
"a surface" to "a client of the only surface", so agent and UI do not compete: they
use the same ops, and a feature that only one can use is not done.

| # | Principle | Rules out | Tie-break |
|---|---|---|---|
| P1 | **One claim, many proofs.** A case states a claim; manual, code and agent are methods; all produce one `Evidence` shape stamped with the claim hash. | A "manual" model and an "automation" model; "agent test" as a separate feature; a result without a stamp. | Beats P6/P7 when a convenience would give one method a private result shape. |
| P2 | **Text is the truth; everything else is a fold.** Authored state is canonical plain-text documents and an evidence log. Indexes, health, standing, links are pure folds computed in the same transaction and rebuildable (`casebook reindex` must reproduce them exactly). Export = storage format. | Hand-synced lists, a second source of truth, a cache carrying correctness, lock-in. | Integrity > P4: if a fold cannot be proven rebuildable it does not ship, even if it is fast. |
| P3 | **One operation surface.** UI, REST, MCP, CLI and CI ingest call the same ~14 ops; schemas defined once generate OpenAPI, MCP tools and CLI help. | UI-only features, a second path to one task, importable internals. | Beats P6: a "simple" shortcut that bypasses an op is rejected. |
| P4 | **Fast by construction.** Each dominant access pattern has a named structure (§7). Latency and tokens-served have budgets enforced as failing tests. | "Add an index/cache later"; client-side filtering; unbounded responses. | Beats agents/UX when they conflict; but an agent token saving never costs correctness (P2/Integrity). |
| P5 | **Policy routes authority; actors are equal.** A write names who and from which base. Policy (a document) decides whether it lands or becomes a proposal. People, agents and CI go through the same gate. | Agent-only or admin-only back doors; silent overwrite; pessimistic locks. | Beats P6: strictness is a switch, never a fork of the model. |
| P6 | **Zero config; strictness by switch.** First case needs a title and nothing else. Regulated behaviour is `policy` fields with presets, same model. | Required fields, wizards, per-profile editions. | Loses to P2/P5 (never trade integrity for fewer clicks). Beats feature breadth. |
| P7 | **Free to read, accountable to write.** Reading costs nothing structurally; every write carries identity, base and (when policy asks) reason. | Seat metering; anonymous writes; an agent without a responsible person. | Equal to P5; both beat UX polish. |
| P8 | **Every promise is a failing test.** Budgets (latency, tokens, ingest), the 5-minute start, rebuildability and lossless export are checks that fail the build. | "Feels fast"; budgets in docs only. | Meta-rule: if a principle has no check, it is not yet a principle. |

### Bending a principle for deliverability

A principle may be bent only if all three hold: (1) the bend is written in a
decision record that names the principle, the cost and an **expiry** (a date or a
milestone); (2) it stays above the floor below; (3) the bend is local (one module or
one release), never a silent default. Bends that remove a check (P8) need a second
approver; Daniel merges anyway under review-first.

**What "a bad product" means (the floor).** Casebook is bad if any of these is true:
it loses or silently overwrites a user's data; it shows a pass for something not
proven on that claim; a hot-path read (open a case, save, ingest ack, gate read)
exceeds **2x** its budget; a team cannot get its data out losslessly; a reader, CI
job or agent needs a human click-through to do its job; a new user cannot get to a
first executed case in 5 minutes. Everything above the floor is negotiable:
breadth, polish, non-hot-path budgets (up to 2x), layer rollout order (Local first).

---

## 4. The DX/UX moves, made concrete

Each move is a commitment with a check.

### 4.1 The Linear move (over GitHub issues): speed as identity, one inbox, no setup

GitHub issues are flexible and slow; Linear is opinionated, instant and keyboard-first.

- **L1. Every op has a command-palette entry and a default key.** Check: a build
  test enumerates the op registry and fails if an op has no command (or an explicit,
  reviewed `uiExempt`).
- **L2. Input-to-paint <= 100 ms p95** on a 10k-case project, measured in a real-browser test; edits are optimistic against a client cache holding pending writes *with their base hashes* (0004), reconciled without losing typed text.
- **L3. One Inbox.** Unbound tests, open proposals, edit conflicts, agent findings and quarantine suggestions are *one* queue (`status{what:'inbox'}`), `j/k` to move, one key to resolve. Check: the product has exactly one place with a pending-decision count.
- **L4. No configuration to start.** A case needs only a title; a project needs a name. Check: the first-run script (§5.1) runs with zero prompts.
- **L5. Triage over reporting.** Failures arrive as a digest ("2 new, 1 flaky, 1 known since #4102") not a table of 12 rows.

### 4.2 The CircleCI move (over Jenkins): config as reviewed code, one-line integrations, insight with no setup

Jenkins needed plugins, a snowflake server and groovy; CircleCI gave a YAML file, hosted-grade defaults and built-in insights.

- **C1. One line, no plugin, any CI.** `casebook report <files>` autodetects commit, branch, PR, build URL and attempt from the environment of GitHub Actions, GitLab, CircleCI, Buildkite, Jenkins. Check: fixture envs for each yield a complete `Ctx` with zero flags; a missing commit is an error unless `--local`.
- **C2. No settings table.** Every setting is a field of a document in the tree (policy, gates, sets), so it is diffable, reviewable and has history. Check: lint fails if a setting exists that is not a document field.
- **C3. Insight on first ingest.** Flaky state, failure digests, durations and the unbound inbox exist after the *first* report, no setup. Check: integration test from empty project to populated digest in one `report` call.
- **C4. The failing build explains itself.** The PR check text is generated from `status{gate}` (top reasons, counts, link). Check: golden-file test on the status text.

### 4.3 The bun/deno move (over npm/ts): one binary, batteries included, drop-in compatible, fast enough to be a feature

- **B1. One artifact.** `casebook` = server + CLI + UI + MCP + importer; zero runtime dependencies; cold start <= 1 s on a laptop. Check: clean-container smoke test; start-time budget.
- **B2. Drop-in.** It accepts what runners already emit (JUnit first) and what incumbents export (TestRail, CSV). No test code changes needed; the `@c_id` annotation is optional.
- **B3. Built-in tooling for the tree.** `casebook fmt` (canonical document form), `casebook check` (a "type-checker" for the suite: dangling links, duplicate bindings, steps with no expected result, cases with no method, stale code methods). The same function backs `status{inbox}` structural items (decision 0006 item 4). Check: `check` runs in CI/pre-commit with a stable exit code; its rules are unit-tested.
- **B4. `casebook bench`** ships in the binary and reproduces the budgets on the user's machine against a generated 100k-case / 1M-result dataset. Claims are re-runnable.

---

## 5. Usage first

These are the spec. Types in §7 are derived from them.

### 5.1 Quickstart (as the user would read it)

```text
# Casebook

Tests as a versioned tree of documents. One binary. No account to start.

1. Install (single binary; install method follows the stack decision).
2. In any folder:

     $ casebook init
     project "my-app" created (local store in ~/.casebook/my-app, tree rev 1)

     $ casebook
     serving http://127.0.0.1:7117   ← opens the UI

3. Write your first case. In the UI press  c  and type an outline:

     Refund a paid order
     - Open the order page for a paid order
       > Refund button is visible
     - Click Refund, choose full amount
       > Confirmation shows the amount
     - Confirm
       > Status is Refunded; email is queued

   (Paste any numbered list and it is split into steps. Enter adds the next step.
    There is no Save button; every keystroke is autosaved as part of one edit.)

4. Run it: press  r  → pick the case → p (pass) / f (fail) / b (block) / s (skip).

5. Send automated results (any CI, one line):

     $ casebook report results.xml          # JUnit; commit/branch/PR from env

6. Let an agent in (scoped, accountable):

     $ casebook token new --agent claude-review --on-behalf-of me \
         --can read,flag,record
     $ claude mcp add casebook http://127.0.0.1:7117/mcp --header "Authorization: Bearer $T"

7. Leave any time:

     $ casebook export ./suite     # plain-text tree + evidence JSONL; `import` restores it
```

What step 3 stores (the canonical form `casebook fmt` always prints; ids are minted
by the server and never reused):

```markdown
---
id: c_7k2m9q
kind: case
title: Refund a paid order
methods: [human]
covers: [q_41x8aw]
tags: [checkout]
---
## Steps
- Open the order page for a paid order ^a1
  > Refund button is visible
- Click Refund, choose full amount ^b7
  > Confirmation shows the amount
- Confirm ^c3
  > Status is Refunded; email is queued
```

(`^xx` are step ids. The editor hides them; they exist so merges, per-step results
and findings can anchor to a step. Accepted cost: some noise in raw diffs.)

Other document kinds are the same shape: a **gate** and a **charter**:

```markdown
---
id: g_pr
kind: gate
title: PR gate
select: { under: /checkout, methods: [code, human] }   # StaticPred only, see §7
require:
  - { each: selected, proven_by: [code], on: commit }       # every selected case, passing on this commit
  - { each: selected, where: { tag: release-critical }, proven_by: [human, agent], within: 14d, on: tag }
---
```

```markdown
---
id: h_checkout-attack
kind: charter
title: Attack the checkout
select: { under: /checkout }
stance: attack                  # attack | review
budget: { tokens: 400000, minutes: 45 }
---
Find ways to refund twice, refund more than was paid, or refund an unpaid order.
Known flaky areas are listed by `status{health}`; do not report them again.
Record each break as a finding with reproduction steps.
```

### 5.2 Call site (a): a CI pipeline step reports automated results

```yaml
# .github/workflows/e2e.yml
jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npx playwright test --reporter=junit > results.xml || true   # what you already do
      - run: casebook report results.xml --gate pr
        if: always()
        env:
          CASEBOOK_URL: ${{ vars.CASEBOOK_URL }}
          CASEBOOK_TOKEN: ${{ secrets.CASEBOOK_TOKEN }}   # principal kind 'ci', scope: record+status
```

```text
$ casebook report results.xml --gate pr
run r_9ks2x  (github acme/shop#482 @ 3fa91c, attempt 1)
10,000 results in 1.4 s  · 9,968 passed · 3 failed · 29 skipped
  failed: 2 new, 1 flaky (refund.spec.ts › refunds a paid order, flaky since #4102)
  digest: 2 signatures  (TimeoutError ×2 at checkout.page.ts:88 · AssertionError ×1)
  unbound: 14 tests with no case → inbox (1 names case c_7k2m9q: link? y/n in UI)
gate pr: HOLD
  2 selected cases have no result on this commit (c_3d8f1a, c_91xk4m)
  1 failing case is not quarantined (c_7k2m9q)
https://casebook.example/r/r_9ks2x
exit 1        # exit 0 unless --gate or --fail-on is given and the gate is not PASS
```

Properties the call site relies on:
- Re-running the same step prints `already recorded (r_9ks2x)` and changes nothing (evidence ids are deterministic; §7.3).
- Unknown tests do not fail the upload: they are `unbound`, visible, never lost.
- Reporting a retry (`attempt 2`) is how fail-then-pass is seen, and is flaky signal #1.
- The same op posts the commit status: `status{what:'gate'}` is the text of the check.

### 5.3 Call site (b): an agent, through MCP, adversarially reviews a PR

Agent identity: `agent claude-review`, on behalf of a person, scope `read, flag,
record`. Tool results are structured; shown abbreviated.

```text
1. impact({ of: { pr: "acme/shop#482" }, skipReviewed: true, limit: 10,
            fields: ["id","title","signals"] })
   → { rev: 4121, total: 7, returned: 7, cursor: null, items: [
       { id:"c_7k2m9q", title:"Refund a paid order", claim:"9f2c",
         signals:["path:src/refund.ts","flaky:suspected","last-fail:2d"] },
       { id:"c_3d8f1a", title:"Partial refund", claim:"1ab4", signals:["req:q_41x8aw","no-code-method"] },
       … 5 more ] }
   # computed from changed paths ∪ requirement trailers ∪ test-file adjacency.
   # No suite scan. Cases already reviewed at the same claim by this agent are omitted
   # (they are counted: "skipped": 4); pass freshEyes:true to include them.

2. read({ ids:["c_7k2m9q","c_3d8f1a"], fields:["claim","methods"], ifNoneMatch:{c_3d8f1a:"1ab4"} })
   → { items:[ {id:"c_7k2m9q", claim:{…}, methods:[…]}, {id:"c_3d8f1a", unchanged:true} ] }

3. flag({ items:[
     { on:{doc:"c_7k2m9q", claim:"9f2c", step:"b7"}, kind:"weak-expectation",
       text:"Expected result does not check the refunded amount.", severity:"med" },
     { on:{doc:"c_3d8f1a", claim:"1ab4"}, kind:"uncovered-path",
       text:"No case covers refunding after the 30-day window.",
       repro:"set order.paidAt = now-31d; click Refund" } ] })
   → { created:[ "f_4ps9", "f_h72k" ] }          # ids only: no echo

4. (policy: review=agents) commit({ reason:"add 30-day window case from f_h72k",
     changes:[ { t:"create", doc:{ kind:"case", title:"Refund after 30-day window", path:"/checkout", … } } ] })
   → { landed:"proposal", proposal:"pr_82kd", why:"policy" }   # same call lands directly under review=none

A re-review after one case changed:
   impact({ of:{pr:"acme/shop#482"}, skipReviewed:true }) → total 7, returned 1 (skipped 6)
```

Token budget target for this job (A4/A5, to be measured, not promised): list of 11
tool definitions <= 2.5k tokens; A4 <= 6k tokens served; A5 <= 15% of A4.

### 5.4 Call site (c): a human runs a manual run; an author captures cases

Executor (keyboard only; every key is a command-palette verb, L1):

```text
 g r        go to Runs
 n          new run → pick set "smoke" (12 cases) → Enter
              ⇒ record({ run:{ kind:"manual", select:"p_smoke", assign:{me:"all"} }, results:[] })
                (opens the run idempotently; RecordOut.scope is the pinned list)
              ⇒ scope is pinned: each case at its CURRENT CLAIM HASH
 (cockpit shows case 1/12, steps, expected results; the next case is prefetched)
 p / f / b / s          record outcome         ⇒ record(run, [{proof, outcome}]) (optimistic)
 f then ⌘V              fail + paste screenshot; type a note; Enter
 d                      link defect: paste a URL (stored as ExtRef on the evidence)
 j / k                  next / previous case
 x                      close run → shows summary + "3 failures, 1 new"
```

Another executor working the same run does the same; results are separate appended
rows, so there is nothing to conflict. If two people record different outcomes for
the same case, the run shows `contested` for that case (§7.4) rather than picking one.

Author capture (burst after a spec lands):

```text
 c                      new case ⇒ editor opens at once, cursor in title (no load step)
 type/paste outline     (grammar in §5.1) ⇒ each pause autosaves one edit
                        ⇒ commit({ base: <hash this editor opened>, changes:[edit…] })
 @                      link requirement: fuzzy find over reqs ⇒ adds `covers`
 /                      insert shared step (live reference; see §7.1 for how a change to
                        a shared step re-stamps its dependents)
 ⌘Z                     undo: issues an inverse edit as a new commit (history never rewrites)
 2 people edit same case, different fields ⇒ merge silently; same field ⇒ the later save
                        becomes a proposal and both versions show side by side (0004)
```

---

## 6. Where the tree lives, and the decision

### 6.1 Decision: Casebook owns the store; git is a mount and a projection

Question: should the suite tree live next to the code (in git) or in Casebook's
own store? Pushed as far as it goes, then decided.

What git-canonical gives: tests change atomically with code in one PR; free review
tooling; agents already live in git; zero lock-in. These are real, and kept (below).

What breaks it (each independently sufficient for a general audience, decision 0005):
1. **Latency/write path.** Save <= 50 ms and bulk edit of 1,000 cases <= 1 s cannot
   go through a hosted-git write (API commit latency, secondary rate limits). A local
   git directory fixes latency but not the next points.
2. **Seats come back.** Readers, approvers and executors who are not engineers would
   need a git host account to read or sign. That rebuilds the per-seat tax (reason #1).
3. **Policy enforcement.** Decision 0003 says agents meet the same gates as people,
   enforced in the operation layer. In git, enforcement is the host's branch
   protection, outside Casebook.
4. **Merge semantics.** 0004 wants field-level auto-merge and a side-by-side
   conflict, with a base hash on every write. Git merges lines, and has no notion of
   "this step was edited".
5. **Many repos, one suite.** A test suite for a product usually spans services.
   Org scale (0005 axis 2) needs shared steps/standards across repos and teams.
6. **Evidence needs a revision with no repo.** Local layer, sandboxes, and imports
   have no git remote; stamps must not depend on one.

**Decision.** The canonical tree is Casebook's own **content-addressed commit log**,
git-shaped: `Commit(parent, changes, author, reason)` with a hash chain, branches (=
proposals), tags (= releases), three-way field-level merge. Its working form is the
canonical text documents of §5.1 and it exports to a git directory **byte-for-byte**
(`casebook export`), which is also its backup format. A subtree can be **mounted** from
elsewhere; every document has exactly one owner:

```ts
type Owner =
  | { t: 'native' }                                        // Casebook is the home (default)
  | { t: 'repo';     url: string; path: Path; sync: 'ci' } // files in a code repo are the home
  | { t: 'upstream'; project: ProjectId; path: Path }      // another project's subtree (org-shared standards)
```

Writes to a document owned elsewhere are rejected with `RepoOwned{repo,path,patch}`
(a ready unified diff to apply there): **one way to do each thing**. The `repo`
owner is where "tests next to the code" lives: `casebook sync` in CI imports the repo's
documents as commits authored by CI. First slice implements only `native` (§12); the
`Owner` type exists from day one so no model change is needed later.

**Cost accepted:** two representations (store + git projection) with a round-trip
property to defend (`export ∘ import = identity`, a failing test, P8). A team that
wants git as the home *now* gets it only in the second slice, as a mount.

### 6.2 Version and proof identity

Two hashes per case, one purpose each:
- `blob`: hash of the canonical bytes. Identifies *the document version* (history, diff, restore).
- `claim`: hash of the **claim-class** content only (steps, expected results, preconditions, plus the claim hashes of any shared steps it uses). Identifies *what is being asserted*. Evidence is stamped with `claim`, not `blob`.

Consequences: retagging, retitling, adding a `covers` link or an owner changes `blob`
but not `claim`, so proof survives; editing a step or an expected result changes
`claim` and the case is honestly unproven until re-witnessed. Editing a shared step
changes the `claim` of every dependent in the same transaction (a derived rewrite,
list in §7.1). A person can say "that was a typo fix" with `decide(reaffirm{from,to})`:
attributed, reasoned, and it carries standing across the hash change. Proof recorded
on a proposal's claim counts automatically when the same claim lands on main.

---

## 7. Domain model (data structures first)

### 7.1 Truth: documents and the commit log

```ts
// Brands: ids are short, typed by prefix, minted by the server, never reused.
type Id<K extends Kind> = Brand<string, K>         // c_7k2m9q (case) s_ shared  q_ req  h_ charter  p_ set  g_ gate
type Hash = Brand<string, 'Hash'>
type Rev  = Brand<number, 'Rev'>                    // per project, monotone, main only
type Path = Brand<string, 'Path'>                   // normalized, '/'-separated, no '..'
type Kind = 'case' | 'shared' | 'req' | 'charter' | 'set' | 'gate' | 'policy'

type Principal =
  | { kind: 'person'; id: PersonId; name: string }
  | { kind: 'agent';  id: AgentId;  name: string; onBehalfOf: PersonId }   // INVARIANT: an agent always has a responsible person
  | { kind: 'ci';     id: CiId;     name: string }

type Doc = CaseDoc | SharedDoc | ReqDoc | CharterDoc | SetDoc | GateDoc | PolicyDoc

interface CaseDoc {
  kind: 'case'; id: Id<'case'>; path: Path; title: string; owner: Owner
  claim: Claim                       // CLAIM class: changing it changes the claim hash
  meta: Meta                         // META class: tags, owner person, priority, custom fields
  methods: NonEmpty<Method>          // INVARIANT: >= 1 way to prove it
  links: Links                       // META class
}
interface Claim { pre: string[]; steps: Step[] }
interface Step  { id: StepId; do: string; expect?: string; uses?: Id<'shared'> }  // `uses` expands by reference
type Method =
  | { m: 'human' }
  | { m: 'code';  fw: Framework; key: TestKey }       // key: normalized suite+name, or '@c_7k2m9q' (annotation form)
  | { m: 'agent'; charter: Id<'charter'> }
interface Links { covers: Id<'req'>[]; watches: Glob[]; defects: ExtRef[] }

interface ReqDoc { kind:'req'; id: Id<'req'>; path: Path; title: string; body?: string
                   source: { t:'native' } | { t:'external'; system: string; key: string; url: string; cachedTitle: string } }
interface CharterDoc { kind:'charter'; id; path; title; select: Pred; stance: 'review'|'attack'
                       brief: string; budget: { tokens?: number; minutes?: number } }
interface SetDoc  { kind:'set';  id; path; title; select: StaticPred }          // plans are sets
interface GateDoc { kind:'gate'; id; path; title; select: StaticPred; require: NonEmpty<Rule> }
interface PolicyDoc { kind:'policy'; id; path; policy: Policy }                  // PROTECTED: see below

// Predicates. Two types so a gate cannot depend on something that changes without a commit.
type StaticPred = { under?: Path; tags?: Tags; covers?: Id<'req'>[]; methods?: MethodKind[]; text?: string; and?: StaticPred[]; or?: StaticPred[]; not?: StaticPred }
type Pred = StaticPred | { live: { health?: Health['state'][]; notRunWithin?: Duration; unbound?: boolean } }
type Rule = { each: 'selected'; where?: StaticPred; proven_by: MethodKind[]   // any-of
             on: 'commit' | 'tag'; within?: Duration }

interface Policy {
  review: 'none' | 'agents' | 'all'           // who must be proposed first
  autoLink: 'off' | 'annotated' | 'create'    // unbound tests: leave / link @c_id annotated / create a case
  runApproval: boolean; freeze: boolean; signoff: boolean       // regulated switches (reserved in slice 1)
  flaky: FlakyParams; quarantine: { autoReleaseAfterClean: number | null }
  presets?: 'loose' | 'standard' | 'regulated'
}
```

**Protected documents.** `PolicyDoc` and `GateDoc` can be changed only by a principal
with scope `admin`, *regardless of `policy.review`*. This closes the hole where an
agent edits the policy that governs it.

The log:

```ts
type Commit = {
  hash: Hash                       // H(parent, canonical(changes), author, at, reason)
  parent: Hash | null
  rev: Rev | null                  // set when the commit lands on main; null on a proposal branch
  branch: 'main' | ProposalId
  author: Principal; at: Instant; reason?: string; opId: OpId   // opId: idempotency key
  changes: NonEmpty<Change>
}
type Change =
  | { t: 'create'; doc: Doc }
  | { t: 'edit';   targets: Targets; ops: NonEmpty<FieldOp> }
  | { t: 'move';   targets: Targets; to: Path }
  | { t: 'remove'; targets: Targets }
  | { t: 'tag';    name: TagName; at: Rev }                 // a release is a tag: immutable name -> rev
// A write names the version it started from. Bulk ops that commute may name 'head' instead,
// and ONLY those: the type makes unsafe bulk-on-head unrepresentable.
type Targets = { based: Array<{ id: Id; base: Hash }> }
             | { commuting: Id[]; opsAreCommutative: true }     // tag add/remove, move; never `set`
type FieldOp =
  | { set: FieldPath; to: Json }
  | { stepInsert: { after: StepId | null; step: Step } } | { stepSet: { id: StepId; do?: string; expect?: string } }
  | { stepRemove: StepId } | { stepMove: { id: StepId; after: StepId | null } }
  | { tagAdd: string } | { tagRemove: string }
```

Heads, versions and the derived indexes (all written inside the commit transaction by
the `tree` module only; `casebook reindex` rebuilds them from commits; the fold-
equivalence test asserts `reindex(state) == state`):

```ts
// Exactly one per live document on main.
type Head = { id: Id; kind: Kind; path: Path; blob: Hash; claim: Hash; rev: Rev; attrs: Attrs }
// Temporal table: state of any document at any main revision r is the row with from <= r < to.
type DocVersion = { id: Id; blob: Hash; claim: Hash; path: Path; from: Rev; to: Rev | null; commit: Hash }
type Blob = { hash: Hash; bytes: CanonicalBytes }          // content-addressed; PK lookup by hash

// Derived, tree-owned:
type ChangeRow = { rev: Rev; id: Id; op: 'create'|'edit'|'move'|'remove'; before: Hash|null; after: Hash|null; by: Principal; cause?: Id }
                                                             // ordered by rev  => changes(since) is a range scan
type Link   = { from: Id; to: Id; kind: 'covers'|'uses'|'select' }                  // stored both directions
type Binding = { proof: ProofKey; case: Id<'case'> }                                  // UNIQUE(proof); violation => BindingConflict
type Watch  = { glob: Glob; case: Id<'case'> }                                        // reverse trie by literal prefix
type Member = { selection: Id<'set'|'gate'|'charter'>; case: Id<'case'> }             // maintained for StaticPred only
type Posting = { key: string; value: string; id: Id }                                 // tag/method/req inverted entries
type FolderStat = { path: Path; n: number; byMethod: Record<MethodKind, number> }     // counts before items
// + full-text index over Head (updated in the same transaction; store requirement)

// Branches / proposals: a proposal is an overlay over main@base.
type Proposal = {
  id: ProposalId; base: Rev; opener: Principal; why: 'policy'|'conflict'|'asked'
  commits: Hash[]; state: 'open'|'merged'|'rejected'|'superseded'
  conflicts: Conflict[]; decidedBy?: Principal; decidedAt?: Instant
}
// overlay rows: (proposal, id) -> DocVersion; reads fall through to main@base.
```

Rules enforced by the type and the `tree` module:
- `claimOf(case, tree)` is a pure function of the case's claim and its shared steps' `claim` hashes at the same tree state. Committing a shared step re-derives `claim` for dependents via the `Link(uses)` reverse index in the same transaction, and records a `ChangeRow` per dependent with `cause: sharedStep`.
- Moves keep `id`; `Path` is only a field of the version. Duplicate ids on import are rejected by `casebook check`.
- A `tag` is immutable; "the tree as released" is `Head` at that rev via `DocVersion`.

### 7.2 Evidence: one shape for all three methods

```ts
type Outcome = 'pass' | 'fail' | 'error' | 'skip' | 'block'        // error = infra/setup, not assertion
type ProofKey =                                                      // what produced a result; NOT a case id
  | { m: 'human'; case: Id<'case'> }
  | { m: 'code';  fw: Framework; key: TestKey }
  | { m: 'agent'; charter: Id<'charter'>; case: Id<'case'> }

type Run =
  | { kind: 'manual';  id: RunId; key: RunKey; tree: TreeRef; scope: Pinned[]; assign: Map<Id<'case'>, PersonId>; opener: Principal; state: RunState }
  | { kind: 'ci';      id: RunId; key: RunKey; tree: TreeRef; ctx: Required<Ctx>; opener: Principal; state: RunState }       // commit REQUIRED
  | { kind: 'session'; id: RunId; key: RunKey; tree: TreeRef; charter: Id<'charter'>; scope: Pinned[]; agent: Principal; state: RunState }
type Ctx = { commit: Sha; branch: string; pr?: string; build?: string; env: string; attemptOf?: RunId }
type Pinned = { case: Id<'case'>; claim: Hash }                       // scope is frozen at open
type TreeRef = { branch: 'main'; rev: Rev } | { branch: ProposalId; base: Rev }
type RunState = 'open' | 'closed'                                      // 'frozen' reserved (policy.freeze)

type Evidence = {
  id: EvidenceId                  // = H(run.key, proof, attempt, ordinal): deterministic => ingest is idempotent
  run: RunId; proof: ProofKey
  stamp: Stamp | null             // null when unbound at ingest: visible history, never counted as proof
  attempt: number
  outcome: Outcome
  failure?: { sig: Signature; kind: 'assert'|'infra'|'timeout'|'crash'; excerpt: BlobRef }
  by: Principal; at: Instant; durationMs?: number
  steps?: Array<{ step: StepId; outcome: Outcome; note?: string }>
  refs: ExtRef[]                  // defect links, artifacts, transcript
}
type Stamp = { claim: Hash; at?: Rev }                                 // claim hash of the case as bound at ingest
```

Why `ProofKey` and not a case id on the row: an automated test can report for
months before anyone links it. Evidence keeps the test's identity; the case reaches
it through `Binding`. Link later and the case immediately has that history. It does
*not* inherit pass-standing for hashes it was not stamped with (Integrity): history
is visible, proof is earned by a result stamped on the current claim.

### 7.3 Derived evidence state (owned by `evidence`, folded inside `record`)

```ts
// Per proof key: the entire flaky + health state. Bounded; this is the incremental aggregate.
type Health = {
  proof: ProofKey
  tape: TapeEntry[]               // ring, last K=32 non-infra outcomes: { commit, branch, claim, outcome, attempt, ev }
  byCommit: LruMap<Sha, Outcome[]>// last C=16 commits' outcomes, for signal 1 (same commit, mixed outcomes)
  state: 'stable' | 'suspected' | 'flaky'
  score: number; why: EvidenceId[]  // <= 5 evidence ids that justify the state (explainable)
  firstSeen: Instant; lastSeen: Instant; n: number; lastOutcome: Outcome
}

// What has this exact claim been proven by, ever and per commit.
type Standing = {
  proof: ProofKey; claim: Hash
  at: 'any' | Sha                  // two rows per result: one 'any', one for ctx.commit (CI)
  lastPass?: EvidenceId; lastFail?: EvidenceId; lastOutcome: Outcome; passedOnRetry: boolean; n: number
}
// commit-scoped rows are kept for recent/open-PR commits (default 30d) and for tagged releases;
// they are rebuildable from Run(commit) -> Evidence(run).

type RunTally = { run: RunId; byOutcome: Record<Outcome, number>; contested: Id<'case'>[] }
type Seen = { proof: ProofKey; firstSeen: Instant; lastSeen: Instant; hint?: Id<'case'> }  // the unbound inbox is Seen where no Binding
```

Required orderings of `Evidence` (both declared, not "later"): `(run, ordinal)` for run
views and ingest; `(proof, at desc)` for history beyond the tape. Everything hot
reads `Health`, `Standing`, `RunTally`, not raw rows.

`record` is idempotent by construction: it computes `evidence.id`, inserts the ones
absent (`insertIfAbsent` returns the newly inserted set), and folds **only** that
set. Re-sending a report folds nothing. A crash mid-batch rolls back that chunk's
transaction; the client retries the same chunk with the same ids.

### 7.4 Judgement and findings (human and agent decisions are data)

```ts
type Finding = {                                              // a reviewer's claim about a version; append-only
  id: FindingId
  on: { doc: Id; claim: Hash; step?: StepId }
  kind: 'weak-expectation'|'ambiguous-step'|'uncovered-path'|'cannot-fail'|'duplicate'|'break'|'other'
  text: string; repro?: string; severity?: 'low'|'med'|'high'
  by: Principal; at: Instant; session?: RunId
}
type Decision = {                                             // append-only; effective = latest per (subject, kind)
  id: DecisionId; by: Principal; at: Instant; reason: string  // reason REQUIRED for waive/quarantine/reject
  until?: Instant
  d: | { k: 'quarantine'; case: Id<'case'>; on: boolean }
     | { k: 'waive';      gate: Id<'gate'>; case: Id<'case'>; subject: Subject }
     | { k: 'reaffirm';   case: Id<'case'>; from: Hash; to: Hash }
     | { k: 'finding';    finding: FindingId; state: 'accepted'|'rejected'|'deferred'|'fixed' }
}
```
Two actors deciding on the same subject: both rows stay; the latest is effective;
the history shows the flip and who did it. No silent last-write-wins, no lock.
A review ledger is the join `Finding ⋈ Decision` keyed `(doc, claim)`; "fresh eyes"
is an op flag that ignores it.

### 7.5 Tracing the dominant access patterns

Each row names the structure, the cost class, and the budget it serves (budgets from
the vision, to be validated by the benchmark). None says "index later".

| Pattern | Path through the structures | Cost | Budget |
|---|---|---|---|
| **Read one case** | `Head[id]` -> `Blob[head.blob]`. Specific version: `DocVersion` (id, from<=r<to) -> `Blob`. | 2 key lookups | p95 < 20 ms |
| **List a folder page** | Range scan `Head` by `Path` prefix with a keyset cursor; counts from `FolderStat`, not by counting. | O(page) | < 50 ms |
| **Search** | Full-text index over `Head` + `Posting` for filters; both written in the commit txn. | O(hits page) | < 100 ms |
| **Save one case** | `commit`: validate -> policy route -> check base -> 3-way merge if head moved -> append `Commit` -> update `Head`/`DocVersion`/`ChangeRow`/`Link`/`Binding`/`Watch`/`Member`/`Posting`/`FolderStat`/FTS, one txn. Work is proportional to touched docs. | O(1 doc) | < 50 ms |
| **Bulk edit 1,000** | One `Commit` with 1,000 targets; the derived writes are set-based batches in one txn. | O(n), one round trip | < 1 s |
| **Execute a run** | `record` with an empty result list opens the run: resolve `Member`/`StaticPred` -> pin `(case, claim)`. Cockpit reads `Blob` by hash (version-exact). `record` appends + folds `RunTally`. | O(1) per result | no spinner |
| **Ingest 10k results** | parse (pure, outside the txn) -> batch `Binding` lookup for distinct proofs -> `insertIfAbsent` Evidence -> `foldHealth`/`foldStanding` per *distinct* proof over the new set -> `Seen` upserts -> `RunTally` -> one txn per <= 2k-row chunk. No per-row round trip. | O(results) | ack < 2 s, visible < 5 s |
| **Flaky state on ingest** | `Health` is the aggregate: `tape` + `byCommit` are bounded, so the fold reads one row per proof and writes it back. Quarantine reads `Decision`. | O(distinct proofs) | within seconds, no nightly batch |
| **Impact set for a change** | changed paths -> `Watch` reverse trie (+ test-file adjacency from `Binding` keys); PR/commit trailers or description -> `Link(covers)` reverse for reqs; union -> join `Health`/`Standing`/`Change` for signals -> pure `rank()`. | O(changed paths + hits) | agent job budget |
| **Changed-since for an agent** | `ChangeRow` range scan `rev > cursor`, filtered by scope (path prefix / req / set) in the scan. Cursor is one integer. Unchanged reads use `blob`/`claim` hash (`ifNoneMatch`). | O(changes since), never O(suite) | tokens |
| **Traceability chain** | req -> `Link(covers)` reverse -> cases -> `methods` -> `ProofKey`s -> `Standing`/`Health` (current claim) -> `Run` (commit, build) -> `Evidence.refs` (defects). Reverse direction by the same indexes. | one keyed hop per link | "every hop one click" |
| **Gate status read by CI** | `Member(gate)` (StaticPred, maintained) ⋈ `Binding` ⋈ `Standing(claim=Head.claim, at=commit or tag)`; minus active `Decision` (quarantine, waive) -> pure `judgeGate(rules, rows)`. One set-based query, no scan. | O(required set) | < 50 ms @ 10k required |
| **Coverage / gap list per release** | For each req: `Link(covers)` reverse; `Standing(claim as of tag, at 'any')` via `DocVersion` at the tag's rev. | O(reqs x cases) keyed | seconds |
| **Unbound inbox** | `Seen` rows with no `Binding`; kept small because tree commits emit a `Δbindings` event that `evidence` consumes in the same txn to drop resolved rows (§8.2). | O(inbox) | instant |

If the gate join misses its budget at scale, the fix is a maintained `GateTally`, a
pure fold over the same `Standing` rows. The structure supports it; nothing about the
model changes. That is the test of "not a retrofit".

### 7.6 Shared state: who can write what

| State | Writers | If two write at once |
|---|---|---|
| Doc content (`Head`, commits) | any principal with `author`, via `commit` | Base hash is checked. Disjoint fields merge; same field => later save becomes a `Proposal{why:'conflict'}`, both versions kept. |
| Evidence | one writer per row (the recorder); rows are never updated | Both appended. `RunTally.contested` if outcomes differ for the same pinned case. |
| Decisions, Findings | any principal with `decide`/`flag` | Both appended; latest effective; history shows the flip. |
| Run scope | opener, at open only | Immutable after open. |
| Policy / gates | `admin` only | Same base-check as docs. |
| Derived state | its owning module only, in-txn | N/A; rebuilt by `reindex`. |

---

## 8. Operation layer and module map

### 8.1 One surface

```ts
interface OpCtx { who: Principal; scope: Scope; opId: OpId; now: Instant }
type Op<I, O> = (ctx: OpCtx, input: I) => Promise<Result<O, OpError>>   // no transport types

// 14 ops. Schemas are defined once; OpenAPI, MCP tool defs, CLI help and the command
// palette registry are generated from them (P3). Reads first.
declare const ops: {
  // reads
  find:    Op<FindIn, Page<Card>>                 // list + search + folder browse: one op
  read:    Op<ReadIn, Array<Doc | Unchanged>>     // batch; fields projection; ifNoneMatch; at?: Rev|Tag
  changes: Op<ChangesIn, ChangeFeed>              // since a rev, scoped
  impact:  Op<ImpactIn, ImpactSet>                // from {pr|commit|paths|req}
  trace:   Op<TraceIn, Chain>                     // req <-> case <-> run <-> commit/build <-> defect
  status:  Op<StatusIn, Status>                   // union: coverage | gate | failures | inbox | run | health
  export:  Op<ExportIn, TextStream>               // plain-text tree + evidence JSONL
  // writes
  commit:  Op<CommitIn, CommitOut>                // the ONLY way to change the tree
  resolve: Op<ResolveIn, ResolveOut>              // accept | reject | amend a Proposal or conflict
  record:  Op<RecordIn, RecordOut>                // manual click and 10k CI ingest are the same op
  flag:    Op<FlagIn, FlagOut>                    // findings, ids back, no echo
  decide:  Op<DecideIn, DecideOut>                // quarantine | waive | reaffirm | finding state
  grant:   Op<GrantIn, GrantOut>                  // principals, tokens, scopes
  import:  Op<ImportIn, ImportOut>                // archive / TestRail / CSV via `formats`
}
```

MCP exposes the first six reads plus `commit, resolve, record, flag, decide` (11 tools);
`export`, `import`, `grant` are admin scope and not in a default agent's tool list.
Tool definitions are budgeted (target <= 2.5k tokens total; to verify, decision 0006).

Key signatures (selected fields; transport-free):

```ts
type FindIn  = { q?: string; where?: StaticPred | Pred; under?: Path; fields?: Field[]; limit?: number; cursor?: Cursor; at?: Rev|TagName }
type Page<T> = { total: number; items: T[]; cursor: Cursor | null; rev: Rev }          // counts first

type ReadIn  = { ids: Id[]; fields?: Field[]; at?: Rev | TagName; ifNoneMatch?: Record<Id, Hash> }
type ImpactIn = { of: { pr: string } | { commit: Sha } | { paths: Path[] } | { req: Id<'req'> }
                  skipReviewed?: boolean; freshEyes?: boolean; limit?: number; fields?: Field[] }
type ImpactSet = { rev: Rev; total: number; skipped: number; items: Array<{ id: Id<'case'>; claim: Hash; signals: Signal[]; score: number }>; cursor: Cursor|null }

type CommitIn  = { opId: OpId; reason?: string; changes: NonEmpty<Change>; asProposal?: boolean }
type CommitOut =
  | { landed: 'main';     rev: Rev; hash: Hash; ids: Id[] }
  | { landed: 'proposal'; proposal: ProposalId; why: 'policy'|'conflict'|'asked' }
  | { rejected: Rejection[] }     // StaleBase | BindingConflict | RepoOwned | Protected | UnknownRef | Invalid{path,why}

type RecordIn  = { run: RunSpec; results: Result1[]; final?: boolean }   // RunSpec idempotently opens/finds the run by RunKey
type RecordOut = { run: RunId; scope?: Pinned[]; inserted: number; duplicate: number; unbound: number; tally: RunTally; gate?: GateBrief }
```

### 8.2 Module map and state ownership

```text
                     shells (thin, no logic)
   web UI      REST      MCP      CLI      CI action        <- all call `ops`
      \          \        |        /          /
       +----------+-------+-------+----------+
                          ops            validate at boundary -> authorize -> compose modules -> one txn
        ______________________|______________________
        |          |            |            |        |
      tree      evidence    judgement      ident    gate (pure over reads)
      owns:     owns:       owns:          owns:
      Commit    Run         Finding        Principal, Token, Grant
      Head      Evidence    Decision
      DocVersion Health
      Blob      Standing
      ChangeRow RunTally
      Link      Seen
      Binding
      Watch
      Member
      Posting
      FolderStat
      Proposal
        |
   pure libraries (no I/O, import nothing stateful):
     doc      parse/print canonical form, claim/meta split, claimHash, diff, 3-way merge
     policy   route(change, who, policy) -> Main | Proposal | Reject ; gate rule evaluation inputs
     fold     foldHealth, foldStanding, foldTally, rank(signals), judgeGate
     formats  junit / ctrf / playwright / trx -> NormalizedReport ; testrail/csv -> Archive ; archive <-> git dir
     query    StaticPred/Pred compile + evaluate
   store      transaction + ordered range scans + full text, embedded or server (two engines allowed behind this)
   jobs       persisted, idempotent: status push to GitHub, mount sync, export, notifications
```

Module rules (single owner per fact):
- Only `tree` writes tree state; only `evidence` writes evidence state; no module imports another module's tables. Cross-module needs go through `ops` composition or through one named channel.
- **The only tree -> evidence channel** is `Δbindings` (bindings added or removed by a commit). `ops.commit` calls `tree.apply` and then `evidence.onBindings(Δ)` in the same transaction; `evidence` uses it to clear resolved `Seen` rows. Nothing else crosses.
- `gate` is not a store; it reads `tree` and `evidence` through their read APIs and applies `fold.judgeGate`.
- Internals are not importable: each module exports its read API and `apply`; the only public entry to the product is `ops`. A lint (P8) fails on imports that skip `ops` from shells.
- Derived writes happen in the same transaction as the source write (P2); jobs never carry correctness.

### 8.3 Pseudocode for the tricky parts

```ts
// ops.commit: the whole write path of the tree
async function commit(ctx: OpCtx, input: CommitIn): Promise<Result<CommitOut, OpError>> {
  const seen = await idem.get(input.opId); if (seen) return seen           // replay => same answer
  authorize(ctx, 'author', input.changes)                                   // scope check, incl. Protected docs
  return store.tx(async tx => {
    const plan = policy.route(input, ctx.who, await tree.policyAt(tx))      // Main | Proposal(why) | Reject
    const checked = await tree.check(tx, input.changes)                     // unknown refs, binding uniqueness, owner (RepoOwned), step ids
    if (checked.rejections.length) return reject(checked.rejections)

    // staleness: each target names its base. If head moved, merge field-wise.
    const merged = []
    for (const t of expandTargets(input.changes)) {
      const head = await tree.head(tx, t.id)
      if (head.blob === t.base) { merged.push(applyOps(head, t.ops)); continue }
      const m = doc.merge3(await tree.blob(tx, t.base), head.doc, applyOps(base, t.ops))
      // TODO: step-level merge by StepId; same-field edits on the same step are a Conflict, not an auto-pick.
      if (m.conflicts.length) plan = Proposal('conflict', m.conflicts)
      else merged.push(m.doc)
    }
    const c = tree.append(tx, plan, merged, ctx, input)                     // Commit row; Head/DocVersion/... only if plan is Main
    if (plan.landsOnMain) {
      await evidence.onBindings(tx, c.bindingDelta)                         // the only cross-module channel
      // NOTE: dependents of an edited shared step have their claim re-derived inside tree.append
    }
    await idem.put(tx, input.opId, c.out)
    return ok(c.out)
  })
}

// fold.foldHealth: the whole flaky algorithm; pure, bounded state
function foldHealth(h: Health, batch: Evidence[], p: FlakyParams, defaultBranch: string): Health {
  for (const e of batch) {                                                  // already sorted by (run.at, ordinal)
    if (e.outcome === 'skip' || e.outcome === 'block') continue
    if (e.failure?.kind === 'infra') { h = noteInfra(h, e); continue }       // infra never drives flakiness
    h.byCommit.push(e.ctxCommit, e.outcome)
    h.tape.pushRing({ commit: e.ctxCommit, branch: e.branch, claim: e.stamp?.claim, outcome: e.outcome, ev: e.id })
  }
  // signal 1 (strong): same claim, same commit, both pass and fail (retry or rerun)
  const strong = h.byCommit.entries().filter(([c, os]) => os.has('pass') && os.has('fail') && sameClaim(h, c))
  // signal 2: on the default branch, transitions pass<->fail over the last W entries with one claim hash
  const flips = transitions(h.tape.filter(t => t.branch === defaultBranch).lastWithSameClaim(p.window))
  // signal 3 (weak, only supports): failure signature changes between failures
  // TODO: decide whether signal 3 can move suspected -> flaky or only raise the score.
  const state = strong.length >= p.strongToFlaky ? 'flaky'
              : flips >= p.flipsToFlaky ? 'flaky'
              : flips >= p.flipsToSuspected || strong.length >= 1 ? 'suspected' : 'stable'
  // leaving flaky/suspected: p.cleanToStable consecutive passes on one claim; never silent in the UI (history row)
  return { ...h, state, score: score(strong, flips, h), why: pickEvidence(h, strong, flips) /* <= 5 ids */ }
}

// ops.record: manual click and CI ingest
async function record(ctx: OpCtx, input: RecordIn): Promise<Result<RecordOut, OpError>> {
  authorize(ctx, 'record', input.run)
  const results = input.results                                             // already NormalizedReport items (formats is outside the txn)
  return chunk(results, 2000).reduceAsync(async (acc, rows) => store.tx(async tx => {
    const run   = await evidence.openOrFind(tx, input.run, ctx.who)         // idempotent by RunKey
    const proofs = distinct(rows.map(r => r.proof))
    const bind  = await tree.bindings(tx, proofs)                           // Map<ProofKey, {case, claim}>  (batch)
    const evs   = rows.map(r => mkEvidence(run, r, bind.get(r.proof), ctx))  // id = H(runKey, proof, attempt, ordinal); stamp null if unbound
    const fresh = await evidence.insertIfAbsent(tx, evs)                    // returns only newly inserted rows
    await evidence.fold(tx, fresh)                                          // Health, Standing(any + commit), RunTally, Seen, via fold.*
    return acc.add(fresh.length, evs.length - fresh.length)
  }))
  // crash between chunks: client resends everything; chunks already applied insert nothing.
}

// fold.judgeGate: pure; the CI status text is a rendering of its output
function judgeGate(g: GateDoc, rows: GateRow[], decisions: ActiveDecisions): Verdict {
  const reasons: Reason[] = []
  for (const r of rows) {                                                   // one row per selected case, claim-current
    if (decisions.waived(g.id, r.case)) continue
    for (const rule of g.require.filter(matches(r))) {
      const proof = best(r.standing, rule.proven_by, rule.on, rule.within)
      if (!proof)                       reasons.push({ case: r.case, why: 'no-proof' })
      else if (proof.lastOutcome==='fail' && !decisions.quarantined(r.case)) reasons.push({ case: r.case, why: 'failing', ev: proof.lastFail })
      else if (stale(proof, rule))      reasons.push({ case: r.case, why: 'stale' })
    }
  }
  return { verdict: reasons.length ? 'hold' : 'pass', because: top(reasons, 20), total: reasons.length /* + counts */ }
  // TODO: 'fail' vs 'hold': a failing required case is 'fail'; missing proof is 'hold'. Confirm with Daniel (open question 12 default).
}

// impact(): ranking is pure and explainable
function rank(signals: Signal[]): number { /* TODO: weights; start: failing > changed-path > flaky > uncovered-req > long-unrun; tune on benchmark */ throw new Error('not implemented') }
```

Idempotence and crash behaviour in one line each: `commit` is replayed from `opId`;
`record` from deterministic evidence ids; `resolve` from proposal state; `import` is
chunked and resumable by archive hash and commit hash (existing commit hashes are
skipped); `decide`/`flag` carry `opId`. Jobs are idempotent consumers of the log.

---

## 9. Product surface

Objects the user lives in: **Suite** (the tree), **Case**, **Run** (of any kind),
**Gate/Release** (a tag + gates), **Inbox**, **Command bar**. Five screens, no
"manual / automation / AI" tabs.

1. **Suite.** Left: folder tree with `FolderStat` counts. Centre: the case editor (outline, in place, autosave). Right (collapsible): history with diff. Every row carries the **proof strip**: one glyph per method the case has.

```text
 /checkout
   ▸ Refund a paid order          H ✓ 2d   C ✗ 1h   A ·        flaky?        q_41x8aw
   ▸ Partial refund               H ·      C ✓ 3h   A ✓ 1d
   ▸ Refund after 30-day window   H ·      C -      A ✗ 1d     (finding f_h72k)
 H = human   C = code   A = agent.   ✓ proven on THIS claim, ✗ failing, ~ proven on an older claim (stale), · never, - no such method
```

2. **Case.** One page: claim (steps/expected), methods side by side (human: how to run; code: the bound test key and where it last ran; agent: its charter), and **one timeline** of evidence from all methods plus versions, findings and decisions interleaved. This is where the three layers appear as one thing.
3. **Runs.** One list, filterable by kind (manual / CI / agent session). Manual run: keyboard cockpit (§5.4). CI run: the failure digest first (new / flaky / known), raw rows on demand. Agent session: the charter, the pinned scope, evidence and findings it produced, tokens served. Same header, same tally.
4. **Release.** Pick a tag or a commit and a gate. Rows are **requirements**, columns the proof strip, plus the verdict with ranked reasons, each reason one click to the case/evidence. The gap list is a filter on the same table. This is the lead's and the auditor's screen, readable free (P7).
5. **Inbox.** One queue: unbound tests (with the `@c_id` suggestion), proposals (agent or conflict), findings awaiting triage, quarantine suggestions. `j/k`, `a` accept, `x` reject (reason prompt only when policy requires it), `l` link.

Settings is a folder of documents (policy, gates, sets) edited with the same editor.
The command bar (`⌘K`) reaches every op; it is also how a new user discovers features.

---

## 10. Agents in the tree

An agentic test is a **charter** (a document) plus a **session run** (pinned scope +
evidence). `record({ run:{kind:'session', charter}, results:[] })` freezes the selected cases at their
claim hashes and returns the "map"; the agent works outside Casebook with its own
tools (non-goal: Casebook does not run the software); it posts evidence in one
`record` batch and findings in one `flag` batch. A finding that becomes a case is a
`commit` linked to the finding. An agent method on a case (`{m:'agent', charter}`) lets
coverage and gates count a session's pass as proof on equal terms with a human's or a
CI test's, if the gate's `proven_by` says so. Whether a gate *should* accept agent
proof is a policy choice of the team, visible in the gate document.

---

## 11. Challenges to existing decisions and docs

| Replaces / refines | With | Why | Cost |
|---|---|---|---|
| Vision rank: speed > agents > UX | Integrity > speed (latency + tokens) > agents > UX | 0004 already forbids silent overwrite; rank makes tie-breaks consistent | A conflict dialog may cost a click that "pure speed" would skip |
| Vision principle 4 "link, not ticket; tracker is the source" (open Q16) | Requirements are documents: `native` or `external` stub (system, key, url, cached title); tracker remains truth for external ones | Traceability views need a queryable node even for teams with no tracker | A stub can go stale; refresh job + `cachedAt` shown |
| 0001 stack criteria | Adds: temporal (interval) rows or equivalent, ordered range scans, in-transaction full text, set-based inserts. Still no stack chosen | The structures in §7 need them; benchmark must test them | Narrows candidates slightly |
| 0006 "findings model phase 2 or 3" | Findings and decisions in slice 1 | Agent token savings (A5) depend on the ledger; cheap to build with commits | More slice-1 surface |
| 0002 "embedded database and local files" for Local | Embedded store only; files appear via `export`/mount | Two storage forms would be two ways | No "edit with my editor" in slice 1 (comes with `repo` mount) |

Unchallenged and kept as constraints: layered self-hosting; one model with policy
switches; multi-user, no live co-editing, online-first with small allowance; software
QA only; teams in general; token efficiency as a budgeted property.

---

## 12. First deliverable slice (not a bad product)

In (Local first, same artifact runs Server):
- `casebook` binary: serve, `init`, `new`, `find`, `report`, `check`, `fmt`, `export`, `import`, `token`, `mcp` (stdio), `bench`.
- Tree: `case`, `shared`, `req` (native + external stub), `set`, `gate`, `policy` documents; `commit` with base-check, field-level merge, proposals under `review: none|agents|all`; history, diff, restore, tags (releases).
- Editor UI with outline capture, autosave, undo, command bar, Suite/Case/Runs/Release/Inbox.
- Manual runs with the keyboard cockpit; `record` for manual and CI (JUnit; one JSON format after verification; CTRF only if verified alive); `@c_id` annotation hints; unbound inbox; flaky detection with evidence; quarantine; commit-status job for GitHub; `casebook-report` GitHub Action.
- `impact` (watch globs + req trailers + test-file adjacency), `changes`, `trace`, `status`, findings and ledger; MCP over HTTP with scoped tokens and a shipped `SKILL.md`.
- Import: TestRail export and CSV. Export/import round-trip test.
- Budgets as failing tests: latency set, ingest 10k, rebuildability, 5-minute start, MCP tool-list size.

Deliberately out (the types already allow them):
`repo` and `upstream` mounts; charter authoring UI beyond the editor (charters work, sessions record, nothing orchestrates agents); freeze/sign-off/run approval (policy fields reserved, enforcement not built); Qase and ADO importers; Jira/ADO two-way sync (URL links only); offline queue beyond draft survival; SSO/SCIM; custom reports beyond Release and health lists; notifications beyond Inbox; Cloud-layer workers (prove by running the same artifact on a server DB, per 0002).

---

## 13. Red-flag self-screen

- *Shallow modules:* `commit` hides routing, merge, binding checks, claim re-derivation, six derived writes; callers see one input. `record` the same for ingest.
- *Information leakage:* the claim/meta split lives in `doc` only; hashing rules are in one function. Field classes are declared once on the type.
- *Temporal decomposition:* modules are by owned fact (`tree`, `evidence`, `judgement`, `ident`), not by phase (parse, store, notify).
- *Pass-through:* shells hold no logic; `ops` validates and composes, nothing else.
- *Split ownership:* `Seen`/`Binding` was the risk (unbound inbox written by two modules); resolved by the `Δbindings` channel, the single cross-module edge.
- *Two ways to one task:* binding has one path (declared `methods.code`; annotations only produce suggestions); editing has one path (`commit`); a result has one path (`record`).
- *Importable internals:* only `ops` is public; a lint enforces it.
- *Hand-synced lists:* none; folder counts, links, membership are in-txn folds with `reindex` equivalence tests.
