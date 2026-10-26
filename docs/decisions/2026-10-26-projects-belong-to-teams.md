# Projects belong to teams

- Date: 2026-10-26
- Status: accepted
- Issue: https://github.com/endqwerty/mainworthy/issues/948

The owner's direction on 2026-10-25 was "projects need to live under teams and teams need owner/admin, users, and viewers."
The owner accepted the model and conversion rules with "1" on 2026-10-26 in
[the acceptance comment](https://github.com/endqwerty/mainworthy/issues/948#issuecomment-6408691804).
This records that choice. It changes no schema or behaviour. M8 implements it, ending with
[issue #955](https://github.com/endqwerty/mainworthy/issues/955).

## What the code does today

An instance has one `orgs` row. `orgId` in `src/server/identity/identity.ts` reads that row; it does not select a
team or tenant. Projects belong directly to the instance through `projects.org`, with instance-unique keys.
`src/server/identity/teams.ts` implements named grant sets, human memberships and attributed team events.
A person's effective capabilities combine direct grants and every team's grants. Agents and pipelines cannot join.
There are no team ownership roles or project-owning teams yet.

`adminOp` in `src/server/ops/admin.ts` is an instance operation requiring `admin`. The registry resolves its
caller on project 0, where grants on `*` apply. Project-specific `admin` alone does not admit that operation.
`resolveCaller` resolves credentials and capabilities on the operation's database connection.
`callerProjectCapabilities` resolves the credential on project 0, then combines direct and team grants for each
requested project in the same snapshot. `heldCapabilities` in `src/core/kinds.ts` adds `record` to `produce` and
caps pipelines at `read, record`. A named role is separate from a capability.

Invitations, tokens, sessions and recovery are instance-level. An invitation for an existing person is recovery,
which replaces their credentials and revokes their tokens and sessions when accepted. Team membership must not
reuse that authority.

## The accepted model

1. Every project belongs to exactly one team through a required `projects.team`. A team owns administration of
   its projects, their policy, members and service tokens. Project keys remain instance-unique. URLs, `--project`,
   `MAINWORTHY_PROJECT`, MCP and the iPhone contract keep their project identifiers. Team names are instance-unique.
   Teams define ownership and administration, not a namespace.
2. Each person holds one membership role per team: `owner`, `admin`, `user` or `viewer`. The role supplies the
   following capabilities on every project in that team. Only an owner appoints or removes owners and admins.
   An admin manages users and viewers. Every team retains at least one owner. Named project roles such as
   `approver`, from [decision 0054](0054-named-role-answers.md), remain separate assignments per
   person and project. They grant no capabilities.
3. The instance remains the account boundary. `MAINWORTHY_OWNER` retains every capability on every project,
   rewritten at every start, and may act in every team without membership. Transferring a team does not remove
   that authority. An instance admin holds `admin` on `*`, creates teams and sees every team. Only instance
   admins create teams in M8. Self-service creation belongs to the hosted-tier work in
   [issue #31](https://github.com/endqwerty/mainworthy/issues/31). Credentials, recovery, personal tokens, sessions
   and forgetting remain instance-level, outside team authority.
4. Agents and pipelines each have one owning team. They are not members. Their per-project grants can name only
   that team's projects. A team owner or admin issues and revokes their tokens. Team administration cannot grant
   `*`. A pipeline remains capped at `read, record`.
5. Policy clauses retain their meaning. `member` means anyone holding `answer`, not anyone on a team's roster.
   `role:` requires the named project role. `author` and `admin` clauses keep their current meaning. Only the
   source of a person's capabilities changes. `MAINWORTHY_REQUIRE_ADMIN_MFA` applies to a person who is an owner
   or admin of any team.
6. Membership invitations are separate from recovery. Joining a team as an existing person changes membership,
   without replacing credentials or revoking tokens or sessions. Several teams can have pending invitations for
   the same person. A team administrator cannot turn a membership invitation into account recovery.
7. Migration creates one team from the instance and moves every project into it. The mapping below deliberately
   does not convert partial project access into a role covering every project. Grant-set teams are dropped and
   their history retained. The archive version increases and older archives are refused, as in decision 0064.
   Before 1.0 there is no migration path beyond this conversion.
8. M8 excludes nested teams, custom membership roles, per-project role overrides for people, a team-wide policy,
   SCIM, billing and tenant isolation. Policy stays per project and the team's administrators set it.

| Membership role | Capabilities on every project of the team |
| --- | --- |
| `owner` | `read, record, produce, answer, plan, admin` |
| `admin` | `read, record, produce, answer, plan, admin` |
| `user` | `read, record, produce, answer, plan` |
| `viewer` | `read` |

A person can belong to several teams, with a different role in each. Team ownership differs from instance
ownership. Named project roles differ from both membership roles and capabilities.

## Authority follows the target

This matrix defines the accepted model, not the current admission rules. Team administration is performed by
people. The instance owner can perform every team action without membership. For other people, instance-wide
`admin` permits team creation and visibility; managing a team's members and projects requires that team's role.
An instance admin who is also a member uses that membership for those actions.

| Action, including current `admin` action names | Authorized caller | Target and restrictions |
| --- | --- | --- |
| `team.create` | Instance owner or instance admin | Instance; establish at least one owner when creating the team |
| `team.list` | Instance owner, instance admin, or team member | Instance admins see every team; members see their teams |
| `team.history` | Instance owner or team owner/admin | That team and its retained history |
| `team.member.add`, `team.member.remove`, membership invitations and role changes | Instance owner or team owner | Any role in that team; never remove or demote its last owner |
| The same membership actions | Team admin | Only users and viewers in that team; cannot appoint, demote or remove owners or admins |
| `project.create`, `project.demo` | Instance owner or team owner/admin | A project belonging to that team; existing demo restrictions still apply |
| `project.list` | Instance owner or caller with project access | Only projects the caller may reach; no access through a different team's membership |
| `policy.show`, policy changes | Instance owner or team owner/admin | A project of that team; changes still use the policy proposal and decision machinery |
| `actor.list`, `token.list` | Instance owner or team owner/admin | Team administration lists only that team's members and service actors or tokens; account details require instance authority |
| `token.create`, `token.revoke` for a service actor | Instance owner or team owner/admin | Agent or pipeline owned by that team, with grants only on its projects |
| `grant.set`, `grant.remove` for a service actor | Instance owner or team owner/admin | Per-project grants within the actor's owning team; pipeline cap applies; no `*` through team authority |
| Assign or remove a named project role | Instance owner or team owner/admin | A person and a project of that team; no capability or membership role is granted |
| Direct capability grants for people; `team.grant.set`, `team.grant.remove` | Removed from the team model | Membership roles replace these sources of project capabilities |
| `token.create`, `token.revoke` for a person; recovery invitations | Existing instance/account authority only | Team roles confer none; existing person-token and owner protections remain |
| `actor.forget`, credential and session administration | Existing instance/account authority only | Team roles confer none; removing a member does not forget their account |

Users and viewers have no team administration authority. Their project operations follow the capability table.
Personal-token self-service and other account operations retain their existing rules. An agent's current
instance-admin grant does not become team administration authority.

The implementation must authorize each team action against its target inside the operation's snapshot or write
transaction. Resolve the credential through `resolveCaller` on that connection, load the target team's membership
and role there, and apply the matrix before reading or mutating its data. For a project, resolve its owning team
on that connection. For a membership, invitation, service actor or token, derive its team from the stored target,
not just a team name supplied by the caller. Check both the current target role and requested role for membership
changes. Serialize membership changes so concurrent removals cannot remove the last owner.

Project-0 `admin` is not proof of team authority, and a team admin need not hold project-0 `admin`.
The `admin` operation's admission must therefore distinguish instance actions from team actions instead of keeping
its current blanket instance-admin requirement. `callerProjectCapabilities` must derive human project capabilities
from membership in each project's owning team, on the same connection, while preserving the instance owner's
exception and the pipeline cap. Its current grant union is not a target-team authorization check. Neither cached
session capabilities nor a check on a separate database connection authorizes the action. Existing recent-proof
and MFA requirements still apply where relevant.

## Migration mapping

Determine effective standing before dropping grant sets, including capabilities supplied by old team membership.
Do not infer a role from a grant on just one project, even if it contains `admin`.

| Existing state | Converted state |
| --- | --- |
| The instance and all its projects | One initial team; every project belongs to it, with its existing key |
| Person named by `MAINWORTHY_OWNER` | Initial team's owner, retaining independent instance-owner authority |
| Other people holding effective `admin` on `*` | Initial team's admins, retaining their instance-admin standing |
| Every other person, including a viewer of one project or an old grant-set member without `admin` on `*` | No membership; re-invite deliberately with a team role, granting no automatic team-wide access |
| Agents and pipelines | Initial team as owner; retain existing grants, expanding any `*` scope to the projects present at conversion so future projects are not silently granted |
| Old grant-set teams and memberships | Drop their standing model; retain attributed history |
| Existing project data and recorded decisions | Keep their history; do not reinterpret recorded answers under the new membership roles |

A named project role remains a separate assignment and cannot restore removed capabilities by itself. Old personal
capability grants cannot remain as a second route around the new membership model. Account identities and their
instance-level credentials remain independent of whether a person is re-invited.

## What this replaces and why

Once [issue #955](https://github.com/endqwerty/mainworthy/issues/955) lands, this supersedes
[decision 0064](0064-teams-and-effective-grants.md)'s grant-set definition, union of personal and team capability
grants, and its self-membership and team-grant administration rules. Its historical events remain evidence.
It also replaces the direct human capability grants, grant-set membership contribution, and instance-admin-only
team management described in [People, agents and pipelines](../guide/access.md), including its Grants, Named roles
and Settings descriptions. That guide describes the running code until the implementation updates it.
The new membership roles do not replace named project roles from decision 0054.

The second opinion recorded on the issue, GPT 6.1 Sol on 2026-10-25, argued for the flat alternative: keep projects
under the instance, add per-project role presets and retain grant-set teams. That would preserve finer project
access and avoid converting existing grants. It was turned down because a grant set still gives no authoritative
answer to who owns a project or may invite its members. Project-owning teams answer both, at the cost of fixed
team-wide membership capabilities and deliberate re-invitation for partial access. The owner accepted that trade-off
and the conversion rules on 2026-10-26.
