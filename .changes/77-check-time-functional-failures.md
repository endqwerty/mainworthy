---
id: 77-check-time
category: Fixed
date: 2026-10-24
issue: https://github.com/endqwerty/mainworthy/issues/77
pr: https://github.com/endqwerty/mainworthy/pull/921
---

`bun scripts/work.ts check-time` no longer counts a failed check as a timing because its output says `OVER BUDGET`. Any nonzero exit is refused, so a comparison against a revision whose check went over its time limit before 2026-10-17 now fails instead of being timed.
