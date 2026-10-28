---
id: 996
category: Fixed
date: 2026-10-27
issue: https://github.com/endqwerty/mainworthy/issues/996
pr: https://github.com/endqwerty/mainworthy/pull/1035
---

Reports with new tests across many files now finish their file questions in durable background pages, instead of holding one transaction open for every file. The first 100 files are handled with the report; the remaining questions and automatic case creation follow after the results commit, using the current policy.
