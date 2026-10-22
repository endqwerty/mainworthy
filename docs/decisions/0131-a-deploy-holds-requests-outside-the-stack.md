# 0131: a deploy holds requests in a proxy outside the stack

Date: 2026-10-22.

A Coolify deploy of `compose.coolify.yaml` removes the old ingress, app and Tailscale sidecar, then starts
the new ones. On the owner's instance the public address answered nothing for 16 seconds on 2026-10-22, and
for about 48 s in another deploy that day. Cloudflare showed its 502 to every request in that time.

Running the old and new stacks side by side would avoid the gap, but neither half is possible.
Coolify has no rolling replacement for Compose (decision 0031). And two servers cannot share one data
directory: the new one would wait on the old one's lock, and a health-first replacement would never stop the
old one. Making the stack start faster shortens the gap but does not close it. Any proxy inside the stack is
removed with it.

So the hold lives on the host, where no deploy touches it. The tunnel's origin, `127.0.0.1:7358`, is now
that proxy, and the stack's ingress moved to `127.0.0.1:7359`. A refused connection is tried again each
second, for up to 90 s, which is under Cloudflare's 100-second limit. A connection that Docker's port proxy
accepts and closes before nginx listens is sent again too. The ingress still starts only once the app is
healthy, so a waiting request meets a refused port, which is tried again, and not an nginx 502, which is not.
The host proxy adds no header, and the ingress keeps owning the client address and the scheme.

HAProxy over Caddy: Caddy's active health checks answer a POST with 503 while the upstream is down, and
without them it has the same port-proxy window, which it retries for GET only. HAProxy retries a refused
connection for any method, and is in Ubuntu's main archive. Its configuration and tests live with the
host's other services, outside this repository; `docs/deploy.md` gives the settings any operator needs.

The tailnet address is not held: its sidecar is part of the stack. A request that runs longer than
Coolify's 30-second stop of the old ingress is still cut off.

No demo changes apply: this changes how the container is reached, not the product.

Principles: Fix Root Causes (the gap comes from replacing the whole stack, so the fix sits outside it);
Make Operations Idempotent (the host's install converges whether the old ingress still holds the port or
not); Test Behavior Not Implementation (the tests run the real HAProxy against a backend that goes away and
comes back).
