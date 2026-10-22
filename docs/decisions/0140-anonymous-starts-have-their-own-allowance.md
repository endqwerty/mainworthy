# 0140: Anonymous sign-in starts have their own allowance

2026-10-22. Fixes [issue #664](https://github.com/endqwerty/mainworthy/issues/664).

A provider begin or passkey challenge allocates an entry in a 10,000-entry map for five minutes. One address
could request enough entries to evict another person's pending sign-in. Counting starts as failed credentials
stopped that flood but made ordinary use behind an office address escalate to fifteen-minute blocks, including
refusals of the right password. Independent review of [PR #772](https://github.com/endqwerty/mainworthy/pull/772)
found this before landing.

Anonymous starts have a separate fixed window of 300 starts per address per 60 seconds, anchored at the first
start. Web/native passkey and provider starts share it, as do provider linking and invitation/provider begins.
Reservation is synchronous before allocation or provider discovery. Refused requests do not extend the window.
The next window restores all 300 starts. Ordinary starts do not read or change the failed-credential limiter, so this quota
cannot refuse a password or an otherwise valid completion of a pending passkey/provider ceremony.

Three hundred permits an office's simultaneous first attempts and a sustained five starts per second.
A per-address limit alone is insufficient: a single IPv6 subscriber can use 34 /64s within one /58 to obtain
10,200 starts in one window, evicting another person's ceremony. No distributed sender is needed.
An additional instance-wide fixed ceiling of 1,000 starts per 60 seconds covers every anonymous start,
including private and unknown addresses. A five-minute interval intersects at most six windows, allowing
at most 6,000 anonymous admissions across every address, below either map's 10,000-entry cap. One thousand
permits a large office burst and sustained traffic above sixteen starts per second. When it is exhausted,
new anonymous starts across the instance wait for its remaining window. Passwords, valid pending answers
and working invitation pages do not wait on this allocation ceiling.

The global count is separate from the bounded address-key map, so rotating addresses cannot evict it.
Both windows are checked and consumed synchronously; a refusal consumes neither and extends neither.
The per-address quota remembers at most 10,000 keys, discarding expired windows then the oldest when full.
It uses the existing trusted-proxy extraction and IPv6 /64 grouping. Private/unknown addresses skip only
the per-address count. OIDC state keeps the deadline from before provider discovery, and a start whose
lifetime expired while discovery was pending allocates no state. A restart clears the allocation counts.

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
