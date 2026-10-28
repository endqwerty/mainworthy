---
id: 1044
category: Fixed
date: 2026-10-27
issue: https://github.com/endqwerty/mainworthy/issues/1044
pr: https://github.com/endqwerty/mainworthy/pull/1053
---

Rerun reports follow at most 64 correction links. Unresolved chains contribute unknown time instead of stale durations. Corrections from another project or a different test, producer, target or run cannot change a rerun's timing. Other project-bound result readers ignore corrections from another project.
