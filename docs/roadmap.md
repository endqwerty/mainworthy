# Roadmap

Phased plan from day zero to a first usable version. Each phase has exit
criteria; a phase ends when they are met and recorded, not on a date. Phases
0 and 1 overlap on purpose: research needs no stack, and the benchmark needs
no design.

Status is kept in this file. Change the plan freely and record why in a
decision record.

## Phase 0: UX research and design (now)

Plan: [ux-research-plan.md](ux-research-plan.md).

- Hands-on friction audit of competitors on the ten core jobs.
- Interviews and observation; Daniel's notes first.
- Intent model and interaction principles.
- Two prototype rounds, measured, with usability sessions.
- Answer the open questions that shape the data model (collaboration,
  offline, review workflow) and record them as decisions.

Exit: see the plan's exit criteria.

## Phase 1: Architecture spike and stack decision (parallel with phase 0)

- Build the benchmark dataset and harness: 100k cases, 1M then 10M results,
  the queries and budgets in the product vision and decision 0001.
- Run it on two or three candidate stacks, each in Local mode (embedded
  store) and Server mode (server database), per decision 0002.
- Prototype the one-operation layer: a handful of operations exposed through
  REST, MCP and a CLI from one definition, to prove the generation path.
- Decide the stack. Supersede decision 0001 with the result, add `t3.json`
  scripts, the check command, stack rules in `AGENTS.md` and a worktree
  release step, in the same change.

Exit: benchmark numbers recorded, stack decision merged, empty project
skeleton builds and runs its check command.

## Phase 2: Core vertical slice (Local layer)

One project, folders, cases with steps, versioning with diff and restore,
search, bulk move and retag with undo. UI implements the interaction
principles; browser latency test runs in the check command. MCP server with
read and author tools and the shipped skill, from the same operation
definitions. Ships as a single artifact that starts with no configuration.

Exit: jobs J1 to J4, J7 and J8 pass on the real product at or better than
the prototype's times; latency budgets hold on the benchmark data; a person
can install and reach a first case in under five minutes (J10).

## Phase 3: Runs and CI ingest

Plans and runs pinned to case versions, manual execution UI (J5), JUnit XML
ingest through API, CLI and a GitHub Actions step, unlinked-results inbox,
manual/automated/both tracking, flaky detection with evidence and
quarantine, PR status.

Exit: J5, J6 and J9 pass; ingest budgets hold; flaky state updates
incrementally on ingest.

## Phase 4: Server and Cloud layers, import, reports

Same artifact against a server database in a container on the home server;
object storage for attachments; cache layer only if the benchmark shows a
budget miss without it; background workers split out if needed. Import from
TestRail, Qase and CSV. Basic reports. Full export.

Exit: the three layers run from one build with identical behaviour; import of
a real TestRail or Qase export round-trips.

## Standing rules across phases

- Every phase that changes behaviour adds tests and runs the check on the
  real surface; performance and latency tests are part of the check from
  phase 2.
- Research continues: each phase ends with a usability session on the real
  product against the baselines in `docs/ux/jobs.md`.
- User-visible changes go in `CHANGELOG.md`; design decisions in
  `docs/decisions/`.
