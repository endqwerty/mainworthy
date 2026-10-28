# Strategy review, 2026-10-27

Where Mainworthy stands 18 days in, how far it drifted from the plan of 2026-10-10, what the market looks like now
(test management tools, the test features CI and observability vendors sell, AI testing platforms), a SWOT turned into
moves, and what we would do differently from day 1.

The raw research is in [research/strategy-2026-10-27/](research/strategy-2026-10-27/): one file per slice, every claim
with a link and "verified 2026-10-27" (read on the vendor's own page) or "reported" (search snippet or third party).
The four research files were gathered by Claude Sonnet 5.5 workers; this page, the drift numbers and the spot checks are
Claude Opus 5.5's. [competitive-analysis.md](competitive-analysis.md) is the 2026-10-10 baseline; section 3.4 lists its
corrections.

## The conclusion first

Mainworthy built what the plan asked for, and built far more around it, for no one in particular. The parts it set out
to make different (case versions pinned to results, one stream for manual and automated results, agents as users with
their own identity) are still different. The parts that look like differentiators on a feature grid (an MCP server,
flaky detection, quarantine) were matched or given away by others in the last year. The largest risk is not a
competitor. It is the view, the most common one in the user voice we collected, that a team does not need a test case
manager at all.

The owner's three biggest decisions, each open:

1. **Who is it for?** Decision 0005 says "teams in general". Section 5 proposes three narrower customers and recommends
   one. Every other choice below depends on this one.
2. **Is the headline "tests a person or an agent runs, with the evidence"?** ThePrimeagen's Oligarchy (section 3.3)
   shows a team building exactly that record for its own agents in a month, without a test management tool. That is
   both the best opening found and proof that the data model alone is no moat.
3. **What to stop.** The native iPhone app, passkeys and SSO, teams (M8) and the loose-to-regulated policy spectrum
   all serve customers no one has yet. Freezing some of them until a user asks is the cheapest way to get back on
   track. Which ones is the owner's call; section 6 says what each costs.

## 1. The track: what the plan said on 2026-10-10

[product-vision.md as of 2026-10-10](https://github.com/endqwerty/mainworthy/blob/a78b0ad9/docs/product-vision.md) ranked
three priorities: a fast backend, first-class agent access, and a UI that gets out of the way while a person moves
knowledge from their head into steps. Four core capabilities sat beside them: case versioning, CI ingestion, manual and
automated tracking in one stream, and automatic flaky detection. The roadmap's phase 0 was a hands-on audit of the
incumbents with measured baselines, before building.

## 2. Where the work went

All counts are from `origin/main` at `4091fde9`. The commands are in [Reproduce](#reproduce).

### 2.1 What stayed on track

Every priority and core capability has shipped in some form:

- one operation registry behind HTTP, OpenAPI, the CLI, MCP and the web client (`src/server/ops/index.ts`);
- append-only case versions, with runs and results pinned to the version they ran;
- CI ingestion of JUnit XML, Playwright, Jest, Vitest, pytest and TRX (`docs/guide/report-results.md`);
- flaky detection from same-code flips (decision 0045), one CI rerun to tell a flake from a broken commit (0128) and
  quarantine with an explicit exit rule (0085);
- agent tokens, edit scopes (0044) and the model named on each agent result (0116).

That is a lot for 18 days. The drift is in what was built around it.

### 2.2 Drift, measured

| Measure | Value | Why it matters |
| --- | --- | --- |
| Commits on `main` | 1,489 in 18 days | Building speed is real |
| Commits that touch no product code (`src/`, `ios/`) | 621 (42%) | Process, docs, CI and deploy work took almost half of the commits |
| Lines of tests / lines of `src/` | 106,559 / 97,593 | More test code than product code, for a product with no outside user |
| Decision records | 142 files, dated 2026-10-09 to 2026-10-27 | About eight a day; 7 say they were superseded |
| Lines in `docs/diagrams/` | 143,063 | Larger than all of `src/` |
| Native iPhone app | 27,425 lines, 180 commits, started on day 4 | A second client before a first user |
| Identity work | 0017, 0029, 0062, 0067, 0072, 0086, 0093, 0096, 0121, 0122, 0140, 0145 | Passwords, recovery, second factor, mail, SSO, passkeys and native sign-in, all before anyone outside signed in |
| Store | SQLite chosen 2026-10-12 (0010), PostgreSQL landed 2026-10-24 (#901), Cloud Run planned | The arena measured single-node speed; the deciding force was deployment shape |
| Phase 0 | not done (roadmap: "no hands-on audit ... and no measured baselines against the incumbents") | No measured comparison with any rival exists |
| "The owner's notes" in `competitors.md` | empty | The most authoritative input was never written down |

Commits per day touching product code against those that did not, from the first commit to today:

```
10-09   0/1   10-13 117/47   10-17  72/23   10-21  28/30   10-25  30/66
10-10   0/11  10-14  71/18   10-18  57/18   10-22 114/72   10-26  14/20
10-11   0/11  10-15 111/52   10-19   4/3    10-23  60/65   10-27  36/41
10-12  29/37  10-16  25/27   10-20  71/50   10-24  29/29
```

Since 2026-10-23 more commits have gone to process and infrastructure than to the product on most days.

### 2.3 Where it got off track, ranked

1. **No customer, so no limit on scope.** Decision 0005 chose "teams in general" and 0003 chose "the process
   spectrum, loose to regulated". With no one to say "not needed", every capability a customer anywhere might want
   became a milestone: teams, roles, SSO, a phone layout, an iPhone app, disputes, inherited excuses.
2. **The comparison that would have focused it was skipped.** Phase 0 asked for hands-on baselines; decision 0009,
   answer 13 ruled out trial accounts. No one loaded this repository's own CI output into Buildkite, Trunk or Qase to
   see what they already do for free.
3. **Rigour sized for a mature product.** Budgets, audits, decision records and test layers suited to a product with
   users and a team were added from day 3. The owner has started to correct this: budgets that warn instead of fail
   (2026-10-24), "Only guard if it's absolutely critical to do so" (2026-10-25), browser tests once per pull request
   (2026-10-27).
4. **Our own words, not the market's.** The guide uses "slot" 158 times, "excuse" 40, "dispute" 23 and "cockpit" 13,
   and "test plan" not once. TestRail, Xray and Azure Test Plans all sell plans. A buyer searching for what they know
   will not find us, and a new user has to learn a model before doing anything.
5. **Stack churn.** SQLite to PostgreSQL to Cloud Run in 12 days. The arena was rigorous about the wrong question.

## 3. The market on 2026-10-27

Inclusion rule for a competitor: a small-to-mid software team could plausibly use it instead of adopting Mainworthy
for at least one of these jobs: author manual cases, see automated results and history across CI runs, detect or
quarantine flaky tests, decide release readiness, let an AI agent author or run tests.

The market is three groups, and Mainworthy sits where they overlap.

### 3.1 Test management tools: MCP is now table stakes

Re-checked for all 13 tools from the 2026-10-10 analysis ([tcm-recheck.md](research/strategy-2026-10-27/tcm-recheck.md)).
No list prices changed. Agent access did:

| Tool | MCP server | Can it write? | Permission model |
| --- | --- | --- | --- |
| Qase | official, MIT, 42 tools | yes, 32 write tools | acts as one person; hosted server needs a paid plan |
| Testiny | official, 15 tools | yes, with an `_etag` conflict check | API key or OAuth |
| PractiTest | official, hosted, 18 tools | yes, 8 write tools | OAuth, Corporate licences only |
| Allure TestOps | built in since 26.1.1, 13 tools | yes, 8 write tools | personal API token, no read-only mode |
| Testomat.io | vendor repository | yes; `--tools read` for read-only | project token or OAuth 2.1 |
| Azure DevOps | official, Microsoft-hosted | yes, creates cases and runs | per-tool read-only flags, `X-MCP-Readonly`, Entra scopes |
| TestRail, Testmo, Xray | closed betas | unknown | OAuth (TestRail, Testmo) |
| qTest, Zephyr | official, tool lists unpublished | reported yes | bearer token (qTest) |

What is still missing everywhere: agent identity as a first-class actor in case history. Qase records agent changes in
its audit trail as the person the agent acts for and lists "agent traces" as planned. No vendor separates the agent
from the person in history, scopes an agent to one project's authoring, or measures what an agent job costs in tokens.
Mainworthy does all three. Versioned case history is still behind a paid or top tier in six tools (TestRail, Xray,
Testomat.io, PractiTest, Testiny from Starter, Qase by retention).

Ownership is consolidating: TestRail, Testmo and Xray are one company (Sembi, owned by Idera) and ship the same kind
of closed-beta MCP. SmartBear owns Zephyr and QMetry.

### 3.2 CI and observability vendors: flaky detection is given away

([ci-vendors.md](research/strategy-2026-10-27/ci-vendors.md))

| Vendor | Product | Manual cases | Flaky detection | Quarantine | Agent access | Free tier | Lock-in |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Buildkite | Test Engine | no | yes, several methods | yes; automatic rules on Enterprise | MCP `list_tests` | 250k executions/month, 24 h history | low: JUnit upload from any CI |
| CircleCI | Test Insights, Smarter Testing | no | same commit pass and fail within 14 days | none found | MCP `find_flaky_tests` | flaky detection capped at 5 tests | high |
| Datadog | Test Optimization | no | Early Flake Detection | yes, by policy | MCP flaky tools | none found; $20/committer/month | low, but the best features need its SDKs |
| Azure DevOps | Test Plans + Pipelines | yes, full | in Pipelines results | suppress from summary | remote MCP with write | 5 Basic users | Test Plans $52/user/month |
| Sentry | (Codecov) | no | n/a | n/a | Sentry MCP has no test tools | n/a | sold Codecov to Harness on 2026-06-02 |
| GitHub | Actions, Copilot | no | none native | none | MCP reads logs only | n/a | n/a |

Others that meet the inclusion rule ([candidates.md](research/strategy-2026-10-27/candidates.md)): Trunk Flaky Tests
(free up to 5 committers, MCP, autofix agent), Mergify (free up to 5 contributors, JUnit path, quarantine), Currents
(Playwright and Cypress, MCP on every plan), Cypress Cloud, BrowserStack Test Reporting & Analytics (accepts JUnit
without its device cloud), Gradle Develocity and CloudBees Smart Tests (enterprise, JVM-leaning), ReportPortal (the
open-source, self-hosted results store).

Two readings. First, a team that only automates can get flaky detection and quarantine free or cheap from a tool it
already uses, so Mainworthy cannot lead with them. Second, only Azure DevOps joins manual cases to CI results, and it
costs $52 a user a month and pulls the team into Azure. Joining the two is still open ground.

Vendor churn is itself a fact to use: Sentry sold Codecov to Harness, Microsoft retired Playwright
Testing (reported, 2026-03-08), and Octomind shut down (reported; sources disagree on 2025 or 2026). A team burned by
that has a reason to want something it can host.

### 3.3 AI testing platforms, and Oligarchy

The AI-native group sells outcomes: QA Wolf (per run, MCP for Claude Code and Codex), Momentic (credits, triage agent
with quarantine), TestMu AI, formerly LambdaTest (test manager with 22 MCP tools plus the KaneAI agent), BrowserStack
Test Management (official MCP), and Playwright's free planner, generator and healer agents. TestCollab ships an
open-source, self-hostable MCP server with 17 tools.

**Oligarchy** is the project the owner asked about. Omarchy announced on
[2026-09-26](https://omarchy.org/news/2026/09/theprimeagen-joins-omarchy-core/) that ThePrimeagen joins Omarchy Core
"to lead Agentic QA" so that "every Omarchy release has had a swarm of agents check everything", and that Oligarchy is
"a custom agent harness that boots Omarchy in QEMU virtual machines and lets agents drive them just like a person
would". The post links `github.com/ThePrimeagen/Oligarchy`, which returns 404 today. A public copy,
[rustybladerunner/Oligarchy](https://github.com/rustybladerunner/Oligarchy), holds 289 commits, by ThePrimeagen and
Cursor Agent (2026-08-28 to 2026-09-19) and has no licence file, so it is visible source but not shown to be open
source. We read the copy's `AGENTS.md`, `ctrl.md`, `ctrl-diagnose.md` and migrations, and checked nothing about how
the copy came to exist.

What it is, from its own docs:

- A test definition is a name, description, instruction and **proof** ("what had to be on screen for a pass").
  Definitions are versioned, never edited in place, and every result pins the version it ran.
- A run has one result per definition; a result has a session holding every key and mouse action, every screenshot,
  the guest's serial console and the logs.
- A **driving agent** runs the test and records a verdict. A separate **diagnosing agent** reads the session back,
  must look at the last screenshot before any verdict, and files one diagnosis naming a cause from a controlled list of
  error types ("There is no `other` or `unclassified`: name the cause").
- Each result is a Linear ticket. The store is PostgreSQL. The stack is Bun, Effect and Cloudflare.

This matters for Mainworthy in two ways. It is the plainest example yet of a manual test case whose tester is an agent:
instruction, expected proof, recorded evidence, a verdict and an independent check of the verdict. Mainworthy's case
model, result stream and agent identity fit that shape closely. And it is a team that needed that record, did not
reach for any test management tool, and built a ten-table version in a month with agents. The data model is not a
moat.

### 3.4 Corrections to competitive-analysis.md

From [tcm-recheck.md](research/strategy-2026-10-27/tcm-recheck.md):

- Finding 5 (MCP): the list of tools with MCP and "depth unknown" are both out of date; see section 3.1.
- Finding 1 (history gated): add PractiTest (Corporate only). qTest documents versioning with approval and names no
  tier.
- Testiny: $18.50/$20.50/$30 are monthly-billing prices; annual is $15.42/$17.08/$25.
- Qase: the free plan must run its MCP server itself with a token; the hosted server needs a paid plan.
- TestRail: the pricing page lists "MCP Server" on every plan, but the MCP page says closed beta by application.
- Kiwi TCMS is GPL-2.0.

## 4. What users say

From 60 quotes with links and dates ([primeagen-and-voice.md](research/strategy-2026-10-27/primeagen-and-voice.md),
part 2). G2, Capterra and Reddit blocked automated reading, so low-star review text is thin and the sample leans to
Ministry of Testing and Hacker News.

| Theme | Quotes |
| --- | --- |
| "Don't need a test case manager" (tests in code, markdown, the issue tracker) | 18 |
| UX | 9 |
| AI | 9 |
| Flaky tests | 7 |
| "Keep one" (regulated, scale, proof, visibility) | 7 |
| Price and seats | 6 |
| Speed, versioning and history, Jira coupling | 4 each |

The strongest of them:

- "Test code is the living documentation." ([Ministry of Testing, 2025-04-24](https://club.ministryoftesting.com/t/is-test-case-management-dead/84370))
- "I've used a bunch of these, and continue to fold none of them into my workflow." Another reply in the same thread:
  a "simple markdown file with Claude". (r/softwaretesting, about 2026-01, read through a mirror)
- "Tests where not helping the delivery - only used as a 'defence', requirements got stale, overall cumbersome to keep
  two IT systems ... up to date." ([HN, 2022-04-19](https://news.ycombinator.com/item?id=31090847))
- "In heavy regulated spaces, it is required to have traceability to formal requirements." (Ministry of Testing,
  2025-04-23)
- "A passing test that's wrong is dangerous", and "no AI deciding what to click or what to assert at runtime."
  ([Ministry of Testing, 2026-05-07](https://club.ministryoftesting.com/t/where-would-you-trust-an-ai-to-write-your-tests-and-where-absolutely-not/87298))

The people who keep a tool keep it for proof: regulation, visibility across a fast-moving team, a record that outlives
the person who ran the test. Nobody keeps one for flaky detection.

## 5. Jobs, positioning and the customer

### 5.1 Jobs, and who already does each

| Job | Who does it today, and at what cost | Where Mainworthy stands |
| --- | --- | --- |
| Author and keep manual cases | TestRail, Qase, Testiny and others, $15 to $78 a seat; markdown in the repo, free | Built; history not gated; our vocabulary is unfamiliar |
| See automated results and history across CI | Buildkite, Datadog, Currents, Mergify, free to cheap | Built; not a reason to switch |
| Find and quarantine flaky tests | Buildkite, Trunk, Mergify free at small scale; Datadog paid | Built; given away by others |
| Decide a release is ready from both kinds of evidence | Azure Test Plans ($52/seat); spreadsheets | Built (the gate, policy, sign-off); rare elsewhere |
| Prove later what was tested, on which version, by whom | TestRail Enterprise, Xray Enterprise, PractiTest Corporate | Built (verifiable audit export, pinned versions); top-tier-only elsewhere |
| Let an agent author or run tests, with its work reviewable | QA Wolf, Momentic, TestMu AI as services; Oligarchy built its own | Built in parts (scopes, model per result, proposals); no evidence capture like screenshots per step yet (0117 keeps a step trail) |

### 5.2 Three possible customers

These are proposals. Choosing among them is the owner's decision.

- **A. Release-gated teams with mixed manual and automated testing**, who must show what was tested (fintech, health,
  B2B vendors with enterprise customers). Alternatives: TestRail or Xray at the top tier, Azure Test Plans. We win on
  history in every tier, results pinned to versions, the gate and self-hosting. We lose on maturity, integrations and
  the vocabulary.
- **B. Teams whose testers are partly agents**, the Oligarchy shape: natural-language cases an agent runs, evidence,
  an independent verdict, a failure taxonomy. Alternatives: build it yourself, QA Wolf or Momentic as a service. We win
  on agent identity, scopes, review of agent edits, self-hosting and an open licence. The market is new and small.
- **C. Automation-heavy developer teams who want flaky handling and a gate.** Alternatives: Buildkite, Trunk,
  Mergify, Currents, mostly free at their size. We have no clear win. Not recommended.

Recommendation: **A as the buyer, B as the headline.** A pays and already believes in keeping cases; B is what makes
Mainworthy different from TestRail in 2027. A positioning statement in April Dunford's order, for the owner to accept,
edit or reject:

> For teams that must show what was tested before a release, and who test with people, scripts and now agents,
> Mainworthy is a self-hostable test case manager that keeps every case version, ties every result (a person's, a
> CI job's or an agent's) to the version it ran, and records who decided the release was ready. Unlike TestRail or
> Xray, the history and audit trail are in every tier and agents are first-class users with their own identity.

### 5.3 What is commodity and what is not

| Part | State | What to do |
| --- | --- | --- |
| Storing results, JUnit ingestion, pass-rate charts | commodity | accept every format, add CTRF; spend nothing on differentiation |
| Flaky detection and quarantine | commodity, given away | keep, do not lead with it |
| MCP server | becoming commodity | lead with what others lack: identity, scopes, review, token cost |
| Case versions pinned to results, history in every tier | sold as an enterprise feature | lead with it for customer A |
| Agent-run cases with evidence and an independent verdict | new | the headline for customer B |
| Capture UX (moving knowledge out of a head) | still hard everywhere | priority 3 from the vision; no measured comparison exists |

## 6. SWOT, turned into moves

| | Opportunities | Threats |
| --- | --- | --- |
| | O1 agent identity in history exists nowhere else; O2 agent-run cases need a record keeper (Oligarchy); O3 regulated teams pay for history and audit, gated elsewhere; O4 vendor churn and consolidation (Sembi, Harness) make self-hosting attractive | T1 "don't need a TCM": tests in code, markdown with an agent; T2 CI vendors give flaky detection and history away; T3 every major TCM has write-capable MCP; T4 a team can build its own record in a month with agents |
| **Strengths:** S1 one model for manual, CI and agent results pinned to case versions; S2 agents as users with scopes, identity and measured token cost; S3 Apache-2.0 and self-hostable; S4 audit export and gate; S5 build speed | **Use S to take O.** Make agent-run cases first-class: an instruction and a proof on a case, screenshots and logs per step on a result, a second agent's diagnosis with a controlled cause list (S1, S2 → O2). Sell history and audit in every tier to customer A (S1, S4 → O3). Publish a self-host story aimed at teams leaving a sold or retired tool (S3 → O4) | **Use S to blunt T.** Keep cases in the repository as files Mainworthy reads and versions, so "tests are the documentation" is an import path, not a lost sale (S1 → T1). Ingest from the CI vendors instead of competing with them (S1 → T2). Lead agent claims with identity and review, which no MCP server has (S2 → T3) |
| **Weaknesses:** W1 no customer; W2 scope sprawl (iOS, identity, teams); W3 invented vocabulary; W4 no measured comparison with rivals; W5 process cost; W6 one maintainer | **Fix W to reach O.** Pick a customer and freeze work that does not serve it (W1, W2). Rename toward market words where meaning allows: plan, run, test case, flaky (W3). Run the comparison phase 0 asked for, with this repository's CI output (W4) | **Avoid the worst case.** A broad product that no one picks against free CI tools and markdown files. Cut scope to one customer's workflow, keep the process light, and make adopting it cost less than one afternoon (W1, W2, W5 → T1, T2) |

What each freeze candidate would save, as a starting point for the owner's choice in decision 3:

| Candidate | Size today | Needed for |
| --- | --- | --- |
| Native iPhone app | 27k lines, its own milestone, real-device checks pending | a tester away from a desk; customer A rarely, B never |
| Passkeys, SSO, second factor, native sign-in | about 12 decisions | enterprise sales, after a first customer |
| Teams own projects (M8) | a milestone, not started | several teams in one instance |
| The loose-to-regulated policy spectrum | the policy engine, disputes, inherited answers | customer A needs the regulated end only |
| Google Cloud cutover (#821) | in progress | a hosted instance others can use; keep if a pilot is near |

## 7. From day 1, what we would do differently

Each item says whether the lesson needed building to learn.

| Change | Could we have known without building? | What it cost |
| --- | --- | --- |
| Name one customer and one job before the first line of code | Yes: decision 0005 chose breadth on purpose | Scope sprawl; most of section 2.2 |
| Spend week 1 loading our own CI output into Buildkite, Trunk, Qase and Azure Test Plans | Yes: free tiers existed | Flaky detection and MCP built as if they were differentiators |
| Start on PostgreSQL | Mostly: a hosted service needs more than one server at deploy time; the arena measured single-node reads | 12 days of store work twice |
| Use the market's nouns (plan, run, case, flaky) and keep new concepts internal | Yes | A guide a buyer has to learn before using |
| Web, CLI and MCP only; no phone app or extra sign-in methods until a user asks | Yes | The iPhone app and identity work |
| Scale rigour to users: a few decisions a week, tests at the cheapest layer, budgets that warn | Partly: the owner learned the cost by paying it, and has corrected it since 2026-10-24 | 42% of commits touched no product code |
| Treat agent-run cases with evidence as a core capability | No: Oligarchy published its model a month ago | Nothing yet; this is the opening |
| Write "the owner's notes" on each rival before designing | Yes | The design rests on reviews and vendor pages, not the owner's experience |

What we would keep: the operation registry, append-only versions, one result stream, agents as users, the evidence
model behind the gate, dogfooding this repository's CI on the instance, and the speed of building.

## 8. Predictions that could prove this wrong

Each is dated so a later reader can check it.

1. By 2027-04-27, none of Buildkite, CircleCI, Datadog or GitHub ships authoring of manual test cases. If one does,
   the joined manual-and-CI opening in section 3.2 closes.
2. By 2027-04-27, at least one of TestRail, Qase or Testmo records an agent as its own actor in case history. If that
   happens, S2 stops being unique and the headline needs another basis.
3. By 2027-01-31, Oligarchy is either public under a licence or its record (definitions, results, diagnoses) moves into
   a third-party tool. If it stays private and home-grown, customer B builds rather than buys.
4. GitHub ships native test analytics in Actions by 2027-04-27. If so, the CI group in section 3.2 becomes free for
   most of customer C, confirming it as the wrong customer.

## 9. What is not checked

- **Hands-on use of any rival.** Every comparison is from vendor pages. Decision 0009, answer 13 ruled out trial
  accounts; reversing that is the owner's call and needs their sign-ups.
- **Conversations with users.** No QA lead or developer outside the project has read the positioning. Whether to talk
  to any is the owner's call.
- **Review sites.** G2, Capterra, Software Advice, TrustRadius and Reddit blocked automated reading.
- **Oligarchy's original repository**, its licence and whether the public copy is authorised.
- **Pages that failed:** Sentry's test analytics docs (404), Buildkite's workflow limits (the pricing page and
  changelog disagree), TestRail's and Testmo's help centres (403), Xray's pricing page (404), Octomind's site.
- **Usage of mainworthy.com** beyond this repository's own CI: not measured here.
- **Section 2.2 is commit counting.** A commit is not a unit of effort; the numbers show direction, not cost.

## 10. Questions for the owner

Answers belong in "The owner's notes" in [competitors.md](competitors.md), which override everything here.

1. Which of the tools in section 3 have you used for real work, and what made you stop or keep using each?
2. In the teams you worked with, who opened the test management tool every day, and who only opened it before a
   release or an audit?
3. Have you seen a team drop its test management tool for tests in code? What, if anything, did they miss later?
4. Would you use Mainworthy to record agent-run tests of your own projects, the way Oligarchy records Omarchy's?
5. Which of customers A, B and C is closest to a team you could ask to try it?

## Reproduce

Run from the repository root at `4091fde9`.

```sh
# Commits touching product code (src/, ios/) against those that do not
git log origin/main --format='format:@@%h' --name-only | awk '/^@@/{if(h!=""){ if(s) a++; else b++ } h=$0; s=0; next} /^(src|ios)\//{s=1} END{if(s)a++; else b++; print a, b}'
# Lines in an area
git ls-files test | xargs cat | wc -l
# Vocabulary in the guide
grep -rio slot docs/guide | wc -l
```
