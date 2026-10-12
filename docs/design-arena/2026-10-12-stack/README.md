# The stack arena, 2026-10-12

Three candidates built the same spike in three stacks, on one dataset and one specification, so the stack could
be chosen on measurements (decision 0001 asked for that). The decision that came out of it is
[0010](../../decisions/0010-stack.md).

| File | What |
| --- | --- |
| [spec.md](spec.md) | What every candidate had to build and measure: nine workloads, two store modes, one registry behind HTTP, MCP and a CLI |
| [rubric.md](rubric.md) | The judge's criteria. The candidates did not see it |
| [schema.sqlite.sql](schema.sqlite.sql), [schema.pg.sql](schema.pg.sql), [schema.pg.indexes.sql](schema.pg.indexes.sql) | The shared schema in both dialects |
| [seed.ts](seed.ts), [queries.txt](queries.txt) | The seed script (100,000 cases, 1,000,000 results, 50,000 open questions) and the fixed search queries |
| [candidates/ts](candidates/ts), [candidates/go](candidates/go), [candidates/rust](candidates/rust) | Each candidate's source as the judge froze it, its own report (`REPORT.md`), its raw numbers (`results.json`) and the reviews of its work by another model family (`verification-*.md`) |
| [verdict.md](verdict.md) | The cross-judge's verdict: its own five runs per candidate, scores, recommendation and what it could not establish |
| [summary.json](summary.json) | Every number from the judge's runs |
| [audit.py](audit.py), [audit/](audit) | The judge's own correctness checks against each candidate, and their results |
| [search-diagnostic.json](search-diagnostic.json) | The judge's look at why PostgreSQL search was the closest line to its budget |

Who did what: each candidate was built by GPT 6.1 Sol and reviewed by Claude Opus 5.5. The judge was GPT 6 Astra.
The lead (Claude Opus 5.5) wrote the specification and the rubric and made the decision; where it departs from
the judge's recommendation, decision 0010 says so.

The candidates' sources are records, not product code: nothing under this directory is built, linted or tested
by the check.
