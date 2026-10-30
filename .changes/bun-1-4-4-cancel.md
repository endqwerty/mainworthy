---
id: bun-1-4-4
category: Changed
date: 2026-10-30
pr: pending
---

The executable and the container image are built with Bun 1.4.4, and the licence notices list what it links, including the code its new formatter and linter port from Prettier, ESLint and their plugins. A stopped request's database statement is now cancelled through the connection that runs it, so the cancel can no longer reach another client's statement behind a connection pooler.
