# Mainworthy: rules for coding agents

A test case management system, called Casebook until 2026-10-13
(`docs/decisions/0015-the-project-is-called-mainworthy.md`). Owner: `endqwerty`,
the person your global instructions name. Personal project, public on GitHub since 2026-10-13, and the owner
reviews every change there before it lands. Your global
`~/.<agent>/AGENTS.md` applies too.

Read [README.md](README.md) first, then `docs/product-vision.md`,
`docs/competitors.md` and `docs/open-questions.md`.

## State

The MVP is built (2026-10-12): TypeScript on Bun, one SQLite file, a React web UI
(`docs/decisions/0010-stack.md`). What it contains and where it departs from the
design: `docs/decisions/0012-mvp-scope-and-departures.md`. What is deferred: the
GitHub milestone `Backlog to 1.0`. How it fits together: `docs/architecture.md`.
It runs on the owner's Coolify for their own use since 2026-10-12, at
`https://mainworthy.com` since 2026-10-13 (`docs/deploy.md`; the home lab's notes
say where and how to redeploy). This repository's CI reports to it since 2026-10-13 (issue #92).
No blocking defect is known: issue
#81, in the web UI's conflict card, is fixed (`docs/decisions/0013-ask-what-became-of-a-command.md`).
Sign-in was rebuilt on 2026-10-13 (`docs/decisions/0017-sign-in-sessions-and-credentials.md`): a browser
session that is not the token, token expiry, a limit on failed attempts, and people signing in as themselves
with a password or a passkey after an invitation, in the web UI (the sign-in page, the page of an invitation,
and "Your sign-in", "Your sessions" and "People" in Settings), through the API and on the command line.

## Stack rules

- **Commands.** `bun install`; `bun run check` (type-check, lint and every test,
  side by side: the test files in eight parallel workers, then the tests that
  measure time with the machine to themselves; the browser tests are skipped, with
  a message, on a machine with no Chromium); `bun run dev` (the server on
  `127.0.0.1:7357`, restarting on change). Bun 1.4; no other runtime or build tool.
  The check takes 120 to 122 s on the 16-thread desktop (2026-10-13, eight runs;
  it was 403 s with the files one after another). `bun run test` is the
  tests alone, printed as they run. One file: `bun test test/suite.test.ts`. One
  shard, as CI runs it: `bun run test --only=parallel --shard=2/6`; the quiet
  tests: `bun run test --only=quiet`. CI (`.github/workflows/check.yml`) runs six shards (five until 2026-10-13) and the quiet
  tests on a runner each, then one `gate` job reports every shard to Mainworthy and
  its gate is the result (the deployed instance when the repository names one and
  the job can use it, else a Mainworthy the job starts: `scripts/ci-instance.ts`,
  decision 0014; since 2026-10-13 that is `https://mainworthy.com`, project `mainworthy`: `docs/deploy.md`);
  a shard with no report fails it, and so does a test
  file in which every test was skipped. An `image` job builds the container and
  asks it for `/docs`; the gate job fails with it. On GitHub the workflow takes about four
  minutes (2026-10-12, two runs: 4 min 24 s and 3 min 49 s; it was about 12 in one job).
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
  `src/server/kernel/migrations/`; a shipped migration is never edited. Its entry
  in `MIGRATIONS` says whether it changes a table an archive holds (`archive`): an
  import requires the last version that did, so an archive taken before a migration
  that changed none still imports. A test checks each entry against the schema.
- **Who a request is, is asked once.** A surface calls `admit` in
  `src/server/identity/identity.ts` and holds no secret (decision 0017). Nothing
  outside `src/server/identity` imports another file of it. A table that holds the
  hash of a secret is listed in `UNEXPORTED` (`src/server/transfer/transfer.ts`),
  so no archive carries it. Both are tests. An id read before a wait at the write
  gate is not used after it: an import deletes every token and session, and the
  next row made takes the first id again. Carry the hash and look the row up
  again inside the write (`openSession`; the verifier's finding of 2026-10-13).
- **Budgets are tests** (`test/budgets.test.ts`, `bench/`). A change that misses a
  hot-path budget does not merge; do not raise the number.
- **The check's wall time is a budget** (`scripts/check-plan.ts`). The check warns
  when its tests take more than 130 s and fails above 150 s, unless other work
  keeps the machine busy. The owner raised the limit from 120 s on 2026-10-13, when
  `main` itself took 120 to 122 s: the longer check is accepted for now, and two
  minutes is still the aim (issue #77). A change that makes the check slower says
  so and fixes it: split the file, share the set-up, do less in the browser. Do
  not raise the limit; that is the owner's to do. A file that takes a worker longer than half a minute is the next thing to
  split; after adding or splitting one, `bun run test --update-timings` (six
  minutes) and commit `scripts/test-timings.json`, which balances the CI shards.
- **Tests run beside each other.** A test takes its ports, directories and browser
  from the helpers (`test/helpers.ts`, `test/e2e/support.ts`), never a fixed port
  or a shared path. One that fails only beside others shares something: fix that,
  do not retry it. Only a test that compares a measured time with a limit goes in
  `QUIET` (`scripts/check-plan.ts`), where it runs after the others.
- **Worktree release:** `rm -rf node_modules .mainworthy .casebook test-results` (also the
  `release worktree` script in `t3.json`, which runs when a thread settles).

## Working rules

- Nothing has to stay compatible before 1.0, and the owner says when that is (2026-10-13): the product has no
  users and has promised nothing. A change may break stored data, cookies, tokens, the API and the CLI when that
  makes the result simpler. Say what breaks in `CHANGELOG.md`; do not build a migration path nobody needs.
- The instance follows `main` (the owner, 2026-10-13). A job on the home server deploys the tip of `main` once it
  has stood for ten minutes (issue #90; the home lab's notes say where the job is and how to hold it). After a
  pull request lands, check that `/healthz` names its commit and that the instance answers.
- Behaviour changes need tests and a check run on the real surface.
- Record user-visible changes in `CHANGELOG.md`; record design decisions in
  `docs/decisions/NNNN-title.md`.
- **A user-visible change updates the user docs in the same pull request.** The
  docs are the Markdown pages in `docs/guide/`, which the instance serves at
  `/docs` (decision 0016). Change the page that describes what you changed; a new
  page goes in `src/core/docs.ts` and `src/surfaces/docs/content.ts` too. After a
  change to an operation, a command, a preset, a capability or an answer, run
  `bun scripts/gen-docs.ts`, which rewrites the tables between the
  `<!-- generated:NAME -->` markers. A diagram is built from its source in
  `docs/diagrams/src/` with `bun scripts/diagrams.ts build <archify directory>
  <name>` (`docs/diagrams/src/README.md`). `test/docs.test.ts` and
  `test/e2e/docs.test.ts` fail on a stale table, a name the docs do not say, a
  dead link, a key the keyboard page lacks and a diagram not built again. They
  cannot tell whether a sentence is still true: read the page you touched.
- Secrets never enter the repo, logs or chat.
- The repository is public (the owner, 2026-10-13). Anyone can read the code, every commit, every issue and pull
  request with its comments, and the log of every workflow run. Do not write there the tailnet's name, an address
  on the tailnet or the home network, or the name of a machine at home. Write `example.ts.net` and an address
  from a documentation range; the real ones are in the home lab's notes. Commits made before that day still
  carry the tailnet's name and one address: the history was not rewritten.
- The owner's name is not written in the repository (their request, 2026-10-13):
  not in docs, comments, tests, commit messages or pull requests. Write "the
  owner"; an example person is `robin`.
- The former name, Casebook, stays only in the files `test/architecture.test.ts`
  lists, each with its reason.
- Competitor claims in `docs/competitors.md` are hypotheses until verified;
  do not build on one without checking it.
- A review is sized to the change. The independent verdict is a review of the
  diff: the reviewer reads the change, runs `bun run check` (two minutes) and
  probes what the change could break next to it. The brief names the diff and a
  time, fifteen minutes for an ordinary change. A review of a whole area, with
  every earlier probe run again, is for a release or for a change that rewrites
  that area, and the brief says which. A finding becomes a test, so the suite
  finds it from then on and the next review does not look for it again. The owner's
  goal (2026-10-12, issue #77): landing a feature costs minutes of waiting, not
  most of an hour.
- One agent at a time runs the whole browser suite on a machine. On 2026-10-12 an
  agent's serial pass ran beside another agent's parallel check for an hour and
  failed for reasons outside its code. A second agent runs single files, or waits.
- A failing test in CI is a question on the instance, and the `gate` job stays red (exit 2) until a person
  answers it there (`docs/deploy.md`). Fix the test, or leave the question to the owner and say which one it is.
  Do not answer a failure of your own pull request with the owner token (issue #91). On 2026-10-13 an agent did
  that once, for a test that failed on purpose in a pull request made to try the switch-on (#104), and the reason
  recorded with the decision says so.
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
  On the desktop `/tmp` is kept in memory and `test/budgets.test.ts` refuses it, so the export goes under
  `~/.cache`. To wait for another agent's test run: `pgrep -f '[t]est-worker'`; without the brackets pgrep
  finds the shell that runs it and the wait never ends (both on 2026-10-12, PR #97).
- Scratch files stay out of the worktree: a log, a draft of a pull request, screenshots. `test/architecture.test.ts`
  reads every file in it, tracked or not, and fails when one holds the former name. On 2026-10-13 an agent's
  decision log under `.audit/` failed a nine-minute `--update-timings` run that way. `~/.cache` is the place.
- A verifier that is asked for the check's time leaves `TMPDIR` alone and times the base beside the head. On
  2026-10-13 a verifier's run with `TMPDIR` on disk took 156 s and failed the 150 s limit on a change that added
  0.1 s, while `main` itself took about 140 s that day (#77). The verdict waited for a third round that compared
  the two. And `main` moves while a review runs: a change that passed and is then rebased gets a short round that
  compares the two revisions (`git range-diff`, the trees) and runs the tests next to it, not the whole review again.

## Model profile

**deep**, the owner's standing choice for this project (named 2026-10-11). Every
agent that delegates here takes models and effort from `homelab route models
--profile deep` instead of the default `balanced`: higher effort for all
classes, Opus on Claude verifiers and reviewers, Astra or Fable for `hard` and
`lead`. It is not `max`; the owner names that for a single thread or task. A model
the owner names in a thread still wins.

## Delivery

Delivery: **review-first**. The owner merges; you do not.

Work on the T3 branch in your worktree and follow the `build` skill: check the
change, get the independent verification `verify` asks for, open a non-draft PR
with a standalone description (`gh pr create`), link it to the thread, and stop.
Do not merge, arm auto-merge, close the PR or push to `main`, even when the
checks are green. Opening the PR does not start a watcher; use `babysit` when
the owner asks you to get an open PR merge-ready. Only the owner saying, in the
current thread, to merge identified work lets you land it (the `ship` skill,
with its gates; the merge method is rebase, `gh pr merge --rebase`, keeping the
branch). "Keep going" or a budget request is not that.

After the owner has merged and you start new work on the same T3 branch, move the
branch onto the merge first, so T3 does not keep showing the merged commits as
new changes (a rebase or squash merge leaves the branch's own commits outside
`main`):

```
git fetch && git reset --hard origin/main && git push --force-with-lease origin HEAD
```

Only when the previous PR is merged and the branch holds nothing unmerged. Then
check `git rev-list --count origin/main..HEAD` prints 0 (local `main` can be
checked out in another worktree and stale).
