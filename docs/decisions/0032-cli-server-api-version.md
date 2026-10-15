# 0032: CLI and server agree on an API version

Date: 2026-10-14. Issue: [#90](https://github.com/endqwerty/mainworthy/issues/90).

## Context

The software version is still 0.1.0 while commits change operation inputs and replies. CI's OpenAPI comparison
sees input differences but cannot yet see reply differences. A CLI can otherwise send an operation and only
then discover that it cannot read the reply. The change workflow also accepted an unknown operation as a
harmless 404, which could lose a pull request's lifecycle event.

## Decision

`src/core/version.ts` owns the software version and a positive integer `API_VERSION`, initially 1. CLI and
server work together when their API versions are equal. Increment it when an operation is added or removed,
or its inputs, replies, capabilities or meaning break compatibility in either direction. Keep it for compatible changes. Update the explicit version in `.github/workflows/change.yml` with it;
the workflow test runs that script against the current contract. The software version
and the build commit identify the release and build, but do not decide compatibility.

The CLI checks `/healthz` before sending its first authenticated request. An unknown or different API version
is a refusal with exit 4, without sending credentials or an operation. Every request then carries
`X-Mainworthy-API-Version`; admission refuses a different value before any operation or archive transfer.
Other clients may omit the header. This rule does not retrofit a compatibility check into an older CLI.
`version` reports the CLI contract locally; `health --json` reports the server contract and compatibility.
A health check remains an availability check, so incompatibility alone does not make it fail.

CI checks the API version as well as the existing operation descriptions and starts its own instance when
incompatible. The lifecycle workflow fails visibly on incompatible instances or unknown operations. It can
be replayed with `workflow_dispatch` after an upgrade. Only a specific missing-change reply is harmless.

## Alternatives

Requiring an identical commit would reject compatible builds on every pull request. A previous-release
support window would require released CLI artifacts and a second contract implementation. The project has
neither, and promises no compatibility before 1.0. An explicit API version gives compatible builds one
contract without treating every commit as a breaking change.

The existing GitHub Actions `gate` is sufficient evidence for an external deploy job. Adding a second status
or a success artifact would duplicate it. `docs/deploy.md` specifies reads for the exact main commit, push run
and current attempt, followed by the deployed commit's health reply. The external job and failure notification
are outside this repository and still need implementation and verification in the home lab.
