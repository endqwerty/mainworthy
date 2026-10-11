# Casebook

A test case management system for software QA, built to fix what is annoying
about TestRail, Qase, Jira (Xray/Zephyr and plain issues) and Azure DevOps
Test Plans, for teams from loose and automation-heavy to regulated.

**Status:** day zero. No language, framework, database or hosting is chosen
yet (see [docs/decisions/0001-stack-open.md](docs/decisions/0001-stack-open.md)).
Nothing here is built; this repo holds the intent so the first implementation
thread starts from the same page.

## Goal

Manage test cases, plans, runs and results for a software team, with:

- fast, keyboard-first authoring and execution, even with tens of thousands of cases;
- a case model that has real history (versions, diffs, who changed what and why);
- traceability to requirements, issues and code without forcing tests to be tickets;
- results that are easy to get in from CI and easy to report out;
- an honest, simple permission and pricing model (no per-seat tax for people who only read results);
- self-hosting in layers: one process on a laptop, a container on a home server, or a cloud deployment with optional cache, from one build.

## Where to read next

| File | What |
| --- | --- |
| [docs/product-vision.md](docs/product-vision.md) | the problem, principles, scope, non-goals |
| [docs/competitive-analysis.md](docs/competitive-analysis.md) | researched comparison of 13 tools: pricing, gating, verified vs reported |
| [docs/competitors.md](docs/competitors.md) | what each existing tool does, and hypotheses on where it falls short |
| [docs/roadmap.md](docs/roadmap.md) | phased plan with exit criteria; phase 0 is UX research |
| [docs/decisions/0003-scope-software-qa-and-process-spectrum.md](docs/decisions/0003-scope-software-qa-and-process-spectrum.md) | software QA only; one model, policy switches across loose to regulated teams |
| [docs/decisions/0005-generic-audience-and-practitioner-evidence.md](docs/decisions/0005-generic-audience-and-practitioner-evidence.md) | for teams in general; Daniel's cross-team experience is practitioner evidence, not the customer |
| [docs/decisions/0006-agent-token-efficiency.md](docs/decisions/0006-agent-token-efficiency.md) | agent token cost for adversarial review and testing is measured and budgeted like latency |
| [docs/ux/flows.md](docs/ux/flows.md) | end-to-end user flows by actor, as hypotheses |
| [docs/ux-research-plan.md](docs/ux-research-plan.md) | how friction is measured before code: desk research, hands-on audit, jobs, profiles, intent model, mocks |
| [docs/open-questions.md](docs/open-questions.md) | decisions that need Daniel's input before design starts |
| [docs/decisions/](docs/decisions/) | architecture decision records |
| [AGENTS.md](AGENTS.md) | rules for coding agents |
| [CHANGELOG.md](CHANGELOG.md) | one line per user-visible change |
