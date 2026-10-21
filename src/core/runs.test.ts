import { expect, test } from "bun:test";
import { emptyTally, explainVerdict, reasonBesideShards, type ShardWait, shardWaitTitle } from "./runs.ts";

const tests: ShardWait = { job: "tests", env: "", missing: [4, 5, 6], of: 6 };
const lint: ShardWait = { job: "lint", env: "linux", missing: [2], of: 2 };

test("a screen that draws the shards reads their count in the gate's reason, whatever the verdict", () => {
	const passed = { ...emptyTally(), pass: 3 };
	const cases = [
		{ facts: { tally: passed, waiting: [tests] }, says: "pending: waiting for 3 shards" },
		{ facts: { tally: passed, waiting: [tests, lint] }, says: "pending: waiting for 4 shards" },
		{ facts: { tally: passed, waiting: [lint] }, says: "pending: waiting for 1 shard" },
		{
			facts: { tally: { ...passed, attributed: 2 }, waiting: [tests] },
			says: "failed: 2 failures attributed to this target; still waiting for 3 shards",
		},
		{
			facts: { tally: { ...passed, unexplained: 1 }, blocking: 1, waiting: [lint] },
			says: "blocked: 1 failure unexplained, 1 question open; still waiting for 1 shard",
		},
		{ facts: { tally: passed, waiting: [] }, says: "passed: 3 results proven" },
	];
	for (const { facts, says } of cases) {
		const full = { blocking: 0, outstanding: 0, expired: false, ...facts };
		expect(reasonBesideShards(explainVerdict(full), facts.waiting)).toBe(says);
	}
	// The server adds the quarantined failures after the verdict's sentence.
	const quarantined = `${explainVerdict({ tally: passed, blocking: 0, outstanding: 0, expired: false, waiting: [tests] })}; 1 quarantined failure recorded, not blocking`;
	expect(reasonBesideShards(quarantined, [tests])).toBe(
		"pending: waiting for 3 shards; 1 quarantined failure recorded, not blocking",
	);
	// A reason that names other shards than the ones given is left whole rather than miscounted.
	expect(reasonBesideShards("pending: waiting for shard 2 of 2 of job lint in linux", [tests])).toBe(
		"pending: waiting for shard 2 of 2 of job lint in linux",
	);
});

test("a job's shards spelled out say which reported and which the gate waits for", () => {
	expect(shardWaitTitle(tests)).toBe("Job tests: 3 of 6 shards reported (1, 2 and 3). Waiting for shards 4, 5 and 6.");
	expect(shardWaitTitle(lint)).toBe("Job lint in linux: 1 of 2 shards reported (1). Waiting for shard 2.");
	expect(shardWaitTitle({ job: "", env: "", missing: [1, 3], of: 3 })).toBe(
		"Job (unnamed): 1 of 3 shards reported (2). Waiting for shards 1 and 3.",
	);
});
