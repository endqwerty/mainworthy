# From a branch to mainworthy.com

A change travels from a worktree branch to the instance at `https://mainworthy.com` through CI, review and an
external deploy job. Mainworthy judges its own CI: a failing test becomes a question on the instance, and the
gate stays red until someone fixes the test or a person answers the question. This page explains each step.
[docs/deploy.md](../deploy.md) has the full record of how the instance and its CI reporting were set up.

[Diagram: a change, from a branch to the deployed instance](diagrams/change-to-deploy.html)

## Open a pull request

The board is `https://github.com/users/endqwerty/projects/2`. A task the owner gave in a thread needs no issue,
because the pull request is its card.

To deliver a change, follow these steps:

1. If the change has an issue, move its card to In Progress before the first edit:
   `bun scripts/work.ts board start <number>`.
2. Make the change on the worktree's branch and run `bun run check`.
3. Get an independent verification from a model of another provider, as the `verify` skill asks.
4. Open a non-draft pull request. Give it the issue's milestone. Put `Closes #123` on a line of its own only when
   the merge makes everything the issue asks for true. Otherwise write `Part of #123`.
5. Set `pr: <this PR's URL>` in each fragment this PR adds, commit and push that update, then run
   `bun scripts/work.ts pr-body <number>`. It checks the linked issues, milestone and fragment PR references.
   CI's `description` job runs the same command; `pr: pending` is allowed only while the PR is a draft.
6. Move the pull request's card too: `bun scripts/work.ts board start <number>`.
7. Once `gate` is green, run the Daybreak security audit on the head and its base, address every issue it declares,
   and record the audit in the description: [docs/security-audit.md](../security-audit.md).

The owner reviews every change and merges it by rebase (`gh pr merge --rebase`), only while the head and base are
the pair the audit read. An agent stops after it opens
the pull request, even when every check is green. A stack of dependent pull requests lands in one step when the
owner's word covers it: [docs/landing-a-stack.md](../landing-a-stack.md).

## Know what CI runs

`.github/workflows/check.yml` runs when a pull request opens, receives commits, reopens or becomes ready for review, and on every push to `main`. The ready-for-review run prevents a draft's `pr: pending` from carrying into a ready PR.
A new run on a pull request cancels that pull request's older run if it is still going. A push to `main` is never
cancelled. A re-run of an older run is neither cancelled by a newer one nor cancels it: both run.

| Job | Runs when | What it does |
| --- | --- | --- |
| `scope` | always | compares the changed paths with `scripts/ci-scope.ts` and decides which jobs and test files run |
| `static` | code, scripts or configuration changed | `bun run typecheck`, `bun run lint` and `bun scripts/async-port.ts --check` |
| `tests` | always, in a matrix from `scope` | 14 shards of functional tests and one runner for the serial performance phase. Each shard uploads its JUnit report as `results-<shard>-attempt-<n>`. |
| `image` | a file the Dockerfile copies changed | builds the container, starts it, and checks `/health`, the docs, a diagram, a screenshot and the skill archive |
| `ios` | the app, its scripts or the server changed | on macOS, `bun scripts/ios.ts test` against this commit's server, then `bun scripts/ios.ts build` |
| `description` | every pull request | `bun scripts/work.ts pr-body <number>`. After you fix a description or a milestone, run this job again. |
| `gate` | after the others, even when they fail | reports every shard's results to Mainworthy and reads the verdict |

A change that touches only prose, another workflow or the iPhone app runs fewer tests: one shard named `tests`
runs the test files that read those paths, plus the tests that read the whole tree (decision 0090). A change to
the CI files themselves runs everything. To see what CI would run for your branch, run
`bun scripts/ci-scope.ts`.

A shard with a failing test still ends as a success, so that the gate, not the shard, decides. The test step
continues on error and uploads its report.

## Read the gate

`scripts/ci-gate.ts` reads the newest attempt of each shard. It refuses a report that is missing, empty, all
skipped or cut short, and a test file that no shard ran. Then it reports each shard to Mainworthy as a shard of
the job `tests` and runs `mainworthy gate`, which exits 0 passed, 1 failed, 2 blocked or 3 pending. The reporting
step exits 1 when a report is incomplete, even if Mainworthy passed what it received. The job's last step also
fails when `scope`, `static`, `image`, `ios`, `description` or a shard's job failed. So a red `gate` can mean a
lint error as well as a failing test: read the step that failed.

The instance is the one `MAINWORTHY_URL` names, project `mainworthy`, reached with the `github-actions` pipeline
token in the secret `MAINWORTHY_TOKEN` (decision 0014). That token records results and reads the gate. It cannot
read the suite, edit a case, answer a question, plan a run or administer. If the instance cannot be reached or
speaks another API version, `scripts/ci-instance.ts` starts a Mainworthy of its own for that run and says so on
the run's summary page. A refused token fails the job instead.

[Diagram: one red build, from upload to a green gate](../diagrams/red-build.html) shows what an instance does with
a report under `standard`, where a person answers the failure. This project's policy answers it by rule instead
(below).

## Clear a red gate

A failing test needs a fix, and it is the fix of the session that pushed the commit. The project's policy answers
every CI failure "needs a fix" by rule, so nobody is asked, the gate reads `failed` and the job exits 1
([decision 0124](../decisions/0124-ci-failures-belong-to-the-session.md)). Read what failed from the instance:

```
bun scripts/work.ts ci                 # this branch's pull request
bun scripts/work.ts ci 673 --wait=900  # a pull request, waiting while its gate is pending
bun scripts/work.ts ci origin/main     # a commit, after git fetch
```

It lists each failing test with its message and the build, and exits 0 passed, 1 failed, 2 blocked, 3 pending.
To clear the gate, do one of these:

- Fix the test and push. The new commit gets its own run, and the answer ends when a commit passes the test.
- Re-run the shard's own job, if the failure was by chance: `gh run rerun <run> --job <id>`. The newer attempt
  replaces the older one, and if the test passes, so does the gate. GitHub's "Re-run failed jobs" re-runs only
  `gate`, because the shard itself succeeded.

`ci` reads `blocked` with a question open when a person is asked. For a CI failure that means the policy was changed
back, and it says how to set it again. An older commit reads `blocked` with no question once a later commit passed
its failing tests, which ends the answer (decision 0102); nobody is asked about it. Never overrule the rule's answer
with the owner token.

A test that fails by chance is still a defect. File it with the `flaky-test` label in milestone M1.

When a pull request is merged or closed, `.github/workflows/change.yml` tells the instance (decision 0022). A
failure still open on that pull request is then no longer asked about. To replay a missed event, run
`gh workflow run change.yml -f pull=<number> -f state=merged`.

## Follow the deploy

Coolify on the home server follows `main` and deploys `compose.coolify.yaml`: an app container, PostgreSQL 18 on an internal network with its own volume, and the retained SQLite volume
and a Tailscale sidecar. The deploy job lives outside this repository. Before it deploys a commit, it must see
that the newest push run of `check.yml` for that commit completed, that its `gate` job succeeded in the run's
current attempt, and that `main` has not moved for ten minutes. [docs/deploy.md](../deploy.md#checks-a-deployment-must-wait-for)
lists the exact reads. This repository does not verify that the external job makes them.

After a pull request lands, check that the instance runs it:

```
$ curl -s https://mainworthy.com/health
{"ok":true,"version":"0.1.0","apiVersion":…,"commit":"<the full SHA of main>"}
```

If `commit` is older than the tip of `main`, the instance lags. Then move both board cards to Done
(`bun scripts/work.ts board done <number>`) and close a still-open issue with a comment that links the pull
request.

## Start the next change on the same branch

After the owner has merged, run `bun scripts/work.ts sync-branch` before new work in the same T3 worktree. It
moves the branch onto `origin/main` and pushes it. It refuses while the branch holds a commit that is not on
`main` or the worktree has changes. At the end of a task, run `bun scripts/work.ts release`. It deletes
`node_modules` and the checkout's test data, and refuses while a server, a test run or another Bun process
works from the checkout.
