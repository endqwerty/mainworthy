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
}

locals {
  region = "us-west1"
  projects = {
    production = var.production_project
    preview    = var.preview_project
  }
  labels = { app = "mainworthy", managedby = "terraform" }
}
