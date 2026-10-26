resource "google_compute_network" "app" {
  project                 = var.production_project
  name                    = "mainworthy"
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "app" {
  project                  = var.production_project
  name                     = "mainworthy"
  region                   = local.region
  network                  = google_compute_network.app.id
  ip_cidr_range            = "10.20.0.0/24"
  private_ip_google_access = true
}

resource "google_compute_global_address" "sql" {
  project       = var.production_project
  name          = "mainworthy-sql"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 16
  network       = google_compute_network.app.id
}

resource "google_service_networking_connection" "sql" {
  network                 = google_compute_network.app.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.sql.name]
  deletion_policy         = "ABANDON"
}

# Production's resources were one instance of a for_each over production and preview until 2026-10-26.
moved {
  from = google_compute_network.app["production"]
  to   = google_compute_network.app
}
moved {
  from = google_compute_subnetwork.app["production"]
  to   = google_compute_subnetwork.app
}
moved {
  from = google_compute_global_address.sql["production"]
  to   = google_compute_global_address.sql
}
moved {
  from = google_service_networking_connection.sql["production"]
  to   = google_service_networking_connection.sql
}
