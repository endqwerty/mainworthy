# The preview project's network, kept for pull-request previews (#894). It costs nothing; its database went on
# 2026-10-26 until previews exist. The connection keeps ABANDON: deleting it fails while Google's side holds it.
resource "google_compute_network" "preview" {
  project                 = var.preview_project
  name                    = "mainworthy"
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "preview" {
  project                  = var.preview_project
  name                     = "mainworthy"
  region                   = local.region
  network                  = google_compute_network.preview.id
  ip_cidr_range            = "10.20.0.0/24"
  private_ip_google_access = true
}

resource "google_compute_global_address" "preview_sql" {
  project       = var.preview_project
  name          = "mainworthy-sql"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 16
  network       = google_compute_network.preview.id
}

resource "google_service_networking_connection" "preview_sql" {
  network                 = google_compute_network.preview.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.preview_sql.name]
  deletion_policy         = "ABANDON"
}

moved {
  from = google_compute_network.app["preview"]
  to   = google_compute_network.preview
}
moved {
  from = google_compute_subnetwork.app["preview"]
  to   = google_compute_subnetwork.preview
}
moved {
  from = google_compute_global_address.sql["preview"]
  to   = google_compute_global_address.preview_sql
}
moved {
  from = google_service_networking_connection.sql["preview"]
  to   = google_service_networking_connection.preview_sql
}
