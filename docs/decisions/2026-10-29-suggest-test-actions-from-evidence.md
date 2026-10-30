# Suggest what to do with a test only from evidence that decides it

- Date: 2026-10-29
- Status: proposed
- PR: https://github.com/endqwerty/mainworthy/pull/1114

The owner asked whether Mainworthy helps a team decide which tests to keep, delete or refactor, and chose that it
should "recommend verdicts but make sure the evidence is clear", for automated tests and manual cases.
[The research](../research/test-value-2026-10-29/README.md) found two things. Coverage overlap and failure history
alone would have removed tests that catch real defects. And the evidence that decides most automated verdicts (the
assertions, client coverage, planted bugs) lives in the team's repository, not in Mainworthy.

## Decision

Mainworthy suggests an action (keep, delete, refactor, merge, move down a layer, or "a person must judge: invariant
guard") only when the evidence for that action's gate is present. Otherwise it says "not enough evidence" and names
what would decide it. The gates are the table in the research, under "What may suggest each action".

The work is staged:

1. **Facts and findings.** One read per test and per case gives its facts. It feeds the report page, the CLI and the
   MCP tools from the registry. A review finding can name an automated test and keeps a snapshot of the evidence it
   was answered on. People accept, reject or defer findings in the queue they already use. A rejection holds until
   that evidence changes.
2. **Suggestions where Mainworthy holds the inputs.** A test that stopped reporting, a manual case not run within a
   set window, near-duplicate manual cases, and the cost of flips and reruns.
3. **Code-side evidence from the repository.** A script, an agent or a person compares assertions or runs planted
   bugs in the repository and attaches the result to a finding. Mainworthy does not run mutations. An importer for
   mutation-testing-elements JSON waits until a user asks for one, or until findings with mutation evidence are being
   answered. A report alone never makes a test the only one that catches a mutant (`killedBy` may list only the
   first failure); that needs a replay.

Accepting a finding changes only what Mainworthy owns (archiving a case, a quarantine, a link), through a decision
with a `Witness`. Deleting test code happens in the repository. No single value score is shown.

## Why not the alternatives

A verdict column computed by the server would answer "not enough evidence" for nearly every automated test, because
its deciding inputs are not on the server. A question in the queue for every test would bury the failures people
need to answer. A scheduled digest records no decision. The research has the panels' full reasoning.
