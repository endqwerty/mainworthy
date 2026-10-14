# Roadmap

Phased plan from day zero to a first usable version. Each phase has exit
criteria; a phase ends when they are met and recorded, not on a date. Phases
0 and 1 overlap on purpose: research needs no stack, and the benchmark needs
no design.

Status is kept in this file. Change the plan freely and record why in a
decision record.

**Status, 2026-10-12.** The owner asked for the MVP and answered the open questions
(decision 0009), so phases 0 to 2 were compressed into one night:

- Phase 1 is done: the stack was chosen from a measured three-candidate arena on
  100,000 cases and 1,000,000 results (decision 0010).
- Phase 2 (Preview 1) is built as the MVP, with the departures and cuts listed in
  decision 0012. Its exit fixtures that pass are tests in `test/`; the ones that do
  not exist yet are issues in the milestones M1 to M7 ("From the MVP to 1.0" below).
- Phase 0 was not done as planned: no hands-on audit (decision 0009, answer 13: no
  trial accounts) and no measured baselines against the incumbents. That gap is the
  reason the MVP is a preview and not a first usable version (#39).
- The Server layer runs from the same build as a container on SQLite. The Cloud
  layer and PostgreSQL are deferred (#57).

Scope is software QA across the process spectrum, loose to regulated, with
the full CI/CD flow in every profile (decision 0003).

## From the MVP to 1.0 (2026-10-13)

The MVP left one milestone, `Backlog to 1.0`, with 71 open issues in no order. On
2026-10-13 it became seven milestones, M1 to M7, numbered in the order they are
meant to be worked. The seven make three phases. Every open issue is in exactly one
milestone, and issue #64 lists them all on one page. A milestone has no date: it
ends when what the table says is true. The GitHub Project
`https://github.com/users/endqwerty/projects/2` shows the same plan as views: all
of it, the milestone being worked as a board, each phase, and what waits for the
owner.

| Phase | Milestone | True when it ends |
| --- | --- | --- |
| 1: harden the preview | M1 Reliable checks and known defects | No test fails by chance, `bun run check` takes under 120 s, and no known defect in what the MVP built is open |
| | M2 An instance to rely on | A backup leaves the host on a schedule and a restore was rehearsed, a deploy waits for the checks, the limits are set, and sign-in was tried on real devices |
| 2: the first usable version | M3 An exact gate that reaches the pull request | The verdict is right after a branch reset, a run with no tests, a late upload and a test that flips, and a decision turns the pull request green with no re-run |
| | M4 Agents | A team limits what an agent edits and answers, the record says who answered, and token cost is measured on two clients |
| | M5 The rest of the workflow | Shared steps, custom fields, attachments, requirements with coverage, reports, the regulated preset, importers and tracker ports are built, and each of the three profiles runs its workflow end to end |
| 3: 1.0 | M6 Teams and organisations | Teams, an identity provider, a second factor and mail are built, and PostgreSQL (#57) and a hosted tier (#31) each have a decision |
| | M7 Before 1.0 | The friction audit against the incumbents (floor item F3, #39), the accessibility audit and the trademark search are done |

The native iOS app the owner asked for on 2026-10-13 is a track beside the phases,
in the milestone `iOS app` (#171).

Why this order:

- **M1 comes first because the check judges every later change.** A test that fails
  by chance costs a pull request a re-run, and its failure stays a question on the
  instance until a person answers it. Six issues about such tests were open on
  2026-10-13.
- **M2 comes before any new capability.** Since 2026-10-13 the instance holds this
  repository's CI results and the owner's decisions on them, and nothing copies them
  off the host (#59).
- **M3 comes before M4 and M5.** The gate's verdict is what the product is for, so a
  case where it is wrong costs more than a capability that is missing.
- **M4 comes before M5.** Agent access is priority 2 of the vision. M4 is six issues,
  and the owner already met one of them: an agent answered a failure with the owner's
  token because the product had no way to delegate it (#118).
- **Phase 3 holds what matters once an instance has more than a handful of people**,
  and what the owner asked for before the name 1.0 is used.

The order says which milestone gets the next agent when two compete. It does not stop
an issue in M5 from starting while M3 is open: several threads work at once.

This replaces phases 3 and 4 below. Their contents went to M3 and M5 (runs, ingest,
traceability, gates, importers, reports) and M2 (deployment, backup and restore). One
of the earlier conditions for the first usable version moved: the Server layer on a
server database. Decision 0010 serves the Server layer from SQLite, so PostgreSQL
(#57) is in M6 as a decision for the owner. Move it back to phase 2 if the first
usable version should wait for it.

## Phase 0: UX research and design (now)

Plan: [ux-research-plan.md](ux-research-plan.md). Desk research, hands-on
use of incumbents and reviewed mocks; no interviews or recruited sessions.

- Desk research and a hands-on friction audit of incumbents on the core
  jobs, including their MCP servers.
- User flows ([ux/flows.md](ux/flows.md)): what people and agents do end to
  end, corrected first by the owner's comparison of the kinds of team they have worked in
  (decision 0005).
  They set the benchmark workload mix and the first MCP operations.
- Three process-spectrum team profiles, written as walks through the flows.
- Intent model and interaction hypotheses with rejection criteria.
- Traceability and gate views designed.
- Two mock rounds: static screens, then an instrumented feasibility mock
  that tests the interaction model and data flow together.
- Answer the open questions that shape the data model and record them as
  decisions: collaboration and offline are done (decision 0004; the mock
  tests which live-update candidates earn their place); review workflow
  default and gate model remain.

Exit: see the plan's exit criteria.

## Phase 1: Architecture spike and stack decision (parallel with phase 0)

- Build the benchmark dataset and harness: 100k cases, 1M then 10M results,
  the queries and budgets in the product vision and decision 0001. Record
  the hardware, concurrency, data distribution, cold and warm state, and the
  pass criterion for each budget before running.
- Run it on two or three candidate stacks, each in Local mode (embedded
  store) and Server mode (server database), per decision 0002, judging
  transactional semantics, concurrent writes and search as well as latency.
- Prototype the one-operation layer: a handful of operations exposed through
  REST, MCP and a CLI from one definition, to prove the generation path.
  Measure the tokens served for A1 and A4 on it against the naive baseline
  (decision 0006).
- Decide the stack. Supersede decision 0001 with the result, add `t3.json`
  scripts, the check command, stack rules in `AGENTS.md` and a worktree
  release step, in the same change.

Exit: benchmark numbers recorded, stack decision merged, empty project
skeleton builds and runs its check command.

## Phase 2: Core vertical slice (Local layer)

**Revised 2026-10-11 (decisions 0007, 0008; `docs/product-design.md` section 9).**
Phase 2 is **Preview 1**, the thin slice "one red build, three producers":
capture and versioning, `report` for CI and manual results with explicit
basis, change runs with the four-verdict gate, planned runs with slots any
admitted producer fills, the decision machinery with the `adopt`, `failure`,
`map`, `finding` and rule-only `signoff` kinds, Suite, Queue, Case, Run and
Change screens, CLI, MCP, `impact`, `since`, `check`, export and import,
Local layer only. Fragments, custom fields, the flaky detector, requirements
coverage, release gate rules, the role and freeze paths of sign-off, and the
Server layer proof move to phase 3, which is the **first usable version**
(decision 0002's rule: Server proven with the same job suite, persisted jobs,
backup and restore checked, before that name is used). The exit criteria for
phase 2 are the jobs and fixtures listed in the design (J11 and J12 below no
longer apply to phase 2; they move to phase 3 with the features they need).
The text below is the earlier plan, kept for its remaining exit criteria.


One project, folders, cases with steps, shared steps, custom fields,
versioning with diff and restore, proposed edits with review (the policy
switch from decision 0003, so J8 is possible), search, bulk move and retag
with undo. UI implements the surviving interaction hypotheses; the browser
latency test runs in the check command. MCP server with read and author
tools and the shipped skill, from the same operation definitions, with
scoped tokens and agent identity in history. Export and import of the
project. Ships as a single artifact that starts with no configuration.

Exit: human jobs J1 to J4, J7, J8, J11, J12 and J15 pass on the real product
at or better than the mock's measures; agent jobs A1 and A2 pass through
MCP with their token cost recorded; latency budgets hold on the benchmark data.

## Phase 3: Runs, CI ingest, traceability and gates

**Replaced 2026-10-13 by M2, M3 and M5 above.** The text below is the earlier plan,
kept for its exit criteria.

Plans and runs pinned to case versions, attachments behind the storage
interface, manual execution UI (J5), JUnit XML ingest through API, CLI and a
GitHub Actions step, unlinked-results inbox, manual/automated/both tracking,
flaky detection with evidence and quarantine. Requirement links and the
traceability views from phase 0 (matrix, chain, gap list). Release gates and
the PR and deploy status that enforce them. Reader access and scoped agent
tokens per project.

Exit: J5, J6, J9, J10, J13 and J14 pass; A3 passes; A4 to A6 pass within their token budgets; ingest budgets hold;
flaky state updates incrementally on ingest; each of the three profiles can
run its workflow end to end with policy switches only. Added 2026-10-11, the
first-usable prerequisites from decision 0002: the same artifact runs the
Server layer against a server database and passes the same job suite; jobs
are persisted and crash-safe; backup and restore are checked in the check
command; the Cloud layer's multi-instance correctness is proven with the
cache disabled. Only when these pass is the result called the first usable
version.

## Phase 4: Scaling, storage, migration import, reports

**Replaced 2026-10-13 by M2 and M5 above.** The text below is the earlier plan, kept
for its exit criteria.

(Revised 2026-10-11: the layer proofs, persisted jobs and backup/restore
moved to phase 3 as first-usable prerequisites.) Deployment on the home
server in a container; object storage for attachments; cache layer only if
the benchmark shows a budget miss without it, with invalidation across
instances tested; background workers split out if needed; migrations in the
check command. Import from TestRail, Qase and CSV. Basic reports over the
result stream.

Exit: Local to Server migration preserves identities, history, links and
attachments; import of a real TestRail or Qase export round-trips; object
storage and any cache pass the same job suite.

## Standing rules across phases

- Every phase that changes behaviour adds tests and runs the check on the
  real surface; performance and latency tests are part of the check from
  phase 2.
- Research continues: each phase ends with the job suite run on the real
  product against the baselines in `docs/ux/jobs.md`, and with a review of
  the result against the three team profiles.
- The phase order after phase 1 is revisable once research and the stack
  decision are in; change it here and say why.
- User-visible changes go in `CHANGELOG.md`; design decisions in
  `docs/decisions/`.
