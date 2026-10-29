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

In an administrator Cloud Shell session, delete the dedicated projects in this order:

```sh
gcloud projects delete mainworthy-preview
gcloud projects delete mainworthy-prod
gcloud projects delete mainworthy-seed
```

The seed project goes last because it holds the existing Terraform backend and deployment identities. No state or
audit-history export is required for this disposable environment. Check each project reaches `DELETE_REQUESTED`.
Delayed usage charges can appear after shutdown.

Retire the dedicated Google billing account, Cloud Identity tenant and organization too. Close billing before
deleting the Google admin identity. The domain and mail routing are on Cloudflare and remain available for Render.
Remove obsolete Google application address and verification records from Cloudflare. Keep the Git source and
published GHCR image, which already exist outside GCP.

The documented agent Google account is read-only. The administrator performs project shutdown in Cloud Shell.

## Prepare Render

The Blueprint defines one Starter image service, PostgreSQL 18 on the 256 MB plan, a 5 GB database disk and a 2 GB
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
6. Configure trusted proxy addresses and the client-address header only after verifying Render's actual forwarding
   behavior. Do not carry over GCP's proxy secret or trust an arbitrary request header.
7. Check `/health` reports the pinned commit, sign-in, read/write operations, attachments and background processing.
   Then attach `mainworthy.com` and update DNS.

The mounted disk requires a single service instance and allows deployment downtime. Database and file backups need
one consistent recovery point. Backup uploads count toward source egress even when customer traffic is zero.

## Release less often

Use tested immutable image digests for manual or nightly releases. Image-backed Render services do not deploy
when a tag is repushed. A release must select one commit, complete its required checks, publish the tested artifact,
trigger Render explicitly, and verify the resulting commit. Skip a night when there is no new approved revision.
The scheduling change belongs with its workflow and verification evidence, not only in this document.

## Current implementation state

The Blueprint and this runbook are preparation. No Render services have been created and no DNS has changed.
The administrator is shutting down GCP. A new empty database is the Render starting point.
