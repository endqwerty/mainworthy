# 0130: production blocks new outbound connections in the app namespace

Date: 2026-10-21. Local implementation; production cutover belongs to the operator.

Coolify adds network attachments, and a host bridge filter misses host INPUT, same-bridge
and IPv6 paths. Internal-only networks also failed the deployment's publishing and proxy
requirements. The policy therefore belongs in the application's own network namespace.

The caller selects `MAINWORTHY_LOCKDOWN=1` in production Compose. Startup transitions from
root setup, through an atomic nft install and readback, to an irreversible `setpriv` drop
and exec. The actual app verifies its own identity and capability sets before dispatch.
A packaged utility handles credential syscalls instead of a new custom privileged launcher.
Healthchecks repeat only the credential drop. Ordinary image consumers keep the original
nonroot entrypoint behavior and outbound connections.

A dedicated proxy with a fixed upstream replaces the public Traefik route after cutover.
It receives the host's Cloudflare Tunnel on loopback and replaces scheme and client headers.
The operator supplies the application-network trust range. The app's existing address parser
and rate limiter consume the dedicated header without a second identity implementation.
The application data volume stays with Mainworthy; Tailscale retains its own identity volume
and direct internal proxying. No host firewall rules or privileged daemon are added.

The proxy cannot authenticate a copied CF-Connecting-IP header. Cloudflare plus the host
loopback listener and removal of the old origin route establish the public boundary.
Trusted network peers and the host remain privileged actors. See `docs/deploy.md` for checks
and limits. No demo changes apply because this changes container deployment, not the product.

Principles: Boundary Discipline (validate at setup and actual app startup); Make Operations
Idempotent (replace the owned table atomically every start); Test Behavior Not Implementation
(reachable packet controls, actual process credentials, proxy headers and sign-in limits).
