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
**What is not:** the Tailscale sidecar in `compose.coolify.yaml` on that instance (`docker compose config` accepts the file once Coolify's own `exclude_from_hc` line is removed; the node has not joined yet), a restore from a backup on that instance, and an upgrade that changes the schema of an instance that holds data.

## The container

```
docker compose up -d --build
docker compose logs mainworthy | head -5      # the owner token, shown once, if you did not set one
```

Then open `http://localhost:7357` and paste the owner token.

| Variable | Default in the image | What |
| --- | --- | --- |
| `MAINWORTHY_OWNER_TOKEN` | not set | The owner's token. Set it to a long random string (`openssl rand -hex 32`). If unset, one is generated on the first start and printed once in the log. |
| `MAINWORTHY_OWNER` | `owner` | The owner's name, as it appears in history. Set it before the first start. |
| `MAINWORTHY_DATA` | `/data` | Where `mainworthy.db` lives. Mount a volume here. |
| `MAINWORTHY_PORT` | `7357` | The port to listen on. |
| `MAINWORTHY_HOST` | `0.0.0.0` | The address to bind. |
| `MAINWORTHY_READERS` | available cores minus two, minimum 1, maximum 8 | Reader threads, each with its own read-only connection, so a read does not wait for a write. A non-negative integer; `0` runs reads inline on the server thread, which is slower under load and only for debugging. |
| `MAINWORTHY_MODE` | `server` | `server`: every request needs a token. `local` (the default outside a container, on loopback): the browser on the same machine is the owner with no step. |

The process runs as an unprivileged user (uid 10001). The health check is `mainworthy health`, which reads
`/healthz`.

## On Coolify

How the instance on the home server was set up. It takes about five minutes through Coolify's API or its
dashboard.

1. **A deploy key.** The repository is private. Add a read-only deploy key to it on GitHub and give Coolify the
   private half (Security → Private Keys).
2. **New resource → Docker Compose**, from this repository with that key: compose file `/compose.coolify.yaml`
   (the instance's own file, with the Tailscale sidecar; `/compose.yaml` is the plain one), the branch to follow
   (`main`).
3. **Environment:** Coolify reads `CASEBOOK_OWNER_TOKEN`, `CASEBOOK_OWNER` and `TS_AUTHKEY` from the compose
   file (the first two keep the names this instance was created with; the file passes them to the container as
   `MAINWORTHY_OWNER_TOKEN` and `MAINWORTHY_OWNER`). Set the token to a long random string (`openssl rand -hex 32`) and the owner to your name, before the first start.
   `TS_AUTHKEY` is a single-use Tailscale auth key (admin console → Settings → Keys), needed for the first
   deploy only; never use the sign-in link the sidecar prints, it rotates every minute.
4. **Storage:** the compose file declares the volume `casebook-data` at `/data`. Coolify creates it as a named
   volume. Bind it to a path you back up if you have one.
5. **Network:** the `tailscale` service in `compose.coolify.yaml` is its own tailnet node, `casebook`, and serves
   the app at `https://casebook.owl-perch.ts.net` (Tailscale issues the certificate; the first request can take
   a few seconds). Nothing is published on the LAN; port 7357 is bound to `127.0.0.1` on the host for debugging
   only. Anything on the tailnet can reach the name, and every request still needs a token. The node's identity
   lives in the `tailscale-state` volume: deleting it registers a new node.
   Once the node is up, disable its key expiry in the Tailscale admin console (Machines → the node), and delete
   `TS_AUTHKEY` from Coolify. For a server without Tailscale, use `compose.yaml` (publishes 7357) or give the
   service a domain in Coolify.
6. **Deploy**, then check: `curl https://casebook.owl-perch.ts.net/healthz` answers `{"ok":true,"version":"…"}`. Open the page
   and paste the owner token.
7. **The public address** (since 2026-10-13): `https://mainworthy.com` serves this instance. Earlier this page
   said to keep it off the public internet until accounts exist (#30) and sign-in is rate limited (#88). The
   owner decided otherwise for the MVP: it is theirs to dogfood, its database will be wiped before 1.0, and they
   can cut it off at any time. Every request still needs a token. The path is the one the server's other public
   apps use: a proxied Cloudflare record for the name, a route in the server's Cloudflare tunnel, Coolify's
   proxy, and a domain on the service in Coolify (`https://mainworthy.com:7357` on the service `casebook`, with
   "connect to the predefined network" on and Coolify's own HTTPS redirect off). Two things differ from an
   ordinary app behind that proxy:
   - **The tunnel route goes to the proxy's HTTPS port** (`https://localhost:443`, certificate not verified,
     server name `mainworthy.com`), not to port 80. Mainworthy accepts a browser's sign-in only when the proxy
     says the page was served over https (`X-Forwarded-Proto`), and Coolify's proxy replaces that header with
     its own: `http` on port 80, `https` on port 443. Measured on the server: the same sign-in request answers
     401 through port 80 and 200 through port 443.
   - **Cloudflare's "Always Use HTTPS" is on** for the zone, so nobody sends a token over plain HTTP.

   To take the instance off the internet, delete the DNS record for the name or its route in the tunnel. A
   firewall rule for incoming connections does not do it: the tunnel is a connection the server opens outward.

Nothing redeploys by itself. After a change lands on the branch, press Redeploy in Coolify or call its API
(`POST /api/v1/deploy?uuid=<application>`).

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

   That token records results on `mainworthy` and reads its gate. It cannot read or change the suite, answer a
   question, plan a run or administer, under any policy.

   On the Coolify instance the commands ran inside the container, which already holds the owner token, so that
   token was copied nowhere: `docker exec <container> sh -c 'MAINWORTHY_TOKEN="$MAINWORTHY_OWNER_TOKEN" mainworthy …'`.
   The new token went from that command's output into `gh secret set MAINWORTHY_TOKEN` and was never printed.
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
- **A test file with no case is one `map` question** under `standard`. The first two runs left 70 of them in the
  queue. They do not block the gate.
- **A push to `main` reports too**, as the workflow runs on it.

What can go wrong, and what the job does: the instance is down (its own Mainworthy, a warning); the instance is an
older or newer build that describes `report` or `gate` differently (the same); the token was revoked or is for
another project (the job fails and says which). To stop reporting to the instance, delete the `MAINWORTHY_URL`
variable. A pull request that changes the shape of a `report` or `gate` reply fails against the instance until it
is redeployed (#90): delete the variable for that pull request. To replace the token (not tried on this instance):
`mainworthy token list`, `mainworthy token revoke <id>`, issue a new one as above and set the secret again.

The token is visible to the code of every pull request, because the `gate` job runs it. That code can report
wrong results for this one project; it cannot do anything else with the token. Until backups exist (#59) the
instance's history is one disk.

### An instance with no public address

Not tried from a GitHub runner. Before 2026-10-13 this instance was reachable on its tailnet only
(`https://casebook.owl-perch.ts.net`), and the `gate` job can join a tailnet for its own length.

1. **In the GitHub repository**, `MAINWORTHY_URL` is the tailnet address.
2. **In the Tailscale admin console** (an agent cannot do these):
   1. *Access controls.* Add the tag: `"tagOwners": { "tag:ci": ["autogroup:admin"] }`. Then **replace** the rule
      that lets everything reach everything; a narrow rule added beside it restricts nothing. On 2026-10-12 the
      tailnet had exactly that one rule (read from a member node's packet filter). With `"hosts": { "mainworthy":
      "100.75.70.124" }`:

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
  `MAINWORTHY_TOKEN`, `MAINWORTHY_PROJECT`) and on a server. The old names are not read. `compose.coolify.yaml`
  is the exception: it still reads `CASEBOOK_OWNER_TOKEN` and `CASEBOOK_OWNER` from Coolify.
- **`compose.yaml`:** its volume is now `mainworthy-data`. If you started it before the rename, the data is in
  `casebook-data`; copy it across before the first start, or the instance starts empty:
  `docker run --rm -v <project>_casebook-data:/from -v <project>_mainworthy-data:/to alpine cp -a /from/. /to/`.

The instance on Coolify keeps four names from before the rename, so that a redeploy finds the same data, tailnet
node and variables. Each can be moved by hand, and none has to be:

| Name | Where | To move it |
| --- | --- | --- |
| `casebook` (tailnet node, `https://casebook.owl-perch.ts.net`) | `TS_HOSTNAME` in `compose.coolify.yaml` | Set `TS_HOSTNAME=mainworthy` in Coolify and redeploy. The address changes; the node's identity does not. |
| `casebook-data` (volume) | `compose.coolify.yaml` | Stop the app, copy the volume to a new one as above, change the name in the file. |
| `CASEBOOK_OWNER_TOKEN`, `CASEBOOK_OWNER` | Coolify's variables | Add the variables under the new names, change the two lines in the file, delete the old ones. |
| `casebook` (service) | `compose.coolify.yaml` | Rename it together with the proxy address in the `tailscale-serve` config. |

## Backup and restore

The data is `/data/mainworthy.db` (with `-wal` and `-shm` beside it while running).

- **Backup:** `mainworthy export --out /backup/mainworthy-$(date +%F).ndjson.gz` writes every fact, decision and
  document as text, from a consistent snapshot, while the server runs. Tokens are not exported.
- **Restore:** start an empty instance, run `mainworthy import <file>` before creating any token, then restart the
  server with `MAINWORTHY_OWNER_TOKEN` set. The import replaces the instance's first rows, the owner's token among
  them, so the token you imported with stops working until the restart. A test imports into an empty instance
  and compares every table (`src/server/transfer/transfer.test.ts`).
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
