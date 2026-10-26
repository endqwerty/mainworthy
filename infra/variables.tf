variable "production_project" {
  description = "Production project id, supplied by CI."
  type        = string
}

variable "preview_project" {
  description = "Preview project id, supplied by CI."
  type        = string
}

variable "app_digest" {
  description = "The image digest check.yml published to GHCR for the commit being applied, looked up by ci.sh."
  type        = string
  validation {
    condition     = can(regex("^sha256:[a-f0-9]{64}$", var.app_digest))
    error_message = "app_digest is the image's sha256 digest."
  }
}

variable "attachments_bucket" {
  description = "Globally unique bucket name, supplied by CI."
  type        = string
}

