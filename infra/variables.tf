variable "production_project" {
  description = "Production project id, supplied by CI."
  type        = string
}

variable "preview_project" {
  description = "Preview project id, supplied by CI."
  type        = string
}

variable "attachments_bucket" {
  description = "Globally unique bucket name, supplied by CI."
  type        = string
}

