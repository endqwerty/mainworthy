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
| `read` | `inbox`, `get`, `find`, `impact`, `since`, `gate`, `history`, `timeline`, `check`, `command` | a person, an agent |
| `record` | `report`, `change`, `gate` | a person, a pipeline |
| `produce` | `propose`, `claim`, `decide` | a person, an agent |
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

Who may make a token depends on whose it is. Anyone who administers makes a token for an agent or a pipeline. A person who administers adds a new person. A token for a person who already exists is made by that person or by the owner, and a token for the owner by the owner alone, because whoever holds a person's token acts under that person's name. A name that starts with `forgotten-` is refused.

Making a token for a name that exists adds a token to that actor and does not change its grants. Naming a different `--can` for an existing actor is refused. Use `actor grant` for that.

## Give a token an end

A token works until you revoke it, unless you give it an end. `--expires` takes a whole number and `h`, `d` or `w`:

```
$ mainworthy token new --ci github-actions --project scratch --expires 90d
```

In Settings, Tokens, choose "Expires" before you create the token: never, 30 days, 90 days or 1 year. A token past its end is refused exactly as a revoked one is, and so is a browser that signed in with it.

To replace a token without a gap, make a second one for the same actor, put it where the first is used, then revoke the first. Two tokens of one actor work side by side. Each start of the server names every token that ends within 14 days, by its id, actor and label.

## See and revoke tokens

Settings, Tokens, lists "Issued tokens" with each token's actor, who made it, when it was made, when and from which address it was last used, and when it ends. "Revoke" next to a token stops it at once. In server mode the last token the owner can sign in with is not revoked: make the owner another one first.

```
$ mainworthy token list
1  agent reviewer  agent token  active  made by robin  last used from 203.0.113.9
2  ci github-actions  ci token  active, expires in 90 days  made by robin
$ mainworthy token revoke 2
token 2 revoked
```

A token with no end works until somebody revokes it, so revoke one you no longer use. Revoking a token leaves the actor and its grants in place. To stop an actor on one project, use `actor ungrant`. To remove who a person was, forget the actor. Only a person who administers forgets an actor, and the owner is not forgotten. The name becomes a pseudonym, `forgotten-` and the actor's number (with `-2`, `-3` and so on added when an archive imported from an older build already holds that name), the tokens stop working, the person's passwords, passkeys and open invitations are revoked, and the history keeps what the actor did.

```
$ mainworthy admin --json '{"do":"actor.forget","name":"dana"}'
{"forgotten":"forgotten-5","tokensRevoked":0}
```

There is no shorter command for it. See [API](./api.md).

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

If the browser is signed in as somebody else, the page says who and asks before it signs them out of that browser. Until it knows who is signed in, and until you answer, the fields cannot be typed in. If the page cannot find out who is signed in, because the request failed or no answer came within twenty seconds, it says so and the fields stay closed: "Try again" asks once more, with the invitation as it was. The answer is about the person the page named and nobody else: if another person signs in to that browser before you accept, nothing is accepted, and the page asks again, about them. "Stay signed in" leaves the invitation as it is.

If no answer comes back when you accept, the page says that it cannot tell whether the invitation was accepted. Go to the sign-in page and try what you chose. If that signs you in, it was.

A link that was used, was revoked or has run out says "This invitation does not work any more." So does one that was cut short when it was copied. Ask whoever sent it for a new one.

A script accepts an invitation with `POST /api/login`. [API](./api.md#sign-in-as-a-person) has the request.

### A name and a password, or a passkey

After that the person signs in on the sign-in page with their name and password, or with "Sign in with a passkey". A wrong name or password gets one sentence, whichever of the two was wrong: "That name and password did not sign you in." A wrong token and a passkey that is refused each have a message of their own, and after too many failed attempts the page says how long to wait instead. A script signs in with `POST /api/login` and `{"name": "dana", "password": "..."}`. A name and a password that are looked at and refused get one answer whatever was wrong with them, `unauthenticated: that did not sign you in`. The reply does not say whether the name exists or the password was wrong. The server's log has the reason as a code, and never the name or the password that was tried.

A passkey is a key that a device or a password manager holds and unlocks with a fingerprint, a face or a PIN. It needs `MAINWORTHY_PUBLIC_URL`, because a passkey belongs to the host name people open the instance at. One made at `https://mainworthy.example` does not sign in at another name of the same instance. Without that variable the pages offer no passkey. [API](./api.md#sign-in-as-a-person) lists the requests a page makes to register and use one.

To set or change your password, open Settings, "Your sign-in". <kbd>n</kbd> puts the caret in the new password. Changing a password asks for the current one. The other browsers that signed in with the old password are signed out, and the page says how many. The one that made the change stays signed in. The page then empties the fields. A password manager such as 1Password can fill the two new fields with a password it makes up and save it under your name. It is told how long a password may be, and to leave the token on the sign-in page alone. A token cannot change a password. If no answer comes back, the page says that it cannot tell whether the password was changed, and reads the list of your ways of signing in again. It may or may not have been changed: sign in with the new password to find out.

To add a passkey, give it a name under "Passkeys" in the same section and press "Add a passkey". "Ways you sign in" lists your password and each passkey with when it was last used, and "Remove" beside each. Your last way of signing in has no working "Remove".

Failed attempts are counted. The fifth wrong password for one name within 15 minutes blocks sign-in with a password for that name for one second, from every address, and each further one doubles the wait, up to 15 minutes. A blocked sign-in is answered `limited` and is not looked at, so the right password waits too. A name nobody has is counted the same way, so the count does not say which names exist. A passkey is not held up by a block on the name. [Troubleshooting](./troubleshooting.md#limited-too-many-failed-attempts) says what to do.

### A lost password or passkey

The sign-in page has no "forgot password", because there is no mail to send one by. A recovery link replaces it. In Settings, People, "People who sign in" lists each person. The owner sees "Recovery link" beside every person. Another person who administers the instance sees it beside their own name only. Somebody who does not administer has no People section and asks the owner. Press it, read what it replaces, and press "Make the recovery link". The link is shown once, as an invitation's is.

From the command line, invite the person again. For a person who exists, the link is a recovery:

```
$ mainworthy invite new dana
invitation 2 for "dana" (a recovery: accepting it replaces every way dana signs in), until 2026-10-16 09:57 UTC
https://mainworthy.example/invite#<code>
This link is shown once. Hand it to dana: it works once. When it is accepted, every password and passkey dana had stops working and every session of theirs ends.
```

Nothing changes until the link is accepted, so a link nobody uses locks nobody out. The owner makes a recovery link for anybody. An admin who is a person can make their own. Everybody else asks the owner: a person who does not administer cannot make an invitation at all, and an admin who asks for another person's link is refused, for the same reason as with a token: whoever accepts the link is that person from then on. A recovery does not touch the person's tokens. Revoke those with `mainworthy token revoke`.

### Your sessions and your ways of signing in

A session is one browser that is signed in. Settings, "Your sessions" lists yours: what opened each one and from which address, the browser as it named itself, when and from where it was last used, and when it ends at the latest. "this browser" marks the one you are looking at. "End" signs that browser out. On your own it is the same as signing out.

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

An admin cannot see or set anybody's password, and cannot register a passkey for somebody else. Only the owner makes a recovery link for another person. An agent that holds `admin` can do none of this. The first two are commands only: Settings shows your own sessions and ways of signing in, not somebody else's.

## Sign in to the web UI

In local mode you sign in as the owner, with no step. See [configuration](./configuration.md#local-mode-and-server-mode) for what local mode means.

In server mode the sign-in page has three ways in, one under the other:

- Your name and password, then "Sign in".
- "Sign in with a passkey", where the instance has passkeys and your browser has them. You type no name.
- "Use a token": paste a token under "Sign in with your token" and press "Sign in with the token". This is how the owner signs in before anybody has a password, and how you try a token somebody handed you.

The caret starts in the name, <kbd>Tab</kbd> goes down the page, and <kbd>↵</kbd> sends the form the caret is in. The server opens a session for that browser, and the browser keeps a cookie that names the session. The cookie is not the token or the password: the browser holds neither after that.

To sign out, press "Sign out" at the bottom of the sidebar, or <kbd>g</kbd> <kbd>x</kbd>. That ends the session on the server, so a copy of the cookie stops working too. If no answer comes back, the page asks the server whether the browser is still signed in, and shows the sign-in page or says that you are still signed in. If that question gets no answer either, the page says it cannot tell, and you press "Sign out" again. Text you typed and had not recorded stays in that browser under your name, and is there when you sign in again. In local mode there is nothing to sign out of, and no button.

A session ends after 14 days without use and after 90 days in any case. It also ends when the token you signed in with is revoked or reaches its end, when the password or passkey you signed in with is removed or replaced, and when your actor is forgotten. Each of these sends you back to the sign-in page. [Configuration](./configuration.md#variables-the-server-reads) says how to change the two lifetimes.

The owner's token comes from the server. If you set `MAINWORTHY_OWNER_TOKEN`, that value is the token. If you did not, the server prints one on its first start:

```
Mainworthy 0.1.0 · server · data in /data · http://localhost:7357
project "scratch" · you are robin@this-machine · policy: loose
owner token (shown once): <token>
```

Copy it then. If you miss it, set `MAINWORTHY_OWNER_TOKEN` to a new value of 20 to 512 characters and restart, and that value becomes a token too. A new value there also retires every token that came from the variable before: the server revokes them and names them in one line when it starts. A value that is a token which was revoked, has reached its end, or is somebody else's is not accepted: the server says which in one line when it starts and leaves the token as it is. With no value set, a start on which the owner holds no token that works prints a new one, as the first start does. In the container, `docker compose logs` has the line.

The command line needs no token in local mode on the same machine. In server mode, give it one with `--token` or `MAINWORTHY_TOKEN`.

## What a pipeline can never do

A pipeline can hold `read` and `record`, and nothing more, under every grant and every policy. It reports results, says when a change ended, and reads a commit's gate. It cannot answer a question, edit a case, plan a run or administer the instance. A grant for a pipeline that lists more is refused:

```
$ mainworthy actor grant github-actions --can produce --project scratch
invalid: a pipeline may hold read and record, not produce; give an agent or a person the rest
```

A pipeline with only `record` cannot read cases or the queue either. Add `read` if its job needs them. The token for a pipeline is in [report results](./report-results.md#give-a-pipeline-its-own-token).

## Where it is in Settings

- Policy shows who answers under the current policy. See [policy](./policy.md).
- Tokens makes, lists and revokes tokens. An admin sees the form, and anyone else sees "An admin creates and revokes tokens."
- People invites a person, lists and revokes open invitations, and makes a recovery link. Only a person who holds `admin` on every project has this section.
- Projects lists the projects you can reach and creates a new one.
- Connect shows the pipeline and agent connection lines, with the address of this instance.
- Your sign-in sets or changes your password and adds and removes passkeys. Only a person has this section.
- Your sessions lists the browsers you are signed in on and ends any of them.

Settings does not show grants. Use `mainworthy actor list` and `actor grant`.

## See also

- [Let an agent in](./agents.md) for an agent's token and what its work counts for.
- [Policy](./policy.md) for who answers each question.
- [Command line](./cli.md) for every `token`, `actor` and `invite` flag.
