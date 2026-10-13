import { expect, test } from "bun:test";
import { KINDS } from "./kinds.ts";
import { stakes, urgent, waiting, waitingPhrase } from "./stakes.ts";

test("only a failure is urgent, and the count says how many there are and how many questions can wait", () => {
	expect(KINDS.filter(urgent)).toEqual(["failure"]);
	expect(waiting({ open: 105, failure: 1, map: 104 })).toEqual({ failures: 1, canWait: 104 });
	expect(waitingPhrase({ open: 105, failure: 1, map: 104 })).toBe("1 failure to explain · 104 can wait");
	expect(waitingPhrase({ open: 3, failure: 3 })).toBe("3 failures to explain");
	expect(waitingPhrase({ open: 2, map: 1, finding: 1 })).toBe("2 can wait");
	expect(waitingPhrase({ open: 0 })).toBe("nothing needs an answer");
	expect(waitingPhrase({})).toBe("nothing needs an answer");
});

test("every kind of question says what leaving it costs, and only a failure blocks anything", () => {
	const none = new Set<string>();
	for (const kind of KINDS) {
		const text = stakes({ kind, blocks: [], facts: none });
		expect(text.startsWith("Blocks nothing.")).toBe(!urgent(kind));
		expect(text.endsWith(".")).toBe(true);
	}
	const failure = (blocks: string[], facts: string[] = []) =>
		stakes({ kind: "failure", blocks, facts: new Set(facts) });
	const held = "While this is open, no gate that counts the unexplained failure passes.";
	expect(failure(["R-83"], ["scope:change"])).toBe(`Listed as blocking R-83. ${held}`);
	// Many runs are named by the first three and a count.
	expect(failure(["R-1", "R-2", "R-3", "R-4", "R-5"])).toBe(`Listed as blocking R-1, R-2, R-3 and 2 more. ${held}`);
	// A failure that names no run says the same of any gate that counts it, whatever its scope, and denies none.
	for (const scope of ["scope:change", "scope:trunk", "scope:run"]) expect(failure([], [scope])).toBe(held);
	// No sentence says how a block ends without an answer, or that a named run is blocked now: a question
	// cannot tell either (the guide does).
	for (const text of [failure(["R-1"]), failure([])]) expect(text).not.toMatch(/until|reads blocked|newer|passing/);
	const adopt = (facts: string[]) => stakes({ kind: "adopt", blocks: [], facts: new Set(facts) });
	expect(adopt(["policy"])).toContain("the policy stays as it is");
	expect(adopt(["conflict"])).toContain("waits for its author");
});
