# CI builds and tests the image once and publishes it to GHCR (check.yml, `publish`). Cloud Run pulls that same digest
# through this remote repository, so no CI identity pushes here.
resource "google_artifact_registry_repository" "images" {
  project       = var.production_project
  location      = local.region
  repository_id = "mainworthy"
  format        = "DOCKER"
  mode          = "REMOTE_REPOSITORY"
  labels        = local.labels
  remote_repository_config {
    description = "The public GHCR images CI publishes"
    docker_repository {
      custom_repository {
        uri = "https://ghcr.io"
      }
    }
  }
}

resource "google_sql_database_instance" "app" {
  project             = var.production_project
  name                = "mainworthy"
  region              = local.region
  database_version    = "POSTGRES_18"
  deletion_protection = true
  settings {
    tier                        = "db-f1-micro"
    edition                     = "ENTERPRISE"
    availability_type           = "ZONAL"
    disk_type                   = "PD_SSD"
    disk_size                   = 10
    disk_autoresize             = true
    user_labels                 = local.labels
    deletion_protection_enabled = true
    ip_configuration {
      ipv4_enabled    = false
      private_network = google_compute_network.app.id
      ssl_mode        = "ENCRYPTED_ONLY"
    }
    database_flags {
      name  = "cloudsql.iam_authentication"
      value = "on"
    }
    # Who held a lock someone waited on more than a second, and which statements took more than one (#1084). Bound
    # values stay out of the log; none of the three restarts the instance.
    database_flags {
      name  = "log_lock_waits"
      value = "on"
    }
    database_flags {
      name  = "log_min_duration_statement"
      value = "1000"
    }
    database_flags {
      name  = "log_parameter_max_length"
      value = "0"
    }
    # Which statements take the time, split into lock, I/O and execution (#1084). Free on Enterprise, kept seven days;
    # client addresses stay off.
    insights_config {
      query_insights_enabled  = true
      query_string_length     = 1024
      record_application_tags = false
      record_client_address   = false
    }
    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
      transaction_log_retention_days = 7
      start_time                     = "09:00"
      location                       = local.region
      backup_retention_settings {
        retained_backups = 7
      }
    }
  }
  depends_on = [google_service_networking_connection.sql]
}

moved {
  from = google_sql_database_instance.app["production"]
  to   = google_sql_database_instance.app
}

resource "google_sql_database" "production" {
  project  = var.production_project
  instance = google_sql_database_instance.app.name
  name     = "mainworthy"
}

resource "google_storage_bucket" "attachments" {
  project                     = var.production_project
  name                        = var.attachments_bucket
  location                    = upper(local.region)
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false
  labels                      = local.labels
  versioning {
    enabled = true
  }
  soft_delete_policy {
    retention_duration_seconds = 604800
  }
  lifecycle_rule {
    condition {
      days_since_noncurrent_time = 7
      with_state                 = "ARCHIVED"
    }
    action {
      type = "Delete"
    }
  }
  lifecycle {
    prevent_destroy = true
  }
}

resource "google_secret_manager_secret" "app" {
  for_each  = toset(["database-password", "job-key", "owner-token", "proxy-secret"])
  project   = var.production_project
  secret_id = "mainworthy-${each.key}"
  labels    = local.labels
  replication {
    user_managed {
      replicas {
        location = local.region
      }
    }
  }
}
