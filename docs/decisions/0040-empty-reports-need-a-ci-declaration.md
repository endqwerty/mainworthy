# 0040: Empty reports need a CI declaration

Date: 2026-10-14. Implements [issue #63](https://github.com/endqwerty/mainworthy/issues/63).

## Problem

Decision 0012 made a gate with nothing proven pending. That stops a pipeline from hiding a failed test with a skip. A pipeline that correctly requires no tests for a docs-only commit also needs a way to pass.

Policy settings live in the versioned `policies.settings` JSON. An `op: "policy"` edit goes through a proposal and an admin's adoption decision. Presets supply initial settings. Report acceptance stores a batch, then application folds results into runs. The evidence module owns batches, and the runs module owns their gate projections.

## Usage

An admin runs `mainworthy policy empty nothing-required`. The pipeline then runs `mainworthy report --nothing-required` with its detected or explicit commit. `mainworthy gate` exits 0 if the declaration is applied and the commit has no ordinary reports.

The operation inputs are:

```json
{"edits":[{"op":"policy","emptyReports":"nothing-required"}]}
```

```json
{"target":{"commit":"1111111111111111111111111111111111111111"},"results":[],"nothingRequired":true}
```

The policy proposal still needs an admin's acceptance. The declaration needs a CI actor with `record`. It carries no test results. People and agents cannot send it.

## Shape

`PolicySettings.emptyReports` is `"pending" | "nothing-required"`. Every preset defaults to `pending`, as do older stored policies that lack the setting. A top-level policy edit changes this setting without replacing the others.

`ReportInput` accepts either nonempty results or an empty array with the literal `nothingRequired: true`. Validation rejects a declaration with results. The report operation checks the actor and explicit commit before creating a target or batch.

Migration 0007 adds `batches.nothing_required`. This retains the declaration after its staged input is cleared and distinguishes it from a report whose results were all refused. Existing batches get 0. Archives include this column, so their schema becomes 7. Older archives must be imported with an older build before upgrading the database.

The evidence module answers whether a commit's targets have an applied declaration and no applied ordinary batch. Any ordinary report, including one from an agent or one whose results were all refused, prevents the exception across all jobs and environments of that repository's commit. Another repository is independent.

The decision coordinator supplies the current policy setting when the runs module recomputes a gate. The runs module checks that setting and the declaration only for an empty change run. Reading a gate uses its stored projection without reaching into the policy module. Planned runs never use the exception. Missing jobs and case slots still need evidence. Gate verdicts retain their order: unapplied reports and expired decisions, attributed failures, unexplained failures and disputes, missing evidence, then passage. A declaration never replaces a result in a test's lane.

Changing the policy recomputes existing empty commit gates. Recorded receipts remain immutable. The gate's reason identifies the declaration instead of claiming that a test passed.

## Alternatives considered

An empty required-jobs list would put the exception on individual runs. Callers would need to construct and manage an obligation set for each path-filter outcome, and a project-level default would still need a policy rule. That is a larger interface for this bounded case.

A policy that treats every empty or skipped report as passed would expose less configuration but hide why evidence is absent. It would let skipped or refused results use the exception. We reject that shape.

The selected shape adds one policy value and one explicit report declaration. It reuses the decision mechanism, batch lifecycle, and gate instead of adding a new operation. It accepts CI's statement about path filters. Mainworthy does not evaluate repository paths or infer whether tests were required.

## Limits

The setting is available through the CLI and policy edits. Settings does not yet have a control for it, as with the evidence basis and hold settings. Selecting a preset resets it to pending.

An ordinary report prevents the empty-report exception permanently for that commit, even if its results were later corrected. Such a commit can still pass through the normal counted-evidence rules. This favors preserving evidence over interpreting a later declaration as a withdrawal.
