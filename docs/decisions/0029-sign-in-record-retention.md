# 0029: Sign-in record retention

- Date: 2026-10-14
- Status: accepted
- Issue: [#227](https://github.com/endqwerty/mainworthy/issues/227)

## Decision

Use the existing 30-day period for ended sessions for other ended sign-in data.
Thirty days lets an admin inspect recent use without keeping addresses indefinitely.
The server's minute job applies these limits under the write gate:

- Erase a token's last network address 30 days after revocation or expiry, whichever happens first.
- Delete an invitation 30 days after use, revocation or expiry, whichever happens first.
- Record token revocation in its sessions in the same transaction. Preserve any earlier recorded end.
- When the job finds token expiry or a revocation an older build left unrecorded in sessions, use the
  token's original end time. Delete sessions whose recorded end is at least 30 days old in that same sweep.

The job runs only while the server runs and waits behind other writes. These periods decide eligibility,
not a guaranteed wall-clock deletion deadline. No schema change is needed, and archives are unchanged.

## Alternatives

Deleting old token rows would remove more data, but would also remove the hash that tells bootstrap a
configured owner token was revoked. Reusing that value would then make a fresh token that works. Sessions
also reference token rows. Keep token rows, including their hashes, labels and dates, and erase their
addresses instead. Erasure of a forgotten person's other sign-in data is separate work in issue #228.

A new retention service or table would duplicate the minute job and the end times the tables already
hold. Keep SQL with each table's owner. `sweepSignInRecords(app)` handles tokens and invitations through
the identity module, and `sweepSessions(app)` records token ends before applying session retention.

## Checks

`test/tokens.test.ts` checks the exact retention boundary, expiry before later revocation, immediate
session ending, older unended sessions and refusal of a revoked configured token after cleanup and
restart. `test/people.test.ts` checks used, revoked, expired and open invitations through the API and
minute job. `test/sessions.test.ts` checks that revocation still stops requests and change streams.
