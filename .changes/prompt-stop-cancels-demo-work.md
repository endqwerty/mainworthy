---
id: prompt-stop
category: Changed
date: 2026-10-29
pr: https://github.com/endqwerty/mainworthy/pull/1097
---

A stopping server cancels its demo work's database statements, also one waiting for another writer's lock, and exits at once instead of waiting up to 7 seconds. The 7-second limit still ends a stop that waits for a request being served.
