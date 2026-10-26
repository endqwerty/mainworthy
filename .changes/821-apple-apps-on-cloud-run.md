---
id: 821-apple-apps
category: Fixed
date: 2026-10-26
issue: https://github.com/endqwerty/mainworthy/issues/821
---

iPhone: the app signs in to `mainworthy.com` with a passkey again, and is offered the phone's saved logins for it. The move to Cloud Run had left `MAINWORTHY_APPLE_APPS` unset, so `/.well-known/apple-app-site-association` was not found and the app said it "could not use a passkey for this instance". The service now takes it from the repository variable of that name, and an apply without it fails.
