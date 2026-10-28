# The customer is release-gated teams moving to CI/CD

- Date: 2026-10-27
- Status: accepted
- PR: https://github.com/endqwerty/mainworthy/pull/1024

Narrows [0005](0005-generic-audience-and-practitioner-evidence.md), which made Mainworthy for "teams in general".
The [strategy review](../strategy-review.md) found that the broad audience let scope grow with nothing to stop it.

## Decision

Mainworthy is designed for one customer: a team that wants to ship through CI/CD but still gates its releases, and
must show what was tested. That includes teams where management needs charts and results to sign off, and teams under
standards that require traceability from requirements to tests, such as DO-178C or DO-200B in aviation and ISO
standards elsewhere. The owner, 2026-10-27: "I'm thinking primarily teams that want to do CI/CD but are still
release-gated", and "We want to be a product that helps them transition to more CI/CD rather than locking them into
more manual QA."

What this means for the design:

- **Manual and automated tests in one place is the core offer.** Such a team cannot move all of its manual tests to
  automation at once, so both kinds of result count toward one release decision. The owner, 2026-10-27: "a team with
  manual tests can't fully migrate immediately."
- **The product pushes toward automation, not away from it.** Each manual case shows whether an automated test covers
  it, and the reports show the automation rate and which manual cases cost the most to keep running. The gate accepts
  automated evidence in place of a manual run when a case has both.
- **Traceability and an audit trail are required, not extras.** Requirement to case to result to release decision,
  with the case version each result ran against, exportable for an auditor.
- **Agent access stays.** Agents author and run tests for this team too; the owner calls being agent friendly "good".
- **A feature needs this customer.** Work that this team does not need waits until a user asks for it.

A team of strong developers that needs no test case manager is not this customer: Buildkite, Trunk and similar tools
serve it.

## What this left open

Which current work to freeze, the authentication provider, Google Cloud against Cloudflare, and whether the
repository stays public. The owner answered all four the same day:
[freeze what the customer does not need](2026-10-27-freeze-what-the-customer-does-not-need.md), which also keeps
Google Cloud and the public repository, and
[people sign in through an identity provider](2026-10-27-people-sign-in-through-an-identity-provider.md).
