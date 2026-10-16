# Quickstart

Start a local instance, write one case, and upload a failing test result.
Then answer its question and read the gate in about ten minutes.

## Start a local instance

You need the `mainworthy` command. From the source tree, install Bun 1.4 or newer,
then run `bun install` and `bun run build`. The executable is `dist/mainworthy`.
Use that path wherever this tutorial says `mainworthy`, or add `dist` to your `PATH`.
You can also use `bun src/cli/main.ts` without a build.
See [configuration](./configuration.md#build-the-single-executable).

To run the server from the source tree, use `bun run start` in place of
`mainworthy serve`. It serves the same web UI as the executable. `bun src/cli/main.ts serve`
by itself, and `bun run dev`, serve the web UI as a development bundle that reloads when
the code changes. The development bundle uses a looser page policy for work on Mainworthy.

This tutorial uses a fresh temporary data directory and port `7701`. If that port is
in use, choose another and use it in every address below. Run the commands in a shell
on your own machine.

1. Start the server in your first terminal.

```sh
$ export MAINWORTHY_DATA=$(mktemp -d)
$ export MAINWORTHY_PORT=7701
$ export MAINWORTHY_OWNER=robin
$ mainworthy serve
```

The server prints its address and data directory, then this line:

```text
project "scratch" · you are robin@this-machine · policy: loose
```

2. Open `http://127.0.0.1:7701`.

Local mode signs you in as the owner. You see the empty Suite. Keep the first terminal open.

3. Point a second terminal at this instance.

```sh
$ export MAINWORTHY_URL=http://127.0.0.1:7701
```

## Write one case

1. Create `coupon.txt` with this outline.

```text
Checkout applies a percentage coupon #checkout
  Open the cart with one $100.00 item
  Apply coupon SAVE10 > Total shows $90.00
```

2. Create the case.

```text
$ mainworthy new coupon.txt
C-1
```

Open Suite to see the case. You can also create it with <kbd>c</kbd>.
[Write cases](./write-cases.md) explains the editor and when it records a version.

## Report a failure

1. Create `results.xml` with this small JUnit report.

```xml
<testsuite name="checkout">
  <testcase name="percentage coupon @C-1@v1" classname="checkout">
    <failure message="expected $90.00, got $100.00" />
  </testcase>
</testsuite>
```

The name identifies case `C-1`, version `1`. Replace it if your case has another ID.
The commit below is a tutorial value, not a commit you need to create in Git.

2. Upload the report.

```text
$ mainworthy report results.xml --commit 1111111111111111111111111111111111111111 --branch quickstart
mainworthy report  scratch @ 1111111  (quickstart)
  1 results   0 pass   1 fail   0 skip  (R-1)
  1 new   Q-2 "expected $90.00, got $100.00"   (1 test)
  0 tests have no case (tracked)
  basis: exact 1
mainworthy gate    blocked: 1 failure unexplained, 1 question open
```

A successful upload records the report. It does not mean the gate passes.
[Report results](./report-results.md) explains CI detection and result identity.

3. Read the gate and its exit code.

```text
$ mainworthy gate --commit 1111111111111111111111111111111111111111
mainworthy gate    blocked: 1 failure unexplained, 1 question open
  Q-2 needs an answer
$ printf 'exit code: %s\n' "$?"
exit code: 2
```

## Answer the question

1. Open Queue with <kbd>g</kbd> <kbd>q</kbd>.

The failure asks why the test failed. The answer choices say what each answer does.
For this exercise, treat the failure as a problem with the test environment.

2. Read the question through the CLI.

```text
$ mainworthy inbox --kind failure
      "q": "Q-2",
      "kind": "failure",
      "title": "expected $90.00, got $100.00",
      "evidenceHash": "7e76b294befd",
      "needs": "one member",
```

This excerpt removes other output lines. Use your own question ID and evidence hash
if they differ. The hash makes your answer apply to the evidence you just read.

3. Answer through the CLI.

```text
$ mainworthy decide --json '{"q":"Q-2","onEvidence":"7e76b294befd","answer":{"is":"infra"}}'
    "q": "Q-2",
    "status": "decided",
```

These are two lines of the returned decision. In Queue, the equivalent answer is
<kbd>i</kbd>, "Infrastructure". It excuses this build only.

4. Read the gate again.

```text
$ mainworthy gate --commit 1111111111111111111111111111111111111111
mainworthy gate    passed: 1 failure excused by a decision, nothing else ran
$ printf 'exit code: %s\n' "$?"
exit code: 0
```

The failed result remains recorded. The decision explains why it does not block.
You do not need a second upload. See [decide](./decide.md) and [changes](./changes.md)
for answers that require a fix instead.

## Stop the tutorial instance

1. Press <kbd>Ctrl</kbd> <kbd>C</kbd> in the first terminal.
2. Remove the temporary data directory when you no longer need the exercise.

Keep the data directory if you want to return to its case and decision history.
