import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { contentHash } from "./hash.ts";
import { normaliseFailure, signatureHash } from "./signature.ts";
import { textArbitrary } from "./test-support.ts";

type FailureExample = { runner: string; message: string; class: "assertion" | "timeout" | "infra"; stable: string };
const examples: FailureExample[] = [
	{
		runner: "Playwright",
		message: "expect(locator).toBeVisible: Timeout 5003ms exceeded.",
		class: "timeout",
		stable: "expect(locator).toBeVisible: Timeout <duration> exceeded.",
	},
	{
		runner: "Playwright",
		message: "expect(locator).toBeVisible: Timeout 10001ms exceeded.",
		class: "timeout",
		stable: "expect(locator).toBeVisible: Timeout <duration> exceeded.",
	},
	{
		runner: "Playwright",
		message: "page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:35741/checkout",
		class: "infra",
		stable: "page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:<port>/checkout",
	},
	{
		runner: "Playwright",
		message: "page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:42819/checkout",
		class: "infra",
		stable: "page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:<port>/checkout",
	},
	{
		runner: "Playwright",
		message: "Target page, context or browser has been closed",
		class: "infra",
		stable: "Target page, context or browser has been closed",
	},
	{
		runner: "Playwright",
		message: "browserType.launch: Browser crashed",
		class: "infra",
		stable: "browserType.launch: Browser crashed",
	},
	{
		runner: "Playwright",
		message: "expect(received).toBe(expected): expected 90.00, got 100.00",
		class: "assertion",
		stable: "expect(received).toBe(expected): expected 90.00, got 100.00",
	},
	{
		runner: "Playwright",
		message: "expect(received).toBe(expected): expected 95.00, got 100.00",
		class: "assertion",
		stable: "expect(received).toBe(expected): expected 95.00, got 100.00",
	},
	{
		runner: "Jest",
		message: "Error: expect(received).toEqual(expected)",
		class: "assertion",
		stable: "Error: expect(received).toEqual(expected)",
	},
	{
		runner: "Jest",
		message: "Exceeded timeout of 5000 ms for a test.",
		class: "timeout",
		stable: "Exceeded timeout of <duration> for a test.",
	},
	{
		runner: "Jest",
		message: "Exceeded timeout of 30000 ms for a test.",
		class: "timeout",
		stable: "Exceeded timeout of <duration> for a test.",
	},
	{
		runner: "Jest",
		message: "A worker process has crashed: signal: SIGKILL",
		class: "infra",
		stable: "A worker process has crashed: signal: SIGKILL",
	},
	{
		runner: "Jest",
		message: "Error: connect ECONNRESET 127.0.0.1:49152",
		class: "infra",
		stable: "Error: connect ECONNRESET 127.0.0.1:<port>",
	},
	{ runner: "Jest", message: "expected 5, got 7", class: "assertion", stable: "expected 5, got 7" },
	{ runner: "Jest", message: "expected 6, got 7", class: "assertion", stable: "expected 6, got 7" },
	{
		runner: "Vitest",
		message: "AssertionError: expected false to be true",
		class: "assertion",
		stable: "AssertionError: expected false to be true",
	},
	{ runner: "Vitest", message: "Test timed out in 3.2 s.", class: "timeout", stable: "Test timed out in <duration>." },
	{ runner: "Vitest", message: "Test timed out in 9.8 s.", class: "timeout", stable: "Test timed out in <duration>." },
	{
		runner: "Vitest",
		message: "Error: getaddrinfo ENOTFOUND api.example.com",
		class: "infra",
		stable: "Error: getaddrinfo ENOTFOUND api.example.com",
	},
	{
		runner: "Vitest",
		message: "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",
		class: "infra",
		stable: "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",
	},
	{
		runner: "pytest",
		message: "AssertionError: assert 90 == 100",
		class: "assertion",
		stable: "AssertionError: assert 90 == 100",
	},
	{
		runner: "pytest",
		message: "AssertionError: assert 91 == 100",
		class: "assertion",
		stable: "AssertionError: assert 91 == 100",
	},
	{
		runner: "pytest",
		message: "TimeoutError: operation exceeded deadline after 2.0 seconds",
		class: "timeout",
		stable: "TimeoutError: operation exceeded deadline after <duration>",
	},
	{
		runner: "pytest",
		message: "ConnectionResetError: [Errno 104] Connection reset by peer",
		class: "infra",
		stable: "ConnectionResetError: [Errno 104] Connection reset by peer",
	},
	{
		runner: "pytest",
		message: "socket.gaierror: [Errno -2] Name or service not known",
		class: "infra",
		stable: "socket.gaierror: [Errno -2] Name or service not known",
	},
	{
		runner: "pytest",
		message: "OSError: [Errno 28] No space left on device: '/tmp/pytest-of-alice/pytest-312/input.json'",
		class: "infra",
		stable: "OSError: [Errno 28] No space left on device: '<temp>'",
	},
	{
		runner: "pytest",
		message: "OSError: [Errno 28] No space left on device: '/tmp/pytest-of-alice/pytest-489/input.json'",
		class: "infra",
		stable: "OSError: [Errno 28] No space left on device: '<temp>'",
	},
	{
		runner: "JUnit",
		message: "org.opentest4j.AssertionFailedError: expected: <5> but was: <7>",
		class: "assertion",
		stable: "org.opentest4j.AssertionFailedError: expected: <5> but was: <7>",
	},
	{
		runner: "JUnit",
		message: "java.util.concurrent.TimeoutException: execution timed out after 1.2 s",
		class: "timeout",
		stable: "java.util.concurrent.TimeoutException: execution timed out after <duration>",
	},
	{
		runner: "JUnit",
		message: "java.net.ConnectException: Connection refused",
		class: "infra",
		stable: "java.net.ConnectException: Connection refused",
	},
	{
		runner: "JUnit",
		message: "java.lang.OutOfMemoryError: Java heap space",
		class: "infra",
		stable: "java.lang.OutOfMemoryError: Java heap space",
	},
	{
		runner: "Go",
		message: "checkout_test.go:41: expected 90.00, got 100.00",
		class: "assertion",
		stable: "checkout_test.go: expected 90.00, got 100.00",
	},
	{
		runner: "Go",
		message: "checkout_test.go:88: expected 90.00, got 100.00",
		class: "assertion",
		stable: "checkout_test.go: expected 90.00, got 100.00",
	},
	{ runner: "Go", message: "context deadline exceeded", class: "timeout", stable: "context deadline exceeded" },
	{
		runner: "Go",
		message: "dial tcp: lookup api.example.com: no such host",
		class: "infra",
		stable: "dial tcp: lookup api.example.com: no such host",
	},
	{ runner: "Go", message: "signal: killed", class: "infra", stable: "signal: killed" },
	{
		runner: "dependency",
		message: "HTTP 503 Service Unavailable from payments",
		class: "infra",
		stable: "HTTP 503 Service Unavailable from payments",
	},
	{
		runner: "dependency",
		message: "server returned 502 Bad Gateway",
		class: "infra",
		stable: "server returned 502 Bad Gateway",
	},
	{ runner: "dependency", message: "HTTP 504 from inventory", class: "infra", stable: "HTTP 504 from inventory" },
	{ runner: "assertion", message: "expected 503, got 200", class: "assertion", stable: "expected 503, got 200" },
	{
		runner: "assertion",
		message: "unexpected status assertion: expected 200, got 503",
		class: "assertion",
		stable: "unexpected status assertion: expected 200, got 503",
	},
];

describe("failure signatures", () => {
	test.each([
		"AssertionError: expected ticket page to show status closed",
		"AssertionError: expected config.timeout to equal 30",
		'Error: expect(locator).toBeVisible()\nLocator: page.getByText("Account closed")',
	])("keeps assertion syntax from being mistaken for infrastructure or timeout: %s", (message) => {
		expect(normaliseFailure({ message }).class).toBe("assertion");
	});
	test("classifies a network timeout and the leading timeout before a later closed-browser message", () => {
		expect(normaliseFailure({ message: "page.goto: net::ERR_CONNECTION_TIMED_OUT at https://example.com" }).class).toBe(
			"timeout",
		);
		expect(
			normaliseFailure({
				message: "Test timeout of 30000ms exceeded.\nTarget page, context or browser has been closed",
			}).class,
		).toBe("timeout");
		expect(normaliseFailure({ message: "request failed: reason: socket hang up" }).class).toBe("infra");
	});
	test("retains long relative filenames and test names", () => {
		const checkout = normaliseFailure({
			message: "expect(received).toBe(expected)",
			detail: "at run (tests/integration/test_checkout_flow.py:41:2)",
		});
		const refund = normaliseFailure({
			message: "expect(received).toBe(expected)",
			detail: "at run (tests/integration/test_refund_policy.py:41:2)",
		});
		expect(checkout.text).toContain("tests/integration/test_checkout_flow.py");
		expect(signatureHash(checkout)).not.toBe(signatureHash(refund));
		const message = "FAILED test_user_can_login_with_valid_credentials_2 - assert 1 == 2";
		expect(normaliseFailure({ message }).text).toBe(message);
	});
	test.each([
		"Killed",
		"DNS resolution failed for dependency",
		"Browser process exited with signal SIGSEGV",
		"Cannot allocate memory",
		"HTTP 504 Gateway Timeout",
	])("recognizes additional infrastructure failure %s", (message) => {
		expect(normaliseFailure({ message }).class).toBe("infra");
	});
	test("recognizes a bare gRPC DeadlineExceeded cause", () => {
		expect(normaliseFailure({ message: "rpc error: code = DeadlineExceeded" }).class).toBe("timeout");
	});
	test.each(examples)("$runner: $message", ({ message, class: failureClass, stable }) => {
		expect(normaliseFailure({ message })).toEqual({ class: failureClass, text: stable });
	});
	test("volatile fixture pairs share signatures and assertion causes stay distinct", () => {
		for (const [a, b] of [
			[0, 1],
			[2, 3],
			[9, 10],
			[16, 17],
			[25, 26],
			[31, 32],
		] satisfies [number, number][]) {
			const left = examples[a];
			const right = examples[b];
			if (!left || !right) throw new Error("Missing fixture pair");
			expect(signatureHash(normaliseFailure({ message: left.message }))).toBe(
				signatureHash(normaliseFailure({ message: right.message })),
			);
		}
		for (const [a, b] of [
			[6, 7],
			[13, 14],
			[20, 21],
		] satisfies [number, number][]) {
			const left = examples[a];
			const right = examples[b];
			if (!left || !right) throw new Error("Missing fixture pair");
			expect(signatureHash(normaliseFailure({ message: left.message }))).not.toBe(
				signatureHash(normaliseFailure({ message: right.message })),
			);
		}
	});
	test("normalises ISO dates, UUIDs, addresses, long hex/base64 ids and temporary paths", () => {
		const a =
			"Error at 2026-10-11T22:34:56.123Z request 550e8400-e29b-41d4-a716-446655440000 ptr 0x7ffec0123 digest 0123456789abcdefabcdef01 id QWxhZGRpbjpvcGVuIHNlc2FtZQ== file /var/folders/xx/random/T/file.json";
		const b =
			"Error at 2026-10-12T01:22:33.999Z request 12d37002-64f3-4665-88a2-111111111111 ptr 0xabc123456 digest abcdef1234567890abcdef02 id SGVsbG9Xb3JsZEZhaWx1cmVJRA== file /var/folders/yy/other/T/file.json";
		expect(normaliseFailure({ message: a }).text).toBe(
			"Error at <time> request <uuid> ptr <address> digest <id> id <id> file <temp>",
		);
		expect(signatureHash(normaliseFailure({ message: a }))).toBe(signatureHash(normaliseFailure({ message: b })));
	});
	test("removes ANSI, skips empty/error-only lines and collapses whitespace", () => {
		expect(normaliseFailure({ message: "\nError:\n\u001b[31m  expected  5,\tgot 7 \u001b[0m\nignored" }).text).toBe(
			"expected 5, got 7",
		);
		expect(normaliseFailure({ message: "   \n" }).text).toBe("");
	});
	test("appends the first external JS frame, ignoring framework internals", () => {
		const detail =
			"Error: failure\n at assert (/app/node_modules/@playwright/test/index.js:42:17)\n at processTicksAndRejections (node:internal/process/task_queues:95:5)\n at checkout (/app/tests/checkout.spec.ts:41:13)\n at later (/app/src/other.ts:2:3)";
		expect(normaliseFailure({ message: "expected 5, got 7", detail }).text).toBe(
			"expected 5, got 7 | at checkout (/app/tests/checkout.spec.ts)",
		);
		expect(normaliseFailure({ message: "expected 5, got 7", detail: detail.replace(":41:13", ":91:2") })).toEqual(
			normaliseFailure({ message: "expected 5, got 7", detail }),
		);
	});
	test("reads pytest, JUnit and Go stack frames", () => {
		expect(
			normaliseFailure({
				message: "AssertionError",
				detail:
					'  File "/venv/lib/_pytest/runner.py", line 4, in run\n  File "tests/test_cart.py", line 41, in test_total',
			}).text,
		).toBe('AssertionError | File "tests/test_cart.py", in test_total');
		expect(
			normaliseFailure({
				message: "AssertionFailedError",
				detail: "at org.junit.Assert.fail(Assert.java:42)\nat com.acme.CartTest.total(CartTest.java:31)",
			}).text,
		).toBe("AssertionFailedError | at com.acme.CartTest.total(CartTest.java)");
		expect(
			normaliseFailure({
				message: "expected 5",
				detail: "testing.tRunner\n/usr/local/go/src/testing/testing.go:1792 +0x100\n/app/checkout_test.go:41 +0xabc",
			}).text,
		).toBe("expected 5 | /app/checkout_test.go");
	});
	test("an application directory named after a framework remains external", () => {
		expect(
			normaliseFailure({
				message: "failure",
				detail: "at app (/app/testing/application.ts:41:13)\nat later (/app/other.ts:8:2)",
			}).text,
		).toEndWith(" | at app (/app/testing/application.ts)");
	});
	test("keeps distinct external frames, assertion values and long ordinary words", () => {
		expect(normaliseFailure({ message: "toHaveBeenCalledExactlyOnce failed" }).text).toBe(
			"toHaveBeenCalledExactlyOnce failed",
		);
		expect(signatureHash(normaliseFailure({ message: "failure", detail: "at one (a.ts:1:2)" }))).not.toBe(
			signatureHash(normaliseFailure({ message: "failure", detail: "at two (b.ts:3:4)" })),
		);
		expect(normaliseFailure({ message: "expected 12345678901234567890, got 7" }).text).toBe(
			"expected 12345678901234567890, got 7",
		);
	});
	test("normalises Windows temp paths, IPv6 ports and source columns", () => {
		expect(
			normaliseFailure({
				message: "failed C:\\Users\\alice\\AppData\\Local\\Temp\\run-93\\x.json at http://[::1]:34721/src foo.ts:41:13",
			}).text,
		).toBe("failed <temp> at http://[::1]:<port>/src foo.ts");
	});
	test("hashes class and text through canonical contentHash", () => {
		const n = normaliseFailure({ message: "expected 5, got 7" });
		expect(signatureHash(n)).toBe(contentHash({ class: n.class, text: n.text }));
		expect(signatureHash({ ...n, class: "infra" })).not.toBe(signatureHash(n));
	});
	test("bounds and stabilises arbitrary input", () => {
		fc.assert(
			fc.property(textArbitrary, textArbitrary, (message, detail) => {
				const n = normaliseFailure({ message, detail });
				expect(n.text.length).toBeLessThanOrEqual(300);
				expect(n.text).toBe(n.text.trim());
				expect(n.text).not.toMatch(/\s{2}/);
				expect(signatureHash(n)).toMatch(/^[0-9a-f]{12}$/);
			}),
		);
	});
	test("clips the final text including the appended frame", () => {
		expect(normaliseFailure({ message: "x".repeat(400), detail: "at app (app.ts:2:3)" }).text).toHaveLength(300);
		expect(normaliseFailure({ message: "x".repeat(400), detail: "at app (app.ts:2:3)" }).text).toEndWith(
			" | at app (app.ts)",
		);
	});
	test("ordinary assertion numbers are sensitive while durations are not", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 1_000_000 }),
				fc.integer({ min: 1, max: 1_000_000 }),
				(number, duration) => {
					const hash = (message: string) => signatureHash(normaliseFailure({ message }));
					expect(hash(`expected ${number}, got ${number + 1}`)).not.toBe(
						hash(`expected ${number + 2}, got ${number + 1}`),
					);
					expect(hash(`Timeout ${duration}ms exceeded`)).toBe(hash(`Timeout ${duration + 1}ms exceeded`));
				},
			),
		);
	});
});
