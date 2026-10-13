# <img src="src/web/icon.svg" alt="" width="32" height="32" align="top"> Mainworthy

One place where manual, automated and agent testing land, and one queue of the decisions they leave for you.
Then one answer for a change: is it worthy of `main`?

A test case management system for software QA, built to fix what is annoying about TestRail, Qase, Jira
(Xray, Zephyr) and Azure DevOps Test Plans. **Status: MVP (2026-10-12).** It runs, it is tested, and it is a
preview: what is missing is listed in [decision 0012](docs/decisions/0012-mvp-scope-and-departures.md) and
tracked in the GitHub milestone *Backlog to 1.0* (one page of it: issue #64).
It was called Casebook until 2026-10-13 ([decision 0015](docs/decisions/0015-the-project-is-called-mainworthy.md)).

![The suite: cases on the left with their proof by person, pipeline and agent; the case as a document on the right](docs/ui/screenshots/suite-light.png)

The other screens, in both themes, are in [docs/ui/screenshots](docs/ui/screenshots): the
[queue](docs/ui/screenshots/queue-dark.png), a [run](docs/ui/screenshots/runs-light.png), a
[change](docs/ui/screenshots/changes-light.png), a [case with its diff](docs/ui/screenshots/case-light.png) and
[settings](docs/ui/screenshots/settings-light.png).

## Start (no account, no configuration)

```
$ bun install
$ bun run start
Mainworthy 0.1.0 · local · data in ~/.mainworthy · http://127.0.0.1:7357
project "scratch" · you are robin@this-machine · policy: loose
```

Open the URL. On your own machine you are signed in as the owner with no step.

The documentation comes with the server, at `/docs` (http://127.0.0.1:7357/docs, or **Docs** in the sidebar, which opens the page about the screen you are on):
how it works, each workflow, what you can customize, and a reference of every key, command and operation. The
sections below are the short version.

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
$ mainworthy report results/*.xml
$ mainworthy gate            # exit 0 passed · 1 failed · 2 blocked · 3 pending
```

In CI it is the same two lines; the commit, branch, pull request and attempt come from the environment. This
repository does it to itself in [.github/workflows/check.yml](.github/workflows/check.yml). Outside CI the commit
comes from the Git checkout; with neither, pass `--commit`. An error exits 4.

`mainworthy` here is `bun src/cli/main.ts`, or the single executable from `bun run build`.

## Decide

`g q` opens the queue. Each row is a question with its evidence, and each answer is one key with its
consequence written beside it: `d` defect, `f` flaky, `i` infrastructure, `e` expected. Your answer is recorded
with your name. `d` and `e` apply to later occurrences of the same cause until they are withdrawn or replaced,
`f` for 14 days, and `i` excuses that build only. `u` undoes; both decisions stay in the ledger.

## Run things by hand

`g r`, `n`, pick cases by folder, tag or search. Then `p` pass, `f` fail, `b` blocked, `s` skip. Results from CI
on the same commit fill the same run where the run allows it, so you only run what nothing else has shown.

## Let an agent in

```
$ mainworthy token new --agent reviewer --can read,produce
$ mainworthy mcp                   # stdio; or point the client at http://127.0.0.1:7357/mcp
```

Ten tools; start with `impact`. The skill that teaches an agent the case model is in
[skill/mainworthy](skill/mainworthy/SKILL.md). An agent's answers are advice unless the policy says otherwise, and
what an agent reports is shown and asked about but never moves a commit's gate: it counts only in a run that
asked for agents.

## Get stricter when you need to

```
$ mainworthy policy use standard   # agent edits need a person; unlinked tests are a question
$ mainworthy policy show           # the whole policy is one table
```

A policy says who answers each kind of question. Under `loose`, the default, edits to cases take effect at once,
a test needs no case, and a person is asked about failures and findings. Under `standard` an agent's edit waits
for a person and a test with no case is a question. Under `strict` a person, never an agent, answers each of
those questions and gives a reason. All three send a policy change to an admin and a conflicting edit back to
its author. The web UI compares the three in Settings, under Policy and under Projects.

## Deploy (one container, one volume)

```
$ docker compose up -d           # then sign in with the owner token (see compose.yaml)
```

Coolify on a home server: [docs/deploy.md](docs/deploy.md).

## Leave whenever you like

```
$ mainworthy export --out mainworthy.ndjson.gz     # every fact, decision and document, as text
```

## Develop

| Command | What |
| --- | --- |
| `bun run check` | type-check, lint and every test, including the latency budgets and the browser tests (skipped, with a message, on a machine with no Chromium) |
| `bun run dev` | the server on `127.0.0.1:7357`, restarting on change |
| `bun bench/run.ts` | the benchmark on 100,000 cases and 1,000,000 results (`--quick` for a small one) |
| `bun bench/external.ts <dataset>` | reads, reports and saves under load, with the load generator in its own process |
| `bun run build` | one self-contained executable in `dist/` |

Rules for contributors, people and agents: [AGENTS.md](AGENTS.md).

## Where to read next

| File | What |
| --- | --- |
| [docs/guide/](docs/guide/index.md) | the user documentation, which the instance serves at `/docs` |
| [docs/architecture.md](docs/architecture.md) | how it fits together, with diagrams |
| [docs/product-design.md](docs/product-design.md) | the product design: thesis, domain model, operation layer, product surface |
| [docs/decisions/](docs/decisions/) | decision records: 0009 the owner's answers, 0010 the stack, 0011 the UI, 0012 what the MVP builds and where it departs, 0013 asking what became of a command, 0014 a pipeline's token and which Mainworthy CI reports to, 0016 the documentation at `/docs` |
| [docs/compliance.md](docs/compliance.md) | what each legal regime needs, what is met, what is not |
| [docs/deploy.md](docs/deploy.md) | running it on a server |
| [docs/product-vision.md](docs/product-vision.md) | the problem and the priorities |
| [docs/competitive-analysis.md](docs/competitive-analysis.md) | 13 existing tools compared |
| [docs/roadmap.md](docs/roadmap.md) | phases and where the project stands |
| [docs/design-arena/](docs/design-arena/) | the candidate designs, benchmarks and verdicts behind the decisions |
| [CHANGELOG.md](CHANGELOG.md) | one line per user-visible change |
