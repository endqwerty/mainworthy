# 0152: Policy reconciliation yields between runs

2026-10-22. Part of [issue #746](https://github.com/endqwerty/mainworthy/issues/746).
Extends [decision 0082](0082-atomic-bulk-proposal-slices.md).

## Problem

Adopting a policy reconciles inherited standing for existing change runs, then lets rules answer eligible open
questions. Its initial `refold` drained every run synchronously. Small question handlers could also accumulate
without pausing. Health requests and worker read replies waited on the HTTP thread until reconciliation ended.
This is separate from the report case-creation pauses preserved in [decision 0137](0137-reports-preserve-case-creation-pauses.md).

A separate-process diagnostic over a generated disk database reproduced the pause during policy adoption.
The CPU profile names `reconsiderPolicySteps` and its initial `refold` as the main uninterrupted work.
The measurements and remaining synchronous stages are recorded in `bench/results-health-stalls.log`.
These local workloads do not identify the historical production 17-second stall conclusively.

## Decision

Keep one reconciliation implementation, `refoldSteps`, which yields between runs in each of its three phases:
collecting affected runs, refreshing inherited standing, and recomputing gates and questions. Policy adoption
preserves those yields and pauses between candidate questions, even when a candidate is skipped or its handler
has too little work to yield. The existing synchronous `refold` drives the same generator to completion for its
other callers. This change does not move those other operations off the HTTP thread.

The writer gate, SQLite transaction and decision savepoints stay open across yields. Other writers wait.
Readers use independent connections and see committed state. The policy and all its decisions still publish
together. The same `finally` restores the context's folding flags on completion, failure or generator closure.
No schema, witness, operation contract, archive or demo scenario changes. No new demo scenario is needed because this only changes the scheduling of existing policy adoption.

A writer worker would require transferring connection and context ownership across many operations. A separate
health listener would leave ordinary reads waiting. Yielding the existing algorithm fixes this policy path
without changing either ownership or visibility. Each individual run reconciliation, SQL statement, parsing,
serialization and final commit remains synchronous. A single large run can therefore still pause the server.

## Checks

`test/policy-latency.test.ts` establishes 6,000 small change runs through the registry, then adopts a policy
through HTTP while another thread polls `/healthz`. Fixture creation is outside the polling interval. Every
report must be complete, and the adoption checks the stored policy, a populated blocked gate, atomic visibility
of policy and question state, and zero failed health requests. There is one fresh instance per test and no
retry of a missed latency assertion.

The 750 ms bound targets the old uninterrupted reconciliation across the whole population. It leaves room
for scheduling pauses on a loaded host and does not replace the read-service budgets or promise that every
individual run or SQL statement stays under that bound. The former 120-run, 50 ms check was too sensitive to
host pauses; widening that small check alone would not establish a reliable regression guard. The larger
fixture keeps each yielded unit small while making the old synchronous pause much longer.

The test remains in `scripts/check-plan.ts`'s `QUIET` phase. `test/check.test.ts` explicitly checks that this file
is included in the quiet phase and excluded from the parallel phase. The ten-pair validation and selected-bound
evidence are recorded in `bench/results-health-stalls.log`. The selected guard passed 10/10 fixed-code tests
and failed 10/10 old-code tests. Fixed waits were 2.8–197.5 ms; old waits were
926.4–6755.1 ms. Independent verification remains with the coordinator.

Principles: Fix Root Causes (preserve reconciliation pauses); Laziness Protocol (one shared algorithm);
Separate Before Serializing Shared State (retain the writer gate and committed snapshots);
Test Behavior, Not Implementation (real HTTP health requests and completed adoption).
