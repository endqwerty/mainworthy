# 0140: A failure a change fixed itself names the change

- Date: 2026-10-22
- Status: accepted (the owner asked for it in the thread that built it, 2026-10-22)

## Problem

The owner asked whether a defect found by CI could link to the issue filed for it, or otherwise show that the same
pull request's work resolved it, and whether Mainworthy could tell that a pull request had a defect that was fixed
before it merged, without making the screens harder to read.

Under decision 0124 the policy answers every CI failure "Defect in the product" by rule, and under decision 0102
that answer ends when a later commit passes the failing tests. The record was all there, but a screen said only
"Ended by rule passed" and the reason "Every test it named passed on `<commit>` where it had failed". Nothing said
that the pull request brought the failure and fixed it, and the change page did not link to the pull request,
which names its issue.

## Decision

**The ending names the change when the change fixed it.** A `passed` ending records `fixed: true` in its answer
when, as it is written, the commit that passed is not one the cause failed on in that scope and the scope's change
has not ended. `passedIn` decides it from the same failures it already reads. A commit that ran again and passed is
a retry, which proves no fix; a pass reported after the merge says nothing about what merged. A question's decision
then carries `fixedIn`, the change's key and whether it is `open`, `merged` or `closed` now, when the ending is
`fixed` and the scope is a pull request or branch. The state is read now, so "before it merged" appears once the
merge is reported; the fix came first because the change was open when it was recorded.

The fix is recorded, not worked out when the question is read: a change can be reopened and ended again, which
replaces its end, and an archive leaves out how changes ended, so neither can say later whether the change was open
at the time. Endings recorded before this decision claim no fix: what passed is only in their reason's text. The
verifier (GPT 6.1 Sol, 2026-10-22) found each earlier version wrong: the first called a retry and a pass after the
merge a fix, the second read whether the change was open from its current end.

**The change page counts them and links to the pull request.** "1 failure that needed a fix was fixed before it
merged." The pull request names the issue it was for, so the failure reaches that issue in one step.

## Turned down

- **Storing the issue on each defect answer.** The rule answers, not a person, and it has no issue to name; the
  pull request's own link to its issue would be copied into every answer and could disagree with it later.
- **Filing an issue for each such failure.** The failure is gone before anyone reads the issue: it would be closed
  on arrival and would fill the board. A failure that outlives its pull request (on `main`, or a flaky test) still
  gets its own issue, as `AGENTS.md` says.
- **Sending the pull request's closing issues with the change.** It needs another field on `change`, the workflow
  and the archive, for a link the pull request page already shows.
- **A mark in the change list.** It would need a count per change on every list read; the change page has it.
