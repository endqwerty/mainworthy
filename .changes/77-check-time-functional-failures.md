---
id: 77-check-time
category: Fixed
date: 2026-10-24
issue: https://github.com/endqwerty/mainworthy/issues/77
pr: pending
---

`bun scripts/work.ts check-time` refuses failed checks that also print the old `OVER BUDGET` marker. Historical timing-only failures remain comparable when every functional stage reports success.
