# 0027: Undo names the decision it withdraws

- Date: 2026-10-14
- Status: accepted
- Issue: [#181](https://github.com/endqwerty/mainworthy/issues/181)

An answer's reply names its decision, but undo used to name only the question.
Another person's replacement answer could arrive between the answer and its undo.
Undo then withdrew the replacement and reported success to the first person.

## Decision

`decide` takes an optional positive integer `ifDecision` alongside `undo`. The
decision module compares it with the question's standing decision inside the same
write transaction as the withdrawal. A mismatch, including a question that is no
longer decided, returns `conflict` before any effect is reverted or decision written.
The existing policy, reason and question-kind checks still apply when it matches.

Immediate undo in the web and iPhone apps uses the `decision` returned by `decide`,
including an `already` reply. Withdrawal from Settled or Decided uses the id shown
in that question's decision. Neither app reads a newer id to retry a refused undo.
The iPhone contract already includes both ids, so its generated wire types stay
the same. Its answer outcome and undo question carry the receipt to the undo call.

Bulk web answers keep a receipt for each successful answer, even if others were
refused. Undo attempts every successful decision separately and reports partial
failure. A retry contains only the withdrawals that failed and retains their ids.

An API caller may omit `ifDecision` to request withdrawal of whichever decision
stands when the transaction runs. This preserves deliberate current-decision
withdrawal by existing command-line and agent callers. It still needs the same
authority and reason. Advice on an open question has no decision to withdraw.

## Turned down

- Requiring an id for every undo would remove deliberate current-decision
  withdrawal and break existing callers without helping the apps, which have ids.
- Reading the current decision before undo leaves a gap between the read and the
  write. The comparison belongs beside the withdrawal in the transaction.
- Replacing a failed receipt with a newer one would let a retry withdraw the
  answer that the first undo correctly left alone.
