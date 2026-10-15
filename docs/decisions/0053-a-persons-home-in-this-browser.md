# 0053: A person's home in this browser

- Date: 2026-10-14
- Status: accepted
- Issue: [#44](https://github.com/endqwerty/mainworthy/issues/44)

## Context

Decision 0009 made Suite the first home and deferred personal choices. The web shell
opened Suite on entry regardless of who signed in. A home is a person's navigation
preference, not a change to the suite, a run, or the project's policy.

## Decision

Settings has a Your home section for each project. Its choice is Suite, Queue, a
run reference, or one saved Suite search with text, folder, and tag filters.
The search reads current cases, not a saved result set. Suite remains the default.
The shell uses the home when a person opens `/` or `/p/<project>`. Explicit screen
and item links keep their destinations. `g h`, also Go home in the palette, uses
the current project's choice through `navigate`, so leaving an editor still seals it.

The browser stores the validated preference in localStorage through `deviceKey`,
under `mainworthy:<encoded actor>:home:<project>`. This separates people sharing
a browser and projects sharing a person. A fresh browser has no choice. The
preference stays after sign-out, and clearing site data removes it. It does not
follow the person to another browser or the iPhone app.

`src/web/lib/home.ts` owns the schema, storage, and destination URL. Settings owns
the form. The shell resolves the initial destination after identifying the person
and before mounting its panes, so a phone opens a run on its detail. Suite's text
filter is in the URL alongside its folder and tag filters. Changing text replaces
the current URL without sealing the editor or adding history entries.

Malformed or unreadable storage falls back to Suite. A refused write reports
failure and leaves the previous stored choice. A missing run or folder uses the
existing screen's unavailable or empty state; Settings remains reachable to change
home. Setting home performs no server write and changes no access rights.

## Alternatives and limits

A server-side actor preference would follow a person across browsers. It would
require a registry operation and database and archive ownership for a navigation
preference. The first slice uses the existing browser preference convention and
states that limit on the form and in the guide. Server synchronization, a library
of named searches, and custom dashboard panels remain outside this slice.
