---
id: 821-shared-state
category: Changed
date: 2026-10-24
issue: https://github.com/endqwerty/mainworthy/issues/821
pr: pending
---

Sign-in limits, passkey and authenticator challenges, provider callbacks and mail links now share PostgreSQL state across instances. Token and session uses are stored during each request, at most once a minute; the idle check can expire an active session up to a minute early. Project change streams replay committed events across instances and recover missed wakeups on their heartbeat. Importing an archive invalidates pending ceremonies everywhere.
