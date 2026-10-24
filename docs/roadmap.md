# Roadmap

Phased plan from day zero to a first usable version. Each phase has exit
criteria; a phase ends when they are met and recorded, not on a date. Phases
0 and 1 overlap on purpose: research needs no stack, and the benchmark needs
no design.

This file keeps the phases and milestone goals. [Issue #64](https://github.com/endqwerty/mainworthy/issues/64)
keeps the current work order and the per-issue lists. Update both when the plan changes.

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
- The instance runs from the same build as a container backed by PostgreSQL 18. The Cloud
  layer and PostgreSQL are deferred (#57).

Scope is software QA across the process spectrum, loose to regulated, with
the full CI/CD flow in every profile (decision 0003).

## From the MVP to 1.0 (updated 2026-10-14)

On 2026-10-13 the milestone `Backlog to 1.0` became seven milestones, M1 to M7,
in three phases. Their titles stay unchanged so existing board filters do not break.
A milestone has no date. It ends when its acceptance criteria and required evidence
are met. The 2026-10-14 audit in [issue #64](https://github.com/endqwerty/mainworthy/issues/64)
sets the current work order. Milestone numbers do not require independent work to
wait for a device check or an owner decision.

| Phase | Milestone | True when it ends |
| --- | --- | --- |
| 1: harden the preview | M1 Reliable checks and known defects | The known defects and agreed phone checks are finished, no `flaky-test` or `bug` issue remains open, and the check meets its under-120 s goal |
| | M2 An instance to rely on | Scheduled backups leave the host, a restore drill is recorded, deployment waits for checks on the exact commit, instance limits are set, and real-device sign-in has evidence |
| 2: the first usable version | M3 An exact gate that reaches the pull request | Each assigned issue has a fixture for its effect on the gate, including branch heads, scope, empty reports, disputes and failure signatures, and outbound GitHub checks publish the verdict |
| | M4 Agents | Reviews belong to the exact change and patch, replies have registry schemas, delegation and edit limits preserve authority, and agent jobs meet budgets measured in two clients |
| | M5 The rest of the workflow | The remaining case, execution, reporting, traceability and data-movement work meets its criteria, and each of the three team profiles runs its workflow end to end with policy switches only |
| 3: 1.0 | M6 Teams and organisations | Assigned organisation features meet their criteria, and PostgreSQL and a hosted tier each have an owner-approved decision based on demonstrated need |
| | M7 Before 1.0 | The friction comparison, accessibility audit and trademark search have recorded results, distribution requirements are addressed, and the owner declares 1.0 |

The native MVP has shipped. The separate `iOS app` milestone tracks the remaining
app work and distribution evidence. TestFlight upload tooling does not prove that
installation works. Edit-overlap resolution shipped in the app on 2026-10-15. The
app also saves eligible queue answers on the device and sends them when it
reconnects. Linking a test and creating a case still need a connection. Native
passkeys are the next candidate feature. App instance selection and licence screens are deferred
owner choices; distribution requirements remain separate obligations.

The check warns above 130 s; CI shards warn above 180 s. Elapsed time is advisory by the
owner's decision 0097. Under 120 s remains the local goal, and
[issue #77](https://github.com/endqwerty/mainworthy/issues/77) tracks a future timing gate.
Runner, CLI-start and reader-startup reductions have shipped. Existing native reply
tests, case field values and policy presets also narrow the work left to do.

### Start next

Follow [issue #64, "Start next"](https://github.com/endqwerty/mainworthy/issues/64#start-next)
for the individual issues, their order and dependencies:

1. Preserve drafts during takeover and competing-window edits. Fix stored-reply
   erasure in parallel when ownership is separate.
2. Finish decision receipts and suggestions, including bulk Queue undo, then
   sustained-change paging.
3. Start off-host backups and a restore drill alongside exact-commit deployment
   gating. Neither waits for the check-time decision.
4. Finish credential retention, shared-browser cleanup and measured proxy
   configuration. Account-erasure controls follow the stored-reply fix.
5. Then prioritize exact gate evidence and the change and patch that an agent
   reviewed. Bring reply schemas forward when CI compatibility needs them.
   Outbound GitHub checks precede optional private report fetching.

Checked against the code on 2026-10-18, parts of this list have shipped: draft
takeover protection and kept copies of competing edits, removal of a forgotten
person's name from stored replies, bulk undo in the queue, paging of `since` under
sustained changes, erasure of revoked credentials and the admin's forget action,
reply schemas for every operation, and optional GitHub commit statuses for the
gate. Measured proxy configuration is not done. The rest of each item was not
checked here, and issue #64 keeps its state.

In parallel, confirm TestFlight installation, settle the private contact, and
gather sign-in and phone evidence on real devices. Public-source research for the
1.0 audits can also proceed before every organisation feature is complete.

Correctness and recovery come first because later capabilities depend on decisions
and evidence that remain true. Several workstreams can proceed together. M5 extends
the existing workflow; M6 needs concrete organisational demand; M7 records the
evidence for the owner's 1.0 decision. Source review alone proves no runtime,
device, deployment or compliance result.

The [private project board](https://github.com/users/endqwerty/projects/2) could not
be read during this update because the token lacks `read:project`. Its membership,
views and status automation are not verified here. Use issue #64 for the work order.

This replaces phases 3 and 4 below. Their contents went to M3 and M5 (runs, ingest,
traceability, gates, importers, reports) and M2 (deployment, backup and restore). One
of the earlier conditions for the first usable version moved: the Server layer on a
server database. PostgreSQL 18 now replaces the SQLite choice in decision 0010. The Local product layer
has ended. `compose.yaml` runs the app and database; running elsewhere is possible but not yet supported.

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
- User-visible changes add `.changes/<issue-or-unique-id>-<slug>.md`; new design decisions use
  `docs/decisions/YYYY-MM-DD-<slug>.md`. The coordinator assembles `CHANGELOG.md`.
