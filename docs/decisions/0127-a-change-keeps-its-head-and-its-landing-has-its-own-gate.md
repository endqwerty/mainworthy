# 0127: A change keeps its head, and its landing has a gate of its own

- Date: 2026-10-21
- Status: accepted (the owner asked for it in the thread that built it, 2026-10-21)
- Replaces: the parts of decisions 0038 and 0033 that make a landing the change's head

## Problem

The owner opened pull request 677 on the iPhone after it merged. The page said "pending: nothing a gate counts
has been reported for this commit" under the head `3cc3a1e8`, and "The gate is the last verdict its head had."
The pull request's own head, `18af80ce`, had passed. `3cc3a1e8` was the commit GitHub's rebase merge wrote on
`main`, inside a stack that landed in one push. `main`'s check runs on the tip of each push, so nothing ever
tested it.

Decision 0038 made the landing commit the change's head. That holds for a fast-forward, where the landing is the
head. A rebase or squash merge writes a new commit, and GitHub's `merge_commit_sha` names that new commit. So in
this repository every merged change showed the gate of a trunk commit under the pull request's name. On
2026-10-21, pull requests 705, 698, 671 and 662 read `blocked` although each passed on its head, and 673 and 677
read `pending`. A pass/fail screen that people ship by has to say which commit each verdict is about.

## Decision

**A change's head is the pull request's head commit.** A landing never replaces it. The `change` operation takes
`head`, the code host's head when it says how the change ended. A merge can happen before the head's last job
reports, and reports cannot move a merged change's head (issue #302), so the merge event names it. The workflow
sends `pull_request.head.sha`. Without `head`, the change keeps the head reports recorded.

**The landing is its own fact with its own gate.** `landing` still records the trunk commit (decision 0123),
places it on trunk and re-judges it there (decision 0038). `find {in: changes}` and `impact` return `landing`:
the commit, the branch, and that commit's gate (`run` is null when nothing was reported for it). `gate {change}`
is the head's gate, now true for merged changes too.

**Each screen names the commit of each verdict.** When the landing is the head (a fast-forward), it is one commit
with one gate, judged on trunk, and the page says so. When it is another commit, the page shows the head's gate
and, separately, "landed on main as another commit, which has a gate of its own", with that gate.

## Turned down

- **Recording the head's verdict when the merge is reported** (a frozen receipt). It would answer "what did it
  merge with" after later evidence or a fast-forward re-judges the commit. It needs a stored copy of every counted
  result's standing at that moment, and the event often arrives before the last job has reported (decision 0022).
  It is an audit feature: issue #726.
- **Falling back from the landing's gate to the head's under one label.** The single label was the bug.
- **Requiring `head` on every end.** A person ending a change by hand may not know it; the change keeps the head
  it has, and the screen names that commit.
- **Testing every trunk commit, or inferring which push contains a landing.** That is a question about trunk, not
  about which commit a verdict describes.

## Repair

Changes merged before this keep the landing as their head. Replaying the workflow for a merged pull request
(`gh workflow run change.yml -f pull=<n>`) sends its head from GitHub and restores it. The database alone cannot:
nothing recorded which commit was the pull request's head when the landing replaced it.
