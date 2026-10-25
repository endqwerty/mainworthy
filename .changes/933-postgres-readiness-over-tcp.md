---
id: 933
category: Fixed
date: 2026-10-25
issue: https://github.com/endqwerty/mainworthy/issues/933
pr: https://github.com/endqwerty/mainworthy/pull/934
---

On a first `docker compose up`, Mainworthy no longer starts while PostgreSQL is still initialising. The compose files' health checks ask PostgreSQL over TCP, which the image's temporary setup server never answers, so the app waits for the real server.
