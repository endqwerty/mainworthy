---
id: 914
category: Fixed
date: 2026-10-24
issue: https://github.com/endqwerty/mainworthy/issues/914
pr: https://github.com/endqwerty/mainworthy/pull/915
---
mainworthy.com stopped answering for hours after a deploy: the retired-demo cleanup held the server's only thread while it deleted the old demo. `mainworthy serve` now runs neither the demo refresh nor that cleanup at startup, so the server answers at once; the demo stays as it was until the cleanup runs off the server's thread.
