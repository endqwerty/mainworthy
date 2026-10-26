# The foundation creates both runtime accounts. The app runs as `app`; Cloud Scheduler signs its minute call to
# /api/job as `jobs`, which the app checks (MAINWORTHY_JOB_ACCOUNT) and which holds nothing else.
data "google_service_account" "runtime" {
  for_each   = toset(["app", "jobs"])
  project    = var.production_project
  account_id = "mainworthy-${each.key}"
}

resource "google_project_iam_member" "sql" {
  for_each = { app_client = "roles/cloudsql.client", app_login = "roles/cloudsql.instanceUser" }
  project  = var.production_project
  role     = each.value
  member   = "serviceAccount:${data.google_service_account.runtime["app"].email}"
}

resource "google_sql_user" "app" {
  project  = var.production_project
  instance = google_sql_database_instance.app.name
  name     = trimsuffix(data.google_service_account.runtime["app"].email, ".gserviceaccount.com")
  type     = "CLOUD_IAM_SERVICE_ACCOUNT"
  # cloudsqlsuperuser owns the mainworthy database; its members may create in it. The instance holds nothing else.
  database_roles = ["cloudsqlsuperuser"]
}

moved {
  from = google_sql_user.runtime["app"]
  to   = google_sql_user.app
}

# The complete policy removes Google's projectViewer and projectEditor convenience grants.
resource "google_storage_bucket_iam_policy" "attachments" {
  bucket = google_storage_bucket.attachments.name
  policy_data = jsonencode({
    bindings = [{
      role    = "roles/storage.objectUser"
      members = ["serviceAccount:${data.google_service_account.runtime["app"].email}"]
    }]
  })
}

resource "google_secret_manager_secret_iam_member" "app" {
  for_each  = toset(["job-key", "owner-token", "proxy-secret"])
  project   = var.production_project
  secret_id = google_secret_manager_secret.app[each.key].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${data.google_service_account.runtime["app"].email}"
}

moved {
  from = google_secret_manager_secret_iam_member.job_key["app"]
  to   = google_secret_manager_secret_iam_member.app["job-key"]
}
moved {
  from = google_secret_manager_secret_iam_member.owner["app"]
  to   = google_secret_manager_secret_iam_member.app["owner-token"]
}
