# 0131: a deploy holds requests in a proxy outside the stack

Date: 2026-10-22.
Amended 2026-10-23 by [PostgreSQL and a stateless app](2026-10-23-postgresql-and-a-stateless-app.md): this hold is retired only after rolling replacement passes the continuous-request
and rollback checks; until then it stays in place.

A Coolify deploy of `compose.coolify.yaml` removes the old ingress, app and Tailscale sidecar, then starts
the new ones. On the owner's instance the public address answered nothing for 16 seconds on 2026-10-22, and
for about 48 s in another deploy that day. Cloudflare showed its 502 to every request in that time.

Running the old and new stacks side by side would avoid the gap, but neither half is possible.
Coolify has no rolling replacement for Compose (decision 0031). And two servers cannot share one data
directory: the new one would wait on the old one's lock, and a health-first replacement would never stop the
old one. Making the stack start faster shortens the gap but does not close it. Any proxy inside the stack is
removed with it.

So the hold lives on the host, where no deploy touches it. The tunnel's origin, `127.0.0.1:7358`, is now
that proxy, and the stack's ingress moved to `127.0.0.1:758`. A refused connection is tried again each
second, for up to 90 s, which is under the 125 s Cloudflare waits for an origin's reply. The ingress still starts only once the
app is healthy, so a waiting request meets a refused port, which is tried again, and not an nginx 502, which
is not. The host proxy adds no client or scheme header, and the ingress keeps owning both. The ingress moved to a
port below 1024: nothing listens there during the gap, and a port any process could take would let it
receive the held requests and their credentials.

Two short windows remain where Docker's port proxy accepts a connection and closes it with no reply: while
the new ingress starts, and while the old one drains after SIGQUIT. A read (a GET or HEAD outside `/api/login/`, whose native OIDC callback consumes its ceremony) is sent again
at once, which carries it across the start window only: HAProxy spends all its
tries on an immediate retry in about 10 ms. A write is not sent again, because an empty reply can also follow a write the app committed, and a duplicate write is worse than a
502. The stop window lasts as long as the old nginx drains: 54 to 123 ms on the owner's host with no
response open, up to Coolify's 30-second stop while a change stream is open. The drain is left unbounded:
a `worker_shutdown_timeout` would shorten the window but could cut a write the app committed before its
one-time reply arrives, and the app's own 5 s grace starts only after the ingress has gone, so no shorter
bound is safe. The window can close entirely only when the host proxy reaches nginx without Docker's port
proxy in between (issue #743). A Unix socket removes the empty replies (measured: nginx deletes it at
SIGQUIT, and a connect gets ENOENT), but HAProxy retries a failed Unix connect at once, with no pause, and
Ubuntu's Caddy 2.6.2 cannot resend a request body after a failed dial. A fixed container address on a
dedicated Docker network would keep HAProxy's paced TCP retries, but Coolify rewrites each service's
networks, so it needs a deploy to prove.

HAProxy over Caddy: Caddy's active health checks answer a POST with 503 while the upstream is down, and
without them it has the same port-proxy window. HAProxy's health checks do the same (a 503 at once while its
only server is down), so the hold uses none. HAProxy retries a refused
connection for any method, and is in Ubuntu's main archive. Its configuration and tests live with the
host's other services, outside this repository; `docs/deploy.md` gives the settings any operator needs.

The tailnet address is not held: its sidecar is part of the stack.

No demo changes apply: this changes how the container is reached, not the product.

Principles: Fix Root Causes (the gap comes from replacing the whole stack, so the fix sits outside it);
Make Operations Idempotent (the host's install converges whether the old ingress still holds the port or
not); Test Behavior Not Implementation (the tests run the real HAProxy against a backend that goes away and
comes back).
