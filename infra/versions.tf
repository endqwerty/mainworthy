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
  # Name a quota project on every call. Without one, Google bills a call to the
  # CI account's own seed project, which enables none of these APIs: Service
  # Networking's operations and the SQL instance and user calls name none
  # unless billing_project is set. Production enables every API that preview
  # uses, and both CI identities may use its quota.
  user_project_override = true
  billing_project       = var.production_project
}

locals {
  region = "us-west1"
  projects = {
    production = var.production_project
    preview    = var.preview_project
  }
  labels = { app = "mainworthy", managedby = "terraform" }
}
