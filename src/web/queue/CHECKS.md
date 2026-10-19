# Builder 2 checks, written before implementation

Run `bun test test/e2e/triage.test.ts test/e2e/execution.test.ts
test/e2e/agent.test.ts test/e2e/settings.test.ts` against isolated real
servers on ports 7450 through 7499 and Playwright's Chromium.

- D2 starts with twenty mixed questions under standard. Twenty answer keys
  remove all rows without a document load. Undo reopens the last question.
  Read the decided and open inboxes from the server after every answer.
- Check every failure parser shape, visible expected/observed evidence,
  advice accepted with Enter, disabled forbidden answers, evidence conflicts,
  rollback after a failed request, bulk decisions and the settled ledger.
- An agent proposal shows its real diff. Accepting it advances the case
  version, and the server timeline attributes that version to the agent.
- J5 records eight passes, a failure with its note, and one blocked result.
  Read all slot fills and the verdict from the server. Preserve pipeline and
  agent fills, skip them with the cursor, and keep the complete next document
  node alive when it becomes current. Corrections name the earlier result.
- Planning shows a live case count and creates the requested selection.
  Changes shows the server gate, open and settled questions and impact.
- Policy changes record a proposal and a decision. Create and revoke a scoped
  token, display its secret only once, and create/switch projects.
- Inspect Queue, cockpit, Changes and Settings in both themes at 1440x900,
  and check answer cards and cockpit controls at 1280x800. No console errors,
  native dialogs, or full page loads during triage or execution.
- Run TypeScript, scoped Biome, and the architecture check. The lead owns
  the final independent verdict, commit, PR and shared worktree cleanup.

## Independent review findings to prove fixed

Claude Opus 5.5 reproduced three failures on the first reviewed revision.
Before changing those paths, add checks for answer → undo → answer again,
double undo during an outstanding request, and a failed result whose read
requests also fail. Assert that the open rows match the server after a retry,
that undo sends one withdrawal, and that the cockpit cache returns to its
last confirmed slot even without a successful refetch. Keep the typed note.
