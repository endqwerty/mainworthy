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
| `MAINWORTHY_OWNER_TOKEN` | not set | The owner's token. Set it to a long random string (`openssl rand -hex 32`). A value shorter than 20 characters or longer than 512 stops the start, in local mode too; one shorter than 32 starts, and every start warns. If unset, one is generated and printed once in the log whenever the owner holds no token that works: on the first start, on the start after an import, and on the start after the owner's last token expired. A value that is not yet a token replaces the old one: the start revokes every token that came from this variable and still works, whoever was the owner when it was set, and names them in one line ("Replacing a token" below). A value that is already a token replaces nothing. When that token was revoked, has reached its end or is somebody else's, it is not brought back: the start says which in one line on stderr, and the owner signs in again once the variable has a new value. |
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

## The limit on failed sign-ins

A wrong token is counted where the server asks who the caller is: on a route that needs a sign-in, whether a
script or a pipeline sends it, and when a person types it into the sign-in form. A route that needs no sign-in
(`/healthz`, the API description, the documentation at `/docs`) looks at no token, and a sign-in body the form
does not accept (longer than 512 characters, or not text) is refused without being counted. A wrong token is
counted twice: against the address it came from, and against its own first 8 characters. The fifth failure of
either within 15 minutes blocks it for one second, and each failure after that doubles the block, up to 15
minutes.
While a block lasts, a request is answered `429` with the seconds to wait in `Retry-After`. The CLI prints
`limited: too many failed attempts; try again in 4 seconds` and exits 4, and the sign-in form says how long to
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

**The instance at `mainworthy.com` does not set the two variables yet**, and `compose.coolify.yaml` does not
pass them. Its requests come through Cloudflare's tunnel, then Coolify's proxy, then the container. Nobody has
measured what the container sees on that path. The values expected to be right, both unverified:

- `MAINWORTHY_CLIENT_ADDRESS_HEADER=cf-connecting-ip`. Cloudflare writes the visitor's address there and
  replaces what the visitor sent. Not checked: that Coolify's proxy passes the header on unchanged, and that no
  request reaches that proxy without going through Cloudflare. One that does could write the header itself.
- `MAINWORTHY_TRUSTED_PROXY` set to the address of Coolify's proxy on the network it shares with the container,
  or that network's range. Not read from the server yet.

Until both are measured and set, with the check in step 3 done from two networks, that instance counts a wrong
token against its first 8 characters and not against an address.

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
   a few seconds). Nothing is published on the LAN; port 7357 is bound to `127.0.0.1` on the host for debugging
   only. Anything on the tailnet can reach the name, and every request still needs a token. The node's identity
   lives in the `tailscale-state` volume: deleting it registers a new node.
   Once the node is up, disable its key expiry in the Tailscale admin console (Machines → the node), and delete
   `TS_AUTHKEY` from Coolify. For a server without Tailscale, use `compose.yaml` (publishes 7357) or give the
   service a domain in Coolify.
6. **Deploy**, then check: `curl https://mainworthy.example.ts.net/healthz` answers `{"ok":true,"version":"…","commit":"…"}`, and `commit` is the commit Coolify
   built (it comes from `SOURCE_COMMIT`; `compose.coolify.yaml` needs no line for it: naming the variable there would
   make Coolify list it as one of yours, and an empty value of yours replaces the one it generates). Compare it with
   the tip of `main` (`git ls-remote origin refs/heads/main`) to see whether the instance is behind. Open the page
   and paste the owner token.
7. **The public address** (since 2026-10-13): `https://mainworthy.com` serves this instance, before accounts
   exist (#30). The owner decided that for the MVP: it is theirs to dogfood, its database will be wiped before
   1.0, and they can cut it off at any time. Every request still needs a token, and wrong tokens are limited
   ("The limit on failed sign-ins"; on this instance not yet by address). The path is the one the server's other public
   apps use: a proxied Cloudflare record for the name, a route in the server's Cloudflare tunnel, Coolify's
   proxy, and a domain on the service in Coolify (`https://mainworthy.com:7357` on the service `mainworthy`, with
   "connect to the predefined network" on and Coolify's own HTTPS redirect off). Two things differ from an
   ordinary app behind that proxy:
   - **The tunnel route goes to the proxy's HTTPS port** (`https://localhost:443`, certificate not verified,
     server name `mainworthy.com`), not to port 80. Mainworthy accepts a browser's sign-in only when the proxy
     says the page was served over https (`X-Forwarded-Proto`), and Coolify's proxy replaces that header with
     its own: `http` on port 80, `https` on port 443. Measured on the server: the same sign-in request answers
     401 through port 80 and 200 through port 443.
   - **Cloudflare's "Always Use HTTPS" is on** for the zone, so nobody sends a token over plain HTTP.
   - **Cloudflare's automatic Web Analytics is to be turned off** for the zone. With it on, Cloudflare writes a
     script tag for `static.cloudflareinsights.com` into every HTML page it passes on. The page's
     Content-Security-Policy allows scripts from the server's own origin only, so the browser refuses that
     script and logs one refusal for each page (seen on the instance on 2026-10-13, in the app and in the
     documentation). Nothing is broken by it, and the product promises no analytics (`docs/compliance.md`); the
     setting is in the Cloudflare dashboard under Web Analytics for the site.

   To take the instance off the internet, delete the DNS record for the name or its route in the tunnel. A
   firewall rule for incoming connections does not do it: the tunnel is a connection the server opens outward.

This setup alone does not enable automatic deployment. To deploy manually, press Redeploy in Coolify or call
its API (`POST /api/v1/deploy?uuid=<application>`). The owner's instance uses an external deploy job; its
required check reads are under "Checks a deployment must wait for" below.

The project `demo` on this instance is seeded again on every start (`MAINWORTHY_DEMO=demo` in
`compose.coolify.yaml`), so each deploy leaves the demo of the code it runs. The start logs
`demo "demo" seeded again in <n> s: 2000 cases, 65 questions`, or a line that says why it was not. What anyone
changed in `demo` is gone after the next deploy; keep work in another project.

The reset holds the write gate on a worker thread. `/healthz` and ordinary reads keep answering, with reads seeing the
old committed demo until the reset commits. Removal, recreation, the demo mark, and retained grants share one
transaction. A stop before commit preserves the old demo and grants; a stop afterwards leaves the empty demo
and grants for the next start to fill. Writes, including administration lists and sign-in, wait for that
transaction, then proceed alongside the seed's API requests. After ten minutes the reset requests its worker
to stop. It stops only between SQLite statements: a running statement must finish before rollback releases
waiting writes. The seed gets a fresh fifteen-minute token after removal, which is revoked when seeding ends.
A graceful stop during reset skips that token. If seeding has begun, the stop waits for the seed to finish
and its token cleanup before closing the database.

Step timings go to stderr, for example `[mainworthy] demo "demo": delete results took 12.3 ms`. The log names
the provenance check, grant capture, table discovery, every table count and delete, foreign-key check,
recreation with grants, the reset transaction, and the seed. The worker disables per-row foreign-key enforcement
before its reset transaction and checks all foreign keys before commit. A violation rolls the whole reset back.
Migration 25 removes indexes needed only for removal, so reports no longer maintain them.
It changes no archive data or version.
[Decision 0087](decisions/0087-responsive-demo-refresh.md) records the tradeoff.

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
   with none (decision 0021), its reports add those cases; `mainworthy` tracks such tests and makes none.

   On the Coolify instance the commands ran inside the container, which already holds the owner token, so that
   token was copied nowhere: `docker exec <container> sh -c 'MAINWORTHY_TOKEN="$MAINWORTHY_OWNER_TOKEN" mainworthy …'`.
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

- **A failing test is a question on the instance.** The gate is `blocked` and the job exits 2. The job's log
  names the question ("Q-70 needs an answer"). Either a later commit passes the test, and its run is green, or a
  person answers the question in the queue (`g q`). After an answer, re-run the `gate` job alone: the shards'
  reports are artifacts of the run, kept for seven days. The pipeline's token cannot answer, and under `standard`
  an agent's answer is advice.
- **A newer attempt of a shard replaces the older one.** When the test passes in it, the gate passes and the
  question leaves the queue with no answer. Seen on this instance on 2026-10-13: `main` at `89d431a` was blocked
  by a browser test that fails now and then (#94), and green after a re-run of shard `tests-4`. GitHub's "Re-run
  failed jobs" re-runs only `gate`, because a shard with a failing test ends as a success and leaves the verdict
  to the gate. Re-run the shard's own job (`gh run rerun <run> --job <id>`): `gate` runs again after it and reads
  the other shards' reports from the earlier attempt. A test that fails now and then is still a defect to fix,
  not to retry (`AGENTS.md`).
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
- **A pull request that is merged or closed tells the instance** (`.github/workflows/change.yml`, decision
  0022, since 2026-10-13). A failure nobody explained on it is then no longer asked about. Before this, such a
  question stayed in the queue until a person answered it: the one about pull request 150 outlived its merge.
  For a pull request that ended earlier, or whose event was missed: `gh workflow run change.yml -f pull=150
  -f state=merged`. The workflow checks the instance's API version first. While the first build with API
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
  `docker compose` would have used the default. Change a stored variable to the new value; do not empty it.
- **The sidecar does not rename a node by itself.** Its `tailscale up` refuses a hostname that differs from
  the one in `tailscale-state`, and the sidecar restarts in a loop. Stop the sidecar, run
  `tailscale set --hostname=<new name>` in a one-off `tailscaled` on the same state volume, and start it
  again. The node keeps its identity and its address.

## The upgrade to sessions

Until 2026-10-13 a browser's cookie held the token itself, for a year. A build from that day on gives the
browser a session instead (decision 0017). What the first start of the new build does by itself:

- It adds the table `sessions` to the database, after writing a copy of the database beside it
  (`mainworthy.db.v1.bak`).
- Tokens are untouched. The owner token, a pipeline's `MAINWORTHY_TOKEN` and an agent's token work as before.
- An archive exported by the earlier build still imports.

What you do once:

- **Sign in again**, in every browser. The upgrade signs every browser out: the old cookie, `mainworthy_session`,
  is no longer read. Paste the owner token as on the first day. That sign-in also removes the old cookie from
  the browser, so the token does not stay there.

Nothing else changes for a browser. Drafts and run notes are kept by the page, not by the cookie.

To go back, stop the container, put `mainworthy.db.v1.bak` in place of `mainworthy.db` and start the previous
image. Sessions made since are gone with the table, and each browser signs in once more.

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

The first start adds columns to `tokens` and `sessions`, after writing a copy of the database beside it
(`mainworthy.db.v2.bak`). Every token and every session keeps working, except a token longer than 512 characters (see below). A token made before the upgrade has no
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
- **Upgrade:** a new image migrates the database on start. Before it changes a database that holds data, it
  writes a copy beside it (`mainworthy.db.v<N>.bak`); to go back, stop the container, put that copy in place of
  `mainworthy.db`, and start the previous image.

Nothing schedules the backup yet, and the home server's own backups do not leave the host: until that is set
up (#59), a failed disk loses the instance.

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
5. After deploying the pinned commit, read `GET https://mainworthy.com/healthz`. Require HTTP 200, `ok: true`
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
