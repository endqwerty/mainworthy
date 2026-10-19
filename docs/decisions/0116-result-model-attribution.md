# 0116: A report names the model behind its results

Date: 2026-10-19. Status: accepted.

An agent can use another model while keeping its token. The actor therefore cannot own the model name.
A report represents one session, so its optional model applies to every result in that report.
Per-result input would let one session claim unrelated models and repeat the same metadata.

The report boundary refuses a model unless the authenticated actor is an agent.
A trimmed name has 1 to 120 characters. It is producer-supplied attribution, not a verified model identity.
The batch stores it so accepted reports retain attribution after a restart. Each result stores it so reads carry
it with the producer. SQL checks permit a non-null model only on agent batches and results.
Null preserves existing evidence and means no model was named. The model participates in batch deduplication.

The operation registry publishes the field to HTTP, OpenAPI, CLI and MCP. Web and iPhone result displays
read it beside the producer. Counting and actor identity do not change: agent results still cannot move a
change's gate, and only a planned run that asks for agents admits their results.
