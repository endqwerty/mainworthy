# Running Casebook on a server

Casebook is one process and one SQLite file. A deployment is one container with one volume; there is no
database container to run, upgrade or back up separately (decision 0010).

**What is verified:** the image builds, starts, serves the UI and the API, keeps its data across a restart, and
passes its health check on the development machine. It also runs on Daniel's Coolify (since 2026-10-12, the
steps under "On Coolify" as they were done): `/healthz` answers, a request with no token gets 401, and a browser
signed in with the owner token over plain HTTP and saved a case through the page.
**What is not:** the Tailscale sidecar in `compose.coolify.yaml` on that instance (the file passes `docker compose config`; the node has not joined yet), a restore from a backup on that instance, and an upgrade of an instance that holds data.

## The container

```
docker compose up -d --build
docker compose logs casebook | head -5      # the owner token, shown once, if you did not set one
```

Then open `http://localhost:7357` and paste the owner token.

| Variable | Default in the image | What |
| --- | --- | --- |
| `CASEBOOK_OWNER_TOKEN` | not set | The owner's token. Set it to a long random string (`openssl rand -hex 32`). If unset, one is generated on the first start and printed once in the log. |
| `CASEBOOK_OWNER` | `owner` | The owner's name, as it appears in history. Set it before the first start. |
| `CASEBOOK_DATA` | `/data` | Where `casebook.db` lives. Mount a volume here. |
| `CASEBOOK_PORT` | `7357` | The port to listen on. |
| `CASEBOOK_HOST` | `0.0.0.0` | The address to bind. |
| `CASEBOOK_READERS` | available cores minus two, minimum 1, maximum 8 | Reader threads, each with its own read-only connection, so a read does not wait for a write. A non-negative integer; `0` runs reads inline on the server thread, which is slower under load and only for debugging. |
| `CASEBOOK_MODE` | `server` | `server`: every request needs a token. `local` (the default outside a container, on loopback): the browser on the same machine is the owner with no step. |

The process runs as an unprivileged user (uid 10001). The health check is `casebook health`, which reads
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
   file. Set the token to a long random string (`openssl rand -hex 32`) and the owner to your name, before the first start.
   `TS_AUTHKEY` is a single-use Tailscale auth key (admin console → Settings → Keys), needed for the first
   deploy only; never use the sign-in link the sidecar prints, it rotates every minute.
4. **Storage:** the compose file declares the volume `casebook-data` at `/data`. Coolify creates it as a named
   volume. Bind it to a path you back up if you have one.
5. **Network:** the `tailscale` service in `compose.coolify.yaml` is its own tailnet node, `casebook`, and serves
   the app at `https://casebook.owl-perch.ts.net` (Tailscale issues the certificate; the first request can take
   a few seconds). Nothing is published on the LAN; port 7357 is bound to `127.0.0.1` on the host for debugging
   only. Anything on the tailnet can reach the name, and every request still needs a token. Casebook holds test
   evidence and tokens: keep it off the public internet until accounts exist (#30) and sign-in is rate limited
   (no issue yet). The node's identity lives in the `tailscale-state` volume: deleting it registers a new node.
   Once the node is up, disable its key expiry in the Tailscale admin console (Machines → the node), and delete
   `TS_AUTHKEY` from Coolify. For a server without Tailscale, use `compose.yaml` (publishes 7357) or give the
   service a domain in Coolify.
6. **Deploy**, then check: `curl https://casebook.owl-perch.ts.net/healthz` answers `{"ok":true,"version":"…"}`. Open the page
   and paste the owner token.

Nothing redeploys by itself. After a change lands on the branch, press Redeploy in Coolify or call its API
(`POST /api/v1/deploy?uuid=<application>`).

To have this repository report its own test results to that instance, set the repository variables
`CASEBOOK_URL` and `CASEBOOK_PROJECT` and the secret `CASEBOOK_TOKEN` (a `ci` token:
`casebook token new --ci github-actions --can read,produce`). Without them the workflow starts a throwaway
Casebook inside the job. A GitHub-hosted runner can only reach an instance with a public address; for this
tailnet-only instance use a self-hosted runner or add the Tailscale action to the workflow.

## Backup and restore

The data is `/data/casebook.db` (with `-wal` and `-shm` beside it while running).

- **Backup:** `casebook export --out /backup/casebook-$(date +%F).ndjson.gz` writes every fact, decision and
  document as text, from a consistent snapshot, while the server runs. Tokens are not exported.
- **Restore:** start an empty instance, run `casebook import <file>` before creating any token, then restart the
  server with `CASEBOOK_OWNER_TOKEN` set. The import replaces the instance's first rows, the owner's token among
  them, so the token you imported with stops working until the restart. A test imports into an empty instance
  and compares every table (`src/server/transfer/transfer.test.ts`).
- **Upgrade:** a new image migrates the database on start. Before it changes a database that holds data, it
  writes a copy beside it (`casebook.db.v<N>.bak`); to go back, stop the container, put that copy in place of
  `casebook.db`, and start the previous image.

Nothing schedules the backup yet, and the home server's own backups do not leave the host: until that is set
up (#59), a failed disk loses the instance.

## Without Docker

```
bun install && bun run build      # dist/casebook, one self-contained executable
CASEBOOK_MODE=server CASEBOOK_HOST=0.0.0.0 CASEBOOK_DATA=/var/lib/casebook ./dist/casebook serve
```
