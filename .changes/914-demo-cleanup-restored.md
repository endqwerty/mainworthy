---
id: 914-demo-cleanup
category: Fixed
date: 2026-10-27
issue: https://github.com/endqwerty/mainworthy/issues/914
pr: https://github.com/endqwerty/mainworthy/pull/1016
---
`mainworthy serve` again refreshes the demo after a deploy and deletes the retired one, both paused since 2026-10-24. Each cleanup slice now reads only the retired demo's own rows, by index, so its cost no longer grows with the other projects on the instance. On a copy with 20 projects and a million results, the longest slice fell from 289 ms to 27 ms and the whole cleanup from 140 s to 46 s. Migration 6 adds three indexes the cleanup reads by. When two instances share a database during a rollout, the second finds the first one's demo and keeps it, with the edits made in it, also when it lost the lock that keeps the two refreshes apart; a retired demo one of them already removed no longer stops the other's refresh. While two retired demos wait for a cleanup that keeps failing, a new revision retires no third: the demo keeps its earlier revision and the server logs why. On SIGTERM, `serve` stops its demo refresh, cleanup and work renewal at their next statement, and none of them commits. A statement waiting for another writer's lock waits on, so `serve` exits after 7 seconds at most, with a warning naming what was still running, inside the 10 seconds Cloud Run allows; PostgreSQL then rolls that statement's transaction back within about a second.
