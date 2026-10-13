# 0003: Software QA only, and one model across the process spectrum

- Date: 2026-10-10
- Status: scope accepted (Daniel); spectrum approach proposed, to be tested in phase 0. Generalised 2026-10-11: the five switches are rows of the policy clause table in [0008](0008-one-evidence-model.md) and `docs/product-design.md` section 6.5.

## Scope: software QA

Mainworthy manages tests for software: manual and automated cases, plans, runs,
results, CI/CD integration and traceability to requirements, issues and code.
Hardware, laboratory, manufacturing and other forms of quality assurance are
out of scope. Research, competitors and features are judged against software
teams only.

## The process spectrum

Software teams differ in how strictly they separate and gate their QA:

- **Loose:** mostly automated, light manual checks, no sign-offs, speed first.
- **Standard:** QA engineers, reviewed case changes, release runs with pass
  criteria, external tracker for requirements and defects.
- **Regulated:** author and approver on every change, runs frozen as
  evidence at release, auditable traceability from requirement to result,
  possibly electronic signatures and retention rules.
- **Automation-heavy:** nearly all results come from CI/CD; the tool is a
  results, flakiness and traceability system more than an authoring tool.

## Decision (proposed)

Support the whole spectrum with **one data model and a small set of
per-project policies**, not separate modes or editions and not every
variation ad hoc.

- The model already carries what the strict end needs: immutable versions
  with author and reason, results stamped with the executed version and
  commit, append-only history. Nothing is added to the model only for one
  profile.
- Policies are switches a project sets, each with a default that suits the
  loose profile and a stricter option: review required before a version
  becomes current (none, for agents only, for everyone); approval required
  to start a release run; release gates (required cases executed, pass
  threshold, no open quarantine exceptions) that feed the CI status;
  evidence freeze (a run and its case versions become read-only at release);
  sign-off with a recorded identity. Profiles are presets that set the
  switches together; a team can change any switch.
- The full CI/CD strategy is in scope for every profile: results from every
  pipeline stage, gates on PR status and on deploy, and traceability that
  reaches commits, builds and deployments, not only requirements.
- Traceability is a first-class view, not a report: requirement to cases to
  versions to runs and results to commits, builds and deployments to
  defects, navigable in both directions, with a coverage matrix and a gap
  list per release. The views are designed in phase 0
  (`docs/ux/traceability-views.md`).

## What is not promised

- Regulatory certification or compliance claims (for example 21 CFR Part 11,
  ISO 29119 conformance). The model records what those require; validation
  packages and claims are for a later decision when a real team needs them.
- Electronic signatures with legal weight in the first usable version. The
  sign-off policy records identity and time; qualified signatures are a
  later addition behind the same policy.

## Consequences

- Policies are enforced in the operation layer, so the API, MCP and UI all
  obey them. Agents meet the same gates as people.
- Phase 0 writes the three team profiles and checks every mock against all
  of them; a design that serves one by making another miserable is rejected.
- Open questions 10 and 12 (review workflow and flaky policy defaults)
  become policy switches with defaults, decided in phase 0.

## Alternatives rejected

- **Pick one profile.** Loose-only forfeits the opening the competitive
  analysis found (history and audit gated behind enterprise tiers);
  regulated-only makes the tool heavy for everyone else.
- **Separate editions or modes.** Two feature sets drift and double the test
  surface. A policy switch is cheaper to build and to explain.
