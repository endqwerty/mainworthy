# Running Mainworthy on a server

Mainworthy is one process and one SQLite file. A deployment is one container with one volume; there is no
database container to run, upgrade or back up separately (decision 0010).

**What is verified:** the image builds, starts, serves the UI and the API, keeps its data across a restart, and
passes its health check on the development machine. It also runs on the owner's Coolify (since 2026-10-12, the
steps under "On Coolify" as they were done): `/healthz` answers, a request with no token gets 401, and a browser
signed in with the owner token over plain HTTP and saved a case through the page. That instance was upgraded
across the rename on 2026-10-13: Coolify built the image, the server logged
`moved /data/casebook.db to /data/mainworthy.db`, and the one case and the owner token were still there. An
export taken just before is in the volume (`/data/before-rename-2026-10-13.ndjson.gz`).
**What is not:** the Tailscale sidecar in `compose.coolify.yaml` on that instance (`docker compose config` accepts the file once Coolify's own `exclude_from_hc` line is removed; the node has not joined yet), a restore from a backup on that instance, an upgrade that changes the schema of an instance that holds data, and the limit on failed sign-ins counting each visitor of that instance by address ("The limit on failed sign-ins" says what is expected and what was not measured).

## Images published by CI

On each push to `main`, `check.yml` builds the image once with a GitHub Actions layer cache (`type=gha`).
The `image` job loads it locally and checks readiness, the full commit from `/healthz`, and the packaged
documentation. After `gate` succeeds, `publish` downloads that same tested image and pushes it to
`ghcr.io/endqwerty/mainworthy`. It never rebuilds it. Pull requests never log in to GHCR or publish images.
Only `publish` has `packages: write`, using `GITHUB_TOKEN`; no additional secret is needed.

The tags are:

- `<full-sha>`: the full 40-character commit, for example `ghcr.io/endqwerty/mainworthy:0123456789012345678901234567890123456789`.
- `main`: the latest published commit that was still the tip of `main` when publishing. An older run or rerun
  publishes its commit tag but skips `main` if the branch has advanced.

The image embeds `MAINWORTHY_COMMIT`, so `/healthz` reports the image's full SHA without a runtime override.
Its OCI labels name the source repository (`org.opencontainers.image.source`), commit
(`org.opencontainers.image.revision`), and UTC creation time (`org.opencontainers.image.created`).

Production still builds on the owner's server through Coolify, using `build: .` in `compose.coolify.yaml`.
Publishing an image changes no deployment trigger or production configuration. Switching production to a
published image belongs to [issue #821](https://github.com/endqwerty/mainworthy/issues/821), step 5.
The future check that the server builds nothing does not apply to production yet.

### Make the package public once

After the first successful publish, the owner must open the `mainworthy` package on GitHub, open **Package
settings**, and change its visibility to **Public** under **Danger Zone**. The public repository does not make
the package public automatically. This is a one-time manual setting the owner must make; an agent cannot
perform it. Until then, anonymous pulls fail. GitHub documents
[package visibility settings](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility).

### Check the first push after merge

1. Confirm `image` builds once, passes its health and documentation smoke checks, and uploads `mainworthy-image`.
2. Confirm `publish` starts only after a successful `gate`, loads the archive without building, and pushes the
   full-SHA tag and `main` tag. If `main` advanced during the run, expect only the full-SHA tag.
3. After making the package public, pull the full-SHA tag without registry credentials. Inspect its OCI labels
   and run it without a commit environment override. Require HTTP 200, `ok: true`, and `commit` equal to that SHA
   from `/healthz`. Check that both tags resolve to the same digest when the commit is still `main`.
4. Confirm Coolify still builds from source on its existing schedule. After that deployment, the public
   `/healthz` must report the deployed commit. This checks the existing deploy path, not deployment of the GHCR image.

## The container

```
docker compose up -d --build
docker compose logs mainworthy | head -5      # the owner token, shown once, if you did not set one
```

Then open `http://localhost:7357` and paste the owner token. The browser gets a session cookie and does not keep
the token. It stays signed in for 14 days without use and for 90 days at most. `POST /api/logout` ends the
session for every copy of the cookie; the web UI has no button for it yet. Scripts, pipelines and agents keep
sending the token itself.

| Variable | Default in the image | What |
| --- | --- | --- |
| `MAINWORTHY_OWNER_TOKEN` | not set | The owner's token. Set it to a long random string (`openssl rand -hex 32`). Only visible ASCII characters without spaces are accepted. Whitespace, control characters and non-ASCII characters stop startup before any token or session changes. A value shorter than 20 characters or longer than 512 stops the start, in local mode too; one shorter than 32 starts, and every start warns. If unset, one is generated and printed once in the log whenever the owner holds no token that works: on the first start, on the start after an import, and on the start after the owner's last token expired. A value that is not yet a token replaces the old one: the start revokes every token that came from this variable and still works, whoever was the owner when it was set, and names them in one line ("Replacing a token" below). A value that is already a token replaces nothing. When that token was revoked, has reached its end or is somebody else's, it is not brought back: the start says which in one line on stderr, and the owner signs in again once the variable has a new value. |
| `MAINWORTHY_OWNER` | `owner` | The owner's name, as it appears in history. Set it before the first start. The start gives this person every capability; when the name is an agent's or a pipeline's on the instance, the server does not start and says which variable to change. |
| `MAINWORTHY_OWNER_WAS` | not set | To rename the owner: the name the owner has now, with the new name in `MAINWORTHY_OWNER`. The start renames that person, who keeps their tokens, password, passkeys, sessions and history, and says so in one line. Unset it afterwards. A former name that is nobody's, an agent's, a pipeline's, a forgotten person's or that of a person who does not hold every capability on every project stops the start, and so does a new name that is not one a person can be given. The guide has the steps: `docs/guide/configuration.md`, "Rename the owner". |
| `MAINWORTHY_DATA` | `/data` | Where `mainworthy.db` lives. Mount a volume here. |
| `MAINWORTHY_LOCK_WAIT_SECONDS` | `30` | Seconds to wait for another server to release the data directory. A finite nonnegative number, including fractions. `0` refuses immediately. |
| `MAINWORTHY_PORT` | `7357` | The port to listen on. |
| `MAINWORTHY_HOST` | `0.0.0.0` | The address to bind. |
| `MAINWORTHY_READERS` | available cores minus two, minimum 1, maximum 8 | Reader threads, each with its own read-only connection, so a read does not wait for a write. An integer from `0` through `8`; `0` runs reads inline on the server thread, which is slower under load and only for debugging. |
| `MAINWORTHY_SESSION_IDLE` | `14d` | How long a browser stays signed in without being used. A whole number and `h`, `d` or `w`: `12h`, `14d`, `2w`. A value that is not one stops the start with a line that names the variable. |
| `MAINWORTHY_SESSION_MAX` | `90d` | How long a browser stays signed in at most, however much it is used. Same form. The session cookie is given this age. |
| `MAINWORTHY_TRUSTED_PROXY` | not set | The addresses the proxy in front connects from: addresses and ranges, separated by commas (`10.0.1.0/24, 2001:db8::/32, 203.0.113.9`). Set it together with the next variable, or neither: one without the other stops the start with a line that says which is missing, and so does an entry that is not an address or a range. See "The limit on failed sign-ins". |
| `MAINWORTHY_CLIENT_ADDRESS_HEADER` | not set | The header in which that proxy writes the address of the visitor, for example `cf-connecting-ip`. It is read only from a peer `MAINWORTHY_TRUSTED_PROXY` names, and must hold exactly one address. |
| `MAINWORTHY_PUBLIC_URL` | not set | The address people open the instance at, as they type it: `https://mainworthy.example`. A passkey belongs to the host name in it, and an invitation link starts with it. Write https and a host name, or `http://localhost:<port>` on a developer's machine. An IP address or plain http anywhere else stops the start with a line that names the variable, because no browser makes a passkey there. So does a path or a query, because the server wants the root address of the instance. Not set: the instance has no passkeys, people sign in with a name and a password or with a token, and `mainworthy invite` prints a link without a host. The server never takes this address from a request's `Host`. |
| `MAINWORTHY_APPLE_APPS` | not set | The iPhone apps the site vouches for, so a phone offers the logins it keeps for this site (its own passwords, or a password manager's such as 1Password) on the app's sign-in screen: each a team id and a bundle identifier, `ABCDE12345.com.mainworthy.app.ABCDE12345`, separated by commas. `bun scripts/ios.ts install` prints the one it built when it signs the app with that site (a paid Apple developer team only: `docs/guide/iphone.md`). The server lists them at `/.well-known/apple-app-site-association`, where Apple reads them; the app names the site in its entitlements (`ios/App/Mainworthy.entitlements`, `mainworthy.com`). Not set: that address is not found, and the app's sign-in screen is offered no login. An entry that is not an app's name stops the start with a line that names the variable. |
| `MAINWORTHY_MODE` | `server` | `server`: every request needs a token. `local` (the default outside a container, on loopback): the browser on the same machine is the owner with no step. Local mode is for that machine only. The server checks what it can see: the connection comes from a loopback address, the `Host` is a loopback name, and the request carries none of the headers a proxy or a tunnel adds; a request that fails one of these needs a token. It cannot see through a relay that passes bytes on unchanged from this machine (`ssh -L`, `socat`, a port forward that adds no header): through one, anyone who reaches the relay is the owner. Never expose a local-mode port that way. To reach an instance from elsewhere, run it in `server` mode. |
| `MAINWORTHY_DEMO` | not set | A demo project the server empties and fills with the demo again on every start, once it listens (`mainworthy seed`; `docs/guide/customize.md`). A deploy restarts the container, so the demo shows the build that runs. Only a demo project is emptied: any other is left as it is, and the start says so in a line on stderr. The grants on it are kept. `compose.coolify.yaml` sets it to `demo` unless the variable is set, so setting it empty in Coolify switches it off; `compose.yaml` leaves it empty. The reset runs on a worker thread while health checks and reads keep answering; writes wait for its transaction. The seed then partly fills the project through the API. Each step logs its elapsed time. |
| `MAINWORTHY_COMMIT` | empty | The commit the build was made from, which `/healthz` reports as `commit` with no sign-in. Exactly 40 lower-case hexadecimal characters, else it counts as not set; the server then reads `SOURCE_COMMIT` (Coolify sets it on the running container), and reports `null` when neither holds a commit. The image takes it as a build argument: `MAINWORTHY_COMMIT=$(git rev-parse HEAD) docker compose build`, or `docker build --build-arg MAINWORTHY_COMMIT=$(git rev-parse HEAD) .`. Without it a plain build reports `null`. |

A container waiting for the data-directory lock ignores `docker stop` until Docker sends SIGKILL after its default 10 seconds, which is harmless with Compose's stop-then-create replacement.

The process runs as an unprivileged user (uid 10001). The health check is `mainworthy health`, which reads
`/healthz`.

A connection nobody has vouched for is closed after three minutes in which it sends and receives nothing, and the
body of a sign-in has five seconds to arrive. A request that carries a valid token, cookie or local session
takes that timeout off its connection: its reply may take as long as the work takes, and the change stream
stays open while nothing changes. So a client that is signed in may keep an idle connection open, as it could
before there was a timeout; the limit is for callers without a credential. Three minutes is longer than a proxy
keeps an idle connection by default (Traefik and Cloudflare's tunnel 90 seconds, nginx 60, Caddy two minutes),
so the proxy closes first; a proxy set to keep them longer than three minutes can lose a request it sends on a
connection the server has just closed.

Every HTTP reply carries its own security headers (`docs/architecture.md`, "What every reply carries"): a
Content-Security-Policy, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy:
no-referrer` and `Cross-Origin-Resource-Policy: same-origin`. The documentation at `/docs` differs in three of
them, on purpose: its replies keep the Content-Security-Policy and the `Referrer-Policy: same-origin` the
documentation site writes, and its pages and diagrams say `X-Frame-Options: SAMEORIGIN`, because a page of the
documentation frames its own diagrams. `Cross-Origin-Opener-Policy: same-origin` is on
every reply but two kinds: one to a request that came over plain http to a network name (a browser honours the
header only over https or on the machine itself, and logs an error otherwise), and the 500 reply, which is
written without the request. One reply carries none of them: the 101 that opens the reload socket of Bun's
development bundle, which only a start from source without `NODE_ENV=production` has, because a browser
applies no such header to a socket. A proxy in front does not need to add any of them. Two things follow for whoever
runs one:

- `Strict-Transport-Security: max-age=31536000` is sent only when the proxy says the request came over https,
  in `X-Forwarded-Proto`, the header the sign-in already needs. A proxy that does not send it gets no HSTS from
  Mainworthy. The header names this host only; a policy for the whole domain is the domain's to set.
- No page can show the app in a frame, on the same host or another. A dashboard or a tool that embeds
  applications in a frame shows an empty one for Mainworthy.

## Update the image pins

`Dockerfile` pins both base images by their multi-platform index digest and installs Debian packages from the
2026-10-22 [snapshot archive](https://snapshot.debian.org/). The dated archive fixes the versions of `nftables`,
`util-linux` and their dependencies together. Exact package versions from a live mirror can disappear after a
security update, so they would not keep an old commit buildable.

To resolve a new image digest, inspect its tag:

```
docker buildx imagetools inspect oven/bun:1.4.3
docker buildx imagetools inspect debian:bookworm-slim
docker buildx imagetools inspect tailscale/tailscale:stable
```

For a base image, copy the top-level `Digest` into the matching `FROM image:tag@sha256:...` line. Use the index
digest, not a platform's manifest digest, so amd64 and arm64 remain available. Keep the tag beside the digest
for readability.
Changing the Bun version also requires updating its licence notices and CI version (`licences/README.md`).

The production server uses `compose.coolify.yaml`, which pins the nginx and Tailscale images too. To move the
Tailscale pin, inspect `tailscale/tailscale:stable` with the command above and replace the digest in its `image:`
entry, keeping `stable` beside it. Editing the pin changes no running container. The next production deploy
pulls that exact digest.

For a Debian security rebuild, update the Debian digest and all three snapshot URLs to a fixed UTC date that
includes the required fixes. The snapshot sources replace the base's live sources and use HTTPS. The slim
runtime base has no CA bundle, so the Dockerfile copies `/etc/ssl/certs/ca-certificates.crt` from the
digest-pinned Bun build stage before apt runs. `check-valid-until=no` permits old signed snapshot metadata
after its expiry date; apt still verifies Debian's archive signatures. HTTPS prevents a network-only attacker
from replacing that metadata with an older signed version without also compromising TLS authentication.

Submit pin updates as ordinary reviewed changes. CI's `image` job builds and smoke-tests the image before it
can pass the deployment gate.

## The limit on failed sign-ins

A wrong token is counted where the server asks who the caller is: on a route that needs a sign-in, whether a
script or a pipeline sends it, and when a person types it into the sign-in form. A route that needs no sign-in
(`/healthz`, the API description, the documentation at `/docs`) looks at no token, and a sign-in body the form
does not accept (longer than 512 characters, or not text) is refused without being counted. A wrong token is
counted twice: against the address it came from, and against its own first 8 characters. The fifth failure of
either within 15 minutes blocks it for one second, and each failure after that doubles the block, up to 15
minutes.
While a block lasts, a request is answered `429` with the seconds to wait in `Retry-After`. The CLI prints
`limited: too many attempts; try again in 4 seconds` and exits 4, and the sign-in form says how long to
wait. What it means for whoever runs an instance:

- A token the server generated (`mainworthy token new`, or the owner token it printed) still works from a
  blocked address. A pipeline is not stopped because somebody on its network is guessing. Passing does not end
  the block: it runs out by the clock.
- A token you chose yourself gets no such pass, and a token the server made from the value of
  `MAINWORTHY_OWNER_TOKEN` is one you chose whatever it looks like. The server goes by where a token came from
  and not by its form, so a value written as `cb_` and 32 letters waits like any other. (A token the server
  generated and you later copied into the variable keeps the row the server made, and still passes.) A request
  that presents a token is judged by the token, whatever cookie comes with it. If you get `429` with it, wait for the seconds it names.
  Somebody who knows how your token begins can keep it blocked by guessing at it; a generated token cannot be
  blocked that way.
- A browser that is signed in is never counted and never blocked.
- A person's sign-in is counted in the same count. A wrong password is counted against the address and against
  the name it was tried for, however the name is capitalised and whether or not anybody has it; so is a wrong
  current password when somebody changes theirs. While either is blocked a password is not looked at, so the
  right one waits too. Somebody who knows a person's name can keep that name's password sign-in blocked by
  guessing at it, as with a token you chose; a passkey is not held up by that. A passkey's answer that is
  refused and an invitation code that accepts nothing are counted against the address alone, and a right one
  of either still works from a blocked address.
- The count is in memory. A restart clears it.

Anonymous passkey/provider starts have a separate allowance of 300 successful starts per public IPv4 address
or IPv6 /56 per minute. There is no instance-wide refusal for another source to monopolise. Starts never add
to failed-credential counts or block a password. A refused start gets `429` with remaining seconds in
`Retry-After`; retries do not extend or escalate its own source's wait. Unavailable starts do not spend it.
Valid pending answers, working invitations and signed-in provider linking bypass this allocation wait.

At capacity, each ceremony store expires dead entries then reclaims the oldest entry from the source with
the most live entries, preferring the incoming source on equal-size ties. Larger sources lose entries before
small unrelated sources. Many independent prefixes with equal shares remain indistinguishable, so this is
not unlimited Sybil isolation. Unknown/private peers are uncounted and share a retention bucket; configure
the trusted proxy below to tell visitors apart.

### Behind a proxy

Without the two variables, the address of a request is the address of its connection. Behind a proxy that is
the proxy's address, the same for every visitor. What the server does with it depends on the address:

- **A loopback or private address is never counted**, because one visitor could otherwise block all the
  others. That is a proxy on the same machine, on the same Docker network or on a private network. A wrong
  token is then counted against its first 8 characters only, which slows guesses at one token and does nothing
  to somebody whose every guess begins differently. A start in server mode says so in one line on stderr.
- **A public address is counted, as one address.** The server cannot know that it is a proxy's. Every visitor
  behind it then shares one count: five wrong tokens from one visitor block that address, and for as long as
  it stays blocked a token somebody chose (`MAINWORTHY_OWNER_TOKEN`) is refused for all of them. A token the
  server generated and a browser that is signed in still get through.

Naming the proxy fixes both. Tell the server which peer is the proxy and where the proxy writes the visitor's
address:

1. **`MAINWORTHY_TRUSTED_PROXY` is the address the server sees connections come from.** With several proxies in
   a row that is the last one, the one that connects to Mainworthy, and not the first one a visitor reaches. In
   Docker it is the proxy container's address on the network it shares with the app
   (`docker network inspect <network>`). A container's address can change when it is redeployed, so name the
   network's range (`10.0.1.0/24`). Every container on that network is then believed.
2. **`MAINWORTHY_CLIENT_ADDRESS_HEADER` is the header that reaches Mainworthy with the visitor's own address in
   it**, and nothing else: one address, no list and no port. Name a header only if a proxy in the row writes it
   from what it saw itself and replaces whatever the visitor sent under that name. A header the visitor can set
   and the proxies pass on unchanged lets anybody choose the address they are counted under, a new one for every
   guess. `X-Forwarded-For` is usually a list that each proxy appends to, and a list is not read.
3. **Check it from outside**, from a public address. Send eight wrong tokens that differ in their first 8
   characters, with no pause between them. The first five are answered `401` and the rest `429`. The first
   block lasts one second, which is why there is no pause.

   ```
   for i in 1 2 3 4 5 6 7 8; do
   	curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $i-not-a-token" https://<host>/api/session
   done
   ```

   Then, within a quarter of an hour, send two more from another network, one right after the other with new
   first characters (a phone off the Wi-Fi will do). Both must be answered `401`. What a different result means:

   - **All eight are `401`.** The server did not count the address. The peer is not in
     `MAINWORTHY_TRUSTED_PROXY`, or the header is missing, holds more than one address, or holds a private
     address, which is a proxy's and not the visitor's.
   - **The second of the two from the other network is `429`.** Both networks are counted as one address. The
     header holds the same address for everybody, a proxy's public one.

   A test runs this check against both kinds of header (`test/limit.test.ts`). Nobody has run it through a real
   proxy yet.

## Production network lockdown

`compose.coolify.yaml` enables `MAINWORTHY_LOCKDOWN=1`. The ordinary image and `compose.yaml`
leave it off, so outbound mail, webhooks, OIDC and other integrations keep working there.
Lockdown blocks every new outbound connection, including those integrations. Do not enable it
on a deployment that needs them.

The image entrypoint installs `scripts/container/lockdown.nft` in the app's network namespace.
It atomically replaces only its own table and compares the installed rules with the packaged
policy. IPv4 and IPv6 share a default-drop output chain. It permits loopback except Docker's
embedded DNS at `127.0.0.11`, and established or related replies to inbound traffic. It does not
permit the original direction of an outbound connection. New connections to another container,
the host, private networks, or the Internet are blocked on every attached interface. This also
covers networks Coolify adds. Reply traffic can still carry application data to an inbound caller.

Only setup runs as root, with NET_ADMIN, SETUID, SETGID and SETPCAP. `setpriv` switches to
UID/GID 10001, clears supplementary groups and every capability set, sets no-new-privileges,
and execs Mainworthy. Before serving, Mainworthy reads its own `/proc/self/status` and refuses
to start unless all five capability fields are zero, every UID/GID is 10001, groups are empty,
and NoNewPrivs is 1. A failed rule install, readback or credential check prevents startup.
Healthchecks use the same credential drop without changing the firewall. A host administrator
can still start a privileged process with Docker; the application cannot regain those privileges.
For a CLI command inside this container, use `docker exec <container> mainworthy-entrypoint <args>`.

The `ingress` service has one fixed upstream, `mainworthy:7357`. Its pinned Nginx image runs as
101:101 with a read-only filesystem, no capabilities, no-new-privileges, a temporary `/tmp`,
64 MiB memory and 64 PIDs. It holds no application volume, token or other secret. It publishes
only `127.0.0.1:758`, forces `X-Forwarded-Proto: https`, and replaces `X-Mainworthy-Client`
with `CF-Connecting-IP`. If the latter is missing, it removes the client header. CONNECT and
absolute-form request targets are refused. DNS refresh handles replacement app containers;
only the fixed service name is resolved, over IPv4 because that is the app's listening address.
Uploads stream to Mainworthy, which owns the body-size limits; the proxy does not buffer them
into its small tmpfs.
Tailscale continues proxying directly to the app through their shared network.

The operator must set `MAINWORTHY_TRUSTED_PROXY` to the actual application network peer range
and `MAINWORTHY_CLIENT_ADDRESS_HEADER=x-mainworthy-client`. Compose requires both values.
Every peer in that range is trusted; do not share it with untrusted workloads. The tailnet path
is a separate trusted internal path, not a public Cloudflare origin.

The public-origin contract requires a host Cloudflare Tunnel pointing to a request-holding
proxy on the host, which passes requests to `http://127.0.0.1:758` ("A deploy that holds
requests" below), and removal of the previous Coolify/Traefik domain after cutover.
A normal public request's malicious CF-Connecting-IP is replaced by Cloudflare before it
enters the tunnel. The proxy trusts that value; it cannot authenticate Cloudflare by inspecting
the header. A process that controls the host can spoof a loopback request, and a compromised
trusted application-network peer can reach the proxy internally. The loopback binding excludes
LAN clients, not a compromised host or trusted peer. Cloudflare Workers and header transforms
are part of the operator-controlled boundary. See [Cloudflare's header semantics](https://developers.cloudflare.com/fundamentals/reference/http-headers/).
Do not claim the public boundary until the old LAN-accessible Traefik route is gone.

To reproduce the container checks on a disposable Linux Docker host:

```sh
	docker build -t mainworthy-lockdown:test .
	docker build -f scripts/container/Dockerfile.test-tools -t mainworthy-lockdown-tools:test .
	python3 scripts/container/test.py
```

The test creates synthetic data and disposable networks and removes its containers and networks
on exit. It needs Python 3 on the host, Docker Compose, outbound access for positive controls,
and unused fixture subnets `172.30.231.0/24`, `fd42:231::/64`, `198.51.100.0/24` and
`2001:db8:231::/64`. It reads the proxy config from Compose. For Compose validation it strips
only the existing Coolify-specific `exclude_from_hc` property, as Coolify's parser does.
It covers TCP, UDP, ICMP, fragments, DNS, newly attached interfaces, capability removal,
header normalization, sign-in limits, loopback binding, invalid startup, health, restarts
and signals. IPv6 uses reachable fixtures; this does not prove public IPv6 routing on the host.
No real Tailscale identity is enrolled by this test. The operator must check that path after deploy.

## On Coolify

How the instance on the home server was set up. It takes about five minutes through Coolify's API or its
dashboard. This page writes the tailnet's name as `example.ts.net` and the node's tailnet address as
`100.64.0.10`; the real ones are in the home lab's notes.

1. **A deploy key.** The repository was private then (it is public since 2026-10-13, and a public one needs no
   key). Add a read-only deploy key to it on GitHub and give Coolify the private half (Security → Private Keys).
2. **New resource → Docker Compose**, from this repository with that key: compose file `/compose.coolify.yaml`
   (the instance's own file, with the Tailscale sidecar; `/compose.yaml` is the plain one), the branch to follow
   (`main`).
3. **Environment:** Coolify reads `MAINWORTHY_OWNER_TOKEN`, `MAINWORTHY_OWNER` and `TS_AUTHKEY` from the compose
   file. Set the token to a long random string (`openssl rand -hex 32`) and the owner to your name, before the first start.
   `TS_AUTHKEY` is a single-use Tailscale auth key (admin console → Settings → Keys), needed for the first
   deploy only; never use the sign-in link the sidecar prints, it rotates every minute.
4. **Storage:** the compose file declares the volume `mainworthy-data` at `/data`. Coolify creates it as a named
   volume. Bind it to a path you back up if you have one.
5. **Network:** the `tailscale` service in `compose.coolify.yaml` is its own tailnet node, `mainworthy`, and serves
   the app at `https://mainworthy.example.ts.net` (Tailscale issues the certificate; the first request can take
   a few seconds). Nothing is published on the LAN; ingress port 758 is bound to `127.0.0.1` for the hold
   in front of the host's tunnel. Anything on the tailnet can reach the name, and every request still needs a token. The node's identity
   lives in the `tailscale-state` volume: deleting it registers a new node.
   Once the node is up, disable its key expiry in the Tailscale admin console (Machines → the node), and delete
   `TS_AUTHKEY` from Coolify. For a server without Tailscale, use `compose.yaml` (publishes 7357) or give the
   ordinary non-lockdown service a domain in Coolify.
6. **Deploy**, then check: `curl https://mainworthy.example.ts.net/healthz` answers `{"ok":true,"version":"…","commit":"…"}`, and `commit` is the commit Coolify
   built (it comes from `SOURCE_COMMIT`; `compose.coolify.yaml` needs no line for it: naming the variable there would
   make Coolify list it as one of yours, and an empty value of yours replaces the one it generates). Compare it with
   the tip of `main` (`git ls-remote origin refs/heads/main`) to see whether the instance is behind. Open the page
   and paste the owner token.
7. **The public address:** start the hold below on the host, point the host's Cloudflare Tunnel at it
   (`http://127.0.0.1:7358`) for `mainworthy.com`, then remove the old Coolify domain and Traefik router. The ingress service sets the
   HTTPS and client headers. Set the proxy range and dedicated header as described above. The previous
   route was `https://localhost:443` through Traefik with a domain on the app service. It remains the live
   route until the operator performs the cutover; the private homelab notes track that work and rollback.
   - Keep Cloudflare's "Always Use HTTPS" on for the zone.
   - Turn off Cloudflare's automatic Web Analytics. Its injected external script violates the app's
     Content-Security-Policy, and the product promises no analytics (`docs/compliance.md`).

   To take the instance off the internet, delete the DNS record for the name or its route in the tunnel. A
   firewall rule for incoming connections does not do it: the tunnel is a connection the server opens outward.

### A deploy that holds requests

A Coolify deploy of a Compose file removes every container of the old stack, then starts the new one: it has
no rolling replacement for Compose, and two servers cannot share the data directory anyway (decision 0031).
On the owner's instance, on 2026-10-22, nothing listened for 16 seconds: removing the old ingress, app and
sidecar took 6.5 s, the new app listened 7 s after that and was healthy half a second later, and the new
ingress started 1.4 s after that. Another deploy that day took about 48 s. A request that reached the tunnel
in that time got Cloudflare's 502.

So the tunnel does not point at the stack. It points at a proxy on the host that no deploy touches, and that
proxy passes each request to the ingress on `127.0.0.1:758`, once nginx there answers. Until then the request
waits, for up to 90 seconds, and a deploy longer than that ends in a 503. Cloudflare waits 125 seconds for an
origin's reply (its documented Proxy Read Timeout). The 90 s is the gate's wait alone: a request it lets
through late can still queue (below), be retried and take the app's own time, so near the end of a long
deploy Cloudflare may give up first with its 524. The owner's instance
runs HAProxy, with a small Lua gate:

```
global
    setenv MAINWORTHY_HOLD_PROBE 127.0.0.1:758
    setenv MAINWORTHY_HOLD_WAIT_MS 90000
    lua-load /etc/haproxy/mainworthy-hold.lua

defaults
    mode http
    option http-server-close
    timeout connect 1s
    timeout http-request 30s
    timeout client 330s
    timeout server 330s
    retries 90
    timeout queue 30s

frontend public
    bind 127.0.0.1:7358
    http-request lua.mainworthy_wait
    http-request return status 503 content-type text/plain string "Mainworthy is being deployed; try again shortly.\n" if { var(txn.mainworthy_hold_expired) -m bool }
    default_backend stack

backend stack
    server ingress 127.0.0.1:758 maxconn 100
```

```lua
local probe_host, probe_port = string.match(os.getenv("MAINWORTHY_HOLD_PROBE"), "^(.+):(%d+)$")
local wait_at_most_ms = tonumber(os.getenv("MAINWORTHY_HOLD_WAIT_MS"))
local answers = false

local function nginx_answers()
    local socket = core.tcp()
    socket:settimeout(1)
    local ok = false
    if socket:connect(probe_host, tonumber(probe_port)) then
        if socket:send("CONNECT hold.invalid:443 HTTP/1.1\r\nHost: hold.invalid\r\n\r\n") then
            local line = socket:receive("*l")
            ok = line ~= nil and string.sub(line, 1, 5) == "HTTP/"
        end
    end
    socket:close()
    return ok
end

core.register_task(function()
    local failing = false
    while true do
        local ok, result = pcall(nginx_answers)
        if not ok and not failing then
            core.Alert("mainworthy-hold: the probe failed, so the gate is open: " .. tostring(result))
        end
        failing = not ok
        answers = not ok or result
        core.msleep(100)
    end
end)

core.register_action("mainworthy_wait", { "http-req" }, function(txn)
    local waited = 0
    while not answers do
        if waited >= wait_at_most_ms then
            txn:set_var("txn.mainworthy_hold_expired", true)
            return
        end
        core.msleep(50)
        waited = waited + 50
    end
end)
```

- **The gate asks nginx, not the port.** Docker's port proxy accepts a connection on 758 whenever the ingress
  container runs, even while nginx in it does not listen, and closes it without a reply. On the owner's
  instance that lasted up to about 2 s while a new ingress started (from Coolify's `Starting` to `Started`);
  before the gate, a request held across a deploy's gap was sent into it and got 502 after 16 s. It also
  lasts while the old nginx drains after SIGQUIT: it stops listening at once and waits for the responses it
  has open, 54 to 123 ms with none open, and up to Coolify's 30-second stop while a browser holds a change
  stream open. Every 100 ms the gate sends nginx a `CONNECT`, which nginx refuses itself (405) without asking
  the app, so a slow app does not hold requests back; any status line means nginx answers.
- **A probe that fails with an error opens the gate.** Requests then go on as they would with no gate. A
  task that stopped on an error would otherwise keep its last answer, and if that was "no", hold every request
  until it expired. A refused or silent nginx is an answer, not an error.
- **At most 100 requests go to nginx together** (`maxconn 100`); the rest queue in HAProxy for up to 30 s.
  When the gate opens after a deploy, every request it held goes at once. nginx in the ingress has 256
  connections, two for each request it passes on, and past that it drops them: in a live test on the
  owner's instance, with about 360 requests held for 18 s, 121 got 502 and nginx logged
  `256 worker_connections are not enough`. The limit holds all the time, not only after a deploy, and an open
  change stream keeps its slot for as long as it is open: with 100 streams open, any other request queues
  and gets 503 after 30 s, even with nginx and the app healthy. nginx alone would take about 128 before it
  dropped requests, so the limit costs a little capacity in exchange for never overrunning it.
- **The drain is left unbounded.** The app keeps running while the ingress drains, so a write in flight
  finishes and its reply arrives, as before, and new requests wait at the gate meanwhile. A
  `worker_shutdown_timeout` would cut a committed write's reply (a new token's secret is shown once).
- **Nothing is sent twice.** A request the gate let through just as the old nginx stopped, within one probe
  interval, meets either a refused port or an empty reply. A refused connection is tried again after a
  second (`retries 90` with `timeout connect 1s`; HAProxy waits the shorter of the two), which is safe for any
  method because nothing was sent. An empty reply ends in 502: it can also follow a write the app has
  committed, and HAProxy cannot tell the two apart.
- The ingress publishes a port below 1024. While a deploy leaves it free, a process on the host could
  otherwise listen there and receive the requests the hold sends, cookies and tokens included. Below 1024
  (`net.ipv4.ip_unprivileged_port_start`, 1024 by default) only root or a process with
  `CAP_NET_BIND_SERVICE` may listen; Docker's port proxy runs as root. This keeps out an ordinary process,
  not a privileged one or a compromised host. The hold's own port, 7358, is never free: HAProxy keeps it
  across deploys.
- `option http-server-close` opens a new connection to the ingress for every request, so none is reused
  after the stack it belonged to has gone.
- The two timeouts are longer than the ingress's 300 s; an open change stream sends a heartbeat every 20 s.
- No `option forwardfor`: the proxy adds no `X-Forwarded-For` and leaves `Host` and `CF-Connecting-IP` as
  they are; it only sends `Connection: close` towards the ingress. The ingress still sets the scheme and the
  client address from `CF-Connecting-IP`, and the app still trusts only the ingress.
- The ingress keeps `condition: service_healthy`: until the app is healthy there is no nginx to answer the
  gate, and requests wait. An ingress that started first would answer the gate and then 502 itself.

A change stream that is open during the deploy ends when the old stack stops; the browser opens it again
and that request waits like any other. The tailnet name is not held: the Tailscale sidecar is part of the
stack and is replaced with it, so `https://mainworthy.example.ts.net` is unreachable for those seconds.

This setup alone does not enable automatic deployment. To deploy manually, press Redeploy in Coolify or call
its API (`POST /api/v1/deploy?uuid=<application>`). The owner's instance uses an external deploy job; its
required check reads are under "Checks a deployment must wait for" below.

The project `demo` on this instance is seeded again on every start (`MAINWORTHY_DEMO=demo` in
`compose.coolify.yaml`), so each deploy leaves the demo of the code it runs. The start logs
`demo "demo" seeded again in <n> s: 2000 cases, 66 questions`, or a line that says why it was not. What anyone
changed in `demo` is gone after the next deploy; keep work in another project.

The worker first audits foreign keys without holding the write gate, so writes can continue during that scan.
It records the connection's database generation before the audit. After taking the gate and beginning a write
transaction, it compares the generation again. An intervening commit makes it roll back the empty transaction,
release the gate, and repeat the audit. An existing dangling reference refuses the reset before removal.

Removal, recreation, the demo mark, and retained grants share one transaction on the worker. `/healthz` and
ordinary reads keep answering and see the old committed demo until commit. Writes, including administration
lists and sign-in, wait for this transaction, then proceed alongside the seed's API requests. A stop before
commit preserves the old demo and grants; a stop afterwards leaves the empty demo and grants for the next seed.
The worker keeps foreign-key enforcement enabled and defers constraints until commit. SQLite checks outgoing
references on changed rows and uses child indexes to find incoming references to deleted parent keys, including
rows in other projects and changes made by triggers. Commit refuses any unresolved reference and rolls back the
whole reset. The reset performs no whole-database validation inside that transaction. Archive import and
standalone project removal retain their bulk audits.

Migration 37 adds the 28 missing incoming-reference indexes, using non-null partial indexes for nullable columns.
The schema test checks all 81 incoming references into tables removal touches, including SQLite's generated
DELETE programs. These indexes cost storage and maintenance on reports; decision 0087 records that tradeoff.
The migration changes no archive data or version.

Step timings go to stderr, for example `[mainworthy] demo "demo": delete results took 12.3 ms`. The log names
database opening and closing, owner lookup, `preflight foreign keys` (or, after two stale preflights, `check foreign keys under the gate`), transaction setup, provenance, grant capture,
foreign-key deferral, table discovery, every table count and delete, recreation with grants, `finish reset transaction`,
the whole reset worker, and the seed. Incremental constraint checks run with each delete and recreation statement;
`finish reset transaction` includes the final constraint decision and commit or rollback.

After ten minutes the reset requests its worker to stop. It stops only between SQLite statements. A running
statement must finish before rollback releases waiting writes. The seed gets a fresh fifteen-minute token after
removal, revoked when seeding ends. A graceful stop during reset skips that token. If seeding has begun, the stop
waits for the seed and its token cleanup before closing the database.
[Decision 0087](decisions/0087-responsive-demo-refresh.md) records the design.

## This repository's CI reporting to the instance

Built in decision 0014; switched on 2026-10-13 (issue #92). The `gate` job of `.github/workflows/check.yml`
reports to the instance `MAINWORTHY_URL` names when it can use it, and otherwise starts a Mainworthy of its own for
that run and says so on the run's summary page (`scripts/ci-instance.ts` has the rule, `test/ci-gate.test.ts` the
cases). For this repository that instance is `https://mainworthy.com`, project `mainworthy`.

**What is verified** (2026-10-13, the last two from GitHub's own runners):

- Every branch of that rule, against real local servers (`test/ci-gate.test.ts`).
- A passing pull request (#102). The `gate` job's summary read "Reported to the deployed Mainworthy:
  https://mainworthy.com, project mainworthy.", six reports held 941 results, the browser tests among them, and
  the gate passed. Asked afterwards, the instance gave the same verdict for that commit.
- A failing one (#104, one test that failed on purpose, closed unmerged). The gate was `blocked` on one question
  and the job exited 2. The question was answered on the instance as `infra`, which excuses the failure for that
  pull request only. A re-run of the `gate` job alone then printed "1 already decided" and passed.

**What is not:** the tailnet join from a GitHub runner. This instance has a public address and does not need it;
the steps are kept below for an instance that has none.

### How it was set up

1. **On the instance**, with a build that has the `record` capability (anything after decision 0014):

   ```
   mainworthy admin --json '{"do":"project.create","key":"mainworthy","preset":"standard"}'
   mainworthy --project mainworthy token new --ci github-actions     # shown once
   mainworthy actor list                                           # ci  github-actions  mainworthy  record
   ```

   That token records results on `mainworthy` and reads its gate. It cannot read the suite, edit a case, answer
   a question, plan a run or administer, under any policy. Where a project's policy creates a case for each test
   with none (decision 0021), its reports add those cases. `mainworthy` does, since 2026-10-17 (below).

   On the Coolify instance the commands ran inside the container, which already holds the owner token, so that
   token was copied nowhere: `docker exec <container> sh -c 'MAINWORTHY_TOKEN="$MAINWORTHY_OWNER_TOKEN" mainworthy-entrypoint …'`.
   The new token went from that command's output into `gh secret set MAINWORTHY_TOKEN` and was never printed.
   After the owner's own account is recovered, that owner token no longer signs in (decision 0067): set
   `MAINWORTHY_OWNER_TOKEN` to a new value and redeploy before using this route again. The CI token above is another
   actor's and keeps working.
2. **In the GitHub repository** (Settings → Secrets and variables → Actions, or `gh variable set` and
   `gh secret set`): variables `MAINWORTHY_URL=https://mainworthy.com` and `MAINWORTHY_PROJECT=mainworthy`, secret
   `MAINWORTHY_TOKEN`. The workflow gives the secret to the one step that reports. `TS_OAUTH_CLIENT_ID` and
   `TS_AUDIENCE` are not set, so the job skips the tailnet step.
3. **Check** on the next pull request: the `gate` job's summary reads "Reported to the deployed Mainworthy", and
   `mainworthy gate --commit <sha>` on the instance gives the verdict the job printed.

### What changes for a pull request

- **A failing test needs a fix, and nobody is asked** (since 2026-10-20, [decision 0124](decisions/0124-ci-failures-belong-to-the-session.md)). Project `mainworthy`
  answers every failure "Defect in the product" by rule, a dispute between two reports aside, so the gate is
  `failed` and the job exits 1 with no question in the queue. The session that pushed the commit fixes it. The
  job's log ends with the command that reads what failed from the instance: `bun scripts/work.ts ci <pull request>`
  (no argument: the branch's pull request; a commit, for `main`; `--wait=900` waits for a pending gate). It lists
  each failing test with its message and build, and exits as `mainworthy gate` does. The answer carries to later
  commits of the pull request and ends when a commit passes the test (decision 0102). A person can still overrule
  it; an agent and the pipeline cannot. An older commit whose answer ended that way reads `blocked` with no
  question open, and `ci` says nobody is asked. When `ci` reads `blocked` with a question open, a person is asked:
  if that is a CI failure, the policy was changed back, and `MAINWORTHY_TOKEN=<owner token> bun scripts/work.ts
  ci-policy` sets it again (run twice, it changes nothing). Until 2026-10-20 a failure was a question for a member and the gate
  stayed `blocked` until a later commit passed or a person answered: the owner's queue filled with failures the
  sessions were about to fix.

  `ci` reads with the token of the agent `sessions`, which may only read: `MAINWORTHY_TOKEN`, or the file
  `~/.config/mainworthy/agent-token` (mode 600, outside the repository; on the Mac since 2026-10-20).
- **Elapsed time is advisory.** A shard over 180 seconds emits a warning, including above the former
  240-second failure limit. Failed tests, incomplete reports and skipped test files still block the gate.
  Decision 0097 records the owner's suspension; [issue #77](https://github.com/endqwerty/mainworthy/issues/77)
  tracks a future timing gate. Job timeouts still stop hung jobs.
- **Reporting waits out a deploy after choosing the instance.** The gate's CLI health checks, shard reports
  and verdict requests make up to twelve attempts through connection failures and HTTP 502, 503 or 504. Each attempt
  has ten seconds, with ten seconds between attempts. All commands share a 230-second retry window within
  the nine-minute job, so each shard cannot start another full wait. A 4xx or other definite refusal returns
  immediately. A lasting outage still fails the job. A retry sends the same report body, whose batch key
  recovers the original receipt without recording results twice, including after a lost reply. Interactive
  CLI commands keep their existing behavior. Initial instance selection keeps its short probe and fallback
  to the job's own Mainworthy when the deployed instance cannot be used.
- **A newer attempt of a shard replaces the older one.** When the test passes in it, the gate passes and the
  rule's answer ends. Seen on this instance on 2026-10-13: `main` at `89d431a` was blocked
  by a browser test that fails now and then (#94), and green after a re-run of shard `tests-4`. GitHub's "Re-run
  failed jobs" re-runs only `gate`, because a shard with a failing test ends as a success and leaves the verdict
  to the gate. Re-run the shard's own job (`gh run rerun <run> --job <id>`): `gate` runs again after it and reads
  the other shards' reports from the earlier attempt. Since 2026-10-21 the `rerun` workflow does this by itself,
  once, after a run's first attempt fails, unless the lint, type-check, scope or description failed or more than
  three jobs would run again (decision 0128). Its run's summary says which jobs it ran again and why.
  A test that fails now and then is still a defect to fix, not to retry (`AGENTS.md`).
- **A change that touches no code reports fewer tests.** The `scope` job runs only what a change needs
  (decision 0090). For a change to prose, another workflow or the iPhone app, one shard named `tests` reports the
  test files it chose, and the gate on the instance judges those. The job's summary page lists them.

  Which attempt the gate reads is decided by the attempt's number (issue #124). Each shard uploads its report as
  `results-<shard>-attempt-<n>`, the `gate` job downloads every artifact of the run into a directory of its own
  name, and `scripts/ci-gate.ts` reads, for each shard, the highest attempt there is; its table has a column that
  says which. Until 2026-10-13 the artifacts of two attempts had one name and were merged into one directory, so
  the one read was the one written last: on pull request #109 (run 38367395704) shard `tests-2` passed in
  attempt 2 and the gate still reported attempt 1's failure. A shard whose newer attempt left no artifact at all
  is still read from the older one. That attempt's job is red: a job that could not be set up fails, and so does
  one whose tests left nothing to upload, at its upload step (`if-no-files-found: error`). The `gate` job fails
  with it: its last step requires every shard's job to have succeeded. An attempt that uploaded files and no whole
  report is the newest attempt all the same, and `scripts/ci-gate.ts` refuses it as "no report".
- **A test file with no case was one `map` question** under `standard` until 2026-10-13. The first two runs left
  70 of them in the queue, and a day later 104 of its 105 open questions were these. They never blocked the
  gate. `standard` now tracks such tests by rule, and what happens to them is the project's own choice
  (`docs/guide/policy.md`, "Tests with no case"). A project made before that keeps the clauses it had and is
  listed as `custom`: choose `standard` again in Settings, Policy, and the rule answers the open questions.
- **Every test of this repository is a case** since 2026-10-17, at the owner's request. Project `mainworthy`
  runs `standard` with tests with no case set to `create`, so a test that turns up later gets its case from the
  rule when its report arrives. The switch made 3,196 cases, one for each test the instance knew. 116 of those
  tests had stopped reporting before the switch, and the names of 115 of them no longer appear in their files at
  `c1dddcc`: they were renamed or removed (#458). A case's proof starts with the first report
  after the switch; the results recorded before it stay with the tests (Tests, `g t`). The gate's verdicts did not
  change: before and after, `c1dddcc` passed on 3,060 results and `b128b5d` on 3,062.

  How it was done, with the owner token over the public address. Choosing `create` answers only the open
  questions. The owner had answered `track` for 132 files, and that answer holds until a file's tests with no case
  change. Withdrawing such an answer keeps the question with people, so the rule does not take it back. The
  three steps, in this order:

  1. Withdraw each `track` answer: `decide {"undo": "Q-n", "ifDecision": <id>}`.
  2. Propose `{"op": "policy", "preset": "standard", "unlinked": "create"}` and accept it. The rule answered the
     16 open questions. `policy use standard` would set the choice back to `track`.
  3. Answer the 132 reopened questions `create` in one `decide {"all": [...]}`.

  The same steps on a copy of the project (`mainworthy export`, then `mainworthy import` into an empty local
  server) made the same cases first. On that copy, a report then put a pass on an existing case and made a case
  for a new test. On the instance, the first report after the switch came from the push of `f4382b8` to `main`.
  Its run started a minute before the switch and reported after it. That commit passed the gate on 3,063 results,
  and the report gave case C-579 a pass from the pipeline.
- **A pull request that is merged or closed tells the instance** (`.github/workflows/change.yml`, decision
  0022, since 2026-10-13). A failure nobody explained on it is then no longer asked about. Before this, such a
  question stayed in the queue until a person answered it: the one about pull request 150 outlived its merge.
  For a pull request that ended earlier, or whose event was missed: `gh workflow run change.yml -f pull=150`.
  A replay reads the pull request's state, merge commit and base branch from GitHub, so a merged trunk change
  keeps its landing commit. Add `-f state=merged`, `closed` or `open` only to override GitHub's state.
  The health check and lifecycle request each make up to twelve attempts through connection failures and HTTP
  502, 503 or 504, with ten seconds per attempt and ten seconds between attempts. Each can take up to 230 seconds,
  within the nine-minute job, while the instance restarts to follow `main`. A 4xx refusal fails immediately,
  except for the missing-change reply below. After retries run out, fix the cause and replay the event.
  The workflow checks the instance's API version first. While the first build with API
  versions waits to deploy (the tip of `main` must stand still for ten minutes), the running instance still
  answers `/healthz` without `apiVersion`. The workflow warns and sends the lifecycle request without the
  version header, as before, so pull requests closed in that window need no manual replay when the request
  succeeds. An instance that names a different API version, or an unknown operation, fails the job and needs
  a replay after the instance is upgraded. Only the specific reply that the named change was never reported
  is accepted as a harmless 404. The gate job still starts its own instance for an unversioned server: its
  report and gate commands require an advertised API version.
- **A push to `main` reports too**, as the workflow runs on it.

What can go wrong, and what the job does: the instance is down (its own Mainworthy, a warning); the instance is an
older or newer build with a different or absent API version, or which describes `report` or `gate` differently
(the same); the token was revoked or is for another project (the job fails and says which); the instance answers the token `429` after too many failed
attempts (the job fails too: the right token of a pipeline passes a block, so this one is not it). To stop
reporting to the instance, delete the `MAINWORTHY_URL`
variable. A breaking reply change increments `API_VERSION` in `src/core/version.ts`; CI then starts its own
instance until the deployed instance advertises that API version. No variable change is needed. To replace the
token, follow "Replacing a token" below: the new one is in use before the old one is revoked, so no run is refused in between.

The token is visible to the code of every pull request, because the `gate` job runs it. That code can report
wrong results for this one project; it cannot do anything else with the token. Until backups exist (#59) the
instance's history is one disk.

### An instance with no public address

Not tried from a GitHub runner. Before 2026-10-13 this instance was reachable on its tailnet only
(`https://casebook.example.ts.net`), and the `gate` job can join a tailnet for its own length.

1. **In the GitHub repository**, `MAINWORTHY_URL` is the tailnet address.
2. **In the Tailscale admin console** (an agent cannot do these):
   1. *Access controls.* Add the tag: `"tagOwners": { "tag:ci": ["autogroup:admin"] }`. Then **replace** the rule
      that lets everything reach everything; a narrow rule added beside it restricts nothing. On 2026-10-12 the
      tailnet had exactly that one rule (read from a member node's packet filter). With `"hosts": { "mainworthy":
      "100.64.0.10" }`:

      ```
      "grants": [
        { "src": ["autogroup:member"], "dst": ["*"], "ip": ["*"] },
        { "src": ["tag:ci"], "dst": ["mainworthy"], "ip": ["tcp:443"] }
      ]
      ```

      (In the older `acls` form: `autogroup:member` to `*:*`, and `tag:ci` to `mainworthy:443`.) Every node on the
      tailnet was owned by a member on that day, so the first rule keeps what they have. Check the console's
      preview for a device that is shared in or tagged before saving.
   2. *Settings → Trust credentials → Credential → OpenID Connect.* Issuer GitHub
      (`https://token.actions.githubusercontent.com`), subject `repo:endqwerty/mainworthy:*`, scope `auth_keys`
      (write), tag `tag:ci`. It is a federated identity: GitHub signs who the job is, and no Tailscale secret is
      stored anywhere.
   3. Copy its Client ID and Audience into the repository variables `TS_OAUTH_CLIENT_ID` and `TS_AUDIENCE`.
      Neither is a secret.

A runner node is removed from the tailnet when its job ends. A join that fails leaves the instance unreachable,
and the job then starts its own Mainworthy and warns.

## An instance made before the rename

The project was called Casebook until 2026-10-13 (decision 0015). An instance made before then is carried over
by the first start of the new build. What moves by itself:

- `casebook.db` in the data directory becomes `mainworthy.db`. The server folds the write-ahead log into the
  file first, so the rename carries every committed row. It refuses to start, and changes nothing, while another
  process has the old file open. Outside a container, `~/.casebook` becomes `~/.mainworthy` in the same step.
  The server logs one line for each move.
- A browser's drafts, run notes and theme move to their new keys when the page loads.
- An archive exported before the rename still imports.

What you do once:

- **Sign in again.** The session cookie has a new name. The owner token is unchanged.
- **Rename the variables you set**: `CASEBOOK_*` becomes `MAINWORTHY_*`, in a pipeline (`MAINWORTHY_URL`,
  `MAINWORTHY_TOKEN`, `MAINWORTHY_PROJECT`) and on a server. The old names are not read.
- **`compose.yaml`:** its volume is now `mainworthy-data`. If you started it before the rename, the data is in
  `casebook-data`; copy it across before the first start, or the instance starts empty:
  `docker run --rm -v <project>_casebook-data:/from -v <project>_mainworthy-data:/to alpine cp -a /from/. /to/`.

The instance on Coolify kept its names from before the rename until 2026-10-16: the service and the tailnet
node `casebook`, the volume `casebook-data` and the Coolify variables `CASEBOOK_OWNER_TOKEN` and
`CASEBOOK_OWNER`. Since then it is `mainworthy` everywhere. The deploy of 2026-10-16 (pull request #402) moved
the data with a one-shot service, `carry-data`, that copied `casebook-data` into `mainworthy-data` after Coolify
had stopped the old container and before the app started: 2.2 GB in about 70 s, and the public address answered
again two minutes after the old container stopped. What was learned there, for the next deployment that moves:

- **Coolify keys a domain by the service's name.** Put the domain on the new service name before the deploy
  that renames the service, or the public address loses its route.
- **Coolify writes a stored variable into the file, an empty one too.** `${TS_HOSTNAME:-mainworthy}` became
  `TS_HOSTNAME: ''` while Coolify held the variable empty, and the default did not apply. Plain
  `docker compose` would have used the default. The sidecar then ran `tailscale up` with no `--hostname`, which
  Tailscale refuses while the node's state holds a hostname that is not the default, and the sidecar restarted
  in a loop. Change a stored variable to the new value; do not empty it. With `TS_HOSTNAME` set to the new name,
  the node takes it and keeps its identity and its address.

## The upgrade to sessions

Until 2026-10-13 a browser's cookie held the token itself, for a year. A build from that day on gives the
browser a session instead (decision 0017). What the first start of the new build does by itself:

- It adds the table `sessions` to the database, after writing a copy of the database beside it
  (`mainworthy.db.v1.bak` if that copy does not already exist). A later upgrade can remove this copy.
- Tokens are untouched. The owner token, a pipeline's `MAINWORTHY_TOKEN` and an agent's token work as before.
- An archive exported by the earlier build still imports.

What you do once:

- **Sign in again**, in every browser. The upgrade signs every browser out: the old cookie, `mainworthy_session`,
  is no longer read. Paste the owner token as on the first day. That sign-in also removes the old cookie from
  the browser, so the token does not stay there.

Nothing else changes for a browser. Drafts and run notes are kept by the page, not by the cookie.

If `mainworthy.db.v1.bak` is still retained, stop the container, put it in place of `mainworthy.db` and start
the previous image. Sessions made since are gone with the table, and each browser signs in once more.

`compose.coolify.yaml` does not pass the two lifetime variables, so the instance on Coolify runs with 14 and 90
days. To change them there, add the two lines from `compose.yaml` to the service and set the variables in
Coolify.

## Replacing a token

A token works until it is revoked or, when it was made with an end, until that end. Give a token an end with
`mainworthy token new --expires 90d` or with "Expires" in Settings; a duration is a whole number and `h`, `d` or
`w` (`12h`, `90d`, `2w`). From its end on, a token is refused exactly as a revoked one is, and every browser
session that was opened with it ends with it. A token made without `--expires` has no end.

`mainworthy token list` and Settings show for each token when it ends, who made it, and the address it was last
used from. Each start of the server names, in one line on stderr, every token that ends within 14 days:

```
mainworthy: token 7 of github-actions ("ci token") expires in 13 days, and what uses it is refused from then on. Make its replacement with `mainworthy token new`, and revoke this one once the replacement is in use.
```

Nothing else announces the end. A pipeline whose token has expired is answered `unauthenticated`.

### A pipeline's or an agent's token

Two tokens of one actor work side by side, so the old one is revoked only after the new one is in use:

1. Make the second token. The actor exists, so the new token carries the grant the actor already holds:
   `mainworthy token new --ci github-actions --expires 90d`.
2. Put the new value where the pipeline reads it. For this repository: `gh secret set MAINWORTHY_TOKEN`.
3. Run the pipeline once. `mainworthy token list` then shows the new token with `last used from` and an address.
4. Revoke the old one by its id: `mainworthy token revoke <id>`.

`test/tokens.test.ts` runs these steps with the real command. They were not tried on the Coolify instance.

### The owner's token from the environment

`MAINWORTHY_OWNER_TOKEN` holds one value, so this replacement has no overlap. It costs one restart:

1. Make a value: `openssl rand -hex 32`.
2. Set the variable to it and restart the server. On Coolify the value comes from the variable that
   `compose.coolify.yaml` names, and the restart is a redeploy.
3. The start finds that the value is not yet a token. In one transaction it makes the value the owner's token
   and revokes every token that came from the variable before and was not revoked. It names each one and the
   actor it signed in, in one line on stderr:

   ```
   mainworthy: MAINWORTHY_OWNER_TOKEN has a new value: the token it held before (token 1 of robin) was revoked, and every session opened with it has ended. Sign in with the new value.
   ```

4. Sign in with the new value in each browser that was signed in with the old one.

The start goes by where a token came from, not by whose it is. So a start that changes `MAINWORTHY_OWNER` and
`MAINWORTHY_OWNER_TOKEN` together still retires the earlier value, which is the token of whoever was the owner
before; that person keeps the name and the grants, and holds one token fewer.

Three things the start does not do:

- It does not touch a token the owner made (`mainworthy token new --human <owner>`) or one an earlier start
  generated. Revoke those by id.
- It retires nothing when the value is already a token. Setting the variable back to a value that was revoked
  does not bring that token back, and the start says so. It says so too when the value is a token that has
  reached its end, with the time it ended.
- It cannot tell a token an earlier build made from the variable from one somebody labelled like it. The upgrade
  marked every token whose label starts with `owner (from ` as coming from the variable, so a token made by hand
  with such a label before the upgrade is retired with the rest. `mainworthy token list` shows the labels.

When no variable is set, the owner's token is the one a start generated. To replace it, sign in as the owner,
make another (`mainworthy token new --human <owner>`), sign in with that one and revoke the first. The server
refuses to revoke the last token the owner can sign in with.

### The upgrade to this build

On an instance at schema 2, the first start adds columns to `tokens` and `sessions`, after writing a copy
beside the database if absent (`mainworthy.db.v2.bak`). A later upgrade can remove this copy. Every token and
every session keeps working, except a token longer than 512 characters (see below). A token made before the upgrade has no
end and names no maker. Before you deploy, check that `MAINWORTHY_OWNER_TOKEN` has at least 20 characters and at
most 512: a value outside that stops the start, and the message says how to make one. The schema is brought up
to date before that check, so a start that is refused for the token's length has already migrated the database;
it has changed no actor and no token, and the next start with a good value carries on from there. A token of
more than 512 characters that an earlier build accepted is refused everywhere after the upgrade, as a bearer
and at sign-in, whether or not the variable still holds it; the server cannot tell a token's length from its
stored hash, so no start says so. Set a new value.

## People sign in as themselves

Since 2026-10-13 a person signs in with a name and a password or with a passkey, and gets there through a link
an admin hands them, because Mainworthy sends no mail (decision 0017). A token still signs a browser in, and the
owner keeps theirs. What the first start of the new build does by itself:

- It adds the tables `credentials`, `invitations` and `passkey_users` and a column to `sessions`, after writing
  a copy of the database beside it (`mainworthy.db.v<N>.bak`, `N` being the version it had).
- Tokens and sessions are untouched: nobody is signed out.

What you do once:

- **Set `MAINWORTHY_PUBLIC_URL`** to the address people open the instance at, and start it again. For the
  instance on Coolify that is `https://mainworthy.com`; `compose.coolify.yaml` passes the variable on. Without
  it nobody can register a passkey and an invitation link has no host.
- **Give yourself a password or a passkey**, if you want one beside the owner token: sign in with the token,
  open Settings, "Your sign-in", and set a password or add a passkey there. The owner token keeps working
  whatever else you sign in with, and the last one is still not revoked.

### Inviting a person

The first person is invited by the owner. Sign in on the sign-in page under "Use a token" with the owner
token, open Settings, "People", type the person's name, choose what they may do and on which project, and
press "Make invitation link". The link is shown once, with a button that copies it; hand it to the person. The
same section lists the open invitations with "Revoke" on each, and makes a recovery link for a person who
exists. An instance with no `MAINWORTHY_PUBLIC_URL` gives a link that starts with the address you opened
Settings at.

The command line does the same:

```
export MAINWORTHY_URL=https://mainworthy.example MAINWORTHY_TOKEN=<an admin's token>
mainworthy invite new robin --can read,produce,answer --project web     # prints the link once
mainworthy invite list                                                  # never shows a link
mainworthy invite revoke 3
```

- The link is `<MAINWORTHY_PUBLIC_URL>/invite#<code>`. It is printed once and only the SHA-256 of the code is
  stored, so copy it when it is printed. The code is after the `#`, which a browser does not send, so it
  reaches no proxy's log.
- It works once, for three days (`--expires 12h`, `2w`; at most `30d`). A new invitation for the same person
  replaces the one before it.
- With no `--can`, a new person may do everything, as a new person's token may. `--project` limits the grant to
  one project.
- Whoever administers and is a person invites a new person. An agent that holds `admin` invites nobody.
- The person opens the link. The page says who the invitation is for and until when it works, and the person
  chooses a password of 12 characters or more, makes a passkey, or both; that signs them in. The page takes the
  code out of the address bar as soon as it has read it, so a reload of that page has no code: open the link
  again. A browser that is signed in as somebody else is told who, and asked before that session is replaced.
- A link that was used, revoked or has run out, and one that was cut short when it was copied, all get the same
  sentence: the invitation does not work any more. Make a new one.

### A lost password or passkey

The sign-in page has no "forgot password": there is no mail to send one by. "Recovery link" beside a person in
Settings, "People", or `mainworthy invite new <name>` for a person who exists, makes a recovery link. The owner
makes one for anybody. An admin who is a person can make their own. Everybody else asks the owner: a person who
does not administer makes no invitation, and another admin's word is not enough to become somebody. The page has
the button where the server allows it and nowhere else. When the link is
accepted, every password and passkey the person had stops working and every session of theirs ends. Until then
nothing of theirs changes, so a link that is never used locks nobody out. Their tokens are not touched:
`mainworthy token revoke <id>` ends those.

A person changes their password, adds a passkey and removes one of their ways of signing in under Settings,
"Your sign-in" (the operation `credential` for a script). The last one they have stays. "Your sessions" lists
the browsers they are signed in on and ends any of them.

### What a passkey is tied to

A passkey belongs to one host name: the one in `MAINWORTHY_PUBLIC_URL` when it was registered. One made at
`https://mainworthy.com` does not sign in at another name of the same instance, such as its tailnet name;
there people use a password or a token. If you change the variable to another host name, the passkeys made
under the old one stay stored and no browser offers them: people sign in with a password and register again.

In a browser, passkeys were tried with Chromium's built-in test authenticator and nothing else
(`test/e2e/people.test.ts`, `test/e2e/passkey-verifier.test.ts`). No physical security key, no synced passkey
and neither Safari nor Firefox has been tried.

### What it costs

A password is hashed with argon2id, which takes 64 MiB and about a tenth of a second on purpose. The server
hashes two at a time and lets thirty-two wait, so leave the container 130 MiB above what it otherwise uses.

## Backup and restore

The data is `/data/mainworthy.db` (with `-wal` and `-shm` beside it while running).

- **Backup:** `mainworthy export --out /backup/mainworthy-$(date +%F).ndjson.gz` writes every fact, decision and
  document as text, from a consistent snapshot, while the server runs. Tokens, sessions, passwords, passkeys and
  invitations are not exported: an archive holds nothing that signs somebody in.
- **Restore:** start an empty instance, run `mainworthy import <file>` before creating any token, then restart the
  server. The import replaces the instance's first rows, the owner's token among them, so the token you imported
  with stops working and every browser is signed out. The restart takes the owner's token from
  `MAINWORTHY_OWNER_TOKEN`, or, when that is not set, generates one and prints it once in the log. The people
  and what they may do came with the archive; their passwords and passkeys did not. As the owner, run
  `mainworthy invite new <name>` for each person, and hand each the link. A test imports
  into an empty instance and compares every table (`src/server/transfer/transfer.test.ts`). An archive names the
  version of what it holds, which changes only when an exported table does, so one taken before an upgrade that
  added other tables still imports (`test/sessions.test.ts` imports one from the build before sessions).
- **Upgrade:** a new image runs all pending migrations in one transaction on start. A failed migration rolls
  back the entire upgrade to its starting schema and data, and removes no copies. Before changing existing
  data, the server uses `VACUUM INTO` to write a consistent copy in a new private directory beside the database.
  The copy inherits `synchronous=OFF` for this read-only source operation, avoiding SQLite's intermediate
  output syncs. The source's original setting is restored before migration writes. Its journal mode is unchanged.
  It syncs and closes that file, renames it to `mainworthy.db.v<N>.bak`, then syncs the directory. `N` is the
  version before the upgrade. Only after all migrations commit, and only if this start completed that copy
  itself, does it remove older upgrade copies and log each removed filename. At that same point it removes
  abandoned copies and journals matching the exact `<database>.v<N>.bak.<uuid>.tmp` and `.tmp-journal`
  names used by older builds. It also removes the exact copy and journal regular files inside private
  `<database>.v<N>.bak.mainworthy-copy-<six-character suffix>` workspaces, then removes a workspace only if empty.
  Unmarked directories from earlier builds remain because they cannot be distinguished from saved operator copies.
  Symlinks, non-regular entries, and unrelated contents remain. Normally one copy remains.
  If the final-name copy already exists, the server leaves it unchecked and performs no cleanup.
  Cleanup failures are logged without failing startup; extra copies remain until a later successful upgrade
  writes a new copy. A start with no pending migrations performs no cleanup.
  Only copies still present are rollback points. To go back, stop the container, put a retained copy in place
  of `mainworthy.db`, and start the image that matches that copy's schema. To preserve an older rollback point
  across further upgrades, save a separate backup before upgrading.

Nothing schedules the backup yet, and the home server's own backups do not leave the host: until that is set
up (#59), a failed disk loses the instance.

### Health while upgrading

`mainworthy serve` acquires the instance lock, opens its HTTP listener and runs the copy and migration on a
worker. During that work, `GET /healthz` returns HTTP 200 with this shape:

```json
{"ok":false,"state":"upgrading","version":"0.1.0","apiVersion":1,"commit":"0123456789012345678901234567890123456789"}
```

The commit is null when unknown, as it is after startup. Every other path and method returns HTTP 503 with
`{"ok":false,"error":{"code":"upgrading","message":"Mainworthy is upgrading; try again shortly."}}` and
`Retry-After: 5`. No application route runs before the worker has closed the upgraded database and startup
recovery has finished. The listener changes to the normal routes on the same port.

The Dockerfile's `mainworthy health` checks liveness: it exits 0 for both ready and upgrading. This lets
Compose's `service_healthy` dependency start the ingress while an upgrade runs, and the ingress's wget probe
also accepts the HTTP 200. The host hold can then pass traffic through; application requests receive 503
until ready. A migration error closes the listener and fails startup. The startup worker's watchdog stops it
after 30 minutes without observable progress: copy/database file size or modification time changes, or
bounded recovery progress messages. This is an inactivity allowance, not a total upgrade duration. A copy
that keeps progressing is allowed to finish and publish its backup. Health replies themselves do not reset
the watchdog. Docker's short start period is retained.

The parent owns a private `<database>.mainworthy-start-<six-character suffix>` copy workspace. It removes
that exact workspace after awaiting the worker on failure, cancellation or inactivity; it keeps a published
`.v<N>.bak`, which a restart reuses. A whole-process crash leaves a marked workspace for the next successful
upgrade's exact regular-file cleanup. Files not matching the copy/journal names and symlinks remain. Bootstrap,
attachment pruning, assertion reconstruction and pending-report/dispute/hand-off recovery run on the worker,
so health keeps answering during those data-dependent steps too.

Readiness is different: require HTTP 200, `ok: true` and the full expected commit. Merely receiving HTTP 200
or seeing the commit is insufficient. The image job checks both fields, and `change.yml` waits through the
upgrading state for at most 30 minutes before sending its lifecycle write. The CLI's authenticated requests
stop with an upgrading message; the iPhone client does not probe health and receives the ordinary 503 reply.
CI's instance chooser and deployment transport retry upgrading within their existing deadlines. If the
instance remains upgrading, the chooser uses its documented isolated-instance fallback with a warning.
The external TestFlight upload job also reads health; it must require `ok: true` before acting on the commit
(see `ios/README.md`). That external job is not changed or verified here.

The autodeploy scheduler and its in-flight window are outside this checkout. Its installed 45-minute allowance
for an upgrading attempt is separate from the application's inactivity watchdog. The external job must keep
the same pinned deployment in flight while its expected commit reports `upgrading`, within its own deployment
budget, including its image-build and container-replacement allowance. The application has no total-duration
cutoff while progressing. Never deploy a newer
candidate over that work. Declare success only on `ok: true` with the pinned commit, and retain and notify
on a failed deployment or expired deadline. This repository-only change does not update or verify that job.

## Without Docker

```
bun install && bun run build      # dist/mainworthy, one self-contained executable
MAINWORTHY_MODE=server MAINWORTHY_HOST=0.0.0.0 MAINWORTHY_DATA=/var/lib/mainworthy ./dist/mainworthy serve
```

## Checks a deployment must wait for

The deploy job lives outside this repository. The existing `check` workflow publishes the `gate` job through
GitHub Actions. No new status, artifact or repository credential is required here. A delay alone does not
prove the checks passed. The external job needs these reads before deploying a candidate commit:

1. Read `GET https://api.github.com/repos/endqwerty/mainworthy/git/ref/heads/main` and keep the full `object.sha`.
2. Read `GET https://api.github.com/repos/endqwerty/mainworthy/actions/workflows/check.yml/runs?event=push&branch=main&head_sha=<sha>&per_page=100`.
   Follow pagination. Select the newest run by `run_number`, without filtering for successful runs. Confirm its
   `head_sha`, `head_branch: "main"`, `event: "push"`, `status: "completed"` and `conclusion: "success"`.
   No run, a pending run, a failed run or an unreadable response means wait, never deploy.
3. Read `GET https://api.github.com/repos/endqwerty/mainworthy/actions/runs/<run-id>/attempts/<run_attempt>/jobs?per_page=100`.
   Follow pagination. Require exactly one job named `gate`, with `status: "completed"` and `conclusion: "success"`.
   A skipped or cancelled gate is not permission to deploy. Use the run's current attempt, never an older passing attempt.
4. Read `GET https://api.github.com/repos/endqwerty/mainworthy/actions/runs/<run-id>` and `main` again immediately
   before deploying. If the run's attempt or result changed,
   check it again. If the tip changed, start over with that commit and the existing settle delay.
5. After deploying the pinned commit, read `GET https://mainworthy.com/healthz`. Keep the deploy in flight
   while that commit reports `ok: false, state: "upgrading"`, within the job's separate deployment deadline.
   The server's 30-minute inactivity allowance can reset throughout an active upgrade. Require HTTP 200, `ok: true`
   and `commit` equal to the full candidate SHA. Record failure if the deploy fails or that reply does not arrive
   within the job's deployment deadline. The external job must notify the operator of that failure and retain
   the commit, workflow run URL, deployment identifier and failure reason. Recovery remains a separate task
   tracked by [issue #59](https://github.com/endqwerty/mainworthy/issues/59).

These are public GitHub reads. A token with repository Actions read permission can avoid anonymous API rate
limits. The external job chooses and stores it. It needs no write permission. GitHub documents
[workflow-run reads](https://docs.github.com/en/rest/actions/workflow-runs#list-workflow-runs-for-a-workflow) and
[jobs for a run attempt](https://docs.github.com/en/rest/actions/workflow-jobs#list-jobs-for-a-workflow-run-attempt).
A pull request's check does not replace the push check of the resulting `main` commit.

This documents the handoff for [issue #90](https://github.com/endqwerty/mainworthy/issues/90). It does not change
or verify the external deploy job, its notifications or its recovery procedure.
