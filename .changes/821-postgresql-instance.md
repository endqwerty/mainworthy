---
id: 821-postgresql
category: Breaks
date: 2026-10-23
issue: https://github.com/endqwerty/mainworthy/issues/821
pr: https://github.com/endqwerty/mainworthy/pull/901
---

Instances now require PostgreSQL 18; `compose.yaml` starts it beside the app. SQLite records are not migrated automatically, so upgrading starts an empty database and the configured demo fills it. Existing identities, tokens and sessions must be set up again. The SQLite volume remains untouched; before accepting new writes, redeploying the previous commit restores the old instance. Automatic database-file upgrade copies and the Local product layer are removed. Running elsewhere remains possible but is not yet supported.
