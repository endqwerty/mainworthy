# 0133: Reports preserve automatic case-creation pauses

2026-10-22. Part of [issue #746](https://github.com/endqwerty/mainworthy/issues/746).
Extends [decision 0082](0082-atomic-bulk-proposal-slices.md).

## Problem

Under the `create` choice for tests with no case, a report raises map questions and the policy creates their
cases. The handlers already pause while sealing, adopting and linking cases. The report called synchronous
`raise`, which drained those generators and discarded the pauses. It also processed every file without pausing.
A separate-process HTTP probe during five reports of 10,000 new tests across 200 files measured health waits of
1.86 to 3.43 seconds. Ordinary gate reads waited too. A diagnostic run held the report's final generator step
for 1.06 to 2.68 seconds. No individual measured SQL call exceeded 46 ms, and JSON parsing peaked at 12 ms.
These local measurements identify one reproducible cause, not every historical production stall.

## Decision

The report delegates each map question through `raiseSteps` and preserves its pauses. It also pauses after each
file, so many files with fewer cases than one handler slice cannot accumulate into a long uninterrupted loop.
All producers use this same report implementation. Synchronous recovery still drains it before listening.

Acceptance and application retain their existing transaction boundaries. The writer gate remains held while
application pauses. Disk readers see committed state, and the new cases, test links and decisions publish
together. An interrupted application rolls back and leaves the accepted batch available to recovery or retry.
No input, reply, schema, archive format or witness rule changes.

A separate health listener would leave ordinary HTTP reads waiting. A new writer worker or committing report
slices separately would change ownership or visibility across many modules. Reusing the existing paused
handlers fixes this caller without either design change. Other synchronous report stages and short writes
waiting behind a report remain work for [issue #60](https://github.com/endqwerty/mainworthy/issues/60).

## Checks

`test/report-latency.test.ts` sends real HTTP reports while another thread polls `/healthz`. One case creates
500 cases in one file, exercising pauses within a handler. Another creates 2,000 cases across 200 files,
exercising pauses between handlers. Both check complete receipts, the final case count, all tests linked and
no failed health probes. They use the existing 50 ms health budget and repeat once on a fresh instance after
a miss, as the archive latency check does. They run in the quiet phase.

Before the change, the repeated health waits were 82.0 ms and 523.7 ms. The first run after the change passed
with 37.3 ms and 25.5 ms. Timing evidence is local; CI and independent verification are recorded in the pull
request. No new demo scenario is needed because this changes scheduling of existing reports only.
