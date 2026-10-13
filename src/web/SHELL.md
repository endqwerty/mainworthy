# Shell contract for Builder 2

The shell compiles and loads through the real Bun server. All six screens,
router, palette, keys overlay, themes and sign-in have a Chromium check.

## Screens and routes

`app.tsx` registers named exports `QueueScreen`, `RunsScreen`,
`ChangesScreen`, `SettingsScreen` from each directory's `index.tsx`.
A screen returns two sibling `section.pane` elements, `#list` and `#detail`.
The frame owns the sidebar (`[` collapses), Suite-only folder tree and footer.
Put scrolling content in `.pane-scroll`.
Each screen imports its own CSS. Do not edit another screen or the shell.

`useApp()` from `ui/context.tsx` supplies `project`, `route`, `session`,
`setStatus(text)`, `openPalette(options)`, `refreshSession()` and `overlayOpen`.
`route` has `screen`, `project`, `ref` and `folder`, with null for no selection.
`navigate(path)` from `lib/router.ts` changes history without a page load.
`routeUrl({project, screen, ref?})` and `refUrl({project, ref})` build URLs.
Screens are `suite`, `case`, `queue`, `runs`, `changes`, `settings`.
Case URLs are `/p/<project>/suite/c/<no>`; other selected refs trail the screen.
Use anchors with `href`, preventDefault and navigate for accessible links.

## Calls and queries

`call(op, input, {project, keepalive?, token?, url?, signal?})` from `lib/api.ts`
is typed from core `Api`. `admin` uses `/api/admin`; others use the project.
A failure throws `ApiError`; `unauthenticated` returns to sign-in. Keep input on device.
`useQueryOp({project, op, input, enabled?})` from `lib/data.ts` returns the
TanStack query, including `data`, `error`, `refetch`, `isPending`.
Parse generic row data with Zod at the screen boundary. Core schemas are shared.
`queryKey({project, op, input})` creates `[project, op, input]`.
`queryClient` is the shared QueryClient. `invalidateProject(project)` refetches.
The shell owns exactly one event stream for the current project. Streams,
window focus and reconnect invalidate cached reads; edits also invalidate.

For optimistic writes, update `queryClient.setQueryData` synchronously before
starting the request. Preserve the previous cache and typed input. On error,
restore the cache and call `setStatus(error.message)`, keeping the input.
`optimisticWrite({key, update, write})` is available for a single cache; it
cancels queries, snapshots, patches, rolls back on errors, and invalidates.
For multiple caches or same-frame keyboard effects, patch manually before call.

## Device draft ownership

One live window owns each draft, for both new and existing cases. Opening a draft claims it only when its owner is absent. Another live owner's editor and conflict card show the stored text read-only, with "This case is being edited in another window" and "Take over here". Taking over preserves the text, changes the stored owner and gives future requests a fresh command id. Pending requests stay with the window that sent them.

Storage events update the open editor's text, conflict and owner. Each input, proposal, merge and removal checks the stored owner when it runs, including replies that arrive after a takeover. The editor uses the same visible input refusal for a conflict and another window's ownership. Leaving a read-only editor sends nothing. Only the owner reconciles a settled conflict.

Editable merged fields use the draft-body schema, so a temporarily empty step keeps its owner and conflict. The stored conflict keeps every merge it sent, each with the command id it went under. A merged text field that differs from both sides contains hand-typed text; side choices leave each field equal to one side. Rejection preserves hand-typed merged fields as the editable draft. When a card's question is answered, the page asks the server what became of each of those ids (the `command` operation) and never compares the recorded head with what it sent. Card text entered after a merge that was recorded becomes a draft on the version the server made of that merge, unless it changes a field that version took from somebody else: then it stays on the draft's own base. Text of a card that something else answered stays a draft on the version it was written on; the card and its draft are dropped only when the recorded head holds all of their text. What the draft holds beyond the card, such as a step with an expected result and no action yet, stays on every one of these paths (decision 0013; `lib/merges.ts`).

## Keyboard and palette

`useBindings([{key, label, handler, when?, allowInInput?, hidden?}])` from
`lib/keys.ts` registers handlers for the mounted screen. Keys are lowercase,
for example `j`, `space`, `g q`, `mod+enter`, `shift+enter`, `escape`.
Use `when: () => !overlayOpen` for normal screen handlers. `mod` is Ctrl or Cmd.
Plain keys are ignored in input fields. Escape and modified keys still work.
Call preventDefault in an input's local handler to keep global keys from firing.
The same registry feeds footer hints, the palette and the `?` sheet.
A key handler commits its synchronous React updates before the next key.
`openPalette({title?, items?})` accepts `{id, label, detail?, handler}` items.
`openPalette({title, onPickCase: ref => ...})` opens searchable case pick mode.
The palette closes before invoking the choice callback. No native dialogs.

## Shared UI and styles

`ui/index.tsx` exports `KeyCap({children})`, `ProducerGlyph({kind})`,
`ProofStrip({proof})`, `StatusLine({children})`, `EmptyState({children})`,
`SectionHeading({children})`, `ListRow({children, selected?, onClick})`,
`DiffView({before, after})`, `WordDiff({before, after})`, `age(at)` and `Proofs`.
Diff bodies are core CaseBody values, aligned by stable step ids.
The mock's CSS and classes are in `base.css`: `.phead`, `.psub`, `.row`, `.sel`,
`.ref`, `.kind`, `.blk`, `.sech`, `.ev`, `.prop`, `.log`, `.ans`, `.out`, `.dim`.
Tokens: `--bg`, `--panel`, `--side`, `--line`, `--line2`, `--ink`, `--dim`,
`--faint`, `--acc`, `--sel`, `--pass`, `--fail`, `--warn`, `--ci`, `--agent`,
`--agent-soft`, `--fail-soft`, `--pass-soft`, `--sans`, `--mono`.
Use these tokens in both themes. Base CSS provides visible focus rings.

## Real-page test support

`test/e2e/support.ts` exports `browserAvailable`, `startServer({cases?, mode?,
preset?, seed?})`, `openPage(server, {path?, signedIn?, browser?})`,
`launchBrowser()`, `paste(page,text)`, `keyCount(page)`, `eventually(read, accepts)`.
Server has `url`, `project`, `token`, `seeded`, `api(op,input,{token?})`, `stop()`.
Page helper has `page`, `context`, `errors`, `dialogs`, `loads()`, `keys()`, `close()`.
`keys()` is async. Use try/finally to close page and server. Skip if no Chromium.
Start servers in 7400..7449 with isolated /tmp data. Never print the owner token.
