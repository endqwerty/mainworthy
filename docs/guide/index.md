# Mainworthy documentation

Mainworthy keeps your test cases, the results that people, pipelines and agents report, and the decisions made about them. Its gate answers whether a change is worthy of `main`. These pages explain how that works, how to use each part, and what you can adjust.

[Diagram: how Mainworthy works](../diagrams/overview.html)

## Where to start

- You have never used it. Follow the [quickstart](./quickstart.md) to start an instance and answer a failure question in about ten minutes.
- You want to look around a filled project first. Run `mainworthy seed demo`. See [a project of demo data](./customize.md#a-project-of-demo-data).
- You want the idea before the keys. Read [how Mainworthy works](./concepts.md).
- You are wiring a pipeline. Read [report results](./report-results.md), then [changes and the gate](./changes.md).
- You want to inspect a gate's results or find an automated test. See [changes and the gate](./changes.md) and [report results](./report-results.md).
- You are setting it up for a team. Read [what you can customize](./customize.md), then [policy](./policy.md) and [people, agents and pipelines](./access.md).
- You met a word you do not know. The [glossary](./glossary.md) has one or two sentences for each.

## All pages

The [web accessibility assessment](https://github.com/endqwerty/mainworthy/blob/main/docs/accessibility.md)
describes the automated checks, known gaps, and the VoiceOver and NVDA work still needed. It is not a
claim of WCAG conformance.

<!-- generated:pages -->

### Start

- [How Mainworthy works](./concepts.md). Mainworthy records cases, results and decisions. A failed test raises a question, and the evidence and decisions together determine the gate's verdict.
- [Quickstart](./quickstart.md). Start a local instance, write one case, and upload a failing test result. Then answer its question and read the gate in about ten minutes.

### Use it

- [Write cases](./write-cases.md). Write cases as outlines, keep their versions, and resolve edits that overlap. Use folders, tags, and search to find the cases you need.
- [Import cases from CSV](./import-cases.md). Preview a CSV file, map its columns to case content and project fields, then confirm one import.
- [Report results](./report-results.md). Send a test report from a runner or CI, then read the gate for the tested commit. Keep the pipeline's identity, retries, and case links with its results.
- [Decide in the queue](./decide.md). Read the evidence behind a question and record an answer with one key. Use the answer's stated consequence to decide what the gate needs next.
- [Planned runs](./runs.md). Choose cases for a run, record results against their pinned versions, and close the run with a verdict. Let CI results fill slots so you do not repeat completed work.
- [Changes and the gate](./changes.md). Read a change's latest verdict and find what prevents it from passing. Use the same gate from the command line to decide whether CI can continue.
- [Let an agent in](./agents.md). Give an AI agent its own token and connect it over MCP to read cases, review changes, and report results. The project's policy decides whether its edits and answers count or need a person's decision.
- [The iPhone app](./iphone.md). Install the iPhone app, sign in and work with your queue, runs, cases and automated tests.

### Customize

- [What you can customize](./customize.md). Find what your team can adjust in Mainworthy, who may adjust it, and where to do it. Follow each link for instructions.
- [Policy](./policy.md). Decide how strict a project is, read its policy, and switch it. A policy says who must answer each kind of question and what an agent's answer is worth.
- [People, agents and pipelines](./access.md). Decide who may do what in each project, give a person, an agent or a pipeline a token, and take it away again. An instance admin holds `admin` on every project and can issue tokens. People can also make their own command-line tokens without admin rights.
- [Configuration](./configuration.md). Run a Mainworthy instance on your machine or on a server, and set where it listens, where it keeps its data and who owns it. The server reads its settings from environment variables. There is no configuration file.
- [Your data](./data.md). Find your data, export it to a text file, back it up and move it to another machine. Your cases, results and decisions are yours, and you can take them out at any time.
- [Privacy](./privacy.md). This policy explains what Mainworthy keeps, why we keep it, how we handle it and your rights over your data. We never sell your data, and we keep as little of it as Mainworthy can work with.

### Reference

- [Keyboard](./keyboard.md). The web app's keys, by screen. <kbd>?</kbd> lists the keys for the current screen. The bar at the bottom shows common actions.
- [Command line](./cli.md). Every `mainworthy` command, with its flags and exit codes. The program generates the tables on this page for the version that serves these docs.
- [API and agent tools](./api.md). Every Mainworthy operation, with its address, required capability, and input. The web UI, command line, and agent tools call these operations. The command line and HTTP API reach every operation. MCP exposes ten of them as agent tools.
- [Glossary](./glossary.md). These definitions explain the words you see in Mainworthy and its command output, with links to the pages that describe them.
- [Troubleshooting](./troubleshooting.md). Find your message or symptom, then follow the steps to resolve it. Each section links to more detail where needed.
- [How it is built](./architecture.md). Mainworthy runs as one server process with a SQLite database. This page explains how its operations record evidence and decisions, and which rules the tests hold the design to.
- [Licence](./licence.md). Mainworthy is open source under the Apache License 2.0. This page describes its terms and the licences of the software Mainworthy bundles.

<!-- /generated -->

## Help while you work

You do not need to keep these pages open. The app links to them where you need them:

- **Docs** at the bottom of the sidebar, beside Keys and Theme, opens the page about the screen you are on, in a new tab. On the queue that is [decide in the queue](./decide.md). <kbd>g</kbd> <kbd>d</kbd> does the same from the keyboard.
- <kbd>?</kbd> lists every key that works on the current screen, with a link to the same page.
- An empty list links to the page that says how something gets into it, and each section of Settings links to the page that explains it. Settings is the gear beside your name at the bottom of the sidebar, or <kbd>g</kbd> <kbd>,</kbd>.
- The sign-in page links here too, because the docs need no account.
- <kbd>⌘</kbd> <kbd>K</kbd> opens the palette. Type `docs` and a word to jump to a page from there.

These pages come with the server you are running, so they describe that version. The version is at the bottom of every page.
