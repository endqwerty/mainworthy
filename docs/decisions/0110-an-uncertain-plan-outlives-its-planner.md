# 0110: An uncertain plan outlives its planner

- Date: 2026-10-18
- Status: proposed

A plan's reply can be lost after the server creates the run. The web planner retained the command for
Retry plan while it stayed open, but Cancel, Escape, another screen, or reload discarded it. Planning
again created a second run. Two synchronous clicks also passed the React state guard before a render.
[Issue #588](https://github.com/endqwerty/mainworthy/issues/588) records both paths.

Save the exact submitted plan, including its command id, in localStorage before sending it. The key uses
the device's existing actor id and the project. Reopening restores the choices and offers Retry plan.
The saved input is parsed with the core PlanInput schema and requires a command id and the opaque project
identity from the session's project list. An unchanged retry keeps that original identity. A known mismatch
leaves the saved plan locked with an explanation and Discard; a replacement after the session read is refused
inside the registry's write transaction, before command replay. A saved plan without an identity is invalid,
never filled in with the current project's identity. A ref changes to
sending synchronously, so the next submit cannot send another command before React renders.

Cancel and Escape may close the planner because the command survives outside the component. A readable
success removes only the matching saved command. An operation's `invalid`, `conflict`, or `not_found`
refusal releases the choices, including on a retry: the registry replays a matching recorded command
before running `plan`. The fixed request passes the same input schema, and `plan` records atomically.
A registry conflict saying that the command was already used for another request keeps the plan saved
and locked: it proves a command was recorded, not that no run exists. This can follow an input-format
change between deploys. The planner says a run may already exist and to check Runs before discarding.
An unreadable or lost reply, `internal`, `unauthenticated`, `forbidden`, or `limited` reply keeps the
command saved. These failures can happen before replay. The registry also returns `not_found` before
replay for an unknown operation or a missing project or grant. HTTP can also refuse a missing route.
Those exact replies keep the command.

Discard this plan releases a pending request with a warning that it may already have been recorded.
It does not undo a run. Removal of the shared key is authoritative: storage notifications, failure
callbacks and retries release a held request when its saved key is absent. A storage read error proves
nothing and retains the request. A different saved command is still shown before sending; absence does
not restore the held command. An older failure callback cannot replace a newer held command.
The notice asks the person to check Runs because another tab may have discarded or completed the request.
Invalid saved data is removed at the storage boundary and treated as absent.
A planner reads shared storage on every submit, including a retry. If another command is saved there,
it shows that request's choices and a notice, then waits for an explicit Retry plan before sending it.
An already saved retry is not written over the shared key again. A stale tab therefore cannot replace
a newer saved request with the command it still shows. Late replies cannot clear another command
or restore data that the person cleared. If the browser cannot save the request, planning stops before
the network write.

Reading the server's command outcome before leaving would also preserve the run, but it adds another
request and a reconciliation flow. Retaining the input uses the existing plan replay contract and the
same device ownership and clearing rules as drafts. The CLI, MCP, native app, and archives do not use
this React component or its lifetime. Their contracts do not change. The demo cannot simulate a lost
browser reply, so its generated data stays the same.
