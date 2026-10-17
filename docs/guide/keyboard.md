# Keyboard

This page lists the web app's keys by screen. <kbd>?</kbd> lists the keys for the current screen.
The bar at the bottom shows common actions.

Tab shows a focus indicator on controls. Except for run progress dots, buttons and form controls have targets of at least 24 CSS pixels.
Run progress dots select the same slots as their full-size list rows.
Links within sentences use their text as the target. Links to the docs are underlined in both themes.
On a phone, a case's proposal status wraps so its question link stays visible when it takes focus.
The [web accessibility assessment](https://github.com/endqwerty/mainworthy/blob/main/docs/accessibility.md)
records the automated coverage and remaining manual checks, including screen-reader use.

## How the keys work

- A sequence such as <kbd>g</kbd> <kbd>q</kbd> means one key followed by the other. You have a little under a second to press the second key.
- <kbd>⌘</kbd> is Command on macOS and Ctrl everywhere else.
- While you type in a field, the available keys are <kbd>⌘</kbd> combinations, <kbd>Esc</kbd>, and the case editor keys. <kbd>Esc</kbd> leaves the case editor, the filter, and a run's note. A field in Settings keeps the focus until you click or tab outside it.
- Choice lists include a case's automation, a token's producer, and a run's cases. A choice list opens with <kbd>↓</kbd>, <kbd>↑</kbd>, <kbd>Home</kbd>, <kbd>End</kbd>, <kbd>Page Up</kbd>, <kbd>Page Down</kbd>, or <kbd>↵</kbd>. The list changes nothing until you choose an option with the arrow keys and <kbd>↵</kbd>, or with the mouse. Choosing an option changes the value once and returns the keys to the screen. Typing a letter selects an option starting with that letter and commits the choice.
- While the palette or the list of keys is open, only <kbd>Esc</kbd> and <kbd>⌘</kbd> <kbd>K</kbd> work. In the palette, <kbd>↑</kbd> and <kbd>↓</kbd> choose a row and <kbd>↵</kbd> runs it. <kbd>Tab</kbd> moves from the field to the rows, where <kbd>↵</kbd> runs the focused row.
- The sign-out dialog starts with the focus on **Sign out and keep drafts**. <kbd>Tab</kbd> and <kbd>Shift</kbd> <kbd>Tab</kbd> move among its three choices. <kbd>↵</kbd> or <kbd>Space</kbd> presses the focused choice. **Stay signed in**, or <kbd>Esc</kbd>, closes it and keeps you signed in. While the dialog is open, the screen's keys and <kbd>⌘</kbd> <kbd>K</kbd> do not run.
- <kbd>↵</kbd> and <kbd>Space</kbd> press a button you reached with <kbd>Tab</kbd>. <kbd>↵</kbd> follows a link you reached that way. Everywhere else, <kbd>↵</kbd> and <kbd>Space</kbd> run the screen's actions. This rule includes list rows and a button you clicked with the mouse, until focus leaves the button.

The browser controls how an open choice list closes. Chromium on Linux takes the highlighted option when you close it with <kbd>Esc</kbd>, <kbd>Tab</kbd>, or a click outside.
To keep the value unchanged, move back to the original option before closing the list.
If the list closes with <kbd>Esc</kbd> or <kbd>Tab</kbd> without a change, the screen's keys stay unavailable until you press <kbd>Esc</kbd> again.
If the browser cannot open the list from a key, an arrow changes the choice by one.

## On a phone

In a phone browser, the web app shows one pane at a time. A tablet held upright usually uses the same layout.
The phone layout has these controls and keyboard rules.

- **Menu** opens the sidebar with the screens, the project, the suite's folders and tags, the theme, and Sign out. Opening it with a keyboard moves focus into the drawer. Pressing **Close menu** returns focus to **Menu**.
- A screen opens on its list. Tapping a row opens its details. **Back** returns to the list. A link to a case, question, run, or change opens the linked item.
- **Actions** opens the palette. The palette lists the screen's actions, apart from opening the palette or the list of keys. Tapping an action runs the action. The field at the top lets you search for a case or jump to a ref. With a keyboard attached, <kbd>?</kbd> still opens the list of keys.
- While a list is shown, **Actions** offers what belongs to the list, such as New case, New folder, Filter and Plan run. Opening a row makes its actions available, such as Edit case, an answer, or Record version. Nothing is decided about a case or a question you have not opened.
- With a keyboard attached, the keys follow the same rule. While a list is shown, its keys work. These include <kbd>c</kbd> and <kbd>/</kbd> in Suite, <kbd>n</kbd> in Runs, <kbd>n</kbd> <kbd>f</kbd> in Suite, and the keys under [Everywhere](#everywhere) except <kbd>[</kbd>. Once a row is open, every key for the screen works. <kbd>n</kbd> <kbd>f</kbd> opens the sidebar's form for a new folder. Moving focus into the details with <kbd>Tab</kbd> shows the details pane. While the sidebar is open, only the list's keys work.
- Buttons offer the same actions as on a desktop, including answers in Queue, run outcomes, and accepting or rejecting proposals.

While the palette is open, only <kbd>Esc</kbd> and <kbd>⌘</kbd> <kbd>K</kbd> work, as on the desktop.
The palette uses <kbd>↑</kbd> and <kbd>↓</kbd> to move, and <kbd>↵</kbd> to run the choice.
The palette's search field does not take focus on a phone, so the on-screen keyboard stays closed.
Tapping the field gives the field focus. Letters typed before the field has focus do nothing.

These keyboard actions have touch alternatives:

| On a desktop | On a phone |
| --- | --- |
| A digit marks the step a run failed at | Write the step in the note |
| Drag a case onto a folder | **Actions**, then Move selected |
| <kbd>Esc</kbd> leaves the case editor | **Back**, or **Actions**, then Seal and leave editor. Both record what you typed. A conflict that waits for your answer stays as it is. |
| <kbd>Esc</kbd> closes the form for a tag, a new folder's name, or the reason the policy asks for | **Actions**, then Cancel tag, Cancel new folder, or Cancel. Nothing is recorded. |

The phone layout requires a touch pointer and a window at most 900 px wide or at most 500 px high.
A browser with a mouse keeps the desktop layout at any width.
A tablet whose window is wider than 900 px and taller than 500 px also keeps the desktop layout.

## Everywhere

| Key | What it does |
| --- | --- |
| <kbd>g</kbd> <kbd>h</kbd> | Go home. Opens [your chosen home](./customize.md#choose-your-home) in this project. Suite is the default. |
| <kbd>g</kbd> <kbd>s</kbd> | Go to Suite |
| <kbd>g</kbd> <kbd>q</kbd> | Go to Queue |
| <kbd>g</kbd> <kbd>r</kbd> | Go to Runs |
| <kbd>g</kbd> <kbd>a</kbd> | Go to Reports |
| <kbd>g</kbd> <kbd>c</kbd> | Go to Changes |
| <kbd>g</kbd> <kbd>t</kbd> | Go to Tests |
| <kbd>g</kbd> <kbd>,</kbd> | Go to Settings |
| <kbd>g</kbd> <kbd>p</kbd> | Switch project. Lists the projects you can read. Type part of a name or key and press <kbd>↵</kbd>. The current screen stays open. Available when you can read more than one project. |
| <kbd>g</kbd> <kbd>d</kbd> | Docs for this screen. Opens the page about the screen you are on, in a new tab. |
| <kbd>g</kbd> <kbd>x</kbd> | Sign out. Opens a dialog to sign out and keep drafts, sign out and clear browser data, or stay signed in. Available when you are signed in. Local mode needs no sign-in. |
| <kbd>⌘</kbd> <kbd>K</kbd> | Jump to or run. Opens the palette. Accepts a ref such as `C-12`, words from a case title, an action name, or `docs` and a word. |
| <kbd>?</kbd> | All keys of the current screen |
| <kbd>[</kbd> | Collapse / expand sidebar |
| <kbd>Esc</kbd> | Close palette / keys |

## Suite and case

![The suite: cases on the left, the selected case on the right](../ui/screenshots/suite-light.png)

| Key | What it does |
| --- | --- |
| <kbd>c</kbd> | New case |
| <kbd>e</kbd> or <kbd>↵</kbd> | Edit case |
| <kbd>j</kbd> or <kbd>↓</kbd> | Next case |
| <kbd>k</kbd> or <kbd>↑</kbd> | Previous case |
| <kbd>/</kbd> | Filter the list |
| <kbd>x</kbd> | Select case, for the three keys below. With none selected they act on the current case. |
| <kbd>m</kbd> | Move selected to a folder |
| <kbd>t</kbd> | Tag selected |
| <kbd>#</kbd> | Archive selected |
| <kbd>u</kbd> | Undo the last move, tag or archive. With nothing to undo, restores the version before. |
| <kbd>Space</kbd> | Peek timeline |
| <kbd>]</kbd> | Next folder |
| <kbd>Alt</kbd> <kbd>[</kbd> | Previous folder |
| <kbd>n</kbd> <kbd>f</kbd> | New folder |
| <kbd>z</kbd> | Widen case pane |
| <kbd>v</kbd> | Version diff |
| <kbd>a</kbd> | Accept proposal |
| <kbd>r</kbd> | Reject proposal |

### While you write a case

| Key | What it does |
| --- | --- |
| <kbd>↵</kbd> | First step, when you are in the title |
| <kbd>↵</kbd> | Next step, when you are in a step |
| <kbd>Tab</kbd> | Expected result of the step you are on |
| <kbd>Shift</kbd> <kbd>↵</kbd> | Next new case. Records this one and starts another |
| <kbd>⌘</kbd> <kbd>↵</kbd> | Record version now |
| <kbd>Esc</kbd> | Seal and leave editor. Records the version and leaves |

[Write cases](./write-cases.md) explains the outline you type and when a version is recorded.

## Queue

| Key | What it does |
| --- | --- |
| <kbd>j</kbd> or <kbd>↓</kbd> | Next question |
| <kbd>k</kbd> or <kbd>↑</kbd> | Previous question |
| <kbd>Space</kbd> | All evidence of the question, or back to the short view |
| <kbd>x</kbd> | Select question, to answer several of one kind at once |
| <kbd>*</kbd> | Select all of this kind. Selects every listed question of the selection's kind, or the current question's kind if nothing is selected. Clears the selection when they are all selected. |
| <kbd>Esc</kbd> | Clear selection |
| <kbd>↵</kbd> | Take advice. Gives the answer an agent advised |
| <kbd>u</kbd> | Undo answer |

The answer keys depend on the kind of question. The queue shows the ones that apply to the question you are on, each with what it does.

<!-- generated:queue-keys -->

| Key | Answer | On a question about |
| --- | --- | --- |
| <kbd>a</kbd> | Accept | a proposed edit |
| <kbd>r</kbd> | Reject | a proposed edit |
| <kbd>l</kbd> | Link to a case | a test with no case |
| <kbd>c</kbd> | Create cases | a test with no case |
| <kbd>t</kbd> | Track without a case | a test with no case |
| <kbd>d</kbd> | Defect in the product | a failed result |
| <kbd>t</kbd> | The test is wrong | a failed result |
| <kbd>e</kbd> | Expected: behaviour changed | a failed result |
| <kbd>f</kbd> | Flaky | a failed result |
| <kbd>i</kbd> | Infrastructure | a failed result |
| <kbd>n</kbd> | Already failing on base | a failed result |
| <kbd>m</kbd> | The failure was a mistake | a failed result |
| <kbd>a</kbd> | Accept | a finding from a review |
| <kbd>r</kbd> | Reject | a finding from a review |
| <kbd>d</kbd> | Duplicate | a finding from a review |
| <kbd>z</kbd> | Defer | a finding from a review |
| <kbd>a</kbd> | Approve | closing a run |
| <kbd>r</kbd> | Reject | closing a run |

<!-- /generated -->

[Decide in the queue](./decide.md) explains each answer.

## Runs

The list of runs has these keys.

| Key | What it does |
| --- | --- |
| <kbd>n</kbd> | Plan run |
| <kbd>j</kbd> | Next run |
| <kbd>k</kbd> | Previous run |
| <kbd>↵</kbd> | Open cockpit: the run with its slots |

The run view has these keys.

| Key | What it does |
| --- | --- |
| <kbd>p</kbd> | Pass |
| <kbd>f</kbd> | Fail and note: type what went wrong, then <kbd>↵</kbd> |
| <kbd>b</kbd> | Blocked |
| <kbd>s</kbd> | Skip |
| <kbd>u</kbd> | Correct last result |
| <kbd>j</kbd> or <kbd>↓</kbd> | Next slot |
| <kbd>k</kbd> or <kbd>↑</kbd> | Previous slot |
| <kbd>0</kbd> <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> <kbd>4</kbd> <kbd>5</kbd> <kbd>6</kbd> <kbd>7</kbd> <kbd>8</kbd> <kbd>9</kbd> | Mark step digit |
| <kbd>Esc</kbd> or <kbd>⌫</kbd> | Clear step mark |
| <kbd>↵</kbd> | Record failure, while you type its note |
| <kbd>Esc</kbd> | Cancel note |

A step number typed before <kbd>f</kbd> marks the failed step. [Planned runs](./runs.md) explains slots and what fills them.

## Changes

| Key | What it does |
| --- | --- |
| <kbd>j</kbd> | Next change |
| <kbd>k</kbd> | Previous change |
| <kbd>↵</kbd> | Open blocking question in the queue |

## Tests

| Key | What it does |
| --- | --- |
| <kbd>j</kbd> | Next test |
| <kbd>k</kbd> | Previous test |

## Settings

| Key | What it does |
| --- | --- |
| <kbd>j</kbd> | Next setting |
| <kbd>k</kbd> | Previous setting |
| <kbd>n</kbd> | New token, in the Tokens section |
| <kbd>n</kbd> | New project, in the Projects section |
| <kbd>n</kbd> | New invitation, in the People section. Focuses the person's name. |
| <kbd>n</kbd> | New password, in the Your sign-in section |

Settings has no key that ends a session or removes a passkey. <kbd>Tab</kbd> reaches "End" and "Remove".

## The sign-in page and an invitation

These two pages open before you are signed in, so the keys above do not work on them.
Both pages use plain forms with these keys.

| Key | What it does |
| --- | --- |
| <kbd>Tab</kbd> | Next field or button, in the order they are on the page |
| <kbd>↵</kbd> | Send the current form to sign in or accept the invitation |
| <kbd>Space</kbd> | Ticks "Make a passkey on this device" on an invitation, when the caret is on it |

The caret starts in the name on the sign-in page and in the password on an invitation.
If the browser is signed in as somebody else, an invitation first asks whether to sign that person out. Focus starts on **Continue**.
A pressed button keeps keyboard focus while its request runs and after a refusal. The next <kbd>↵</kbd> tries again.

## Reports

| Key | What it does |
| --- | --- |
| <kbd>j</kbd> | Next report |
| <kbd>k</kbd> | Previous report |
| <kbd>↵</kbd> | Open report |
