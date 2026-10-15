# Compliance register

What each legal or regulatory regime would need from Mainworthy, what the product already gives, what is missing,
and what it would cost. The owner's rule (decision 0009, answer 15): do what is very low cost now; plan what is
significant; where compliance would make the product worse to use, say so and document where the requirement is
not met.

This is an engineer's register, not legal advice. Nothing here is a compliance claim: the vision's non-goal
stands ("the model records what a regulated team needs, the claims come later if a real team needs them").
Update this file with every release that changes a row.

Status words: **met** (by construction, with the check named), **partly**, **not met**, **not applicable**.

## Where the law is not met today

Read this first. These are the known gaps, in order of how soon they bite.

1. **Personal data inside recorded text cannot be erased.** The record is append-only (principle P0), so a
   name typed into a step, a note or a failure message stays in history. An actor's identity can be removed
   (see row P3), which covers the common erasure request; a redaction of free text does not exist. A fix that
   keeps the record true is a redaction recorded as a decision, which replaces the text and keeps the fact that
   text was there. Cost: medium. Tracked in #40.
2. **No retention limits.** Mainworthy keeps everything forever. Privacy law expects the operator to set how
   long personal data is kept. Nothing enforces a limit. Cost: medium (it interacts with gap 1). Tracked in #40.
3. **Sign-off is identity and time, not an electronic signature.** It does not re-authenticate the signer or
   record the meaning of the signature, so it does not satisfy 21 CFR Part 11 or EU Annex 11. Cost: medium,
   and it needs real accounts first (#30). Tracked in #40.
4. **Giving someone the executable or the image has open licence items, all from Bun.** The executable carries the
   Bun runtime and what it links, and `licences/README.md` lists what the audit of Bun 1.4.3 left open: LGPL
   libraries linked statically (JavaScriptCore, WTF, copied WebCore files, TinyCC), which a recipient may ask
   the source of and link again; MPL-2.0 files whose source must stay available; TinyCC's runtime source under
   the GPL with a linking exception; a package under Artistic-2.0; and two ports in Bun that name no licence. The
   notices are inside the executable, which serves them at `/docs/licence`, and in the image beside it, and they
   point at the public source of each part at its exact revision. Harmless while the only copy runs on the
   owner's server; before anyone else is given the image or the executable, the owner decides how the source is
   offered (hosted beside the image, or a written offer) and whether the open items are acceptable. Cost: low to
   medium. Decision 0025; tracked in [#234](https://github.com/endqwerty/mainworthy/issues/234).
5. **Accessibility has not been audited.** The UI is keyboard-first, with visible focus and live status, but
   nobody has checked it against WCAG 2.2 AA. Public-sector and many enterprise buyers require a conformance
   report. Cost: medium. Tracked in #47.
6. **The instance keeps more than it needs, in four places.** The policy at `/privacy`
   (`docs/guide/privacy.md`, 2026-10-14) says what is kept today, gaps included. To keep only what is needed:
   sign-in records that are never deleted (#227), a forgotten person's name in stored command replies (#228),
   forgetting a person without the raw API (#229), and a person's drafts left in the browser after sign-out
   (#230). The policy names no controller and no private contact address yet; the owner chooses them (#231).

## Privacy (GDPR, UK GDPR, CCPA)

Self-hosted, the operator is the controller and Mainworthy is software they run; the product's duty is to make
compliance possible. On a hosted tier the owner would be a processor, with duties of their own (a data processing
agreement, a list of sub-processors, breach notification, data residency): planned with that tier (#31).

| # | Requirement | Status | How, or what is missing |
| --- | --- | --- | --- |
| P1 | Know what personal data is held | met | Actor names, and whatever people type into text fields. For each browser session, what the browser calls itself (its `User-Agent`, cut to 256 characters) and two network addresses; for each token, one network address ("Network addresses" below). The minute job deletes a session's row 30 days after the row records its end: at once for a sign-out or a forgotten actor, and for a session that stopped working another way (its token was revoked or ended, or it went unused) only when the job marks it expired, which for a revoked token is when a lifetime runs out. The cookie is refused from the moment the token stops working; the row, with the `User-Agent` and the addresses, can stay up to the session's lifetime longer. For a person who signs in as themselves (decision 0017): a password as an argon2id hash, never the password; for each passkey its public key, its credential id, a counter and the label the person gave it; one random handle per person, which an authenticator files their passkeys under; when each was made and last used; and for an invitation the SHA-256 of its code, who it is for and who made it. A password's hash and a passkey's key are erased when the credential is removed or replaced. The limit on failed sign-ins also holds, in the server's memory only, the addresses that wrong tokens, wrong passwords, refused passkeys and wrong invitation codes came from (an IPv6 address as its /64 network), and the names that wrong passwords were tried for, in lower case and cut to 64 characters, which is whatever was typed into the name field: at most 10,000 keys, never in the database or the log, forgotten 15 minutes after the last failure or the end of its block, and a restart clears them. No email, no analytics, no telemetry, and the server writes no log of requests. There are two cookies: the session cookie, and for the five minutes of a passkey sign-in a ceremony cookie that ties the challenge to the browser that asked for it. Both are strictly necessary and need no consent banner. |
| P2 | Access and portability | met | `mainworthy export` writes every fact, decision and document in an open text format. Check: the export and import round-trip test. Tokens, sessions, passwords, passkeys and invitations are not exported: an archive holds nothing that signs somebody in. |
| P3 | Erasure of a person | partly | `admin { do: "actor.forget" }` replaces the actor's name with a pseudonym, disables the actor, revokes its tokens, erases the address each of them was last used from, and ends its sessions, whose rows are deleted 30 days later with the addresses they hold. It revokes the person's passwords and passkeys, which erases each hash and key, revokes their open invitations and deletes the handle their passkeys were filed under. Token and credential labels are erased, including labels on revoked rows. Question evidence resolves names from actor ids; display names saved by older builds are rewritten when forgetting. Saved command replies and report receipts use the pseudonym for attribution, while command ids keep their request digests and still prevent repeated writes. The rows of the credentials stay, empty, because a passkey's credential id is never registered twice. History still says the same actor did each thing; it no longer says who that was. Text the person typed stays (gap 1). |
| P4 | Storage limitation | not met | Gap 2. |
| P5 | Security of processing | partly | Tokens are stored as SHA-256 hashes and shown once. A token can be given an end, after which it is refused as a revoked one is, and the owner's token from the environment must have at least 20 characters. A browser holds a session cookie and not a token; the cookie's value is stored as a SHA-256 hash too, and a session ends at sign-out, after 14 days without use and after 90 days (decision 0017). A password is stored as an argon2id hash (64 MiB, two passes), is 12 to 256 characters with no rule about what is in it, and never passes through the operation registry or a log line; a name and a password that are looked at and refused are answered the same whatever was wrong. A passkey is verified against the instance's configured address and never against a request's `Host`. Local mode accepts only same-origin loopback requests. Transport encryption is the reverse proxy's job (Coolify's Traefik), encryption at rest the disk's. Wrong tokens are limited by address and by the token's first 8 characters, and wrong passwords by address and by the name they were tried for (decision 0017, issue #88); behind a proxy the limit by address needs two variables set (`docs/deploy.md`), and the instance at `mainworthy.com` does not set them yet. A person signs in as themselves with a password or a passkey (#30, first slice); missing there: the pages of the web UI, a second factor, single sign-on. |
| P6 | Records of who did what | met | Every write names an actor and a time and has a place in the project's sequence. Check: the idempotent command log and the ledger tests. |

### Network addresses

The server stores three network addresses, so that a person can see where a token or a session was used from and
notice a use that was not theirs. Each is the address the request came from as the server determines it (`clientAddress`
in `src/surfaces/http.ts`): the other end of the connection, or, when that is a proxy the operator named in
`MAINWORTHY_TRUSTED_PROXY`, the address that proxy reported in the header named beside it. Behind a proxy that
is not named, it is the proxy's address and not the visitor's.

| Address | Column | Written | Kept until |
| --- | --- | --- | --- |
| Where a session was opened from | `sessions.created_addr` | At sign-in | The session's row is deleted, 30 days after the row records its end. A sign-out and a forgotten actor record it at once; a session that stopped working another way (its token was revoked or ended, or it went unused) records it only when the minute job marks it expired, which can be up to the session's lifetime after it stopped working. |
| Where a session was last used from | `sessions.last_seen_addr` | At sign-in, and then with each later use: noted in memory and written in a batch, normally within a minute and longer behind a long write | The same. |
| Where a token was last used from | `tokens.last_used_addr` | With each use: noted in memory and written in a batch, normally within a minute and longer behind a long write | A later use replaces it. After the last use it stays for as long as the token's row, and nothing deletes a token's row today: revoking a token and a token's expiry both leave the row. Forgetting the token's actor erases it at once. |

Only the latest address of each kind is kept; there is no history of addresses. An import empties both tables. An
export holds neither table, so no archive carries an address. Each start also names the tokens that expire soon,
by id, actor and label; that line holds no address and no secret.

Check: `test/tokens.test.ts` (what is written and when, and what forgetting a person erases) and
`test/sessions.test.ts` (the 30 days).

## Electronic records and signatures (21 CFR Part 11, EU GMP Annex 11)

For teams in pharmaceuticals and medical devices. The regulated profile is not built (decision 0009).

| # | Requirement | Status | How, or what is missing |
| --- | --- | --- | --- |
| E1 | Audit trail: computer-generated, time-stamped, who, what, when; earlier values not obscured | met | History is the storage model: versions are immutable, a change of mind supersedes and never erases. Check: `undo` leaves both decisions in the ledger; `restore` makes a new version. |
| E2 | Records can be copied and retrieved for inspection | partly | The export is complete and machine-readable. A human-readable audit report (PDF or similar) does not exist. |
| E3 | Access limited to authorised people; unique identities | partly | Actors and capabilities, tokens per actor. No personal accounts with passwords or SSO yet (#30). |
| E4 | Authority checks: only allowed people sign or change | met | The policy clause table decides who may answer each kind of question; the decision records the clause. Check: the policy tests. |
| E5 | Signatures show name, time and meaning, and are bound to their record | not met | Gap 3. A decision is bound to its evidence by hash, which is the hard part; the signing ceremony is missing. |
| E6 | Two-component signing and re-authentication | not met | Gap 3. |
| E7 | A validated system | not applicable yet | Validation is the customer's process; a vendor supplies the documents for it. Deferred until a regulated team asks. |

Honest note on experience: a signing ceremony adds a password prompt to every sign-off. That is friction by
design. It belongs behind the regulated preset only, never on the loose or standard path.

## Traceability standards (ISO 13485, IEC 62304, ISO 26262, DO-178C)

| # | Requirement | Status | How, or what is missing |
| --- | --- | --- | --- |
| T1 | Requirement to test to result, both directions | partly | The links exist (`covers`, the result's basis, the test's case). The matrix, the gap list and the chain to deployments are not built (#41, #42). |
| T2 | Results tied to the exact version tested | met | Every result carries an explicit basis: exact, assumed or unresolved. A run pins case versions when it starts. Check: the basis and slot tests. |
| T3 | Release evidence that cannot change afterwards | not met | Closing a run is a recorded decision, but freezing is not built (#42). |

## Security frameworks (SOC 2, ISO 27001)

They certify an organisation, not software. They apply only to a hosted tier (#31). What the product would
contribute is already listed above (P5, P6, E1, E4). Missing for that day: an access log of reads, and backup
procedures with a tested restore on the hosting side.

## Accessibility (EU Accessibility Act, EN 301 549, Section 508, ADA)

Gap 5. Business software sold to private companies is mostly outside the Accessibility Act, but public
procurement in the EU and the US asks for a conformance report against WCAG. The cheap things are done in the
MVP (everything reachable by keyboard, focus visible, status announced, colour never the only signal for an
outcome); the audit and the fixes it finds are tracked in #47.

## Licences

Mainworthy is under the Apache License 2.0, copyright held by the owner (decision 0025). What it ships from others,
with the full text of each licence, is in `THIRD-PARTY-NOTICES.md`, which `bun scripts/licences.ts` writes from the
build. Every instance serves it at `/docs/licence/THIRD-PARTY-NOTICES.md`, and the container image has it in
`/usr/share/doc/mainworthy/`. The web UI's script opens with a comment that names it, its page does too
(`<link rel="license">`), every page of the docs links
it at its foot, each diagram page carries Archify's notice, and the iPhone app links it under **You**, **About**. `test/licences.test.ts` fails on a dependency under a licence nobody has accepted.

| Ships in | What | Licences |
| --- | --- | --- |
| The executable, and of those the web UI a browser loads takes some | 18 npm packages: React, TanStack, Zod, the MCP SDK, Ajv, @noble/hashes and what they import | MIT, ISC, BSD-3-Clause, CC0-1.0 |
| The executable | The Bun runtime 1.4.3 and what it links: 266 parts, among them 65 Rust crates and 84 npm packages it embeds for its Node.js fallbacks (`licences/README.md`) | Mostly MIT, BSD, Apache-2.0, ISC and Zlib; LGPL for JavaScriptCore, WebKit and TinyCC; MPL-2.0 for some CSS code, three crates and Mozilla's certificate list; GPL with runtime exceptions for the compilers' runtime libraries; Artistic-2.0 for domain-browser (gap 4) |
| The pages at `/docs` | Archify 3.0.1's viewer and the JetBrains Mono font in the diagrams; the privacy policy, adapted from Basecamp's policies | MIT, OFL-1.1, CC-BY-4.0 |
| The iPhone app | Nothing from others: its own code and Apple's frameworks | |

None of these places a condition on Mainworthy's own licence. The container's base image, `debian:bookworm-slim`,
carries Debian's packages with their copyright files in `/usr/share/doc`, as Debian ships them.

## Other regimes checked

- **EU AI Act:** Mainworthy contains no model. Agents connect to it through MCP under their own identity, and
  everything an agent writes is marked as an agent's. Not applicable as a provider of an AI system.
- **Export controls on cryptography:** what is used is SHA-256 hashing, argon2id for passwords
  (`Bun.password`) and the verification of passkey signatures (ES256, EdDSA and RS256, by `verify` of
  `node:crypto` as Bun provides it). TLS is the proxy's. No algorithm is implemented here: the passkey
  verifier is hand-written and calls the runtime for every signature. Not a practical concern.
- **Trade marks:** the name is unchecked (#34). The Apache licence grants no right to the name (its section 6).
- **Selling a hosted tier:** terms of service, a privacy policy, a data processing agreement and sales tax or
  VAT handling are needed before the first paying customer (#31).
