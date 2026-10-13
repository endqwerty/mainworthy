// Not for merging. Issue #92: one test that fails on purpose, to see the gate job block on the deployed
// Mainworthy and pass on a re-run once the failure is answered there.
import { expect, test } from "bun:test";

test("switch-on probe: this test fails on purpose", () => {
	expect("the failure is answered on the instance").toBe("issue #92");
});
