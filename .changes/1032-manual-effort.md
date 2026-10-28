---
id: 1032
category: Added
date: 2026-10-27
issue: https://github.com/endqwerty/mainworthy/issues/1032
pr: https://github.com/endqwerty/mainworthy/pull/1041
---

Reports now ranks manual effort by known total time, including cases with linked automation. Each case shows executions, timed and untimed counts, known total and timed average. Partial totals and unknown timings are explicit. Corrections replace the original execution's timing in its original period. The automation rate and frequency backlog remain available.

Correction traversal is limited to 64 links; longer chains count as untimed. Cross-project corrections in imported history cannot change manual effort totals.
