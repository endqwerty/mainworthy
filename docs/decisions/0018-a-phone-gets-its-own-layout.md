# 0018: A phone gets its own layout, and the desktop does not change for it

- Date: 2026-10-13
- Status: proposed (built in the pull request that adds this file; the owner reviews)

On a phone the app could not be read. A 390 px window got a 120 px sidebar, and the list and the detail shared
the 270 px that were left, one over the other, each half the height. The owner asked for a decision: make the
phone views good, or decide that a phone needs a native app and leave it. One condition came with it. The
desktop is not to be compromised, and if a layout for phones costs too much, the phone is given up.

## Decision

**No native app, and no second set of controls. A phone gets a layout of its own in the same web app.** It shows
one pane at a time, the sidebar as a drawer, and one button that lists the actions. A person can read
everything on it and can do what a pointer already could: answer a question, record a result in a run, accept a
proposal, change a setting, sign in. The rest is reached through the palette, which already lists what the keys
of a screen do and runs one when it is pressed.

**A phone is a device whose first pointer is a finger.** One media query says so, in `src/web/lib/layout.ts`:

```
(pointer: coarse) and (max-width: 900px), (pointer: coarse) and (max-height: 500px)
```

The first part is a phone, or a tablet held upright. The second is a phone on its side, which is wide and has no
height. Where the query matches, the root element carries `data-layout="phone"`.

**The desktop cannot be changed from the phone's side.** This is what makes the cost small enough to pay.

- Every rule for a phone is in one file, `src/web/phone.css`, and starts with `:root[data-layout="phone"]`.
- No other stylesheet names that attribute.
- Every part of the query requires `(pointer: coarse)`, which a browser worked with a mouse does not match at any
  window width. A desktop window made narrow keeps the layout it had, with the sidebar and both panes.

All three are tests in `test/architecture.test.ts`. `test/e2e/phone.test.ts` opens a mouse-driven window 390 px
wide and finds the desktop layout.

What the desktop does carry: one stylesheet whose rules never match there, two listeners on the media query,
which are called when the pointer or the window crosses it, and the shell's hook, which there adds no listener
on the window and no second render. The cost was not measured. No test of a budget moved.

**The shell keeps the phone's state.** `usePhoneShell` in `src/web/phone.tsx` keeps which pane is shown and
whether the drawer is open. A screen still returns `#list` and `#detail`. The detail is shown when

- a row of the list is pressed (every screen's list is a `listbox` of `option` rows),
- somebody goes to an address that names one thing: by a link to a case or a question, by the palette's jump
  to one (also to the one the address already names), by the browser's Back and Forward. An address that only
  changes in place, as it does for a case that was just recorded, is nobody going anywhere, and the pane stays,
- anything in the detail takes the focus: the field in which "New case" or "Plan run" puts the caret, and a
  button that the Tab key of an attached keyboard reaches.

Both panes stay laid out, one over the other. A pane that was removed from the layout could not take the focus,
so an action that opens the editor would put the caret nowhere.

**What is covered cannot be acted on.** A screen whose list has rows has a selected row, and its keys act on it: `f`
answers the selected question "Flaky". On the desktop the question is beside the list. On a phone something can
lie over it: the list, the sidebar, the palette. Three reviews each found a way to record a decision about a
question nobody had opened: the palette over the list, then a key of an attached keyboard (a tablet with one is
a phone by the query above), then Tab and Enter, then a key while the sidebar was open, then Tab under the
palette. So the rule is one rule, held in four places:

- **The pointer** reaches only what is on top: the covered pane takes no pointer events, and the sidebar and the
  palette each have a backdrop over what is under them (`src/web/phone.css`).
- **The focus.** Whatever takes the focus in the detail is shown first, and the sidebar closes for it. In the
  list the same holds for a field, and for what Tab reaches; a screen that gives its list the focus back after
  an answer changes nothing. What gets covered gives the focus up, so Enter presses nothing under the list or
  the sidebar (`usePhoneShell`).
- **Keys and the palette.** A binding says when it is an action of the list (`list: true` in
  `src/web/lib/keys.ts`: New case, Filter, Plan run, and the shell's own). While the detail is covered, by the
  list or by the sidebar, only those run. Everything else runs once the detail is shown. A binding that says
  nothing is treated as acting on the detail, so a new action that forgets the mark is missing from one list on
  a phone and decides nothing unseen. A test names the marked bindings, so a new mark is seen in review; it
  reads the source as text and cannot see a mark that is computed.
- **Under the palette and the sheet of keys** the whole app is inert, and the palette holds the focus
  (`src/web/app.tsx`).

Back leaves what was open, as going to another address does: an editor records what was typed, and the list
stays when the recorded case then gets its address. A conflict that waits for an answer is not recorded by
leaving, here or anywhere: its card stays under the list until it is answered.

The mark on a binding is the one thing a screen says for a phone's sake.

## What a phone does not have

- **Keys**, unless a keyboard is attached. The hints in the footer and the key caps on buttons are hidden
  either way. The palette opens from the **Actions** button, and its field does not take the focus, so the
  keyboard on the screen does not cover the list.
- **The step a run failed at.** The digit keys mark it and nothing else does. Without a keyboard the step goes
  in the note.
- **Drag and drop** of a case onto a folder. "Move selected" in the palette does the same.
- **A new folder.** Its form is in the sidebar, and the sidebar is closed when an action runs.
- **`Esc` in a field.** A reference asked for after an answer is skipped by sending it empty. The filter is
  cleared by deleting its text.
- **Rows made for a finger in the Suite.** The list is drawn 32 px to a row by the virtual list, and a
  stylesheet cannot change that.

These are in issue #136 with the rest of what was left.

## What was turned down

- **A native app.** Two more clients to build, release and keep in step with a product that changes every day
  and has one user. Nothing here needs what only a native app has.
- **Giving up the phone.** Reading a case, answering a failure from a notification and recording a run while
  holding the device under test are all things a phone is for, and all three already worked by pointer once the
  layout let them be seen.
- **Rules by width alone** (`@media (max-width: 760px)`). They would also change a desktop window made narrow,
  which today shows the list over the detail and is used that way beside the product under test. Following the
  pointer leaves that window alone.
- **Every screen saying when to show its detail.** Six screens would each have had to call the shell from their
  click handlers, and the next screen would have had to remember to. The roles the rows already carry say the
  same thing in one place.
- **Touch controls on each screen** for what the keys do. That is the second set of controls the owner's
  condition rules out. Where one action turns out to matter on a phone, it gets a button on every device.
- **A setting that forces the layout.** It would help a phone with a mouse attached and a laptop used by touch,
  which report a fine pointer and keep the desktop layout. Nobody has asked, and a wrong guess there leaves the
  layout that was there before.

## What is not checked

The tests run in Chromium with touch emulated. No real phone has opened this layout. Not checked: how iOS and
Android move the page when the keyboard opens over a field at the bottom, such as a run's note; the browser's
own bars against `100dvh`; a phone with a notch on its side.
