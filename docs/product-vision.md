# Product vision

## Problem

Teams keep their tests in tools that were designed around a spreadsheet of
cases and a "run" button. Those tools get slow at scale, hide history, make
traceability a manual chore, and charge for every viewer. Teams on Jira or
Azure DevOps get tests bolted onto a ticket tracker whose model does not fit.

## Priorities (ranked, set by Daniel 2026-10-10)

When two goals conflict, the higher one wins.

1. **A fast, good backend.** Speed is a feature, not a polish step. Every
   later priority depends on it.
2. **First-class agent access.** Agents are users: they read, author and run
   cases through MCP and skills, with the same power as the UI.
3. **UI and UX that get out of the way.** The hard part of this work is moving
   knowledge from a person's head into documentation. The tool must make that
   painless.

### 1. Backend

- One operation layer. The UI, the REST/JSON API, the MCP server and CI
  ingest all call the same operations, so nothing is UI-only and nothing
  drifts.
- Draft latency budgets, to be validated on a benchmark dataset of 100k cases
  with 1M results before the stack is final: p95 read of one case under 20 ms
  and a case list page under 50 ms at the server; search under 100 ms; a
  single-case save under 50 ms; bulk edit of 1,000 cases under 1 s.
- Writes are append-only versions (principle 1), so saves are cheap and
  history is free.
- Pagination, search and filtering are done by the database, never by
  fetching everything and filtering in the client.
- Performance tests are part of the check command from the first
  implementation, not added later.

### 2. Agentic access

- An MCP server is a core surface from the first usable version, not an add-on.
  Remote (HTTP) transport with scoped tokens, so an agent can be given
  read-only, one-project or author rights. Tool descriptions and annotations
  (read-only, destructive) are written for models, and results are structured.
- A shipped skill (`SKILL.md` format) that teaches an agent the case model:
  how to write a good case, when to reuse shared steps, how to link
  requirements, how to report a result.
- Agent-authored changes carry the agent's identity and are visible in the
  case history. A human can review them as a diff and accept or revert, the
  same way as any other version.
- The OpenAPI description and the MCP tool list come from the same source.
- "Current cutting edge" is a moving target. Treat MCP and Agent Skills as the
  starting position and re-check the state of the art (and verify the exact
  spec versions) when the MCP work starts; record what is chosen in a decision
  record.

### 3. UI and UX

The user is turning what they know into steps, expected results and context,
and moving cases around while they do it. Anything that interrupts that
thinking is a defect.

- **Instant response.** Clicks, drags and keystrokes respond within one frame
  to 100 ms. No spinner on a click, no input that mounts or "loads" before it
  accepts text, no editor that needs a second to become interactive.
  Interface state changes optimistically and reconciles with the server in
  the background; a failure is shown without losing what was typed.
- **Everything is editable in place.** No separate edit mode or modal for the
  common path. Autosave, always; undo and redo that work across edits,
  moves and bulk actions.
- **Fast capture.** Type steps as an outline, paste a list or a block of text
  and get structured steps, create the next step with Enter. Keyboard-first,
  with drag and drop for the things that are spatial (reordering steps, moving
  cases between folders).
- **Predictable layout.** Nothing jumps while loading; lists are virtualized
  so a folder of thousands of cases scrolls and searches like a short one.
- **Measured, not felt.** Interaction latency (input to next paint) is measured
  in a browser test on the real UI and has a budget like the backend does.
  A change that breaks the budget does not merge.

## Core capabilities (must-have, added 2026-10-10)

These sit beside the three ranked priorities: they are not optional extras,
and each one is also bound by the speed and agent-access priorities (every
one of them is available through the API and MCP, and stays fast at scale).

### Versioning of test cases

- A case has a stable ID and an append-only list of immutable versions. A
  version records the author (person or agent), time, a short reason (optional
  to write, easy to add) and the full content.
- Diff between any two versions, field by field and step by step, in the UI
  and through the API/MCP. Restore an old version (creates a new version, never
  rewrites history).
- A run and every result record the exact version they executed. Reports can
  say "this failure was on version 7; version 8 changed step 3."
- Plans and suites reference cases, not copies. A plan chooses to follow the
  latest version or pin one; the default is latest for planning and pinned at
  the moment a run starts.
- Moves, renames of folders, tag edits and bulk edits are versioned the same
  way, so a bulk change is one undoable, attributable event.
- Draft vs published: edits (especially by agents) can be proposed and
  reviewed before they become the current version. Open question: whether
  this is a per-project setting (see open questions).

### CI integration

- Ingest is an API first, with a small CLI and a ready-made GitHub Actions
  step on top of it; other CI systems use the CLI or API. Must not need a
  plugin per CI vendor.
- Formats: JUnit XML first (every runner can produce it), then the common
  JSON reports (for example Playwright, Jest/Vitest, pytest), and TRX for
  .NET. A neutral open report format (such as CTRF) is worth supporting if
  verification shows it is alive and adopted; treat as a hypothesis until
  checked.
- Each ingest is tagged with commit SHA, branch, PR number, build URL,
  environment, and the retry attempt number. This metadata is what makes flaky
  detection and traceability to code possible, so it is required for CI
  uploads, not optional.
- Ingest is idempotent (re-sending the same report does not double count) and
  tolerant (unknown tests do not fail the upload).
- Mapping a test result to a case: by a stable automated-test identifier
  (path + name, or an explicit case ID annotation in the test). Results with
  no match land in an "unlinked" inbox, from which a person or an agent can
  link them to an existing case or create a new case in one step. Optional
  auto-create per project.
- Results flow back: a commit status or PR check with the summary and a link,
  plus a deep link from a failure to the case, its version and its history.
- Draft budget: ingest of a 10,000-result report is accepted in under 2 s and
  visible in reports within 5 s.

### Automated vs manual tracking

- Every case has an execution type: manual, automated, or both (a manual
  case that also has an automated counterpart). Changing it is a versioned
  edit.
- A case links to zero or more automated tests (identifiers as above), and
  the link is checked from the other direction: the system knows when a
  linked automated test stopped reporting (stale), when an automated test
  has no case (unlinked), and when a manual run was recorded for a case that
  also has an automated test.
- Reports answer, at any time, per project/folder/tag/requirement: how many
  cases are manual, automated, both; the automation rate over time; the
  automation backlog (manual cases ranked by how often they run and how long
  they take); which manual cases were not run in the last N days.
- Manual and automated results stay one result stream (principle 3). The
  type is a filter, not a separate model.

### Automatic flaky detection

- No setup: detection runs on ingest and needs no manual tagging.
- Signals, strongest first:
  1. The same test, same commit (same code), different outcomes, including
     fail-then-pass on a retry attempt in one run or across reruns of the
     same commit.
  2. Alternating outcomes on a stable branch (main) over a window of recent
     runs, without a relevant case/code change in between (the case version
     and commit tell us that).
  3. A failure whose error signature changes between occurrences (timeouts,
     connection errors) as a weak supporting signal.
- Classification separates infrastructure and environment failures
  (timeout, runner crashed, setup failure) from assertion failures, when the
  report allows, so a bad runner does not mark every test flaky.
- Each case gets a flakiness state (stable, suspected, flaky), a score with
  the evidence behind it (the runs and commits that show it), and a trend.
  The score and the thresholds are explainable and tunable per project.
- Quarantine: a flaky case can be marked quarantined. Its results are still
  recorded but it does not fail the PR status or the pass-rate headline. It
  leaves quarantine on a person's decision or after a run of clean results,
  never silently.
- Flaky cases get an owner-visible list, a notification option, and a link to
  an issue in the external tracker. Reports show flaky rate, top offenders, and
  time lost to reruns.
- Draft budget: the flaky state of a case updates within seconds of ingest
  (incremental on ingest, not a nightly batch), and reading it adds no
  noticeable cost to listing cases.

## Principles (draft, to be challenged)

1. **A test case is a versioned document, not a row.** Every edit is a version;
   a run records the exact version it executed (see "Versioning of test cases").
2. **Separate the definition of a test from the act of running it.** Plans,
   suites and runs are cheap views over cases, not copies of them.
3. **Automated and manual results are one stream.** CI results and human
   results land in the same model and reports.
4. **Traceability by link, not by ticket.** Cases link to requirements, issues
   and commits in external trackers; the tracker stays the source of truth for
   those.
5. **Fast first.** Search, bulk edit and run execution are keyboard-driven and
   stay responsive on very large suites (budgets under "Priorities").
6. **Everything has an API and an export.** No lock-in: full import/export of
   cases, history and results in an open format.
7. **Agents are users.** Whatever a person can do, an agent can do through MCP,
   under its own identity and permissions.

## Scope for a first usable version (draft)

- Projects, folders/tags, test cases (steps, expected results, preconditions,
  custom fields), shared steps.
- Case versioning with diff, restore, and version-stamped results.
- Plans and runs, manual execution UI, result statuses, attachments, defects links.
- Ingest of automated results via API, CLI and a GitHub Actions step (JUnit XML first), with commit/branch/attempt metadata and an unlinked-results inbox.
- Manual / automated / both on every case, with automation rate and stale or unlinked automated-test reports.
- Automatic flaky detection with evidence, quarantine and PR status that respects it.
- Import from TestRail, Qase and CSV.
- MCP server and a shipped agent skill (priority 2).
- Basic reports: pass rate over time, coverage by requirement, automation rate, flaky cases.

## Non-goals (for now)

- Being a full issue tracker or ALM.
- Test code generation or execution infrastructure.
- Multi-tenant SaaS billing.

Everything above is a starting position. Change it freely; record why.
