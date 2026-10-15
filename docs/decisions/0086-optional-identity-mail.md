# Optional mail for sign-in

Date: 2026-10-15. Issue [#122](https://github.com/endqwerty/mainworthy/issues/122).

## Runtime and ownership

The identity module owns contacts, address verification, password reset proofs and sign-in method notices. It exposes them only through `identity.ts`. Signed-in contact changes use the existing `credential` operation. Public requests use the existing HTTP sign-in exchange, so passwords and mail-link codes never enter a command fingerprint. Invitations keep their existing stored hashes, expiry and one-use acceptance.

The kernel reads optional SMTP configuration from process environment. A small SMTP client sends plain-text mail with required STARTTLS, implicit TLS or explicitly selected unencrypted SMTP. Both encrypted modes check certificates. SMTP secrets never enter stored data, archives, replies or logs. The client uses Bun's Node-compatible sockets and TLS APIs, so it adds no dependency or licence.

## Caller sequence

An admin supplies an optional `email` when creating an invitation through Settings, the CLI or the API. The operation requests delivery after commit and still returns the link once for manual delivery. Sending to an address does not attach or verify it for recovery.

A person sets their address through `credential` with `email.set`, in a signed-in browser. The instance owner can set somebody else's. Recovery authority follows the existing invitation rule: an ordinary admin cannot replace another person's recovery address. The mailbox holder explicitly confirms a single-use link that expires after 24 hours. Changing the address immediately removes its verified status. Replacing or removing a verified address schedules a notice to that previous address before changing the contact. The notice contains no link code and asks the recipient to contact an instance admin if they did not make the change. Removal also works after SMTP is disabled, when no notice can be sent.

A public `resetRequest` always returns the same acknowledgement for known, unknown and unverified addresses. Every request counts in the shared attempt limiter under a separate hashed recipient key and the client's address key. Existing private-address exemptions remain. Only a verified contact receives a reset link, which expires after 15 minutes. A new link replaces the earlier link of the same purpose for that person.

Reset replaces only the password and ends every session, then asks the person to sign in normally. It retains passkeys, tokens and TOTP. The normal second-factor exchange remains authoritative. Admin recovery still replaces all sign-in credentials and tokens as decision 0067 describes. Its successful commit also clears every pending mail link for that person, including a reset requested when no password existed. Their verified contact stays available for a fresh reset request. Reset rechecks the contact revision, actor name, deadline, single-use proof and password hash after hashing and waiting at the write gate.

## Re-authentication for contact changes

Keep the existing signed-in browser requirement for changing your own contact, without asking for an existing credential again. Passkey registration also accepts that session plus the new key's registration ceremony, without checking an existing password, passkey or authenticator. A password change requires the current password when one exists, but adding a first password does not. Requiring an existing credential only for email would not protect the other session-authorized ways to add sign-in methods.

Match passkey registration's authority and notice behavior. A changed address still needs mailbox verification, and the previous verified address now receives a notice, including when the instance owner makes the change. A token cannot change its own person's contact. Another person's contact remains restricted to the instance owner. A general credential re-authentication exchange would need to cover passkey-only and authenticator accounts and keep secrets out of operation fingerprints. That broader policy is outside this repair.

## Shape and synthesis decision

The alternatives were a persistent outbox and stored pending links, or a bounded in-memory delivery set and pending proofs. Choose memory because optional identity mail needs neither a delivery history nor restart-safe proofs. A durable queue would persist usable mail links and add another lifecycle. The selected design persists only a contact address, its verification time and a random revision in identity's `mail_contacts` table. The revision rejects stale links but cannot be used as a verification or reset code. This table holds no secret or secret hash, so archives preserve its addresses and verification status. Migration 0020 adds an exported table and raises the archive version to 20. Project exports include contacts only for their exported actors. Import replaces contacts with the archived rows and clears pending proofs. Forgetting a person deletes their contact.

Pending proofs are hashed keys in a map bounded at 10,000 entries. Mail caused by a write and its verification proofs are scheduled with database after-commit callbacks. Rollback, including a savepoint rollback, discards its callbacks. A public reset request reads committed contacts and credentials and writes no database rows. It registers its proof and starts delivery directly, so another request's open transaction cannot delay or discard them. Invitations and credential notices run inside their own write and retain after-commit delivery. SMTP never holds the write gate. Each exchange has a five-second deadline. Authentication uses AUTH PLAIN. At most 100 messages are in flight. Shutdown stops new deliveries and awaits active messages. Failures log one generic line and do not undo identity changes.

## Accepted limits

Restart loses queued messages and pending links. The person requests another link. There is no retry or delivery-status API, so the invitation reply says delivery was requested. A restore keeps each address and its verification time, as the archive carries them; pending links never travel, so a restore asks people to request new ones. SMTP acceptance does not prove inbox delivery.

The reset request and completion pages use fragment codes, clear them from the address bar and retain the code only in component memory. They also handle a link opened on an already-mounted request page. Mail controls are absent when the server does not advertise mail.
