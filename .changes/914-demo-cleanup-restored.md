---
id: 914-demo-cleanup
category: Fixed
date: 2026-10-27
issue: https://github.com/endqwerty/mainworthy/issues/914
pr: pending
---
`mainworthy serve` again refreshes the demo after a deploy and deletes the retired one, both paused since 2026-10-24. Each cleanup slice now reads only the retired demo's own rows, by index, so its cost no longer grows with the other projects on the instance. On a copy with 20 projects and a million results, the longest slice fell from 289 ms to 27 ms and the whole cleanup from 140 s to 46 s. Migration 6 adds three indexes the cleanup reads by. Two instances starting on one database during a rollout refresh the demo one at a time, so the second keeps the first one's demo and the edits made in it, and a retired demo one of them already removed no longer stops the other's refresh.
