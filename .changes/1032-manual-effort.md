---
id: 1032
category: Added
date: 2026-10-27
issue: https://github.com/endqwerty/mainworthy/issues/1032
pr: https://github.com/endqwerty/mainworthy/pull/1041
---

Reports now ranks manual effort by known total time, including cases with linked automation. Each case shows executions, timed and untimed counts, known total and timed average. Partial totals and unknown timings are explicit. Corrections replace the original execution's timing in its original period. The automation rate and frequency backlog remain available; the backlog's counts now follow the same correction rules. A correction chain longer than 64 links counts as untimed, and a correction that does not keep its result's project, test, producer, target and run is ignored.
