---
id: 821-proxy
category: Added
date: 2026-10-25
issue: https://github.com/endqwerty/mainworthy/issues/821
pr: https://github.com/endqwerty/mainworthy/pull/943
---

`MAINWORTHY_PROXY_SECRET` lets the public app require proof that a request passed through its proxy, including on Cloud Run where direct requests share the proxy's connecting address. The proxy must overwrite `x-mainworthy-proxy` with a secret of at least 32 characters. Requests without matching proof receive JSON 403 before any handler runs, except `GET /healthz` for startup probes. Proved requests use the single visitor address in `MAINWORTHY_CLIENT_ADDRESS_HEADER` for sign-in limits. Address-based proxy trust remains available; setting both trust methods stops startup. The job endpoint moved onto the normal server: `MAINWORTHY_JOB_AUDIENCE` with `MAINWORTHY_JOB_ACCOUNT` lets a scheduler call `POST /api/job` with its Google token, which needs no proxy proof. `MAINWORTHY_JOB_SERVICE`, the job-only mode, is gone; a server that set it now serves everything and runs jobs as before.
