# UX research and review plan

Mainworthy's third priority, UI and UX that get out of the way, is the one
that most needs evidence before code. Competing tools are the baseline of
friction; this plan finds where that friction is, what users intend when they
hit it, and which interactions remove it. It runs before implementation
(roadmap phase 0) and keeps running alongside it.

**Audience (decision 0005):** software QA teams in general, not any one
team. Daniel's experience across enterprise, large, small and startup teams
is the main first-hand evidence, used as practitioner judgment and checked
against public evidence.

**Method constraint (Daniel, 2026-10-10):** no user interviews or recruited
usability sessions. The research is desk research, hands-on use of the
incumbents, careful written reasoning, and mock-ups that test both the
interaction and the architecture's feasibility. Where a claim would need
real users to confirm it, say so and keep it a hypothesis.

Everything here is a method, not a conclusion. Findings go in `docs/ux/` as
they are produced; nothing in the product vision is treated as proven until a
finding backs it, and the vision's UX bullets are candidate solutions to be
tested, not rules to be confirmed.

## Scope

Software QA only: test cases, plans, runs and results for software, with CI/CD
as a first-class flow. Hardware, laboratory and other forms of QA are out of
scope (decision 0003), and research does not cover their tools.

## Questions to answer

1. What is the user actually trying to do at each moment, and where does the
   tool make them do something else first? (Intent vs. imposed workflow.)
2. Where does time go in a day of test management: authoring, reorganising,
   executing, triaging CI results, maintaining traceability, reporting, or
   fighting the tool?
3. Which interactions must be instant, and which can tolerate a visible
   delay without breaking flow?
4. How do people get knowledge out of their head: free text first and
   structure later, or structured fields from the start? Both are hypotheses
   to test in mocks.
5. What do people do with history and diffs when they have them, and what do
   they fake when they do not (copies, "v2" suffixes, spreadsheets)?
6. How should agent-authored changes appear so that a person trusts and
   reviews them without a ceremony?
7. How do teams across the process spectrum (loose, standard, regulated,
   automation-heavy) express their gates and sign-offs, and what do they
   need to see to understand traceability from requirement to result to
   deployment? (Decision 0003 sets the position to test.)
8. What does "self-hosted locally" need to feel like for a single user to
   adopt it over a spreadsheet or a Markdown folder?

## Method

### 1. Desk research

Sources, in order of weight: vendors' own documentation and release notes;
public complaint threads (vendor forums, Reddit r/QualityAssurance and
r/softwaretesting, Stack Overflow, GitHub issues of the open-source tools);
review sites, read for recurring specifics and discounted for marketing;
regulatory and process references for the strict end of the spectrum (ISO
29119, IEC 62304, FDA 21 CFR Part 11 expectations for electronic records
and signatures, ISTQB terminology) read for what a tool must record, not to
certify against. Every claim taken from a source is labelled Verified,
Reported or Open as in `docs/competitive-analysis.md`.

### 2. Friction audit of incumbents (hands-on)

Trial accounts where they can be opened without a sales call (Qase, Testiny,
Testmo, TestRail trial), Kiwi TCMS self-hosted, and Azure DevOps Test Plans
or Xray if an instance is available. Start with two tools and widen. For each,
perform the core jobs below with a screen recording and log every friction
event in the friction catalogue: clicks, keystrokes, waits over 100 ms
(measured with browser performance tooling, not a stopwatch), modal
dialogs, page loads, lost input. Mark a job "unsupported" rather than
forcing it.

The same session tries each vendor's MCP server on the agent jobs (A1 to A6),
recording tokens as well as capability, closing the open item on MCP depth
in the competitive analysis.

### 3. Core jobs

Fixed list, used in the audit, the mocks and later on the real product, so
measures are comparable. Human jobs are judged on completion, errors, lost
input, assistance needed and time; agent jobs on contract (can it be done at
all, with what identity and scope, and does history record it).

| # | Job | Success means |
| --- | --- | --- |
| J1 | Write a new case with 6 steps from notes in your head | case saved, steps structured, no error, under 2 minutes |
| J2 | Paste a plain-text list of steps and get a structured case | steps split correctly without manual re-entry |
| J3 | Find a case by a half-remembered phrase among 10k cases | found in under 15 seconds, no filter configuration |
| J4 | Move 40 cases between folders and retag them | one undoable action, no page reload |
| J5 | Execute a 30-case manual run, recording results and one failure with a screenshot | keyboard only, no mouse required |
| J6 | Triage a CI run with 12 failures, two of them flaky | know which are new, which are flaky, link one to a case |
| J7 | See what changed in a case since the last release and why | diff shown with author and reason |
| J8 | Review and accept an agent-proposed edit to three cases | diff reviewed, accepted or reverted, in under a minute |
| J9 | Link 10 cases to a requirement and see its coverage and last results | links made in bulk; coverage visible without an export |
| J10 | Follow a failed deployment check back to the case, its version, the commit and the requirement | every hop is one click, in both directions |
| J11 | Add a custom field to a project and fill it on 20 cases | no schema migration ceremony; bulk fill is one action |
| J12 | Change a shared step used by 50 cases | one edit, all users updated as a new version, affected cases listed |
| J13 | Give a reader results-only access, and an agent author access to one project | no seat purchase for the reader; scope visible on the token |
| J14 | Set a release gate: no deploy while required cases are unexecuted or failed | gate defined in minutes and visible in the pipeline status |
| J15 | Install and open the tool locally with no account | from download to first case in under 5 minutes |
| A1 | Agent reads a folder, writes three cases, runs a result | possible through MCP under its own identity; history shows it |
| A2 | Agent is restricted to read-only on one project | enforced by the token, not by convention |
| A3 | Agent reports a CI result set and links unlinked tests | idempotent; unlinked inbox shows what it could not match |
| A4 | Agent reviews a 5-file change adversarially: finds the affected cases, challenges them, records 3 findings | affected set comes from the change, not a scan of the suite; findings stored against case versions; tokens within budget |
| A5 | The same agent re-reviews after one case changed | only the changed case and its dependents are read; reviewed unchanged versions skipped unless fresh eyes is asked for; tokens a small fraction of A4 |
| A6 | Agent runs an adversarial test session over 20 cases and records results plus 2 new findings with reproduction steps | results written in one batch; findings linked; regression cases proposed; tokens within budget |

**Token measure (decision 0006).** Every agent job is also judged on tokens:
a scripted reference agent with a fixed model and tokenizer runs the job, and
we count the tokens of tool definitions, requests and responses, and the
number of calls. Budgets come from a baseline: the same job through each
incumbent's MCP server (audit) and through a naive list-and-get-everything
use of Mainworthy's own API.

### 3b. Flows

The jobs are single tasks; flows are what people and agents do end to end
across a day and a release, with triggers, handoffs and rough frequency.
First draft: [ux/flows.md](ux/flows.md), all hypotheses. They are corrected
by Daniel's comparison of the kinds of team he has worked in (open question 18), the
friction audit and the mocks, and they set the workload mix for the
benchmark and the first operations of the MCP surface. Jobs are added or
changed where flows expose a gap.

### 4. Process spectrum profiles

Three written personas of teams, not people, built from practitioner
experience and public evidence rather than from any real team, used to check
every design against the spectrum in decision 0003. They are also checked
for organisation scale (one person, one team, many teams), which varies
independently of strictness (decision 0005):

- **Loose:** a small product team; tests are mostly automated, manual checks
  before release, nobody signs anything, speed matters most.
- **Standard:** a team with QA engineers, review of case changes, release
  runs with pass criteria, Jira for defects and requirements.
- **Regulated:** medical, finance or automotive software; every change needs
  an author and approver, runs are evidence frozen at release, traceability
  from requirement to result must be exported for an audit, electronic
  signatures may be required.

Each profile gets a one-page workflow: how a requirement becomes cases, how
cases get approved, how CI and manual runs feed a release decision, and
what the team looks at to decide. A design that serves one profile by making
another miserable is rejected.

### 5. Intent model

From the audit and desk research, write the intent model: for each core job,
the user's goal, the minimum information they must give, what the tool can
infer or default, and what it may never ask for up front. "The tool asked for
something the intent model says to infer" is a defect in later testing.

### 6. Interaction hypotheses and design system

Turn the product-vision UX bullets into numbered hypotheses with the
observation that would reject each (for example: "H3 autosave with undo
beats explicit save; rejected if the mocks show no way to make a draft state
visible to a regulated team"). Candidate tests: free-text capture against
structured fields; autosave against explicit publication; immediate agent
edits against proposed edits. Choose a visual direction and density. Produce a
component inventory for the first usable version.

### 7. Mocks: interaction and architecture feasibility

Two rounds, both reviewed by Daniel and by an independent model, not by
recruited users:

- **Round 1, static mocks.** Core screens for the jobs above and the three
  profiles, checked against the intent model and the interaction hypotheses.
  Includes the traceability views (matrix, chain, pipeline gate status).
- **Round 2, feasibility mock.** A throwaway interactive mock with 10k fake
  cases, virtualized lists, in-place editing and optimistic updates,
  instrumented for input-to-paint latency. Its purpose is to find out whether
  the interaction model and the data flow (optimistic writes, versioning,
  cache reconciliation) are feasible together, and to surface what the
  backend must provide. It is not the start of the product code base.

## Outputs (all under `docs/ux/`)

| File | Content |
| --- | --- |
| `sources.md` | desk research sources with labels and the specifics each gave |
| `friction-catalogue.md` | every friction event: tool, job, what happened, what the user meant, cost, idea for removing it |
| `flows.md` | end-to-end flows by actor, with triggers, handoffs, profile differences and open points |
| `jobs.md` | the core jobs above with baseline measures per incumbent and "unsupported" marks |
| `profiles.md` | the three process-spectrum profiles and their workflows |
| `intent-model.md` | the intent specification per job |
| `interaction-hypotheses.md` | numbered hypotheses with rejection criteria; the survivors become browser tests |
| `traceability-views.md` | the traceability and gate visualisations, with what question each answers |
| `mock-results.md` | review notes and latency measures for each mock round |
| `competitor-mcp.md` | hands-on findings on competitors' agent surfaces |

## Exit criteria for phase 0

- At least two incumbents audited on every job, each job marked done or
  unsupported, with measured waits.
- Profiles, intent model and interaction hypotheses written, reviewed by an
  independent model and by Daniel, with review notes recorded.
- Round 2 mock meets the input-to-paint budget in the product vision on 10k
  cases and completes J1 to J4 and J8 without lost input; the architectural
  requirements it surfaced are written into the stack criteria.
- Open questions that block the data model have answers recorded as decision
  records: collaboration and offline are answered in decision 0004 (the mock
  tests its live-update candidates); review workflow and gate model remain.

## Non-goals of the research

- Choosing the stack. The benchmark decides that (roadmap phase 1); the
  mock's findings on what must be instant feed the front-end criteria.
- Visual polish beyond what is needed to test the interaction.
- Certifying against any regulation. The regulated profile sets what must be
  recorded; compliance claims are out of scope until a real team needs them.
