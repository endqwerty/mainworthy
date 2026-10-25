data "google_project" "production" {
  project_id = var.production_project
}

locals {
  job_url = "https://mainworthy-jobs-${data.google_project.production.number}.${local.region}.run.app"
  runtime = var.runtime == null ? {} : { jobs = var.runtime }
}

resource "google_cloud_tasks_queue" "jobs" {
  project  = var.production_project
  location = local.region
  name     = "mainworthy"
  rate_limits {
    max_concurrent_dispatches = 1
    max_dispatches_per_second = 1
  }
  retry_config {
    max_attempts       = 10
    min_backoff        = "5s"
    max_backoff        = "300s"
    max_doublings      = 5
    max_retry_duration = "3600s"
  }
  http_target {
    http_method = "POST"
    uri_override {
      scheme                    = "HTTPS"
      host                      = trimprefix(local.job_url, "https://")
      uri_override_enforce_mode = "ALWAYS"
      path_override {
        path = "/api/job"
      }
    }
    header_overrides {
      header {
        key   = "Content-Type"
        value = "application/json"
      }
    }
    oidc_token {
      service_account_email = google_service_account.runtime["jobs"].email
      audience              = local.job_url
    }
  }
}

resource "google_cloud_tasks_queue_iam_member" "enqueue" {
  project  = var.production_project
  location = local.region
  name     = google_cloud_tasks_queue.jobs.name
  role     = "roles/cloudtasks.enqueuer"
  member   = "serviceAccount:${google_service_account.runtime["app"].email}"
}

# No placeholder image: bootstrap builds the backing resources first. Step 4 supplies both tested digests.
resource "google_cloud_run_v2_service" "jobs" {
  for_each             = local.runtime
  project              = var.production_project
  name                 = "mainworthy-jobs"
  location             = local.region
  deletion_protection  = true
  ingress              = "INGRESS_TRAFFIC_ALL"
  invoker_iam_disabled = false
  labels               = local.labels
  scaling {
    min_instance_count = 0
    max_instance_count = 1
  }
  template {
    service_account                  = google_service_account.runtime["jobs"].email
    timeout                          = "600s"
    max_instance_request_concurrency = 1
    execution_environment            = "EXECUTION_ENVIRONMENT_GEN2"
    scaling {
      min_instance_count = 0
      max_instance_count = 1
    }
    vpc_access {
      egress = "PRIVATE_RANGES_ONLY"
      network_interfaces {
        network    = google_compute_network.app["production"].name
        subnetwork = google_compute_subnetwork.app["production"].name
      }
    }
    containers {
      name       = "app"
      image      = each.value.image
      depends_on = ["sql-proxy"]
      ports {
        container_port = 7357
      }
      resources {
        limits            = { cpu = "1", memory = "512Mi" }
        cpu_idle          = true
        startup_cpu_boost = false
      }
      dynamic "env" {
        for_each = {
          MAINWORTHY_HOST          = "0.0.0.0"
          MAINWORTHY_MODE          = "server"
          MAINWORTHY_DATA          = "/data"
          MAINWORTHY_JOB_SERVICE   = "1"
          MAINWORTHY_JOB_RUNNER    = "0"
          MAINWORTHY_JOB_AUDIENCE  = local.job_url
          MAINWORTHY_JOB_ACCOUNT   = google_service_account.runtime["jobs"].email
          MAINWORTHY_DB_POOL       = "1"
          MAINWORTHY_DB_WRITE_POOL = "1"
          MAINWORTHY_DATABASE_URL  = "postgresql://${urlencode(google_sql_user.runtime["jobs"].name)}@127.0.0.1:5432/mainworthy?sslmode=disable"
        }
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = { MAINWORTHY_JOB_KEY = "job-key", MAINWORTHY_OWNER_TOKEN = "owner-token" }
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
      image = each.value.sql_proxy_image
      args = [
        "--auto-iam-authn", "--private-ip", "--structured-logs", "--health-check", "--http-address=0.0.0.0",
        google_sql_database_instance.app["production"].connection_name,
      ]
      resources {
        limits            = { cpu = "1", memory = "128Mi" }
        cpu_idle          = true
        startup_cpu_boost = false
      }
      startup_probe {
        http_get {
          path = "/startup"
          port = 9801
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
        mount_options = ["stat-cache-ttl=0", "type-cache-ttl=0", "uid=10001", "file-mode=0600", "dir-mode=0700"]
      }
    }
  }
  lifecycle {
    # Step 5 patches the tested application digest and moves traffic. Infrastructure owns every other field.
    ignore_changes = [template[0].containers[0].image, traffic]
  }
  depends_on = [
    google_project_iam_member.sql, google_secret_manager_secret_iam_member.job_key,
    google_secret_manager_secret_iam_member.owner, google_storage_bucket_iam_policy.attachments,
  ]
}

resource "google_cloud_run_v2_service_iam_binding" "jobs" {
  for_each = local.runtime
  project  = var.production_project
  location = local.region
  name     = google_cloud_run_v2_service.jobs[each.key].name
  role     = "roles/run.invoker"
  members  = ["serviceAccount:${google_service_account.runtime["jobs"].email}"]
}

resource "google_cloud_scheduler_job" "tick" {
  for_each         = local.runtime
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
    uri         = "${local.job_url}/api/job"
    headers     = { "Content-Type" = "application/json" }
    body        = base64encode(jsonencode({ do = "tick" }))
    oidc_token {
      service_account_email = google_service_account.runtime["jobs"].email
      audience              = local.job_url
    }
  }
  depends_on = [google_cloud_run_v2_service_iam_binding.jobs]
}
