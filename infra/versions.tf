terraform {
  required_version = "~> 1.17.0"
  backend "gcs" {
    prefix = "mainworthy"
  }
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 8.8.0"
    }
  }
}

provider "google" {
  region = local.region
  # Bill each call to its resource's project. Without this, calls without a
  # resource project (Service Networking's connections and operations) go to
  # the CI account's own seed project, which enables none of these APIs.
  user_project_override = true
}

locals {
  region = "us-west1"
  projects = {
    production = var.production_project
    preview    = var.preview_project
  }
  labels = { app = "mainworthy", managedby = "terraform" }
}
