---
id: 880
category: Fixed
date: 2026-10-23
issue: https://github.com/endqwerty/mainworthy/issues/880
pr: https://github.com/endqwerty/mainworthy/pull/885
---

People granted `read,record` can record Pass, Fail, Blocked and Skip in the web cockpit and iPhone app. The web cockpit also enables attachments carried by those reports. These controls now check `record`, the capability the operations require, instead of `produce`. Case edits and answers keep their existing permission requirements.
