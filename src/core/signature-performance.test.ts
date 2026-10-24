import { describe, test } from "bun:test";
import { hostileInputBudget } from "../../scripts/budget.ts";
import { normaliseFailure } from "./signature.ts";

describe("untrusted failure text", () => {
	// A report is untrusted input and may carry thousands of failures. None of them may cost more than a moment,
	// whatever it contains: the server applies a report on the thread that also answers reads.
	const hostile: [string, { message: string; detail?: string }][] = [
		["a keyword then 20,000 spaces", { message: `status${" ".repeat(20_000)}x` }],
		["server returned then 20,000 tabs", { message: `server returned${"\t".repeat(20_000)}ok` }],
		["a frame with 20,000 spaces", { message: "boom", detail: `at a${" ".repeat(20_000)}b` }],
		["a frame of repeated Windows paths", { message: "boom", detail: `at ${"c:\\".repeat(20_000)}` }],
		["20,000 short stack lines", { message: "boom", detail: "    at node_modules/x.js:1:1\n".repeat(20_000) }],
		["one unbroken megabyte", { message: "x".repeat(1_000_000), detail: "y".repeat(1_000_000) }],
		["line then digits, repeated", { message: "boom", detail: `File "a.py", ${"line 1 ".repeat(8_000)}` }],
	];
	for (const [name, input] of hostile) {
		test(`records normalization time for ${name}`, () => {
			normaliseFailure(input); // warm
			const started = performance.now();
			for (let i = 0; i < 20; i++) normaliseFailure(input);
			hostileInputBudget(`failure normalization ${name}: mean of 20 runs`, (performance.now() - started) / 20, 5, "ms");
		});
	}
});

test("records normalization time for a very long unbroken failure line", () => {
	const start = performance.now();
	normaliseFailure({ message: `expected <div>${"x".repeat(100_000)}</div>` });
	hostileInputBudget(
		"failure normalization 100000-character unbroken line: elapsed",
		performance.now() - start,
		100,
		"ms",
	);
});
