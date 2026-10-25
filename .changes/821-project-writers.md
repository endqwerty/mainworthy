---
id: 821-project
category: Breaks
date: 2026-10-23
issue: https://github.com/endqwerty/mainworthy/issues/821
pr: https://github.com/endqwerty/mainworthy/pull/919
---

Writes to different projects can run concurrently. A report releases its project and actor locks after acceptance and rechecks the admitting token or browser session and current authority before application or recovery. A revoked report is cancelled and stops holding runs pending. Lock contention and PostgreSQL deadlocks return retryable `busy` replies with HTTP 503. Retry unchanged content with the same command id. Already accepted reports remain pending until application or cancellation. The browser keeps pending requests and the CLI reports `busy` with exit code 4. The API version advances to 3. Clients pinned to API 1 or 2 must upgrade before writing. Identity mutations serialize before discovering actor names or row owners, so a later lookup cannot invert the actor and project lock order. Authority locks allow foreign-key references made by project writes. An identity mutation waiting for a busy project queues other identity mutations; sign-in locks only its existing actor and stays outside that queue. A session id absent when ending is requested returns not-found even if a sign-in creates it during the request. Ordinary project writes remain concurrent. Sign-ins return retryable `busy` if proof discovery resolves to another actor before commit, and credential locks follow the parsed request.
