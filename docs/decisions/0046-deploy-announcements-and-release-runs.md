# 0046: Deploy announcements and release runs

Date: 2026-10-14. Implements the first slice of issue #42, answer 17 of decision 0009.

## Decision

`announce` records a deployment and binds a project-local build label to an artifact's
SHA-256 digest. The binding cannot change. The first announcement of an artifact
names its source repositories and full commits. Mainworthy records who attested that
source and when. This is the authenticated caller's statement, not a signature from
an external provenance service.

A pipeline with `record`, or a human admin with `record`, may announce. An agent
cannot establish provenance. A retry with the same command id writes nothing. A
new command records another deployment, including a redeployment or rollback.
These are facts, not changes to standing that need a decision witness.

Artifacts, build bindings and deployments belong to evidence. Planned runs accept
`{build, env?}` and use the existing slots, obligations, sign-off and gate. Results
on the same digest count across labels, within the environment selected by the run.
When a report target or plan names an environment, that build label must have an
announced deployment there. Otherwise it returns `invalid` and lists the label's
deployed environments. An announcement under another label does not satisfy this
check, even when its digest is the same. Omitting the environment keeps the existing
unspecified target or any-environment plan behavior.

A later deployment does not require new results. A new run can count results already
recorded for the same digest and environment, including results reported under
another deployed label. Results need not postdate the selected label's deployment
announcement. Rejected reports store no results; retry them after announcing the
deployment.

Commit results never count as artifact execution in this slice. Artifact failures
are answered in the scope of that artifact, separate from code and other artifacts.

## Alternatives

A separate release module and release gate would duplicate the existing target
matching and gate rules. Keeping provenance in evidence and selection in runs
gives callers one way to report and judge results.

We do not add an MCP tool. The CLI and HTTP API expose `announce` and direct build
report targets. MCP's report schema omits the build target to keep the existing tools/list budget;
use a planned run. This omission does not refuse a build target sent directly.
The schema compactor honours `x-mcp-hidden` on union members as well as optional
properties.

## Remaining work

Code-in-artifact reuse needs an obligation that explicitly opts in. Environment
discovery and a build picker in the web and iPhone planners, plus webhook intake,
remain deferred. The native app can read a build run with its existing unknown
target fallback. The web app names the build and supports recording its slots.

The new tables travel in archives. Archives exported before this schema change
must be restored with the older build. Existing databases upgrade in place.
