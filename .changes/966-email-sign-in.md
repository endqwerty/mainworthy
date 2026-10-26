---
id: 966-email-sign-in
category: Added
date: 2026-10-26
issue: https://github.com/endqwerty/mainworthy/issues/966
pr: pending
---

A person signs in with their email address or their name, and their password, on the web and in the iPhone app. The field is now **Email or name**. The address is the one under Settings, **Your sign-in**, **Email**, which every instance now shows: one that sends no mail saves it unverified, with **Save email address**, where it used to refuse it with "mail is off on this instance". Such an address signs the person in and receives no mail. A name wins over another person's address that reads the same, and failed attempts count against the person whichever was typed. `POST /api/login` takes an address of up to 254 characters in `name`.
