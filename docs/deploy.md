# Running Casebook on a server

Casebook is one process and one SQLite file. A deployment is one container with one volume; there is no
database container to run, upgrade or back up separately (decision 0010).

**What is verified:** the image builds, starts, serves the UI and the API, keeps its data across a restart, and
passes its health check, all on the development machine (see the pull request for the commands and output).
**What is not:** a deployment on Coolify itself. Nothing has been deployed to the home server; the steps below
follow Coolify's Docker Compose build pack and are yours to run.

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

1. **New resource → Docker Compose**, from this repository (it is private: use the GitHub App or a deploy key),
   compose file `compose.yaml`, branch `main`.
2. **Environment:** set `CASEBOOK_OWNER_TOKEN` (mark it as a secret) and `CASEBOOK_OWNER`.
3. **Storage:** the compose file declares the volume `casebook-data` at `/data`. Leave it as a named volume, or
   bind it to a path you back up.
4. **Network:** either give the service a domain (Coolify's proxy terminates TLS and forwards to port 7357), or
   keep it off the public internet and reach it over the tailnet with a Tailscale sidecar, the way the other
   tailnet-only app on that host is set up. Casebook holds test evidence and tokens: prefer the tailnet until
   accounts and sign-in rate limiting exist (#30).
5. **Health check:** path `/healthz`, port 7357. The image also declares its own.
6. Deploy. Read the log for the owner token if you did not set one.

To have this repository report its own test results to that instance, set the repository variables
`CASEBOOK_URL` and `CASEBOOK_PROJECT` and the secret `CASEBOOK_TOKEN` (a `ci` token:
`casebook token new --ci github-actions --can read,produce`). Without them the workflow starts a throwaway
Casebook inside the job. A GitHub-hosted runner can only reach an instance with a public address; for a
tailnet-only instance use a self-hosted runner or add the Tailscale action to the workflow.

## Backup and restore

The data is `/data/casebook.db` (with `-wal` and `-shm` beside it while running).

- **Backup:** `casebook export --out /backup/casebook-$(date +%F).ndjson.gz` writes every fact, decision and
  document as text, from a consistent snapshot, while the server runs. Tokens are not exported.
- **Restore:** start an empty instance and run `casebook import <file>`. A test does exactly this and compares
  every table (`src/server/transfer/transfer.test.ts`).
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
