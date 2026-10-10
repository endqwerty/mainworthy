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

## Principles (draft, to be challenged)

1. **A test case is a versioned document, not a row.** Every edit is a version;
   a run records the exact version it executed.
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
- Case versioning with diff.
- Plans and runs, manual execution UI, result statuses, attachments, defects links.
- Ingest of automated results (for example JUnit XML) via API.
- Import from TestRail, Qase and CSV.
- MCP server and a shipped agent skill (priority 2).
- Basic reports: pass rate over time, coverage by requirement, flaky cases.

## Non-goals (for now)

- Being a full issue tracker or ALM.
- Test code generation or execution infrastructure.
- Multi-tenant SaaS billing.

Everything above is a starting position. Change it freely; record why.
