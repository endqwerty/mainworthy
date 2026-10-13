# Compliance register

What each legal or regulatory regime would need from Mainworthy, what the product already gives, what is missing,
and what it would cost. Daniel's rule (decision 0009, answer 15): do what is very low cost now; plan what is
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
4. **Third-party licence notices are not shipped with the container image.** The dependencies are permissive
   (MIT, Apache-2.0, CC0, public domain), and their licences require the notices to travel with a distributed
   binary. Harmless while the only user is the owner; required before anyone else is given the image. Cost:
   low (generate the file at build). Tracked in #40.
5. **Accessibility has not been audited.** The UI is keyboard-first, with visible focus and live status, but
   nobody has checked it against WCAG 2.2 AA. Public-sector and many enterprise buyers require a conformance
   report. Cost: medium. Tracked in #47.
6. **No project licence.** The repository is private and `UNLICENSED`. Before a public release Daniel has to
   choose one. Tracked in #34 with the name check.

## Privacy (GDPR, UK GDPR, CCPA)

Self-hosted, the operator is the controller and Mainworthy is software they run; the product's duty is to make
compliance possible. On a hosted tier Daniel would be a processor, with duties of his own (a data processing
agreement, a list of sub-processors, breach notification, data residency): planned with that tier (#31).

| # | Requirement | Status | How, or what is missing |
| --- | --- | --- | --- |
| P1 | Know what personal data is held | met | Actor names, and whatever people type into text fields. No email, no IP addresses, no analytics, no telemetry. The only cookie is the session cookie, which is strictly necessary and needs no consent banner. |
| P2 | Access and portability | met | `mainworthy export` writes every fact, decision and document in an open text format. Check: the export and import round-trip test. Tokens are not exported. |
| P3 | Erasure of a person | partly | `admin { do: "actor.forget" }` replaces the actor's name with a pseudonym, disables the actor and revokes its tokens. History still says the same actor did each thing; it no longer says who that was. Text the person typed stays (gap 1). |
| P4 | Storage limitation | not met | Gap 2. |
| P5 | Security of processing | partly | Tokens are stored as SHA-256 hashes and shown once. Local mode accepts only same-origin loopback requests. Transport encryption is the reverse proxy's job (Coolify's Traefik), encryption at rest the disk's. No rate limiting on sign-in yet (#30). |
| P6 | Records of who did what | met | Every write names an actor and a time and has a place in the project's sequence. Check: the idempotent command log and the ledger tests. |

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
contribute is already listed above (P5, P6, E1, E4). Missing for that day: sign-in rate limiting, an access log
of reads, and backup procedures with a tested restore on the hosting side.

## Accessibility (EU Accessibility Act, EN 301 549, Section 508, ADA)

Gap 5. Business software sold to private companies is mostly outside the Accessibility Act, but public
procurement in the EU and the US asks for a conformance report against WCAG. The cheap things are done in the
MVP (everything reachable by keyboard, focus visible, status announced, colour never the only signal for an
outcome); the audit and the fixes it finds are tracked in #47.

## Licences

Gap 4 and gap 6. Dependencies in the shipped executable: Bun (MIT), React (MIT), TanStack Query and Virtual
(MIT), Zod (MIT), @noble/hashes (MIT), the MCP SDK (MIT), fractional-indexing (CC0), SQLite (public domain).
None is copyleft, so none constrains Mainworthy's own licence.

## Other regimes checked

- **EU AI Act:** Mainworthy contains no model. Agents connect to it through MCP under their own identity, and
  everything an agent writes is marked as an agent's. Not applicable as a provider of an AI system.
- **Export controls on cryptography:** only standard hashing (SHA-256) is used; TLS is the proxy's. Nothing
  custom. Not a practical concern.
- **Trade marks:** the name is unchecked (#34).
- **Selling a hosted tier:** terms of service, a privacy policy, a data processing agreement and sales tax or
  VAT handling are needed before the first paying customer (#31).
