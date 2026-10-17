# 0096: Request authentication is separate from device ownership

Date: 2026-10-17

A tab can hold a response while another tab signs out and signs in as the same actor. The actor id stays the
same, so a device owner alone cannot identify the earlier request. Its late 401 used to sign out the first tab
even though the shared cookie named a newer valid session. Its late 200 could replace newer session details.

Keep actor-owned UI lifetime in `DeviceSession`: actor id, local activation revision and the explicit clear
barrier. Keep authentication generation separate. `device.ts` publishes an opaque random string in browser
storage after a successful session-establishing exchange or logout. The cookie remains authoritative. The
generation is an invalidation signal, never a credential. Completed sign-ins reply `signedIn: true`.
A second-factor challenge, linked-only OIDC reply, reset or email verification does not establish a session.
Ordinary session reads, new tabs and identity adoption publish nothing.

Each browser-owned `call`, `session` and signed-in `exchange` captures the current generation before dispatch.
Before exposing a result or refusal, it checks both that generation and the existing device owner. A local
publication revision also invalidates the publishing tab's earlier requests when storage writes fail, even
if reads still work. When storage cannot be read, within-tab publication checks remain available. Storage
availability changes can discard a reply, which is safer than accepting an unknown generation.

An obsolete reply is a synthetic `ApiError` with status null. It does not dispatch global sign-out. App retries
an obsolete session read once, keeps an existing workspace after repeated replacement, and offers Reconnect
on startup if neither read survives. Event reconnect can retry with its current mounted owner. Lost logout
confirmation needs a real current HTTP 401 before it reports success or applies a clear choice.

Do not remount the same actor's workspace on generation changes. RunCockpit holds pending attachment bytes
and other in-progress state only in memory. Remounting would discard them. Existing actor-change storage
handling still returns a different actor's tabs to sign-in, and explicit clear retains its deletion barrier.
Old writes are never automatically retried under another identity.

App subscribes to storage and global refusal before comparing its cached clear barrier with current storage.
A missed clear uses the existing refusal path to synchronize and invalidate old work before the startup read,
including on return from OIDC. Reply ownership checks remain in place.

A server session id alone requires another discovery request before publication and still leaves an interval
after cookie replacement. Keep session ids as test evidence rather than a second runtime generation. A
browser can apply the cookie before JavaScript publishes the generation. Protection begins after the newer
successful exchange is observed by a cooperating tab. Without shared storage there is no cross-tab signal.
Overlapping authentication responses retain the cookie-order limits accepted in decision 0067. This change
adds no authentication manager, lock or pre-dispatch transition protocol.

Tests hold real two-tab refusals across a newer session, inspect distinct server session ids, create a stored
case with its author, and record preserved attachment bytes. Focused checks cover stale successful replies,
actor round trips, storage failures, startup, live-update recovery and logout confirmation. Existing privacy,
clear-device and draft restoration checks remain in place. This browser coordination fix adds no demo data.
