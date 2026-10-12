# How Casebook fits together

A guide to the code as built in the MVP. The product design it implements is
[product-design.md](product-design.md); where the code departs from it is
[decision 0012](decisions/0012-mvp-scope-and-departures.md).

Explorable diagrams (open in a browser; they are self-contained HTML):

- [The architecture](diagrams/architecture.html): the surfaces, the operation layer, the modules and the store.
- [One red build](diagrams/red-build.html): a pipeline's report from upload to a green gate, step by step.
- [The life of a question](diagrams/question-lifecycle.html): raised, answered, carried forward, asked again.

## The idea in four sentences

Casebook keeps three kinds of record: what the software should do (cases, with versions), what was observed
(results from people, pipelines and agents, in one shape), and what people decided about it. Producers append
evidence; detectors turn evidence into questions, one per cause; a decision answers a question and is the only
thing that can change what is "current". Every surface (web, command line, API, agent tools) calls the same
fifteen operations. The whole instance is one process and one SQLite file.

## One process

```
 browser (React)     casebook CLI      CI pipeline       agent (MCP)
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
                          one SQLite file (WAL)          writer connection + read-only connection
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
| Read | `inbox` · `get` · `find` · `impact` · `since` · `gate` · `history` · `timeline` · `check` |
| Administer | `admin` (projects, actors, tokens) |

`invoke` does the same things for every operation: parse the input at the boundary, check the capability, and
for a write, open a transaction, give the command the project's next **sequence number**, run it, record the
command id so a retry returns the same reply and writes nothing, commit, and publish what changed.

## The record

- **Append-only facts.** Versions, results, answers and decisions are never updated. A change of mind is a new
  row that names the one it replaces.
- **Standing** is everything that is "current": the head version of a case, which case a test belongs to, how a
  failure is counted, whether a run is closed, the policy in force. Each has exactly one writer, and that
  writer takes a `Witness`, an object only the decision machinery can create. So there is no way in the code to
  change what is current without a row in the ledger saying who decided, on what evidence, under which policy
  clause. A rule's decision is recorded exactly like a person's.
- **One clock per project.** Every command gets the next sequence number, in commit order, and stamps its rows
  with it. "What changed since I last looked" is one range read; the cursor an agent passes back is that number.

## What happens when a pipeline reports (the red build)

1. `casebook report results.xml` parses JUnit XML into normalised results, reads the commit, branch, pull
   request and attempt from the CI environment, and calls `report`.
2. **Accept**, first transaction: the results are stored under a key made from their content, so the same
   report twice is a no-op. Every run this commit matters to is marked as waiting. From this commit on, the gate
   reads `pending`: nobody is served the verdict from before the upload.
3. **Apply**, second transaction, in slices of 500 results. Between slices the server answers reads from its
   read-only connection, so a ten-thousand-result report does not freeze anyone's screen. For each result: find
   or create the test; work out the **basis** (exact if a run pinned the version or the test names it, assumed
   at the case's current version if the test is linked to a case, unresolved if there is no case; never a silent
   guess); normalise the failure message into a **signature**, so the same cause in 500 tests is one cause.
4. **Fold**: the commit's run gets the effective result per test; planned runs that accept this commit get
   their slots filled where the acceptance rule admits the result.
5. **Raise**: one `failure` question per cause, in the scope of the pull request, the trunk or the run. If that
   cause already has a decision that still holds, the answer is carried forward and nobody is asked. If the
   failure already fails where the change started, a loose project's rule excuses it, as a recorded decision.
6. **Verdict**: `passed`, `failed` (a decision attributed a failure to this commit: it needs a fix), `blocked`
   (a failure nobody has explained, or a dispute: it needs a decision) or `pending` (evidence is missing).
7. A person presses one key in the queue. The decision changes how the run counts that cause, the verdict is
   recomputed in the same transaction, and `casebook gate` now exits 0. The pipeline did not run again.

## Runs

A run does not own results. It says which targets count (a commit, or only what is typed into it) and what it
needs (obligations). A **change run** exists per commit and counts tests. A **planned run** pins each selected
case at its current version in a **slot**; a result fills a slot when its basis names that case at that
version, its method is one the run asked for, and the case admits that method. So a pipeline's pass on the same
commit fills a manual regression run, a slot that asks for a person is not filled by a test, and an agent's
result counts only where a run asked for agents and the case declares it. A fail from one producer beside a pass
from another is `disputed` until a person decides; a later write never hides it.

## Policy

A project's strictness is a table of clauses: for a kind of question under some conditions, who must answer
(a rule, a member, an admin, the author), what an agent's answer is worth (counted, advice, refused), and what
an open question holds back. `loose`, `standard` and `strict` are three such tables over the same data; a
project switches between them without a migration, and the switch is itself a proposal and a decision.

## The web UI

`src/web` is a React app that imports only `src/core`. It keeps a draft of what you type on your device as you
type it, shows every change on the frame of the keypress and reconciles with the server in the background, and
refetches what the server's change stream says was touched. The answer keys in the queue, their labels and the
sentence beside each come from one map in `src/core/kinds.ts`, which the CLI prints too.

## Rules the code enforces on itself

`test/architecture.test.ts` fails the check when: a module imports up the map (the suite reaching into
decisions); a module runs SQL on a table another module owns (every one of the 38 tables has one owner, and a
read of someone else's data goes through their functions); anything but the kernel talks to SQLite; anything
but the decision machinery mints a witness; a writer that undoes a withdrawn decision is called from anywhere
but a kind handler; the core imports I/O; the web UI imports the server; a declared SQL statement does not
prepare against the schema; or the agent surface grows past ten tools. `test/budgets.test.ts` fails it when a
hot path gets slow.

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
| `skill/casebook/` | the skill that teaches an agent the case model |
| `test/` | behaviour tests by area, the architecture rules, the budgets, the browser tests |
| `bench/` | the benchmark on 100,000 cases and 1,000,000 results |
