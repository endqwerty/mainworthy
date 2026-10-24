import { expect, spyOn, test } from "bun:test";
import { snapshots } from "../bench/report-siblings-equivalence.ts";
import { gateOp } from "../src/server/ops/reads.ts";
import expected from "./fixtures/report-storage/sqlite-main.json";

test("batched report storage matches the per-result SQLite writer on main", async () => {
	if (gateOp.effect !== "read") throw new Error("gate must stay a read operation");
	const gate = spyOn(gateOp, "run");
	try {
		expect(await snapshots(true)).toEqual(expected);
		expect(gate).not.toHaveBeenCalled();
	} finally {
		gate.mockRestore();
	}
});
