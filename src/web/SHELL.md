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
is typed from core `Api`. The instance's operations (`INSTANCE_OPS` in core `api.ts`:
`admin`, `session`, `credential`, `invitation`) use `/api/<op>`; others use the project.
A failure throws `ApiError` with the server's `code`, `message`, `details` and HTTP `status`;
`unauthenticated` returns to sign-in. Keep input on device.
The routes that are not operations are in `lib/signin.ts`, one function each: sign-in in
its four forms, the passkey challenge, the instance's methods, the password, sign-out.
They go through `exchange` in `lib/api.ts`, which words a `limited` reply as the wait its
`Retry-After` names ("Too many attempts. Try again in N seconds."), so every form says it alike.
`lib/passkey.ts` runs the two passkey ceremonies. `lib/people.ts` reads the replies of
`session`, `credential` and `invitation` into the core's row types.
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

## Signing in and out

`app.tsx` shows one of four things: the page of an invitation (`signin/invite.tsx`, at
`/invite`, whoever is signed in), the sign-in page (`signin/index.tsx`), a connection
error, or the workbench. Neither page is a screen: they render with no session, no
project and no key registry, so they use plain forms. Enter submits, focus starts in the
first field and Tab follows the order on the page.

The sidebar's navigation is the four screens the work is done on: Suite, Queue, Runs and
Changes. What is not the work is in the footer, on two lines. The first is the account
area: who is signed in, the link to Settings (a gear, `g ,`) beside the name, and "Sign
out" where the session is a browser's (`session.via === "cookie"`). The second has Docs
(the page about the screen that is open, `g d`), Keys and Theme. `g x` signs out; the binding is
registered only then, so the palette and the `?` sheet do not offer it in local mode.
Signing out calls `/api/logout`, then `signedOut()` from `lib/api.ts`, which is also what
a refused request does: the device session is suspended and the sign-in page is shown.

Settings has three sections about signing in, each its own file in `settings/`: "Your
sign-in" (`signin.tsx`, a person only), "Your sessions" (`sessions.tsx`) and "People"
(`people.tsx`, an instance admin who is a person). Their lists use `useList` from
`settings/list.ts`, which reads again each time the section opens. `n` goes to the
section's first field: the new password, the invited person's name. A section's key is
registered only for a caller who has the section.

On these pages and sections a control whose request is under way is marked `aria-disabled`
and not disabled, so it keeps the focus; its handler lets one request through. The selects
of the invitation form keep the focus when they change. A proof (a password, a token, a
passkey's answer, an invitation) and a change are sent once for each press and never again
by the page itself. What the page does ask again by itself is what only reads: a list after
something in it may have changed, and `/api/session` after a sign-out that got no reply.
When accepting an invitation, making a link or changing a password gets no reply, the page
says what may have happened (`saidOfWrite` in `settings/list.ts`) and not "try again".
Ending a session, removing a way of signing in and revoking an invitation may be pressed
again safely: they say that Mainworthy did not answer, and read their list again.

## Device draft ownership

One live window owns each draft, for both new and existing cases. Opening a draft claims it only when its owner is absent. Another live owner's editor and conflict card show the stored text read-only, with "This case is being edited in another window" and "Take over here". Taking over preserves the text, changes the stored owner and gives future requests a fresh command id. Pending requests stay with the window that sent them.

Storage events update the open editor's text, conflict and owner. Each input, proposal, merge and removal checks the stored owner when it runs, including replies that arrive after a takeover. The editor uses the same visible input refusal for a conflict and another window's ownership. Leaving a read-only editor sends nothing. Only the owner reconciles a settled conflict.

Editable merged fields use the draft-body schema, so a temporarily empty step keeps its owner and conflict. The stored conflict keeps every merge it sent, each with the command id it went under. A merged text field that differs from both sides contains hand-typed text; side choices leave each field equal to one side. Rejection preserves hand-typed merged fields as the editable draft. When a card's question is answered, the page asks the server what became of each of those ids (the `command` operation) and never compares the recorded head with what it sent. Card text entered after a merge that was recorded becomes a draft on the version the server made of that merge, unless it changes a field that version took from somebody else: then it stays on the draft's own base. Text of a card that something else answered stays a draft on the version it was written on; the card and its draft are dropped only when the recorded head holds everything the person typed in them (a side chosen in the card may differ from the head: it is text of a recorded version). What the draft holds beyond the card, such as a step with an expected result and no action yet, stays on every one of these paths (decision 0013; `lib/merges.ts`). Leaving the editor in the ordinary way still drops such a step, as it did before (issue #86).

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
`ProofStrip({proof})`, `StatusLine({children})`, `EmptyState({children, doc?})`,
`DocLink({page, children})`, `openDocs(page)`,
`SectionHeading({children})`, `ListRow({children, selected?, onClick})`,
`DiffView({before, after})`, `WordDiff({before, after})`, `age(at)` and `Proofs`.
Diff bodies are core CaseBody values, aligned by stable step ids.
The mock's CSS and classes are in `base.css`: `.phead`, `.psub`, `.row`, `.sel`,
`.ref`, `.kind`, `.blk`, `.sech`, `.ev`, `.prop`, `.log`, `.ans`, `.out`, `.dim`.
Tokens: `--bg`, `--panel`, `--side`, `--line`, `--line2`, `--ink`, `--dim`,
`--faint`, `--acc`, `--sel`, `--pass`, `--fail`, `--warn`, `--ci`, `--agent`,
`--agent-soft`, `--fail-soft`, `--pass-soft`, `--sans`, `--mono`.
Use these tokens in both themes. Base CSS provides visible focus rings.

## Links to the documentation

The user documentation is served at `/docs` from `docs/guide` (decision 0016).
`src/core/docs.ts` lists its pages; `DocLink` and `openDocs` take a page's slug,
so a link to a page that does not exist does not compile. Both open a new tab.
`SCREEN_DOCS` in the core names the page for each screen: `g d` and the `?` sheet
use it, and `app.tsx` does not compile with a screen it does not name.
`EmptyState` takes `doc={{page, label}}` to say how something gets into an empty
list. The palette lists the pages once something is typed (`docs policy`).
A screen that gains a section links to the page that explains it.

## Real-page test support

`test/e2e/support.ts` exports `browserAvailable`, `startServer({cases?, mode?,
preset?, seed?, passkeys?})`, `openPage(server, {path?, signedIn?, as?, ready?, browser?})`,
`launchBrowser()`, `paste(page,text)`, `keyCount(page)`, `eventually(read, accepts)`.
`as: {name, password}` signs a person in instead of the owner. `ready` is the selector
that shows a page is up when it is neither the app nor the sign-in page (`/invite`).
`addAuthenticator(harness)` gives the page a virtual authenticator for passkeys; the
server needs `passkeys: true` and the page `localhost`. `advanceClock(server, ms)` moves
the server's clock forward.
Server has `url`, `project`, `token`, `seeded`, `api(op,input,{token?})`, `stop()`.
Page helper has `page`, `context`, `errors`, `dialogs`, `loads()`, `keys()`, `close()`.
`keys()` is async. Use try/finally to close page and server. Skip if no Chromium.
Start servers in 7400..7449 with isolated /tmp data. Never print the owner token.
