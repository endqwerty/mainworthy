# 0115: Slot work leases and the agent tool budget

A planned run's evidence state does not say whether somebody is working. Store one
lease per slot in `slot_leases`, separate from evidence. Reads derive free or held
from the lease deadline and the run's open state. No expiry sweeper is needed.
The server sets both timestamps. Callers request 30 to 86400 seconds, default 900.
A renewal keeps the original start. Next-slot selection and taking share the registry's
SQLite write transaction. Method admission uses the run and pinned case.

A lease coordinates producers. It changes no case, evidence admission, verdict,
excuse, policy, or sign-off. It is operational state rather than standing under the
witness rule. Any qualifying result ends the lease, including a non-holder's.
Closing the run clears every lease. Expired leases cannot block or appear in reads.
Leases do not travel in archives. Project removal deletes them with their slots.

The `work` operation has take and give-back actions. Taking a named slot held by
someone else refuses with their name and deadline. Taking without a slot chooses
an eligible unfinished slot, skipping live leases and the caller's existing fills.

The owner approved replacing the MCP `gate` tool with `work` to keep ten tools.
`get` returns the complete gate for commit:hash, change:key, and run refs, including
repository disambiguation for commits. HTTP and CLI gate remain unchanged. MCP
clients using gate must change their tool call. Keeping eleven tools or increasing
the token budget was rejected. Discovery descriptions are shorter to fit the
existing budget; the generated reference retains full operation details.

The seed takes one unfinished slot for 24 hours. A configured live demo renews
that named slot every 12 hours through the registry. Seeding again also takes it
again. This keeps the displayed work live without fake timestamps or random-stream
changes. An ordinary producer may still complete it or close the run.
