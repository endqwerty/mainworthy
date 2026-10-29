---
id: privacy
category: Changed
date: 2026-10-29
pr: https://github.com/endqwerty/mainworthy/pull/1096
---

The privacy policy for mainworthy.com names Render, which runs the server and its database, and Sentry, which receives a trace of each request. A trace holds the route's pattern, the operation, the status and timings, never your content, address or name. The Render runbook says the traces endpoint ends in `/v1/traces`; Sentry shows it without that.
