# Develop Mainworthy

These pages are for people and agents who change Mainworthy's code. The user guide that every instance serves at
`/docs` is in [docs/guide](../guide/index.md). It describes the product to its users and stays out of how the
code is built. The rules an agent must follow are in [AGENTS.md](../../AGENTS.md). These pages explain what those
rules rest on and how the pieces connect.

| Page | Read it to |
| --- | --- |
| This page | set up a checkout, run the server and learn the daily loop |
| [How the code is organised](code.md) | find where a piece of behaviour lives and which imports the module map allows |
| [Add an operation, a migration, a screen or a page](change-the-code.md) | make the common kinds of change and know which test guards each |
| [The check and the tests](tests.md) | run the tests, read the check's output and keep tests from interfering with each other |
| [From a branch to mainworthy.com](ci-and-delivery.md) | follow a change through CI, review, merge and deploy |

Two longer documents sit beside these. [docs/architecture.md](../architecture.md) explains the design in depth:
identity, sessions, the record, runs, policy and the headers on every reply.
[docs/features-and-flows.md](../features-and-flows.md) describes what the product does today, screen by screen,
with its workflows and data flows.

## Set up a checkout

To set up a checkout, follow these steps:

1. Install Bun 1.4 or newer. CI and the container use Bun 1.4.3.
2. Install PostgreSQL 18 binaries, or set `MAINWORTHY_TEST_PG` to a PostgreSQL 18 admin URL.
   The tests clone isolated databases; the URL must permit database creation. `MAINWORTHY_PG_BIN` can name
   the directory containing `initdb` and `pg_ctl`. `compose.yaml` runs PostgreSQL for an app deployment.
3. Install the packages.

	```
	$ bun install --frozen-lockfile
	```

4. Install the browser the browser tests run: the Chromium headless shell that playwright-core is built for, in
   Playwright's cache (decision 0114). Run it again after a playwright-core upgrade.

	```
	$ bun run browser
	```

   `MAINWORTHY_CHROMIUM` names another browser instead. A system Chromium is not used unless it names one.
   Without a browser, the check skips the browser tests and says so at the end.
5. Start the development server.

	```
	$ bun run dev
	```

	The server prints its address, `http://127.0.0.1:7357`, and the data directory it uses. On a loopback address
	the server runs in local mode and signs you in as the owner with no step.

`scripts/preflight.ts` checks the Bun version and the installed packages before the check runs. If either is
missing, it prints one line that says what to do and exits with code 4.

In a T3 Code worktree, `t3.json` runs the install when the worktree is created. It also offers `check`, `dev`
(with a preview of `http://127.0.0.1:7357`), a quick benchmark and `release worktree`.

## Keep development data apart

The server keeps its data in `~/.mainworthy` unless `MAINWORTHY_DATA` names another directory. That directory
holds attachment bytes and archive staging files. Structured records live in PostgreSQL. `bun run dev` uses
the checkout cluster when `MAINWORTHY_DATABASE_URL` is unset. A separate app data directory alone does not
isolate records; also point `MAINWORTHY_DATABASE_URL` at a separate database. For example:

```
$ MAINWORTHY_DATABASE_URL=postgres://mainworthy:password@127.0.0.1:5432/mainworthy_scratch \
	MAINWORTHY_DATA="$(bun scripts/work.ts scratch new dev)" bun run dev
```

To fill a new project called `demo` with a shop's suite, two weeks of results, runs and a queue of questions, run
the seed against the running server:

```
$ bun src/cli/main.ts seed demo
```

The seed writes through the same HTTP operations as any client. [Your data](../guide/data.md) and
[Configuration](../guide/configuration.md) list every variable the server reads.

## Run the server three ways

| Command | What runs | Use it to |
| --- | --- | --- |
| `bun run dev` | `bun --watch src/cli/main.ts serve`. Bun's development bundle of the web UI, with module reload and a looser page policy. The server restarts when a source file changes. | work on the code |
| `bun run start` | `src/cli/main.ts serve` with `NODE_ENV=production`. The built web UI under the strict page policy, with no reload. | see what a person who runs the source tree sees |
| `bun run build`, then `dist/mainworthy serve` | one self-contained executable with the server, the web UI, the CLI, the docs | test what the container ships |

In each form, `mainworthy` means the CLI. From source it is `bun src/cli/main.ts`. Every command and flag is in
the [command line reference](../guide/cli.md).

## Commands you will use

| Command | What it does |
| --- | --- |
| `bun test <file>` | runs one test file |
| `bun run test` | runs functional tests, with output as it comes. Performance tests run separately. |
| `bun run check` | runs the type-check, lint, async-port guard and functional tests, including browser tests. [The check and the tests](tests.md) explains its output. |
| `bun run typecheck`, `bun run lint`, `bun run format` | `tsc --noEmit`, `biome check .` and `biome check --write .` |
| `bun scripts/ci-scope.ts` | prints what CI would run for this branch |
| `bun scripts/gen-docs.ts` | rewrites the generated tables in `docs/guide` from the code |
| `bun bench/run.ts` | the benchmark on 100,000 cases and 1,000,000 results. `--quick` runs a small one. |
| `bun bench/external.ts <dataset>` | reads, reports and saves under load, with the load generator in its own process |
| `bun scripts/work.ts` | lists the worktree commands: scratch directories, the board, pull request checks, stopping servers and releasing the worktree |

## The daily loop

A change starts in a worktree on its own branch and ends when the instance at `https://mainworthy.com` runs it.
The owner reviews and merges every pull request. An agent stops after it opens one.

[![A change, from a branch to the deployed instance](diagrams/change-to-deploy.png)](diagrams/change-to-deploy.html)

The picture links to the interactive diagram. GitHub shows an HTML file as text, so download it or open it from a
checkout in a browser.

[From a branch to mainworthy.com](ci-and-delivery.md) explains each step.

## What every change carries

Each of these has a test or a script behind it, except where the table says otherwise.

| A change that | Also updates |
| --- | --- |
| a person can see | a new `.changes/<issue-or-unique-id>-<slug>.md` fragment and the relevant `docs/guide` page |
| an operation, a command, a preset, a capability or an answer key | the generated docs: run `bun scripts/gen-docs.ts` |
| a design choice that is hard to reverse, would surprise a later reader and came from a real trade-off | a decision record in `docs/decisions/YYYY-MM-DD-<slug>.md` (review judgment) |
| a feature | the demo in `src/cli/demo/`, unless that is truly unreasonable (the owner's review, nothing runs) |
| a dependency | the licence notices: run `bun scripts/licences.ts` |
| the schema | `src/server/kernel/schema.sql`, its catalog snapshot and a behaviour test; state stored-data and archive compatibility |

[Write a changelog fragment or decision](change-the-code.md#record-a-visible-change) describes the metadata and assembly commands.

[Project writes and authority](concurrency.md) explains actor and project locks, accepted report admission, and retryable contention.
