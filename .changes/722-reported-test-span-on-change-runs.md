---
id: 722-reported-test-span
category: Added
date: 2026-10-26
issue: https://github.com/endqwerty/mainworthy/issues/722
pr: https://github.com/endqwerty/mainworthy/pull/970
---

A change run shows a **Reported test span** beside its test time, on the web and the iPhone: from the earliest start to the latest end its counted reports named. It appears only when every one of those reports named its start and end and no declared shard or accepted report is still to come. `mainworthy report` reads the span from Playwright JSON, Jest and Vitest JSON, and JUnit suites whose timestamps name a time zone; the API takes it as `span` on `report`, and `find --in results` returns it as `reportedSpan`. A report sent again with other timing is now a new report.
