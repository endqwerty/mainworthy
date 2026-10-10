# Casebook

A test case management system built to fix what is annoying about TestRail,
Qase, Jira (Xray/Zephyr and plain issues) and Azure DevOps Test Plans.

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
- an honest, simple permission and pricing model (no per-seat tax for people who only read results).

## Where to read next

| File | What |
| --- | --- |
| [docs/product-vision.md](docs/product-vision.md) | the problem, principles, scope, non-goals |
| [docs/competitors.md](docs/competitors.md) | what each existing tool does, and hypotheses on where it falls short |
| [docs/open-questions.md](docs/open-questions.md) | decisions that need Daniel's input before design starts |
| [docs/decisions/](docs/decisions/) | architecture decision records |
| [AGENTS.md](AGENTS.md) | rules for coding agents |
| [CHANGELOG.md](CHANGELOG.md) | one line per user-visible change |
