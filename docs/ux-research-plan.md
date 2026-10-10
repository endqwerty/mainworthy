# UX research and review plan

Casebook's third priority, UI and UX that get out of the way, is the one
that most needs evidence before code. Competing tools are the baseline of
friction; this plan finds where that friction is, what users intend when they
hit it, and what interactions remove it. It runs before implementation
(roadmap phase 0) and keeps running alongside it.

Everything here is a method, not a conclusion. Findings go in
`docs/ux/` as they are produced; nothing in the product vision is treated as
proven until a finding backs it.

## Questions to answer

1. What is the user actually trying to do at each moment, and where does the
   tool make them do something else first? (Intent vs. imposed workflow.)
2. Where does time go in a day of test management: authoring, reorganising,
   executing, triaging CI results, reporting, or fighting the tool?
3. Which interactions must be instant, and which can tolerate a visible
   delay without breaking flow?
4. How do people want to get knowledge out of their head: free text first and
   structure later, or structured fields from the start?
5. What do people do with history and diffs when they have them, and what do
   they fake when they do not (copies, "v2" suffixes, spreadsheets)?
6. How should agent-authored changes appear so that a person trusts and
   reviews them without a ceremony?
7. What does "self-hosted locally" need to feel like for a single user to
   adopt it over a spreadsheet or a Markdown folder?

## Method

### 1. Friction audit of existing tools (hands-on)

Trial accounts for TestRail, Qase, Testiny, Testmo and (if accessible) Xray
or Azure DevOps Test Plans; Kiwi TCMS self-hosted. For each tool, perform the
core jobs below with a stopwatch and a screen recording, and log every
friction event in the friction catalogue (see "Outputs"). Record clicks,
keystrokes, waits over 100 ms, modal dialogs, page loads and lost input.

This also closes the open item in `docs/competitive-analysis.md` on
competitors' MCP depth: try each MCP server for the same jobs.

### 2. Core jobs

Fixed task list, used in the audit, the prototypes and the usability
sessions, so numbers are comparable:

| # | Job | Success means |
| --- | --- | --- |
| J1 | Write a new case with 6 steps from notes in your head | case saved, steps structured, under 2 minutes |
| J2 | Paste a plain-text list of steps and get a structured case | steps split correctly without manual re-entry |
| J3 | Find a case by a half-remembered phrase among 10k cases | found in under 15 seconds, no filter configuration |
| J4 | Move 40 cases between folders and retag them | one undoable action, no page reload |
| J5 | Execute a 30-case manual run, recording results and one failure with a screenshot | keyboard only, no mouse required |
| J6 | Triage a CI run with 12 failures, two of them flaky | know which are new, which are flaky, link one to a case |
| J7 | See what changed in a case since the last release and why | diff shown with author and reason |
| J8 | Review and accept an agent-proposed edit to three cases | diff reviewed, accepted or reverted, in under a minute |
| J9 | Produce a coverage report for one requirement | report without exporting to a spreadsheet |
| J10 | Install and open the tool locally with no account | from download to first case in under 5 minutes |

### 3. Interviews and observation

Five to eight people who do test management weekly (QA engineers, developers
who own tests, a manager who reads reports). One hour each: 30 minutes of
watching them use their current tool for real work, 30 minutes of interview
on the questions above. Daniel's own notes in `docs/competitors.md` are the
first interview.

### 4. Intent model

From the audit and interviews, write the intent model: for each core job, the
user's goal, the minimum information they must give, what the tool can
infer or default, and what it may never ask for up front. This document is the
specification the UI is judged against; "the tool asked for something the
intent model says to infer" is a defect.

### 5. Interaction principles and design system

Turn the product-vision UX bullets into testable rules with numbers (instant:
under 100 ms input to paint; autosave debounce; undo depth; keyboard map;
drag affordances; empty-state behaviour; error display without losing input).
Choose a visual direction and density. Produce a component inventory for
the first usable version.

### 6. Prototypes, measured

Two rounds of clickable prototypes with real-sized fake data (10k cases):

- Round 1: static design mock-ups for the core screens, reviewed against the
  intent model, not with users.
- Round 2: a throwaway interactive prototype with virtualized lists and
  in-place editing, used in usability sessions on jobs J1 to J5 and J8. It
  is instrumented for input-to-paint latency and task time. It is not the
  start of the product code base.

### 7. Usability sessions

Five participants per round on the prototype, same jobs, same measures as the
audit, so Casebook is compared with the incumbents on the same scale.

## Outputs (all under `docs/ux/`)

| File | Content |
| --- | --- |
| `friction-catalogue.md` | every friction event: tool, job, what happened, what the user meant, cost in time or clicks, idea for removing it |
| `jobs.md` | the core jobs above with baseline times per competitor |
| `interviews.md` | anonymised notes and the recurring themes |
| `intent-model.md` | the intent specification per job |
| `interaction-principles.md` | numbered, testable UX rules; these become browser tests later |
| `prototype-results.md` | task times and latency measures for each round |
| `competitor-mcp.md` | hands-on findings on competitors' agent surfaces |

## Exit criteria for phase 0

- Friction catalogue has at least three tools fully audited on all ten jobs.
- Intent model and interaction principles written and reviewed by one
  independent model and by Daniel.
- Prototype round 2 beats the best competitor baseline on J1 to J5 by a
  margin that participants notice, and the latency measures meet the budgets
  in the product vision.
- Open questions that block the data model (real-time collaboration, offline,
  review workflow) have answers recorded as decision records.

## Non-goals of the research

- Choosing the stack. The benchmark decides that (roadmap phase 1), though
  research findings on what must be instant feed the front-end criteria.
- Visual polish beyond what is needed to test the interaction.
