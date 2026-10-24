# 0089. The iPhone app supports the current iOS and the one before

Date: 2026-10-16. Asked by the owner in a thread.

## How firm this is (added 2026-10-23, issue #905)

The owner's words were tentative: "maybe only current, next and one previous; I'm not sure one previous is even
needed". They asked to drop old iOS versions and doubted the "one before". The policy below (the current major iOS
and the one before, the macOS floor that follows it, and moving the floor when a new iOS ships) is an agent's choice
that keeps the version the owner doubted. It stands as a working default, not a rule the owner set.

## Problem

The app was built for iOS 18 and later (`ios/project.yml`, `ios/Kit/Package.swift`). Making the queue's **Select**
follow iOS 26's toolbars needed `ToolbarSpacer`, which iOS 26 added, behind an `#available` check. The owner asked to
drop old iOS versions: "maybe only current, next and one previous; I'm not sure one previous is even needed".

## Decision

**The app supports the current major iOS and the one before.** On 2026-10-16 that is iOS 27 and iOS 26, so the
deployment target is 26.0 in `ios/project.yml` and `.iOS("26.0")` in the package. The package's tests run on the Mac,
so its macOS floor follows the same rule: `.macOS("26.0")`, which the CI runner (`macos-26` image) meets.

- **The one before** costs nothing today: no screen needs an API that iOS 27 added. iOS 26 is also where the system's
  current toolbars, tab bar and glass arrived, which the app's design now follows, so it is the natural floor.
- **The next** iOS needs no target of its own: an app built for 26 runs on later versions. A beta is tried with the
  Xcode that ships it.
- **When a new iOS ships**, the floor moves up a version in the same change that first builds with its Xcode, and code
  behind `#available` checks for the dropped version is removed.

What this let the app do with no availability checks (same pull request):

- **Selecting in the queue** works as in Photos and Files: the tab bar gives way to a bottom toolbar with the count and
  **Answer**, **Select All** is at the top left, and **Done** at the top right.
- **The floating bars** (the queue's and a question's notices, the Cases notice, a run slot's outcome buttons) are
  glass placed with `safeAreaBar`, so content scrolls under them as under the system's bars, in place of hand-drawn
  material cards.
- **The primary action of a floating bar** uses the glass prominent button style.

## Turned down

- **Only the current iOS.** A phone that cannot update yet, or a person who waits, would lose the app at each
  release for no gain.
- **Keeping iOS 18 with availability checks.** Every new screen would carry two designs, and the older one is
  tested nowhere: the simulator and CI run the current iOS.

## Not done

- Moving the Cases search into the tab bar's search role, and minimizing the tab bar on scroll. Both change how the
  app behaves, not only how it looks, and nobody asked.
