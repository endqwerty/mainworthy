output "images" {
  value = "${local.region}-docker.pkg.dev/${var.production_project}/${google_artifact_registry_repository.images.repository_id}"
}

output "sql_connections" {
  value = { for key, instance in google_sql_database_instance.app : key => instance.connection_name }
}

output "runtime_accounts" {
  value = { for key, account in data.google_service_account.runtime : key => account.email }
}

output "job_url" {
  value = local.job_url
}
