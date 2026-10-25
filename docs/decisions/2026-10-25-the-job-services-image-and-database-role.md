# The job service's image and database role

- Date: 2026-10-25
- Status: proposed
- Issue: https://github.com/endqwerty/mainworthy/issues/821

Step 4 of [the Cloud Run record](2026-10-23-postgresql-on-cloud-run-and-cloud-sql.md) changes that record in
three places.

**Cloud Run pulls the tested image through Artifact Registry instead of CI pushing it there.** CI already builds
and smoke-tests the image once and publishes that digest to GHCR, which anyone can read. The registry is a remote
repository of GHCR, so Cloud Run runs the same digest and no CI identity needs push rights or a new federation
binding in the foundation. The alternative, a push from `check.yml`, needed a third CI identity, its own
federation condition and an owner apply in Cloud Shell, for the same image. If GHCR is ever unsuitable, the
repository becomes a standard one and `publish` pushes to it as well.

**Both runtime users are members of `cloudsqlsuperuser`, and every session starts as that role.** Cloud SQL
creates the `mainworthy` database owned by `cloudsqlsuperuser`, and IAM database users have no privileges of their
own. Terraform's `database_roles` makes both users members, and the database URL's `options=-c role=…` makes
their sessions act as that role, so every table has one owner and either service can migrate. The record asked
for a dedicated owner role granted by hand; on an instance with only a private address that meant an owner-run
SQL session from inside the network for four statements. The instance holds only this application, so the wider
role grants nothing outside it that the application does not already own. A dedicated role can replace it later
with one migration and a `database_roles` change.

**The bucket mount's checks move from step 4 to before the cutover.** The bucket stays empty until the cutover
brings attachments, and only the job service mounts it until then. The checks and the fallback to Cloud Storage's
API are unchanged; they run before real data lands.
