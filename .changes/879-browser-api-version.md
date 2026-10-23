---
id: 879
category: Fixed
date: 2026-10-23
issue: https://github.com/endqwerty/mainworthy/issues/879
pr: https://github.com/endqwerty/mainworthy/pull/886
---

Already-open browser pages cannot write through an incompatible API after a server upgrade. The web client sends its API version, and the server refuses browser writes with a missing or mismatched version and asks for a reload. Unversioned native iPhone, CLI and MCP requests continue to work.
