# 0020: A collapsed sidebar gives its width to the pane that is read

- Date: 2026-10-13
- Status: proposed (built in the pull request that adds it; the owner reviews)

The owner asked for a way to collapse the left sidebar, which takes room that reading a case needs. The sidebar
could collapse already: `[` did it, and so did a click on the mark beside the name. Nothing on the page said
either, and what it did was wrong on four of the five screens. Measured in a window of 1440 px, as widths of
the sidebar, the list and the pane on the right:

| Screen | Open | Collapsed, before | Collapsed, now |
| --- | --- | --- | --- |
| Suite | 236, 657, 547 | 64, 829, 547 | 64, 657, 719 |
| Queue | 236, 484, 720 | 64, 829, 547 | 64, 484, 892 |
| Runs, Changes | 236, 542, 662 | 64, 829, 547 | 64, 542, 834 |
| Settings | 236, 210, 994 | 64, 829, 547 | 64, 210, 1166 |

Each screen's stylesheet wrote the sidebar's width into its own columns, and the collapsed sidebar had one set
of columns, the Suite's, which won over all of them. So on Queue, Runs, Changes and Settings a collapsed sidebar
made the pane that is read narrower. In a window under 760 px, where the list is above the other pane, it made
both narrower: 216 px where they had 580. The rule that hid the sidebar's key caps hid every key cap in the app.
A reload opened the sidebar again. And a case pane widened with `z` went back to its width when the sidebar
changed.

One person sketched the alternatives below. No second model designed against them (the architect skill asks for
two); the independent review of the pull request is the second reading.

## Decision

**The sidebar's width is said once.** `base.css` sets `--side-open` at each width of the window (236, 190 and
120 px) and `--side-width`, which is that or the 64 px of the collapsed strip. Every set of columns starts with
`var(--side-width)`. A test reads the stylesheets and fails on a set of columns of `#app` that starts with
anything else. It reads rules whose selector ends in `#app`: a screen that laid itself out some other way would
get past it, and the browser test walks only the screens it names.

**The pane on the right takes the width the sidebar gave up, and the list keeps its width.** That pane is where
a case, a question, a run or a change is read, and it is what the owner asked room for. Its column adds
`--side-freed`, the difference between the two widths. It is added to the width the pane has, which in a narrow
window is its least width and not its share of the window: `calc(max(480px, 50%) + var(--side-freed))`. (The
automated review on the pull request found the first version adding it to the share alone, so that at 900 px
Queue's right pane gained 96 px of the 126.) Where the open layout is already wider than the window, some of
what the sidebar gives up goes to that first. Two other rules were turned down. Giving the width to the
list is what the Suite did before: at 1440 px the list of titles became 829 px wide and the case stayed at 547.
Splitting it is a rule nobody can state from looking at the page. Settings and a widened case pane already gave
the width to the right pane, so now every screen follows one rule. Under 760 px the two panes are one above the
other and both take it.

**A button collapses the sidebar, in its first row, after the name.** Its tooltip says "Collapse sidebar ([)".
Collapsed, it is under the mark and says "Expand sidebar ([)". The mark is no longer a button on the desktop:
two controls with one name is one too many, and a mark that looks like a logo is not where anybody looks for
this. Turned down: an expand control that appears when the pointer is over the mark, which is as hidden as the
key was.

**The strip stays, 64 px wide.** It keeps the project, the search, the screens and the footer one click away.
Hiding the sidebar whole was turned down: it gives 64 px more, and then the way back and the four screens need
a control that floats over the list.

**The browser keeps the choice**, under `mainworthy:sidebar` in its local storage, as it keeps the theme. It is
not kept per person or on the server: how wide a window is belongs to the device. A browser whose store refuses
(it is full, or switched off for the site) collapses and opens the sidebar for the page that is open and keeps
nothing; the independent review found the first version leaving an empty page there. A phone (decision 0018) reads
none of it and has no button; Menu opens its sidebar.

**The page marks the collapsed sidebar with an attribute**, `data-sidebar="collapsed"` on `#app`, not a class.
The Suite puts `zoom` into the class list itself when `z` widens the case pane, and a class that React writes
took it out again each time the sidebar changed.

**`z` follows the same width.** The widened case pane had the sidebar's 236 px written into its columns too, at
every width of the window, so under 1100 px `z` made the sidebar wider than it was without it. Now the sidebar
keeps its width and the case gets the difference. Under 760 px, where the case is under the list, `z` left a
third, empty column and made both panes 340 px wide; there it now changes nothing.

## Not done

- The sidebar does not collapse by itself in a narrow window. It narrows to 190 px under 1100 px and to 120 px
  under 760 px, as before, and under 760 px its first row shows the mark and the button without the name.
- The strip's search, Keys and Theme icons have no tooltip. The screens, Settings, Sign out and Docs have one.
- `z` still changes the class list from the Suite. Moving it into the shell's state is a change to the Suite.
