resource "google_compute_network" "app" {
  for_each                = local.projects
  project                 = each.value
  name                    = "mainworthy"
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "app" {
  for_each                 = local.projects
  project                  = each.value
  name                     = "mainworthy"
  region                   = local.region
  network                  = google_compute_network.app[each.key].id
  ip_cidr_range            = "10.20.0.0/24"
  private_ip_google_access = true
}

resource "google_compute_global_address" "sql" {
  for_each      = local.projects
  project       = each.value
  name          = "mainworthy-sql"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 16
  network       = google_compute_network.app[each.key].id
}

# The first apply (2026-10-25) created both connections, then failed reading
# their operations from the seed project; adopt them instead of creating again.
import {
  for_each = local.projects
  to       = google_service_networking_connection.sql[each.key]
  id       = "projects/${each.value}/global/networks/mainworthy:servicenetworking.googleapis.com"
}

resource "google_service_networking_connection" "sql" {
  for_each                = local.projects
  network                 = google_compute_network.app[each.key].id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.sql[each.key].name]
  deletion_policy         = "ABANDON"
}
