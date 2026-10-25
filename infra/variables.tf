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

variable "runtime" {
  description = "Null during bootstrap. Enable only after image publication, SQL grants, secrets and mount checks."
  type = object({
    image           = string
    sql_proxy_image = string
  })
  default = null
  validation {
    condition = var.runtime == null ? true : alltrue([
      can(regex("@sha256:[a-f0-9]{64}$", var.runtime.image)),
      can(regex("@sha256:[a-f0-9]{64}$", var.runtime.sql_proxy_image)),
    ])
    error_message = "Both runtime images must be pinned by sha256 digest."
  }
}
