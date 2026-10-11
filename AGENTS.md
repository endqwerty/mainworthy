# Casebook: rules for coding agents

A test case management system. Owner: Daniel (`endqwerty`). Personal project:
act freely, deliver end to end. Your global `~/.<agent>/AGENTS.md` applies too.

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

## Delivery

Work on the T3 branch in your worktree, open a PR with `gh pr create`, link it
to the thread, merge it yourself (`gh pr merge --squash`, keep the branch), then
move the branch onto the merge so T3 does not keep showing the merged commits
as new changes (a squash leaves the branch's own commits outside `main`):

```
git fetch && git reset --hard origin/main && git push --force-with-lease origin HEAD
```

Only after the PR is merged and the branch holds nothing unmerged. Then check
`git rev-list --count main..HEAD` prints 0. State the final `du -sh .` in your
last message.
