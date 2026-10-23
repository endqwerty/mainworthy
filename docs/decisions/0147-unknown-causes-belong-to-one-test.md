# 0147: Unknown failure causes belong to one test

- Date: 2026-10-22
- Status: accepted

## Problem

A runner can report a failure without diagnostic text. Inventing a message from the test name can classify
an assertion as a timeout or infrastructure failure. Omitting its signature also removes its failure question,
because questions and excuses use signatures as their identity. The gate then blocks with nothing to answer.

## Decision

Store an unknown signature whose hash includes the scope-free test key. Signature lookup remains scoped to
the project. Its class is `unknown`, and its display text is `Unknown failure cause`. Results and runner tries
use the same rule, without borrowing another observation's diagnostic. Different tests never share an unknown
cause. Later unknown failures of the same test reuse it, and an answer applies within its existing scope.

Unknown causes open ordinary failure questions and use existing decisions and excuses. They stay outside
assertion grouping, file splitting, and cause-level detector suggestions. Outcome flips still count. A matching
unknown cause on the base does not establish that the head has the same failure, so it supplies no inheritance
evidence. A missing or header-only message first uses the first diagnostic line of `detail`; stack frames alone
are not diagnostic cause text.

Migration 0042 widens the signature class constraint without changing existing ids, classes, or references.
It changes an exported table and advances the archive version. Current archives preserve unknown causes and
their decisions; earlier archives require a fresh export. Existing stored causes keep their classification. Earlier answers to the old fallback causes ("no failure message (…)", "Test failed") keep covering the results already recorded, but the next failure with no message gets the unknown cause and is asked again.

## Alternatives

Keeping signatures absent would require a second identity for failure questions and every excuse path.
Encoding an unknown cause as an assertion with a special hash would hide its meaning from the detector and
base comparisons. An explicit stored class lets those consumers distinguish missing evidence directly.
