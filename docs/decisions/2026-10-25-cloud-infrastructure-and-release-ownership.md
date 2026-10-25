# Cloud infrastructure and release ownership

- Date: 2026-10-25
- Status: proposed
- Issue: https://github.com/endqwerty/mainworthy/issues/821

The public `infra/` configuration owns application resources in the production and preview projects. The private
foundation owns project creation, API enables, CI identities, federation and the app's state bucket. The app's
Terraform cannot administer the foundation or its own federation bindings. The foundation pins `infra.yml` on
`main` before it grants the deploy account any role. Push runs can use the writer; manual runs can use only the
reader. Pull requests get neither. This replaces the earlier record's proposal to plan credentialed PR code.

Terraform owns the private job service's configuration. Step 5 owns only its application image and traffic,
excluded explicitly from Terraform updates. The proxy image, identity, networking, secret references, mount,
limits and probes stay in Terraform. Step 5 must patch those two release fields, preserve all others, and use the
same `mainworthy-infrastructure` concurrency group. Whole-template replacement would violate this boundary.
Check that a release followed by a drift check has no diff, and that an infrastructure update preserves the
released image and traffic.

The public app service waits for step 5. Its Cloudflare proof and release checks do not exist yet, and creating
it now would require an unready public service or a placeholder image. Step 5 adds its infrastructure settings
to this configuration and gives the release workflow the same narrow ownership. This postpones creation, rather
than introducing another manifest owner. The alternative was to create both services now with a generic image.
That would make the resource graph look complete without checking the app's actual startup or network boundary.

Bootstrap leaves `runtime` null. It creates the databases, network, registry, secrets, bucket and queue. Once the
tested app and proxy images exist, secret versions and SQL grants are ready, and the mount/proxy checks pass,
set both image digests together. Terraform then creates the private job service, invoker binding and Scheduler
job. There is no placeholder application, polling timer or second live host to retire later.

The owner's 2026-10-25 direction removes the home-server rollback and any work to run both hosts. In the earlier
record's steps 3 to 7, drop the old-host fallback rehearsal, request-holding proxy work for this move and the
Cloudflare switch back before the first write. Build-once image checks, Cloud Run revision rollback, compatible
schema changes, the restore drill and proof of the client's address still matter. Retire the old deployment
when Cloud Run passes those checks. This change does not operate either host or switch public traffic.

The current database code can allocate six connections per process even with both configurable pools set to
one: one reader, one writer, two admission connections, one job connection and one LISTEN connection. Two
revisions of one job instance need 12 connections; a migration and an operator bring that to 14. The job service
therefore sets both service and revision maxima to one. Adding the public service with the same six-connection
shape needs 26, exceeding the record's 25. Step 5 must reduce unused pools in job mode or otherwise prove a
smaller connection budget before creating the public service. Instance limits can briefly overshoot, so 14 is
an allocation budget, not a hard connection cap. Do not raise `max_connections` to conceal this gap.

No live plan or apply has run. The owner applies the foundation in Cloud Shell, then CI applies the app
infrastructure after merge. An owner-run plan and a no-change manual drift check remain the cloud acceptance
checks; local Terraform validation cannot establish them.
