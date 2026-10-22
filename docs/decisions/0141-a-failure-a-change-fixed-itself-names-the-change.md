# 0141: A failure a change fixed itself names the change

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

**The ending names the change when another of its commits passed.** A `passed` ending records `fixed: true` in its
answer when the commit that passed is not one the cause failed on in that scope; `passedIn` decides it from the same
failures it already reads. A commit that ran again and passed is a retry, which proves no fix. A question's decision
then carries `fixedIn`, the change's key and whether it is `open`, `merged` or `closed` now, when the ending is
`fixed` and the scope is a pull request or branch. The sentence is "Fixed by another commit of pr:482", with ", which
merged" or ", which closed without merging" once it has ended.

**It claims no order.** Mainworthy does not know which of two commits is newer (a reset can return to an older one
that passes) or when a commit was pushed, and the ending is not written when the passing report arrives (an open
planned run holds it until its own evidence comes). So the sentence says "another commit", not "a later commit", and
"which merged", not "before it merged". The verifier (GPT 6.1 Sol, 2026-10-22) found each of three earlier versions
claiming an order the server could not know: a retry and a late report read as a fix before the merge; whether the
change was open was read from its current end, which a reopening or an archive restore changes; and whether it was
open when the ending was written, which a planned run delays, while a reset made an older commit "later". Every
commit of a pull request is part of its work, so "another commit" is what the owner asked to see: the same pull
request's work resolved the failure, and a retry did not.

Endings recorded before this decision claim no fix: what passed is only in their reason's text.

**The change page counts them and links to the pull request.** "1 failure that needed a fix was fixed by another of
its commits." The pull request names the issue it was for, so the failure reaches that issue in one step. The link's
text is its own host and path, not the change's key: a report supplies the address, and a key would vouch for it.
It stands on its own line and wraps, never clipped, because a clipped "github.com.…" could hide whose site it is
(both from the Daybreak audit, 2026-10-22).

**One commit spelled two ways is one commit.** Mainworthy keeps a commit as it was reported, and a report may give
seven to sixty-four characters in either case. When deciding `fixed`, a commit that is a case-insensitive prefix of
a failing one, or the other way round, counts as that commit, so an abbreviated retry claims no fix (the Daybreak
audit, 2026-10-22). Making every report name a full lowercase hash is a larger change to the report contract.

## Turned down

- **Storing the issue on each defect answer.** The rule answers, not a person, and it has no issue to name; the
  pull request's own link to its issue would be copied into every answer and could disagree with it later.
- **Filing an issue for each such failure.** The failure is gone before anyone reads the issue: it would be closed
  on arrival and would fill the board. A failure that outlives its pull request (on `main`, or a flaky test) still
  gets its own issue, as `AGENTS.md` says.
- **Sending the pull request's closing issues with the change.** It needs another field on `change`, the workflow
  and the archive, for a link the pull request page already shows.
- **A mark in the change list.** It would need a count per change on every list read; the change page has it.
