# Move Mainworthy from GCP to Render

This is a fresh deployment. There are zero users and zero customer data as of 2026-10-28. Uptime is unnecessary.
Create a new empty PostgreSQL database on Render. Delete the dedicated GCP application projects without a database
or attachment backup. There is no restore, credential continuity or data-migration requirement.

## Prepare in parallel

- Shut down the old GCP projects. Render does not need to be running first.
- Prepare Render with `infra/render.yaml`. Validate the Blueprint and review its paid resources before creating them.
- Keep review layers draft and run one combined stack check against `main` before landing. See
  [test costs](development/tests.md#estimate-the-recurring-ci-cost) and [stack landing](landing-a-stack.md).
- Keep GitCafe as a candidate source host. Compare its account-wide storage and outbound usage with the reduced
  CI plan before paying for a larger plan or moving the forge.

## Retire GCP now

Disable the GitHub `infra.yml` workflow before project shutdown, and cancel any queued or running infrastructure
runs. Verify the workflow reports `disabled_manually`. This prevents subsequent pushes from recreating resources.

The administrator has requested deletion of the dedicated preview and production projects, then the seed project.

The seed project goes last because it holds the existing Terraform backend and deployment identities. No state or
audit-history export is required for this disposable environment. Check each project reaches `DELETE_REQUESTED`.
Delayed usage charges can appear after shutdown.

Retire the dedicated Google billing account, Cloud Identity tenant and organization too. Close billing before
deleting the Google admin identity. The domain and mail routing are on Cloudflare and remain available for Render.
Remove obsolete Google application address and verification records from Cloudflare. Keep the Git source and
published GHCR image, which already exist outside GCP.

The documented agent Google account is read-only. The administrator performs project shutdown in Cloud Shell.

## Set up on Free first

Use `infra/render-free.yaml` for the initial disposable environment. Both resources are Free, and there is no
persistent application disk or payment-method requirement for this workspace. The app sleeps after 15 idle minutes;
its local attachments disappear on restart or redeploy. The free database expires after 30 days. These limits are
acceptable for initial setup with zero users and customer data. Upgrade before relying on retained records or files.

The app is initially available at `https://mainworthy-render.onrender.com`. Use the custom domain through Cloudflare
when the proxy proof below is configured; the direct Render URL then serves only health checks without that proof.
Generate the job key with `openssl rand -base64 32`, which produces canonical base64 for exactly 32 bytes.

## Upgrade to durable paid services later

`infra/render.yaml` defines one Starter image service, PostgreSQL 18 on the 256 MB plan, a 5 GB database disk and a 2 GB
application disk. The planning estimate is about $15/month before excess traffic, builds, backup egress or taxes.
Recheck [current pricing](https://render.com/pricing) before creating paid resources. The small database tier needs
an actual schema-initialization and workload check. Increase it only after reviewing the resulting recurring cost.

The image is pinned to the published digest for commit `3cfa7c4d748001e4ee25a0c27c06e8d9609db610`, verified in GHCR
on 2026-10-28. The application runner is enabled because Google Cloud Scheduler will be removed. The database uses
a direct connection, with no transaction pooler. Public database access is disabled. The application connects over Render's private network.

Before using the Blueprint:

1. Validate it against [Render's current specification](https://render.com/docs/blueprint-spec) and with
   `render blueprints validate infra/render.yaml` or the validation API. Local schema validation alone does not
   prove the account supports a plan, region or PostgreSQL version.
2. Generate a new job key and owner token securely. Set the public URL to the actual Render URL during verification.
3. Provide a registry credential when the GHCR package becomes private. Keep deployed image digests available in
   GHCR so Render can recover after a restart. Moving the source repository to private does not automatically
   establish the package's access settings.
4. Check that the service user can write the mounted `/data`. Let the application initialize the new database.
5. Verify `unaccent`, migrations, new records and attachments. Configure OIDC and its callback URL only if needed
   for the new deployment.
6. Generate a new `MAINWORTHY_PROXY_SECRET` of at least 32 characters. Configure a Cloudflare request-header
   transform scoped to the custom domain that overwrites `x-mainworthy-proxy` with this value. Set the matching
   Render variable and `MAINWORTHY_CLIENT_ADDRESS_HEADER=cf-connecting-ip`. Cloudflare supplies the client address;
   the app reads it only after checking the proxy proof. Keep the value in private settings, never in this file.
   Verify that requests to the direct Render URL without the proof receive 403, including requests with a forged
   client-address header. `GET /health` remains available for Render's health checks.
7. Check `/health` reports the pinned commit, sign-in, read/write operations, attachments and background processing.
   Then attach `mainworthy.com` and update DNS.

The mounted disk requires a single service instance and allows deployment downtime. Database and file backups need
one consistent recovery point. Backup uploads count toward source egress even when customer traffic is zero.

## Scaling past Render

Attachments stay on the Render disk. The owner, 2026-10-29: "let's stay with the render simple disk, but keep
cloudflare as a scaling option in mind." Upgrade before the Free database expires on 2026-11-28.

When one instance or the disk no longer fits, look at Cloudflare first, since it already serves the domain:

1. R2 for attachments, as a second `BlobStore` in `src/server/kernel/blobs.ts`. Bun's built-in S3 client works with
   it, so no package is added. This removes the disk, and with it the single instance and the downtime on deploy.
2. Cloudflare Containers for the published image. PostgreSQL stays with a PostgreSQL host, reached through
   Hyperdrive; Cloudflare's own database, D1, is SQLite. Workers alone would mean rewriting the Bun server.

[Containers pricing](https://developers.cloudflare.com/containers/platform/pricing/), read 2026-10-29: Workers Paid at
$5 a month, then memory and disk for every running second and CPU for active use. One `basic` instance (1/4 vCPU,
1 GiB) running all month comes to about $13–14 with the plan, most of it memory. `lite` (1/16 vCPU, 256 MiB) is about
$8 but likely too small. That excludes PostgreSQL. A container that sleeps starts from a fresh disk, so attachments
must be in R2 first, and while asleep it runs no jobs, so Mainworthy would stay awake (a long `sleepAfter`).

This is a direction, not a plan. Recheck the products and their prices when the time comes.

## Send traces

Tracing is off until the service has an OTLP endpoint
([configuration](guide/configuration.md#send-traces-to-an-opentelemetry-collector)). To send to Sentry's free plan:

1. Create a Sentry project. In its settings, **Client Keys (DSN)**, copy the OTLP endpoint and the `x-sentry-auth`
   header value. The endpoint Sentry shows ends in `/integration/otlp`; the traces endpoint adds `/v1/traces`:
   `https://o<org id>.ingest.<region>.sentry.io/api/<project id>/integration/otlp/v1/traces`. Without an OTLP panel,
   build both from the DSN, `https://<public key>@o<org id>.ingest.<region>.sentry.io/<project id>`.
2. In the Render service's environment, set `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` to the traces endpoint, ending in
   `/v1/traces`; Mainworthy sends to it as written. Set `OTEL_EXPORTER_OTLP_TRACES_HEADERS` to
   `x-sentry-auth=sentry sentry_key=<public key>`, without quotes. Keep both in Render's private settings, never in
   this file. Optionally add `OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=production`. Sentry answered
   `200 {}` to one OTLP JSON span sent with these settings on 2026-10-29.
3. After the restart, the log says `traces go to https://o<id>.ingest.<region>.sentry.io`. Open the site, then find
   the request's trace in Sentry's trace explorer; its `service.version` is the deployed commit.
4. Add Sentry to the processors in [the privacy policy](guide/privacy.md) before `mainworthy.com` sends to it.

A failing collector does not affect requests. The log says once that sending failed.

## Release less often

Use tested immutable image digests for manual or nightly releases. Image-backed Render services do not deploy
when a tag is repushed. A release must select one commit, complete its required checks, publish the tested artifact,
trigger Render explicitly, and verify the resulting commit. Skip a night when there is no new approved revision.
The scheduling change belongs with its workflow and verification evidence, not only in this document.

## Current implementation state

Both Free resources have been created, and the application reports the pinned commit at `/health` on Render.
GCP projects are pending deletion and the dedicated billing account is closed. Google DNS records and the old
proxy rule have been removed from Cloudflare. Custom-domain routing and the new Render proxy proof are being
verified. This environment starts with a new empty database; only disposable deployment smoke records are added.
