# 0103: Every source layer is checked

- Date: 2026-10-18
- Status: proposed

## Problem

The module-map test silently skipped every layer it did not name. The operations layer and top-level server
files escaped the check, including startup importing HTTP above it. Dynamic imports escaped the static-import
regular expression too. [Issue #391](https://github.com/endqwerty/mainworthy/issues/391) records the gaps.

## Decision

Every TypeScript source file belongs to a named layer. Unknown layers fail. Bun scans runtime imports,
including dynamic imports; static extraction also keeps checking the type-only imports Bun erases.
Existing domain dependency permissions stay as they were.

Instance startup lives in `src/app`, above surfaces. Recovery, tracker hold coordination, reader threads and
archive workers live with the operations they compose in `server/ops`. The checkpoint worker lives in
`server/kernel`, and imports only the database wrapper. Every caller and compiled worker entry uses its new
location, without compatibility modules.

The CLI demo refresh remains an explicit exception. It resets demo storage and restores grants directly,
issues temporary identity tokens and resolves its owner. Its seed still writes through HTTP operations.
The CLI client's shared token length bound is a separate named identity exception. The test lists each
exception by file, with its reason.

## Alternatives

A new server runtime layer would collect orchestration above operations. Moving these files into their
existing owning modules avoids another layer. Startup is the one new outer layer because it composes HTTP
and cannot belong below surfaces.
