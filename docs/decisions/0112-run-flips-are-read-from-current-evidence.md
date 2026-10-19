# 0112: Read run flips from current evidence

- Date: 2026-10-18
- Status: proposed

Correcting either endpoint withdraws a same-code flip from reports and detector evidence. Test details
counted the raw flip history, while run details counted sticky `run_tests.flipped` markers.
[Issue #630](https://github.com/endqwerty/mainworthy/issues/630) records the disagreement.

Read test counts through the same `uncorrectedResults` predicate as reports. Derive run counts and
failing-row flags from live flips in each effective result's target, test, producer, and job. Evidence
owns this batched SQL read; runs supplies its effective result ids. Count a lane once even when it has
several flips. Agent evidence never marks a change run's lane.

Remove marker writes and the refold path that preserved them. The unused stored column remains in the
schema. No schema or archive migration is needed, and old databases and imported archives immediately
get the same corrected reads. Results and flip history remain append-only.

Recomputing markers on correction would also need a backfill for existing databases and a rule for
archive imports. Read derivation avoids maintaining that second projection. It adds a batched evidence
query to run reads without adding one query per lane. Public reply shapes stay the same, so web, CLI,
and iPhone consumers need no contract changes. Existing demo reports use the corrected shared reads.
