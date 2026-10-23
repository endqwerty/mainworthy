# What you can customize

Mainworthy has settings for the instance, each project, cases, runs, and your browser. This page lists who can change each setting and links to instructions.

[Diagram: what you can customize, and where](../diagrams/customize-map.html)

## Five levels

Settings sit at five levels. The level tells you who is affected when you change a setting:

- The instance is one running server and its data. The server's address, mode, data directory and reader threads belong here. People, agents, pipelines and their tokens belong here too. You set the server through environment variables. You set the rest in Settings or with the `mainworthy` command.
- A project is its own set of cases, runs, queue and policy. One instance can hold several. A person, an agent or a pipeline can have different rights in each.
- A case says which producers may test it: people, the pipeline, agents, or any mix.
- A run says what it needs before it is complete. You choose that when you plan the run.
- Your browser keeps your theme, sidebar choice, and personal home. Each person has a separate home for each project.

Two words recur below. An instance admin holds the `admin` capability on every project. A project admin holds it on one project. The instance names one person as its owner, using your user name by default. The owner always holds every capability.

## What you can change

| What | Where you change it | Who may | Details |
| --- | --- | --- | --- |
| The policy preset | Settings, Policy, "Preset", or `mainworthy policy use` | An admin on the project who also holds `produce` | [Policy](./policy.md) |
| What happens to a test with no case | Settings, Policy, "Tests with no case", or `mainworthy policy tests` | An admin on the project who also holds `produce` | [Policy](./policy.md#tests-with-no-case) |
| When a report with no tests passes | `mainworthy policy empty pending` or `mainworthy policy empty nothing-required` | An admin on the project who also holds `produce` | [Policy](./policy.md#reports-with-no-tests) |
| Single clauses, the flaky hold, the evidence basis | Settings, Policy, "Edit clauses", or `mainworthy propose` with a policy edit | In Settings, a person with instance `admin` and project `produce`. The command line can propose for another admin to accept | [Policy](./policy.md#change-single-clauses) |
| Same-code detector settings | `mainworthy propose` with a policy edit. Settings shows the current values | An admin on the project who also holds `produce` | [Policy](./policy.md#same-code-detector-settings) |
| Custom field definitions | Settings, Policy, "Custom fields", or a `propose` policy edit | In Settings, an instance admin who also holds `produce`. Through `propose`, a project admin | [Policy](./policy.md#custom-fields) |
| Projects | Settings, Projects, "Create a project", or `mainworthy admin` | An instance admin | [Policy](./policy.md#choose-a-preset-for-a-new-project) |
| What each person, agent or pipeline may do | `mainworthy actor grant` and `actor ungrant`. Settings, People shows people's personal and team grants and manages teams | An instance admin who is a person | [People, agents and pipelines](./access.md) |
| Named roles | `mainworthy actor grant --roles` | An instance admin who is a person | [Named roles](./access.md#named-roles) |
| Admin-issued tokens | Settings, Tokens, or `mainworthy token new`, `list` and `revoke` | An instance admin. A token for an existing person needs that person or the owner | [Make a token](./access.md#make-a-token) |
| Your personal command-line tokens | Settings, Your sign-in, Your command-line tokens | You, signed in with a password, passkey or identity provider, or as the local owner | [Make your own command-line token](./access.md#make-your-own-command-line-token) |
| How an agent connects | Settings, Connect, then `mainworthy mcp` or the `/mcp` address | Whoever holds an agent token | [Let an agent in](./agents.md) |
| What a run asks for | Runs, <kbd>n</kbd>, or `mainworthy plan` for methods, people and required jobs | Anyone with `plan` | [Planned runs](./runs.md) |
| Folders and tags | Suite | Anyone with `produce`. The policy decides whether the edit applies at once | [Write cases](./write-cases.md#organize-the-suite) |
| Which methods a case admits | The case's "Can be exercised by" section, or `methods` in its Markdown | Anyone with `produce`, under the same rule | [Let an agent in](./agents.md#what-agent-work-is-worth) |
| Your home | Settings, Your home | You, for yourself in this browser and project | [This page](#choose-your-home) |
| The theme | The "Theme" button at the bottom of the sidebar | You, in your own browser | This page |
| The sidebar, open or collapsed | The button beside "Mainworthy" at the top of the sidebar, or <kbd>[</kbd> | You, in your own browser | [This page](#the-sidebar) |
| Where the server listens, its mode, data directory and reader threads | Environment variables | Whoever starts the server | [Configuration](./configuration.md) |
| How CI reports | A pipeline token, and `MAINWORTHY_URL`, `MAINWORTHY_TOKEN` and `MAINWORTHY_PROJECT` in the job | An admin makes the token. Whoever edits the pipeline sets the rest | [Report results](./report-results.md#give-a-pipeline-its-own-token) |
| Backups and moving machines | `mainworthy export` and `mainworthy import` | An instance admin | [Your data](./data.md) |

## Policy is the largest setting

The policy decides who answers each kind of question and what an agent's answer is worth. It controls review of edits, failure explanations and agent answers. The three presets run from `loose` to `strict`. [Policy](./policy.md) compares them and shows how to switch.

A policy change applies to the whole project. An admin who is a person accepts the proposal, and both the proposal and decision stay in the record.

## Projects

Each project keeps its own cases, queue, runs and policy. A new project starts with the preset you choose. The first project, `scratch`, exists so you can write a case before you configure anything.

If you go elsewhere while a project is being created, its confirmation leaves you in the project and screen you chose.

A project key uses lower-case letters, digits and hyphens. The key starts with a letter or digit and has at most 40 characters. You cannot rename or delete a project yet. The other commands pick a project with `--project` or `MAINWORTHY_PROJECT`, or use the only one when there is one.

### Switch projects

The sidebar names the current project under "Mainworthy". When you can read more than one project, the name is a button. To switch projects, follow these steps:

1. Press the project name or <kbd>g</kbd> <kbd>p</kbd>. Mainworthy lists your projects, each with its key and policy.
2. To find a project, type part of its name or key. The initial selection is the first project other than the current one.
3. Press <kbd>↵</kbd> to open the selected project.

You stay on the same screen. From Queue you arrive in the other project's Queue. A case, question or run that was open stays in the previous project because its ref belongs to that project. Back returns to that item. With the sidebar collapsed, the button shows the first letter of the project's name.

On a phone, switch projects with these steps:

1. Tap **Menu**.
2. Tap the current project.
3. Tap the destination project.

**Actions** offers "Switch project" as well. With a keyboard attached, <kbd>g</kbd> <kbd>p</kbd> opens the list. Use <kbd>↑</kbd> <kbd>↓</kbd> and <kbd>↵</kbd> to choose from the list, as on a desktop.

The palette also finds a project when you type a word of its name. Open the palette with <kbd>⌘</kbd> <kbd>K</kbd>. Settings, Projects lists the same projects, and a press on one opens its Settings.

### A project of demo data

To look around before you write a case of your own, fill a project with the demo.

```
$ mainworthy seed demo
seeded demo: 2000 cases, run R-54, 66 questions
http://127.0.0.1:7357/p/demo/suite
```

The demo is a shop's suite. Its cases are in 29 folders under eight areas: Checkout, Accounts, Orders, Catalog, Back office, Notifications, Mobile app and API. Each folder holds the scenarios of one feature, and each case has steps of its own. The project defines three optional custom fields: priority, the team that owns a case, and risk notes. Cases carry priority and team values; Checkout cases also have risk notes. The back office's cases came from TestRail and keep their TestRail ids as aliases. In the default demo, `mainworthy get C5505` reads one. A feature that needs more cases than it has scenarios repeats them for another browser, language or kind of customer, as a real suite does. About a third of the cases have an automated test, and each test is linked to its case.

The pipeline also reports the shop's unit tests. No case names those tests. There are 60 files under `tests/unit/`, one open question each. Try [selecting several rows in the queue](./decide.md) to answer them together. To track every test without a case, open Settings, Policy and set "Tests with no case" to "Track without a case", or run `mainworthy --project demo policy tests track`. `--unlinked-files` sets how many files there are, from 0 to 500.

Two results in each of today's failing pipeline runs, and the agent's result, include step trails. Each step shows several actions with their own times, which add up to the step's time. For example, applying a coupon shows focus, typing the coupon, and pressing Apply.

The project holds fourteen days of history before today:

- A pipeline named `pipeline` reported on `main` every night, and on one to three pull requests on most days. Two days of each week are quieter. The seed determines this pattern independently of the real weekday. Two nights found a defect. On one night, the services used by the tests were down. Some pull requests failed before they were fixed. A person answered each failure the day it was reported.
- A run was planned every other day and worked through by hand. The older ones are closed as passed. The one from two days ago found a defect and stays open, and yesterday's is half done.
- Some cases were edited. Two cases that the API checks now cover were archived. An agent named `reviewer` reviewed two pull requests.
- One automated test was quarantined, failed while covered, and left quarantine after a person checked its repair.
- Each pull request merged after its last report. The pipeline reported that the change ended, so Mainworthy no longer asks about that change. Today's pull request 482 is the only one open.

Today `main` fails one test. Pull request 482 starts from that commit and fails the same test. Both failures carry the trace the test runner wrote, as an attachment. A run named "Checkout regression" is planned on the pull request, and `reviewer` has left a finding, a proposed edit, and a bulk proposal for up to 201 catalog cases (one for each case, at most 201). The queue holds six questions that need judgment: the failing test on `main` and on the pull request, the finding, both proposals, and a test that has no case. The sixty unit-test questions make 66 in all. The demo adopts the `standard` preset before its first report, set to ask about tests with no case. This keeps the pull request's failure open with the hint that it also fails on the base.

Four flags change what is written:

- `--cases` sets how many cases, from 1 to 100000.
- `--seed` is the number the demo is made from. The same seed gives the same cases, pull requests and failures on any instance. Another seed gives another demo of the same shop. The default is 1.
- `--days` sets how many days of history, from 0 to 90. With 0 the demo holds today and nothing before it.
- `--unlinked-files` sets how many files of unit tests have no case, from 0 to 500. The default is 60. Use 0 to leave only the six questions above. Demos with at most twenty cases omit the bulk proposal.

The history ends on the day you run the command. It does not move forward afterwards. A demo seeded a month ago shows the history ending on that day.

The `seed` command requires a project name each time. It creates the project if that name does not exist. The command does not read `--project` or `MAINWORTHY_PROJECT`. It fills only a project with no writes, so the demo cannot overwrite your work. If a seed stops halfway, send the same command again with the same flags. It finishes the rest and writes nothing twice.

A seeded project is a demo project, and stays one. Only a demo project accepts a write that says when it happened. Those writes give the demo its history. Every other project records the server's clock, and no flag or token changes that. Archives exclude the demo mark. [The API page](./api.md#say-when-a-write-happened) has the details.

`seed` needs a person who administers the instance, because it makes the project and the two actors. In server mode, give that person's token with `--token` or `MAINWORTHY_TOKEN`. The pipeline and the agent hold a grant on the demo project alone. The command revokes the pipeline and agent tokens when seeding ends. If seeding stops early, those tokens expire after an hour.

You cannot delete a project yet, so the demo stays until you start with a new data directory. To seed it again on every start, set `MAINWORTHY_DEMO=demo`. Once `mainworthy serve` listens, it empties the project `demo` and seeds it again. The history ends on the day of the start, and whatever you changed there is gone. The server empties only a demo project and leaves any other project unchanged, with a log line that says so. A project seeded before the demo mark was introduced also qualifies if its first write came from that seed. The server creates the project if it does not exist.

Personal and team grants on the demo stay. The seed sets its own `pipeline` and `reviewer` grants again. The reset empties and recreates the project with its grants in one transaction. A stop before commit preserves the old demo and grants. A stop after commit leaves an empty demo that the next start fills.

The reset runs on a worker thread, so `/healthz` and ordinary reads keep answering. It first audits existing references while writes continue. If a write commits during that audit, it repeats the audit before removal. An existing invalid reference refuses the reset.

Writes, including administration lists and sign-in, wait during removal and recreation. Reads see the old demo until the empty demo and its grants commit together. Foreign-key enforcement remains enabled with indexed checks on changed rows and references to deleted rows, including other projects' references. An unresolved reference rolls the whole reset back. Logs distinguish the audit before the write gate from deletion, recreation, and commit.

The seed then fills the project through the API, so readers can see it partly filled. The server creates the seed's fifteen-minute token after the reset and revokes it when seeding ends. A graceful stop during reset skips that token. A stop during seeding waits for the seed to finish and revoke its token.

After ten minutes, the reset requests its worker to stop. The worker can stop only between SQLite statements. A running statement must finish before rollback releases waiting writes. Each reset step and the seed log their elapsed time. See [configuration](./configuration.md).

## Cases, folders and tags

Folders nest. A tag is lower case, starts with a letter or digit, and can hold `-`, `_`, `.` and `/`. Moving a case or changing its tags is an edit like any other. Under `strict`, that edit waits for a person.

A case lists the methods that may produce evidence for it. People are the default. Add agents so an agent's result can count in a run that asks for agents. An automated test does not depend on the list of methods. Its result can fill a slot through a link to the case or the case's ref in the test's name. A case keeps at least one method.

## The theme

Press "Theme" at the bottom of the sidebar to switch between light and dark. Until you do, Mainworthy follows your system. The choice stays in this browser.

## The sidebar

To make room for what you are reading, press the button beside "Mainworthy" at the top of the sidebar, or <kbd>[</kbd>. The sidebar becomes a strip 64 px wide. The strip keeps the project, the search, the six screens and the footer, each as an icon. It does not show the folders and tags of the Suite.

The pane on the right takes the width the sidebar gave up. That is the pane where you read a case, a question, a run or a change. The list keeps its width. In a window narrower than about 900 px the panes are at their least width and do not all fit beside the open sidebar. Part of the width goes to fitting them in first. In a window narrower than 760 px the list is above the other pane, and both get wider.

Press the button or <kbd>[</kbd> again to open the sidebar. The choice stays in this browser, so a reload and your next visit find the sidebar as you left it. If the browser cannot save the choice, the sidebar still collapses for this visit but opens again on reload.

In the Suite, <kbd>z</kbd> sets the list to 340 px and gives the case the rest of the width. In a window wider than about 900 px, this widens the case further when the sidebar is collapsed. In a narrower window the list is under 340 px already, so <kbd>z</kbd> takes width from the case. In a window narrower than 760 px <kbd>z</kbd> changes nothing, because the case is under the list.

A phone has no strip. On a phone, **Menu** opens the sidebar over the pane. See [Keyboard](./keyboard.md).

## Choose your home

Suite is the default home. To choose another home, follow these steps:

1. Open Settings with <kbd>g</kbd> <kbd>,</kbd>.
2. Choose **Your home**.
3. Pick Suite, Queue, a run, or a saved search.
4. For a run or saved search, fill in the details described below.
5. Press **Save home**.

For a run, enter its ref in this project, such as `R-12`. For a saved search, enter the search text, folder path, tag, or any combination. The search applies all the filters you enter and reads the current cases each time. Leave a field empty to leave that filter out. The browser saves one home search per project. It does not keep a library of named searches.

Press <kbd>g</kbd> <kbd>h</kbd>, or choose **Go home** in the palette, to open your home. On a phone, **Actions** offers Go home while either pane is shown. Opening the instance at `/` uses your first accessible project's home. Opening `/p/<project>` or `/p/<project>/` without a query uses that project's home. A project address with filters or a link to an invitation, screen, case, question, or run keeps its own destination. Other paths outside `/p/`, such as `/?utm=1` and `/nowhere`, open Suite in your first accessible project.

The browser stores your home preference separately for your signed-in name and each project. **Sign out and keep drafts** preserves the preference for your next sign-in in that browser. **Sign out and clear browser data** removes the preference. Clearing the site's data in your browser also removes the preference. The preference does not follow you across browsers or into the iPhone app. Saving your home changes nobody else's home or project data.

A browser that cannot read the preference opens Suite. If saving fails, the form says so and keeps your previous home. If the saved run or search folder no longer exists, Mainworthy opens Suite and tells you that your home was not found. Open Settings to choose another home. If the lookup fails on entry, Mainworthy opens Suite with a notice. Mainworthy keeps your saved home so you can try **Go home** again. A search that matches no cases still opens with its saved filters.

## What is fixed today

The following behavior is fixed on every instance:

- The five kinds of question: a proposed edit, a test with no case, a failed result, a finding and closing a run. Each takes the answers [Decide in the queue](./decide.md) lists, on the keys it lists.
- The four verdicts, `passed`, `failed`, `blocked` and `pending`, and the exit codes 0 to 3 of `mainworthy gate`.
- The six capabilities, `read`, `record`, `produce`, `answer`, `plan` and `admin`, and the kinds of actor. [Named roles](./access.md#named-roles) can require a particular reviewer but do not add capabilities.
- A pipeline holds `read` and `record` at most, whatever its grant says.
- Three named presets. A policy with different clauses is called `custom`. Settings edits its clauses under Policy.
- The shape of a case: a title, preconditions, steps with expected results, methods, an automation intent, tags, a folder and the requirements it covers. A case can carry free `fields` of text in its Markdown, and project definitions can require values or limit them to a choice. The web capture and edit editor shows every defined field, marks required values and validates them before saving. Values can also be edited through Markdown or a `propose` body. [Policy](./policy.md#custom-fields) explains the definitions.
- Sign-in uses a token, or a person uses a name and password or a passkey set up through an admin's invitation. A password can require an authenticator code. The instance can also offer single sign-on through one OpenID Connect identity provider. With [mail configured](./configuration.md#turn-on-mail), a person can reset a lost password through their verified email address. Without mail, the owner can make a [recovery invitation](./access.md#a-lost-password-or-passkey). A password is 12 to 256 characters and has no other rule. A token works until you revoke it or until the end you gave it.
- The database is one SQLite file.

Stable-trunk flakiness detection, a requirements coverage matrix, two-person approval, frozen evidence, gap waivers and dashboards you arrange yourself are not built yet. [Same-code detection and quarantine](./report-results.md#quarantine-an-unreliable-test) are available, as are [CSV imports](./import-cases.md) and [five fixed reports](./reports.md).

## See also

- [Configuration](./configuration.md) for the server's variables.
- [Glossary](./glossary.md) for the words used here.
