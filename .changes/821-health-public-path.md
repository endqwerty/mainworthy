---
id: 821-health
category: Changed
date: 2026-10-26
issue: https://github.com/endqwerty/mainworthy/issues/821
pr: https://github.com/endqwerty/mainworthy/pull/947
---

The health check moved from `/healthz` to `/health`, for the CLI, CI, monitors and the container's own check: on Cloud Run, Google's front end answers `/healthz` itself and never passes it to the server. `/health` answers without a sign-in or the proxy's proof and says only the version, the API version and the commit. A CLI from before this change cannot check a server until it is updated.
