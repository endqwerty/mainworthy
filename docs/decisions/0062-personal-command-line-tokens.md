# 0062: Personal command-line tokens

- Date: 2026-10-15
- Status: proposed for issue #117.

A person who signed in with a password or a passkey had no way to use the CLI unless an admin made a token.
The existing tokens already reference an actor and read that actor's current grants.
They lose grants when the actor does, and forgetting the actor revokes them.

## Decision

Extend the existing `credential` instance operation with `token.create`, `token.list`, and `token.revoke`.
It needs `self`, requires a person, and adds no MCP tool.
Creation accepts a label and a lifetime, binds the caller as the actor, and changes no grants.
No actor, project, or capabilities can be supplied.
A personal token carries every current grant of its person, as an admin-issued token for that person does.
It does not claim to be an agent or a pipeline.

Creation requires a browser session opened with a password or a passkey, or local-owner access.
A bearer or a browser opened with a token cannot use this action to extend that token's lifetime. Such a browser can still set a password for a person who has none, sign in with it and then make a token; that gives nothing a password does not already give, since a password signs in again for as long as it stands.
The default lifetime is 30 days, and the maximum is 365 days. There is no unlimited personal-token option.

Reuse the `tokens` table, secret hashing, expiry, use tracking, and revocation.
No schema migration or new table is needed, and tokens remain excluded from archives.
A command with a creation reply stores only the registry's withheld-secret marker.
Retrying the same command returns conflict and makes no second token.

Settings, Your sign-in, shows the new secret in component memory until dismissed or the section is left.
It never enters the query cache or device storage.
The list shows every token of the caller, including those an admin made, without any secret or hash.
Revocation uses `mayActFor`, so a person may revoke their own and a human admin may revoke anyone's.
The owner's last working token is protected in the identity function shared with the admin operation.

There is no instance switch for personal tokens. A person already trusted with a password or passkey may use their own current grants from the CLI.
Operators can remove grants or forget an actor to remove access, and admins can revoke a token.
An extra switch would add another credential policy before one is needed.

## Alternatives

A browser-assisted `mainworthy login` would need a new exchange, callbacks, and local credential storage.
It can follow later if copying a token becomes a problem.
A separate operation would repeat the credential operation's self access and human restriction.
The three actions fit the existing credential ownership and reply-withholding rules.
A separate actor with copied grants would need grant synchronization and would change attribution.
