import { expect, test } from "bun:test";
import { publicLog } from "../bench/log.ts";
import { machine } from "../bench/run.ts";

test("benchmark metadata contains no absolute Mac volume or home paths", () => {
	expect(JSON.stringify(machine(process.cwd()))).not.toMatch(/\/(?:Volumes|Users)\//);
});

test("benchmark logs keep repository paths relative and redact other Mac paths", () => {
	const root = "/Volumes/example/project";
	expect(publicLog(`Reusing dataset: ${root}/.mainworthy/bench/data`, root)).toBe(
		"Reusing dataset: .mainworthy/bench/data",
	);
	expect(publicLog(`Report: ${root}/bench/results.json`, root)).toBe("Report: bench/results.json");
	expect(publicLog("mount /Volumes/example and /Users/runner/scratch/data", root)).toBe(
		"mount <local-path> and <local-path>",
	);
});
