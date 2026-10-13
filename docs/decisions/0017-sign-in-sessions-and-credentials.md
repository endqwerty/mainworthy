# 0017: Sign-in, sessions and credentials

- Date: 2026-10-13
- Status: proposed. Four pull requests deliver it, and a fifth the pages. The first is built in the pull
  request that adds this file, the second (the limit on failed attempts) in the one after it, the fourth
  (people) in the one that adds the section "What the fourth pull request builds", and the pages in the one
  that adds "The pages"; the owner reviews.

The instance has been public since 2026-10-13. Issue #88 lists what sign-in needs before more than one person
uses it, and issue #30 asks that a person sign in as themselves. This record holds the design for both, so that
four pull requests build one shape and the last needs no rewrite of the first.

## Problem

1. **The browser held the token.** The cookie's value was the token itself, kept for a year. Sign-out cleared the
   cookie and ended nothing, so a copy of the cookie kept working. `Session` carried the secret, because two
   surfaces hashed it again after each write to record that the token was used.
2. **Nothing limited failed attempts.** A wrong token cost the caller one request.
3. **A token had no end.** It never expired, a changed `MAINWORTHY_OWNER_TOKEN` retired nothing, and
   `last_used_at` was written after writes only, so a token that only read looked unused.
4. **Nobody signed in as themselves.** A token was the one proof there was, pasted into a form.

Constraints. A request is admitted on the reading connection before it waits at the write gate, and must not
touch the writing connection outside the gate. An operation is synchronous, runs in a transaction, and the
registry refuses a call with no actor. A shipped migration is never edited. An archive must not hold anything
that signs somebody in. Local mode, where the owner of the machine needs no sign-in, stays as it is.

## Decisions

1. **Everything stays in `src/server/identity`.** The directory gains files; `identity.ts` is the one file
   another layer imports, and `test/architecture.test.ts` holds that. Moving tokens to a new layer was turned
   down: 400 lines moved for a boundary the SQL-ownership test already draws for each layer.
2. **A surface asks one question.** `admit(app, facts)` answers with a `Session` or a refusal. `Session` is
   `{ via, actor(project) }` and holds no secret. `actor` reads standing again on every call, so an operation
   that waited at the gate and a change stream opened an hour ago stop when the session ends. The HTTP surface
   reads the facts of a request and writes the cookie; it decides nothing about who the caller is.
3. **A use is noted in memory and written in batches.** `admit` notes that a token or a session was used. A
   flush under the write gate, once a minute and on a graceful stop, writes `last_used_at` and `last_seen_at`.
   Lists and the idle check read the newer of memory and the row. A read never waits for a writer, and a token
   that only reads shows its use.
4. **Sign-in is an exchange of the HTTP surface, not an operation.** `POST /api/login` takes a proof and answers
   with a cookie. `POST /api/logout` ends the session in the database and clears the cookie. The registry
   refuses a call with no actor, an operation is synchronous inside a transaction, and a password check must
   not hold the write gate, so sign-in cannot be an operation without a second way to run one.
5. **Everything a signed-in caller does is an operation**: listing and ending sessions, credentials,
   invitations, token expiry. Pull request 4 adds `"self"` to what an operation may need, and one function
   decides "my own, or anyone's if I am an admin".
6. **A session opened with a token depends on that token.** Revoking the token ends the sessions it opened,
   by a join when the session is read and not by a second write. A forgotten actor's sessions are refused
   because the actor is disabled, and `forgetActor` also marks them ended.
7. **The cookie** is 32 random bytes in base64url, and only their SHA-256 is stored. Its name is
   `__Host-mainworthy_sid` over https and `mainworthy_sid` over plain http, because a browser accepts the
   `__Host-` prefix only with `Secure`. It is `HttpOnly; SameSite=Strict; Path=/`, and `Max-Age` is the absolute
   lifetime. The cookie of earlier builds, `mainworthy_session`, signs nobody in.
8. **Lifetimes.** A session ends after 14 days without use and after 90 days in any case. Both are `Config`
   fields, read from `MAINWORTHY_SESSION_IDLE` and `MAINWORTHY_SESSION_MAX` as durations (`12h`, `14d`, `2w`;
   `src/core/duration.ts`). A value that is not a duration stops the start.
9. **One migration for each pull request**, holding only what that pull request uses. One migration with every
   table up front was turned down: two tables nothing reads for three pull requests, in a file that can never
   be edited.
10. **Sessions, and later credentials and invitations, are never exported.** `UNEXPORTED` in
    `src/server/transfer/transfer.ts` is the one list: an export leaves those tables out and an import empties
    them, a table before the one it refers to. A test holds the list equal to every table of identity but the
    three an archive is meant to hold: `orgs`, `actors` and `grants`. (Until pull request 4 the test went by a
    column named `hash`; a password's hash and a passkey's key are in a column of another name.)

## What the first pull request builds

Migration `0002_sessions.sql` adds the table `sessions`. `src/server/identity/sessions.ts` owns it and
`src/server/identity/uses.ts` holds the last uses. `identity.ts` gains `admit`, `signInWithToken` and `signOut`.
`noteTokenUse` and its two callers are gone. The web UI's sign-in form still takes a token, and the page has no
sign-out button yet: the route is there for one.

**A session is alive** when it is not ended, the clock is before its absolute end, it was used less than the
idle lifetime ago, the token that opened it still works and names the same actor, and that actor is not
disabled. `openSession` is given the hash of the token that was presented and no id. It makes a row only when,
in the statement that writes it, a token with that hash exists and works and its actor stands. A sign-in reads
the token before it waits at the write gate, and an import that runs meanwhile deletes every token; the next
token made takes the first id again. An id read before the wait would then name another token, so none is
carried across it. The independent check of this pull request found that with a run: a sign-in queued behind an
import and a new token was let in with a token that no longer existed. A session with no token does not exist
until pull request 4 gives it a credential to depend on.

**The rules of the last-use notes** (`uses.ts`):

- `admit` checks the session against the newest use known, in memory or in the row, and notes the new use only
  after the session passed. A cookie past its idle time is refused however often it is sent.
- A note is a maximum. An earlier time never replaces a later one.
- A flush writes under the gate and removes a note only after its write committed. A failed flush keeps every
  note.
- The flush only updates. It never makes a row, and it leaves an ended session's row alone, so a flush after a
  sign-out reopens nothing.
- `/api/logout` commits the end before it answers. It ends the session of the cookie it was sent, needs no
  session of its own and answers 200 for no cookie, an unknown one and an ended one. A bearer token on the same
  request changes nothing.
- A successful import clears the notes, because a row made afterwards takes an old id.
- The minute timer also ends, in the database, every session past a lifetime (`ended_why = 'expired'`), so a
  clock set back later does not revive it. It deletes a session's row 30 days after the session ended.
- `token.list` reads the newer of memory and the row.

What a crash loses is what was noted since the last flush that committed: normally a minute, longer behind a long
write. It can make somebody sign in again early. It cannot make a session live longer.

**No reply leaves after standing ended.** A read goes to a reader thread with the actor as it stood when the call
was dispatched. A reader that was busy can start the read after a sign-out. So `invokeAsync` asks the caller
again when the reader has answered, and answers `unauthenticated` when it stands no more. A write already asked
after its wait at the gate.

**Cookies.** One function gives the scheme the browser used; the cookie's name, `Secure` and every deletion use
it. A reply carries each cookie in a `Set-Cookie` header of its own. Sign-in and sign-out also expire
`mainworthy_session` and, over https, the session cookie's other name. Over plain http the `__Host-` name cannot
be expired, because a browser refuses that prefix there. Two cookies of the session's name in one request are
treated as none.

**Archives keep importing.** `transfer.ts` required an archive's schema to equal the build's, so this migration
would have refused every archive taken before it, though no exported table changed. Each entry of `MIGRATIONS`
now says whether it changes what an archive holds. `ARCHIVE_VERSION` is the last entry that does; an export writes
it and an import requires it. It is 1 before and after this change.

## What the second pull request builds

A limit on failed attempts (issue #88 item 1). `src/server/identity/limiter.ts` holds the rule. It is pure, takes
the clock as an argument and counts opaque keys. One limiter is kept for each instance, in memory (`attempts.ts` since the fourth pull request, which counts
people in it too).

**What is counted.** A secret presented as a token where the server asks who the caller is: in an
`Authorization` header on a route that takes a session, or in a body `POST /api/login` accepts. Both go through
one function (`present` in `identity.ts`), so they share their keys. A route that takes no session (`/healthz`,
the API description, the documentation) looks at no token, and a sign-in body the schema refuses (longer than
512 characters, or not a string) is refused without being counted; neither tests a credential. A session cookie
is never counted, right or wrong, and neither is the owner of the machine in local mode or `POST /api/logout`.

**The keys.** The address the request came from, and the first 8 characters of the secret (after `cb_` when
it has that marker). An IPv4 address is its own key. An IPv6 address is keyed by its /64, the network one
subscriber holds. A loopback or private address has no key, and neither has an empty secret: each would be one
key for many callers, and one of them could block the rest. The account name is a third key, since the fourth pull request (`accountKey`).

**The rule.** The fifth failure of a key within 15 minutes blocks it for 1 second. Every failure after that
doubles the block, up to 15 minutes. A key is forgotten 15 minutes after its last failure or the end of its
block, whichever is later. A success outside a block clears the secret's key and never the address's: one valid
token used between guesses would otherwise reset the count of the address that is guessing. A correct generated
token that passes during a block reports nothing, so it clears nothing, its own key included. The block runs
out by the clock.

**A blocked request** is answered 429 with `Retry-After` in whole seconds and the error code `limited`,
before the secret is looked up, and nothing is reported for it: asking again does not lengthen the block. The
one exception is a secret in the form the server generates (`cb_` and 32 characters). It is looked up, and it
passes when it is right and the server made it. Nobody guesses 190 bits, and refusing a right token would let
anybody who shares an address with a pipeline stop it. A wrong secret in that form is answered 429 like any
other and is not counted while the block lasts. A secret a person chose gets no pass: a right guess at one is
what the block is there to prevent.

The form does not say who chose a secret. `MAINWORTHY_OWNER_TOKEN` holds whatever the operator wrote, and
`cb_` and 32 letters somebody typed are not 190 random bits. So the pass goes by the token's row: a token whose
`source` is `env` gets none, in any form, and is answered 429 as a wrong one is. A token `token.create` made,
and the owner's token a start generated, pass. (The first build of the limit went by the form alone; the
independent review showed an owner token written in that form passing a block.) A generated owner token that
the operator later copies into the variable keeps its row and its source, and still passes: the server made it.

**The address.** The HTTP surface says where a request came from (`clientAddress` in `src/surfaces/http.ts`)
and hands it to `admit` as one more fact; the identity module reads no header. It is the address of the
connection. Headers are ignored, unless the connection comes from a peer in `MAINWORTHY_TRUSTED_PROXY`
(addresses and ranges): then it is what that peer wrote in the header `MAINWORTHY_CLIENT_ADDRESS_HEADER`
names. That header must hold exactly one address. Missing, or anything else, and the request has no address
key; it is not counted under the proxy's own. The two variables are set together or not at all. One without
the other, a header name that is not one, or a list entry that is not an address or a range stops the start
with a line that names the variable and the entry, before anything is opened. In server mode with neither set,
the start says in one line that a failed sign-in from a loopback or private address is not counted against that
address.

**The memory is bounded** at 10,000 keys. When a failure brings a new key to a full limiter, keys whose time
has passed are dropped, then the key that failed longest ago. Whoever can fail with 10,000 distinct keys makes
the limiter forget an older one and so buys its four free failures again: 10,000 requests for five guesses.
The alternatives are worse. Growing lets a flood take the process's memory, and refusing new keys lets the same
flood switch the limit off for whoever comes after it.

**The error codes are one list.** `limited` is a new code, and the codes were written out in five places: the
server's statuses, the envelope's type, the CLI's and the web client's schemas, and the schema the reader
threads' replies are read with. They are now `ERROR_CODES` and `HTTP_STATUS` in `src/core/api.ts`, the API
description is made from them, and `test/architecture.test.ts` fails on a second copy.

**Where the code is.** How an address and a range are written is in `src/server/kernel/address.ts`, not in
the limiter: the configuration is the kernel's, the kernel imports no module above it, and `defaultConfig` has
to read the list of proxies before anything is opened. `Config` has one field for the proxy,
`proxy: { peers, header } | null`, and not one for each variable, so a configuration with one half set cannot
be written down.

**Not done here.** The values of the two variables for the instance at `mainworthy.com` are not measured, and
`compose.coolify.yaml` does not pass them. `docs/deploy.md` says which values are expected and how to check
them: eight wrong tokens from one network, then two from another. Until that is done, a failed sign-in on that
instance is counted against the first 8 characters of its token and against nothing else.

## The two pull requests that follow

**3. What a token may be** (issue #88 items 2, 4, 5). Built. Migration `0003_token_limits.sql` adds
`expires_at`, `created_by`, `source` and `last_used_addr` to `tokens`, and `created_addr` and `last_seen_addr` to
`sessions`.

- **An end.** `token.create` takes `expires`, a duration, and stores the moment. One rule decides whether a token
  works (`works` in `identity.ts`): it was not revoked, and the clock is before `expires_at`. The join that reads
  a session with its token holds the same condition. So a token past its end is refused exactly as a revoked one
  is: as a bearer, at sign-in, by every session it opened and by a change stream before its next event. Nothing is
  written when the end comes. A token that ended is not another way in for the owner: `token.revoke` still keeps
  the owner's last token that works, and a start with no token configured generates one when all of the owner's
  have ended.
- **Replacing one with no gap.** Two tokens of one actor already worked side by side. What was missing is the
  end, `mainworthy token new --expires 90d`, the end and the maker in `mainworthy token list` and in Settings,
  and a line at each start for every token that ends within 14 days. The line names the token's id, actor and
  label.
- **The owner's token from the environment.** `source` says which start-up rule made a token: `env` or
  `generated`. When `MAINWORTHY_OWNER_TOKEN` holds a value that is not yet a token, the start revokes every
  `env` token that was not revoked, whoever its actor is, in the transaction that inserts the new one, and one
  line names each token and its actor. There is one such variable, so at most one `env` token should work. The
  first build retired only the `env` tokens of the owner the start named; the independent review showed that a
  start which changed `MAINWORTHY_OWNER` and the token together left the earlier value working as an
  administrator. A value that is already a token retires nothing: setting the variable back to a revoked value
  does not revive it and does not revoke the current one. A configured value that is a token which was revoked,
  has reached its end or is somebody else's is left as it is, and the start says which. A value shorter than 20
  characters stops the start, and one shorter than 32 warns on every start. `POST /api/login` no longer requires
  8 characters; its schema says a token is a string of at most 512, and a configured value longer than that
  stops the start, so no token that works is too long to sign a browser in. A start that is refused says that no
  actor and no token was changed: the database is brought to the build's schema before the owner is looked at.
- **Last use, with the address.** A note in `uses.ts` carries the address beside the time. The flush writes the
  address only when the note has one and is not older than the row, so a use with no address erases none and an
  old use does not replace a newer address. `openSession` writes where a session was opened from. The address is
  the one the limit counts failed attempts against, `clientAddress` in `src/surfaces/http.ts`: the other end of
  the connection, or what a proxy the operator named reported.
- **Who made it.** `createToken` records the actor that asked. `token.list` shows `expiresAt`, `createdBy` and
  `lastUsedFrom`.

Four things were added to the design while it was built. `token.list` also answers `expired`, by the server's
clock, so that a client whose clock is off does not call a refused token active. `openSession` writes the
sign-in's address as the session's last address too, since the sign-in is its first use. The length rule holds in
local mode as well, because the configured value becomes a token there too. And forgetting an actor erases the
address each of its tokens was last used from, in the row and in the notes: a token's row is never deleted, and
an address says where a person was.

**4. People** (issue #30, first slice; as built, see "What the fourth pull request builds" below, which says
where it departs from this paragraph). Migration `0004` adds `credentials` and `invitations`. A person signs in
with a name and a password, or with a passkey. An admin invites a person with a link, since there is no email.
A person lists and ends their own sessions. Three rules came from the review:

- A password never enters the registry, which stores a digest of each request. Setting one is a route of the
  exchange family: the current password is verified and the new one hashed with `Bun.password` outside the gate,
  then a short commit under the gate reads the actor and the credential's revision again.
- `/invite/<code>` is a public page that changes nothing on GET, because mail and chat previews fetch links.
  Accepting is a same-origin POST. A browser signed in as somebody else is told who the invitation is for and
  asked before its session is replaced.
- The passkey verifier is hand-written and parses no CBOR: the page sends the key as SPKI and the authenticator
  data as bytes, and `node:crypto` verifies ES256 and RS256. It gets a review of its own before the pull request
  opens. The server claims that no attestation was requested, never that one was verified. If that review
  finds a protocol defect that is not a one-line fix, the pull request uses `@simplewebauthn/server` behind the
  same interface.

## What the fourth pull request builds

The server and the command line. The pages of the web UI follow in a pull request of their own, built from
these routes and operations.

**Tables** (migration `0004_people.sql`; none travels in an archive). `credentials` holds what a person signs in
with: a password as an argon2id string, a passkey as JSON with its public key and counter, with the passkey's
credential id in a column of its own under a unique index, so an id is registered once on the instance for
good. `invitations` holds the SHA-256 of a link's code. `passkey_users` holds one random handle per person,
which an authenticator files their passkeys under; it is not a column of `actors` because an archive holds
`actors`. `sessions` gains `credential`: a session rests on the token or on the credential that opened it. The
table refuses a row with both, `openSession` makes a row with a token and `openSessionOnCredential` one with a
credential, and a row with neither is alive to no reader. A session of either kind says where it was opened
from and last used from, and `session list` shows both.

**Signing in** is four bodies of `POST /api/login`: `{ token }`, `{ name, password }`, `{ passkey }` and
`{ invitation, password?, passkey?, label?, replace? }`. `POST /api/login/challenge` answers a passkey's
options for a sign-in (`{}`) or shows an invitation with the options to register a passkey with it
(`{ invitation }`), and writes no row: a challenge is an entry in a map in memory, bounded at ten thousand,
and a new one can push out the oldest. `GET /api/login/methods` says whether the instance has passkeys.
`POST /api/account/password` sets or changes a password from a signed-in browser. They are in
`src/surfaces/signin.ts`. A name, a password, a passkey's answer or an invitation code that is looked at and
refused is 401 and one sentence whatever was wrong, with the reason in the log as a code. The replies that
are not that 401 are listed with the departures below.

**Operations.** `Need` gains `self`. `session` (list, end) and `credential` (list, `passkey.begin`,
`passkey.add`, remove) need it; `invitation` (create, list, revoke) needs `admin` and a person. `mayActFor` in
`identity.ts` is the one place that says whose things a `self` operation may touch. `mainworthy invite` prints
an invitation's link once.

**Rules.**

- A sign-in is judged twice: outside the write gate, where a password is hashed and a signature checked, and
  again in the commit. The commit reads everything by what it holds and not by a row's number: a person by
  name, a password by its stored hash, a passkey by credential id, key and counter, an invitation by the hash
  of its code. An import gives a row's number to somebody else, and the independent check of pull request 1
  showed a sign-in that waited across one and opened a session for whoever came after.
- A challenge is kept in memory for five minutes with what it was issued for, bounded at ten thousand, and
  spent by the commit that stores the passkey or opens the session. An import ends every ceremony under way.
- A ceremony is finished where it began. The challenge keeps its initiating context, and an answer is taken
  only from there. Every path compares it in the commit that spends the challenge; a sign-in and an
  invitation also compare it when the answer arrives, before the wait for that commit:
  - A sign-in, where nobody is signed in yet: the reply that carries the challenge sets a cookie of 32 random
    bytes (`mainworthy_ceremony`, or `__Host-mainworthy_ceremony` over https; `HttpOnly; SameSite=Strict;
    Path=/`, `Max-Age` of the challenge's five minutes, `Secure` over https, by the same function that
    names and sets the session cookie). The challenge keeps the cookie's SHA-256. An answer with no such
    cookie, another one, or two of them is refused with the one refusal of a sign-in and counted like any
    refused answer. The reply to an answer that was looked at clears the cookie, whatever came of it. A
    request refused before that (one from another site's page, or a body that is not exactly a passkey's
    answer) leaves the cookie, and the challenge, as they were.
  - A signed-in registration: the session that asked, by the hash of its session cookie, which is what its
    row stores. Another session of the same person does not complete it. The owner of the machine in local
    mode, who has no session, is one context. A bearer token is none: `passkey.begin` and `passkey.add`
    refuse a token (403), as the password route does, because a way in that a script could add would outlive
    the token.
  - A registration with an invitation: that invitation, by the hash of its code. Another invitation for the
    same person does not accept a passkey made for the first.

  No row's number is kept: an import gives it to another row. The earlier review of the verifier asked for
  this, the list above `verifyRegistration` left it out, and the independent check of this pull request found
  each of the three completed from somewhere else. No takeover was shown, since a valid signature or the
  account's own authority was still needed; a signed answer is now also worth nothing without the browser,
  session or invitation it was made for.
- The challenge an answer names is read from its client data by the verifier's own reader (`challengeOf` in
  `webauthn.ts`), so the caller accepts exactly the bytes the verifier accepts, one leading byte-order mark
  included.
- The relying party is `MAINWORTHY_PUBLIC_URL` and nothing a request says. A value no browser would make a
  passkey at (an IP address, plain http off `localhost`) stops the start. So does one with a path or a
  query, for another reason: the server wants the root address of the instance. Without it there are no passkeys and a link has no host.
- A password is 12 to 256 characters. Changing one makes a new row and revokes the old, which erases its hash;
  the sessions that rested on the old one end, but for the one that made the change.
- An invitation to recover revokes every credential and ends every session of the person when it is accepted,
  and not before. The owner makes one for anybody, and an admin who is a person makes their own, as a token
  for a person is made. Nobody else makes one: `invitation` needs `admin`, so a person who does not
  administer asks the owner.
- A person's last credential is not removed, by them or by an admin: a recovery link is the way.
- The owner's token rule does not change: the last one is not revoked, whatever else the owner signs in with.
- The limit on failed attempts counts a person's sign-in in the limiter that counts tokens, so an address
  blocked for one is blocked for the other. A name and a password, and the current password of a change, are
  counted under the address and under the name (`accountKey`: lower-cased, cut to a name's length). A password
  is a secret a person chose, so while either key is blocked it is not looked at, and a success clears the
  name and never the address. A name nobody has is counted exactly as a wrong password is. A passkey's answer
  that is refused and an invitation code that accepts nothing, at acceptance or where the page looks at it,
  are counted under the address alone, and a right one of either passes a blocked address, as a right
  generated token does: nobody guesses a signature or 256 random bits.

**Where it departs from the design above, and why.**

- `self` is any signed-in person or agent, and not a pipeline. A pipeline's token reaches `report` and `gate`
  and nothing else (decision 0014), and a test holds that for every operation of the registry.
- There is no `credential password.set` (the design's first list had one). A password never enters the
  registry, so setting one is the route.
- The link is `/invite#<code>`, not `/invite/<code>`: the part after the `#` is not sent to a server, so the
  code reaches no proxy's log.
- The page of an invitation is told 404 for a code that accepts nothing, and an acceptance is told the 401 of
  every refused sign-in. Each is one reply for every reason a code does not work. From an address that is
  limited, a code that does not work is told 429 instead.
- These replies of `POST /api/login` are not that 401: too many failed attempts (429, with the seconds to
  wait), a password that is not 12 to 256 characters (400, said before the invitation is looked at), an
  invitation accepted with neither a password nor a passkey (400), a passkey on an instance with none (400),
  a browser signed in as somebody else (409, with the name), which the page needs in order to ask, and a
  body that is still arriving after the time a sign-in is given (408, and the connection is closed). A body
  over 16 KiB or one that is not JSON is told that 401; until the independent check found it, it was told
  the sentence of a wrong token. A request from another site's page is refused before its body is read,
  with a wrong token's sentence.
- A new invitation for a person revokes their earlier ones that nobody accepted, so one link is good at a time.
- `replace` is the name of the person the page asked about, not a yes. The page asks "you are signed in as
  robin, go on as sam?" and sends `replace: "robin"`. In the commit that accepts the invitation the server
  reads again who the browser's cookie signs in. When that is somebody other than the invited person and
  `replace` is not exactly their name, it answers the 409 with `details.signedInAs`, the name it is now, and
  changes nothing, so the page asks again. With no session, or the invited person's own, a name ends
  nothing. A `replace` that is not a name is 400. The first form was a boolean: the reviewer of the pages
  signed a third person in from another tab between the question and the answer, and the server ended that
  person's session, about whom nobody had been asked.
- A person's passkey handle is made when they are invited, so that showing an invitation writes no row. It
  does add a challenge to the map in memory.
- A failed answer does not spend its challenge; a successful one does. A wrong answer proves nothing about the
  challenge, and the next answer is judged the same.
- Two passwords are hashed at once and thirty-two wait; past that a sign-in is refused. One hash takes 64 MiB,
  and a sign-in needs no name that exists to ask for one.
- A revoked credential's row is kept, for the credential id, and what it held is erased.
- The reply of a wrong token keeps its sentence (`a token is required`), and a refused sign-in of a person has
  its own (`that did not sign you in`). Both are 401 `unauthenticated`.
- Counting by name lets whoever knows a name keep that name's password sign-in blocked, for as long as they
  keep guessing. It is accepted: the other choice is unlimited guesses at one person's password from many
  addresses. A passkey is not held up by it, and a block is at most fifteen minutes after the last guess.

**What the pages asked for**, found when the web UI was built from these routes:

- `GET /api/session` says whether the caller is the owner (`owner`), because the owner alone makes a recovery
  link for another person and a page must know where the server will refuse.
- How long a password is (`PASSWORD_LENGTH`, `whyNotPassword`) is in `src/core/people.ts`, which the page
  imports, and no longer in the server.
- `invitation list` shows each person's grants, as `actor.list` does.
- A credential stored by accepting an invitation is marked as used at that moment: it signed its person in.
- An operation of the instance is answered at `/api/<operation>` only. Before, the registry ran one under any
  project's address, `admin` included, and a client written against the wrong address worked.

**Not built here.** The pages. Unicode normalisation of a password: it is compared as the bytes that were
typed.

**Not tried.** In a browser, passkeys were tried with Chromium's built-in test authenticator only
(`test/e2e/people.test.ts`, `test/e2e/passkey-verifier.test.ts`). No physical security key, no synced passkey
and neither Safari nor Firefox has been tried.

## The pages

The web UI for the fourth pull request: the sign-in page, the page of an invitation, "Your sign-in", "Your
sessions" and "People" in Settings, and sign-out. What each screen must do, and the browser test that holds
it, is in `src/web/CHECKS.md`; the guide describes them for a person (`docs/guide/access.md`).

**Choices.**

- The three ways of signing in are on the page at once: name and password, the passkey button, and the token
  form under "Use a token". A disclosure for the token form was turned down. It would put the owner's only way
  into a new instance behind a click, and every way is otherwise one Tab away.
- The page says its own sentence for the server's 401 ("That name and password did not sign you in."). A wait
  (429) is "Too many attempts. Try again in N seconds.", with N read from `Retry-After`, the same wherever a
  proof can fail: the three ways of signing in, the invitation page and the current password in "Your
  sign-in". One function words it (`exchange` in `src/web/lib/api.ts`). Any other refusal is shown as the
  server wrote it. After a wait the page does not send the proof again by itself: the person presses the
  button.
- The invitation page takes the code out of the address bar when it reads it, not when the invitation is
  accepted: a code that sits in the address while a form is filled in is copied with it. The price is that a
  reload has no code, and the page then says to open the link again.
- The question for a browser signed in as somebody else comes before the form, from `/api/session`. The
  fields wait until the page knows who is signed in, and then for the answer. Not knowing is a state of its
  own and is not taken for "nobody": when the lookup fails, or has no answer after twenty seconds, the page
  says that it could not find out and offers to ask again, and the fields stay closed. Twenty seconds,
  because the answer is one small reply that a slow connection brings in a second or two; the first asking is
  not given up, and an answer that comes late is still taken.
- The answer is about one person, and `replace` carries that person's name. The first version sent
  `replace: true`, and an independent check showed what that allowed: the page asked about robin, somebody
  else signed in from another tab, and the acceptance ended their session with no question about them. Now
  the server reads who holds the browser when it accepts and answers 409 with that name unless `replace` is
  exactly it. The page then asks about the person the 409 names and sends nothing until "Continue". It never
  sends a name that was not on the page when the answer was given. What was typed is kept for that second
  sending, and so is a passkey that was already made, while its challenge lasts; past that the page says so
  and the passkey is made again.
- The page shows a new link under sentences of its own, written from `purpose`, `name` and whether the link has
  a host, and does not show the reply's `note`. For an instance with no public address the note says to put
  the address before the link, and the page has already done that with the address it was opened at.
- "Recovery link" is offered where the server allows it and nowhere else: beside every person for the owner
  (`owner` of the session), and beside their own name for another admin of the instance, who is told that
  the owner makes the others. A button that is always answered 403 was the first version, before the session said who the owner is.
- A new invitation starts with what a person needs to work: read, record, produce, answer and plan. `admin`
  is for the inviter to tick, with a line saying what it gives, and is unticked again after an invitation that
  had it. The server's own default for an invitation with no `can` is still everything, as for a token; the
  page always sends what is ticked.
- A link that was made stays on the page until it is dismissed or the section is left, with one exception: a
  newer link for the same person takes its place, because the server revoked the earlier one when it made the
  newer. A link for somebody else, or a recovery link that is refused, does not take it away.
- A control whose request is under way is marked `aria-disabled` and stays focusable, and its handler lets
  one request through. Disabled, it dropped the focus, and somebody working by keyboard was left on nothing
  after a refusal. The two selects of the invitation form keep the focus when they change, unlike the shell's
  selects, which give it up so that the next plain key is a shortcut: here the next key is another arrow.
- When accepting an invitation, making a link, changing a password or signing out gets no reply, the page
  says only what it knows and how to find out, and does not say "try again": the server may have acted, and a
  second press would act again. It infers nothing from what happens next either. The first wording for a
  password said that a refused current password meant the change had gone through, which a mistyped current
  password disproves. A sign-out with no reply is looked up at `/api/session`. Ending a session, removing a
  way of signing in and revoking an invitation are safe to repeat, and do say to try again, with their list
  read again.
- A proof or a change is sent once for each press, never again by the page itself. What the page repeats by
  itself only reads: a list, and `/api/session`.
- Enter and Space belong to a button that shows the focus (`src/web/lib/keys.ts`). The screens bind those keys
  too, and took them from "Sign out" on the Suite, which could then not be pressed by keyboard. The one
  handler now lets them through to a button or a link that matches `:focus-visible` and is not a row of the
  screen's list. A button that was clicked holds the focus without showing it, so the screen's Enter and Space
  still work after a click.
- Ending this browser's own session in "Your sessions" calls `/api/logout`, as "Sign out" does, so the cookie
  is cleared too.
- The lists of sessions, credentials and invitations are read again every time their section opens. The cache
  keeps a read for fifteen seconds, and in that time a session that ended elsewhere would stay in the list
  with a button to end it.

**Not built.** An admin's view of another person's sessions and credentials, which the operations allow
(`actor`). Signing out does not record an open draft first; it stays on the device under the person's name, as
it does when a session ends by itself.

## The three candidates

Three candidates were designed independently from one brief. The design above takes its parts from all three.

**A: one authentication module, asked one question.** A new layer `src/server/auth` above `identity`, with tokens
moved into it, and two functions for every surface: `admit`, and an `exchange` behind one route `/api/auth`.
Taken: the one question and its plain `Facts`, a variable that names the header with the client's address, the
`Duration` syntax, the one list of unexported tables with its test, and the hand-written passkey verifier. Turned
down: the new layer and the move, and the single route, which the two existing paths serve without a new name.

**B: derive the tables from accounts, and put everything but the cookie in the registry.** One noun for each
table, `"self"` as a need, and operations for sessions, credentials and invitations. Taken: staying in
`identity`, sign-in as an exchange and everything after it as an operation, and the shapes of `credentials` and
`invitations`. Turned down: one migration up front, sign-out as an operation (a sign-out must work with no
session), and hashing a new password inside the operation, which would hold the write gate.

**C: resolve authority where the operation runs.** A credential reference travels to the reader thread, which
resolves the session, token, actor and grants in the snapshot that runs the read. Sign-in is an asynchronous
operation kind. Taken: the finding that a reader is handed authority that can be stale, and the rule that a
right generated token passes a blocked prefix. Turned down for now: the new operation kind, which adds a second
driver to `execute` to document a call only a browser makes, the walk through `X-Forwarded-For` with trusted
networks, and `@simplewebauthn/server`, which would add ten direct dependencies to a project with eight.

## What the independent review changed

A model from another provider reviewed the design against the code before anything was built. What it changed:

- It showed, with a run, that a read dispatched to a busy reader was answered after a token was revoked. The
  reply check above closes that at the reply. Reading authority inside the read's own snapshot stays deferred.
- The design said "a flush writes last uses" and no more. The rules of the notes above are the review's.
- A session that expired could come back when the clock was set back. The minute timer now ends it in the
  database.
- The cookie rules: separate headers, one scheme function, deletions valid for each name, two cookies as none.
- The migration would have refused every earlier archive. `ARCHIVE_VERSION` is the answer.
- A session needs the token's own row. A missing token is not a working one.
- The limit, as first written, let anybody block a pipeline that shares their address, or a token whose first
  characters they know. The pass for a right generated secret and the named proxy peers replace it.
- Password setting and the invitation page, as described under pull request 4.
- The hand-written passkey verifier stays on the conditions given there.

## Tradeoffs accepted

- Everyone signs in once more after the upgrade. The old cookie is not exchanged for a session: it held the
  token, and a year-old copy of it should stop working.
- A crash loses the uses noted since the last flush, and somebody may be asked to sign in early. In exchange no
  read waits for a writer and no request writes a row to say it happened.
- A read that ran on a reader thread asks who the caller is once more before it answers: two or three point
  reads on the reading connection.
- A session whose token was revoked keeps its row unended until a lifetime passes. It is refused all the same,
  because being alive is read with the token.
- A session that expired less than a minute before the clock is set back, so that the minute timer has not
  ended it yet, is alive again until the clock reaches its end a second time. A use noted at a time that is now
  in the future counts as a use now.
- The limit's state is in memory and a restart forgets it, so a failed attempt never reaches the write gate.
- A token past its end is refused by the clock alone. A clock set back to before the end makes the token work
  again until the clock reaches the end a second time. The minute timer does not end it in the database as it
  ends a session: the only mark a token's row has for that is `revoked_at`, and an expiry is not a revocation.
- The start retires a token by its `source`, and `source` was filled from the label for tokens made before the
  column existed. A token somebody labelled `owner (from ...` by hand before the upgrade is marked `env` and is
  retired by the next changed value, whoever its actor is.
- A changed value retires the previous owner's `env` token when the owner's name changes in the same start. That
  person keeps the name and the grants and loses that one token. The other choice left an administrator's token
  working after the operator replaced it.
- The owner can still run out of tokens: the owner revokes the one with no end while another works, and that
  other one then ends. `token.revoke` keeps the last token that works now and does not look ahead. The next start
  is the way back in. With no token configured it generates one. With one configured that no longer signs the
  owner in, it says why (the token was revoked, or reached its end and when) and asks for a new value; a value
  that is not yet a token becomes the owner's token.
- A token's last address stays with its row after the token is revoked or has ended, and nothing deletes a
  token's row yet (`docs/compliance.md`).
- The address is the key that slows a guesser. The first 8 characters only count guesses that share them, and
  a guesser who changes them with every guess is counted once under each. So where a request has no address
  key (from a loopback or private address, which is what a proxy the configuration does not name usually has)
  that guesser is not slowed at all. The start says so, and the two variables are the fix.
- A proxy the configuration does not name and whose address is public is counted as one address. Its visitors
  share one count, and five wrong tokens from one of them block a token a person chose for all of them while
  that visitor keeps failing. Generated tokens and signed-in browsers still pass. Naming the proxy is the fix.
- Somebody who knows the first 8 characters of a token a person chose can keep that token blocked by guessing
  at it, from any address. A generated token cannot be blocked that way, which is one more reason to let the
  server make the owner's.
- A holder's success clears the count of their token's first 8 characters. A token in constant use is therefore
  protected by the count of the guesser's address, and not by its own.

## Deferred

Each of these is an issue and is not built in the four pull requests: reading authority inside the
transaction or snapshot that runs the operation, reader threads included (#113); OIDC (#114); TOTP (#115);
teams and roles for each project (#30); a chain of trusted proxies, and the two proxy settings on the owner's
instance (#116); a person's own CLI token (#117); mail for invitations and recovery (#122).

## What breaks

Nothing has to stay compatible before 1.0. A signed-in browser is signed out by the upgrade and signs in again
with a token. `Session` has no `secret`. Two things are kept on purpose, because the owner's own instance holds
data: a database made by the previous build is migrated with a backup beside it, and an archive exported by the
previous build still imports. Each has a test with a file that build made (`test/fixtures/sessions/`).

Pull request 3 breaks three things. A `MAINWORTHY_OWNER_TOKEN` shorter than 20 characters or longer than 512
stops the start. A row of `token.list` has four more fields, and a line of `mainworthy token list` has more
columns. A changed `MAINWORTHY_OWNER_TOKEN` now revokes every token that came from the variable before, where
both values worked before. A database made by
the build before it is migrated with a backup beside it, and its tokens and sessions keep working; the test uses
a database that build made (`test/fixtures/tokens/`).
