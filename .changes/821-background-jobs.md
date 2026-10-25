---
id: 821-background
category: Changed
date: 2026-10-24
issue: https://github.com/endqwerty/mainworthy/issues/821
pr: pending
---

Background work uses durable PostgreSQL jobs with transactional enqueue, expiring claims and bounded retries. The separate job service accepts Google OIDC service identities at the registry's job endpoint; the public service refuses it. Startup schedules recovery and assertion rebuilds without waiting for them. Attachment I/O is asynchronous, and an age-bounded prune coordinates with uploads through shared object rows. Demo refresh and retired cleanup remain paused. Cloud Tasks dispatch is not included yet.
