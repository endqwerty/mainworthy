# User flows

The core jobs in [../ux-research-plan.md](../ux-research-plan.md) are single
tasks. A flow is what people and agents do end to end: who starts it, what
triggers it, what they hand to whom, what is read and written, and how often.
Flows come first because they decide what the jobs, the mocks, the operation
layer and the benchmark workload must cover.

**Status: every flow here is a hypothesis.** No interviews are planned, so
nothing below is observed behaviour. It is written from general QA practice
and the competitor analysis, and it is meant to be wrong in places. Each flow
has an "Open" line naming what would confirm or reject it. The sources that
can do that without recruiting users, in order of weight:

1. Daniel's account of how his own team tests and releases (open question 18).
   This is the only first-hand evidence available.
2. The hands-on friction audit of incumbents: what their users are forced to do
   shows what they were trying to do.
3. Vendor docs, release notes and public complaint threads (labelled Verified,
   Reported or Open as in `docs/competitive-analysis.md`).
4. The mocks, which expose flows that do not hang together.

Frequencies are guesses, marked "(guess)", for sizing the workload only.

## Actors

| Actor | Does |
| --- | --- |
| Author | Turns knowledge (specs, notes, bugs, exploratory sessions) into cases; keeps them current. Usually a QA engineer; in loose teams, a developer. |
| Executor | Runs manual cases and records results. May be the author, a tester or a developer doing a pre-release check. |
| Developer | Writes automated tests, reads CI failures, fixes or quarantines. |
| Lead | Plans a release's testing, reads coverage and results, decides go or no-go. |
| Approver | Regulated profile only: reviews and signs case changes and runs. |
| Reader | Product owner, support, auditor. Reads results and traceability; never edits. |
| Agent | Authors, runs, reports and links under its own identity and token scope. |
| CI system | Sends results and asks for gate status. Not a person, but the highest-volume writer. |
| Admin | Installs, configures projects and policies, issues tokens, imports data. |

## Flows

Each flow: trigger, steps, done when, how the profiles differ, jobs it uses,
what is open.

### F1. First run and first case

- **Actor / trigger:** Admin and Author, often the same person, evaluating the
  tool or starting a project.
- **Steps:** download and start (Local layer, no account) → create a project →
  write or paste a first case → run it or see it listed → decide whether to
  keep going. Optionally import existing cases (F11).
- **Done when:** a first case exists and the person believes the rest will
  not be harder. This flow decides adoption.
- **Profiles:** the same for all; policy switches are not offered up front.
- **Jobs:** J15, J1, J2. **Frequency (guess):** once per user; a few times for
  evaluators.
- **Open:** what a person with a spreadsheet or a folder of Markdown files
  expects to bring in on day one (question 18).

### F2. Capture knowledge into cases

- **Actor / trigger:** Author, with a spec, a ticket, notes, a bug that
  escaped, or an exploratory session just finished.
- **Steps:** create a case (or several) from free text, a pasted list or an
  outline → add or reuse shared steps → set type (manual, automated, both),
  tags, folder → link a requirement or issue → leave; autosave.
- **Done when:** the case says what to do and what to expect, and can be
  found again. Structure may be added later; capture must not wait for it.
- **Profiles:** regulated may require a reviewer before the version becomes
  current; loose does not. An agent may do the whole flow from a spec (F8).
- **Jobs:** J1, J2, J9, J11, A1. **Frequency (guess):** the most common
  authoring flow; bursts after a spec lands or a bug escapes.
- **Open:** free text first or structured from the start (research question 4).

### F3. Find, reorganise and maintain the suite

- **Actor / trigger:** Author or Lead; a feature changed, a folder is a mess,
  cases are duplicated or outdated.
- **Steps:** search or browse → select many → move, retag, edit a field,
  change a shared step, archive or merge duplicates → check what else was
  affected → undo if wrong.
- **Done when:** the structure matches how the team now thinks, and nobody
  lost a case or its history.
- **Profiles:** regulated teams need the change attributed and possibly
  approved; loose teams want it instant and undoable.
- **Jobs:** J3, J4, J7, J11, J12. **Frequency (guess):** weekly maintenance
  sessions; heavy reading, occasional bulk writes of hundreds of cases.
- **Open:** how often bulk operations happen and how large they get.

### F4. Plan and execute a manual run

- **Actor / trigger:** Lead plans (a release candidate, a sprint check, a
  regression); Executors run.
- **Steps:** choose cases by folder, tag, requirement or "not run in N days" →
  assign to people → start the run (versions pinned) → execute case by case,
  mostly by keyboard: pass, fail, block, skip, note, attachment → on a failure,
  raise or link a defect (F9) → watch progress → close the run.
- **Done when:** every case in scope has a result, or an accepted reason for
  none, and the Lead can state the outcome.
- **Profiles:** loose runs a short ad-hoc list; regulated needs approval to
  start and freezes the run as evidence on close.
- **Jobs:** J5, J7. **Frequency (guess):** per release and per risky change;
  several executors writing results at the same time (decision 0004).
- **Open:** how people really split a run between several executors.

### F5. CI results arrive and are triaged

- **Actor / trigger:** CI system, on every push or PR; then a Developer or
  tester when something fails.
- **Steps:** pipeline posts a report with commit, branch, PR, build, environment
  and attempt → ingest matches tests to cases; unmatched go to the inbox (F6)
  → flaky detection updates → commit status or PR check is posted → on a failure
  someone opens the link, sees new failures against flaky or known ones, reads
  evidence, and decides: fix, rerun, quarantine, link a defect.
- **Done when:** every failure on the PR is explained or acted on, and the PR
  status reflects the decision.
- **Profiles:** automation-heavy teams live in this flow; regulated teams
  also keep the report as evidence for the release.
- **Jobs:** J6, J10; A3 for agent-driven triage. **Frequency (guess):** the
  highest-volume write path by far (tens to thousands of reports a day);
  triage reads are bursty after a red build.
- **Open:** which CI systems and report formats come first (question 11).

### F6. Link automated tests to cases

- **Actor / trigger:** Author, Developer or Agent; the unlinked inbox is not
  empty, or a case needs an automated counterpart.
- **Steps:** open the inbox → for each unmatched test, link to an existing case,
  create a case, or ignore it → the system also flags linked tests that
  stopped reporting (stale) → fix identifiers in the test code when needed.
- **Done when:** the inbox is empty or consciously ignored, and automation
  rate is trustworthy.
- **Profiles:** optional auto-create per project suits loose teams.
- **Jobs:** A3, J9. **Frequency (guess):** a burst when a project is first
  connected, then a small trickle.
- **Open:** whether teams will annotate tests with case IDs at all.

### F7. From requirement to release decision

- **Actor / trigger:** Lead, before a release or at a milestone.
- **Steps:** pick the release scope (requirements, tickets) → see coverage
  and the latest results per requirement → see the gap list (no passing result
  on the released versions) → follow any red or gap back to cases, versions,
  commits → decide go or no-go, or fix the gap and look again.
- **Done when:** the decision is made and the reason is recorded.
- **Profiles:** loose teams glance at one number; regulated teams export the
  matrix as audit evidence.
- **Jobs:** J9, J10, J14. **Frequency (guess):** per release; the gate is
  also read by CI many times a day.
- **Open:** whether requirements live in an external tracker or in Casebook
  (question 16) and how deployments are reported (question 17).

### F8. Agent authors or changes, a person reviews

- **Actor / trigger:** an Agent, asked by a person or a schedule to write
  cases for a feature, update cases after a change, or report results.
- **Steps:** agent reads the area (cases, shared steps, history) under its own
  token → writes cases or edits, as new versions or as proposals depending on
  the project policy → a person sees what changed, reads the diff, accepts,
  edits or reverts → history records agent and approver.
- **Done when:** the accepted change is current, the rejected one is
  recorded, and the reviewer did not need a ceremony to decide.
- **Profiles:** loose accepts agent edits directly; standard and regulated
  require review (decision 0003).
- **Jobs:** A1, A2, J8, J13. **Frequency (guess):** unknown; the one flow whose
  volume depends on how well the MCP surface works.
- **Open:** how people actually decide whether to trust an agent's change.

### F9. Failure to defect

- **Actor / trigger:** Executor (F4) or Developer (F5) with a failed result.
- **Steps:** from the failure, create or link an issue in the external
  tracker with the case, version, result, evidence and build prefilled → the
  link comes back on the result → when the defect closes, rerun the case.
- **Done when:** the failure points to a tracked defect and the defect points
  back.
- **Jobs:** J5, J6, J10. **Frequency (guess):** a fraction of failures; depends
  on how much of the team uses the tracker.
- **Open:** whether Jira or ADO integration is day-one (question 4).

### F10. Close a release and keep the evidence

- **Actor / trigger:** Lead, with an Approver in the regulated profile.
- **Steps:** confirm the gates pass → freeze the run and the case versions
  as evidence (if the policy says so) → sign off with identity and time →
  export the traceability and results if an audit needs them.
- **Done when:** the release record cannot change afterwards and can be
  reproduced later.
- **Profiles:** skipped by loose teams; central for regulated ones.
- **Jobs:** J7, J10, J14. **Frequency (guess):** per release, rare.
- **Open:** how much evidence and signature depth the first version needs
  (question 15).

### F11. Bring data in, move data between layers

- **Actor / trigger:** Admin, when adopting from TestRail, Qase, ADO or CSV, or
  moving a Local project to a Server.
- **Steps:** export from the old tool or the Local project → import → check
  counts, links, history and attachments → fix what did not map → switch
  the team over.
- **Done when:** the team trusts the imported data enough to stop using the old
  tool.
- **Jobs:** none yet, so one is needed (see gaps). **Frequency (guess):** once
  per project, but it decides whether a team can adopt at all (question 5).
- **Open:** whether import is a launch requirement.

### F12. Give someone access

- **Actor / trigger:** Admin; a stakeholder needs results, a CI job needs an
  ingest token, an agent needs scoped author rights.
- **Steps:** create the user or token → set role and project scope → hand it
  over → later, see who or what used it and revoke it.
- **Done when:** the right people and agents have exactly the access they need,
  and it is visible.
- **Jobs:** J13, A2. **Frequency (guess):** rare, but every flow above depends
  on it.

## Rhythm: how the flows fit together

Hypothesised, per profile. This is the part most in need of Daniel's account.

| Cadence | Loose | Standard | Regulated |
| --- | --- | --- | --- |
| Every push | F5 | F5 | F5 |
| Daily | F5 triage, F2 a case now and then | F5 triage, F2, F3 | F5, F2 with review |
| Weekly | F3 occasionally | F3, F6 | F3 with approval |
| Per release | short F4, glance at F7 | F4, F7 | F4 with approval, F7, F10 |
| Rare | F11, F12 | F11, F12 | F11, F12 |

## Gaps against the core jobs

- **Flows with no job:** F11 (import and migration) and the ownership of the
  unlinked inbox (F6) have no measurable job. Add "J16: import 2,000 cases
  with history from a TestRail export and verify them" and "J17: empty an
  unlinked inbox of 50 tests".
- **Jobs with no flow:** J12 (shared step change) and J13 (reader access)
  appear only inside F3 and F12. Keep, but check they are used in practice
  in the audit.
- **Missing the first step of F5:** nobody has defined how a team connects CI
  for the first time. Add a job once question 11 is answered.
- **Cross-actor handoffs are untested by any job.** F4 (Lead to Executor),
  F8 (Agent to reviewer) and F10 (Lead to Approver) are where tools usually
  lose people. The mocks must cover a handoff, not only a screen.

## What the flows imply (to check, not to assume)

- **Write path:** CI ingest (F5) is the biggest writer by volume; manual
  results (F4) and authoring (F2, F3) are small and bursty; bulk edits (F3)
  are the spikes. The benchmark workload should mix them in these
  proportions, not test each alone.
- **Read path:** triage (F5), search (F3), run execution (F4) and the
  gate read by CI (F7) are the hot reads. Traceability and coverage (F7) are
  heavy joins read less often but must still be quick.
- **Concurrency:** many executors (F4), CI writers (F5) and agents (F8) at
  once on the same project; one author editing a case at a time (decision
  0004).
- **MCP first set:** the operations an agent needs for F2, F5/F6 and F8 are
  the first to define in the one-operation layer.
- **First five minutes:** F1 is the adoption gate and the only flow the Local
  layer must serve with no setup.

## How this changes the plan

- The research plan gains a flows step before profiles and the intent model;
  `flows.md` is its first output.
- The benchmark spec (roadmap phase 1) takes its workload mix from the flows
  once Daniel has corrected them; the dataset sizes and budgets do not wait.
- Each profile in `docs/ux/profiles.md` is written as a walk through the
  flows above with the policy switches that differ.
