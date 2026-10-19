# 0044: Agent edit scope clauses

Date: 2026-10-14

Status: implemented for folders and tags. Rate and content-authorship limits await product decisions.

## Problem

Issue [#36](https://github.com/endqwerty/mainworthy/issues/36) asks for limits on agent edits beyond the preset adoption switch. The clause matcher already decides who adopts a proposal, but proposals supply no folder or tag facts. A saved proposal can also outlive a move or a retag of its cases.

## Usage

An admin adds an `adopt` clause with `when: ["author:agent", "folder:checkout"]`, or `tag:critical`, and `ask: {who: "member", agents: "none", notProducer: false, reason: "optional"}`. The normal policy proposal and decision put it into force. It comes after policy and conflict handling and before the general adoption clause.

## Shape

`scopeFacts(db: Db, project: number, edits: readonly Resolved[]): string[]` belongs to the suite, which owns the folders, case tags and resolved edits. It hides those reads behind one function. Sealing adds the facts to the proposal's question. The decision machinery calls the same function when showing or answering an open adoption question.

Folder facts include each ancestor of the source and destination paths. Tag facts include current tags and tags the proposal adds or sets. Changing a folder includes its descendants and their case tags. The conditions describe the whole proposal, so one protected edit holds the whole batch. Every existing clause keeps its meaning and the presets remain unchanged.

## Synthesis decision

Two designs were compared locally. A separate edit-limit checker would decide whether to adopt before or beside the clause matcher. That creates a second policy path and requires callers to reconcile its result with conflict and policy handling. Extending the question's facts keeps adoption in one path and fits the existing module map. No new writer, table or operation is needed.

Derive scope from resolved edits so every caller uses the same folder and tag facts. Refresh those facts when a pending proposal is shown or answered, because a case may have moved or changed tags since the proposal was sealed.

The suite projects the whole batch's folder tree in adoption order, including folders created by case placement.
Each folder keeps its identity through ancestor and child renames. Scope includes its original, intermediate,
and final paths, and the final folders of created and moved cases. Computing a destination separately for each
rename misses paths produced by combined renames, as reported in [#553](https://github.com/endqwerty/mainworthy/issues/553).

Sealing and adoption check that this projected tree has one folder per canonical path. A collision is refused,
including collisions between two edits or with a folder added while a proposal waited. Folder names can be
swapped in one batch if their final paths are distinct. An unresolved path target that encounters temporary
duplicates is refused rather than choosing an arbitrary folder. This preserves path-based case and run
selection, as reported in [#551](https://github.com/endqwerty/mainworthy/issues/551). Waiting proposals remain
readable and rejectable when a later collision prevents acceptance. No folders are merged.

We refuse non-canonical folder and tag predicates at set time, naming the clause and its normalised spelling. Silently accepting a spelling that never matches would let an agent's edit be adopted without the intended review. Matching normalises older stored predicates and current scope names with the same cleaners. Paths and tags strip Unicode format characters and use NFC before their existing whitespace and case rules. A predicate empty after cleaning is invalid.

Suite writes use the same cleaning for folder paths, explicit folder names and tags. Existing NFD folder names are not rewritten. Folder lookup and scope matching normalise them, so a canonical path reuses the existing folder and its scope still requires review. A later explicit rename stores the cleaned name.

## Tradeoffs

Matching is conservative across a batch. A folder condition and a tag condition may match different cases in the same proposal. Scope clauses require the existing custom-policy API workflow. There is no additional settings form.

The MCP predicate schema combines its string patterns, and the `propose` description is shorter, to keep the existing tools/list token ceiling. Validation and the ceiling are retained.

## Open product decisions

Does a daily limit count proposals, changed cases or adopted edits? Is it per agent or shared by the project, and does the day mean UTC or a rolling 24 hours? The recommendation is a project-wide rolling 24-hour count of adopted case changes authored by agents. A batch counts each changed case once. Rejected proposals and unchanged retries consume nothing. Crossing the limit requires human adoption rather than discarding the proposal.

Does human-content protection apply to a whole case once a person has written any version, or only to fields and steps whose content came from a person? The current history records authorship per whole version, not per retained field. The recommendation is an explicit whole-case protection clause for any case with a human-authored version. It avoids losing protection when an agent writes a later version. Field-level protection would need a separate provenance design.

Those choices are not encoded in this change. The issue remains partly open. `standard` continues to require human adoption for every agent proposal.
