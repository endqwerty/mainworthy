---
id: 821-proxy-secret
category: Added
date: 2026-10-25
issue: https://github.com/endqwerty/mainworthy/issues/821
pr: https://github.com/endqwerty/mainworthy/pull/0
---

`MAINWORTHY_PROXY_SECRET` lets the public app require proof that a request passed through its proxy, including on Cloud Run where direct requests share the proxy's connecting address. The proxy must overwrite `x-mainworthy-proxy` with a secret of at least 32 characters. Requests without matching proof receive JSON 403 before any handler runs, except `GET /healthz` for startup probes. Proved requests use the single visitor address in `MAINWORTHY_CLIENT_ADDRESS_HEADER` for sign-in limits. Address-based proxy trust remains available; setting both trust methods stops startup.
