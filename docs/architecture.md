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

A caller that holds no grant on a project is told what it would be told of a project that does not exist, word
for word, in an operation and on the change stream: a refusal that named the missing capability would confirm
the project's key to any token. One that holds a grant there and lacks the capability is told which it lacks.

Holding `admin` is not being anybody. A token for a person who exists is made by that person or by the owner of
the instance, and one for the owner by the owner alone, because whoever holds a token for a name acts under it.
An agent that holds `admin` makes projects and tokens for agents and pipelines; it makes no person and no
person's token, changes no grant and forgets nobody. The owner is the person the configuration names
(`MAINWORTHY_OWNER`): the start gives that person every capability, refuses a name that is an agent's or a
pipeline's, and in server mode makes sure the owner holds a token that works. The owner is not forgotten, and in
server mode the owner's last token is not revoked.

Who a request is from is settled in `src/surfaces/http.ts` (`sessionOf`): a bearer token, else the session
cookie, else, in local mode, the owner of the machine. The last needs no sign-in, so the server checks what it
can see of where the request started: a loopback Host, a connection from a loopback address, and none of the
headers a proxy or a tunnel adds. That is the immediate connection, not the original client: a relay on this
machine that passes bytes on unchanged looks the same, so a local-mode port is never exposed through one. A cookie or the local owner is accepted only from the server's own page (`Origin`, and
`Sec-Fetch-Site` where the browser sends it). A failure that is not one of the operation's own refusals is
answered `internal error` and nothing more; what failed is in the server's log.

A connection that sends nothing is closed after three minutes, unless somebody has vouched for it: a request that
is given a session takes the timeout off its connection (`admit` in the same file). The timeout counts the
server's own silence, and a reply that takes longer than it (a write waiting at the gate behind a large report,
an archive being applied) must not be lost. A client with a session may therefore keep an idle connection open,
as before there was a timeout.

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

## Rules the code enforces on itself

`test/architecture.test.ts` fails the check when: a module imports up the map (the suite reaching into
decisions); a module runs SQL on a table another module owns (every one of the 38 tables has one owner, and a
read of someone else's data goes through their functions); anything but the kernel talks to SQLite; anything
but the decision machinery mints a witness; a writer that undoes a withdrawn decision is called from anywhere
but a kind handler; the core imports I/O; the web UI imports the server; a declared SQL statement does not
prepare against the schema; or the agent surface grows past ten tools. `test/integrity.test.ts` holds one test
per thing that must never happen (a green gate with nothing proven, an agent's result counted as a pipeline's, a
conflict used to skip a review), each found by an independent review. `test/budgets.test.ts` fails the check
when a hot path gets slow.

## Where things are

| Path | What |
| --- | --- |
| `src/core/` | pure logic and schemas shared by browser and server |
| `src/server/kernel/` | the database wrapper, migrations, the command context, the witness |
| `src/server/{suite,evidence,runs,decisions,identity,policy}/` | one module per owner of tables |
| `src/server/ops/` | the registry and the operations |
| `src/surfaces/` | HTTP, MCP, the JUnit reader, CI environment detection, archive routes |
| `src/cli/` | the command line, generated from the registry plus a few adapters |
| `src/web/` | the web UI |
| `skill/mainworthy/` | the skill that teaches an agent the case model |
| `test/` | behaviour tests by area, the architecture rules, the budgets, the browser tests |
| `bench/` | the benchmark on 100,000 cases and 1,000,000 results |
