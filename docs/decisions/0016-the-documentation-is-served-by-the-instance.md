# 0016: The documentation is served by the instance, and the check keeps it true

- Date: 2026-10-13
- Status: proposed (built in the pull request that adds `/docs`; the owner reviews)

Until now a person who used Mainworthy had the README and nothing else. The README is for someone looking at
the repository, which is private; the rest of `docs/` is the design and its history, written for whoever builds
the product. Someone signed in at `https://mainworthy.com` had no page that said what a question is, which
answer excuses a failure, or what a project can adjust.

The owner asked for a documentation website that stays current when features and workflows change, that says
what can be customized, that uses the interactive diagrams, and that the app links to.

## Decision

**The instance serves its own documentation at `/docs`.** The pages are Markdown files in `docs/guide/`. The
server renders them once, on the first request, with Bun's built-in Markdown renderer, and serves them with the
diagrams and screenshots they show. All of it is imported by name in `src/surfaces/docs/content.ts`, so the
single-file build carries it. There is no second deployment, no build step and no new dependency.

**It needs no session.** The site is handed to `serve` as `open` routes, which are given the request and nothing
of the instance (`src/surfaces/http.ts`). It cannot show a project, a person or a setting, so it is the same for
every instance of a version, like `/api/openapi.json`. That is what lets the sign-in page link to it.

**A page is plain Markdown that GitHub also renders.** A page uses no syntax of its own. The site decides from
ordinary Markdown what to add (`src/surfaces/docs/render.ts`):

| In the Markdown | On the site |
| --- | --- |
| `[text](./policy.md#presets)` | A link to `/docs/policy#presets` |
| A paragraph that is only `[caption](../diagrams/NAME.html)` | The interactive diagram in a frame, with the caption |
| `![alt](../ui/screenshots/NAME-light.png)` alone in a paragraph | The screenshot in the reader's theme |
| `> [!NOTE]` | A note |

**A diagram is served as a stranger.** Each diagram is a page that archify builds, with its script inside it.
It is sent with a `sandbox` policy that gives it an origin of its own and lets it load nothing, so it cannot
read what the app keeps in the browser or call the API as the person looking at it. A diagram page also
records the address of the repository its sources are in. The server sends the page with the product's name
in its place (`withoutRepositoryAddress`): which files a part was drawn from is useful to a reader, whose
repository they are in is not, and the site is public. A page of the docs itself
runs one script file and no script written into the page.

**What can be read from the code is read from the code.** The tables of commands, operations, agent tools,
capabilities, answer keys and policy presets are written by `scripts/gen-docs.ts` from the lists the product
runs on, between `<!-- generated:NAME -->` markers. They are committed, so a change to an operation shows up
as a changed docs file in the same pull request.

**The check fails when the docs fall behind** (`test/docs.test.ts`, `test/e2e/docs.test.ts`):

| What changed | What fails |
| --- | --- |
| An operation, command, preset, capability or answer | The generated table differs from the committed one |
| A new `MAINWORTHY_*` variable, verdict, kind of question or error code | The name is on no page |
| A page added, removed or renamed | The table of contents and the files disagree; a link to it finds nothing |
| A heading renamed | A link to that heading finds nothing |
| A diagram's source edited | Its page was not built again (`docs/diagrams/src/built.json`) |
| A key added to a screen | The Keys overlay lists a key the keyboard page does not |
| A screen added | The app does not compile until `SCREEN_DOCS` names its page |
| A directory the site imports from, not in the image | The Dockerfile or `.dockerignore` leaves it out; CI builds the image and asks it for `/docs` |

What a test cannot see is whether a sentence is still true. That stays a working rule in `AGENTS.md`: a
user-visible change updates the page that describes it, in the same pull request.

**The app points at the docs** (`src/core/docs.ts` is the one list both read): Docs in the sidebar and `g d`
for the page about the current screen, a link on the sign-in page, the same link in the Keys overlay, the pages in the
palette, and a link beside each empty list and each Settings section.

## Turned down

- **A static site on another host** (GitHub Pages, Cloudflare Pages). The repository is private, so Pages needs
  a paid plan or a second repository; the site would be a second thing to deploy; and it would describe `main`,
  not the version a person is running. A local instance with no network would link to a page it cannot reach.
- **Screens inside the web app.** They would need a session, so the sign-in page could not link to them, and a
  page could not be sent to someone who has no account. The text would also ship in the app's bundle.
- **A documentation generator** (Docusaurus, VitePress, Starlight). Each brings Node, a build step and hundreds
  of packages into a repository whose rule is Bun and no other tool, for what is here 400 lines of rendering.
- **Generating every page.** Prose that explains why cannot be read from a list of operations. Tables are
  generated; sentences are written.
- **Building the diagrams in the check.** archify is a tool the author runs, not a dependency. The pages are
  committed and stamped instead.

## What this leaves open

- The site is in English only, and has no versions: an instance serves the docs of its own version.
- The screenshots are made by `bun test/e2e/screenshots.ts` and are not checked against the app.
- Search is a word match over the pages, made in the browser. It has no ranking beyond headings before text.
