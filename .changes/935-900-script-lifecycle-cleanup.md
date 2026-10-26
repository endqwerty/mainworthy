---
id: 935-900-script-lifecycle
category: Fixed
date: 2026-10-25
issue: https://github.com/endqwerty/mainworthy/issues/935
pr: https://github.com/endqwerty/mainworthy/pull/964
---

Test PostgreSQL clusters record their checkout and are stopped and removed after it disappears, at cluster startup or scratch deletion. Existing checkout clusters remain intact. Older clusters without an owner need a matching original checkout path for recovery. The Daybreak audit uses a temporary Codex home with an authentication link, so user-level instruction files no longer direct the audit.
