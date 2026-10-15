# 0042: Inherited excuses name results and their base evidence

Date: 2026-10-14. Implements issue #69 and replaces departure 4's restriction in decision 0012.

## Problem

An excuse for a whole cause can cover a different test or an agent's report with the same message.
The automatic inherited answer also needs to end when the base evidence changes, without another report from the change.

## Usage

A pipeline reports a failure on a base commit, then the same test and cause on a pull request.
Under loose policy, `report` and `gate` show that failure excused. The ledger records an `inherited` decision for that commit.
An unmatched test with the same cause stays unexplained. Standard and strict still ask a person.

## Shape

`result_excuses` belongs to evidence. It associates an exact result with a failure decision, classification and expiry.
Only `setResultExcuses(ctx, witness, results, class)` writes this standing. Broader manual cause answers keep their existing storage.
When both cover a result, the newer decision counts.

The failure handler uses the existing decision and witness path. An automatic question is identified by commit run and cause.
Its evidence and decision effects record `{ result, base: resultIds[] }` for every covered result, without a display limit.
Its hold compares that whole evidence basis. The question's displayed test list remains bounded.

The runs module reads each effective failure when tallying a commit, and each effective failing fill when tallying a slot.
A slot is excused only when every failing fill is explained. Agent results cannot receive automatic inherited standing or supply base evidence.
Closed runs keep their pinned results, whose inherited answers still depend on the current base.

A fold also reaches other runs of the change, changes based on the affected commit, and their planned runs.
When a head lands on trunk, reconciliation retires its inherited decision because the target no longer has a change base.
Trunk answers apply and unexplained failures are asked again, including in planned runs. Older change commits retain their own inherited standing.
Retargeting is recorded in the command context at the evidence writer, so acceptance of a duplicate report cannot skip reconciliation.
The comparison reads effective base results in the same environment, method and job, independent of the base's own excuses.
Cycles between change bases therefore need no recursive decision reasoning.

## Synthesis decision

We compared adding test and method dimensions to every broad cause excuse with a separate exact-result relation.
The exact-result relation keeps test, commit, producer and lane identity in the result they already belong to.
It hides those dimensions from broad excuse callers and lets issue #70 build on the same storage without implementing that issue here.
This follows Model the Domain and Fix Root Causes: classification reads the evidence unit that actually fails.

## Tradeoffs

Tallying examines individual effective failures rather than counting a whole cause together.
The rule indexes base evidence once per reconciliation pass and reconciles the complete set rather than a report or queue sample.
A report reconciles its causes together. Nested decisions enqueue run folds for the active pass instead of entering another fold.
Without an inherited rule or earlier inherited questions, reconciliation reads no base evidence.
When a new policy asks a person, the ordinary cause question replaces the inherited rule question.
Withdrawing an automatic answer also retires its per-result question and leaves one ordinary cause question for a person.
The retired question keeps the withdrawal decision, which disables automatic inheritance for that commit and cause.
Base and head retries, corrections and retargeting do not undo that choice. Another commit or cause may still inherit.
A person's answer uses the ordinary failure holds, so a failing base retry cannot withdraw it.
We chose this handoff over keeping manual answers on the per-result question: that would require a second set of manual holds and retry rules.
The demo adopts standard before reporting failures so its queue includes the pull request's failure and its base-comparison hint.
Migration `0013_result_excuses.sql` is marked `archive: true` and requires archive schema 13. Existing stored policy clauses stay unchanged; applying the loose preset enables the new rule.

## Validation

`test/inherited.test.ts` covers mixed tests, split reports, 501 failures, commit isolation, passing and skipped retries,
corrections, mistaken decisions and undo, retargeting, duplicate receipts, recovery, agents and pinned closed runs.
The sequence audits independently check that inherited result excuses cite a currently effective base failure of the same test and cause in the same repository, environment, method and job.
Full-suite and independent verification belong to the integrating parent before delivery.
