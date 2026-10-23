# 0151: CLI text is escaped at the terminal

Date: 2026-10-22.

Report diagnostics escaped terminal controls, but CSV previews and other CLI
output could still print controls from files or server replies. Escape human
lines and warnings in their shared output functions, using `escapeControls`.
Keep ordinary Unicode readable and leave stored and imported content unchanged.

`get --md` and `fmt` use a shared Markdown printer that preserves LF separators
and escapes the other controls. Their JSON forms retain the original document
values. `printJson` writes `reportJson` directly, because passing serialized JSON
through the human line printer would escape its structural newlines.

All terminal text also neutralizes Actions commands. The modern `::` prefix is
recognized after leading whitespace; the legacy `##[` prefix can occur anywhere
in a line. Render the first character of these prefixes as a Unicode escape.
After JSON serialization, that escape preserves the original decoded value.
The separate error sink applies the same command protection after folding CR/LF.

Per-field escaping misses other consumers and future fields. Sanitizing imports
would change the record. The terminal boundary covers previews, receipts, lists,
status lines and warnings without changing their callers. Remove direct Markdown
stream writes and their source-test exemptions to keep new output behind this
boundary. MCP protocol output and files written by archive and audit exporters
keep their existing serialization contracts.
