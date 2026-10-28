---
id: 1057
category: Fixed
date: 2026-10-27
issue: https://github.com/endqwerty/mainworthy/issues/1057
pr: https://github.com/endqwerty/mainworthy/pull/1068
---

Archive import now refuses case versions whose body or claim hashes do not match their content, and cases whose head hash does not match their head version. A refusal names the table and row and rolls back the whole import, preserving the target instance.
