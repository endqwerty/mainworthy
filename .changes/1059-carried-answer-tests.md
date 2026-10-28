---
id: 1059
category: Fixed
date: 2026-10-27
issue: https://github.com/endqwerty/mainworthy/issues/1059
pr: https://github.com/endqwerty/mainworthy/pull/1062
---

A carried defect, wrong-test or expected-change answer now waits for every test it has covered to pass before ending as fixed. A partial report that passes only the original tests keeps the answer and its attribution until the newly covered tests pass too.
