resource "google_artifact_registry_repository" "images" {
  project       = var.production_project
  location      = local.region
  repository_id = "mainworthy"
  format        = "DOCKER"
  labels        = local.labels
}

resource "google_sql_database_instance" "app" {
  for_each            = local.projects
  project             = each.value
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
      private_network = google_compute_network.app[each.key].id
      ssl_mode        = "ENCRYPTED_ONLY"
    }
    database_flags {
      name  = "cloudsql.iam_authentication"
      value = "on"
    }
    backup_configuration {
      enabled                        = each.key == "production"
      point_in_time_recovery_enabled = each.key == "production"
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

resource "google_sql_database" "production" {
  project  = var.production_project
  instance = google_sql_database_instance.app["production"].name
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
  for_each  = toset(["database-password", "job-key", "owner-token"])
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
