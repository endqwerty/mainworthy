# One service, released by the apply

- Date: 2026-10-26
- Status: proposed
- Issue: https://github.com/endqwerty/mainworthy/issues/821

Mainworthy on Google Cloud is one Cloud Run service on one database, and each push to `main` releases by the same
Terraform apply that owns the rest. This replaces parts of [the Cloud Run record](2026-10-23-postgresql-on-cloud-run-and-cloud-sql.md),
[the ownership decision](2026-10-25-cloud-infrastructure-and-release-ownership.md) and
[the job service's image](2026-10-25-the-job-services-image-and-database-role.md).

The project started empty, and the earlier design added pieces before anything needed them: a separate private
job service, a Cloud Tasks queue with a dispatcher, a preview database for previews that do not exist yet, and a
release path beside Terraform with its own identity and federation binding. On the owner's prompt (2026-10-26) the
design was redone from what serving `mainworthy.com` needs.

- **One service.** Cloud Scheduler's minute tick calls the public service's `/api/job`, which checks the Google
  token, and the due jobs run inside that request, so request-based billing still gives them CPU. A dedicated
  service bought isolation of job load from public requests, which nothing needs before 1.0, at the cost of a
  second deploy, proxy, mount and connection budget. Jobs wait at most about a minute; none needs less.
- **No Cloud Tasks.** The tick runs every due job, which already reconciles anything a dispatcher would lose. The
  queue comes back only if a job needs less latency than a minute.
- **Releases are the apply.** The image digest is a Terraform input that `infra.yml` looks up from GHCR for the
  commit it applies, so Terraform owns the whole service and a release is a plan like any other. This drops the
  release identity, its federation change and the split ownership of image and traffic. Rollback is a revert.
- **One database.** The preview instance goes until previews (#894) exist; its free network stays for them.
