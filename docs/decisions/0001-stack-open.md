# 0001: Stack is deliberately undecided

- Date: 2026-10-09
- Status: open

Daniel asked that no language or framework be committed to at project
creation. The repository therefore contains no manifests, lockfiles or source
directories. The first design thread must choose the stack, record the choice
here (superseding this record), and add the matching `t3.json` scripts, check
command and `AGENTS.md` rules in the same change.

Inputs to that choice: [docs/product-vision.md](../product-vision.md) and the
answers in [docs/open-questions.md](../open-questions.md).

## Selection criteria (added 2026-10-10)

Daniel ranked the priorities: fast backend, then agent access through MCP and
skills, then instant-feeling UI/UX (see "Priorities" in the product vision).
The stack decision must be judged against these, with evidence rather than
preference:

- **Backend speed:** meets the latency budgets on a 100k-case / 1M-result
  benchmark. Build the benchmark with the two or three leading candidates
  before choosing.
- **Agent surface:** a maintained MCP server SDK for the language, and a way
  to generate the API description and MCP tools from one source.
- **UI responsiveness:** a front end that supports optimistic updates, a
  local cache, list virtualization and in-place rich editing without a
  loading step on input. A server-rendered round trip per click does not meet
  the bar.
- **Ops:** runs on the home server and on a small host; one deployable if
  possible.

### Added with the versioning, CI and flaky-detection requirements

- **Write-heavy result stream:** the data store must take a high volume of
  small appended result rows, keep full per-case history cheaply, and answer
  "last N results for this case" and "outcomes per commit" queries fast. Add
  these two queries and a 10,000-result ingest to the benchmark, with a
  history of many millions of results, not only 1M.
- **Immutable versions:** storing and diffing versions of a structured
  document must be cheap and not require rewriting rows.
- **Incremental computation:** flaky state is updated on ingest; the stack
  needs a simple way to do incremental aggregation (for example in the
  database or an in-process job queue) without a separate analytics system
  to run at the start.

### Added with the layered self-hosting decision (0002)

- **Embedded and server modes:** the store works embedded in one process
  for the Local layer and as a server database for Server and Cloud, with one
  schema and query layer. The benchmark runs in both modes.
- **One self-contained artifact:** a single binary or one container image
  with no build step for the user.
- **Optional cache:** any cache is added only when the benchmark shows a
  budget miss without it, and never carries correctness.

### Added with the multi-user and offline decision (0004)

- **Idempotent, version-checked writes:** every write takes a client-generated
  id and the base version it started from, and the store rejects or reports
  a conflict instead of overwriting. Benchmark concurrent edits to the same
  case, not only throughput.
- **Change notifications:** the server can push "this changed" events to
  clients over one channel; losing an event must be repaired by refetch.
  Live co-editing of text (CRDT or OT) is not a criterion.
- **Client cache that can queue:** the front end can hold pending writes with
  their base versions, show them as pending and replay them on reconnect.
