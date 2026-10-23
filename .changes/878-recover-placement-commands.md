---
id: 878
category: Fixed
date: 2026-10-23
issue: https://github.com/endqwerty/mainworthy/issues/878
pr: https://github.com/endqwerty/mainworthy/pull/887
---

Suite placements and Undo keep their command IDs when replies are lost. Pressing `u` checks the recorded outcome before retrying the same request, so a retry of an already-recorded Undo no longer overwrites another person's later move.
