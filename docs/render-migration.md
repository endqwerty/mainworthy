# Move Mainworthy from GCP to Render

Downtime is acceptable during this migration. Retire GCP once recovery from an independent copy is proven;
Render does not need to be running first. Preserve current production data. The old Coolify application's
disposal permission does not cover the current production database or attachments.

## Prepare in parallel

- Secure a recoverable PostgreSQL 18 dump, matching attachment files and required configuration outside GCP.
  Check the dump by restoring it into an isolated database. Keep credentials out of Git, logs and PRs.
- Prepare Render with `infra/render.yaml`. Validate the Blueprint and review its paid resources before creating them.
- Reduce CI frequency and support one combined stack check. Until the workflow and landing policy support that,
  each layer still needs its existing checks. See [test costs](development/tests.md#estimate-the-recurring-ci-cost).
- Keep GitCafe as a candidate source host. Compare its account-wide storage and outbound usage with the reduced
  CI plan before paying for a larger plan or moving the forge.

## Stop GCP costs early

1. Pause automated deployments and scheduled writes, and stop public writes before taking the final recovery copy.
   Allow any active writes to finish. Keep a record of the exact image digest and configuration.
2. Export PostgreSQL and copy the matching attachment data. Preserve `MAINWORTHY_JOB_KEY` if retaining encrypted
   private jobs. Preserve the owner credential and any configured identity-provider credentials securely.
3. Store the copy outside GCP. Restore it into isolated PostgreSQL 18, check representative records and file hashes,
   and verify the application can read it. A backup that exists only in the project being deleted is insufficient.
4. Delete the application compute and its scheduler when they are no longer needed for extraction. Stopping Cloud SQL
   reduces compute charges but retains storage charges. Keep data resources until step 3 passes.
5. Delete the data resources or dedicated projects only after recovery passes and their inventory has been reviewed.
   Cloud SQL and bucket deletion protections need explicit handling. Preserve unrelated organization, identity and
   billing resources. Confirm billing and resource inventories afterwards; project deletion is not a backup strategy.

The agent's documented Google account is read-only. Foundation changes are performed by the administrator in Cloud
Shell; app infrastructure changes use the reviewed Terraform path. Use the homelab repository's `access.md` rather
than granting a broader workstation credential. Record which artifacts passed restore before declaring deletion safe.

## Prepare Render

The Blueprint defines one Starter image service, PostgreSQL 18 on the 256 MB plan, a 5 GB database disk and a 2 GB
application disk. The planning estimate is about $15/month before excess traffic, builds, backup egress or taxes.
Recheck [current pricing](https://render.com/pricing) before creating paid resources. The small database tier needs
an actual restore and workload check. Increase it only after reviewing the resulting recurring cost.

The image is pinned to the published digest for commit `3cfa7c4d748001e4ee25a0c27c06e8d9609db610`, verified in GHCR
on 2026-10-28. The application runner is enabled because Google Cloud Scheduler will be removed. The database uses
a direct connection, with no transaction pooler. Public database access is disabled. Temporarily allow only the
restoring machine's address if an external restore route is needed, then remove that rule.

Before using the Blueprint:

1. Validate it against [Render's current specification](https://render.com/docs/blueprint-spec) and with
   `render blueprints validate infra/render.yaml` or the validation API. Local schema validation alone does not
   prove the account supports a plan, region or PostgreSQL version.
2. Set `MAINWORTHY_JOB_KEY` to the preserved value, and set the owner token securely. Do not generate a different
   job key for retained encrypted jobs. Set the public URL to the actual Render URL during verification.
3. Provide a registry credential when the GHCR package becomes private. Keep deployed image digests available in
   GHCR so Render can recover after a restart. Moving the source repository to private does not automatically
   establish the package's access settings.
4. Check that the service user can write the mounted `/data`. Restore attachment files into `/data/blobs` with the
   correct ownership. Keep the app stopped or in maintenance during the database and attachment restore.
5. Restore into the managed database using PostgreSQL 18 tools, without Cloud SQL-specific ownership or role grants.
   Verify `unaccent`, migrations, private jobs, representative records and attachments. Configure any retained OIDC
   credentials and callback URL before checking sign-in.
6. Configure trusted proxy addresses and the client-address header only after verifying Render's actual forwarding
   behavior. Do not carry over GCP's proxy secret or trust an arbitrary request header.
7. Check `/health` reports the pinned commit, sign-in, read/write operations, attachments and background processing.
   Verify a fresh backup and restore before treating Render as production. Then attach `mainworthy.com` and update DNS.

The mounted disk requires a single service instance and allows deployment downtime. Database and file backups need
one consistent recovery point. Backup uploads count toward source egress even when customer traffic is zero.

## Release less often

Use tested immutable image digests for manual or nightly releases. Image-backed Render services do not deploy
when a tag is repushed. A release must select one commit, complete its required checks, publish the tested artifact,
trigger Render explicitly, and verify the resulting commit. Skip a night when there is no new approved revision.
The scheduling change belongs with its workflow and verification evidence, not only in this document.

## Current implementation state

The Blueprint and this runbook are preparation. No Render services have been created, no DNS has changed, and no GCP
resources have been deleted. GCP deletion is not yet cleared: the independent restore and off-GCP copy remain to be
verified through the administrator's data-access route. Uptime is not a prerequisite for retirement.
