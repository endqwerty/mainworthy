---
id: 1042
category: Fixed
date: 2026-10-27
issue: https://github.com/endqwerty/mainworthy/issues/1042
pr: https://github.com/endqwerty/mainworthy/pull/1056
---

Archive import now refuses malformed historical case bodies, slots pinned to missing case versions, and corrections across projects, tests or actors. Errors name the affected table and row, and a refused import leaves the instance unchanged. Older bodies with duplicate methods remain valid.
