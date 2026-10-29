# Running Mainworthy on a server

The project-specific GCP projects are pending deletion as of 2026-10-28, and the dedicated billing account is
closed. There are zero users and zero customer data to migrate. The old Google DNS and proxy rule have been
removed from Cloudflare. Use [the fresh Render deployment runbook](render-migration.md) for the replacement.
The GCP sections below describe the retired setup.

Mainworthy runs as one app process connected to PostgreSQL 18. The app volume holds attachment bytes and
archive staging; PostgreSQL has its own volume. `compose.yaml` runs both. Running elsewhere is possible but
not yet supported, as amended in [decision 0026](decisions/0026-the-apps-offer-one-instance.md).

## Google Cloud

Mainworthy runs as one Cloud Run service, `mainworthy` in `us-west1`, on one Cloud SQL database, defined by the
[Terraform in `infra/`](../infra/) and applied only by CI ([the decision](decisions/2026-10-26-one-service-released-by-the-apply.md);
[the costs](cloud-costs.md)). It does not serve `mainworthy.com` until the cutover below.

### What the owner sets up once

1. The private foundation, applied in Cloud Shell: projects, organisation policies, the app's state bucket, the two
   runtime accounts (`app`, `jobs`), and two CI identities federated from GitHub, a writer for `infra.yml`'s push runs
   and a read-only planner for its manual runs. No pull request can sign in.
2. These Actions repository secrets (placeholders shown; no identifier belongs in this repository), under
   **Settings > Secrets and variables > Actions > Repository secrets**:

   | Secret | Example or source |
   | --- | --- |
   | `GCP_PRODUCTION_PROJECT` | `example-production` |
   | `GCP_PREVIEW_PROJECT` | `example-preview` (its network is kept for previews, #894) |
   | `GCP_ATTACHMENTS_BUCKET` | `example-attachments` |
   | `GCP_TERRAFORM_STATE_BUCKET` | `example-app-tfstate`, the foundation's app state bucket |
   | `GCP_WORKLOAD_IDENTITY_PROVIDER` | the foundation's complete provider name |
   | `GCP_INFRA_DEPLOY_ACCOUNT` | the foundation's writer; push only |
   | `GCP_INFRA_PLAN_ACCOUNT` | the foundation's reader; manual dispatch only |

3. Three secret values, in Cloud Shell, since no CI identity may add one:

   ```sh
   p=example-production   # the production project
   openssl rand -base64 32 | tr -d '\n' | gcloud secrets versions add mainworthy-job-key --project="$p" --data-file=-
   openssl rand -base64 48 | tr -d '\n/+=' | gcloud secrets versions add mainworthy-owner-token --project="$p" --data-file=-
   openssl rand -base64 48 | tr -d '\n/+=' | gcloud secrets versions add mainworthy-proxy-secret --project="$p" --data-file=-
   ```

   The job key encrypts private job inputs (replacing it makes queued ones unreadable). The owner token signs the
   owner in on first start; read it with `gcloud secrets versions access latest --secret=mainworthy-owner-token
   --project="$p"`. The proxy secret goes into Cloudflare at the cutover. `mainworthy-database-password` stays empty:
   the app signs in to PostgreSQL through IAM.

### Every push to main releases

`check.yml` builds the image once, tests it and, after its gate, publishes it to GHCR under the commit's tag.
`infra.yml` runs on every push to `main`: before signing in it waits up to 40 minutes for that tag (`ci.sh digest`,
anonymous, since the image is public), then plans and applies with the digest as `app_digest`. The registry
`mainworthy` is a remote repository of `https://ghcr.io`, so Cloud Run runs that exact digest. A new image makes a new
revision; Cloud Run moves traffic to it once its startup probe gets `/health` ready (the database answers and the
migrations are done; until then it answers 503), and keeps traffic on the previous revision if it never does. The
writer refuses a plan whose commit is no longer main's tip, so a late older push never replaces a newer release, and
a commit whose gate failed has no image and is not released. Releases and other changes share one concurrency group
and the state lock.

Rollback is a revert on `main`, which releases the previous commit's image. In an emergency the owner can move
traffic in Cloud Shell (`gcloud run services update-traffic mainworthy --to-revisions=<revision>=100 --region=us-west1
--project=example-production`); the next apply moves all traffic to its own revision again (the service declares 100% to the latest), so pause merging until the fix is on `main`. Releases do not run the previous
release's smoke checks against the new schema: before 1.0 nothing is compatible (`AGENTS.md`).

A manual run of **infrastructure** on `main` is the drift check: the reader plans `main`'s tip with its published
digest, with `-lock=false -detailed-exitcode`. Exit 0 is no change, 2 is drift (the job fails and names the
resources), 1 an error.

Public logs show the image digest, the plan and apply counts, `No changes.`, one line per planned change (action,
resource address and the names of changed attributes, never values) and redacted error headers. Terraform output,
plans and full diagnostics stay in a private directory under `RUNNER_TEMP`, deleted on exit; the secrets reach the
called workflow as reusable-workflow secrets, which Actions masks. Locally, an author runs only `terraform fmt`,
`init -backend=false` and `validate` (with `TF_DATA_DIR` outside the checkout), `bash infra/ci.test.sh` for CI's
command order and failure paths, and no Google login. `check.yml`'s static job runs the same before a merge.

### The service

- One minimum and one maximum instance, 1 vCPU and 512 MiB, request-based billing, with the Cloud SQL Auth Proxy
  beside it (IAM sign-in, private IP) and the attachment bucket mounted at `/data/blobs` with metadata caching off.
- Background work: Cloud Scheduler posts `{"do":"tick"}` to the service's `/api/job` every minute, signed with a
  Google token as the `jobs` account. The app checks that token's audience and account and runs the due jobs inside
  the request; it runs no timer of its own (`MAINWORTHY_JOB_RUNNER=0`).
- The owner: `MAINWORTHY_OWNER` comes from the repository variable of that name, so the repository does not hold
  the owner's name. An apply without it fails: the server would name the owner `owner` and, on every start, give a
  person of that name every capability, making them if nobody has the name. Set it to the owner's name exactly as it
  is on the instance; a name nobody has makes a new person who holds every capability.
- Cloudflare's proof: the organisation forbids `allUsers`, so the invoker check is off and the app refuses every
  request without `x-mainworthy-proxy` set to the proxy secret, except `/health` and the token-checked `/api/job`.
  Only requests with it are read for `cf-connecting-ip`.
- Database privileges: the app's IAM user is a member of `cloudsqlsuperuser`, which owns the `mainworthy` database,
  and every session starts as that role, so tables have one owner.
- Query Insights is on for the database, without client addresses: Cloud SQL's console shows each statement's time
  split into lock, I/O and execution, kept seven days, and Cloud Monitoring's `insights/*` metrics carry the same.
- Slow work is logged. PostgreSQL logs a statement over one second and a lock wait over one second, naming the
  sessions holding it, without bound values (`cloudsql.googleapis.com/postgres.log`). The app logs a write over five
  seconds as `[mainworthy] slow write: <op> in <project> took … ms: … ms waiting for a connection, … ms holding it`.
- Connections: a deploy runs two revisions, each with up to 2 read, 2 write, 1 job, 2 admission, 1 `LISTEN` and 1
  migration connection: 18, plus an operator's session, under `db-f1-micro`'s 25.

### The cutover

`mainworthy.com` reaches the service through a Cloud Run domain mapping (`infra/app.tf`): Google's front end answers
for the domain with a Google-managed certificate, and Cloudflare proxies to it, so requests arrive with
`Host: mainworthy.com` and Cloudflare's own `CF-Connecting-IP`. Domain mappings are in preview ("not production-ready",
for latency); the load balancer in #945 replaces it once outside users arrive.

1. The owner, once: adds CI's deploy account as an **Owner** of `mainworthy.com` in Search Console (Google requires
   the account that creates a mapping to own the domain), and creates a Cloudflare Transform Rule, "Modify Request
   Header", on requests whose host is `mainworthy.com` (`http.host eq "mainworthy.com"`), that sets `x-mainworthy-proxy` to the proxy secret
   (`gcloud secrets versions access latest --secret=mainworthy-proxy-secret --project="$p"`). Cloudflare overwrites
   both that header and `CF-Connecting-IP`, whatever a client sent.
2. The apply creates the mapping. Its status lists the DNS records Google expects.
3. In Cloudflare, `mainworthy.com`'s records become those records with the proxy off (DNS only), so Google can issue
   the certificate ("usually about 15 minutes but can take up to 24 hours"). Until it does, the site answers 403:
   requests skip Cloudflare and carry no proof. Then the proxy goes back on, with SSL/TLS set to Full (strict).
   Google renews the certificate through Cloudflare, and its page says Cloudflare's "Always Use HTTPS" must be off,
   or Cloudflare would redirect the renewal's plain-HTTP check. So that setting is off, and a redirect rule sends every
   other `http://mainworthy.com` request to `https://`, leaving paths under `/.well-known/acme-challenge/` alone.
4. Check that `https://mainworthy.com/health` names the commit, that direct requests to the `run.app` address and to
   Google's addresses for `mainworthy.com` without the proof are refused. Then the Coolify instance and its autodeploy go.

Rollback, before anything is written to the new instance, is restoring the previous DNS records.

Cloud Run's front end answers `/healthz` itself with Google's 404, so the health path is `/health`, which needs no
proof: it says only the version and the commit. The bucket mount's two-instance checks (#946) wait for a second
instance or for attachments in use.

## PostgreSQL cutover at merge

Merging this engine change makes the owner's instance restart on an empty PostgreSQL database.
The configured demo fills that database on startup. Existing projects, identities, tokens and sessions
from SQLite do not carry over. This reset is the owner's choice when merging the pull request.
There is no automatic SQLite-file conversion. Archive imports still require matching format and schema.

`compose.coolify.yaml` adds an interim PostgreSQL 18 service, reachable only on an internal database network,
with a separate named `mainworthy-postgres` volume. Its password is `SERVICE_PASSWORD_POSTGRES`, which Coolify
generates on the first deploy (32 letters and digits), stores, and reuses on every redeploy; it is listed under
the resource's environment variables. The app receives its database URL from Compose and waits for database health. The URL names the database `mainworthy-database`, an alias only the internal network knows: Coolify also puts every service on its shared `coolify` network under its service name, and there Coolify's own database is `postgres` too.
The existing `mainworthy-data:/data` mount stays exactly where it is. The SQLite file remains on that volume,
untouched; the app uses it for neither reads nor writes.

Before accepting any new work, undo the cutover by redeploying the previous commit. That build reads the
retained SQLite file again. Once the new database has accepted writes, the two stores have different histories;
this rollback does not preserve the new PostgreSQL writes. The automatic demo seed itself writes only the new
PostgreSQL database. Stop traffic during the decision window and do not delete either volume.

The Docker jobs cannot be run on the implementation Mac because Docker is not installed. Their PostgreSQL
networking, image startup and lockdown probes require the first CI/container run. Prior SQLite deployment
checks are historical evidence, not verification of this cutover.

## Images published by CI

On each push to `main`, `check.yml` builds the image once with a GitHub Actions layer cache (`type=gha`).
The `image` job loads it locally and checks readiness, the full commit from `/health`, and the packaged
documentation. After `gate` succeeds, also when it passes in the automatic rerun of a test failing by chance,
`publish` downloads that same tested image and pushes it to `ghcr.io/endqwerty/mainworthy`. It never rebuilds it. Pull requests never log in to GHCR or publish images.
Only `publish` has `packages: write`, using `GITHUB_TOKEN`; no additional secret is needed.

The image carries `LICENSE`, `NOTICE` and `THIRD-PARTY-NOTICES.md` in `/usr/share/doc/mainworthy/`. The executable inside
it includes the Bun runtime, parts of which are under the LGPL and the MPL; [licences/SOURCE.md](../licences/SOURCE.md)
says where their source is, how to link a changed library again, and the written offer `NOTICE` repeats.

The tags are:

- `<full-sha>`: the full 40-character commit, for example `ghcr.io/endqwerty/mainworthy:0123456789012345678901234567890123456789`.
  Once published, this workflow leaves the tag unchanged. A rerun with the same registry manifest digest reuses it;
  a different digest fails with `Refusing to overwrite` before changing the commit tag or `main`.
- `main`: the latest published commit that was still the tip of `main` when publishing. An older run or rerun
  publishes its commit tag but skips `main` if the branch has advanced.
- `build-<run-id>-<run-attempt>`: a staging tag for the tested archive. The publisher pushes it to learn the actual
  registry manifest digest, then compares the commit tag before promoting that digest. Staging tags remain after
  successful or failed attempts and are not deployment targets.

The image embeds `MAINWORTHY_COMMIT`, so `/health` reports the image's full SHA without a runtime override.
Its OCI labels name the source repository (`org.opencontainers.image.source`), commit
(`org.opencontainers.image.revision`), and the commit's committer timestamp (`org.opencontainers.image.created`,
from `git log -1 --format=%cI`). The timestamp stays the same on reruns. This removes wall-clock label drift;
other build inputs can still change the digest, in which case the commit-tag guard refuses replacement.
An inspection error other than a missing commit tag also fails the job without changing the commit tag or `main`.

The publisher promotes the inspected manifest by digest and records `ghcr.io/endqwerty/mainworthy@sha256:<digest>`
in the workflow run summary. Future deployments must use that digest reference; a commit tag or `main` is an alias.

Production still builds on the owner's server through Coolify, using `build: .` in `compose.coolify.yaml`.
Publishing an image changes no deployment trigger or production configuration. Switching production to a
published image belongs to [issue #821](https://github.com/endqwerty/mainworthy/issues/821), step 5.
The future check that the server builds nothing does not apply to production yet.

### Update pinned actions

Every action in the `image` and `publish` jobs uses a full 40-character commit SHA, with its release version in
an adjacent comment. The artifact actions in the other jobs use the same pins. Pinning the rest of the workflows,
and automated pin updates, is [issue #853](https://github.com/endqwerty/mainworthy/issues/853).

To update a pin, review the action's release notes and changes since the pinned commit. Resolve the exact release
with `gh api repos/<owner>/<repo>/git/ref/tags/<version> --jq .object`. If its type is `tag`, resolve that SHA with
`gh api repos/<owner>/<repo>/git/tags/<sha> --jq .object`, repeating until the type is `commit`. Replace the action
SHA and its `# vN.N.N` comment together, including other occurrences of the same action. Run
`bun test test/check.test.ts` and `actionlint .github/workflows/check.yml` before accepting the update.

### Make the package public once

After the first successful publish, the owner must open the `mainworthy` package on GitHub, open **Package
settings**, and change its visibility to **Public** under **Danger Zone**. The public repository does not make
the package public automatically. This is a one-time manual setting the owner must make; an agent cannot
perform it. Until then, anonymous pulls fail. GitHub documents
[package visibility settings](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility).

### Check the first push after merge

1. Confirm `image` builds once, passes its health and documentation smoke checks, and uploads `mainworthy-image`.
2. Confirm `publish` starts only after a successful `gate`, loads the archive without building, and pushes the
   staging tag before creating or reusing the full-SHA tag and updating `main`. If `main` advanced during the run,
   expect no `main` update. Confirm the summary records the published digest reference.
3. After making the package public, pull the summary's digest reference without registry credentials. Inspect its
   OCI labels and run it without a commit environment override. Require HTTP 200, `ok: true`, and `commit` equal to that SHA
   from `/health`. Check that both tags resolve to the same digest when the commit is still `main`.
4. Confirm Coolify still builds from source on its existing schedule. After that deployment, the public
   `/health` must report the deployed commit. This checks the existing deploy path, not deployment of the GHCR image.

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
| `MAINWORTHY_OWNER_WAS` | not set | To rename the owner: the name the owner has now, with the new name in `MAINWORTHY_OWNER`. The start renames that person, who keeps their tokens, linked identities, sessions and history, and says so in one line. Unset it afterwards. A former name that is nobody's, an agent's, a pipeline's, a forgotten person's or that of a person who does not hold every capability on every project stops the start, and so does a new name that is not one a person can be given. The guide has the steps: `docs/guide/configuration.md`, "Rename the owner". |
| `MAINWORTHY_DATA` | `/data` | Local attachments and archive staging. Keep the existing volume mounted here. |
| `MAINWORTHY_JOB_KEY` | not set | Base64 of exactly 32 random bytes. Generate once with `openssl rand -base64 32` and keep outside PostgreSQL. Every instance must use the same key for private jobs. Missing refuses private enqueue; invalid stops startup. |
| `MAINWORTHY_DATABASE_URL` | required | PostgreSQL 18 URL; Compose points it at the database service. |
| `MAINWORTHY_PORT` | `7357` | The port to listen on. |
| `MAINWORTHY_HOST` | `0.0.0.0` | The address to bind. |
| `MAINWORTHY_DB_POOL` / `MAINWORTHY_DB_WRITE_POOL` | `2` / `1` | PostgreSQL read and write pool sizes, each from 1 to 64. Writes remain exclusive for the whole operation. |
| `MAINWORTHY_SESSION_IDLE` | `14d` | How long a browser stays signed in without being used. A whole number and `h`, `d` or `w`: `12h`, `14d`, `2w`. A value that is not one stops the start with a line that names the variable. |
| `MAINWORTHY_SESSION_MAX` | `90d` | How long a browser stays signed in at most, however much it is used. Same form. The session cookie is given this age. |
| `MAINWORTHY_TRUSTED_PROXY` | not set | The addresses the proxy in front connects from: addresses and ranges, separated by commas (`10.0.1.0/24, 2001:db8::/32, 203.0.113.9`). Requires `MAINWORTHY_CLIENT_ADDRESS_HEADER` and cannot be set with `MAINWORTHY_PROXY_SECRET`. A missing header name or malformed address or range stops startup. See "The limit on failed sign-ins". |
| `MAINWORTHY_PROXY_SECRET` | not set | The secret the proxy overwrites `x-mainworthy-proxy` with on every request, at least 32 characters. Requires `MAINWORTHY_CLIENT_ADDRESS_HEADER`. All requests without matching proof receive JSON 403 except `GET /health`. See the Cloud Run cutover section above. |
| `MAINWORTHY_CLIENT_ADDRESS_HEADER` | not set | The header in which that proxy writes the address of the visitor, for example `cf-connecting-ip`. It is read only after the proxy is proved by its configured connecting address or secret, and must hold exactly one address. |
| `MAINWORTHY_PUBLIC_URL` | not set | The address people open the instance at, as they type it: `https://mainworthy.example`. The identity provider sends people back to it, at `/signin/oidc`, and an invitation link starts with it. Write https, or `http://localhost:<port>` on a developer's machine. Plain http anywhere else stops the start with a line that names the variable. So does a path or a query, because the server wants the root address of the instance. Required with an identity provider, and so for any invitation: without a provider the instance makes none. The server never takes this address from a request's `Host`. |
| `MAINWORTHY_OIDC_ISSUER`, `_CLIENT_ID`, `_CLIENT_SECRET`, `_NAME` | not set | The OpenID Connect identity provider people sign in through: its issuer address (`https://accounts.google.com` for Google), the client id and secret it gave this instance, and the name on the sign-in button. All four or none, with `MAINWORTHY_PUBLIC_URL`; a partial set or an issuer that is not https stops the start. Not set: only the owner signs in, with the owner token, and `mainworthy invite` refuses. "People sign in as themselves" below. |
| `MAINWORTHY_MODE` | `server` | `server`: every request needs a token. `local` (the default outside a container, on loopback): the browser on the same machine is the owner with no step. Local mode is for that machine only. The server checks what it can see: the connection comes from a loopback address, the `Host` is a loopback name, and the request carries none of the headers a proxy or a tunnel adds; a request that fails one of these needs a token. It cannot see through a relay that passes bytes on unchanged from this machine (`ssh -L`, `socat`, a port forward that adds no header): through one, anyone who reaches the relay is the owner. Never expose a local-mode port that way. To reach an instance from elsewhere, run it in `server` mode. |
| `MAINWORTHY_DEMO` | not set | A marked demo refreshed once per known deployed revision, after the server listens. `MAINWORTHY_COMMIT` or Coolify's `SOURCE_COMMIT` identifies the revision. A same-revision restart preserves edits and renews featured work. A new revision swaps a fresh project into the same key and moves personal and team grants atomically, then seeds it in the server's own process. Retired data drains in bounded transactions. See "Demo deployment and cleanup" below. `compose.coolify.yaml` defaults to `demo`; set it empty for none. |
| `MAINWORTHY_COMMIT` | empty | The commit the build was made from, which `/health` reports as `commit` with no sign-in. Exactly 40 lower-case hexadecimal characters, else it counts as not set; the server then reads `SOURCE_COMMIT` (Coolify sets it on the running container), and reports `null` when neither holds a commit. The image takes it as a build argument: `MAINWORTHY_COMMIT=$(git rev-parse HEAD) docker compose build`, or `docker build --build-arg MAINWORTHY_COMMIT=$(git rev-parse HEAD) .`. Without it a plain build reports `null`. |

A container waiting for the data-directory lock ignores `docker stop` until Docker sends SIGKILL after its default 10 seconds, which is harmless with Compose's stop-then-create replacement.

Private jobs store authenticated ciphertext using AES-256-GCM, a random nonce per enqueue, and the job id and kind as associated data. `compose.coolify.yaml` uses `${SERVICE_REALBASE64_32_JOBKEY}` so Coolify generates and retains a key without an operator choosing one. Coolify's `SERVICE_BASE64_64` values are alphanumeric, not base64-encoded bytes; use the [documented REALBASE64 generator](https://coolify.io/docs/services/configuration/docker-compose). Plain `compose.yaml` reads `MAINWORTHY_JOB_KEY` from the environment or `.env`, like the database password override. Generate it once with `openssl rand -base64 32` and preserve it across restarts. Never commit the key or put it in a database backup.

A missing key refuses private enqueue, while instances without private work can start. To rotate, first drain private jobs, then replace the key on every instance together. Retain the old key separately for backups containing pending jobs. Under a different key, queued jobs fail authentication, record a generic decryption error naming the setting, and send nothing on that attempt. Restoring the old key before bounded retries exhaust recovers the job. Jobs never fall back to plaintext, including private rows from an older build. Completed or exhausted jobs erase the encrypted input.

The process runs as an unprivileged user (uid 10001). The health check is `mainworthy health`, which reads
`/health`.

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
(`/health`, the API description, the documentation at `/docs`) looks at no token, and a sign-in body the form
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
- A person's sign-in is counted in the same count. Mainworthy has no password to guess: a person signs in at
  the identity provider, which runs its own limits. A provider's answer that is refused and an invitation code
  that accepts nothing are counted against the address alone, and a right invitation code still works from a
  blocked address.
- The count is in PostgreSQL, shared by every instance on the database. A restart does not clear it.

Anonymous provider sign-in starts have a separate allowance of 300 successful starts per public IPv4 address
or IPv6 /56 per minute. There is no instance-wide refusal for another source to monopolise. Starts never add
to failed-attempt counts. A refused start gets `429` with remaining seconds in
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
leave it off, so webhooks, OIDC and other integrations keep working there.
Lockdown permits the configured PostgreSQL TCP endpoint and blocks other new outbound connections, including those integrations. Do not enable it
on a deployment that needs them.

The image entrypoint installs `scripts/container/lockdown.nft` in the app's network namespace.
Before installing rules, it resolves the address and port from `MAINWORTHY_DATABASE_URL`. It pins the runtime
URL to that numeric address and adds rules for only that TCP endpoint, so the app needs no later DNS query.
It atomically replaces only its own table and compares the installed rules with the rendered policy. IPv4 and IPv6 share a default-drop output chain. It permits loopback except Docker's
embedded DNS at `127.0.0.11`, and established or related replies to inbound traffic. Apart from the configured database address and port, new connections to another container,
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
4. **Storage:** retain `mainworthy-data` at `/data`. PostgreSQL gets the separate `mainworthy-postgres` volume
   at `/var/lib/postgresql`. Back up PostgreSQL and attachments together. Coolify generates the database password
   (`SERVICE_PASSWORD_POSTGRES`) on the first deployment; nothing needs setting.
5. **Network:** the `tailscale` service in `compose.coolify.yaml` is its own tailnet node, `mainworthy`, and serves
   the app at `https://mainworthy.example.ts.net` (Tailscale issues the certificate; the first request can take
   a few seconds). Nothing is published on the LAN; ingress port 758 is bound to `127.0.0.1` for the hold
   in front of the host's tunnel. Anything on the tailnet can reach the name, and every request still needs a token. The node's identity
   lives in the `tailscale-state` volume: deleting it registers a new node.
   Once the node is up, disable its key expiry in the Tailscale admin console (Machines → the node), and delete
   `TS_AUTHKEY` from Coolify. For a server without Tailscale, use `compose.yaml` (publishes 7357) or give the
   ordinary non-lockdown service a domain in Coolify.
6. **Deploy**, then check: `curl https://mainworthy.example.ts.net/health` answers `{"ok":true,"version":"…","commit":"…"}`, and `commit` is the commit Coolify
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

### Demo deployment and cleanup

`compose.coolify.yaml` keeps `MAINWORTHY_DEMO=demo` by default. Coolify supplies the deployed image's full
`SOURCE_COMMIT`, or the image's `MAINWORTHY_COMMIT` takes precedence. No separate host, service, database or
operator action is needed. The demo remains at `/p/demo`, with the same people and personal and team grants.
Set the variable empty to stop refresh and renewal. With no known commit, refresh is refused and existing demo
work is left alone. A project without a demo mark is refused untouched, including old unmarked seeds.

The demo mark records either an in-progress seed with its revision and pinned size, a completed seed with its
revision and featured slot, or a retired project. A completed same-revision restart does no seed or swap. It
renews featured work immediately, then every twelve hours. For a new revision, one gate transaction renames the
old project to an internal retired key, creates and marks a fresh project at `demo`, and moves current personal
and team grants across. Readers see committed data; subsequent requests may see the fresh demo partly filled.
The seed is the ordinary one (`mainworthy seed`), with the same operations, and it bounds case proposals and report
shards and dates history from the new demo mark. It runs in the server's process: its client hands each request to
the operation registry as the owner, as a person on this machine in local mode is, so no token is made for it and
no request leaves the process. Nothing is sent to the address `MAINWORTHY_HOST` names, and
`MAINWORTHY_PROXY_SECRET`, which every request from outside must prove, has nothing to check. The pipeline's and
reviewer's tokens the seed makes are admitted in the same process and revoked when it ends. Its command ids include
the project identity, so it cannot replay the retired project's commands, and every write it makes names the
identity of the project the swap chose (`projectIdentity`), its administrative ones too (marking the demo, the
pipeline's and reviewer's grants and tokens), each checked in the write's own transaction. A refresh that lost its
lock while another revision replaced the demo has its next write refused, so it changes nothing in the new demo or
in who may use it, stops, and marks nothing ready. A seed interrupted after the swap
resumes that same marked project, time and command ids on the next start. Any earlier retirement drain finishes
before that resumed seed runs, keeping the two heavy stages from overlapping.
Only marked demo data is disposable. Changes someone made in the demo are replaced on the next deployed revision.
That is intended, not a defect to guard against. The owner, 2026-10-27: "Demo edits can be lost, it's meant to be
a generated demo that the dev can play with without worry. In fact, edits should be lost on redeploy. If changes
are needed to be kept, the demo seed would be updated." So the demo's state is never a reason for a stopping
server to wait.

Retired projects have no project-specific grants and are hidden from the project list. Instance-wide grants,
including the owner's, still allow reads by the retired key until cleanup deletes the data, but no writes: from the
transaction that retires it, every write that names the project is refused (`<key> is a retired demo being removed,
and takes no more writes`), whatever surface sends it, including reports, proposals, work, and the grants and tokens
on it. A report accepted just before the retirement is not finished, and the background recovery leaves it too.
Cleanup runs on start and after refresh, including when MAINWORTHY_DEMO is unset. It deletes at most 32 owned
rows per gate turn and transaction,
with foreign keys enforced, then yields to foreground work. A final transaction deletes the mark and project
together. An interrupted drain continues from remaining rows. A failed slice rolls back and logs the failure;
its retired mark remains for retry. A new swap first drains earlier retirements, so the heavy stages do not
overlap; a drain that fails there is logged and the swap goes ahead, so the new revision still gets its demo, and
the retired project waits for the next start's drain. Drains take the oldest retired project first, so one that
fails every time also holds back the ones retired after it. That is bounded: while two retired projects wait, a
new revision retires no third. Its refresh stops before the swap with the warning `mainworthy: demo "demo" is not ready for
this revision: 2 retired demos are still waiting for cleanup, so the demo keeps its earlier revision until
cleanup removes one`, and the demo stays as it was, edits included. Each later start retries the drain and,
once fewer than two wait, the swap. A retired project another instance removed first counts as removed. Normal
completion retains no retired project. PostgreSQL reuses deleted storage through its ordinary maintenance; cleanup does not promise immediate disk shrinkage.
Whole-instance exports are refused with a retry message while retired marks remain, because those marks do not
travel in an archive. Active-project exports remain available.

A slice reads only the retired project's own rows, by index, so what it costs follows the size of the retired demo,
not of the other projects on the instance (#914). A drain reads the schema once and skips the tables it has already
emptied. Since a retired demo takes no writes, a table the drain has emptied stays empty, and nothing reads it
again: the last slice deletes the mark and the project row and reads no table. (Before, it read every table again
from its first row, past the index entries of every row the drain had removed: one transaction that grew with the
whole demo.) If a row appears anyway, the project row's foreign keys refuse its deletion, that slice rolls back, and
the next drain, which starts its reading afresh, removes the row. A table owned through its parents (a
result's excuses, a run's slots, a slot's lease through its slot and run) is read under one batch of 256 of its own
parents at a time. The drain keeps its place at every level of the chain from slice to slice, reading each level in
index order (the top one by `(project, id)`, a lower one by `(parent column, id)`), and a slice that finds a batch
empty moves at most one row on at a level above. So a slice reads a bounded number of rows however many runs, slots,
cases or results the demo has. Before, each slice gathered every one of the demo's parent ids again (for a lease,
every slot of the batch's runs), which made the drain's work grow with the square of their number.

A table whose rows refer to other rows of the same table (`folders.parent`, `decisions.supersedes`,
`questions.prior`, `results.corrects`) first has those references set to null for the retired demo's rows, 256 rows a
slice in `(project, id)` order, and is then deleted 32 rows a slice from batches of 256 read in the same order. A row another row referred to
could only go after that one, so a chain of folders (someone with `produce` on the demo can make thousands with
`propose`) let one row go per slice, each slice reading the whole chain to find it: 50 million rows and index entries
read for a chain of 5,000. Now each row is read a fixed number of times. A table with an index in (owner, `id`)
order is walked down to its own rows the same way, so a slice reads past the rows it removed at most once.

What a slice still reads beyond its batch: the foreign-key checks PostgreSQL makes when it deletes a row, which pass
the index entries of the rows that referred to it. A row many others referred to (one report's batch) costs that
many, once. The last slice's checks pass the removed rows of any table the drain deleted through another index; on a
test demo of 4,000 rows of each kind, that slice read 691 rows and index entries, against 21,950 before.
Slices use index scans and never sort or use bitmap scans, so a slice's `LIMIT` stops the scan. On a copy with 20 seeded projects (1.06
million results) and one retired default demo (102,304 rows, 28,000 of them results), the drain took 140 s before
this, with a median slice of 35 ms, a longest of 289 ms, and plans that read up to 490,000 rows of other projects to
find none; after it, 46 s, a median of 2.2 ms and a longest of 27 ms.

Migration 6 adds the indexes the drain reads by: one each on `search_docs`,
`slot_results` and `team_events`, and one on `(project, id)` for each table a slice reads in batches (`batches`,
`cases`, `changes`, `decisions`, `folders`, `merge_receipt_nodes`, `questions`, `requirements` and `runs`), and one on `slots`
`(run, id)` for leases, read through their slots. An upgrade builds them one at a time with `CREATE INDEX
CONCURRENTLY`, outside a transaction, so an older instance still serving during the rollout keeps writing to those
tables while they are built. Each index that finishes stays built: a start that Cloud Run's startup probe cuts off
resumes with the next one, and an index left invalid by a build cut off midway is dropped and built again. The schema
ledger moves to 6 only when every index is valid. An instance waiting to migrate asks for the migration lock every
200 ms rather than waiting in one statement, because a concurrent build waits for every older snapshot, that waiting
statement's included. A build also waits for transactions already open, up to the 120 s each may last. A new database
builds them in its first transaction, while its tables are empty. The build time follows the tables' row count:
about 0.15 s per index for a million rows on a desktop, and the instance's tables hold far fewer.

No whole-database audit or worker retry runs under the demo gate. Each swap and deletion slice is checked against
a 500 ms acceptance ceiling, alongside successful unrelated HTTP reads, writes and token sign-ins on a populated
local database. Half a second is an interactive ceiling, not an infrastructure latency guarantee. Logs identify
a cleanup slice exceeding 100 ms. PostgreSQL indexes and foreign-key checks still cost time, including shared CPU
and disk contention; the rehearsal evidence belongs in the pull request.

Each swap and cleanup slice holds the identity lock and the locks of the projects it changes for its one short
transaction. The swap's transaction also decides: under the demo key's transaction lock it reads the demo's mark,
and if the demo is already ready for this revision it keeps it, edits included, and the refresh ends there; if it is
seeding this revision, the refresh resumes that seed. Only otherwise does it retire the demo. Since that check
and the swap commit together, no refresh replaces a demo another instance finished for the same revision.

A whole refresh also runs under a PostgreSQL session lock named for the demo (`Database.exclusive`), which every
instance on the database takes: during a rollout with two instances the second waits, then finds the first's
finished seed and does not seed again. The lock ends with its connection: when an instance dies mid-seed, the
next start resumes the marked seed. It also ends when only that connection is lost, and the refresh holding it
carries on without knowing. Two instances may then seed the same project at once, which the seed's command ids
make harmless, and whichever finishes second finds the demo ready and keeps it. So the lock saves seeding twice;
the swap's check is what keeps the demo. Moving refresh and drain to the durable job interface remains open
(#821); several instances do not need it. Scheduled requests must replace the renewal timer when CPU is
allocated only during requests.

A stopping server waits for its demo work only briefly. On SIGTERM or SIGINT, `serve` aborts the refresh, the drain
and the renewal of the demo's featured work: the wait for the refresh lock ends, an unfinished seed sends no further
request, and each transaction stops at its next statement and rolls back. An aborted transaction
never commits, even when the code that ran in it caught the abort, and the stopped operation is not logged as a
failure. A renewal that fails for any other reason logs `demo work renewal failed` with the reason. The seed's
pipeline and reviewer tokens expire by themselves within the hour if the stop prevents their revocation. What the
refresh or drain left unfinished resumes on the next start.

A statement already sent is not cancelled: one waiting for another writer's lock, in the drain, the renewal or a
seed write, waits on. So `serve` gives the whole stop seven
seconds, inside the ten Cloud Run allows before SIGKILL. At seven seconds it prints `mainworthy: stopping took
longer than 7 s; exiting with <what> still running`, naming the step it was on (the demo refresh, demo work
renewal, retired demo cleanup or the server's own shutdown), and exits with code 4. Write connections set
PostgreSQL's `client_connection_check_interval` to one second, so a statement still waiting for a lock when the
process exits notices the closed connection within about a second and rolls back its transaction, releasing the
locks it held, rather than holding them until it gets its lock.

This supersedes the reset-in-place implementation described in decision 0087; its incoming-reference indexes
remain useful to enforced transfer removal and cleanup. The PostgreSQL baseline includes only local operational demo state,
which is excluded from archives and does not change their format.

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
  has ten seconds, with ten seconds between attempts. A 230-second retry window starts with the first failing
  request, including that attempt. Commands waiting through the same outage share what remains; a successful
  response resets the window so a later outage gets its full budget within the nine-minute job. A 4xx or other
  definite refusal returns immediately. A lasting outage still fails the job. A retry sends the same report body, whose batch key
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
  (decision 0090). For a change to prose or another workflow, one shard named `tests` reports the
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
  answers `/health` without `apiVersion`. The workflow warns and sends the lifecycle request without the
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

The upgrade sections below are historical instructions for SQLite builds. They do not apply to PostgreSQL.
The current cutover starts an empty database and leaves the SQLite file and its old backups untouched.

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

A person signs in through the instance's OpenID Connect identity provider, and only that way (decision
2026-10-27, "People sign in through an identity provider"). Mainworthy keeps no password, passkey or second
factor and sends no mail: the provider owns those, and account recovery too. A token still signs a browser in,
and the owner keeps theirs: it is the first way in, and on an instance with no provider the only person is the
owner, signed in with it. Agents and pipelines use tokens as before.

### Set up the provider

1. Register a web application with the provider. Its redirect address is `<MAINWORTHY_PUBLIC_URL>/signin/oidc`,
   for example `https://mainworthy.example/signin/oidc`. Scopes: `openid`, `email` and `profile`.
2. Set `MAINWORTHY_OIDC_ISSUER`, `MAINWORTHY_OIDC_CLIENT_ID`, `MAINWORTHY_OIDC_CLIENT_SECRET`,
   `MAINWORTHY_OIDC_NAME` and `MAINWORTHY_PUBLIC_URL`, and start the instance again. Keep the client secret in
   the secret environment; it goes to the provider and nowhere else.
3. Sign in on the sign-in page under "Use a token" with the owner token, open Settings, "Your sign-in", and link
   your identity at the provider. Linking the first identity needs no proof.

For Google: Google Cloud console, Google Auth Platform, Clients, create a client of type Web application, with
the redirect address above under "Authorised redirect URIs"; the issuer is `https://accounts.google.com`. The
guide has the rest: `docs/guide/configuration.md`, "Sign in through an identity provider".

`mainworthy.com` will use Google accounts once the owner has created its OAuth client. Until then nobody but the
owner signs in there, with the owner token. On the Coolify file, `MAINWORTHY_LOCKDOWN=1` blocks the server from
reaching any provider, so only the owner token signs in there either way.

### Inviting a person

The owner invites the first person. Sign in with a token or through the provider, open Settings, "People", type
the person's name, choose what they may do and on which project, and press "Make invitation link". The link is
shown once, with a button that copies it; hand it to the person. The same section lists the open invitations
with "Revoke" on each, and makes a recovery link for a person who exists. Making one from a browser needs recent
proof: a session opened with a token has it for ten minutes after sign-in, and a provider session gets it with
"Confirm with" and the provider's name. An instance with no provider makes no invitation.

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
  presses "Accept with" and the provider's name and signs in there; the identity they sign in with becomes
  theirs. The page takes the code out of the address bar as soon as it has read it, so a reload of that page has
  no code: open the link again. A browser that is signed in as somebody else is told who, and asked before that
  session is replaced.
- A link that was used, revoked or has run out, and one that was cut short when it was copied, all get the same
  sentence: the invitation does not work any more. Make a new one.

### A lost identity

There is nothing to reset here: a person who cannot sign in at the provider recovers that account there.
"Recovery link" beside a person in Settings, "People", or `mainworthy invite new <name>` for a person who exists,
makes a recovery link for a person who needs another identity. The owner makes one for anybody. An admin who is a
person can make their own. Everybody else asks the owner: a person who does not administer makes no invitation,
and another admin's word is not enough to become somebody. The page has the button where the server allows it
and nowhere else. When the link is accepted, through the provider, the identity used becomes the person's only
one, every token of theirs is revoked and every session of theirs ends. Until then nothing of theirs changes, so
a link that is never used locks nobody out.

A person links and unlinks identities under Settings, "Your sign-in" (the operation `credential` lists and
removes them for a script). The last one they have stays. "Your sessions" lists the browsers they are signed in
on and ends any of them.

An identity is the provider's issuer and its subject for the person. Changing `MAINWORTHY_OIDC_ISSUER` leaves
every identity linked at the old issuer unused: the owner signs in with the owner token, links again, and makes a
recovery link for everybody else.

### Upgrading to provider-only sign-in

The first start of the build that made the provider the only way in deletes stored passwords, passkeys,
authenticators, recovery codes, recovery email addresses and queued mail (migration 8); there is no path to keep
them. A browser signed in with one of those is signed out. Tokens, linked identities and sessions opened with them
stay. What you do once:

- Remove `MAINWORTHY_SMTP_HOST`, `_PORT`, `_TLS`, `_USER`, `_PASSWORD`, `MAINWORTHY_MAIL_FROM`,
  `MAINWORTHY_REQUIRE_ADMIN_MFA` and `MAINWORTHY_OIDC_MFA` from the environment: nothing reads them.
- Set up the provider, sign in with the owner token and link your identity (above).
- Make a recovery link for each person who signed in with a password or a passkey. They accept it at the provider.
- Archives exported before the upgrade (formats 43 and 44) are refused on import: export again after it.

## Backup and restore

PostgreSQL holds the records, including identities and credentials. `/data/blobs` holds attachment bytes.
Archive exports include attachment bytes and exclude sign-in secrets.

- `mainworthy export --out backup.ndjson.gz` writes a consistent archive while the app runs. Test it by
  importing into a fresh PostgreSQL database with a matching app version. Restart after import and issue new
  tokens or invitations, since sign-in secrets are not exported.
- To retain sign-in secrets too, stop the app, dump PostgreSQL with `pg_dump` and copy its matching `blobs/`.
  Restore with PostgreSQL tools into an isolated PostgreSQL 18 database before trusting the backup.
  Copying `/data` alone does not back up the database; copying a running PostgreSQL data directory is unsafe.
- Mainworthy creates no automatic upgrade copy. Keep a tested backup before changing the image or schema.
  The PostgreSQL conversion does not read or migrate the SQLite file. Archive imports must match format and schema.

Nothing schedules these backups yet. Keep tested backups outside the server.

### Health while upgrading

`mainworthy serve` opens its startup listener before applying the PostgreSQL baseline and recovery.
`GET /health` returns HTTP 503 with `ok: false, state: "upgrading"` and `Retry-After: 5` until startup
finishes, so a probe that reads only the status, such as Cloud Run's startup probe, does not call the revision
ready. `mainworthy health` reads the body and exits 0 during that state; it proves liveness, not readiness.
Other routes answer 503 with `Retry-After: 5`. Startup failure closes the listener.

The deployer must require `ok: true` and its pinned commit before declaring success. Do not replace a
candidate while its startup is still in progress. The external deployment scheduler and its deadline are
outside this repository; this change does not verify them.

## Without Docker

```
bun install && bun run build      # dist/mainworthy, one self-contained executable
MAINWORTHY_DATABASE_URL=postgres://mainworthy:password@127.0.0.1:5432/mainworthy \
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
5. After deploying the pinned commit, read `GET https://mainworthy.com/health`. Keep the deploy in flight
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
