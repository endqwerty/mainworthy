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
