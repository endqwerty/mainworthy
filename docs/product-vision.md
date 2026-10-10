# Product vision

## Problem

Teams keep their tests in tools that were designed around a spreadsheet of
cases and a "run" button. Those tools get slow at scale, hide history, make
traceability a manual chore, and charge for every viewer. Teams on Jira or
Azure DevOps get tests bolted onto a ticket tracker whose model does not fit.

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
   stay responsive on very large suites.
6. **Everything has an API and an export.** No lock-in: full import/export of
   cases, history and results in an open format.

## Scope for a first usable version (draft)

- Projects, folders/tags, test cases (steps, expected results, preconditions,
  custom fields), shared steps.
- Case versioning with diff.
- Plans and runs, manual execution UI, result statuses, attachments, defects links.
- Ingest of automated results (for example JUnit XML) via API.
- Import from TestRail, Qase and CSV.
- Basic reports: pass rate over time, coverage by requirement, flaky cases.

## Non-goals (for now)

- Being a full issue tracker or ALM.
- Test code generation or execution infrastructure.
- Multi-tenant SaaS billing.

Everything above is a starting position. Change it freely; record why.
