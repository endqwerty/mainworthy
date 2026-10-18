# 0022: A change ends, and an ended change is not asked about

- Date: 2026-10-13
- Status: accepted (the owner agreed the direction in the thread that built it, 2026-10-13)

The one failure in the queue of project `mainworthy` on 2026-10-13 was a test that timed out on pull request
150. The pull request had merged that afternoon, and a later commit had fixed the test's time limit. The
question still said "blocks gate", for a gate nobody would read again, and nothing could take it away but a
person's answer: a failure question leaves by itself only when a newer result of the same pull request passes,
and a merged pull request sends no more results. Mainworthy had no word for "this change is over".

## Decision

**A change has an end: `merged` or `closed`.** It is a fact about the change, like where its head is, so it
is said by whoever reports for the change, a pipeline or a person, through a new operation, `change`. An
agent's word about it is refused, as its word about where a commit belongs is not taken. The state `open` says
the change is open again.

**An ended change is not asked about.** `askUnexplained` already had the idea: a run "speaks" when an answer
about it would be acted on, and an older commit of a change does not speak because a newer one replaced it.
The run of a change that has ended does not speak either. So:

- When a change ends, its open failure questions are closed (the state `dissolved`, which a question takes
  when what it asked about went away).
- A report for it that arrives later, from a job that finished after the merge, is recorded and counted and
  raises no question. This is why the end is kept on the change and not applied once: the `closed` event of a
  pull request usually arrives before its last job has reported.
- When it is opened again, the run of its newest commit speaks again, and what it shows unexplained is asked
  about at once.

**A failure that came with the merge is not lost.** The line runs the same tests on the merged commit. If the
failure is real it fails there, in the line's scope, and is asked about there. If it does not fail there, it
was the pull request's own and there is nothing to decide.

**What does not change.** The verdict of the change's last commit: it failed and nobody explained it, so it
reads `blocked`, now with no open question. Answers already given. Findings, which are about cases. And a
question that an open planned run still shows unexplained: that run was asked for by a person and waits for
the answer whatever became of the pull request.

**The signal is sent, not fetched.** Mainworthy does not talk to a code host (issue #89 is the instance
fetching reports). A workflow on `pull_request: [closed, reopened]` makes one request with the pipeline's
token. This repository's is `.github/workflows/change.yml`; the guide has the same for a user.

## Where it is kept

In a table of its own, `change_ends`, which an archive leaves out. A column on `changes` was the first
version. `changes` travels in an archive, so the column would have raised the archive version, and an import
refuses an archive older than that: five tests that import an archive of an earlier build failed. A change's
end is not worth every backup taken before today. So after an import every change is open. The questions that
were closed when a change ended stay closed, because that is their own state; only a failure reported again
for such a change would be asked about, until somebody says once more that it ended. The pull request that
makes demo projects (decision 0100 there) keeps its mark the same way, for the same reason.

## A third operation for a pipeline

Decision 0014 gave a pipeline's token two operations, `report` and `gate`, and a test holds the list. `change`
is the third. It needs `record`, because the pipeline is the one that knows a pull request closed. What a
secret in a CI system gains is the power to stop the questions about one pull request. It could already do
that by reporting a pass for the same tests on a newer commit. The verdict is not touched either way: a commit
that failed unexplained reads `blocked` after its change ended.

## Turned down

- **Working it out from the reports.** A merged pull request's commits do not appear on the line: GitHub's
  rebase and squash merges write new commits, so no report on the line names the pull request it carried.
- **A time limit**: a change with no report for some days counts as ended. It needs nothing sent, and it is a
  guess. It would close the question of a slow pull request whose author is still on it, and leave a merged
  one in the queue for days.
- **Answering the questions by rule** ("the change ended") instead of closing them. An answer is a judgement
  about a cause and carries forward; nothing was judged here.
- **Making the ended commit's gate read anything but what it was.** A pull request that merged red merged red.

## Not done

- Findings and proposals about an ended change stay open. They are about cases, not about the build.
- A pull request from a fork tells nothing: the workflow has no token there.
- The existing question about pull request 150 on the instance predates this. A person answers it, or the
  workflow is run once by hand for it (`gh workflow run change.yml -f pull=150 -f state=merged`).
