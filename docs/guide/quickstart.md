# Quickstart

Start a local instance, write one case, and upload a failing test result.
Then answer its question and read the gate in about ten minutes.

## Start a local instance

An instance needs PostgreSQL 18. `compose.yaml` runs it alongside the app. Running elsewhere is possible but
not yet supported. For this source-tree tutorial, install PostgreSQL 18 binaries and use `bun run dev` to
start the checkout's development cluster, or set `MAINWORTHY_DATABASE_URL` to a dedicated empty PostgreSQL database.
The Local product layer has ended; loopback authentication remains available for development.

You need the `mainworthy` command. First, install Bun 1.4 or newer.
From the source tree, run `bun install`, then `bun run build`. The executable is `dist/mainworthy`.
Where this tutorial says `mainworthy`, use `dist/mainworthy` or add `dist` to your `PATH`.
You can also use `bun src/cli/main.ts` without a build.
See [configuration](./configuration.md#build-the-single-executable).

To run the server from the source tree, use `bun run start` in place of
`mainworthy serve`. It serves the same web UI as the executable. Both `bun src/cli/main.ts serve`
and `bun run dev` serve the web UI as a development bundle that reloads when the code changes. The development bundle uses a looser page policy for work on Mainworthy.

This tutorial uses a fresh temporary data directory and port `7701`. If that port is
in use, choose another. Use the chosen port in every address below. Run the commands in a shell
on your own machine.

To start the tutorial instance, follow these steps.

1. Start the server in your first terminal.

	```sh
	$ export MAINWORTHY_DATA=$(mktemp -d)
	$ export MAINWORTHY_PORT=7701
	$ export MAINWORTHY_OWNER=robin
	$ bun run dev
	```

	The server prints its address and data directory, then this line:

	```text
	project "scratch" · you are robin@this-machine · policy: loose
	```

2. Open `http://127.0.0.1:7701`.

	Local mode signs you in as the owner. You see the empty Suite.

3. Keep the first terminal open.

4. Point a second terminal at this instance.

	```sh
	$ export MAINWORTHY_URL=http://127.0.0.1:7701
	```

## Write one case

Create a case for a coupon test with these steps.

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

3. Open Suite to see the case.

	You can also create a case with <kbd>c</kbd>. [Write cases](./write-cases.md) explains the editor and when it records a version.

## Report a failure

Upload a failing result for the case with these steps.

1. Create `results.xml` with this small JUnit report.

	```xml
	<testsuite name="checkout">
	  <testcase name="percentage coupon @C-1@v1" classname="checkout">
	    <failure message="expected $90.00, got $100.00" />
	  </testcase>
	</testsuite>
	```

	The test name identifies case `C-1`, version `1`. If your case has another ID, use that ID in the test name.
	The commit below is a tutorial value, not a commit you need to create in Git.

2. Upload the report.

	```text
	$ mainworthy report results.xml --commit 1111111111111111111111111111111111111111 --branch quickstart
	mainworthy report  scratch @ 1111111  (quickstart)
	  1 result   0 pass   1 fail   0 skip  (R-1)
	  1 new   Q-2 "expected $90.00, got $100.00"   (1 test)
	  0 results had no case or version when recorded
	  basis: exact 1 result
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

For this exercise, treat the failure as a problem with the test environment. Follow these steps to record that decision.

1. Open Queue with <kbd>g</kbd> <kbd>q</kbd>.

	The failure question asks why the test failed. The answer choices say what each answer does.

2. Read the question through the CLI.

	```text
	$ mainworthy inbox --kind failure
	      "q": "Q-2",
	      "kind": "failure",
	      "title": "expected $90.00, got $100.00",
	      "evidenceHash": "7e76b294befd",
	      "needs": "one member",
	```

	The excerpt omits other output lines. If your question ID or evidence hash differs, use the values from your output. The hash makes your answer apply to the evidence you just read.

3. Answer through the CLI.

	```text
	$ mainworthy decide --json '{"q":"Q-2","onEvidence":"7e76b294befd","answer":{"is":"infra"}}'
	    "q": "Q-2",
	    "status": "decided",
	```

	The excerpt shows two lines of the returned decision. In Queue, the equivalent answer is
	<kbd>i</kbd>, "Infrastructure". That answer excuses only this build.

4. Read the gate again.

	```text
	$ mainworthy gate --commit 1111111111111111111111111111111111111111
	mainworthy gate    passed: 1 failure excused by a decision, nothing else ran
	$ printf 'exit code: %s\n' "$?"
	exit code: 0
	```

	The failed result remains recorded. The decision explains why the failure does not block the gate.
	You do not need a second upload. See [decide](./decide.md) and [changes](./changes.md)
	for answers that require a fix instead.

## Stop the tutorial instance

When you finish the exercise, follow these steps.

1. Press <kbd>Ctrl</kbd> <kbd>C</kbd> in the first terminal.
2. If you no longer need the exercise, remove the temporary data directory.

	Keep the data directory if you want to return to its case and decision history.
