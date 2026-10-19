# 0114: The browser tests run Playwright's Chromium

Date: 2026-10-18

Part of [issue #469](https://github.com/endqwerty/mainworthy/issues/469).

The browser tests used the first system Chromium they found (`/usr/bin/chromium`, then Google Chrome). Two things
made that browser a poor fixture:

- Its version is whatever the machine installed. playwright-core 1.64 was released with Chromium 156; the
  owner's Linux machine had Arch's 152, then 154 after an update on 2026-10-18, and a GitHub runner has the
  current Google Chrome.
- On Arch, `/usr/bin/chromium` is a launcher that adds `~/.config/chromium-flags.conf` to every start. The
  crashed test browsers' command lines carried the desktop's flags: `--ozone-platform=wayland`, three
  `--load-extension` directories and `--password-store=gnome-libsecret`.

The load test below found a third: under load the full Chromium builds failed, Playwright's own Chrome for
Testing too, and Playwright's headless shell did not. So the tests now start the headless shell that
playwright-core names for its own revision.
`bun run browser` installs it into Playwright's cache, which every worktree shares; the T3 worktree setup and
each CI test job run it. `MAINWORTHY_CHROMIUM` still names another browser. A machine without it skips the
browser tests with a line that names `bun run browser`; no system Chromium is picked up any more, so a machine
runs the browser it was told to or none.

## Evidence

A load script (16 browser servers, as many as the check's worker slots, four journeys each at a time, eight
CPU-bound processes beside them; load average 60 to 70 on 16 threads) opened a context and a page of a seeded
server, pressed three keys and closed it, for each browser in turn:

| Browser | Seconds | Journeys | What went wrong |
| --- | --- | --- | --- |
| Arch Chromium 154 (`/usr/bin/chromium`) | 180 | 1184 | one `goto: Page crashed` |
| Arch Chromium 154 | 300 | none reported | the run did not end within 500 s |
| Arch Chromium 154 | 300 | 1837 | nothing |
| Chrome for Testing 156 (Playwright's full Chromium) | 300 | 2133 | nothing |
| Chrome for Testing 156 | 300 | 1905 | one browser process exited; its four journeys failed from then on |
| Playwright headless shell 156 | 300 | 3924 | nothing |
| Playwright headless shell 156 | 300 | 3855 | nothing |

Both full Chromium builds failed under this load, the system's and Playwright's: Chrome's new headless mode, in
which a test browser is the whole browser started with `--headless`, is common to them, and the exited browser
process matches #469's crashes, which were browser processes too. The headless shell is a separate, smaller
build of the older headless mode. It did 7779 journeys with nothing going wrong, and about twice the work of
either full build in the same time. Three failures in about 7000 full-build journeys against none in 7779 is
evidence, not proof (at the full builds' rate the headless shell would show none about one time in 27), and
the cause inside Chromium is not known: no core dump was recorded for the exited Chrome for Testing process.

## Not chosen

- **Playwright's full Chromium (Chrome for Testing)**: its path is in playwright-core's public API and its
  version is the one playwright-core expects, but it failed under load as the system Chromium did and did
  about half the journeys of the headless shell. Playwright itself uses the headless shell for headless runs.
  The headless shell's path comes from playwright-core's untyped registry instead; `test/check.test.ts` holds
  it to the revision in `browsers.json`, so an upgrade that moves it fails a test instead of skipping the
  browser tests.
- **Keeping the system Chromium as a fallback**: a machine that missed the install would quietly go back to the
  browser this replaces.
- **Downloading the browser in a `postinstall` script**: the container build would download it too, and it
  needs none.
