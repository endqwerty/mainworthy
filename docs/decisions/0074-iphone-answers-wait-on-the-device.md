# 0074. iPhone answers wait on the device

Date: 2026-10-15. Implements issue #206, deferred by decision 0023.

## Problem

A short network drop used to lose a queue answer once its immediate retries ended. A lost reply also left the person unsure whether to give the answer again. The server already checks the evidence and remembers a command's reply.

## Shape

QueueScreen.answer asks ProjectClient.prepareAnswer to capture the complete decide input and command id before sending, including ifOpen: true. The server refuses a saved answer if somebody decided the question meanwhile, without replacing their decision. A known command returns its recorded reply before that precondition is checked. AnswerOutbox.enqueue saves it first. AnswerOutbox.send sends waiting entries in order and saves each outcome before moving on. The view reads entries through the screen.

Each entry keeps the question ref and title, evidence hash, answer, reference, reason, command id, and eventual outcome. A network error, cancelled task, expired session, rate limit, internal error, or unreadable reply leaves the command waiting. A server decision, advice, changed evidence, or refusal ends that entry. An overtaken answer is never updated to newer evidence or retried as a new command. Its message asks the person to read the question again and answer on its current evidence.

Files are written atomically under the app's Application Support directory and excluded from device backups on save and load. Their names hash the instance URL, stable actor id, and project key. A file that cannot be read is preserved and blocks new answers to that outbox. Failure to save a new answer prevents sending it. Failure to save an outcome pauses sending, leaving the original saved command safe to retry.

Workspace owns an outbox for each accessible project. The existing change-stream reconnect loop sends their answers while the app is in front, including projects the person has left. Opening a project shows its saved entries. Explicit sign-out stops new sends from that workspace and keeps the files for the same person signing in on the same instance. A request already sent may complete. Another person sees and sends only their own files.

## Synthesis decision

Capture the prepared input, rather than serializing every evidence type in a Question. Reconstructing an answer by ref after reconnecting was rejected because it could silently attach an old judgment to new evidence. Keeping answers only in memory was rejected because closing the app would discard work whose server outcome might already exist.

## Limits

Linking tests and creating cases keep their existing MappingSubmission flow outside this outbox. Their sheet says a connection is required and the answer is not saved in Unsent answers. An uncertain reply keeps the same command in memory for Retry. Closing the app loses that command and the mapping choices.

Other queue answers and their outcomes survive closing the app, unlike case-editor drafts. Reopening the app still needs the server to identify the signed-in person before their workspace opens. There is no background delivery while the app is closed. Removing the app removes these files. Outcomes stay until the person presses **Clear outcomes**. Waiting answers cannot be cleared because a lost reply may already have recorded them. A reply that stays uncertain holds later answers in that project.

The existing decide operation and its reply suffice. The session reply adds actorId so a new person cannot inherit saved answers by reusing a forgotten name. The app requires this field and therefore needs an updated server. There is no migration or new operation.
