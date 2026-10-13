# How Mainworthy fits together

A guide to the code as built in the MVP. The product design it implements is
[product-design.md](product-design.md); where the code departs from it is
[decision 0012](decisions/0012-mvp-scope-and-departures.md).

Explorable diagrams (open in a browser; they are self-contained HTML):

- [The architecture](diagrams/architecture.html): the surfaces, the operation layer, the modules and the store.
- [One red build](diagrams/red-build.html): a pipeline's report from upload to a green gate, step by step.
- [The life of a question](diagrams/question-lifecycle.html): raised, answered, carried forward, asked again.

## The idea in four sentences

Mainworthy keeps three kinds of record: what the software should do (cases, with versions), what was observed
(results from people, pipelines and agents, in one shape), and what people decided about it. Producers append
evidence; detectors turn evidence into questions, one per cause; a decision answers a question and is the only
thing that can change what is "current". Every surface (web, command line, API, agent tools) calls the same
sixteen operations. The whole instance is one process and one SQLite file.

## One process

```
 browser (React)     mainworthy CLI      CI pipeline       agent (MCP)
       │                  │                 │                 │
       └──── HTTP: POST /api/p/<project>/<op> ────────────────┘   + /mcp, /api/…/events (change stream)
                                 │
                    src/surfaces   http · mcp · formats/junit · ci-env · archive      no logic; adapters only
                                 │
                    src/server/ops   the registry (OPS) and invoke()                   the one public entry
                                 │
        ┌──────────────┬─────────┴──────┬───────────────┬──────────────┐
   decisions        runs            evidence          suite         identity · policy
   questions,       change runs,    tests, targets,   cases,         actors, tokens,
   answers,         planned runs,   batches,          versions,      the clause table
   the ledger       slots, verdict  results, causes   proposals
        └──────────────┴────────┬───────┴───────────────┴──────────────┘
                    src/server/kernel   db · migrations · ctx · witness · app
                                 │
                          one SQLite file (WAL)          one writer connection, reader threads
```

The documentation a user reads is served by the same process, at `/docs`: the Markdown pages in `docs/guide`,
rendered once and sent without a session, because they are the same for every instance of a version
(`src/surfaces/docs`, decision 0016).

`src/core` is beside all of this: pure functions and schemas with no I/O (the case document, the outline
grammar, canonical Markdown, diff, three-way merge, hashes, failure signatures, the policy presets, the verdict
function). The browser and the server run the same code from it.

## The operation layer

`src/server/ops/index.ts` lists every operation. Each has a name, a one-line summary, an input schema, the
capability it needs, whether it reads or writes, and, if it is an agent tool, a description written for a model.
From that one list come the HTTP routes, the OpenAPI document, the CLI commands and their help, and the MCP
tools. Adding a capability means adding an entry there; there is nowhere else to add one, and a test fails if
an operation named like a shortcut (`createCase`, `closeRun`) appears.

| | Operations |
| --- | --- |
| Produce evidence | `propose` (create or change cases, folders, links, the policy) · `report` (results) · `claim` (a review and its findings) |
| Request evidence | `plan` (start a run) |
| Decide | `decide` (answer a question, or withdraw a decision) |
| Read | `inbox` · `get` · `find` · `impact` · `since` · `gate` · `history` · `timeline` · `check` · `command` |
| Administer | `admin` (projects, actors, grants, tokens) |
| Sign in as yourself | `session` (your browser sessions: list, end) · `credential` (your password and passkeys: list, register a passkey, remove) · `invitation` (an admin invites a person with a link) |

`invoke` does the same things for every operation: check that the caller may run it, parse the input at the
boundary, and for a write, open a transaction, give the command the project's next **sequence number**, run it, record the
command id, commit, and publish what changed. A command id names one request: sent again unchanged it gets the
first reply and writes nothing; sent again with other content it is refused. A client whose reply was lost can
also ask `command` what became of the id, which writes nothing (decision 0013). A report is the one command that
commits twice, and it takes a sequence number for each transaction (see the red build below). A read runs on a
reader thread with its own read-only connection, so a long write does not hold it up; a write waits its turn at
one gate, because the file has one writer.

## Who may call

An actor is a person, an agent, a pipeline or the policy's own rule. What it may do is a grant per project (or
one for every project): a list of capabilities. A token names an actor and carries its grants.

| Capability | Lets its holder |
| --- | --- |
| `read` | call the reads |
| `record` | `report` results and read the `gate` |
| `produce` | `propose`, `claim`, `decide`, and everything `record` does |
| `answer` | have a `decide` count where the policy asks a member |
| `plan` | `plan` a run |
| `admin` | `admin` |

A pipeline holds `read` and `record` at most, whatever its grant says: it cannot change the suite, answer or
plan under any policy, because it cannot call the operations that do (`heldCapabilities` in `src/core/kinds.ts`;
decision 0014). The caller is refused before the operation checks its input. `grant.set` and `grant.remove` are the one way a
grant changes; a new token for an actor that exists changes nothing it may do.

`session` and `credential` ask for no capability. Their need is `self`: whoever is signed in runs them, a person
or an agent, with whatever grants, on what is their own. A person who holds `admin` on every project may also
list and end what is somebody else's, and one function decides that for every such operation (`mayActFor` in
`src/server/identity/identity.ts`; a test names the operations and where the decision is made). A pipeline is
refused: its token reaches `report` and `gate` and nothing else.

A caller that holds no grant on a project is told what it would be told of a project that does not exist, word
for word, in an operation and on the change stream: a refusal that named the missing capability would confirm
the project's key to any token. One that holds a grant there and lacks the capability is told which it lacks.

Holding `admin` is not being anybody. A token for a person who exists is made by that person or by the owner of
the instance, and one for the owner by the owner alone, because whoever holds a token for a name acts under it.
An agent that holds `admin` makes projects and tokens for agents and pipelines; it makes no person and no
person's token, changes no grant and forgets nobody. The owner is the person the configuration names
(`MAINWORTHY_OWNER`): the start gives that person every capability, refuses a name that is an agent's or a
pipeline's, and in server mode makes sure the owner holds a token that works. The owner is not forgotten, and in
server mode the owner's last token that works is not revoked.

A token works until it is revoked or reaches its end. `token.create` takes `expires`, a duration
(`src/core/duration.ts`), and stores the moment in `tokens.expires_at`; without it the token has no end. One rule
decides (`works` in `identity.ts`, and the same condition in the SQL that reads a session with its token), so a
token past its end is refused exactly as a revoked one is: as a bearer, at sign-in, by every session it opened and
by a change stream before its next event. Nothing is written when the end comes. A token's row also says who made
it (`created_by`) and which start-up rule made it (`source`): `env` for the value of `MAINWORTHY_OWNER_TOKEN`,
`generated` for one a start made because the owner held none. When the variable holds a value that is not yet a
token, the start revokes every `env` token that was not revoked, whoever its actor is, in the transaction that
inserts the new one, so a changed variable retires what it held before even when the owner's name changed with
it. A configured owner token shorter than 20 characters, or longer than the 512 a sign-in reads (`TOKEN_MAX`),
stops the start. Each start lists in `warnings` a short one, the retired ones, a configured one that no longer
signs the owner in (revoked, past its end, or somebody else's) and every token that ends within 14 days.

Who a request is from is one question, `admit` in `src/server/identity/identity.ts`, and every surface asks it.
The HTTP surface reads what the request carries (`factsOf` in `src/surfaces/http.ts`) and decides nothing: a
bearer token, else the session cookie, else, in local mode, the owner of the machine. The last needs no sign-in,
so the server checks what it can see of where the request started: a loopback Host, a connection from a loopback
address, and none of the headers a proxy or a tunnel adds. That is the immediate connection, not the original
client: a relay on this machine that passes bytes on unchanged looks the same, so a local-mode port is never
exposed through one. A cookie or the local owner is accepted only from the server's own page
(`Origin`, and `Sec-Fetch-Site` where the browser sends it). What `admit` answers with holds no secret. It can
be asked again who the caller is now, and an operation that waited at the gate, a read that ran on a reader
thread and the change stream before each event all ask. A failure that is not one of the operation's own
refusals is answered `internal error` and nothing more; what failed is in the server's log.

A browser does not hold a token (decision 0017). `POST /api/login` takes a token and opens a session: a row in
`sessions` and a cookie of 32 random bytes, of which only the SHA-256 is stored. The cookie is
`__Host-mainworthy_sid` over https and `mainworthy_sid` over plain http, `HttpOnly` and `SameSite=Strict`. A
session ends when its browser signs out, after 14 days without use, after 90 days in any case, when the token
that opened it is revoked or reaches its end, and when its actor is forgotten. `POST /api/logout` commits the end before it answers,
so a copy of the cookie stops working with it. Signing in and out are routes of the HTTP surface and not
operations: nobody is signed in yet, and the registry runs nothing for a caller it cannot name.

A person signs in as themselves with a name and a password or with a passkey, and the first time with an
invitation, the link an admin hands them since there is no mail (decision 0017). These are further bodies of
`POST /api/login`, beside the token, in `src/surfaces/signin.ts`, with `POST /api/login/challenge` for a
passkey's challenge and `POST /api/account/password` to set a password. They are routes and not operations for
one more reason: the registry keeps a digest of each request that carries a command id, and a password must
not reach it. A test fails when an operation's input has a field named like a password. A refused sign-in is
answered 401 and one sentence whatever was wrong, and the reason goes to the log as a code, so a reply does not
say which names exist. A name with no password is checked against a hash nobody's password matches, so the
refusal takes as long.

What a person signs in with is a row of `credentials`: a password as an argon2id string (`Bun.password`), a
passkey as its public key and counter. A row is one secret and is never changed into another, and a session
rests on the row or the token that opened it, never on both, and says where it was opened and last used from
whichever it is. Removing a credential, or changing a password,
ends the sessions that rested on it; the session that changed the password moves to the new row. An
invitation and a session cookie are stored as SHA-256 hashes, like a token. None of these tables is in an
archive.

Every way in has two halves (`src/server/identity/people.ts`). Outside the write gate the proof is judged
against committed rows: a password is hashed on another thread, two at a time, and a passkey's signature is
checked. Under the gate, in one transaction, everything is read and judged again before anything is written,
and it is read by what it holds and never by a row's number alone: a person by name, a password by its stored
hash, a passkey by its credential id, key and counter, an invitation by the hash of its code. Between the two
halves a password can change, a person can be forgotten and an archive can be imported, after which a row's
number belongs to somebody else.

The passkey verifier (`src/server/identity/webauthn.ts`) is hand-written, parses no CBOR and keeps nothing.
The code around it keeps what it must (the list above `verifyRegistration` there). A challenge lives in memory
for five minutes with what it was issued for, and the commit that stores the passkey or opens the session
spends it. A credential id is unique on the instance for good, by an index. The person is the one the stored
row names, and the user handle the browser returns must be theirs. The counter is compared again in the
commit. The relying party comes from `MAINWORTHY_PUBLIC_URL` and never from a request's `Host`; without the
variable the instance has no passkeys.

Being used is not a write. `admit` notes in memory when a token or a session was last used and from which
address, and the server writes the notes once a minute and when it stops (`src/server/identity/uses.ts`). The
address is the one `clientAddress` in `src/surfaces/http.ts` gives for the request; a use that has none (a request
that never was on a connection) writes its time and leaves the address in the row. The idle check and
`token.list` read the newer of the note and the row, so a read never waits for the writer. A crash loses the
notes since the last write: somebody may have to sign in again early, and no session lives longer for it. The
same minute timer ends, in the database, each session that has passed a lifetime, so that a clock set back does
not revive it.

Failed attempts are limited (decision 0017; `src/server/identity/limiter.ts`). `admit` counts a wrong bearer
token, and `POST /api/login` a wrong token typed into the form, under two keys: the address the request came
from and the first 8 characters of the secret. The fifth failure of a key within 15 minutes blocks it for one
second, and each failure after that doubles the block, up to 15 minutes. A request whose key is blocked is
answered 429 with `Retry-After` and the error code `limited`, and its secret is not looked up. One secret is
looked up all the same: a token in the form the server generates passes when it is right and the server made
it, so a pipeline is not stopped by whoever shares its address. Passing reports nothing and clears nothing; the
block runs out by the clock. A token a person chose gets no pass, and a token the start made from the value of
`MAINWORTHY_OWNER_TOKEN` is one whatever its form: the row says where a token came from (`tokens.source`), and
that decides. (A generated token later copied into the variable keeps the row the server made, and passes.)
A request that presents a token is judged by the token, whatever cookie comes with it; a session cookie on a
request with no token is never counted, and neither is the owner of the machine in local mode. The count is in
memory, one for each instance, at most 10,000 keys, and a restart forgets it: a failed attempt writes nothing
and never waits at the write gate. Every route that takes a session is under the limit, `/mcp`, the archive and
the change stream included, because each takes its session in one place (`sessionFor` in `src/surfaces/http.ts`).
A route that takes none (`/healthz`, the API description, the documentation) looks at no token, and a sign-in
body the schema refuses is refused before it is counted.

A person's sign-in is counted in the same limiter (`src/server/identity/attempts.ts` holds an instance's one).
A name and a password, and the current password of a change, are counted under the address and under the name
(`accountKey`, lower-cased), and are not looked at while either is blocked; a success clears the name and never
the address, and a name nobody has is counted exactly as a wrong password is. A passkey's answer that is
refused, and an invitation code that accepts nothing, are counted under the address alone, and a right one of
either passes a blocked address as a right generated token does.

The address a request came from is the address of its connection (`clientAddress` in `src/surfaces/http.ts`).
Headers that claim another one are ignored, with one exception: when the connection comes from a proxy the
operator named in `MAINWORTHY_TRUSTED_PROXY`, the address is read from the header named in
`MAINWORTHY_CLIENT_ADDRESS_HEADER`, which must hold exactly one address. A loopback or private address is never
counted, because behind a proxy it is every visitor's. So a server that names no proxy and sits behind one
with a loopback or private address counts a wrong token against its first 8 characters only, which does not
slow a guesser who varies them, and its start says so in one line. A proxy that is not named and has a public
address is counted as one address like any other peer: its visitors share one count, and one visitor's
failures block the others' hand-chosen tokens. Naming the proxy is the fix for both. How an address and a
range are written is
`src/server/kernel/address.ts`, which the configuration, the limit and the HTTP surface all read with.

A connection that sends nothing is closed after three minutes, unless somebody has vouched for it: a request that
is given a session takes the timeout off its connection (`sessionFor` in `src/surfaces/http.ts`). The timeout
counts the server's own silence, and a reply that takes longer than it (a write waiting at the gate behind a
large report, an archive being applied) must not be lost. A client with a session may therefore keep an idle
connection open, as before there was a timeout.

## The record

- **Append-only facts.** Versions, results, answers and decisions are never updated. A change of mind is a new
  row that names the one it replaces.
- **Standing** is everything that is "current": the head version of a case, which case a test belongs to, how a
  failure is counted, whether a run is closed, the policy in force. Each has exactly one writer, and that
  writer takes a `Witness`, an object only the decision machinery can create: its class has a private field, the
  one function that makes it is handed out once, and the database refuses a row that cites a decision the ledger
  does not hold. So there is no way in the code to change what is current without a row in the ledger saying who
  decided, on what evidence, under which policy clause. A rule's decision is recorded exactly like a person's.
  Withdrawing a decision undoes only what that decision made. (The four writes that look like standing and are
  not are listed in decision 0012.)
- **One clock per project.** Every command gets the next sequence number, in commit order, and stamps its rows
  with it (a report gets two, one for each of its transactions). "What changed since I last looked" is one range
  read; the cursor an agent passes back is that number.

## What happens when a pipeline reports (the red build)

1. `mainworthy report results.xml` parses JUnit XML into normalised results, reads the commit, branch, pull
   request and attempt from the CI environment, and calls `report`.
2. **Accept**, first transaction: the results are stored under a key made from their content, so the same
   report twice is a no-op. Every run this commit matters to is marked as waiting. From this commit on, the gate
   reads `pending`: nobody is served the verdict from before the upload.
3. **Apply**, second transaction, in slices of 200 results, so a ten-thousand-result report does not freeze
   anyone's screen. For each result: find or create the test; work out the **basis** (exact if a run pinned the
   version or the test names it, assumed at the case's current version if the test is linked to a case,
   unresolved if there is no case; never a silent guess); normalise the failure message into a **signature**, so
   the same cause in 500 tests is one cause. A claim about a case that cannot be accepted is refused, never
   adjusted; an automated result is then kept with no case, so a failure is not dropped from the gate.
4. **Fold**: the commit's run gets the effective result per test; planned runs that accept this commit get
   their slots filled where the acceptance rule admits the result.
5. **Raise**: one `failure` question per cause, in the scope of the pull request, the trunk or the run. If that
   cause already has a decision that still holds, the answer is carried forward and nobody is asked. If the
   failure already fails on the commit the change started from, the question says so, as a hint for the person
   who answers; nothing is excused by the hint and no answer stands on it.
6. **Verdict**: `passed`, `failed` (a decision attributed a failure to this commit: it needs a fix), `blocked`
   (a failure nobody has explained, or a dispute: it needs a decision) or `pending` (evidence is missing, or
   nothing was proven at all).
7. A person presses one key in the queue. The decision changes how the run counts that cause and the verdict is
   recomputed in the same transaction. If the answer excuses the failure (flaky, infrastructure, already failing
   on the base), `mainworthy gate` now exits 0 and the pipeline did not run again. If the answer is that the
   failure is real (a defect, a wrong test, an expectation that changed), the verdict is `failed` and the exit
   code is 1: the commit needs a fix, and the decision says why.

## Runs

A run does not own results. It says which targets count (one commit, or only what is typed into it) and what it
needs (obligations). A **change run** exists per commit that a pipeline or a person has reported, and counts
tests. A commit only an agent has reported has no run and no gate to read (`pending`, nothing counted), and an
agent's report never moves a change's head. A **planned run** pins each selected case at its current version in
a **slot**, and counts its commit by the whole hash: an abbreviated hash is settled when the run is planned (the
one reported commit that starts with it, a refusal when two do, the text itself when none does). A result fills
a slot when three things hold. Its basis names that
case at that version (or, where the run allows it, another version whose steps and expected results are the
same). Its method is one the run asked for. And the case, at the pinned version, admits that method: people and
agents are declared on the case; an automated test is admitted by its link or annotation, and whether a test may
fill the slot is then the run's choice. So a pipeline's pass on the same commit fills a manual regression run, a
slot that asks for a person is not filled by a test, and an agent's result counts only where a run asked for
agents and the case declares it. A fail from one producer beside a pass from another is `disputed` until a person
decides; a later write, another test's pass or an older attempt never hides a failure.

A run can also require named jobs. A job is met by a pipeline's report that ran something: not by an agent's
report under the job's name, and not by a report of skips only. A run that counts only what is typed into it
cannot require a job. A closed run keeps what it was closed on; reopened, it counts the evidence as it is now,
so corrections, `mistaken` decisions and results that arrived while it was closed reach it.

## Policy

A project's strictness is a table of clauses: for a kind of question under some conditions, who must answer
(a rule, a member, an admin, the author) and what an agent's answer is worth (counted, advice, refused). A
clause also carries `blocks`, which orders the queue and says which runs a failure question lists. It does not
decide a gate: a failure nobody has explained blocks every run that shows it under every policy, and no other
kind of question blocks a run. Once a person has answered a question against what a rule's clause answers, the
rule does not answer it again when that answer ends: a person is asked until a person gives the rule's answer.
`loose`, `standard` and `strict` are three such tables over the same data; a project switches between them
without a migration, and the switch is itself a proposal and a decision.

## The web UI

`src/web` is a React app that imports only `src/core`. It keeps a draft of what you type on your device as you
type it, shows every change on the frame of the keypress and reconciles with the server in the background, and
refetches what the server's change stream says was touched. The answer keys in the queue, their labels and the
sentence beside each come from three maps in `src/core/kinds.ts` (`ANSWER_KEYS`, `ANSWER_LABELS`,
`ANSWER_HELP`).

What the device keeps (drafts, the notes typed for a run) is kept per person. Every request the page makes names
the person it was loaded as (`X-Mainworthy-As`), and the server refuses it when the session has become somebody
else's, in another tab for instance: text one person typed is never recorded under another's name. A caller that
sends no name (a script, the CLI, an agent) is whoever its token says.

## What every reply carries

Every reply of the server carries the same headers, whichever route wrote it: the API's JSON, the change
stream, an archive, `/mcp`, a 404, a 500, and the web UI's page, script and style sheet. The policy is one file
of pure functions, `src/surfaces/headers.ts`, and each line of it says why it is there. One reply carries none
of them: the 101 that opens the development reload socket (below). A browser applies none of these headers to
a socket, so there they would promise nothing; who may open that socket is decided before it is opened.

| Header | Value | What it is for |
| --- | --- | --- |
| `Content-Security-Policy` | for the page: `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`. For every other reply: `default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` | The page runs the one script and the one style sheet this instance serves and talks to this instance only. No page, here or elsewhere, can show it in a frame: in local mode the workbench opens without a sign-in, so a frame on any site the person visits would have been the workbench itself. |
| `X-Frame-Options` | `DENY` | The same rule for browsers that only know this header. |
| `X-Content-Type-Options` | `nosniff` | A reply is what its content type says. |
| `Referrer-Policy` | `no-referrer` | An address names a project and a case; no other site learns it from a link. |
| `Cross-Origin-Opener-Policy`, `Cross-Origin-Resource-Policy` | `same-origin` | Another origin gets no handle on the window and cannot embed a reply. The opener policy is sent over https and to a name of this machine only: a browser ignores it on plain http to a network name and logs an error. |
| `Strict-Transport-Security` | `max-age=31536000` | Only when the request came over https: by its own scheme, or by the first element of `X-Forwarded-Proto`, in lower case. For this host alone: no `includeSubDomains`, no `preload`. |

The page's policy has no `'unsafe-inline'` and no `'unsafe-eval'`. It was found by running the app under it:
the browser tests collect every console error, and a refusal is one, so a change that needs something the
policy does not allow fails the test of whatever it broke. One library needed a change: zod builds its parsers
from a string when it may, and asks by trying. `src/web/lib/no-eval.ts` tells it not to. What that costs was
measured on 2026-10-13 in Chromium 152: a page parsed 10,000 rows of the case list (`z.array(CaseRow)`) fifty
times, and four pages did so each way. The median was 2.9 to 3.4 ms with zod compiling its parsers and 2.9 to
3.0 ms without.

Bun serves an HTML import handed to it as a route by itself and offers no way to add a header (Bun 1.4.3). So the
route is the server's own (`src/surfaces/ui.ts`), and it has two forms, for the two things an HTML import is:

- **In the executable** the import lists the files that were built into it. The route serves them: the page
  with `Cache-Control: no-cache`, the files it names (their names carry a hash of their content) to be kept for
  a year. Nothing is bundled when the server runs and nothing else listens.
- **From source** (`bun run start`, `bun run dev`, the tests) Bun bundles on request, as before, on a socket
  file in a private temporary directory, and the route passes each reply on with the headers. With
  `NODE_ENV=production` that is the same bundle and the same strict policy as the executable's. Without it, it
  is Bun's development bundle with its reload socket, which the route relays. That bundle needs three things
  more, each measured in a browser: the hash of the one inline script Bun writes into the page, read from the
  page as it is served; `blob:` scripts, from which a changed module is run; and inline styles, with which Bun
  lays out the error it shows in the page for a module that does not build. Scripts get no `'unsafe-inline'`
  and nothing gets `'unsafe-eval'`. No executable serves this bundle. A process that is killed leaves its
  socket directory behind (`mainworthy-ui-<pid>-…`); a start from source removes it once no process has
  that id any more.

  The reload socket is the one request the route does not simply pass on, because a socket the route opened
  to the bundler would be judged as this process and always let in. Only `/_bun/hmr`, the path Bun's
  development page asks for, is ever made a socket; an upgrade asked of any other path is answered as a plain
  request for that path. Before it is opened the visitor passes two checks, and one who fails either is
  answered 403 with the headers. First the HTTP surface's rule for a browser's request (`sameOrigin`): an
  Origin, where one is sent, is this server, scheme and host, and `Sec-Fetch-Site`, where sent, says the same.
  Then Bun's own: the route opens its socket to the bundler with the `Host` and `Origin` the visitor sent and
  opens the visitor's only if the bundler accepted that one. Bun refuses a name that is not this machine's
  or an address (a page reached through DNS rebinding) and an Origin on another site. The first rule is the
  stricter one for an Origin: Bun's lets in a page on another port of this machine, and the route does not.

The documentation site (`/docs`, `src/surfaces/docs/site.ts`) writes the policy of its own pages, and keeps it
(`withHeadersKeepingPolicy`): a page of the documentation loads the site's script and style sheet and frames its
diagrams, and a diagram is a sandboxed page with its script inside it, so neither is the app's page nor
"everything else". Such a reply keeps the `Referrer-Policy` its route wrote too (`same-origin`, not the `no-referrer` of the table
above), its `X-Frame-Options` follows its policy (`SAMEORIGIN` where the policy says `frame-ancestors 'self'`),
and it gets the remaining headers like any reply.

A route added to the HTTP surface gets the headers without knowing of them: the route table goes through
`withHeadersOnEvery` (`src/surfaces/with-headers.ts`), which refuses, when the server starts, a route that Bun
would answer by itself. One reply cannot say how the browser arrived: Bun hands its error handler no request,
so a 500 carries every header but `Strict-Transport-Security` and `Cross-Origin-Opener-Policy`.

## Rules the code enforces on itself

`test/architecture.test.ts` fails the check when: a module imports up the map (the suite reaching into
decisions); a module runs SQL on a table another module owns (every one of the 42 tables has one owner, and a
read of someone else's data goes through their functions); anything but the kernel talks to SQLite; anything
but the decision machinery mints a witness; a writer that undoes a withdrawn decision is called from anywhere
but a kind handler; the core imports I/O; the web UI imports the server; a declared SQL statement does not
prepare against the schema; the error codes of a reply are written out a second time outside `src/core/api.ts`;
a table of identity other than `orgs`, `actors` and `grants` could travel in an archive; an operation that needs
`self` decides by itself whose things it touches; an operation's input has a field named like a password; or the
agent surface grows past ten tools. `test/integrity.test.ts` holds one test
per thing that must never happen (a green gate with nothing proven, an agent's result counted as a pipeline's, a
conflict used to skip a review), each found by an independent review. `test/budgets.test.ts` fails the check
when a hot path gets slow.

## Where things are

| Path | What |
| --- | --- |
| `src/core/` | pure logic and schemas shared by browser and server |
| `src/server/kernel/` | the database wrapper, migrations, the command context, the witness, the configuration and how an address is written |
| `src/server/{suite,evidence,runs,decisions,identity,policy}/` | one module per owner of tables |
| `src/server/ops/` | the registry and the operations |
| `src/surfaces/` | HTTP, MCP, the JUnit reader, CI environment detection, archive routes, the documentation site, the web UI's files, the headers on every reply |
| `docs/guide/` | the user documentation, served at `/docs`; its table of contents is `src/core/docs.ts` |
| `src/cli/` | the command line, generated from the registry plus a few adapters |
| `src/web/` | the web UI |
| `skill/mainworthy/` | the skill that teaches an agent the case model |
| `test/` | behaviour tests by area, the architecture rules, the budgets, the browser tests |
| `bench/` | the benchmark on 100,000 cases and 1,000,000 results |
