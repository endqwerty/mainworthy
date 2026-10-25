---
id: 821-background
category: Changed
date: 2026-10-24
issue: https://github.com/endqwerty/mainworthy/issues/821
pr: https://github.com/endqwerty/mainworthy/pull/931
---

Background work uses durable PostgreSQL jobs with transactional enqueue, expiring claims and bounded retries. The separate job service accepts Google OIDC service identities at the registry's job endpoint; the public service refuses it. Startup schedules recovery and assertion rebuilds without waiting for them. Attachment I/O is asynchronous, and an age-bounded prune coordinates with uploads through shared object rows. Mail is queued in the writer's transaction, survives restarts and retries at least once; completed or exhausted jobs remove its private message input. Demo refresh and retired cleanup remain paused. Cloud Tasks dispatch is not included yet. Password-reset links and their mail jobs now commit together; an enqueue failure preserves the prior link. Periodic jobs remove expired sign-in state and change-stream hints older than 24 hours. Streams with missing history refresh the project. Recovery and decision-expiry jobs record their changes for every instance. Session expiry and sign-in retention fence their job claims after identity and actor locks, preventing an expired worker from changing records after a successor takes over.
