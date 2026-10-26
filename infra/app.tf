data "google_project" "production" {
  project_id = var.production_project
}

locals {
  # Cloud Run's deterministic URL for the service: the Scheduler's target and the audience of its token.
  app_url         = "https://mainworthy-${data.google_project.production.number}.${local.region}.run.app"
  app_image       = "${local.region}-docker.pkg.dev/${var.production_project}/${google_artifact_registry_repository.images.repository_id}/endqwerty/mainworthy@${var.app_digest}"
  sql_proxy_image = "gcr.io/cloud-sql-connectors/cloud-sql-proxy:2.26.3@sha256:f333a9c59890c3c67b8505166c5dbdcc0b29fca9173a2e09ca0446ab6997a736"
}

# The one service. Cloudflare stands in front of mainworthy.com and sets x-mainworthy-proxy to the proxy secret; the
# app refuses a request without it, except /healthz and the Scheduler's token-checked POST /api/job, and believes
# cf-connecting-ip only with it. The organisation forbids allUsers, so the invoker check is off instead. Each apply
# on main sets the image to the commit's tested digest; Cloud Run moves traffic once the new revision is ready.
resource "google_cloud_run_v2_service" "app" {
  project  = var.production_project
  name     = "mainworthy"
  location = local.region
  # The service holds no state (data is in Cloud SQL and the bucket), and protection would stop Terraform replacing a
  # service whose first revision failed: the retry after a fix must be able to recreate it.
  deletion_protection  = false
  ingress              = "INGRESS_TRAFFIC_ALL"
  invoker_iam_disabled = true
  labels               = local.labels
  scaling {
    min_instance_count = 1
    max_instance_count = 1
  }
  template {
    service_account                  = data.google_service_account.runtime["app"].email
    timeout                          = "3600s"
    max_instance_request_concurrency = 80
    execution_environment            = "EXECUTION_ENVIRONMENT_GEN2"
    scaling {
      min_instance_count = 1
      max_instance_count = 1
    }
    vpc_access {
      egress = "PRIVATE_RANGES_ONLY"
      network_interfaces {
        network    = google_compute_network.app.name
        subnetwork = google_compute_subnetwork.app.name
      }
    }
    containers {
      name       = "app"
      image      = local.app_image
      depends_on = ["sql-proxy"]
      ports {
        container_port = 7357
      }
      resources {
        limits            = { cpu = "1", memory = "512Mi" }
        cpu_idle          = true
        startup_cpu_boost = true
      }
      dynamic "env" {
        for_each = {
          MAINWORTHY_HOST                  = "0.0.0.0"
          MAINWORTHY_MODE                  = "server"
          MAINWORTHY_DATA                  = "/data"
          MAINWORTHY_PUBLIC_URL            = "https://mainworthy.com"
          MAINWORTHY_CLIENT_ADDRESS_HEADER = "cf-connecting-ip"
          # Jobs run in the Scheduler's minute request (and any sign-in's own), not on a timer.
          MAINWORTHY_JOB_RUNNER   = "0"
          MAINWORTHY_JOB_AUDIENCE = local.app_url
          MAINWORTHY_JOB_ACCOUNT  = data.google_service_account.runtime["jobs"].email
          # Two revisions during a deploy, each with 2 + 2 pooled, 1 job, 2 admission, 1 LISTEN and 1 migration
          # connection: 18, plus an operator's session, under db-f1-micro's 25.
          MAINWORTHY_DB_POOL       = "2"
          MAINWORTHY_DB_WRITE_POOL = "2"
          # Sessions act as the database's owner role, so every table has that one owner.
          MAINWORTHY_DATABASE_URL = "postgresql://${urlencode(google_sql_user.app.name)}@127.0.0.1:5432/mainworthy?sslmode=disable&options=-c%20role%3Dcloudsqlsuperuser"
        }
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = { MAINWORTHY_JOB_KEY = "job-key", MAINWORTHY_OWNER_TOKEN = "owner-token", MAINWORTHY_PROXY_SECRET = "proxy-secret" }
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.app[env.value].secret_id
              version = "latest"
            }
          }
        }
      }
      volume_mounts {
        name       = "attachments"
        mount_path = "/data/blobs"
      }
      startup_probe {
        http_get {
          path = "/healthz"
          port = 7357
        }
        period_seconds    = 5
        timeout_seconds   = 2
        failure_threshold = 48
      }
    }
    containers {
      name  = "sql-proxy"
      image = local.sql_proxy_image
      args = [
        "--auto-iam-authn", "--private-ip", "--structured-logs", "--health-check", "--http-address=0.0.0.0",
        google_sql_database_instance.app.connection_name,
      ]
      resources {
        limits            = { cpu = "1", memory = "128Mi" }
        cpu_idle          = true
        startup_cpu_boost = false
      }
      # --health-check serves /startup on the proxy's default HTTP port, 9090.
      startup_probe {
        http_get {
          path = "/startup"
          port = 9090
        }
        period_seconds    = 5
        failure_threshold = 48
      }
    }
    volumes {
      name = "attachments"
      gcs {
        bucket        = google_storage_bucket.attachments.name
        read_only     = false
        mount_options = ["metadata-cache-ttl-secs=0", "uid=10001", "file-mode=0600", "dir-mode=0700"]
      }
    }
  }
  # Every apply sends all traffic to the revision it releases, which also ends an emergency pin made in Cloud Shell.
  traffic {
    type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
    percent = 100
  }
  depends_on = [
    google_project_iam_member.sql, google_secret_manager_secret_iam_member.app,
    google_storage_bucket_iam_policy.attachments,
  ]
}

# Durable jobs run when the app is called at /api/job, which checks this token's audience and account.
resource "google_cloud_scheduler_job" "tick" {
  project          = var.production_project
  region           = local.region
  name             = "mainworthy-tick"
  schedule         = "* * * * *"
  time_zone        = "Etc/UTC"
  attempt_deadline = "600s"
  retry_config {
    retry_count          = 5
    min_backoff_duration = "5s"
    max_backoff_duration = "300s"
    max_doublings        = 5
  }
  http_target {
    http_method = "POST"
    uri         = "${local.app_url}/api/job"
    headers     = { "Content-Type" = "application/json" }
    body        = base64encode(jsonencode({ do = "tick" }))
    oidc_token {
      service_account_email = data.google_service_account.runtime["jobs"].email
      audience              = local.app_url
    }
  }
  depends_on = [google_cloud_run_v2_service.app]
}
