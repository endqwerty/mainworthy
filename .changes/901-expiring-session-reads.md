---
id: 901
category: Fixed
date: 2026-10-24
issue: https://github.com/endqwerty/mainworthy/issues/821
pr: https://github.com/endqwerty/mainworthy/pull/901
---
Sessions that expire while an account read or live-update connection is being authorized now receive the sign-in-required response. This keeps session expiry from appearing as a missing project.
