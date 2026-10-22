# 0134: Anonymous sign-in starts have their own allowance

2026-10-22. Fixes [issue #664](https://github.com/endqwerty/mainworthy/issues/664).

A provider begin or passkey challenge allocates an entry in a 10,000-entry map for five minutes. One address
could request enough entries to evict another person's pending sign-in. Counting starts as failed credentials
stopped that flood but made ordinary use behind an office address escalate to fifteen-minute blocks, including
refusals of the right password. Independent review of [PR #772](https://github.com/endqwerty/mainworthy/pull/772)
found this before landing.

Anonymous starts have a separate fixed window of 300 starts per address per 60 seconds, anchored at the first
start. Web/native passkey and provider starts share it, as do provider linking and invitation/provider begins.
Reservation is synchronous before allocation or provider discovery. Refused requests do not extend the window.
The next window restores all 300 starts. No start reads or changes the failed-credential limiter, so this quota
cannot refuse a password or an otherwise valid completion of a pending passkey/provider ceremony.

Three hundred permits an office's simultaneous first attempts and a sustained five starts per second.
A five-minute interval intersects at most six windows, allowing at most 1,800 admissions for one remembered
address. That is below either map's 10,000-entry cap. This is an admission bound, not a proof about arbitrary
delays before asynchronous provider allocation. It does not protect against a distributed sender with many
addresses. The quota remembers at most 10,000 keys, discarding expired windows then the oldest when full.
It uses the existing trusted-proxy address extraction and IPv6 /64 grouping; private/unknown addresses remain
uncounted. A restart clears it.

A working invitation is proof of a random server-issued code. Its page remains accessible during either
address block, while guessed codes retain the failed-attempt limit. Repeated valid reads reuse the same
invitation-bound registration challenge, with its original deadline. With one minute left, the next read
creates a successor and keeps the previous challenge valid until its original deadline. At most two unexpired
challenges exist for one invitation. This avoids invalidating another tab's operating-system prompt or letting
one code churn the shared map. The challenge store owns reuse, expiry and spending; there is no second cache.
The existing passkey `timeout` reports remaining lifetime, and the web page derives its deadline conservatively
from request dispatch. No wire field is added.

A token bucket would permit continuous refill but adds fractional-credit rules. Outstanding-ceremony quotas
would require accounting across both maps, every completion, expiry and import. The fixed window bounds the
reported flood with fewer state transitions. Exempting valid invitations without bounded reuse would leave
another way to fill the challenge map.

Principles: Model the Domain (separate allocations from failed proofs); Laziness Protocol (one synchronous
reservation operation); Boundary Discipline (validate invitation proof before exemption); Test Behavior Not
Implementation (HTTP lockout, flood, invitation and expiry checks).
