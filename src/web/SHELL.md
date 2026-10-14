# Shell contract for Builder 2

The shell compiles and loads through the real Bun server. All six screens,
router, palette, keys overlay, themes and sign-in have a Chromium check.

## Screens and routes

`app.tsx` registers named exports `QueueScreen`, `RunsScreen`,
`ChangesScreen`, `SettingsScreen` from each directory's `index.tsx`.
A screen returns two sibling `section.pane` elements, `#list` and `#detail`.
The frame owns the sidebar (`[` and the button in its first row collapse it), Suite-only folder tree and footer.
A screen with its own columns starts them with `var(--side-width)` and adds `var(--side-freed)` to the pane on
the right, as `queue.css` does (decision 0020). Do not write the sidebar's width as a number: base.css says it
once, and a test fails on a set of columns that starts with anything else.
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
`queryClient` is the shared QueryClient. `invalidateProject(project)` refetches, and
`changed(project, change)` refetches what an event of the stream touched. Both ask a
first read that was still on its way once more when it lands: its reply may be from
before the change (issue #87). Nothing outside `lib/data.ts` calls
`queryClient.invalidateQueries`; keep it so.
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

Under the brand, the sidebar names the project that is open (`.project`). With more than
one project in the session it is a button that opens the palette with the projects as its
items, and `g p` does the same; with one, it is the name alone and the key is not
registered. A choice goes to `projectUrl({project, screen})` from `lib/router.ts`: the same
screen in the other project, with no ref, folder or tag. Settings, Projects goes through the
same function. Add no other way to build that URL. On a phone the line is in the drawer,
and the binding is marked `list`: it goes somewhere and records nothing about a row.

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
and not disabled, so it keeps the focus; its handler lets one request through. A proof (a password, a token, a
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
`openPalette({title?, items?})` accepts `{id, label, detail?, current?, handler}` items.
Given items, the palette is a picker: it lists those rows and nothing else, and finds them
by the words of their label and detail. An item marked `current` is what is already so (the
open project): it shows a check, and the choice starts on the first item without the mark.
`openPalette({title, onPickCase: ref => ...})` opens searchable case pick mode.
The palette closes before invoking the choice callback, and each opening starts with
nothing typed, also one made from a choice. No native dialogs: a list to pick from is the
palette, not a `<select>` in the shell or a menu of its own.

A native `<select>` is always the `Select` of `ui/index.tsx`, and no select calls `blur()` itself. A select
gives the focus back when the choice is finished, not on every change: a closed select changes on every
arrow key, so one that let go at the first change would take one key and lose the keyboard. A choice made
with the pointer (a pick from the open list) is finished at the change. A choice made with the keyboard on a
closed select (arrows, Home, End, Page keys, a typed letter) is finished at Enter, Escape or Tab: until then
the select keeps the focus and the arrows keep working. `Select` tells the two apart by a key on the select
before the change (a pick from the list, and Enter in the open list, send no `keydown` to the page). Enter
and Escape on a focused select give the focus back and stop there: they are the select's own, so Escape does
not close the pane behind it and Enter does not open a row. Tab moves on as it does anywhere. A plain key
that is not one of those is left to the select (type-ahead) and not run by the shell, as in any field.

## What a note and an Escape record (issue #73)

Each of these is as the screen says, and a test pins it.

- A run slot's note is the person's text about the slot, shown in the one field "Result note" beside the keys. It
  is not labelled as belonging to a failure. Whatever is recorded next on that slot takes the note that is in the
  field, so a `p` after a failure whose request failed records the pass with the note the screen shows
  (`execution.test.ts`, "a failure note is kept on the device"). Dropping it on `p` would lose input.
- In the queue's defect reference field Escape records the defect without a reference. The field says so
  ("Defect reference, optional", "Enter records · Escape skips the reference") and the hint is checked in R5B-3
  (`round5.test.ts`). The reason field, which is required, is cancelled by Escape. Whether Escape in the reference
  field should cancel the answer instead is the owner's to decide.
- A queue question that is no longer listed refuses Enter in its answer field in one of two states: the page has
  read that it was settled ("This question was settled elsewhere. Your note is kept."), or it is still reading
  ("Reading this question before answering. Your note is kept."). When the read comes back and says the
  question was settled, the second message becomes the first, unless another line has replaced it by then
  (`round3-interactions.test.ts`, "R3B-2 a question settled elsewhere while the queue first reads it"). A read
  that fails, or that finds the question still open, leaves the line as it is, and so does moving to another
  question: the status line is one line for the whole app and keeps its last message.

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

## A phone

Decision 0018. `lib/layout.ts` says what a phone is, in one media query that requires `(pointer: coarse)`, and
sets `data-layout="phone"` on the root element where it matches. `usePhone()` reads the same query.

The shell does the rest. `usePhoneShell(route, overlayOpen)` in `phone.tsx` keeps which pane is
shown (`data-pane` on `#app`) and whether the sidebar is drawn over it (`data-menu`). `PhoneBar` is the bar with
Menu, Back and Actions; it is rendered on a phone only. The detail is shown when a `[role=option]` inside
`#list` is pressed, when somebody goes to an address with a ref (`navigate` without `replace`, also to the
address the page is at, and the browser's Back and Forward), and when anything inside `#detail` takes the focus. So a screen's
list stays a `listbox` of `option` rows, and an action whose form is in the detail focuses its first field.

Every style for a phone goes in `phone.css`, each rule starting with `:root[data-layout="phone"]`, and no other
stylesheet names the attribute: the desktop cannot be changed from there (`test/architecture.test.ts`). The
desktop's `@media (max-width: 760px)` rules match a phone too; undo in `phone.css` what a phone does not want.
Do not add a touch control to one screen for what a key does. The palette lists the bindings that are not
`hidden`, of which a phone that shows the list is offered those marked `list` (below), and runs one on a tap.

What is covered cannot be acted on. The covered pane takes no pointer events. Whatever takes the focus in the
detail is shown; in the list, a field that takes it, or what Tab reaches. A screen may give its list the focus
back after an answer, and the detail stays. What gets covered gives the focus up. Under the palette and the
sheet of keys `#app` is `inert`, and the palette holds the focus. Back sends `mainworthy:leave`, as `navigate`
does, so an editor records what was typed (not a conflict that waits for an answer). An address changed in
place (`navigate` with `replace`) leaves the pane as it is: use it when nobody goes anywhere. `navigate` sends
`mainworthy:went` (`WENT` in `lib/router.ts`) for every other call, and the shell decides the pane from it.

A binding that is an action of the list says `list: true`: New case, Filter, Plan run. While the detail is
covered, by the list or by the sidebar (`listOnly`), only those run, from the palette and from a key of an
attached keyboard (`useKeyboard(listOnly)`), because every other binding may act on the selected row. Mark a new binding `list` only
if it records no answer, result or change about the selected row, and add it to the list of marked bindings in
`test/architecture.test.ts`. `openPage(server, { device: "phone" })` opens a page as a phone
(`test/e2e/phone.test.ts`).

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
