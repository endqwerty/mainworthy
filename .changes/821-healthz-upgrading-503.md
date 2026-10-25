---
id: 821
category: Changed
date: 2026-10-25
issue: https://github.com/endqwerty/mainworthy/issues/821
pr: https://github.com/endqwerty/mainworthy/pull/941
---

While the server starts and migrates, `/healthz` answers HTTP 503 instead of 200, with the same `ok: false, state: "upgrading"` body and `Retry-After: 5`. A probe that reads only the status, such as Cloud Run's, no longer calls a starting server ready. `mainworthy health` still exits 0 and prints `upgrading`; the CLI still says the server is upgrading.
