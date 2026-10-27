---
id: 973-jest-timing
category: Fixed
date: 2026-10-26
issue: https://github.com/endqwerty/mainworthy/issues/973
pr: https://github.com/endqwerty/mainworthy/pull/982
---

`mainworthy report` warns about reversed Jest and Vitest file times even when an earlier file omits timing. Both file orders keep all results and omit the reported span.
