# People, agents and pipelines

Decide who may do what in each project, give a person, an agent or a pipeline a token, and take it away again. An instance admin holds `admin` on every project and can issue tokens. People can also make their own command-line tokens without admin rights.

Only a person who administers the instance changes grants. An admin-issued token for an existing person needs that person or the owner.

## Kinds of actor

An actor makes each change in Mainworthy, and the record names who made it. There are four kinds of actor:

- A person. Someone who reads, writes and answers. The queue and the web UI are built for people.
- An agent. An AI tool that reviews changes, proposes edits and reports results. [Let an agent in](./agents.md) covers it.
- A pipeline. A CI job that reports results and reads the gate.
- The policy. A rule that answers a question on a project's behalf. It holds no grant and no token, and you do not create it.

An actor has a name, a kind and grants. There are no seats, so an actor costs nothing. A token proves who is calling, and a person can also [sign in as themselves](#sign-in-as-yourself) with a password or a passkey. A name uses letters, digits, `.`, `_`, `@` and `-`, starts with a letter or digit, and runs up to 64 characters.

## Capabilities

A grant lists capabilities, and a capability is permission to call a group of operations.

<!-- generated:capabilities -->

| Capability | Operations it allows | Held by default by |
| --- | --- | --- |
| `read` | `attachment`, `inbox`, `get`, `find`, `impact`, `since`, `gate`, `history`, `timeline`, `check`, `stats`, `command`, `tracker-status`, `handoff-status` | a person, an agent |
| `record` | `attach`, `report`, `change`, `announce`, `work`, `gate` | a person, a pipeline |
| `produce` | `propose`, `import-csv`, `claim`, `tracker`, `decide` | a person, an agent |
| `answer` | `handoff` | a person |
| `plan` | `plan` | a person |
| `admin` | `audit`, `admin`, `invitation` | a person |

A pipeline holds `read` and `record` at most, whatever its grant lists.

<!-- /generated -->

`produce` includes `record`. You need `produce` to send an answer. The [policy](./policy.md#what-a-policy-is) decides whose answer counts. A member clause needs `answer`. An admin clause needs `admin`. Subject to its other restrictions, an author clause allows the proposal's author or an admin who is a person.

A person with only `read,record` can claim and release run slots, record Pass, Fail, Blocked or Skip, and attach evidence to their own results in the web cockpit.
They can also correct their last result in an open run.
The iPhone app lets them record these outcomes and correct their last result in an open run. It can read attachments but does not upload them.
Case edits and answers need `produce`. Starting a run needs `plan`. Withdrawing a sign-off to reopen a closed run needs the permissions that answer requires.

A new person gets all six capabilities, a new agent gets `read` and `produce`, and a new pipeline gets `record`. These defaults apply only when you make a token for a name that does not exist yet and give no `--can`.

## Grants

A grant says what an actor may do on one project, or on every project. A grant on every project shows as `*`. An actor can hold both, and the two add up.

```
$ mainworthy actor list
rule   policy  no grant
human  robin  *  read, record, produce, answer, plan, admin
agent  reviewer  scratch  read, record, produce, answer
ci     github-actions  scratch  read, record
```

To change a grant, use `grant`. The command replaces the actor's capabilities for that scope, so list every capability you want the actor to keep.

```
$ mainworthy actor grant reviewer --can read,produce --project checkout
reviewer on checkout: read, produce
$ mainworthy actor ungrant reviewer --project checkout
reviewer holds no grant on checkout any more
```

Leave out `--project` to change the grant on every project. Only a person changes a grant: an agent that holds `admin` is refused. You cannot change your own grant, because a slip could lock the instance. Another admin does it. Nobody changes the owner's grant. Mainworthy writes that grant again at every start.

### Named roles

A personal grant can also list named roles. Team grants provide capabilities only and reject role assignments. A custom policy can require a role such as `approver` before an answer counts.
A role does not give capabilities. The actor still needs `produce` to send an answer and `answer` for a role clause to count it.
Team permissions can supply `produce` and `answer` for a personal role. Team membership alone gives no named role.
Roles on every project and roles on one project add up. A role on another project gives nothing here.

```
$ mainworthy actor grant reviewer --can read,produce,answer --roles approver --project checkout
reviewer on checkout: read, produce, answer; roles: approver
```

Role names use lowercase letters, digits and `-`, start with a letter, and have at most 32 characters.
`--roles` accepts commas or repeated flags. To keep the grant's roles, omit `--roles`. To clear the roles, use `--roles=`.
Removing a grant removes its roles. A new token or invitation for an existing actor keeps their roles.
Settings, People and `mainworthy actor list` show the roles with their grants. Assign them through the command above or the `admin` operation's `grant.set` action.

Only a person who administers the instance can change roles. The existing guards for self and owner grants also apply.
The owner has no implicit named role and cannot be assigned one through `grant.set`. Use separate people as approvers.
Changing roles affects later answers and withdrawals. It leaves recorded decisions in place.
An agent can hold a role and give a counted answer if the clause permits agent answers.
Grant and role changes do not yet have an attributed change history.

The owner is the person named by `MAINWORTHY_OWNER`. See [configuration](./configuration.md).

## Make your own command-line token

Sign in with your password or a passkey, then open Settings, **Your sign-in**, **Your command-line tokens**. A provider session can also create a token after you prove an existing password, passkey or authenticator code.
Creating a personal token or issuing any token under **Tokens** requires proof of
your own credential within ten minutes in that browser session. Settings asks
inline when needed and retries after proof. Admin token issuance with a bearer
token and local CLI issuance keep their existing authority.
If you signed in with the owner token and have no credential yet, add a password or passkey in **Your sign-in**, then return to **Tokens** and confirm that credential when asked.
If your only sign-in method is a provider identity, ask the owner for a recovery link and accept it with a password or passkey before creating a personal token. Adding a local credential from that provider-only session requires proof too.
You need no admin capability. As the local owner, you can make one without signing in.

To create a personal token, follow these steps:

1. Enter a **Token label** that says where you use it.
2. Choose a **Token lifetime**. The default is 30 days, and the longest is one year.
3. Choose **Create personal token**.
4. Choose **Copy personal token**.
5. Store the token in your shell or script's secret store.
6. When you have stored the token, choose **Dismiss personal token**. Leaving the section also clears the secret from the page.

Set `MAINWORTHY_URL` to your instance's address and `MAINWORTHY_TOKEN` to the token, then run the CLI:

```
$ mainworthy find --json '{"in":"cases","limit":10}'
```

The token acts as you, with your current personal and team grants on each project. Making it changes no grants.
A grant removed from you is removed from every token of yours. Forgetting you stops them all.
Changing your password does not revoke tokens. Do not give a personal token to an agent or a pipeline that needs its own identity.

The list shows only your tokens, including any an admin made for you, with their ids, labels, creation and last-use times, expiry, and revocation.
Choose **Revoke** beside a token to stop it immediately. Your password or passkey session stays signed in.
The owner's last working token stays until another is made.
A missing creation reply may mean a token was made but its secret was lost. Check the list, revoke that token, and make another.

The same list and revocation work from the CLI:

```
$ mainworthy credential --json '{"do":"token.list"}'
$ mainworthy credential --json '{"do":"token.revoke","id":2}'
```

The `credential` operation accepts `token.create` with `label`, optional `expires` such as `12h` or `30d`, and optional `cmd`.
The reply holds `id`, `actor`, `token`, and `expiresAt`, a Unix timestamp in milliseconds.
An expiry is required internally, defaults to `30d`, and cannot exceed `365d`.
A command id prevents a repeated creation. Its secret reply is never saved, and a retry receives `conflict`.
Creation accepts no actor, project, or grants. It requires a browser session opened with a password, passkey or identity provider, plus recent proof of an existing password, passkey or authenticator code, or local-owner access. A provider sign-in alone does not supply that proof.
A bearer token and a browser signed in with a token cannot make a personal token.
There is no instance setting to disable personal tokens. An admin who is a person may revoke another person's token by id, as with other credentials.

## Teams

A browser setting a personal or team grant that includes `admin`, or adding someone to a team holding `admin` on any project, requires recent proof of the caller's own credential. Settings asks inline for team changes. Bearer-token and local CLI grant and membership changes retain their existing authority. Non-admin grants and removal operations keep their existing rules.

A team is a named set of grants. A person's effective permissions are their own grants plus the grants of every team they belong to. Grants on one project and on every project add up. Removing a person from one team takes away that team's contribution immediately, including requests waiting to run. A personal grant or another team's grant still applies.

To create a team and assign its permissions, open Settings, People, and follow these steps:

1. Enter a name in **New team name**.
2. Press **Create team**.
3. Choose the team under **Team to manage**.
4. Choose the project scope under **Grant on**.
5. Tick **Team permissions**. The new grant replaces the team's grant in that scope, so tick every permission to keep.
6. Press **Set team grant**.
7. Select **Person to add**.
8. Press **Add team member**.

**Remove grant** removes just the chosen project grant. **Remove member** takes a person out of the team in one step. Each person's row shows their own grants and a separate line for each team's grants.

Only a person who administers the instance manages teams. Agents, pipelines and the policy cannot join. Another admin changes your membership or the grants of a team you belong to. The owner keeps every capability independently and cannot join a team. A team with `admin` on every project lets every member administer the instance.

The API uses the existing `admin` operation, at `POST /api/admin`. The same actions are available through the generated command line:

```
$ mainworthy admin --do team.create --name Quality
$ mainworthy admin --do team.grant.set --team Quality --project checkout --can read,produce
$ mainworthy admin --do team.member.add --team Quality --person sam
$ mainworthy admin --do team.list
$ mainworthy admin --do team.history --team Quality
$ mainworthy admin --do team.member.remove --team Quality --person sam
$ mainworthy admin --do team.grant.remove --team Quality --project checkout
```

Leave out `--project` for a grant on every project. `mainworthy actor list` labels grants received from a team. With an older API-version-1 server that omits team membership or roles, the CLI and People still show personal grants. Missing roles mean an empty role list. `team.history` lists creation, membership changes and grant changes with the person who made each change, its time, and the affected person or project. Repeating an action with the same `cmd` returns its original reply without adding another event. Forgetting a person removes their memberships and shows their pseudonym in team history. Teams, grants, memberships and this history travel in an [archive](./data.md#export-everything).

## Make a token

A token is a secret that stands for one actor. An agent or a pipeline sends it with each request, and a person types it to sign in.

To create an admin-issued token in Settings, follow these steps:

1. Open Settings with <kbd>g</kbd> <kbd>,</kbd>.
2. Open Tokens. Use <kbd>j</kbd> to move down the sections.
3. Press <kbd>n</kbd> to enter "Token actor".
4. Fill in the actor's name.
5. Pick Agent, Pipeline or Person under "Producer" to match the actor's kind.
6. For a new actor, tick the "Permissions". For an existing actor, these controls are disabled and its grants stay unchanged.
7. Choose "Create token".

The new secret appears once, with "Copy token" and "Dismiss secret". A token carries its actor's current grants on every project.
A new actor starts with the selected permissions on the project you are in. For an existing actor, the form shows their personal and team grants, including project names and roles, and sends no new permissions when it makes the token. An actor with no personal grants, or only team grants, can still get a token. Change personal grants with `mainworthy actor grant` (`grant.set`), and manage team grants in Settings, People. While actor access is loading, creation waits. If the form cannot read actor access, it says so. A forgotten actor cannot get a token, and the form says so before submission.

From the command line:

```
$ mainworthy token new --agent reviewer --can read,produce
token for agent "reviewer" (read, record, produce)
<token>
Shown once. It will not be shown again.
```

Use `--human` for a person and `--ci` for a pipeline. For a new actor, add `--project <key>` to give its initial grant on one project. Without it the initial grant covers every project. For an existing actor, `--project` does not limit the token's access. Use `mainworthy actor list` to check its grants before making a token.

Mainworthy shows a token once and keeps only a hash, so it cannot show it again. If you lose one, revoke it and make another.

The Tokens section and `token new` command need instance admin capability. For your own token without admin, use **Your sign-in** as described above. Who may make an admin-issued token depends on whose it is. Any instance admin can make a token for an agent or a pipeline. Only a person who administers can add a new person. An existing person's token needs that person or the owner, and the owner's token needs the owner alone. Whoever holds a person's token acts under that person's name. Mainworthy refuses a name that starts with `forgotten-`.

Making a token for a name that exists adds a token to that actor and does not change its grants. Naming a different `--can` for an existing actor is refused. Use `actor grant` for that.

## Give a token an end

An admin-issued token works until you revoke it, unless you give it an expiry. A personal token always expires. `--expires` takes a whole number and `h`, `d` or `w`:

```
$ mainworthy token new --ci github-actions --project scratch --expires 90d
```

In Settings, Tokens, choose "Expires" before you create the token: never, 30 days, 90 days or 1 year. A token past its end is refused exactly as a revoked one is. A browser that signed in with the expired token is also refused.

To replace a token without a gap, follow these steps:

1. Make a second token for the same actor.
2. Replace the first token wherever you use it.
3. Revoke the first token.

Two tokens of one actor work side by side. Each start of the server names every token that ends within 14 days, by its id, actor and label.

## See and revoke tokens

Settings, Tokens, and Settings, People, show "Issued tokens". The list includes each token's number, label, actor, issuer, creation time, last-use time and address, and expiry. A token with no recorded use says "never used". Forgetting a person reads this list again, so their tokens show the forgotten name and revoked state. The actor is who the token identifies. The list cannot tell which person held a shared token. "Revoke" next to a token stops it at once. In server mode the last token the owner can sign in with is not revoked. Make the owner another one first.

```
$ mainworthy token list
1  agent reviewer  agent token  active  made by robin  last used from 203.0.113.9
2  ci github-actions  ci token  active, expires in 90 days  made by robin
$ mainworthy token revoke 2
token 2 revoked
```

The server reads your token or session, your actor and your grants in the same snapshot that runs an operation. A read waiting for a pooled connection sees a grant removed before it starts. Before sending a read reply, the server checks the project, caller's grant and required capability again; if the project was replaced, it reads the replacement instead of returning the old project's data. A report already accepted keeps its actor and finishes even if that actor's token is then revoked.

A token with no end works until somebody revokes it, so revoke one you no longer use. Revoking a token leaves the actor and its grants in place. To stop an actor on one project, use `actor ungrant`. To remove who a person was, forget the actor. Only a person who administers forgets an actor, and the owner is not forgotten. The name becomes a pseudonym made from `forgotten-` and the actor's number. If an archive imported from an older build already holds that name, Mainworthy adds `-2`, `-3` or a later suffix. The tokens stop working. Mainworthy revokes the person's passwords, passkeys and open invitations. The history keeps what the actor did.

Forgetting also clears the person's token and credential labels, including labels on revoked rows. Question evidence, saved command replies and report receipts use the pseudonym for attribution. New questions keep actor ids and resolve names when read. Forgetting rewrites display names saved by older builds. This leaves the evidence hash unchanged because it covers the decision's material basis and target, not display attribution. Command ids still name the same requests, so retrying a command does not repeat the write. Replies that held secrets remain unavailable. Text in cases and notes stays as written.

```
$ mainworthy admin --json '{"do":"actor.forget","name":"dana"}'
{"forgotten":"forgotten-5","tokensRevoked":0}
```

The raw operation remains available. The page and shorter command are described in [Forget a person](#forget-a-person).

## Add an authenticator for password sign-in

In Settings, open **Your sign-in**, then choose **Add an authenticator**.

If confirmation is needed, use a password or passkey you already added. The
confirmation offers an authenticator code only when an authenticator is enrolled.
If you signed in with only a token, add your first password or passkey in
**Your sign-in**, then choose **Add an authenticator** again and confirm that credential.

To enrol the authenticator, follow these steps:

1. Scan the QR code with a TOTP authenticator, or enter the setup key by hand. Mainworthy generates the QR code on the instance without contacting another service.
2. Enter the six-digit **Authenticator code**.
3. Within five minutes, choose **Confirm authenticator**.
4. Save the ten recovery codes somewhere private.
5. Choose **I saved the recovery codes**. Mainworthy shows these codes once. Each code works once with your password.

Your other sessions end when you confirm. Your current session stays signed in. The next password sign-in shows **One more step**. Enter a fresh authenticator code or an unused recovery code. The password alone opens no session. A passkey with user verification needs no extra code.

If you choose a passkey during **One more step** and cancel, restart password sign-in before entering a code.

Authenticator codes change every 30 seconds. Mainworthy allows the previous and next 30-second step for clock differences and refuses a code already used. Wait for a new code if you just confirmed enrolment. Wrong sign-in codes count against your account and the request address. Re-entering the right password does not clear failed-code attempts. Enrolment has a separate failed-code count, so setup typos do not block sign-in codes.

The credential list identifies your authenticator without showing its setup key or recovery codes. **Remove** removes it and ends all your sessions. Removing your own authenticator uses your signed-in session and does not ask for a fresh code. To replace lost recovery codes, remove the authenticator and enrol again from a session you can still open. Otherwise, ask the owner for a recovery invitation.

An instance that requires a second factor for admins keeps an admin's authenticator while that person still has a password. The requirement covers personal and team grants on any project. An admin recovery invitation on such an instance must be accepted with a passkey. An admin password without an authenticator does not count as a working sign-in method. Add another passkey or enrol an authenticator before removing the last usable passkey.

The [configuration](./configuration.md#require-a-second-factor-for-admins) page describes the admin requirement. The [command line](./cli.md#sign-in-with-a-password-and-a-code) and [iPhone app](./iphone.md#sign-in) also support the second step.

## Forget a person

In Settings, open **People** and find **Forget a person** below the list of people.

To forget a person, follow these steps:

1. Choose the person in **Person to forget**. Your own name and the current owner's name are unavailable, with the reason beside each.
2. Press **Forget this person**.
3. Read what forgetting erases and what stays.
4. To confirm, press **Forget** followed by the person's name.

The confirmation takes the keyboard focus. **Cancel** or <kbd>Esc</kbd> closes it without changing anything and returns focus to **Forget this person**.

The warning names the sign-in data that forgetting erases, including linked provider identities, recovery email addresses, authenticator secrets and recovery-code hashes. It also names token network addresses and labels, and explains that team memberships are removed. History, attachments and typed case and note text stay. Some sign-in records and request fingerprints stay too. [Privacy](./privacy.md#your-rights-with-respect-to-your-information) describes those retained records.

The page shows the pseudonym and the number of tokens revoked. It reads the people and invitations again and removes any invitation link it was showing for that person. If no reply comes back, it reads the lists again. If the person is no longer listed, the page says so and clears the confirmation. Otherwise, retrying the same confirmation uses the same command id.

From the command line, `mainworthy actor forget dana` prints the warning and makes no change. After reading it, repeat the name to confirm:

```
$ mainworthy actor forget dana --confirm dana
Forgotten as forgotten-5. 0 tokens revoked. History and typed text stay.
```

Add `--json` for the pseudonym and the number of revoked tokens as JSON. Both the page and the command use the same admin operation. `actor list --json` identifies the current owner with `owner: true`. If an older server does not identify the owner, the page keeps forgetting unavailable. You must be a person who administers the instance. You cannot forget yourself or the current owner. To forget the current owner, first [hand the instance to somebody else](./configuration.md).

A person cannot yet request forgetting inside Mainworthy or delete their own account. Ask the person who runs your instance. For `mainworthy.com`, follow [Privacy, changes and questions](./privacy.md#changes-and-questions). See [Privacy](./privacy.md#your-rights-with-respect-to-your-information) for retained records and typed text.

## Sign in as yourself

A person can sign in with their email address or their name and a password, or with a passkey, and needs no token for it. A person gets their first way in through an invitation link. An admin copies it or sends it by mail when [SMTP is configured](./configuration.md#turn-on-mail). Nobody chooses a password for somebody else.

Manage invitations and sign-in methods in Settings. The sections below also list the commands and API requests for scripts.

### Invite a person

If your first sign-in used the owner token and you have no credential yet, add a password or passkey in **Your sign-in**, then return to **People** and prove it when asked.

Making any invitation from a browser requires recent proof of your own credential, even for a read-only invite. Settings prompts inline and retries after proof. Bearer-token and local CLI invitations keep their existing authority.

In Settings, open People. This section is visible to a person who holds `admin` on every project. To invite a person, follow these steps:

1. Type the person's name. <kbd>n</kbd> puts the caret in the field.
2. Tick what they may do. The form starts with `read`, `record`, `produce`, `answer` and `plan`. `admin` starts unticked. Tick it for somebody who should administer the project. On every project, `admin` also lets them invite people, issue tokens, create projects and change grants.
3. Choose one project, or every project.
4. Choose how long the link works, from 12 hours to 30 days. Three days is the start.
5. Press "Make invitation link".

The link appears once, masked, with "Copy link". Copy it and hand it to the person. "Dismiss link" takes it off the page, and so does leaving the section. Nothing shows it again. If no answer comes back when you make a link, the page says so and reads its lists again. A person who is in the lists was invited, but the invitation link is lost. A recovery link is then their way in.

With mail enabled, the form also offers **Send to email address, optional**. The CLI accepts `mainworthy invite new robin --email robin@example.com`, and the API accepts `email` on `invitation` with `do: "create"`. The recipient gets the same single-use link and expiry. The reply still shows the link once so you can deliver it yourself if mail fails. Sending an invitation does not verify or save a recovery address.

"Open invitations" lists the links nobody has accepted yet: who each is for, what that person may do, who made it and when it runs out. "Revoke" withdraws one.

To create an invitation from the command line, run `mainworthy invite new`:

```
$ mainworthy invite new dana --can read,produce,answer --project checkout
invitation 1 for "dana" (may read, record, produce, answer on checkout), until 2026-10-16 09:57 UTC
https://mainworthy.example/invite#<code>
This link is shown once. Hand it to dana: it works once.
```

Command-line invitations follow these rules:

- The link is printed once. Mainworthy keeps only a hash of the code in it, so it cannot print the link again. If it is lost, make another.
- The link works once, for three days. `--expires` takes a whole number and `h`, `d` or `w`, up to `30d`. A new invitation for the same person replaces the one before it.
- `--can` and `--project` say what a new person may do, as they do for a token. Without `--can` a new person may do everything.
- The link starts with the address in `MAINWORTHY_PUBLIC_URL`. With that variable unset, the command prints `/invite#<code>` and tells you to put the address of the instance before it. See [configuration](./configuration.md#variables-the-server-reads).
- Only a person who administers invites somebody. An agent that holds `admin` is refused.

`mainworthy invite list` shows every invitation, who made it, whether it is open, used, revoked or expired, and what its person may do on which project. It never shows a link. `mainworthy invite revoke <id>` withdraws one that nobody has accepted.

### Accept an invitation

Open the link. The page says "You are invited as dana" and until when the link works. To accept the invitation, follow these steps:

1. Choose a password, a passkey, or both:
   - For a password, type the password twice. The page counts the characters as you type. A password is 12 to 256 characters. No digit, capital letter or symbol is required.
   - For a passkey, tick "Make a passkey on this device". Give the passkey a name. The default is the name of your browser.
2. Press "Accept and sign in". You are signed in and the app opens.

The page takes the code out of the address bar as soon as it has read it. The address you see, and the one Back returns to, has no code. Copying that address does not copy the invitation. The browser's own record of the address first opened still holds the whole link. The code is the part after the `#`. The browser does not send that part of the address to the server. If you reload the page, open the original link again.

If the browser is signed in as somebody else, the page names them and asks before signing them out. The fields stay disabled until the page knows who is signed in and you answer. If the request fails or takes more than twenty seconds, the page says so and keeps the fields disabled. **Try again** checks once more and keeps the invitation.

Your confirmation applies to the person the page named. If the acceptance request carries a different person's cookie, the server accepts nothing and the page asks about that person instead. **Stay signed in** leaves the invitation unchanged.

Two sign-ins already in flight can each finish and set this browser's cookie. The last response chooses who this browser is signed in as. A session whose cookie was replaced can remain open on the server, because the earlier request did not carry that cookie. Sign in as that person and end it in **Your sessions**, or leave it to expire after 14 days without use, at the default lifetime. This does not end their sessions on other devices.

If no answer comes back when you accept, the page says that it cannot tell whether the invitation was accepted. Go to the sign-in page and try what you chose. If sign-in succeeds, the invitation was accepted.

A link that was used, was revoked or has run out says "This invitation does not work any more." So does one that was cut short when it was copied. Ask whoever sent it for a new one.

A script accepts an invitation with `POST /api/login`. [API](./api.md#sign-in-as-a-person) has the request.

### An email address or a name and a password, or a passkey

Mainworthy normalizes passwords to Unicode NFC before hashing and checking them. An accented letter such as `é` matches the same letter entered as `e` followed by a combining accent, including from an iPhone keyboard. Compatibility characters such as full-width letters stay distinct. Passkeys and the PIN or biometric check that unlocks them are unchanged.

A password stored before this change still accepts its original spelling. For an older non-NFC spelling, the first successful sign-in with that spelling refreshes its hash. After that refresh, canonical spellings both work. Until then, a different spelling may fail. Refreshing the hash keeps existing sessions signed in. Changing a password accepts the original spelling of an older password too.

Sign in on the sign-in page with your email address or your name, and your password, or choose "Sign in with a passkey". The email address is the one set under **Your sign-in**, **Email**. A name wins over another person's email address that reads the same. A wrong email address, name or password gets the same message: "That email or name and password did not sign you in." A wrong token and a refused passkey each have their own message. After too many failed attempts, the page says how long to wait.

A script signs in with `POST /api/login` and `{"name": "dana", "password": "..."}`, where `name` can also be the person's email address. Failed attempts are counted against what was typed, so a person's name and address are counted apart, and a blocked name tells nothing about whose an address is. A successful sign-in with the exact name clears that name's count; one with an email address clears nothing, since the same text in another case can be somebody else's name. When the server checks and refuses those credentials, it replies `unauthenticated: that did not sign you in`. The reply does not say whether the name exists or the password was wrong. The server logs the reason as a code, never the name or password tried.

A passkey is a key that a device or a password manager holds and unlocks with a fingerprint, a face or a PIN. It needs `MAINWORTHY_PUBLIC_URL`, because a passkey belongs to the host name people open the instance at. One made at `https://mainworthy.example` does not sign in at another name of the same instance. Without that variable the pages offer no passkey. [API](./api.md#sign-in-as-a-person) lists the requests a page makes to register and use one.

To set or change your password, open Settings, **Your sign-in**. <kbd>n</kbd> puts the caret in the new password. Changing a password asks for the current one. The server ends other sessions opened with the old password, and the page says how many. The browser making the change stays signed in, and the page empties the fields.

Adding or removing a password, passkey or authenticator, changing your recovery
address, and linking or removing a provider identity need recent proof of your
own credential. Password or passkey sign-in counts for ten minutes in that
session. When proof is older, Settings asks inline for your password, passkey or
six-digit authenticator code, showing only methods you have already added, then retries the change. A recovery code alone does
not count. Another browser's proof does not count for this session.

An admin removing somebody else's credential, or the owner changing their
recovery address in **People**, proves their own credential. A bearer token
cannot provide session proof. Use a signed-in browser for these changes. The
local-mode owner, invitation acceptance, and recovery links need no prior proof.
If you have no live credential, adding your first password or passkey needs no
prior proof either. Add it in **Your sign-in**, then retry and prove it before
setting or removing a recovery address or enrolling an authenticator. If you have
only a provider identity, ask the owner for a recovery link to establish a
password or passkey first. The last usable way to sign in stays even after proof.
Removing a credential that this session rests on ends the session.

Making any invitation or recovery link from a browser asks for the admin's recent proof.
If you lost every credential, the operator can still issue a link with their
owner token or the local CLI. Accepting the link needs no prior proof.

A password manager such as 1Password can generate a password, fill both new-password fields and save it under your name. The fields tell password managers the allowed length. The sign-in page asks them to ignore the token field. A bearer token cannot change a password. If no reply comes back, the page says it cannot tell whether the password changed and reads your sign-in methods again. Try signing in with the new password to find out.

To add a passkey, give it a name under "Passkeys" in the same section and press "Add a passkey". "Ways you sign in" lists your password and each passkey with when it was last used, and "Remove" beside each. Your last way of signing in has no working "Remove".

Failed attempts are counted. The fifth wrong password for one name within 15 minutes blocks password sign-in for that name for one second, from every address. Each further wrong password doubles the wait, up to 15 minutes. A blocked sign-in is answered `limited`. The credentials are not checked, so the right password waits too. A name nobody has is counted the same way, so the count does not say which names exist. A passkey is not held up by a block on the name. [Troubleshooting](./troubleshooting.md#limited-too-many-attempts) says what to do.

The same limit applies to the current password when changing it. Password attempts already waiting to be checked stop if the name or address becomes blocked. A check that finishes during a block returns `limited` too. A successful check never clears a block that began while it was running, even if that block has since expired.

Starting a passkey or provider sign-in has a separate limit of 300 successful starts per public IPv4 address or IPv6 /56 in one minute.
Web and iPhone starts share it. People sharing that address or network share its allowance too.
A blocked start says how long to wait, with `429 limited` and `Retry-After` seconds in the API.
The wait never escalates, and retries do not extend it. No instance-wide start allowance lets another network block your first attempt.
Unavailable passkey options and an unreachable provider do not spend the allowance. Signed-in provider linking and a working invitation bypass it.

Ordinary starts never add to failed-credential counts or cause a password refusal. Wrong invitation codes still count as failed proofs.
Password sign-in keeps the failed-attempt rule described above. Valid answers to pending passkey/provider ceremonies can still finish during a start limit.
A working invitation opens its form and can be accepted with a password or passkey during an address block.
Reloading it reuses its passkey challenge; with one minute left, a successor preserves an ongoing prompt until its original deadline.
The page uses the remaining lifetime supplied by the server.

Pending ceremonies still have a memory limit. At capacity, the source holding the most live ceremonies loses its oldest entry,
so a large flood does not discard a small unrelated source's pending sign-in. If sources hold equal shares, an oldest entry can still be displaced.
A client controlling many independent IPv4 addresses or /56 networks can appear as many sources; the server cannot identify them as one person.
The address follows the instance's [proxy configuration](./configuration.md#run-behind-a-proxy-that-ends-tls).
Unknown and private addresses are not counted and share one retention bucket, so configure the proxy to distinguish visitors.

### Through an identity provider

An instance can let people sign in through an OpenID Connect identity provider, such as Okta, Microsoft Entra ID, Google Workspace, Keycloak or Authentik. Whoever runs the instance [sets it up](./configuration.md#sign-in-through-an-identity-provider). The sign-in page then has a "Sign in with" button named after the provider.

The provider says who signed in. Mainworthy decides which person that is here, and it never decides by an email address or a name the provider sends. An identity reaches a person in one of two ways:

- **An invitation.** On the invitation's page, choose "Accept with" and the provider's name instead of setting a password. The identity becomes the person's way in. A recovery invitation accepted this way replaces every other way in, as one accepted with a password does.
- **Linking.** A person who is signed in opens Settings, **Your sign-in**, and chooses "Link" with the provider's name. The browser goes to the provider and comes back to that section.

An identity belongs to one person at a time. Linking one that somebody already has is refused. "Ways you sign in" lists it with the provider's name and the email the provider gave. Removing it, or forgetting the person, erases the identity, and it can be linked again later. An identity counts as a way in: with it, a person can remove their password. When admins must use a second factor, an admin signs in through the provider only if the operator has said the provider asks everybody for one (`MAINWORTHY_OIDC_MFA=true`). Without that, becoming an admin ends the person's sessions opened through the provider, as it ends password sessions. An identity counts as a way in only while the instance is configured with its provider: after the provider is removed or replaced, the last password or passkey stays.

An identity the provider vouches for that nobody here has linked does not sign in. The page says "That did not sign you in." An admin invites the person, or the person links the provider from a session they have.

The [iPhone app](./iphone.md#sign-in) also offers the configured provider. Its system browser sheet returns
a one-time code to the app, which exchanges it for a session of its own. The provider identity must already
be linked to your person. Operators register the additional callback
`MAINWORTHY_PUBLIC_URL/api/login/oidc/native/callback` at their provider, alongside the web callback.

### A lost password or passkey

With mail enabled, **Forgot your password?** on the sign-in page opens a reset request. Enter your verified email address. The page gives the same answer for known, unknown and unverified addresses. Requests are counted per email address and client address by the failed-attempt limiter, including its exemption for private and loopback client addresses. The sixth request inside the counting window waits one second, and later requests increase the wait. A public client's count is shared with failed sign-ins. [Configuration](./configuration.md#run-behind-a-proxy-that-ends-tls) describes how a proxy supplies the client address.

The reset link works once for 15 minutes. It replaces your password and ends all your sessions, without signing you in. Your passkeys and tokens stay, and an enrolled authenticator is still required for password sign-in. A later password change, address change, accepted admin recovery invitation, reset request or archive import invalidates the link. Restarting an instance does not invalidate a pending link. Losing your authenticator still needs a recovery code, a passkey or an admin recovery invitation.

To set a recovery address, follow these steps:

1. In **Your sign-in**, set your address under **Email**.
2. Open the verification mail.
3. Press **Verify email**.

The link works once for 24 hours. Until you verify, the address cannot receive reset links or sign-in method notices. The instance owner can set an address under a person's **Sign-in details**, but the person who holds that mailbox must still verify it. As with recovery invitations, another admin cannot change someone else's recovery address. The API uses `credential` with `do: "email.get"` or `do: "email.set"`, an optional `actor`, and `email` on set. Set `email` to `null` to remove it. Changing it needs a signed-in browser for your own address, or the instance owner for somebody else's.

As with adding a passkey, the browser session is sufficient without re-entering an existing credential. With mail enabled, replacing or removing a verified address sends a notice to the previous address. That notice contains no verification or reset code. If you did not make the change, the notice asks you to contact an instance admin. You can remove a stored address through the API even after mail is switched off, when no notice can be sent.

Without mail, **Email** under **Your sign-in** still saves an address, with **Save email address**. Nothing is sent to it and it stays unverified: it signs you in, in place of your name, and receives no reset link or notice. Another person who wants the same address finds it taken, and the owner can change or remove it under that person's **Sign-in details**.

Without mail, there is no reset link or invitation address field. An admin recovery invitation remains available. In Settings, People, "People who sign in" lists each person. The owner sees "Recovery link" beside every person. Another person who administers the instance sees it beside their own name only. Somebody who does not administer has no People section and asks the owner. Press it, read what it replaces, and press "Make the recovery link". The link is shown once, as an invitation's is.

The public sign-in exchange is `POST /api/login`. To request a reset, send `{ "resetRequest": "robin@example.com" }`. To verify an address, send `{ "emailVerification": "<code>" }`. To finish a reset, send `{ "reset": "<code>", "password": "<new password>" }`. A successful request replies `{ "requested": true }` for every address. A blocked request returns `429` with `Retry-After`. Successful verification replies `{ "verified": true }`, and a successful reset replies `{ "changed": true }` without a session cookie. `GET /api/login/methods` includes `mail`, which says whether the instance offers these flows.

A verified address receives a notice when a password, passkey or authenticator is added, changed or removed, and when account recovery replaces sign-in methods. Replacing or removing that address sends a notice to the previous verified mailbox. Mail is queued in the account change transaction and delivered after it commits. Delivery failure does not undo a change or reveal SMTP details. Pending links and queued mail are stored in PostgreSQL and survive restarts across instances. Failed sends retry with bounded backoff. SMTP delivery is at least once, so a lost receipt can produce a duplicate message. Ask for another link if none arrives before it expires. Archives preserve contacts and verification status. Import clears pending verification and reset links.

Opening the confirmation moves focus to **Make the recovery link**. **Cancel** or <kbd>Esc</kbd> closes the confirmation and returns focus to that person's **Recovery link** button.

From the command line, invite the person again. For a person who exists, the link is a recovery:

```
$ mainworthy invite new dana
invitation 2 for "dana" (a recovery: accepting it replaces every way dana signs in), until 2026-10-16 09:57 UTC
https://mainworthy.example/invite#<code>
This link is shown once. Hand it to dana: it works once. When it is accepted, every password, passkey and token dana had stops working and every session of theirs ends.
```

Nothing changes until the link is accepted, so a link nobody uses locks nobody out. The owner makes a recovery link for anybody. An admin who is a person can make their own. Everybody else asks the owner. A person who does not administer cannot make an invitation. An admin cannot make another person's recovery link because whoever accepts that link acts as that person, as with a token.

Accepting recovery revokes every token belonging to that person, including personal CLI tokens and tokens made by an admin. Scripts using those tokens stop working and need new tokens. Tokens belonging to other people, agents and pipelines stay as they are.

Recovering the owner also revokes their configured `MAINWORTHY_OWNER_TOKEN`, even if it was their last token. The new password or passkey still signs them in. To restore a configured owner token, set the variable to a new value and restart. Restarting with the revoked value does not revive it. CI jobs that use that owner token also fail authentication until their configured secret is updated to the new value. CI using a separate pipeline actor's token is unaffected.

### Your sessions and your ways of signing in

A session is one browser that is signed in. Settings, "Your sessions" lists your sessions. Each row shows the sign-in method, initial address, browser name, last-use time and address, and maximum expiry. "this browser" marks your current session. "End" signs the selected browser out. Ending your current session is the same as signing out.

A person who administers the instance can inspect another person in Settings, **People**. Beside their name, open **Sign-in details**. It lists their sessions with the same details and **End** button as your own sessions. For another person, **End** asks you to confirm with **End this session** or **Cancel**. Ending this browser's session opens the sign-out dialog.

The details say whether the person has a password. They also list the person's passkeys and authenticator, with labels, creation times and last-use times. **Remove** removes a password or passkey and ends the sessions that used it. Removing an authenticator ends all of the person's sessions. For another person, removal first asks you to confirm with **Remove this sign-in method** or **Cancel**. The person's last usable password or passkey stays. They must add another before you can remove it. You cannot set their password or add a passkey for them. Recovery links keep the rules described above.

These confirmations move focus to **End this session** or **Remove this sign-in method** when they open. **Cancel** or <kbd>Esc</kbd> closes the confirmation and returns focus to the original **End** or **Remove** button. Cancel has a target of at least 44 by 44 pixels on a phone, as it does for a recovery link.

A script lists them and ends one:

```
$ mainworthy session --do list
[
  {
    "id": 2,
    "openedWith": "password",
    "label": "password",
    "userAgent": "Mozilla/5.0 ...",
    "createdAt": 1791885461648,
    "createdFrom": "203.0.113.9",
    "lastUsedAt": 1791885461648,
    "lastUsedFrom": "203.0.113.9",
    "expiresAt": 1799661461648,
    "current": false
  }
]
$ mainworthy session --do end --id 2
{
  "ended": true,
  "current": false
}
```

`openedWith` is `token`, `password`, `passkey` or `oidc`. `current` is true for the session that sent the request. The command line uses a token, so `current` is always false for command-line requests.

`mainworthy credential --do list` shows your password, passkeys and authenticator, each with an id, a label and when it was last used. It never shows a password, a hash or a key. `mainworthy credential --do remove --id <id>` removes one and ends the sessions that used it. Removing an authenticator ends all your sessions. Your last usable way of signing in stays:

```
$ mainworthy credential --do remove --id 1
invalid: this is the last way dana signs in, so it stays. Add a passkey or set a password first, then remove this one. If it is lost, an admin can make a recovery link (mainworthy invite new dana)
```

These two commands need no capability. A person who is signed in runs them for what is their own. An agent can list and end its own sessions. The `credential` operation refuses an agent with `forbidden` because only a person has a password or a passkey. A pipeline is refused by both.

### What an admin can do for somebody else

A person who holds `admin` on every project can:

- List somebody's sessions with `mainworthy session --do list --actor dana` and end any session by its id.
- List somebody's password, passkeys and authenticator with `mainworthy credential --do list --actor dana`. An admin can remove one by its id, except the last usable sign-in method.
- Invite a new person and list and revoke invitations.

An admin cannot see or set anybody's password, and cannot register a passkey for somebody else. Only the owner makes a recovery link for another person. An agent that holds `admin` can do none of this. Settings, **People**, offers the first two under each person's **Sign-in details**.

## Sign in to the web UI

In local mode you sign in as the owner, with no step. An operation waiting across an archive import still runs as the configured local owner. See [configuration](./configuration.md#local-mode-and-server-mode) for what local mode means.

In server mode the sign-in page has these ways in, one under the other:

- Your email address or your name, and your password, then "Sign in".
- "Sign in with" and the name of the instance's identity provider, where it has one. See [through an identity provider](#through-an-identity-provider).
- "Sign in with a passkey", where the instance has passkeys and your browser has them. You type no name.
- "Use a token": paste a token under "Sign in with your token" and press "Sign in with the token". This is how the owner signs in before anybody has a password, and how you try a token somebody handed you.

The caret starts in **Email or name**, <kbd>Tab</kbd> goes down the page, and <kbd>↵</kbd> sends the form the caret is in. The server opens a session for that browser, and the browser keeps a cookie that names the session. The cookie identifies the session. After sign-in, the browser holds neither the token nor the password.

A page's operation requests and signed-in account changes carry the actor id the page loaded, so a shared cookie cannot record your text as somebody else. If another tab signs in as a different person, the server refuses the stale page's request and asks you to sign in again. This also applies when the new person has the same name as a forgotten person.

For HTTP clients that send `X-Mainworthy-As`, its value is the exact decimal `actorId` from `/api/session`, such as `3`. Names, percent-encoded values and other number formats such as `03` are refused. Clients that omit the header continue to act as their credentials identify them.

An expired session returns HTTP `401 unauthenticated`, including when it expires while an account read or live-update connection request is being authorized. Sign in again to continue.

To sign out, press **Sign out** at the bottom of the sidebar, or <kbd>g</kbd> <kbd>x</kbd>. Ending this browser's session in Settings, **Your sessions**, opens the same dialog. It offers three choices:

- **Sign out and keep drafts** starts with the focus. It keeps your browser data so your drafts are there when you sign in again.
- **Sign out and clear browser data** removes your name, case drafts, queue answers, and run notes from this browser. The warning explains that unsaved text in every open tab will be lost and cannot be recovered.
- **Stay signed in**, or <kbd>Esc</kbd>, closes the dialog without signing out or clearing data.

<kbd>Tab</kbd> moves among the choices, and <kbd>↵</kbd> or <kbd>Space</kbd> presses the focused button. Signing out ends the session on the server, so a copy of the cookie stops working too. If no answer comes back, the page checks whether the browser is still signed in. If the first check gets no answer, the page checks a second time. If either check confirms that the session ended, the page applies your choice and shows the sign-in page.

If a check finds you still signed in, the attempt ends and keeps your browser data. If neither check answers, the page says it cannot tell whether you are signed out and that your browser data was kept. In both cases, the choice to clear ends with that attempt. Press **Sign out** again to choose and retry. Before leaving a shared computer when Mainworthy cannot answer, clear the site's data in your browser settings. A pending choice stays only in the tab making the attempt and does not survive a reload. A later expiry or sign-out in another tab does not apply that old choice. A session that expires keeps your drafts. In local mode there is nothing to sign out of, and no button.

A session ends after 14 days without use and after 90 days in any case. It also ends in these cases:

- The token you signed in with is revoked or reaches its end.
- The password or passkey you signed in with is removed or replaced.
- Your actor is forgotten.

Each of these sends you back to the sign-in page. [Configuration](./configuration.md#variables-the-server-reads) says how to change the two lifetimes.

After a tab processes a successful sign-in, replies to earlier session checks and signed-in requests are discarded. This also protects another open tab when the same person signs in again and this site's browser storage is available. That tab keeps its drafts, run notes and pending attachments. Signing in as somebody else still returns the other tab to the sign-in page. If repeated sign-ins interrupt both startup session checks, **Reconnect** reads the session again.

The browser can replace its session cookie before the sign-in tab processes the reply. Cross-tab protection begins after that reply is processed. Without browser storage, the protection applies within each tab. Overlapping sign-ins still follow the browser's cookie arrival order. A discarded reply can represent work the server already completed. Check the recorded state before trying the write again.

The owner's token comes from the server. If you set `MAINWORTHY_OWNER_TOKEN`, that value is the token. If you did not, the server prints one on its first start:

```
Mainworthy 0.1.0 · server · data in /data · http://localhost:7357
project "scratch" · owner robin · sign in with a token, a password or a passkey · policy: loose
owner token (shown once): <token>
```

The second line says who the owner is and how people sign in. Server mode signs nobody in on its own. In local mode the line reads `you are robin@this-machine`, because there you are the owner.

Copy the owner token when it appears. If you miss the token, set `MAINWORTHY_OWNER_TOKEN` to a new value of 20 to 512 visible ASCII characters without spaces. `openssl rand -hex 32` makes a suitable value. Startup refuses whitespace, control characters and non-ASCII characters before changing any token or session. Restart the server to add a valid value as a token. A new value also revokes every token previously issued through that variable. At startup, the server names those tokens in one log line. The server refuses a value that matches a revoked or expired token, or somebody else's token. At startup, it names the reason in one line and leaves the token unchanged. If no value is set and the owner holds no working token, the server prints a new token at startup, as on its first start. In the container, `docker compose logs` has the line.

The command line needs no token in local mode on the same machine. In server mode, give it one with `MAINWORTHY_TOKEN`, or `--token-file` for a token in a file. `--token` works too, but an argument appears in the process list and the shell's history. Prefer the variable. If the command is about to send a token to plain `http://` on another machine, it warns once on standard error. [Use an `https://` address](./cli.md#give-the-token-in-the-environment-or-in-a-file).

## What a pipeline can never do

A pipeline can hold `read` and `record`, and nothing more, under every grant and every policy. It reports results and their attachments, can append files to its own results, says when a change ended, and reads a commit's gate. It cannot answer a question, edit a case, plan a run or administer the instance. A grant for a pipeline that lists more is refused:

```
$ mainworthy actor grant github-actions --can produce --project scratch
invalid: a pipeline may hold read and record, not produce; give an agent or a person the rest
```

A pipeline with only `record` cannot read cases or the queue either. Add `read` if its job needs them. The token for a pipeline is in [report results](./report-results.md#give-a-pipeline-its-own-token).

## Where it is in Settings

These Settings sections manage policy, access and sign-in:

- Policy shows who answers under the current policy. See [policy](./policy.md).
- Tokens makes, lists and revokes tokens. An admin sees the form, and anyone else sees "An admin creates and revokes tokens."
- People invites a person, lists and revokes open invitations, makes a recovery link, manages teams and their grants, and forgets a person after confirmation. Sign-in details lists and ends each person's sessions and lists and removes their password, passkeys and authenticator. Issued tokens lists token use and revokes tokens. Only a person who holds `admin` on every project has this section.
- Projects lists the projects you can reach and creates a new one.
- Connect shows the pipeline and agent connection lines, with the address of this instance.
- Your sign-in sets or changes your password, adds and removes passkeys and an authenticator, manages your recovery email address, and creates your personal command-line tokens. Only a person has this section.
- Your sessions lists the browsers you are signed in on and ends any of them.

People shows personal grants with their roles and the permissions received from each team. Use `mainworthy actor grant` to edit personal grants.

## See also

- [Let an agent in](./agents.md) for an agent's token and what its work counts for.
- [Policy](./policy.md) for who answers each question.
- [Command line](./cli.md) for every `token`, `actor` and `invite` flag.
