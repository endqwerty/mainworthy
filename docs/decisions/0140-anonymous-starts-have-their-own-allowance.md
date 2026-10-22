# 0140: Anonymous sign-in starts have their own allowance

2026-10-22. Fixes [issue #664](https://github.com/endqwerty/mainworthy/issues/664).

Anonymous provider/passkey starts could fill their 10,000-entry maps and evict someone else's pending sign-in.
An initial fix counted starts as failed credentials and blocked ordinary office users, including the right
password. A later global ceiling protected pending state but let one client refuse every new passkey/provider
start indefinitely by spending each minute's allowance. Independent reviews of
[PR #772](https://github.com/endqwerty/mainworthy/pull/772) found both before landing. Neither policy remains.

Anonymous starts have a separate fixed allowance of 300 per 60 seconds per public IPv4 address or IPv6 /56,
anchored at the first successful allocation. A /58 spread across 34 /64s is one /56 source, not 34 allowances.
Three hundred permits an office-sized burst and sustained five starts per second. Failed-proof limits retain
their existing /64 grouping and exponential rule; ordinary starts neither change nor consult them.
A refused start does not extend its window. There is no instance-wide start refusal or shared allowance to
monopolise. Unknown/private addresses remain uncounted because an unnamed proxy may share one among visitors.
The operator must configure the trusted proxy to distinguish those visitors.

Check availability before consuming a source allowance. Missing passkey options, an unsupported native
public address, an invalid invitation or native request, and failed/expired provider discovery consume no
anonymous start. OIDC reserves after discovery, synchronously before storing state, and retains the deadline
from before discovery. A start that expired during discovery allocates nothing. Signed-in provider linking
and a validated invitation/provider join are proven contexts and bypass anonymous counts.

Every ceremony store remains bounded at 10,000 entries. It owns entries and their source membership together:
expiry, spending, replacement and capacity eviction update one index. When full, expire dead entries first,
then drop the oldest entry from the EXISTING source bucket with the most live entries. If the incoming source
is tied for largest, it loses its own oldest entry. Otherwise choose the oldest entry among the tied-largest
buckets. Insert the new ceremony afterward, so a full map does not refuse an unrelated newcomer.

Passkey/provider sign-in owners are IPv4 or /56 source keys. An invitation's registration and provider
ceremonies belong to its validated code hash; authenticated registration/linking belongs to its session
context. Native handoff codes belong to their proven credential. Unknown peers share an explicit unknown
bucket. Both passkey and OIDC maps use the same retention implementation; native handoffs keep their existing
one-minute lifetime with that policy too. A restart or import clears the stores as before.

This protects a small source bucket while larger buckets consume the map, including the tested victim among
forty independent flooding prefixes. It is not unlimited Sybil isolation. One client controlling many
independent IPv4 addresses or /56 prefixes appears as many sources. At equal bucket sizes, no anonymous fact
identifies the flooder; a tied source's oldest pending entry may be displaced. People behind the same public
address or /56 share the allowance and retention bucket. Unknown visitors behind an unnamed proxy cannot be
isolated from each other. These are limits of the information available, not a promise of a bounded global wait.

A working invitation's page stays reachable during either address block. Valid reloads reuse its registration
challenge; with one minute left, a successor preserves the old prompt until its original deadline. At most two
unexpired challenges belong to one invitation. The existing passkey timeout reports remaining lifetime, and
the page derives its deadline conservatively from request dispatch. No wire field or second options cache is added.

Coarsening alone does not cover independently routed sources. Global refusal creates cross-client denial.
Source-aware eviction instead reclaims overrepresented memory without a shared admission switch. Per-source
counting, bounded ownership and proof binding remain separate policies.

Principles: Attack the Premise (remove global refusal); Model the Domain (one owner for entry/index lifecycle);
Fix Root Causes (source-aware full-map retention); Boundary Discipline (validate availability and proof before charging);
Test Behavior Not Implementation (HTTP start availability and pending completions under sustained floods).
