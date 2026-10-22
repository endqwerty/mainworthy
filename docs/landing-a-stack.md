# Landing a stack

For an agent, when the owner has said in the current thread to merge a stack or its lower layers. Without those
words nothing merges: `build`, `babysit` and `autopilot-stack` open the stack, link it to the thread and stop.

A stack is a chain of pull requests: each one's base is the branch of the one below, and the lowest one's base is
`main`. After a layer lands by rebase its commits have new ids on `main`, so a layer landed alone leaves the rest
to be rebased onto the result and pushed, and a changed revision or base needs its checks and a short round of
review again. `gh stack merge` lands the layers together instead:

```
gh stack merge <the highest pull request the owner's word covers> --rebase --yes
```

It merges that pull request and every layer below it into the stack's base, or none of them. You look at every
layer before the command and at every result after it. That replaces two things in `ship`: landing one request at
a time, and looking at the next request between landings. Its other gates hold.

## Before the command

- The owner's word covers every layer the command merges. It merges all the layers below the one you name, so
  merge nothing if one of them is a layer the owner did not name.
- The number means the pull request. The command first tries its argument as the number of a stack and merges the
  whole of a stack that has it, so `gh api 'repos/{owner}/{repo}/stacks/<number>'` must answer 404. In the answer
  of `gh api 'repos/{owner}/{repo}/stacks?pull_request=<number>'` the base is `main` and the members are the layers
  you expect, in order. It prints `[]` for a chain that only its base branches hold together; `gh stack link
  <lowest> ... <highest>` (pull request numbers) makes a stack of it, changes a base that does not fit the order
  you gave, and only warns when it could not. Read the members and the bases afterwards; a layer whose base changed
  needs its checks and its verdict again.
- Each layer has its own passing independent verdict and a green `gate` on the head and the base it has now. The
  command sends no revision: what the branches hold when it runs is what lands. Just before you run it, compare
  every head and base with the ones that were verified, and run it only while nothing else pushes to those
  branches. The extension checks that a layer is open and not a draft; `main` has neither branch protection nor a
  ruleset requiring `gate`, so only you stop a layer whose check failed. When `gate` is a required check on
  `main`, GitHub stops it and this sentence goes.
- Each layer's head and base are the pair the Daybreak audit read, with no issue left unaddressed
  ([security-audit.md](security-audit.md)). A layer whose head or base changed is audited again before the command.
- Pass `--rebase`. Without it the command picks the method: the one the account used last or the repository's
  default. The repository allows rebase only, but pass it anyway. A merge queue on `main` would ignore the flag and
  could land the layers apart; there is none, and with one, do not use this command.

## After the command

- Check that every layer says merged and that `main` holds its commits. The `/healthz` check is made once, for the
  commit `main` ends on.
- A command that fails can leave the merge running: it asks for the status up to 600 times, a second apart, and
  gives up at the first request that fails. Read the state of every layer first. Land nothing one at a time until
  you know that no layer merged and that no merge is still running.

`gh stack` is an extension of `gh` (`gh extension install github/gh-stack`; 0.2.1 has `merge`). It merges only
pull requests that GitHub holds as a stack. This page comes from the extension's code and README, not from a
landing: when the command does something the page does not say, correct the page.
