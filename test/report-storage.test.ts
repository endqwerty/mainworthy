import { expect, test } from "bun:test";
import { snapshots } from "../bench/report-siblings-equivalence.ts";
import expected from "./fixtures/report-storage/sqlite-main.json";

test("batched report storage matches the per-result SQLite writer on main", async () => {
	expect(await snapshots(true)).toEqual(expected);
});
