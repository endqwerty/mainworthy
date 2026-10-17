# <img src="src/web/icon.svg" alt="" width="32" height="32" align="top"> Mainworthy

Mainworthy keeps your test cases, the results from people, pipelines and agents, and one queue of questions
about them. Its gate answers whether a change is worthy of `main`.

Mainworthy is a test case management system for software QA. The MVP shipped on 2026-10-12 and remains a
preview. [Decision 0012](docs/decisions/0012-mvp-scope-and-departures.md) records the MVP's scope. The GitHub
milestones M1 to M7 and the separate `iOS app` milestone track the remaining work.
[Issue #64](https://github.com/endqwerty/mainworthy/issues/64) keeps the current work order.
[docs/roadmap.md](docs/roadmap.md) describes the phases and milestone goals.
It was called Casebook until 2026-10-13 ([decision 0015](docs/decisions/0015-the-project-is-called-mainworthy.md)).

![The suite: cases on the left with their proof by person, pipeline, and agent, with the case as a document on the right](docs/ui/screenshots/suite-light.png)

The other screens, in both themes, are in [docs/ui/screenshots](docs/ui/screenshots): the
[queue](docs/ui/screenshots/queue-dark.png), a [run](docs/ui/screenshots/runs-light.png), a
[change](docs/ui/screenshots/changes-light.png), a [case with its diff](docs/ui/screenshots/case-light.png), the
[reports](docs/ui/screenshots/reports-light.png) and [settings](docs/ui/screenshots/settings-light.png).

## Start (no account, no configuration)

To start from the source tree, follow these steps:

1. Install Bun 1.4 or newer.
2. Install the packages from the source tree.

	```
	$ bun install
	```

3. Start the server.

	```
	$ bun run start
	Mainworthy 0.1.0 · local · data in ~/.mainworthy · http://127.0.0.1:7357
	project "scratch" · you are robin@this-machine · policy: loose
	```

4. Open the URL that the server prints. Local mode signs you in as the owner.

To look around a filled project, run `mainworthy seed demo`. The command writes a shop's suite with two weeks of results and runs and a queue to work through.

The server includes the [documentation](http://127.0.0.1:7357/docs) at `/docs`. **Docs** at the bottom of the
sidebar opens the page about your current screen. The guide covers workflows, settings, keys, commands and
operations. The sections below are the short version.

## Write a case

To write a case in the web UI, follow these steps:

1. Press `c`.
2. Type a title.
3. Press Enter.
4. Type the steps. Use ` > ` to start an expected result.

If you paste a list, the app splits the list into steps. The app keeps your draft as you type.
The draft becomes version 1 when you leave the case, press `⌘ Enter`, or pause for 30 seconds.

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

In CI, use the same two lines. The commit, branch, pull request, and attempt come from the environment. This
repository does it to itself in [.github/workflows/check.yml](.github/workflows/check.yml). Outside CI the commit
comes from the Git checkout. If neither source provides a commit, pass `--commit`. An error exits 4.

`mainworthy` here is `bun src/cli/main.ts`, or the single executable from `bun run build`.

## Decide

`g q` opens the queue. Each row is a question with its evidence. Each answer has a key and a description of its consequence. For a failure, `d` means defect, `f` flaky, `i` infrastructure and `e` expected.
Mainworthy records your answer with your name. `d` and `e` require a fix and apply to later occurrences of the
same cause while their evidence still holds. By default, `f` excuses the cause for up to 14 days, and `i`
excuses only that build. `u` withdraws an answer. The decision and its withdrawal both stay in the ledger.

To answer several questions of one kind, follow these steps:

1. Select their boxes. To select a range, hold Shift. To select all eligible rows of that kind in the loaded list, press `*`. The list can hold up to 500 questions.
2. Give one answer.

## Run things by hand

To start a planned run, follow these steps:

1. Press `g r`.
2. Press `n`.
3. Pick cases by folder, tag, or search.
4. Record each result with `p` for pass, `f` for fail, `b` for blocked, or `s` for skip.

Where the run allows it, CI results on the same commit fill the same run. You run only what has no result yet.

Open a change in **Changes** to see the results its gate counted. **Tests** (`g t`) lists automated tests,
with or without a case, and each test's latest results.

## Let an agent in

```
$ mainworthy token new --agent reviewer --can read,produce
$ mainworthy mcp                   # stdio; or point the client at http://127.0.0.1:7357/mcp
```

There are ten agent tools. Start with `impact`. The skill that teaches an agent the case model is in
[skill/mainworthy](skill/mainworthy/SKILL.md). An agent's answers are advice unless the policy says otherwise.
Mainworthy shows and asks about an agent's reports, but those reports never change a commit's gate.
An agent's report counts only in a run that asked for agents.

## Get stricter when you need to

```
$ mainworthy policy use standard   # agent edits need a person
$ mainworthy policy tests create   # a test with no case gets one: ask | track | create
$ mainworthy policy show           # the whole policy is one table
```

A policy says who answers each kind of question. Under `loose`, the default, case edits take effect at once
and a test needs no case. A rule excuses a failure already present on the base while its evidence holds.
A person answers other failures and findings. Under `standard` an agent's edit waits for a person. Under
`strict` a person approves case edits and answers failures and findings, with a reason.

The policy also decides what happens to a test with no case. Mainworthy tracks it without one, creates a case
for it, or raises a question for its file. All three presets send policy changes to an admin and conflicting
edits back to their authors. The web UI compares the presets in Settings, under Policy and under Projects.

## Deploy (one container, one volume)

```
$ docker compose up -d           # then sign in with the owner token (see compose.yaml)
```

Coolify on a home server: [docs/deploy.md](docs/deploy.md).

## Leave whenever you like

```
$ mainworthy export --out mainworthy.ndjson.gz     # cases, results and decisions, as text
```

See [your data](docs/guide/data.md) for what an archive includes and leaves out.

## Develop

| Command | What |
| --- | --- |
| `bun run check` | Type-checks, lints, and runs every test, including latency budgets and browser tests. Without Chromium, browser tests are skipped with a message. `MAINWORTHY_CHROMIUM` names a browser. The command lists each failed test at the end. It requires Bun 1.4 and installed packages, and prints one line if either is missing. |
| `bun run dev` | Runs the server on `127.0.0.1:7357` with Bun's development bundle of the web UI and restarts it on change. A changed module reaches the open page under a looser page policy (`docs/architecture.md`). |
| `bun run start` | the same server as a person runs it: the built web UI under the strict page policy, no reload |
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
| [ios/](ios/README.md) | the iPhone app: how to install it on your phone, and how to work on it |
| [docs/product-vision.md](docs/product-vision.md) | the problem and the priorities |
| [docs/competitive-analysis.md](docs/competitive-analysis.md) | 13 existing tools compared |
| [docs/roadmap.md](docs/roadmap.md) | phases and where the project stands |
| [docs/design-arena/](docs/design-arena/) | the candidate designs, benchmarks and verdicts behind the decisions |
| [CHANGELOG.md](CHANGELOG.md) | one line per user-visible change |

## Licence

Mainworthy is licensed under the [Apache License 2.0](LICENSE). Its copyright notice is in [NOTICE](NOTICE).
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) lists the software Mainworthy bundles from others and their licences.
An instance serves all three files at `/docs/licence`.
