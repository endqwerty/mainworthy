---
id: 821-gcp-infra
category: Added
date: 2026-10-25
issue: https://github.com/endqwerty/mainworthy/issues/821
pr: https://github.com/endqwerty/mainworthy/pull/932
---

Google Cloud application infrastructure is defined in Terraform for us-west1, with isolated production and preview networks, private PostgreSQL instances, attachment storage, secret containers and a private HTTP job service. Main-branch CI applies through Workload Identity Federation; manual drift checks use a separate read-only identity. Bootstrap waits for tested images and secret versions before creating the job service. Public traffic remains on the current host until the Cloud Run deployment and cutover checks pass.
