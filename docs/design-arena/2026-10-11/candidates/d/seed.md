## Your seed lens (candidate D)

Start from this whole-shape idea and push it as far as it goes; abandon it only if you can show it breaks, and say so:

**Decision-queue centric.** The product is organised around the *decisions a human must make*, the way Linear's triage inbox organises an issue tracker: a failure to explain, an agent proposal to accept, an unlinked automated test to map, a requirement with no evidence, a flaky test to quarantine or release, a release to sign off. Manual QA, CI and agents are three producers that feed one typed decision queue; the suite, runs and reports are the backdrop that the queue links into. Every decision is recorded with identity, time and reason, so the queue is also the audit trail and the agent's "already decided, do not rediscover" ledger. The fast UI is a keyboard-driven queue plus deep links into context; the MCP surface lets agents both produce and (under policy) resolve queue items. Decide what the queue item type must carry so that one model serves the loose team (auto-resolve most things) and the regulated one (named human on each).

You run as a premium model because this is the product's foundational design; spend the thought on the data structures and the access-pattern traces, and on challenging the existing decisions where they deserve it.
