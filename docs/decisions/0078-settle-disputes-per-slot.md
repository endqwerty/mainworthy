# 0078: Settle disputes per slot without withdrawing the cause answer

Date: 2026-10-15. Status: proposed, implemented for review.
Implements [issue #70](https://github.com/endqwerty/mainworthy/issues/70).

## Problem

The MVP counted a disputed slot as passed when a cause answer excused every failure in it.
Under standard, a producer could answer before another producer's contradictory pass arrived.
The same producer could not answer after that pass. Arrival order therefore decided who settled the slot.

Withdrawing the cause answer would affect unrelated runs and commit gates.
An agent's result could then end a person's answer, contrary to decision 0012, departure 3.
Decision 0042 added exact-result inherited excuses, but those still apply wherever the result counts.
A result shared by two slots needs two independent settlements.

## Usage

A pipeline fails a case. A person calls its cause infrastructure. Another producer passes that case in a planned run.
The commit keeps its infrastructure excuse. Queue adds "Disputed C-1 in R-1" for the planned slot.
The run waits for this settlement even though the cause already has an answer.

Under standard and strict, neither side's producers may settle, replace or withdraw that answer.
An eligible person can classify the named failures in this slot. Another slot sharing the results still waits.
The same checks apply when the pass arrives before the cause answer.

## Shape

The existing `failure` kind represents three subjects: a cause in its scope, inherited results, and a slot dispute.
A slot subject records `{ slot, signature, scope }`, with its own fingerprint.
Its complete effective result IDs form its basis. The displayed test sample does not bound the decision's evidence.
Each cause and scope in a disputed slot gets a separate question, so one classification never silently answers another cause.

The result-excuse writer accepts a scope:

```ts
type ResultExcuseScope =
	| { kind: "result" }
	| { kind: "slot"; slot: number };

excuseForResult(db, result, scope);
excuseForDisputedSlot(db, slot, result);
setResultExcuses(ctx, witness, results, klass, { kind: "slot", slot });
```

Evidence continues owning `result_excuses` and its witness-checked writer.
Runs owns slot evidence, tallying and result discounting. Decisions owns reconciliation, policy checks and holds.
No new operation, answer, tool or decision mint is added.

Ordinary cause questions no longer acquire dispute authorization from neighboring slots.
A cause answer can be given, changed or withdrawn under its own clause, while slot settlements stay separate.
Slot questions use `scope:run` and `hint:disputed`, including when their evidence came from a change.
Their parties remain recorded after settlement, result discounting and run closure.

## Lifecycle

Every disputed slot requires local standing for every effective failing fill.
A global inherited excuse or broad cause answer cannot substitute for it, however recent.
An unanswered cause keeps the slot disputed even if another cause has been attributed.
After every cause has a local settlement, the existing classification rule applies: any attributed cause fails the run,
otherwise the disputed slot counts as passed. This preserves the existing treatment of exercise requirements and `minActors`.
Settlement does not waive missing slots or required jobs.

A changed effective result from a person or pipeline renews the slot's settlement.
An agent's report never renews or ends a person's settlement, even when its attempt or outcome changes.
While the non-agent evidence and scope stay the same, that classification also covers later agent failures
of the same cause in this slot and scope. A different cause still needs its own settlement.
The complete result set remains recorded as the evidence the person answered.
Duplicate reports and ineffective attempts do not renew a settlement.
Expiry or withdrawal removes only the local rows written by that decision. Flaky settlements retain their timed hold.
Other local classifications hold on this exact slot evidence, including infrastructure answers.
Cause answers retain their usual holds and continue to cover every occurrence they covered before.

`mistaken` retains its documented global meaning. It discounts only the failing result IDs named by the slot question,
but those results stop counting in their commit gate and every open run that admitted them.
Closed runs keep their pinned evidence. Withdrawing a mistaken answer restores only what that answer discounted.

Startup reconciles stored disputes that have no slot questions before serving requests.
This corrects earlier passed tallies without withdrawing their cause answers. Subsequent starts skip that repair.
Commit-accepting runs continue receiving late evidence through the existing sign-off reconsideration path.

## Synthesis decision

We compared extending `result_excuses` with a slot dimension against a separate settlement relation owned by runs.
Unchanged result-only storage cannot express independent settlements of shared results.
The scoped extension keeps one witness writer, one expiry representation and one withdrawal path.
Separate readers keep local settlement precedence out of ordinary cause and inherited callers.
Model the Domain shaped the slot key. Fix Root Causes shaped the separate question and the removal of cause-derived dispute facts.

Migration 0017 rebuilds `result_excuses` with nullable `slot`, a row ID and separate unique indexes for global and slot rows.
Existing rows become global rows without changing their decisions or classification.
It requires archive schema 17. Older archives must be exported again after upgrading the original database.
The migration number may need renumbering when concurrent branches land.

## Validation and review boundary

The old integrity regression, "a failure already explained is not asked about again because somebody else then passed",
is replaced by both event orders requiring an independent slot settlement.
Related tests now distinguish the slot question from the cause question, including global mistaken-result undo.
Targeted checks cover shared results, agent contradictions, other scopes, multiple causes, expiry, late results,
startup reconciliation, migration preservation, archive restore and real HTTP requests.
Sequence audits independently distinguish global and local standing and check slot authorization.
The integrating parent owns the full check and independent provider verification before delivery.
