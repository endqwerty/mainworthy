---
id: 821-health
category: Changed
date: 2026-10-26
issue: https://github.com/endqwerty/mainworthy/issues/821
pr: https://github.com/endqwerty/mainworthy/pull/947
---

The server also answers its health check at `/health`, which the CLI, CI and monitors now use: on Cloud Run, Google's front end answers `/healthz` itself and never passes it to the server. `/healthz` still answers for a container's own health check. A CLI from before this change cannot check a server on Cloud Run until it is updated.
