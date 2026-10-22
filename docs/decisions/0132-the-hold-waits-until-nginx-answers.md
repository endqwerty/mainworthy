# 0132: the hold waits until nginx answers, not until the port accepts

Date: 2026-10-22. Builds on decision 0131.

Decision 0131 put HAProxy on the host in front of the stack's ingress, retrying a refused connection every
second. The first two deploys behind it showed what that missed. Docker's port proxy accepts a connection on
the ingress's port whenever the ingress container runs, even while nginx in it does not listen, and closes it
with no reply. While a new ingress started, that lasted up to about 2 s (Coolify's `Starting` to `Started`).
In the second deploy, a request held across the 16-second gap was sent into that window and got 502. The
same happens while the old nginx drains after SIGQUIT, for as long as a browser holds a change stream open,
up to Coolify's 30-second stop. HAProxy retries an empty reply at once, with no pause, so a retry cannot wait
the window out. And it must not resend a write: an empty reply can also follow a write the app committed.

So a Lua task in HAProxy asks nginx itself whether it answers, every 100 ms, and a request waits while it does
not. The question is a `CONNECT`, which nginx refuses itself (405) without asking the app, so a slow app does
not hold requests back. Any status line means nginx answers. A probe that fails with a Lua error opens the
gate, so a fault in the gate costs what it had cost with no gate rather than holding every request. A request still waiting after 90 s gets HAProxy's
own 503. With the gate, HAProxy no longer replays anything after an empty reply (decision 0131's GET and HEAD
replay is removed), so nothing is ever sent twice. The old ingress's drain stays unbounded: the app runs while
it drains, so a write in flight keeps its reply, and new requests wait at the gate meanwhile.

Opening the gate sends every held request at once, and nginx in the ingress has 256 connections, two for
each request. A live test that held about 360 requests got 121 of them dropped with 502. So HAProxy sends
at most 100 to nginx together and queues the rest for up to 30 s.

What remains is a request the gate let through just as the old nginx stopped, within one probe interval. If
it meets a refused port it is tried again; if it meets an empty reply it gets 502.

Rejected:
- Nginx on a Unix socket. nginx deletes the socket at SIGQUIT, so a connect fails cleanly, but HAProxy retries
  a failed Unix connect with no pause (5 retries in 0 ms on 3.2, measured), so it would need a gate anyway.
  It would also change the ingress's mounts and user.
- Ubuntu's Caddy 2.6.2, which retries a failed dial every `lb_try_interval`: its retry of a request with a
  body fails (`invalid Read on closed Body`, measured).
- A fixed container address on a dedicated Docker network, which would avoid the port proxy. Coolify rewrites
  each service's networks, so it could only be proven by a deploy.
- Turning off Docker's userland proxy for the whole daemon, which changes every container on the host.
- A health check in HAProxy: while its only server is down, HAProxy answers 503 at once and queues nothing.

The gate's configuration and tests live with the host's other services, outside this repository; they run
with Ubuntu's exact HAProxy package in a container. `docs/deploy.md` gives the settings and the Lua.

No demo changes apply: this changes how the instance is reached, not the product.

Principles: Fix Root Causes (the port proxy accepts for an nginx that does not listen, so the gate asks
nginx); Test Behavior Not Implementation (the tests drive the real HAProxy against a port that accepts and
closes); Experience First (a request waits rather than fail during a deploy, and a write is never repeated).
