---
id: 1009-owner-on-cloud-run
category: Fixed
date: 2026-10-27
issue: https://github.com/endqwerty/mainworthy/issues/1009
---

`mainworthy.com` names its owner from the repository variable `MAINWORTHY_OWNER`. The move to Cloud Run had left it unset, so each start could give a person named `owner` every capability, making one if nobody had that name. An apply without the variable now fails.
