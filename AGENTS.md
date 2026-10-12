# Casebook: rules for coding agents

A test case management system. Owner: Daniel (`endqwerty`). Personal project,
but Daniel reviews every change on GitHub before it lands. Your global
`~/.<agent>/AGENTS.md` applies too.

Read [README.md](README.md) first, then `docs/product-vision.md`,
`docs/competitors.md` and `docs/open-questions.md`.

## State

The MVP is built (2026-10-12): TypeScript on Bun, one SQLite file, a React web UI
(`docs/decisions/0010-stack.md`). What it contains and where it departs from the
design: `docs/decisions/0012-mvp-scope-and-departures.md`. What is deferred: the
GitHub milestone `Backlog to 1.0`. How it fits together: `docs/architecture.md`.
It runs on Daniel's Coolify for his own use since 2026-10-12 (`docs/deploy.md`; the
home lab's notes say where and how to redeploy). The one known blocking defect is
issue #81, in the web UI's conflict card.

## Stack rules

- **Commands.** `bun install`; `bun run check` (type-check, lint and every test,
  side by side: the test files in eight parallel workers, then the tests that
  measure time with the machine to themselves; the browser tests are skipped, with
  a message, on a machine with no Chromium); `bun run dev` (the server on
  `127.0.0.1:7357`, restarting on change). Bun 1.4; no other runtime or build tool.
  The check takes 107 s on the 16-thread desktop (2026-10-12, five runs of 107 to
  108 s; it was 403 s with the files one after another). `bun run test` is the
  tests alone, printed as they run. One file: `bun test test/suite.test.ts`. One
  shard, as CI runs it: `bun run test --only=parallel --shard=2/5`; the quiet
  tests: `bun run test --only=quiet`. CI (`.github/workflows/check.yml`) runs five shards and the quiet
  tests on a runner each, then one `gate` job reports every shard to Casebook and
  its gate is the result; a shard with no report fails it. Not yet run on GitHub:
  about three and a half minutes is expected (it was 716 s in one job).
- **One registry.** A capability is an operation in `src/server/ops/index.ts`. HTTP,
  the OpenAPI document, the CLI, the MCP tools and the web client come from it. Never
  add a route, a command or a tool beside it.
- **The module map is a test.** `test/architecture.test.ts` fails on an import that
  goes up the map, on SQL outside its owning module, and on any second way to mint a
  decision witness. Fix the design, not the test.
- **Standing changes only through a decision.** Anything that is "current" (a case's
  head, a link, an excuse, a closed run, the policy) is written by a function that
  takes a `Witness`. Do not add a writer without one. Four functions put back what
  a withdrawn or ended decision did (`restoreLink`, `dropExcuse`, `reopenRun`,
  `restoreFailures`) and take no witness: the withdrawal is the recorded event,
  and a test allows only the kind handlers to call them.
- **`src/core` is pure** and runs in the browser and the server. No I/O, no Node or
  Bun APIs. `src/web` imports only `src/core`.
- **SQL** is declared with `sql()` in the module that owns the table (the owner of
  each table is listed in `test/architecture.test.ts`), so the check can prepare every
  statement against the schema. To read another module's data, call its functions; do
  not join its tables. A schema change is a new file in
  `src/server/kernel/migrations/`; a shipped migration is never edited.
- **Budgets are tests** (`test/budgets.test.ts`, `bench/`). A change that misses a
  hot-path budget does not merge; do not raise the number.
- **The check's wall time is a budget** (`scripts/check-plan.ts`). The check warns
  when its tests take more than 115 s and fails above 120 s, unless other work
  keeps the machine busy. A change that makes the check slower says so and fixes
  it: split the file, share the set-up, do less in the browser. Do not raise the
  limit. A file that takes a worker longer than half a minute is the next thing to
  split; after adding or splitting one, `bun run test --update-timings` (six
  minutes) and commit `scripts/test-timings.json`, which balances the CI shards.
- **Tests run beside each other.** A test takes its ports, directories and browser
  from the helpers (`test/helpers.ts`, `test/e2e/support.ts`), never a fixed port
  or a shared path. One that fails only beside others shares something: fix that,
  do not retry it. Only a test that compares a measured time with a limit goes in
  `QUIET` (`scripts/check-plan.ts`), where it runs after the others.
- **Worktree release:** `rm -rf node_modules .casebook test-results` (also the
  `release worktree` script in `t3.json`, which runs when a thread settles).

## Working rules

- Behaviour changes need tests and a check run on the real surface.
- Record user-visible changes in `CHANGELOG.md`; record design decisions in
  `docs/decisions/NNNN-title.md`.
- Secrets never enter the repo, logs or chat.
- Competitor claims in `docs/competitors.md` are hypotheses until verified;
  do not build on one without checking it.
- Briefing a verifier: write the brief as a QA review of application logic and say
  that everything runs locally. On 2026-10-12 a Codex verifier was stopped by its
  provider's content filter in the middle of a run whose brief used the vocabulary
  of security testing ("forge", "escalate", "hostile"); the same checks in plain
  words ran to the end. Have it write each finding to its report as it confirms it,
  so a run that is cut off still leaves its findings.
- A delegated worker that ends with "Selected model is at capacity" has stopped for
  good: read what it left in the tree, finish or re-delegate the rest, and do not
  wait for it.
- A delegated child shares this checkout, and its own rules tell it to release the
  worktree when it finishes. Say in every task that it must not: on 2026-10-12 two
  children did, and removed `node_modules` under the lead and a builder that were
  still running. Reviewers work in an export (`git archive <rev> | tar -x -C <dir>`)
  and clean only that. If modules vanish mid-task: `bun install --frozen-lockfile`.

## Model profile

**deep**, Daniel's standing choice for this project (named 2026-10-11). Every
agent that delegates here takes models and effort from `homelab route models
--profile deep` instead of the default `balanced`: higher effort for all
classes, Opus on Claude verifiers and reviewers, Astra or Fable for `hard` and
`lead`. It is not `max`; Daniel names that for a single thread or task. A model
Daniel names in a thread still wins.

## Delivery

Delivery: **review-first**. Daniel merges; you do not.

Work on the T3 branch in your worktree and follow the `build` skill: check the
change, get the independent verification `verify` asks for, open a non-draft PR
with a standalone description (`gh pr create`), link it to the thread, and stop.
Do not merge, arm auto-merge, close the PR or push to `main`, even when the
checks are green. Opening the PR does not start a watcher; use `babysit` when
Daniel asks you to get an open PR merge-ready. Only Daniel saying, in the
current thread, to merge identified work lets you land it (the `ship` skill,
with its gates; the merge method is rebase, `gh pr merge --rebase`, keeping the
branch). "Keep going" or a budget request is not that.

After Daniel has merged and you start new work on the same T3 branch, move the
branch onto the merge first, so T3 does not keep showing the merged commits as
new changes (a rebase or squash merge leaves the branch's own commits outside
`main`):

```
git fetch && git reset --hard origin/main && git push --force-with-lease origin HEAD
```

Only when the previous PR is merged and the branch holds nothing unmerged. Then
check `git rev-list --count origin/main..HEAD` prints 0 (local `main` can be
checked out in another worktree and stale).
