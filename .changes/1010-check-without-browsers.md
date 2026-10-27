---
id: 1010
category: Changed
date: 2026-10-27
issue: https://github.com/endqwerty/mainworthy/issues/1010
pr: https://github.com/endqwerty/mainworthy/pull/1018
---

`bun run check` and `bun run test` now omit Chromium tests by default. Add `--browser` to include them, or select a browser file explicitly. The summary names the omitted coverage. Pull request CI still runs the browser tests; server and process tests in `test/e2e/` stay in the local check.
