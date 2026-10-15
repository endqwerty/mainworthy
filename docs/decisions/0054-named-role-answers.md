# 0054: Named roles on grants and answer clauses

Date: 2026-10-14
Status: Accepted
Issue: [#53](https://github.com/endqwerty/mainworthy/issues/53)

## Problem

`strict` can require a reason and exclude an evidence producer, but it cannot name an approver role.
Accounts and capabilities alone cannot express that distinction.

## Decision

Implement roles and one-person role approval as the first slice. Keep the existing presets selectable as before.
A regulated preset still needs independent two-person approval, freeze semantics, and gap waivers.

A personal grant stores a deduplicated list of role names beside its capabilities.
Team grants supply capabilities only and reject role assignments. Membership alone gives no named role.
This keeps each approver explicitly assigned while teams manage shared permissions.
A personal role can combine with `produce` and `answer` from a team in the same project.
Changing team membership can therefore change whether that person is eligible to answer.
The identity module resolves global and project roles together when a request names its project.
`grant.set` is still the only grant editor. Omitted roles preserve membership; an empty list clears it.
Token and invitation creation keep existing grants. Human instance admins assign roles under the existing self and owner guards.
The owner has no implicit named role. Separate accounts can hold approver roles.

A policy clause uses `who: "role:approver"`. The shared `standingOf` function requires the role and `answer` capability.
An agent may hold a role. With `agents: "answer"`, its answer counts when it meets the other conditions.
Use `agents: "none"` for a sign-off that requires a person.
It also applies the existing agent and producer conditions. `decide` still requires `produce` before checking standing.
Revocation affects later answers and withdrawals without changing past decisions.
Reader threads resolve current roles from credential references inside their snapshots.
The archive-worker contract carries roles when restoring the local owner.

Refuse a policy proposal, and refuse its later acceptance, if a role clause has no eligible holder in that project.
The holder needs `produce`, `answer`, the role, and an actor kind the clause permits to answer.
Global and project grants combine; another project's roles do not count.
This checks membership before any particular evidence exists, so producer independence still applies when answering a question.
An admin can restore a removed grant to accept a waiting policy proposal, or reject that proposal.
Removing the last holder after adoption is allowed and can leave questions waiting until an admin assigns the role again.
Every later policy proposal that retains the role clause is refused while it has no eligible holder, including settings-only edits.
Restore a holder or remove the role clause in the proposal. The validation remains the same for every policy edit.

## Alternatives and module boundaries

A separate `who: "role"` branch with a required `role` field is valid but adds object alternatives to the policy schema.
The prefixed selector expresses one choice in one field, like the existing `answer:` predicates, and avoids a role field on unrelated selectors.
A separate role registry would add lifecycle rules before there is a need for role metadata.

The core owns `Role`, `Ask` and eligibility. Identity owns stored grants and resolves an actor's effective roles.
The existing admin operation and CLI adapter edit grants. Clients render the server's `needs` and `you` values.
No new operation, alternate decision writer or witness path is added.

## Storage and limits

Migration 0018 adds `grants.roles TEXT NOT NULL DEFAULT '[]'`.
It changes an exported table and advances the archive version from 17 to 18. Older archives are refused; this release requires an export from the new schema.
MCP's tool listing hides the role selector to keep the existing token ceiling and tool descriptions.
HTTP, the CLI and the web accept it through the core schema, as does an MCP call that supplies it.

## What remains of issue 53

Grant and role changes still have no attributed change history. A command id records its actor and request digest,
but neither grant values before and after the change nor the role that made a past answer count.
An attributed grant ledger and a record of the role used at sign-off remain part of issue 53.
Adding them requires storage, archive and reading contracts beyond this role-membership slice.
Two-person approval, frozen evidence, gap waivers and the regulated preset also remain open.
This slice does not establish regulatory certification.
