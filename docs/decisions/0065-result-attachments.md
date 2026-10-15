# 0065: Result attachments through the report boundary

Date: 2026-10-15. Status: accepted.

[Issue #51](https://github.com/endqwerty/mainworthy/issues/51) asks for screenshots
and files as evidence. This slice accepts them in reports and through `attach`,
lets a person paste or select them in the run cockpit, reads them through
`attachment`, and includes the bytes in whole-instance and one-project archives.

## Ownership and storage

A result owns attachment metadata in the evidence module. Its producer can append
files with the `record` capability; readers of its project can list and retrieve
them. This adds `attach` to a pipeline token's operations, restricted to its own
results. A pipeline still needs a separate read grant to retrieve bytes. Attachment insertion is
a fact, not a change to standing, so it needs no decision witness. It neither
changes an outcome nor satisfies a run obligation.

The kernel's `BlobStore` hides the storage backend. Disk storage writes an atomic
file under `blobs/<sha256>`; tests can use memory storage. Metadata stores the hash,
byte size, safe file name, detected content type and optional step id. Names never
form storage paths. Bytes are immutable and identical content shares a file.

Reports retain the existing two-transaction flow. Accepted batches keep base64 in
their staged input until application creates the result and its attachments. A
crash during application rolls back metadata; recovery can reconstruct every file
from the accepted batch. Processed batches clear staged input. Failed writes can
leave unreferenced blob files, which startup prunes before recovering accepted
reports. Referenced files have no automatic expiry or global quota.

## Input and display

One file is at most 4 MiB. A report has at most 100 files and 16 MiB decoded bytes.
One result has at most 20 files and 16 MiB across reports and later appends. These
bounds keep base64 uploads within the existing 64 MiB operation body limit and
bound per-result growth. Large videos belong in an external artifact store.

We considered upload tickets and separate binary HTTP endpoints. They introduce
an unattached-file lifetime and another transport protocol. Bounded base64 on
registry operations keeps permission checks, command retries and schemas in the
existing path. Both new operations omit MCP tools; attachment input on `report`
is hidden from tool discovery to preserve its measured token budget.

Only PNG, JPEG, GIF and WebP signatures get image types. The web client builds
object URLs for those images. All downloads use `application/octet-stream` and a
file name supplied through the download attribute. HTML and SVG never render as
pages. No attachment becomes a script, frame or object element. The page CSP
allows blob images while its script, object and frame restrictions remain.

The JUnit parser captures testcase output path markers and attachment properties
without I/O. The CLI opens named files only with `--attachments <directory>`.
Without the flag, markers are ignored and stderr says so once per command.
With it, canonical paths must stay inside the directory. Missing, hidden,
outside-root, non-file, unreadable, changed, invalid-name and over-limit files
are skipped, with one stderr line per file. Skips consume no upload budget, so
later files can still fit. A link inside the directory keeps its reported name.
The CLI adds `skippedAttachments` to its JSON receipt and a count to human output.
This count describes local filtering on this invocation; it is not sent to the
server or stored in the immutable server receipt. All parsed results still upload.
An unavailable attachment directory skips its named files with a clear reason.

We considered server-side dropping with a per-file receipt reason. The API instead
refuses an entire request whose attachment payload is invalid or exceeds a limit.
An API producer explicitly supplies bytes and can correct the structured error
before retrying. Keeping that boundary atomic avoids acknowledging an incomplete
payload as the requested evidence and retains the existing schema and retry
identity. The CLI is the adapter for reporter-generated file references: it
filters optional files against the same schemas and cumulative limits before
sending, so those references cannot invalidate an otherwise valid report.

Names reject C0 and C1 controls, DEL, bidi overrides and bidi isolates. These
characters must not change how a file name appears in the UI.

## Portability and privacy

Migration 0011 adds the metadata table and raises the archive schema to 11. An
attachment row in an archive carries its base64 content under `blob`. The archive
checksum covers that content, and import checks its size, hash and type before
inserting the row. Export refuses missing content. Older archive schemas require
a new export; this pre-1.0 slice adds no archive migration path.

Forgetting a producer preserves result evidence and attachment file names and
bytes. They can contain personal data, just as typed notes can. The guides state
this limitation. There is no attachment deletion or redaction operation yet;
retention and erasure policy need a separate design that covers retained history
and shared content hashes. Operators must plan disk capacity and back up both
the database and blobs, or use an archive that contains both.
