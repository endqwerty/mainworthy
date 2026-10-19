# 0118: The MCP tool list's size is a guideline, not a gate

Date: 2026-10-19. Status: accepted (the owner).

## Context

Decision 0006 made agent token cost a measured product property, with budgets set from a baseline of other MCP
servers and a change that breaks a budget refused like a latency regression. The tool list's budget was never set
that way. It was the size the tool list had when first measured (3,950 `o200k_base` tokens), frozen as a ceiling
that the test also required to equal the measurement rounded up to 50, so it could only fall. An earlier draft target
of 1,500 tokens was never met.

On 2026-10-19 three changes landed together (slot work leases, the model behind an agent's results, step trails).
Together they came to 3,965 tokens, so each one shortened other tools' descriptions to fit, and the list stood at
3,949. The next field an agent needs would have meant trimming again.

Other MCP servers, as Anthropic measured them
([advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use), 2025-11-24): Splunk 2 tools about 2K
tokens, Sentry 5 tools about 3K, Grafana 5 tools about 3K, Slack 11 tools about 21K, GitHub 35 tools about 26K, Jira
about 17K. Mainworthy's ten tools cost about as much as one small server. 4,000 tokens is about 2% of a
200,000-token context window, loaded once per session and usually cached by the client.

## Decision

Treat the size like a rate limit: measured use, a comparison with peers, and headroom for planned growth.

- Guideline: **5,000 tokens** for the whole tools/list and **1,500** for any one tool (`TOOL_TOKEN_GUIDELINE` in
  `src/surfaces/mcp.ts`). That is the measured 3,949 plus about 25%, still about the size of a small server such as
  Sentry or Grafana. The largest tool, `propose`, is about 1,370.
- It is a guideline, not a gate (the owner, 2026-10-19). Going over it prints a warning in `src/surfaces/mcp.test.ts`
  and does not fail the check. The pull request says why it is worth the size.
- Each tool's size stays recorded exactly in that test, so any change to a description or schema has to update the
  table, and a reviewer sees it.
- The limit of ten tools (`test/architecture.test.ts`) is unchanged.

This amends decision 0006 for the size of the tool list. The token budgets of agent jobs (A1 to A6) remain to be set
from a baseline as 0006 describes.

## Rejected

- **Keep 3,950 as a hard ceiling.** It came from no comparison, and each new field costs other tools' clarity.
- **Raise the hard ceiling to 5,000.** It still turns an advisory cost into a failing check, which the owner decided
  against.
- **Drop the measurement.** The recorded per-tool sizes are what make growth visible; they cost nothing to keep.
