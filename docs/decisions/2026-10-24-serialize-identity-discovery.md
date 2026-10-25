# Serialize identity discovery and mutation

- Date: 2026-10-24
- Status: accepted
- Issue: https://github.com/endqwerty/mainworthy/issues/821

Actor footprint discovery followed by later rechecks failed three contention reviews. A name can disappear while actor locking waits, and an id can first become visible after the last check. Both permit an operation to take an earlier actor or organisation lock after a project lock. Real PostgreSQL regression tests reproduce deadlocks for token creation, invitation creation, token revocation, credential removal, and session ending.

Identity writes now acquire one transaction advisory lock before discovery and all actor or project locks. This revises the no-shared-authority-lock choice in the PostgreSQL decision of 2026-10-23. The registry takes it for every instance write. Sign-in commits and direct identity entry points use the same lock. Project data writes keep shared actor locks and project row locks, and never join it. Footprint discovery still acquires affected actors before projects because data writers can hold an actor while waiting for a project. The registry's organisation-row absence reservations and post-wait footprint checks are removed.

Per-name advisory reservations plus mandatory checked resolvers could retain concurrent identity writes. That would require every name and id resolution to carry checked state across the identity module. Serialization instead makes the discovery stable until the transaction ends. Its cost is that one identity writer waiting on a busy project queues every sign-in commit and other identity writer. Expensive proof verification stays outside the lock. The concurrency document records the measured cost and the regression tests preserve ordinary project concurrency. Revisit this choice if that identity queue becomes a practical limit.
