# Teams and effective grants

2026-10-15. Implements [issue #30](https://github.com/endqwerty/mainworthy/issues/30).

## Decision

A team is a named set of grants, on individual projects or on every project. People hold memberships. Identity owns `teams`, `team_members`, `team_grants` and `team_events`; all actions extend the existing `admin` operation, with no new MCP tool. Settings, People manages them. The generated CLI exposes the same actions.

`toActor` reads personal grants plus the grants of current memberships and passes the union through `heldCapabilities`. No team grant is copied into a person's grants. Two teams can grant the same permission, and removing one membership leaves every other source intact. Agents, pipelines and the policy cannot join. The owner's authority stays independent of teams. As with personal grants, a person cannot change their own membership or the grants of a team they belong to.

[Decision 0017, Authority in the operation's snapshot](0017-sign-in-sessions-and-credentials.md#authority-in-the-operations-snapshot) owns caller resolution. A surface passes `Session.reference`, and `resolveCaller` reads the credential, actor and effective grants on the connection running the operation. Team grants join personal grants in `toActor` on that connection. Reader threads and queued writes use this existing path. This slice adds no worker actor refresh, parent grant recheck or read rerun. A membership removed before an operation begins its snapshot grants nothing to it. A read already running keeps its snapshot, with the existing final check for a credential that ended while it ran. Personal CLI tokens follow the same path and receive the person's current team grants.

`actor.list` keeps personal grants and adds `teams`, each with its own grants. People and the actor CLI label those sources. A team's history records creation, membership changes and grant changes with the actor who requested them. Command IDs use the existing registry replay rules. A repeated add or remove that changes nothing adds no event. History keeps actor IDs, so forgetting a person replaces their displayed name with the same pseudonym used elsewhere and removes their memberships. Operations performed by members still name the person who performed them.

## Alternatives

Copying a team's grants into each member's grants would make removal ambiguous when another team or a personal grant supplies the same permission. Deriving the union preserves those sources and removes permission with one membership deletion.

A separate team service or operation would duplicate the identity boundary or introduce another instance operation without needing one. Keeping SQL in identity and actions in `admin` follows the existing grant path.

## Storage and archives

Migration 0012 adds the four identity tables. It changes exported data, so `ARCHIVE_VERSION` becomes 12. Export/import discovers and preserves those tables, including history. An import requires archive schema 10; older archives are refused explicitly. To move older data, upgrade its database and export again. Database migration preserves existing rows and writes the normal backup first. The existing session/import tests retain their current-format snapshots and refusal check for older archives. A project archive includes teams with current or historical grants on that project or every project, their members, and their history for that scope. Other project grants and their events stay out.

A team created without a command ID still counts as user data and prevents replacement of bootstrap data during import. Sign-in tables remain excluded.

## Scope

Teams can be created, granted permissions and have people added or removed. Renaming and deleting teams, nested teams, external directory synchronization and custom roles are outside this slice. The existing capability vocabulary and policy decisions are unchanged.
