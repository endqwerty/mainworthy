# 0017: Sign-in, sessions and credentials

- Date: 2026-10-13
- Status: proposed. Four pull requests deliver it. The first is built in the pull request that adds this file;
  the owner reviews.

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
    them, a table before the one it refers to. A test holds the list equal to the identity tables with a `hash`
    column.

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

## The three pull requests that follow

**2. A limit on failed attempts** (issue #88 item 1). `identity/limiter.ts` is pure and takes the clock as an
argument. Keys are the client address and the first 8 characters of the presented secret, later also the account
name. The fifth failure within 15 minutes blocks a key for 1 s, doubling to 15 minutes. A blocked key is
answered 429 with `Retry-After` before the credential is looked at, with one exception: a right secret in the
generated format always passes. Guessing 190 bits is not what the limit is for, and refusing a right token would
let anybody who shares an address with a pipeline stop it. A secret a person chose gets no pass. A session cookie
is never counted. The client address comes from `MAINWORTHY_CLIENT_ADDRESS_HEADER`, believed only from the peers
`MAINWORTHY_TRUSTED_PROXY` names; setting one without the other stops the start.

**3. What a token may be** (issue #88 items 2, 4, 5). Migration `0003` adds a token's expiry, creator, source and
last address. `token.create` takes `expires`; an expired token is refused and its sessions with it. A changed
`MAINWORTHY_OWNER_TOKEN` retires the one it replaces. A hand-set owner token shorter than 20 characters stops
the start, and one under 32 warns.

**4. People** (issue #30, first slice). Migration `0004` adds `credentials` and `invitations`. A person signs in
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

## Deferred

Each of these becomes an issue and is not built in the four pull requests: reading authority inside the
transaction or snapshot that runs the operation, reader threads included; OIDC; TOTP; teams and roles for each
project; a chain of trusted proxies; a person's own CLI token.

## What breaks

Nothing has to stay compatible before 1.0. A signed-in browser is signed out by the upgrade and signs in again
with a token. `Session` has no `secret`. Two things are kept on purpose, because the owner's own instance holds
data: a database made by the previous build is migrated with a backup beside it, and an archive exported by the
previous build still imports. Each has a test with a file that build made (`test/fixtures/sessions/`).
