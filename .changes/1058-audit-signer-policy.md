---
id: 1058
category: Fixed
date: 2026-10-27
issue: https://github.com/endqwerty/mainworthy/issues/1058
pr: https://github.com/endqwerty/mainworthy/pull/1061
---

Audit verification now refuses full-history files whose decision signers name a missing policy version and identifies the decision in the error. Partial histories count omitted older signing policies among references before the range, once per signer. Included signing policies must not follow their decision in the project sequence.
