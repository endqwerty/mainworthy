# Require an API version on browser writes

- Date: 2026-10-23
- Status: accepted
- Issue: https://github.com/endqwerty/mainworthy/issues/879
- PR: https://github.com/endqwerty/mainworthy/pull/886

API 2 changed placement replies, but the old browser bundle sent no API version. It could archive
a case already archived by another client, claim a change and then undo the other client's work.
Checking only an explicitly mismatched header left that old bundle able to write.

The web API client sends the shared API version on each fetch request, including session and sign-in
requests. The HTTP boundary refuses explicit mismatches and requires the header on browser requests
other than GET and HEAD. Browser POSTs carry Origin, including on plain HTTP where fetch metadata
may be absent. Sec-Fetch-Site also identifies a browser request. These headers are controlled by the
browser, so an already-open bundle cannot omit them to evade the check. Cross-origin requests still
follow the existing authentication refusal. No operation runs after a version refusal.

A cookie alone is insufficient: the native iPhone app also authenticates with a session cookie.
Requiring the header for every cookie request or every client would require an iPhone change without
making old browser tabs safer. Native clients without browser headers remain accepted when unversioned.
Explicit mismatches are refused for them as before. The CLI already sends its version and checks health.
EventSource streams use GET, cannot set a custom header and do not write.

The refusal uses the existing conflict envelope and a short reload instruction. Historical bundles
already display that message, so refusing the request also explains what the person must do. The
message makes no claim that earlier writes or all unsaved input were preserved. No demo data is
added: a deployment compatibility guard changes no project workflow for the demo to show.

Principles: Boundary Discipline (refuse before dispatch); Laziness Protocol (use browser headers instead
of changing the native client); Test Behavior, Not Implementation (check unchanged case and timeline).
