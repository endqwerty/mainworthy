# 0026: The apps offer one instance, and say nothing of licensing

- Date: 2026-10-14
- Status: accepted (the owner's request, 2026-10-14). Amends [0002](0002-layered-self-hosting.md) for the apps.
  Amended 2026-10-23 by [PostgreSQL on Cloud Run and Cloud SQL](2026-10-23-postgresql-on-cloud-run-and-cloud-sql.md): the pages for whoever runs an
  instance will say that it needs PostgreSQL, and that running one elsewhere is possible but not yet supported.

The owner asked to hide the option of running Mainworthy on another server, and licensing, from the user
interfaces for now. Both stay: running elsewhere is a future item, and the open-source code keeps what anyone who
takes it needs to run their own instance.

## Decision

**The iPhone app signs in to the instance its build names, and does not ask.** The sign-in screen had an
"Instance" field, filled with `mainworthy.com`, where a person could type the address of another one. It is gone;
the screen asks for a name and a password. The instance is `MAINWORTHY_INSTANCE` in `ios/Config/Base.xcconfig`,
`mainworthy.com`, and a build from source names another in `Local.xcconfig` (`ios/README.md`, "Another instance").
The screen tests pass the server they start as a launch argument, `-instance <address>`. The client is unchanged:
`Instance` and `Server` reach any address, and a session the phone already holds for another instance still works
until it is signed out. When the server ends such a session, the sign-in form renews it on that instance, so the
password goes where the session was opened and the screens that wait for it come back (the verifier's finding).

**The guide stops telling a person how to point the app elsewhere.** The pages for whoever runs an instance stay
(configuration, quickstart, your data): they are how someone who takes the code runs it, and the web UI is always
the instance it is served from, so it has no such option to hide.

**Licensing is not shown in the apps.** The repository's licence files are for GitHub and for anyone who takes the
code. Showing the licence and the notices in the iPhone app and the docs is a backlog item, with what distributing
the executable needs (issue #234). Reversed the same day: the web UI and the diagram pages need their notices
where they are served, and the apps show the licence again (decision 0025).

## Turned down

- **Keeping the field behind a gesture or a setting.** Nobody needs it now, and a hidden control still has to be
  tested and explained. A build setting does the same for the person who builds the app.
- **Taking `Instance` out of the client.** It costs nothing to keep, the tests need it, and it is what brings the
  field back (issue #233).
