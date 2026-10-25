# Mainworthy: rules for coding agents

A test case management system: TypeScript on Bun 1.4, PostgreSQL 18, a React web UI. Personal project, public on
GitHub; the owner is `endqwerty`, the person your global instructions name. Your global `~/.<agent>/AGENTS.md` applies
too.

Read [README.md](README.md), then `docs/product-vision.md`, `docs/competitors.md` and `docs/open-questions.md`.
Where it stands: `docs/roadmap.md`, `docs/decisions/` and [issue #64](https://github.com/endqwerty/mainworthy/issues/64)
(the work order); how it fits together: `docs/architecture.md`. The instance at
`https://mainworthy.com` follows `main` (`docs/deploy.md`).

A rule here names what enforces it; one that nothing enforces is a judgment call. A mistake that happens twice is
fixed in code, a check or a script, not noted here (decision 0091). This file stays under 12,000 bytes.

## Commands

| Command | What |
| --- | --- |
| `bun run check` | type-check, lint and functional tests; prerequisites: `scripts/preflight.ts` |
| `bun run test`, `bun test <file>`, `bun run dev` | the tests alone; one file; the server on `127.0.0.1:7357`, on the checkout's PostgreSQL cluster if no URL is set |
| `bun scripts/ci-scope.ts` | what CI would run for the branch (`.github/workflows/check.yml` says what each job does) |
| `bun scripts/work.ts scratch new <name>`, `scratch rm <directory>` | scratch files go in `~/.cache`, never in the worktree; `rm` deletes only a directory `new` made. A reviewer works in a `git archive <rev>` export there |
| `bun scripts/work.ts stop-server` | stop the servers you started |
| `bun scripts/work.ts release` | last command of a task, and the `release worktree` script of `t3.json`; refuses while a server, a test run or another bun process uses the checkout |
| `bun scripts/work.ts board`, `pr-body`, `sync-branch`, `check-time`, `ci` | below; `bun scripts/work.ts` alone lists every command; `test/work.test.ts` holds each |

## Rules

| Rule | What enforces it |
| --- | --- |
| **One registry.** A capability is an operation in `src/server/ops/index.ts`; HTTP, the OpenAPI document, the CLI, the MCP tools and the web client come from it. Add no route, command or tool beside it | `test/architecture.test.ts`, "the registry" |
| **The module map.** Imports go down the map. SQL is declared with `sql()` in the module that owns the table; read another module's data through its functions. `src/core` is pure (no I/O); `src/web` imports only `src/core`. Fix the design, not the test | `test/architecture.test.ts`, "the module map" |
| **Standing changes only through a decision.** Anything "current" (a case's head, a link, an excuse, a closed run, the policy) is written by a function that takes a `Witness`. Add no writer without one | `test/architecture.test.ts`, witness tests |
| **Schema changes update the PostgreSQL baseline**, `src/server/kernel/schema.sql`, and its snapshot, with a behaviour test. Keep archive compatibility explicit | `test/schema.test.ts` checks the catalog snapshot and prepares declared SQL |
| **Who a request is, is asked once.** A surface calls `admit` (`src/server/identity/identity.ts`) and holds no secret. A table with the hash of a secret is in `UNEXPORTED` | `test/architecture.test.ts`, identity tests |
| **A phone is styled in one file**, `src/web/phone.css`, each rule under `:root[data-layout="phone"]`. A screen adds no touch control for what a key does. A binding is `list: true` only when it decides nothing about the selected row | `test/architecture.test.ts`, "the phone layout" |
| **The iPhone app reads the server through one contract** (decision 0023): `scripts/ios/contract.ts`. Never edit a `Generated/` directory (`bun scripts/ios.ts gen`). Write no team id into the repository | `test/ios-contract.test.ts`; `ios/README.md` says what to do when it fails |
| **Licences are read from the build** (decision 0025). After changing a dependency run `bun scripts/licences.ts` and commit the result. A licence the script does not name is the owner's call, asked in the pull request | `test/licences.test.ts` |
| **The time of a write is the server's.** Only a demo project takes one from its caller (decision 0100). Put no time in an operation's input | `test/demo-time.test.ts`; `src/cli/demo/` is pure |
| **A feature adds to the demo** (the owner, 2026-10-15): `src/cli/demo/` decides what is written, `src/cli/seed.ts` sends it; draw nothing new from an existing random stream. Leave it out only when truly unreasonable, and say why in the pull request | the owner's review (nothing runs) |
| **A budget is a baseline that warns.** Every number goes through `budget()`: above the baseline it warns; above ten times it fails for review, unless the pull request moves the baseline and says why (the owner, 2026-10-24: "None of them should be hard limits"). After adding or splitting tests, refresh `scripts/test-timings.json` (docs/development/tests.md) | `scripts/budget.ts` |
| **Guard only what the design allows.** Before adding a check, test or audit fix, name who reaches the state; if the design rules it out, say so and add nothing (the owner, 2026-10-24: "Don't overly guard against situations that have been architected to not happen") | review judgment |
| **Tests run beside each other.** Take ports, directories and browser from the helpers; a test that fails only beside others shares something, so fix that. Timing and database process cleanup tests run alone with `bun run performance` | `test/helpers.ts`, `test/e2e/support.ts`, `scripts/check-plan.ts` |
| **A command-line test starts the command once** and asks the rest in-process | review judgment; `scripts/check.ts` reports duration |
| **A sentence on a screen about what the server does is a claim.** Say only what the screen can know | `test/evidence.test.ts` holds the failure question's sentence to the server; other screen copy is review judgment |
| **A user-visible change updates `docs/guide/` in the same pull request** and runs `bun scripts/gen-docs.ts` after a change to an operation, command, preset, capability or answer; a new page is also listed in `src/core/docs.ts` and `src/surfaces/docs/content.ts` | `test/docs.test.ts`, `test/e2e/docs.test.ts` (neither knows if a sentence is still true) |
| **The repository is public.** Write no tailnet name, address on the tailnet or home network, or machine name: `example.ts.net` and a documentation-range address | `test/architecture.test.ts`, "a public repository" (tailnet names only; the rest is review) |
| **The owner's name is not written here** (their request, 2026-10-13): write "the owner", and `robin` for an example person. The one exception is the copyright line (decision 0025) | `test/licences.test.ts`, "the owner's name is written only in the copyright line" |
| **A failing test in CI is yours to fix.** The instance's policy answers it "needs a fix", so `gate` stays red until a commit passes it. `bun scripts/work.ts ci` reads what failed (`docs/deploy.md`). Never overrule it with the owner token | the policy (`ci-policy`); the token is judgment |

## Working rules

- Nothing here is fixed before 1.0, and the owner says when that is. Any rule, decision, test, budget, feature or
  dependency may go when something better turns up: say what and why in the pull request. Nothing is compatible either:
  break stored data, tokens, the API or the CLI when it simplifies the result, say so in the changelog, and build no
  migration path. Safety, secrets, the public-repository rules and the owner's merge stay.
- Behaviour changes need tests and a check on the real surface. A user-visible change adds a `.changes/` fragment.
  Secrets never enter the repository, logs or chat.
- A decision record (a dated file in `docs/decisions/`) is only for a choice that is hard to reverse, would surprise a
  reader and came from a real trade-off. A `proposed` record binds nothing. Quote the owner with how firm they were
  ("maybe", "for now"); never cite them for an agent's choice.
- After a pull request lands, check that `/healthz` names its commit.
- Competitor claims in `docs/competitors.md` are hypotheses until verified.
- A review is sized to the change: the verifier reads the diff, runs `bun run check` and probes what it could break. The
  brief names the diff and a time (fifteen minutes for an ordinary change); a whole-area review is for a release or a
  rewrite. A finding becomes a test. The goal (#77): landing costs minutes.
- `bun scripts/work.ts check-time <base> <head>` compares the check's time, alternating runs and judging the spread. A
  rebase that leaves the verified tree unchanged needs no new review. Leave `TMPDIR` alone.

## Issues, pull requests and the board

The board is `https://github.com/users/endqwerty/projects/2`; a closing keyword in a pull request links it to its
issue and GitHub's workflows move both. A task the owner gave in a thread needs no issue: the pull request is its card.

- **Filing an issue.** One milestone (M1 to M7, `docs/roadmap.md`; each description says what belongs) and an `area:`
  label. A test that fails by chance gets `flaky-test` and M1; `decision` and `waiting-for-feedback` mark what an
  agent cannot finish alone. Add it to its list in #64.
- **Starting.** Before the first edit, `bun scripts/work.ts board start <number>` for the issue, and again for the
  pull request once it is open. `todo` and `done` set the other statuses; `board check` says when the ids in
  `scripts/work/board.ts` no longer fit the board.
- **Opening the pull request.** `Closes #123` on a line of its own only when the merge does all the issue asks;
  `Part of #123` otherwise. Give it the issue's milestone (`gh pr create --milestone`). Run
  `bun scripts/work.ts pr-body <number>`, as CI's `description` job does (after a fix, rerun that job). A keyword
  counts only while the base is `main`; in a stack set the issue In Progress by hand and read the links again when
  the pull request below has merged.
- **Stopping without finishing.** `board todo <number>` and say on the issue what is left (also for a pull request
  closed unmerged).
- **After the merge** both cards are Done; close a still-open issue with a comment linking the pull request. A problem
  found on the way gets its own issue.
- **Only the owner** changes the board's workflows, renames or adds a milestone (the view's filter, `docs/roadmap.md`
  and #64 together) and approves the `project` scope (`gh auth refresh -h github.com -s project`).

## Model profile

**deep**, the owner's choice: delegation takes models and effort from `homelab route models --profile deep`; `max` is
for a thread or task the owner names. When `homelab route plan --profile deep --role verifier --author codex` names no
one, take the verifier from `--profile balanced` and say so in the pull request; with none, report it unverified.

## Delivery

**Review-first: the owner merges; you do not.** On the T3 branch, follow the `build` skill: get the independent
verification `verify` asks for, open a non-draft pull request with a standalone description naming its issue (above),
link it to the thread, run the Daybreak audit every merge needs (`docs/security-audit.md`) and stop. Do not merge, arm
auto-merge, close it or push to `main`, even when checks are green. Only the owner saying, in the current thread, to
merge identified work lets you land it (the `ship` skill, `gh pr merge --rebase`, keeping the branch). A stack lands in
one step when the owner's word covers it: `docs/landing-a-stack.md`. Under `build`, `babysit` and `autopilot-stack`
nothing merges.

After the owner has merged and you start new work on the same T3 branch, run `bun scripts/work.ts sync-branch`: it moves
the branch onto `origin/main` and pushes it, refusing while the branch holds a commit not on `main` or the worktree has
changes.
