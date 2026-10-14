# Mainworthy documentation

Mainworthy keeps your test cases, the results that people, pipelines and agents report, and the decisions made about them. Then it answers one question for a change: is it worthy of `main`? These pages explain how that works, how to use each part, and what you can adjust.

[Diagram: how Mainworthy works](../diagrams/overview.html)

## Where to start

- You have never used it. Follow the [quickstart](./quickstart.md): about ten minutes from an empty machine to a gate you decided.
- You want to look around a filled project first. Run `mainworthy seed demo`: see [a project of demo data](./customize.md#a-project-of-demo-data).
- You want the idea before the keys. Read [how Mainworthy works](./concepts.md).
- You are wiring a pipeline. Read [report results](./report-results.md), then [changes and the gate](./changes.md).
- You are setting it up for a team. Read [what you can customize](./customize.md), then [policy](./policy.md) and [people, agents and pipelines](./access.md).
- You met a word you do not know. The [glossary](./glossary.md) has one or two sentences for each.

## All pages

<!-- generated:pages -->

### Start

- [How Mainworthy works](./concepts.md). The whole product in one page: what it records, how a failed test becomes a question, and how evidence and decisions together give a verdict. Read it once and the screens and commands will make sense.
- [Quickstart](./quickstart.md). Start a local instance, write one case, and upload a failing test result. Then answer its question and read the gate, in about ten minutes.

### Use it

- [Write cases](./write-cases.md). Write cases as outlines, keep their versions, and resolve edits that overlap. Use folders, tags, and search to find the cases you need.
- [Report results](./report-results.md). Send JUnit XML from a test runner or CI, then read the gate for the tested commit. Keep the pipeline's identity, retries, and case links with its results.
- [Decide in the queue](./decide.md). Read the evidence behind a question and record an answer with one key. Use the answer's stated consequence to decide what the gate needs next.
- [Planned runs](./runs.md). Choose cases for a run, record results against their pinned versions, and close with a verdict. Accept CI evidence so you do not repeat work already shown.
- [Changes and the gate](./changes.md). Read a change's latest verdict and find what prevents it from passing. Use the same gate from the command line to decide whether CI can continue.
- [Let an agent in](./agents.md). Give an AI agent its own token, connect it over MCP, and know what its edits, findings, results and answers are worth. An agent reads the suite, reviews a change, records what it found, and leaves the decisions to people.
- [The iPhone app](./iphone.md). Answer the queue from your phone in a native app. This page says how to install the app, how to sign in and what it does today.

### Customize

- [What you can customize](./customize.md). See everything a team can adjust in Mainworthy, who may adjust it, and where to do it. Use this page to find the right setting, then follow the link to the page that explains it.
- [Policy](./policy.md). Decide how strict a project is, read its policy, and switch it. A policy says who must answer each kind of question and what an agent's answer is worth.
- [People, agents and pipelines](./access.md). Decide who may do what in each project, give a person, an agent or a pipeline a token, and take it away again. Making tokens and changing grants needs an instance admin, who holds `admin` on every project. Some of it only a person may do, and a token for a person who already exists is made by that person or by the owner.
- [Configuration](./configuration.md). Run a Mainworthy instance on your machine or on a server, and set where it listens, where it keeps its data and who owns it. The server reads its settings from environment variables. There is no configuration file.
- [Your data](./data.md). Find your data, export it to a text file, back it up and move it to another machine. Your cases, results and decisions are yours, and you can take them out at any time.

### Reference

- [Keyboard](./keyboard.md). Every key of the web UI, by screen. In the app, <kbd>?</kbd> lists the keys of the screen you are on, and the bar at the bottom shows the ones you are most likely to want next.
- [Command line](./cli.md). Every command of `mainworthy`, with its flags and exit codes. The tables on this page are read from the program, so they match the version you are running.
- [API and agent tools](./api.md). Every operation Mainworthy has, with its address, the capability it needs and its input. The web UI, the command line and an agent's tools all call these same operations. The command line and the HTTP API reach all nineteen. An agent's tools are ten of them.
- [Glossary](./glossary.md). The words Mainworthy uses, each in a sentence or two, with the page that says more. The words are the ones you see in the app and in command output.
- [Troubleshooting](./troubleshooting.md). What the common messages mean and what to do about each. Find the message or the symptom you have, then follow the link for the background.
- [How it is built](./architecture.md). A short look under the hood for people who run or extend Mainworthy: the parts, how a request travels through them, and the rules the design holds itself to. You do not need this page to use the product.

<!-- /generated -->

## Help while you work

You do not need to keep these pages open. The app points back to them:

- **Docs** at the bottom of the sidebar, beside Keys and Theme, opens the page about the screen you are on, in a new tab. On the queue that is [decide in the queue](./decide.md). <kbd>g</kbd> <kbd>d</kbd> does the same from the keyboard.
- <kbd>?</kbd> lists every key that works on the current screen, with a link to the same page.
- An empty list links to the page that says how something gets into it, and each section of Settings links to the page that explains it. Settings is the gear beside your name at the bottom of the sidebar, or <kbd>g</kbd> <kbd>,</kbd>.
- The sign-in page links here too, because the docs need no account.
- <kbd>⌘</kbd> <kbd>K</kbd> opens the palette. Type `docs` and a word to jump to a page from there.

These pages come with the server you are running, so they describe that version. The version is at the bottom of every page.
