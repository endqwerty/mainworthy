# 0153: Cockpit corrections can withdraw automatic sign-off

2026-10-22. Fixes [issue #793](https://github.com/endqwerty/mainworthy/issues/793).

A one-case run under the loose policy closes when its pass arrives. The cockpit still offered correction,
but its closed-run guard refused the key. An automatic sign-off is already withdrawable through `decide`.
The current policy controls withdrawal, with a rule's permission interpreted as member permission. The
person who recorded the result may withdraw it when they have answer permission. Producing results alone
is insufficient.

The cockpit reads the run's settled sign-off. A human whose answer counts can correct their last result
through an automatic approval. Undo waits for preceding reports, reads current run state and sign-off,
checks that the original result still fills its slot, and withdraws the exact decision with `ifDecision`.
Only a confirmed withdrawal permits the correction report. Other closed runs link to the settled sign-off
and hide the correction action. Human approvals still require an explicit withdrawal in Queue.

Both writes use existing registry operations. Withdrawal records a superseding decision. Correction uses
`report`'s existing append-only result with `corrects`, preserving both results. There is no new capability,
decision kind, or claim that the two writes are atomic. If correction fails after withdrawal, status says
the run reopened without the correction. A lost withdrawal reply directs the person to check Queue.
Session ownership and project identity guard both writes, and the existing correction checks still protect
against another producer replacing the result.

Hiding correction on every closed run would deny the workflow the existing policy permits. Automatically
withdrawing human approvals would make a result key reverse an explicit review, so those remain in Queue.

No demo change is needed. This fixes a transient cockpit interaction using the existing run, sign-off, and
correction data that the demo already contains.

Principles: Laziness Protocol (reuse the registry operations); Experience First (one key for an allowed
correction); Fix Root Causes (handle legitimate closure in the cockpit); Test Behavior Not Implementation
(browser keys and recorded server state); Model the Domain (derive eligibility from run and sign-off state).
