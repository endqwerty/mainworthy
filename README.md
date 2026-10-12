# Casebook

One place where manual, automated and agent testing land, and one queue of the decisions they leave for you.

A test case management system for software QA, built to fix what is annoying about TestRail, Qase, Jira
(Xray, Zephyr) and Azure DevOps Test Plans. **Status: MVP (2026-10-12).** It runs, it is tested, and it is a
preview: what is missing is listed in [decision 0012](docs/decisions/0012-mvp-scope-and-departures.md) and
tracked in the GitHub milestone *Backlog to 1.0*.

## Start (no account, no configuration)

```
$ bun install
$ bun run start
Casebook 0.1.0 · local · data in ~/.casebook · http://127.0.0.1:7357
project "scratch" · you are daniel · policy: loose
```

Open the URL. On your own machine you are signed in as the owner with no step.

## Write a case

Press `c`. Type a title, Enter, then steps. ` > ` starts the expected result. Paste a list and it is split for
you. There is no save button: your draft is kept as you type and becomes version 1 when you leave it.

```
Checkout applies a percentage coupon #checkout
  Open the cart with one $100.00 item
  Apply coupon SAVE10            > Total shows $90.00
  Reload the page                > Coupon is still applied
```

## Send test results (any runner that writes JUnit XML)

```
$ casebook report results/*.xml
$ casebook gate            # exit 0 passed · 1 failed · 2 blocked · 3 pending
```

In CI it is the same two lines; the commit, branch, pull request and attempt come from the environment. This
repository does it to itself in [.github/workflows/check.yml](.github/workflows/check.yml).

`casebook` here is `bun src/cli/main.ts`, or the single executable from `bun run build`.

## Decide

`g q` opens the queue. Each row is a question with its evidence, and each answer is one key with its
consequence written beside it: `d` defect, `f` flaky, `i` infrastructure, `e` expected. Your answer is recorded
with your name and applies to later occurrences of the same cause until the evidence changes. `u` undoes; both
decisions stay in the ledger.

## Run things by hand

`g r`, `n`, pick cases by folder, tag or search. Then `p` pass, `f` fail, `b` blocked, `s` skip. Results from CI
on the same commit fill the same run where the run allows it, so you only run what nothing else has shown.

## Let an agent in

```
$ casebook token new --agent reviewer --can read,produce
$ casebook mcp                   # stdio; or point the client at http://127.0.0.1:7357/mcp
```

Ten tools; start with `impact`. The skill that teaches an agent the case model is in
[skill/casebook](skill/casebook/SKILL.md). An agent's answers are advice unless the policy says otherwise.

## Get stricter when you need to

```
$ casebook policy use standard   # agent edits need a person; unlinked tests are a question
$ casebook policy show           # the whole policy is one table
```

## Deploy (one container, one volume)

```
$ docker compose up -d           # then sign in with the owner token (see compose.yaml)
```

Coolify on a home server: [docs/deploy.md](docs/deploy.md).

## Leave whenever you like

```
$ casebook export --out casebook.ndjson.gz     # every fact, decision and document, as text
```

## Develop

| Command | What |
| --- | --- |
| `bun run check` | type-check, lint and every test, including the latency budgets and the browser tests |
| `bun run dev` | the server on `127.0.0.1:7357`, restarting on change |
| `bun bench/run.ts` | the benchmark on 100,000 cases and 1,000,000 results (`--quick` for a small one) |
| `bun run build` | one self-contained executable in `dist/` |

Rules for contributors, people and agents: [AGENTS.md](AGENTS.md).

## Where to read next

| File | What |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | how it fits together, with diagrams |
| [docs/product-design.md](docs/product-design.md) | the product design: thesis, domain model, operation layer, product surface |
| [docs/decisions/](docs/decisions/) | decision records: 0009 the owner's answers, 0010 the stack, 0011 the UI, 0012 what the MVP builds and where it departs |
| [docs/compliance.md](docs/compliance.md) | what each legal regime needs, what is met, what is not |
| [docs/deploy.md](docs/deploy.md) | running it on a server |
| [docs/product-vision.md](docs/product-vision.md) | the problem and the priorities |
| [docs/competitive-analysis.md](docs/competitive-analysis.md) | 13 existing tools compared |
| [docs/roadmap.md](docs/roadmap.md) | phases and where the project stands |
| [docs/design-arena/](docs/design-arena/) | the candidate designs, benchmarks and verdicts behind the decisions |
| [CHANGELOG.md](CHANGELOG.md) | one line per user-visible change |
