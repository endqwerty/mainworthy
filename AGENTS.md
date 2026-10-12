# Casebook: rules for coding agents

A test case management system. Owner: Daniel (`endqwerty`). Personal project,
but Daniel reviews every change on GitHub before it lands. Your global
`~/.<agent>/AGENTS.md` applies too.

Read [README.md](README.md) first, then `docs/product-vision.md`,
`docs/competitors.md` and `docs/open-questions.md`.

## State

Day zero: **the stack is undecided** (`docs/decisions/0001-stack-open.md`).
Do not add a language, framework or build tool until a decision record is
written. When you do, in the same change: add the decision record, a
`t3.json` with install/check/dev scripts, the check command and stack rules in
this file, and a worktree-release step if dependencies are large (the Mac mini
is short on disk).

## Working rules

- Behaviour changes need tests and a check run on the real surface.
- Record user-visible changes in `CHANGELOG.md`; record design decisions in
  `docs/decisions/NNNN-title.md`.
- Secrets never enter the repo, logs or chat.
- Competitor claims in `docs/competitors.md` are hypotheses until verified;
  do not build on one without checking it.

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
