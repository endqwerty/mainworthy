# 0097: Check duration is advisory

- Date: 2026-10-17
- Status: accepted by the owner in the thread landing pull requests 467, 468 and 470

## Problem

The whole-check limit of 150 seconds and the CI shard limit of 240 seconds repeatedly blocked passing
checks and required exceptions. The owner suspended elapsed-time gating completely until a useful gate
can be set. Raising a threshold to make the current run pass would preserve that problem.

## Decision

`scripts/check.ts` and `scripts/ci-gate.ts` keep reporting durations. Their existing warning thresholds
remain 130 seconds for the local test suite and 180 seconds for a CI shard. Elapsed time alone never
changes their exit code. There is no bypass switch or machine-load exemption.

Functional failures still block, including failed product latency tests, missing or incomplete reports,
skipped test files and nonzero test exits. Typecheck, lint, independent verification, and timeouts that
stop a hung test or CI job remain required.

[Issue #77](https://github.com/endqwerty/mainworthy/issues/77) keeps the performance work and the task of
establishing a measured timing gate. This decision does not choose a replacement limit or claim a speedup.
