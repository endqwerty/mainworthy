# The foundation creates runtime identities so it can grant deployment access directly on each account.
data "google_service_account" "runtime" {
  for_each   = toset(["app", "jobs"])
  project    = var.production_project
  account_id = "mainworthy-${each.key}"
}

resource "google_project_iam_member" "sql" {
  for_each = {
    app_client  = { account = "app", role = "roles/cloudsql.client" }
    app_login   = { account = "app", role = "roles/cloudsql.instanceUser" }
    jobs_client = { account = "jobs", role = "roles/cloudsql.client" }
    jobs_login  = { account = "jobs", role = "roles/cloudsql.instanceUser" }
  }
  project = var.production_project
  role    = each.value.role
  member  = "serviceAccount:${data.google_service_account.runtime[each.value.account].email}"
}

resource "google_sql_user" "runtime" {
  for_each = data.google_service_account.runtime
  project  = var.production_project
  instance = google_sql_database_instance.app["production"].name
  name     = trimsuffix(each.value.email, ".gserviceaccount.com")
  type     = "CLOUD_IAM_SERVICE_ACCOUNT"
  # cloudsqlsuperuser owns the mainworthy database; its members may create in it. The instance holds nothing else.
  database_roles = ["cloudsqlsuperuser"]
}

# The complete policy removes Google's projectViewer and projectEditor convenience grants.
resource "google_storage_bucket_iam_policy" "attachments" {
  bucket = google_storage_bucket.attachments.name
  policy_data = jsonencode({
    bindings = [{
      role    = "roles/storage.objectUser"
      members = [for account in data.google_service_account.runtime : "serviceAccount:${account.email}"]
    }]
  })
}

resource "google_secret_manager_secret_iam_member" "job_key" {
  for_each  = data.google_service_account.runtime
  project   = var.production_project
  secret_id = google_secret_manager_secret.app["job-key"].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${each.value.email}"
}

# Both processes bootstrap the same owner. Neither may print a newly generated owner token in logs.
resource "google_secret_manager_secret_iam_member" "owner" {
  for_each  = data.google_service_account.runtime
  project   = var.production_project
  secret_id = google_secret_manager_secret.app["owner-token"].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${each.value.email}"
}
