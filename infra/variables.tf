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

variable "apple_apps" {
  description = "MAINWORTHY_APPLE_APPS, the iPhone apps mainworthy.com vouches for, from the repository variable of that name: the repository holds no team id."
  type        = string
  # Empty, the site serves no apple-app-site-association and the app can use no passkey or saved login for it.
  validation {
    condition     = trimspace(var.apple_apps) != ""
    error_message = "apple_apps is empty: set the repository variable MAINWORTHY_APPLE_APPS (docs/deploy.md)."
  }
}

variable "owner" {
  description = "MAINWORTHY_OWNER, the owner's name on mainworthy.com, from the repository variable of that name: the repository does not hold the owner's name."
  type        = string
  # Unset, the server would name the owner `owner` and give a person of that name every capability on each start.
  validation {
    condition     = trimspace(var.owner) != ""
    error_message = "owner is empty: set the repository variable MAINWORTHY_OWNER (docs/deploy.md)."
  }
}

variable "attachments_bucket" {
  description = "Globally unique bucket name, supplied by CI."
  type        = string
}

