# 0019: The project switcher is a line of the sidebar that opens the palette

- Date: 2026-10-13
- Status: proposed (built in the pull request that adds it; the owner reviews)

The owner asked for the project switcher to be available more prominently. It was a native `<select>` in the
sidebar's first row, beside the name of the product: 12 px, grey, at most 105 px wide, and only there with more
than one project. A long project name squeezed the mark beside it to a sliver. It was hidden with the sidebar
collapsed and in a window narrower than 760 px. It had no key, the palette did not know projects, and a choice
always opened Suite, whatever screen was open. The other way was a list of buttons in Settings, Projects.

Two designs were sketched from the same findings, each with a different starting point, by two models
(architect skill, 2026-10-13).

| Candidate | Starting point | Model |
| --- | --- | --- |
| P | the palette is the app's one picker; the sidebar gets a button that opens it | Claude Opus 5.5 |
| M | the switcher is its own control with its own menu, anchored to its button | GPT 6.1 Sol |

## Decision

**The project has a line of its own in the sidebar, under the brand and above the search.** It says "Project"
and the name in the ink colour, at every width and with the sidebar collapsed (then as the name's first letter).
With one project it is the name alone. With more it is a button, and `g p` presses it. This is M's placement,
and both candidates had the button.

**The button opens the palette with the projects as its items.** This is P. The palette already filters as you
type, moves with the arrows, chooses with Enter, closes with Escape, gives the focus back, and keeps the screen's
keys out while it is open (`data-overlay`). The suite's "move to a folder" already picks from a list this way. A
row shows the name, the key and the policy; the open project is marked, and the choice starts on the first other
one, so the button and Enter go from one project to the other.

**On a phone (decision 0018) nothing more is needed.** The line is in the drawer that Menu opens, a tap on it
opens the same picker, and "Switch project" is among the actions a phone offers while a list is shown: it goes
somewhere and records nothing about a row.

**A switch keeps the screen and drops what was selected.** `projectUrl` in `src/web/lib/router.ts` is the one
place that says so, and Settings, Projects goes through it. Both candidates had this rule.

**The palette finds a project by a word of its name or key**, as it finds a page of the docs.

## What was turned down

- **M's anchored menu.** It reads better beside its button than a palette in the middle of the window. It needs
  what the palette already has, written a second time: where the menu goes and where it flips to, a focus that
  moves through its rows, typing to find a row, a press outside, Tab, Escape, and one more kind of overlay for
  the shell to keep the screens' keys out of. The next list to pick from would then have two examples to copy.
  Typing the first letters of a name also finds less than the palette's filter does once names are alike.
- **A larger native `<select>`.** It cannot show the key or the policy, and a key cannot open it everywhere.
- **Removing the buttons in Settings, Projects** (M). The list stays, as the place that shows every project with
  its policy and creates one. Its rows now use the same function as the switcher, so there is one rule for where
  a switch lands.
- **"New project" in the picker.** Creating a project stays in Settings. Settings keeps its section in memory,
  not in the address, so the picker has no way to open Projects with the form ready. That is a change to
  Settings, and not part of this one.

## What this costs

- The picker opens in the middle of the window, not under the button that was pressed.
- With one project there is no button and no key, so `g p` does nothing there. The keys sheet and the palette do
  not offer it, as they do not offer `g x` in local mode.
- The palette changed in two ways for every picker. A list it is given no longer mixes in the cases that match
  the typed words (the folders of "move to a folder" did). A palette opened from a choice in the palette starts
  empty: before, the words typed to find the first case of a link were still there for the second.
