# Mainworthy: rules for coding agents

A test case management system: TypeScript on Bun 1.4 (a choice, not a lock-in: decision 0010), one SQLite file, a React
web UI. Personal project, public on GitHub; the owner (`endqwerty`, the person your global instructions name)
reviews every change before it lands. Your global `~/.<agent>/AGENTS.md` applies too.

Read [README.md](README.md), then `docs/product-vision.md`, `docs/competitors.md` and `docs/open-questions.md`.
Where it stands: `docs/roadmap.md`, `docs/decisions/` and [issue #64](https://github.com/endqwerty/mainworthy/issues/64)
(the work order and every open issue); how it fits together: `docs/architecture.md`. The instance at
`https://mainworthy.com` follows `main` (`docs/deploy.md`).

A rule here names what enforces it; one that nothing enforces is a judgment call. A mistake that happens twice is
fixed in code, a check or a script, not noted here (decision 0091). This file stays under 12,000 bytes.

## Commands

| Command | What |
| --- | --- |
| `bun run check` | type-check, lint and every test, about two minutes; a machine that cannot run it says why in one line (`scripts/preflight.ts`) |
| `bun run test`, `bun test <file>`, `bun run dev` | the tests alone; one file; the server on `127.0.0.1:7357` |
| `bun scripts/ci-scope.ts` | what CI would run for the branch (`.github/workflows/check.yml` says what each job does) |
| `bun scripts/work.ts scratch new <name>`, `scratch rm <directory>` | scratch files go in `~/.cache`, never in the worktree; `rm` deletes only a directory `new` made. A reviewer works in a `git archive <rev>` export there |
| `bun scripts/work.ts stop-server`, `wait-tests` | stop the servers you started; wait for another agent's test run (one agent at a time runs the whole suite) |
| `bun scripts/work.ts release` | last command of a task, and the `release worktree` script of `t3.json`; refuses while a server, a test run or another bun process works from the checkout |
| `bun scripts/work.ts board`, `pr-body`, `sync-branch`, `check-time` | below; `bun scripts/work.ts` alone lists every command; `test/work.test.ts` holds each |

## Rules

| Rule | What enforces it |
| --- | --- |
| **One registry.** A capability is an operation in `src/server/ops/index.ts`; HTTP, the OpenAPI document, the CLI, the MCP tools and the web client come from it. Add no route, command or tool beside it | `test/architecture.test.ts`, "the registry" |
| **The module map.** Imports go down the map. SQL is declared with `sql()` in the module that owns the table; read another module's data through its functions. `src/core` is pure (no I/O); `src/web` imports only `src/core`. Fix the design, not the test | `test/architecture.test.ts`, "the module map" |
| **Standing changes only through a decision.** Anything "current" (a case's head, a link, an excuse, a closed run, the policy) is written by a function that takes a `Witness`. Add no writer without one | `test/architecture.test.ts`, witness tests |
| **Schema changes are a new migration** in `src/server/kernel/migrations/`; a shipped one is never edited. Mark `archive` as the comment on `MIGRATIONS` says, and test the behaviour too | `test/architecture.test.ts` migration tests keep versions contiguous and the `archive` marks true to the SQL; that a shipped migration is never edited is review judgment |
| **Who a request is, is asked once.** A surface calls `admit` (`src/server/identity/identity.ts`) and holds no secret. A table with the hash of a secret is in `UNEXPORTED` | `test/architecture.test.ts`, identity tests; the comment on `openSession` says why a hash, not an id, crosses the write gate |
| **A phone is styled in one file**, `src/web/phone.css`, each rule under `:root[data-layout="phone"]`. A screen adds no touch control for what a key does. A binding is `list: true` only when it decides nothing about the selected row | `test/architecture.test.ts`, "the phone layout" |
| **The iPhone app reads the server through one contract** (decision 0023): `scripts/ios/contract.ts`. Never edit a `Generated/` directory (`bun scripts/ios.ts gen`). Write no team id into the repository | `test/ios-contract.test.ts`; `ios/README.md` says what to do when it fails |
| **Licences are read from the build** (decision 0025). After changing a dependency run `bun scripts/licences.ts` and commit the result. A licence the script does not name is the owner's call, asked in the pull request | `test/licences.test.ts` |
| **The time of a write is the server's.** Only a demo project takes one from its caller (decision 0100). Put no time in an operation's input | `test/demo-time.test.ts`; `src/cli/demo/` is pure |
| **A feature adds to the demo** (the owner, 2026-10-15): `src/cli/demo/` decides what is written, `src/cli/seed.ts` sends it; draw nothing new from an existing random stream. Leave it out only when truly unreasonable, and say why in the pull request | the owner's review (nothing runs) |
| **Product budgets are tests**; raise no number. Advisory: whole-check and CI shard durations (decision 0097, #77) and the MCP tool list's size (0118). After adding or splitting tests, refresh and commit `scripts/test-timings.json`: `bun scripts/work.ts timings-from-ci <run-id>` from passing CI, or `bun run test --update-timings` locally | `test/budgets.test.ts`, `scripts/check-plan.ts` |
| **Tests run beside each other.** Take ports, directories and browser from the helpers; a test that fails only beside others shares something, so fix that. Only a test that compares a time with a limit goes in `QUIET` | `test/helpers.ts`, `test/e2e/support.ts`, `scripts/check-plan.ts` |
| **A command-line test starts the command once** and asks the rest in-process | review judgment; `scripts/check.ts` reports duration |
| **A sentence on a screen about what the server does is a claim.** Say only what the screen can know | `test/evidence.test.ts` holds the failure question's sentence to the server; other screen copy is review judgment |
| **A user-visible change updates `docs/guide/` in the same pull request** and runs `bun scripts/gen-docs.ts` after a change to an operation, command, preset, capability or answer; a new page is also listed in `src/core/docs.ts` and `src/surfaces/docs/content.ts` | `test/docs.test.ts`, `test/e2e/docs.test.ts` (neither can tell whether a sentence is still true: read the page) |
| **The repository is public.** Write no tailnet name, address on the tailnet or home network, or machine name: `example.ts.net` and a documentation-range address | `test/architecture.test.ts`, "a public repository" (tailnet names only; the rest is review) |
| **The owner's name is not written here** (their request, 2026-10-13): write "the owner", and `robin` for an example person. The one exception is the copyright line (decision 0025) | `test/licences.test.ts`, "the owner's name is written only in the copyright line" |
| **The former name** (decision 0015) stays only in the files the architecture test lists | `test/architecture.test.ts`, "the project's name" |
| **A failing test in CI is a question on the instance**, and `gate` stays red until a person answers it there (`docs/deploy.md`). Fix the test, or leave the question to the owner and say which. Never answer your own pull request's with the owner token | `scripts/ci-gate.ts` keeps `gate` red. Not answering with the owner token is judgment: nothing runs |

## Working rules

- Nothing is compatible before 1.0, and the owner says when that is. A change may break stored data, tokens, the
  API and the CLI when that makes the result simpler. Say what breaks in `CHANGELOG.md`; build no migration path.
- Behaviour changes need tests and a check on the real surface. Record user-visible changes in `CHANGELOG.md` and
  design decisions in `docs/decisions/NNNN-title.md`. Secrets never enter the repository, logs or chat.
- After a pull request lands, check that `/healthz` names its commit.
- Competitor claims in `docs/competitors.md` are hypotheses until verified.
- A review is sized to the change: the verifier reads the diff, runs `bun run check` and probes what the change
  could break next to it. The brief names the diff and a time (fifteen minutes for an ordinary change); a whole-area
  review is for a release or a rewrite. A finding becomes a test. The owner's goal (#77): landing costs minutes.
- To compare the check's time, `bun scripts/work.ts check-time <base> <head>` times both alternately and judges the
  spread; a rebase that leaves the tree as it was verified needs no round (it says so). Leave `TMPDIR` alone.

## Issues, pull requests and the board

The board is `https://github.com/users/endqwerty/projects/2`; a closing keyword in a pull request links it to its
issue and GitHub's workflows move both. A task the owner gave in a thread needs no issue: the pull request is its card.

- **Filing an issue.** One milestone (M1 to M7, `docs/roadmap.md`; each description says what belongs) and an `area:`
  label. A test that fails by chance gets `flaky-test` and M1; `decision` and `waiting-for-feedback` mark what an
  agent cannot finish alone. Add it to its list in #64.
- **Starting.** Before the first edit, `bun scripts/work.ts board start <number>` for the issue, and again for the
  pull request once it is open. `todo` and `done` set the other statuses; `board check` says when the ids in
  `scripts/work/board.ts` no longer fit the board.
- **Opening the pull request.** `Closes #123` on a line of its own only when the merge makes everything the issue
  asks for true; `Part of #123` otherwise. Give it the issue's milestone (`gh pr create --milestone`). Run
  `bun scripts/work.ts pr-body <number>`: it reads back what GitHub linked, and the `description` job of CI runs it
  (after a fix, run that job again). A keyword counts only while the base is `main`; in a stack set the issue In
  Progress by hand and read the links again when the pull request below has merged.
- **Stopping without finishing.** `board todo <number>` and say on the issue what is left (also for a pull request
  closed unmerged).
- **After the merge** both cards are Done; close a still-open issue with a comment linking the pull request. A problem found on the way gets its own issue.
- **Only the owner** changes the board's workflows (in the browser), a renamed or added milestone (the view's filter,
  `docs/roadmap.md` and #64 together), and approves `gh auth refresh -h github.com -s project` (the `project` scope).

## Model profile

**deep**, the owner's standing choice: delegation takes models and effort from `homelab route models --profile
deep`, not `balanced`; `max` is for a thread or task the owner names. When `homelab route plan --profile deep --role
verifier --author codex` names no one (the Opus window is spent), take the verifier from `--profile balanced` and
say in the pull request that it ran at balanced; with no other provider able to verify, report the work as not
independently verified.

## Delivery

**Review-first: the owner merges; you do not.** Work on the T3 branch in your worktree and follow the `build` skill:
check the change, get the independent verification `verify` asks for, open a non-draft pull request with a
standalone description that names its issue (above), link it to the thread, and stop. Do not merge, arm auto-merge,
close it or push to `main`, even when the checks are green. Only the owner saying, in the current thread, to merge
identified work lets you land it (the `ship` skill, by rebase: `gh pr merge --rebase`, keeping the branch). A stack
lands in one step when the owner's word covers it: `docs/landing-a-stack.md`. Under `build`, `babysit` and
`autopilot-stack` nothing merges, and a stack is no exception.

After the owner has merged and you start new work on the same T3 branch, run `bun scripts/work.ts sync-branch`:
it moves the branch onto `origin/main` and pushes it, and refuses while the branch holds a commit that is not on
`main` or the worktree has changes.
