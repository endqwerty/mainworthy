# People, agents and pipelines

Decide who may do what in each project, give a person, an agent or a pipeline a token, and take it away again. Making tokens and changing grants needs an instance admin, who holds `admin` on every project. Some of it only a person may do, and a token for a person who already exists is made by that person or by the owner.

## Kinds of actor

Everything in Mainworthy is done by an actor, and every record names the actor that made it. There are four kinds.

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
| `read` | `attachment`, `inbox`, `get`, `find`, `impact`, `since`, `gate`, `history`, `timeline`, `check`, `command`, `tracker-status` | a person, an agent |
| `record` | `attach`, `report`, `change`, `gate` | a person, a pipeline |
| `produce` | `propose`, `claim`, `tracker`, `decide` | a person, an agent |
| `answer` | none by itself; it makes an answer count where the policy asks a member | a person |
| `plan` | `plan` | a person |
| `admin` | `admin`, `invitation` | a person |

A pipeline holds `read` and `record` at most, whatever its grant lists.

<!-- /generated -->

`produce` includes `record`. To answer a question you need two things: `produce` to send the answer, and `answer` for the policy to count it. A new person gets all six, a new agent gets `read` and `produce`, and a new pipeline gets `record`. These defaults apply only when you make a token for a name that does not exist yet and give no `--can`.

## Grants

A grant says what an actor may do on one project, or on every project. A grant on every project shows as `*`. An actor can hold both, and the two add up.

```
$ mainworthy actor list
rule   policy  no grant
human  robin  *  read, record, produce, answer, plan, admin
agent  reviewer  scratch  read, record, produce, answer
ci     github-actions  scratch  read, record
```

Change a grant with `grant`. It replaces what the actor could do there, so list everything you want it to keep.

```
$ mainworthy actor grant reviewer --can read,produce --project checkout
reviewer on checkout: read, produce
$ mainworthy actor ungrant reviewer --project checkout
reviewer holds no grant on checkout any more
```

Leave out `--project` to change the grant on every project. Only a person changes a grant: an agent that holds `admin` is refused. You cannot change your own grant, because a slip could lock the instance. Another admin does it. Nobody changes the owner's grant, which Mainworthy writes again at every start.

The owner is the person named by `MAINWORTHY_OWNER`. See [configuration](./configuration.md).

## Make your own command-line token

Sign in with your password or a passkey, then open Settings, **Your sign-in**, **Your command-line tokens**.
You need no admin capability. As the local owner, you can make one without signing in.

1. Enter a **Token label** that says where you use it.
2. Choose a **Token lifetime**. The default is 30 days, and the longest is one year.
3. Choose **Create personal token**, then **Copy personal token**. Store the token in your shell or script's secret store.
4. Choose **Dismiss personal token** when you have stored it. Leaving the section also clears the secret from the page.

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
Creation accepts no actor, project, or grants. It requires a password or passkey browser session, or local-owner access.
A bearer token and a browser signed in with a token cannot make a personal token.
There is no instance setting to disable personal tokens. An admin who is a person may revoke another person's token by id, as with other credentials.

## Teams

A team is a named set of grants. A person's effective permissions are their own grants plus the grants of every team they belong to. Grants on one project and on every project add up. Removing a person from one team takes away that team's contribution immediately, including requests waiting to run. A personal grant or another team's grant still applies.

In Settings, People, use **New team name** and **Create team**, then choose the team under **Team to manage**. Choose **Grant on**, tick **Team permissions**, and press **Set team grant**. This replaces that team's grant on the chosen project, so tick everything it should keep. **Remove grant** removes just that project grant. Select **Person to add** and press **Add team member**; **Remove member** takes a person out in one step. Each person's row shows their own grants and a separate line for each team's grants.

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

Leave out `--project` for a grant on every project. `mainworthy actor list` labels grants received from a team. With an older API-version-1 server that omits team membership, the CLI and People still show personal grants. `team.history` lists creation, membership changes and grant changes with the person who made each change, its time, and the affected person or project. Repeating an action with the same `cmd` returns its original reply without adding another event. Forgetting a person removes their memberships and shows their pseudonym in team history. Teams, grants, memberships and this history travel in an [archive](./data.md#export-everything).

## Make a token

A token is a secret that stands for one actor. An agent or a pipeline sends it with each request, and a person types it to sign in.

In Settings, open Tokens (<kbd>g</kbd> <kbd>,</kbd>, then <kbd>j</kbd> to move down). Press <kbd>n</kbd>, then fill in "Token actor", pick a "Producer" (Agent, Pipeline or Person), tick the "Permissions" and choose "Create token". The new secret appears once, with "Copy token" and "Dismiss secret". A token made here is limited to the project you are in.

From the command line:

```
$ mainworthy token new --agent reviewer --can read,produce
token for agent "reviewer" (read, record, produce)
<token>
Shown once. It will not be shown again.
```

Use `--human` for a person and `--ci` for a pipeline. Add `--project <key>` to limit the grant to one project. Without it the grant covers every project.

Mainworthy shows a token once and keeps only a hash, so it cannot show it again. If you lose one, revoke it and make another.

The Tokens section and `token new` command need admin capability. For your own token without admin, use **Your sign-in** as described above. Who may make an admin-issued token depends on whose it is. Anyone who administers makes a token for an agent or a pipeline. A person who administers adds a new person. A token for a person who already exists is made by that person or by the owner, and a token for the owner by the owner alone, because whoever holds a person's token acts under that person's name. A name that starts with `forgotten-` is refused.

Making a token for a name that exists adds a token to that actor and does not change its grants. Naming a different `--can` for an existing actor is refused. Use `actor grant` for that.

## Give a token an end

An admin-issued token works until you revoke it, unless you give it an end. A personal token always has an end. `--expires` takes a whole number and `h`, `d` or `w`:

```
$ mainworthy token new --ci github-actions --project scratch --expires 90d
```

In Settings, Tokens, choose "Expires" before you create the token: never, 30 days, 90 days or 1 year. A token past its end is refused exactly as a revoked one is, and so is a browser that signed in with it.

To replace a token without a gap, make a second one for the same actor, put it where the first is used, then revoke the first. Two tokens of one actor work side by side. Each start of the server names every token that ends within 14 days, by its id, actor and label.

## See and revoke tokens

Settings, Tokens, and Settings, People, list "Issued tokens" with each token's number, label, actor, who made it, when it was made, when and from which address it was last used, and when it ends. A token with no recorded use says "never used". Forgetting a person reads this list again, so their tokens show the forgotten name and revoked state. The actor is who the token identifies; the list cannot tell which person held a shared token. "Revoke" next to a token stops it at once. In server mode the last token the owner can sign in with is not revoked: make the owner another one first.

```
$ mainworthy token list
1  agent reviewer  agent token  active  made by robin  last used from 203.0.113.9
2  ci github-actions  ci token  active, expires in 90 days  made by robin
$ mainworthy token revoke 2
token 2 revoked
```

The server reads your token or session, your actor and your grants in the same snapshot that runs an operation. A read waiting for a reader sees a grant removed before it starts. A report already accepted keeps its actor and finishes even if that actor's token is then revoked.

A token with no end works until somebody revokes it, so revoke one you no longer use. Revoking a token leaves the actor and its grants in place. To stop an actor on one project, use `actor ungrant`. To remove who a person was, forget the actor. Only a person who administers forgets an actor, and the owner is not forgotten. The name becomes a pseudonym, `forgotten-` and the actor's number (with `-2`, `-3` and so on added when an archive imported from an older build already holds that name), the tokens stop working, the person's passwords, passkeys and open invitations are revoked, and the history keeps what the actor did.

Forgetting also clears the person's token and credential labels, including labels on revoked rows. Question evidence, saved command replies and report receipts use the pseudonym for attribution. New questions keep actor ids and resolve names when read; forgetting rewrites display names saved by older builds. This leaves the evidence hash unchanged because it covers the decision's material basis and target, not display attribution. Command ids still name the same requests, so retrying a command does not repeat the write. Replies that held secrets remain unavailable. Text in cases and notes stays as written.

```
$ mainworthy admin --json '{"do":"actor.forget","name":"dana"}'
{"forgotten":"forgotten-5","tokensRevoked":0}
```

The raw operation remains available. The page and shorter command are described in [Forget a person](#forget-a-person).

## Add an authenticator for password sign-in

In Settings, open **Your sign-in**, then choose **Add an authenticator**.

1. Scan the QR code with a TOTP authenticator, or enter the setup key by hand. Mainworthy generates the QR code on the instance without contacting another service.
2. Enter the six-digit **Authenticator code** and choose **Confirm authenticator** within five minutes.
3. Save the ten recovery codes somewhere private, then choose **I saved the recovery codes**. Mainworthy shows these codes once. Each code works once with your password.

Your other sessions end when you confirm. Your current session stays signed in. The next password sign-in shows **One more step**. Enter a fresh authenticator code or an unused recovery code. The password alone opens no session. A passkey with user verification needs no extra code.

If you choose a passkey during **One more step** and cancel, restart password sign-in before entering a code.

Authenticator codes change every 30 seconds. Mainworthy allows the previous and next 30-second step for clock differences and refuses a code already used. Wait for a new code if you just confirmed enrolment. Wrong sign-in codes count against your account and the request address. Re-entering the right password does not clear failed-code attempts. Enrolment has a separate failed-code count, so setup typos do not block sign-in codes.

The credential list identifies your authenticator without showing its setup key or recovery codes. **Remove** removes it and ends all your sessions. Removing your own authenticator uses your signed-in session and does not ask for a fresh code. To replace lost recovery codes, remove the authenticator and enrol again from a session you can still open. Otherwise, ask the owner for a recovery invitation.

An instance that requires a second factor for admins keeps an admin's authenticator while that person still has a password. The requirement covers personal and team grants on any project. An admin recovery invitation on such an instance must be accepted with a passkey. An admin password without an authenticator does not count as a working sign-in method. Add another passkey or enrol an authenticator before removing the last usable passkey.

The [configuration](./configuration.md#require-a-second-factor-for-admins) page describes the admin requirement. The [command line](./cli.md#sign-in-with-a-password-and-a-code) also supports the second step. The current iPhone build explains when a second step is required and asks you to use the web app.

## Forget a person

In Settings, open **People** and find **Forget a person** below the list of people.

1. Choose the person in **Person to forget**. Your own name and the current owner's name are unavailable, with the reason beside each.
2. Press **Forget this person**.
3. Read what forgetting erases and what stays, then press **Forget** followed by the person's name to confirm.

The confirmation takes the keyboard focus. **Cancel** or <kbd>Esc</kbd> closes it without changing anything and returns focus to **Forget this person**.

The page shows the pseudonym and the number of tokens revoked. It reads the people and invitations again and removes any invitation link it was showing for that person. If no reply comes back, it reads the lists again. If the person is no longer listed, the page says so and clears the confirmation. Otherwise, retrying the same confirmation uses the same command id.

From the command line, `mainworthy actor forget dana` prints the warning and makes no change. After reading it, repeat the name to confirm:

```
$ mainworthy actor forget dana --confirm dana
Forgotten as forgotten-5. 0 tokens revoked. History and typed text stay.
```

Add `--json` for the pseudonym and the number of revoked tokens as JSON. Both the page and the command use the same admin operation. `actor list --json` identifies the current owner with `owner: true`. If an older server does not identify the owner, the page keeps forgetting unavailable. You must be a person who administers the instance. You cannot forget yourself or the current owner. To forget the current owner, first [hand the instance to somebody else](./configuration.md).

A person cannot yet request forgetting inside Mainworthy or delete their own account. Ask the person who runs your instance. For `mainworthy.com`, follow [Privacy, changes and questions](./privacy.md#changes-and-questions). See [Privacy](./privacy.md#your-rights-with-respect-to-your-information) for retained records and typed text.

## Sign in as yourself

A person can sign in with their name and a password, or with a passkey, and needs no token for it. Mainworthy sends no mail and nobody chooses a password for somebody else, so a person gets their first way in through a link that an admin hands them.

Each step below is in the web UI, under Settings, and has a command that does the same for a script.

### Invite a person

In Settings, open People. You see it when you are a person who holds `admin` on every project.

1. Type the person's name. <kbd>n</kbd> puts the caret in the field.
2. Tick what they may do. It starts as `read`, `record`, `produce`, `answer` and `plan`. `admin` starts unticked: tick it only for somebody who should change the policy, and on every project also invite people, make tokens and projects and change what others may do.
3. Choose one project, or every project.
4. Choose how long the link works, from 12 hours to 30 days. Three days is the start.
5. Press "Make invitation link".

The link appears once, masked, with "Copy link". Copy it and hand it to the person. "Dismiss link" takes it off the page, and so does leaving the section. Nothing shows it again. If no answer comes back when you make a link, the page says so and reads its lists again. A person who is in them was invited, and that link is lost: a recovery link is then their way in.

"Open invitations" lists the links nobody has accepted yet: who each is for, what that person may do, who made it and when it runs out. "Revoke" withdraws one.

The same from the command line:

```
$ mainworthy invite new dana --can read,produce,answer --project checkout
invitation 1 for "dana" (may read, record, produce, answer on checkout), until 2026-10-16 09:57 UTC
https://mainworthy.example/invite#<code>
This link is shown once. Hand it to dana: it works once.
```

- The link is printed once. Mainworthy keeps only a hash of the code in it, so it cannot print the link again. If it is lost, make another.
- The link works once, for three days. `--expires` takes a whole number and `h`, `d` or `w`, up to `30d`. A new invitation for the same person replaces the one before it.
- `--can` and `--project` say what a new person may do, as they do for a token. Without `--can` a new person may do everything.
- The link starts with the address in `MAINWORTHY_PUBLIC_URL`. With that variable unset, the command prints `/invite#<code>` and tells you to put the address of the instance before it. See [configuration](./configuration.md#variables-the-server-reads).
- Only a person who administers invites somebody. An agent that holds `admin` is refused.

`mainworthy invite list` shows every invitation, who made it, whether it is open, used, revoked or expired, and what its person may do on which project. It never shows a link. `mainworthy invite revoke <id>` withdraws one that nobody has accepted.

### Accept an invitation

Open the link. The page says "You are invited as dana" and until when the link works.

1. Type a password twice. The page counts the characters as you type. A password is 12 to 256 characters, and nothing else is asked of it: no digit, no capital letter, no symbol.
2. Or tick "Make a passkey on this device" and give the passkey a name. It starts as the name of your browser. You can do both.
3. Press "Accept and sign in". You are signed in and the app opens.

The page takes the code out of the address bar as soon as it has read it. From then on the address you see, and the one Back returns to, has no code in it, so it is not copied with the address. That is as far as a page can go: the browser's own record of the address that was first opened still holds the whole link, as it does for any address. The code is the part after the `#`, which a browser sends to no server. If you reload the page, it has no code: open the link again.

If the browser is signed in as somebody else, the page says who and asks before it signs them out of that browser. Until it knows who is signed in, and until you answer, the fields cannot be typed in. If the page cannot find out who is signed in, because the request failed or no answer came within twenty seconds, it says so and the fields stay closed: "Try again" asks once more, with the invitation as it was. The answer is about the person the page named and nobody else: if the acceptance request carries a different person's cookie, nothing is accepted, and the page asks again, about them. "Stay signed in" leaves the invitation as it is.

Two sign-ins already in flight can each finish and set this browser's cookie. The last response chooses who this browser is signed in as. A session whose cookie was replaced can remain open on the server, because the earlier request did not carry that cookie. Sign in as that person and end it in **Your sessions**, or leave it to expire after 14 days without use, at the default lifetime. This does not end their sessions on other devices.

If no answer comes back when you accept, the page says that it cannot tell whether the invitation was accepted. Go to the sign-in page and try what you chose. If that signs you in, it was.

A link that was used, was revoked or has run out says "This invitation does not work any more." So does one that was cut short when it was copied. Ask whoever sent it for a new one.

A script accepts an invitation with `POST /api/login`. [API](./api.md#sign-in-as-a-person) has the request.

### A name and a password, or a passkey

Mainworthy normalizes passwords to Unicode NFC before hashing and checking them. An accented letter such as `é` matches the same letter entered as `e` followed by a combining accent, including from an iPhone keyboard. Compatibility characters such as full-width letters stay distinct. Passkeys and the PIN or biometric check that unlocks them are unchanged.

A password stored before this change still accepts its original spelling. For an older non-NFC spelling, the first successful sign-in with that spelling refreshes its hash, after which canonical spellings both work. Until then, a different spelling may fail. Refreshing the hash keeps existing sessions signed in. Changing a password accepts the original spelling of an older password too.

After that the person signs in on the sign-in page with their name and password, or with "Sign in with a passkey". A wrong name or password gets one sentence, whichever of the two was wrong: "That name and password did not sign you in." A wrong token and a passkey that is refused each have a message of their own, and after too many failed attempts the page says how long to wait instead. A script signs in with `POST /api/login` and `{"name": "dana", "password": "..."}`. A name and a password that are looked at and refused get one answer whatever was wrong with them, `unauthenticated: that did not sign you in`. The reply does not say whether the name exists or the password was wrong. The server's log has the reason as a code, and never the name or the password that was tried.

A passkey is a key that a device or a password manager holds and unlocks with a fingerprint, a face or a PIN. It needs `MAINWORTHY_PUBLIC_URL`, because a passkey belongs to the host name people open the instance at. One made at `https://mainworthy.example` does not sign in at another name of the same instance. Without that variable the pages offer no passkey. [API](./api.md#sign-in-as-a-person) lists the requests a page makes to register and use one.

To set or change your password, open Settings, "Your sign-in". <kbd>n</kbd> puts the caret in the new password. Changing a password asks for the current one. The other browsers that signed in with the old password are signed out, and the page says how many. The one that made the change stays signed in. The page then empties the fields. A password manager such as 1Password can fill the two new fields with a password it makes up and save it under your name. It is told how long a password may be, and to leave the token on the sign-in page alone. A token cannot change a password. If no answer comes back, the page says that it cannot tell whether the password was changed, and reads the list of your ways of signing in again. It may or may not have been changed: sign in with the new password to find out.

To add a passkey, give it a name under "Passkeys" in the same section and press "Add a passkey". "Ways you sign in" lists your password and each passkey with when it was last used, and "Remove" beside each. Your last way of signing in has no working "Remove".

Failed attempts are counted. The fifth wrong password for one name within 15 minutes blocks sign-in with a password for that name for one second, from every address, and each further one doubles the wait, up to 15 minutes. A blocked sign-in is answered `limited` and is not looked at, so the right password waits too. A name nobody has is counted the same way, so the count does not say which names exist. A passkey is not held up by a block on the name. [Troubleshooting](./troubleshooting.md#limited-too-many-failed-attempts) says what to do.

### A lost password or passkey

The sign-in page has no "forgot password", because there is no mail to send one by. A recovery link replaces it. In Settings, People, "People who sign in" lists each person. The owner sees "Recovery link" beside every person. Another person who administers the instance sees it beside their own name only. Somebody who does not administer has no People section and asks the owner. Press it, read what it replaces, and press "Make the recovery link". The link is shown once, as an invitation's is.

Opening the confirmation moves focus to **Make the recovery link**. **Cancel** or <kbd>Esc</kbd> closes the confirmation and returns focus to that person's **Recovery link** button.

From the command line, invite the person again. For a person who exists, the link is a recovery:

```
$ mainworthy invite new dana
invitation 2 for "dana" (a recovery: accepting it replaces every way dana signs in), until 2026-10-16 09:57 UTC
https://mainworthy.example/invite#<code>
This link is shown once. Hand it to dana: it works once. When it is accepted, every password, passkey and token dana had stops working and every session of theirs ends.
```

Nothing changes until the link is accepted, so a link nobody uses locks nobody out. The owner makes a recovery link for anybody. An admin who is a person can make their own. Everybody else asks the owner: a person who does not administer cannot make an invitation at all, and an admin who asks for another person's link is refused, for the same reason as with a token: whoever accepts the link is that person from then on.

Accepting recovery revokes every token belonging to that person, including personal CLI tokens and tokens made by an admin. Scripts using those tokens stop working and need new tokens. Tokens belonging to other people, agents and pipelines stay as they are.

Recovering the owner also revokes their configured `MAINWORTHY_OWNER_TOKEN`, even if it was their last token. The new password or passkey still signs them in. To restore a configured owner token, set the variable to a new value and restart. Restarting with the revoked value does not revive it. CI jobs that use that owner token also fail authentication until their configured secret is updated to the new value. CI using a separate pipeline actor's token is unaffected.

### Your sessions and your ways of signing in

A session is one browser that is signed in. Settings, "Your sessions" lists yours: what opened each one and from which address, the browser as it named itself, when and from where it was last used, and when it ends at the latest. "this browser" marks the one you are looking at. "End" signs that browser out. On your own it is the same as signing out.

A person who administers the instance can inspect another person in Settings, **People**. Beside their name, open **Sign-in details**. It lists their sessions with the same details and **End** button as your own sessions. For another person, **End** asks you to confirm with **End this session** or **Cancel**. Ending this browser's session opens the sign-out dialog.

The details also say whether the person has a password and list their passkeys, with their names, when they were added, and their last use. **Remove** removes a password or passkey and ends the sessions that used it. For another person, it first asks you to confirm with **Remove this sign-in method** or **Cancel**. The person's last password or passkey stays; they must add another before you can remove it. You cannot set their password or add a passkey for them. Recovery links keep the rules described above.

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

`openedWith` is `token`, `password` or `passkey`. `current` is true for the session the request itself came by, so from the command line, which uses a token, it is always false.

`mainworthy credential --do list` shows your password and passkeys, each with an id, a label and when it was last used. It never shows a password, a hash or a key. `mainworthy credential --do remove --id <id>` removes one and ends the sessions that were opened with it. Your last way of signing in stays:

```
$ mainworthy credential --do remove --id 1
invalid: this is the last way dana signs in, so it stays. Add a passkey or set a password first, then remove this one. If it is lost, an admin can make a recovery link (mainworthy invite new dana)
```

These two commands need no capability. A person who is signed in runs them for what is their own. An agent lists and ends its own sessions, and `credential` refuses it with `forbidden`: only a person has a password or a passkey. A pipeline is refused by both.

### What an admin can do for somebody else

A person who holds `admin` on every project can:

- list somebody's sessions with `mainworthy session --do list --actor dana`, and end any session by its id;
- list somebody's password and passkeys with `mainworthy credential --do list --actor dana`, and remove one by its id, but not the last;
- invite a new person, and list and revoke invitations.

An admin cannot see or set anybody's password, and cannot register a passkey for somebody else. Only the owner makes a recovery link for another person. An agent that holds `admin` can do none of this. Settings, **People**, offers the first two under each person's **Sign-in details**.

## Sign in to the web UI

In local mode you sign in as the owner, with no step. An operation waiting across an archive import still runs as the configured local owner. See [configuration](./configuration.md#local-mode-and-server-mode) for what local mode means.

In server mode the sign-in page has three ways in, one under the other:

- Your name and password, then "Sign in".
- "Sign in with a passkey", where the instance has passkeys and your browser has them. You type no name.
- "Use a token": paste a token under "Sign in with your token" and press "Sign in with the token". This is how the owner signs in before anybody has a password, and how you try a token somebody handed you.

The caret starts in the name, <kbd>Tab</kbd> goes down the page, and <kbd>↵</kbd> sends the form the caret is in. The server opens a session for that browser, and the browser keeps a cookie that names the session. The cookie is not the token or the password: the browser holds neither after that.

To sign out, press **Sign out** at the bottom of the sidebar, or <kbd>g</kbd> <kbd>x</kbd>. Ending this browser's session in Settings, **Your sessions**, opens the same dialog. It offers three choices:

- **Sign out and keep drafts** starts with the focus. It keeps your browser data so your drafts are there when you sign in again.
- **Sign out and clear browser data** removes your name, case drafts, queue answers, and run notes from this browser. The warning explains that unsaved text in every open tab will be lost and cannot be recovered.
- **Stay signed in**, or <kbd>Esc</kbd>, closes the dialog without signing out or clearing data.

<kbd>Tab</kbd> moves among the choices, and <kbd>↵</kbd> or <kbd>Space</kbd> presses the focused button. Signing out ends the session on the server, so a copy of the cookie stops working too. If no answer comes back, the page checks whether the browser is still signed in, with a second check if the first gets no answer. If either check confirms that the session ended, the page applies your choice and shows the sign-in page.

If a check finds you still signed in, the attempt ends and keeps your browser data. If neither check answers, the page says it cannot tell whether you are signed out and that your browser data was kept. In both cases, the choice to clear ends with that attempt. Press **Sign out** again to choose and retry. Before leaving a shared computer when Mainworthy cannot answer, clear the site's data in your browser settings. A pending choice stays only in the tab making the attempt and does not survive a reload. A later expiry or sign-out in another tab does not apply that old choice. A session that expires keeps your drafts. In local mode there is nothing to sign out of, and no button.

A session ends after 14 days without use and after 90 days in any case. It also ends when the token you signed in with is revoked or reaches its end, when the password or passkey you signed in with is removed or replaced, and when your actor is forgotten. Each of these sends you back to the sign-in page. [Configuration](./configuration.md#variables-the-server-reads) says how to change the two lifetimes.

The owner's token comes from the server. If you set `MAINWORTHY_OWNER_TOKEN`, that value is the token. If you did not, the server prints one on its first start:

```
Mainworthy 0.1.0 · server · data in /data · http://localhost:7357
project "scratch" · owner robin · sign in with a token, a password or a passkey · policy: loose
owner token (shown once): <token>
```

The second line says who the owner is and how anybody signs in. A server signs nobody in on its own, so it does not say "you are": in local mode the line reads `you are robin@this-machine`, because there you are the owner.

Copy it then. If you miss it, set `MAINWORTHY_OWNER_TOKEN` to a new value of 20 to 512 characters and restart, and that value becomes a token too. A new value there also retires every token that came from the variable before: the server revokes them and names them in one line when it starts. A value that is a token which was revoked, has reached its end, or is somebody else's is not accepted: the server says which in one line when it starts and leaves the token as it is. With no value set, a start on which the owner holds no token that works prints a new one, as the first start does. In the container, `docker compose logs` has the line.

The command line needs no token in local mode on the same machine. In server mode, give it one with `MAINWORTHY_TOKEN`, or `--token-file` for a token in a file. `--token` works too, but an argument is in the process list and the shell's history; prefer the variable. The command warns once on standard error if it is about to send a token to plain `http://` on another machine: [use an `https://` address](./cli.md#give-the-token-in-the-environment-or-in-a-file).

## What a pipeline can never do

A pipeline can hold `read` and `record`, and nothing more, under every grant and every policy. It reports results and their attachments, can append files to its own results, says when a change ended, and reads a commit's gate. It cannot answer a question, edit a case, plan a run or administer the instance. A grant for a pipeline that lists more is refused:

```
$ mainworthy actor grant github-actions --can produce --project scratch
invalid: a pipeline may hold read and record, not produce; give an agent or a person the rest
```

A pipeline with only `record` cannot read cases or the queue either. Add `read` if its job needs them. The token for a pipeline is in [report results](./report-results.md#give-a-pipeline-its-own-token).

## Where it is in Settings

- Policy shows who answers under the current policy. See [policy](./policy.md).
- Tokens makes, lists and revokes tokens. An admin sees the form, and anyone else sees "An admin creates and revokes tokens."
- People invites a person, lists and revokes open invitations, makes a recovery link, manages teams and their grants, and forgets a person after confirmation. Sign-in details lists and ends each person's sessions and lists and removes their password and passkeys. Issued tokens lists token use and revokes tokens. Only a person who holds `admin` on every project has this section.
- Projects lists the projects you can reach and creates a new one.
- Connect shows the pipeline and agent connection lines, with the address of this instance.
- Your sign-in sets or changes your password and adds and removes passkeys. Only a person has this section.
- Your sessions lists the browsers you are signed in on and ends any of them.

People shows personal grants and the grants received from each team. To change a personal grant, use `mainworthy actor grant`.

## See also

- [Let an agent in](./agents.md) for an agent's token and what its work counts for.
- [Policy](./policy.md) for who answers each question.
- [Command line](./cli.md) for every `token`, `actor` and `invite` flag.
