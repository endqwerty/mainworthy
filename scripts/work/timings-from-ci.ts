import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SaxesParser } from "saxes";
import { z } from "zod";
import { newestAttempt, outcomePath, readOutcome, readTimings, TIMINGS, writeTimings } from "../check-plan.ts";
import { read } from "./run.ts";
import { make, remove } from "./scratch.ts";

/** Bun's outer testsuite is the file's elapsed time; nested describe suites and testcases overlap it. */
function fileTimes(xml: string): Map<string, number> {
	const files = new Map<string, number>();
	const parser = new SaxesParser();
	let depth = 0;
	parser.on("doctype", () => {
		throw new Error("JUnit document types are not supported");
	});
	parser.on("opentag", (tag) => {
		depth++;
		if (depth === 1 && tag.name !== "testsuites") throw new Error("Expected Bun's JUnit testsuites root");
		if (depth !== 2 || tag.name !== "testsuite") return;
		const file = tag.attributes.file;
		const time = tag.attributes.time;
		if (
			typeof file !== "string" ||
			!/^(src|test)\/(?:[^/]+\/)*[^/]+\.test\.tsx?$/.test(file) ||
			file.split("/").some((part) => part === "." || part === "..")
		)
			throw new Error("A JUnit file suite must name a repository test file");
		if (typeof time !== "string" || time.trim() === "" || !Number.isFinite(Number(time)) || Number(time) < 0)
			throw new Error(`Invalid JUnit duration for ${file}`);
		if (files.has(file)) throw new Error(`Duplicate JUnit file: ${file}`);
		files.set(file, Number(time) * 1000);
	});
	parser.on("closetag", () => {
		depth--;
	});
	parser.write(xml).close();
	if (files.size === 0) throw new Error("JUnit report has no file durations");
	return files;
}

/** Imports downloaded artifacts, keeping absent files and the old weights' typical scale. */
export function timingsFromReports(root: string, directory: string): { files: number; scale: number } {
	const shards = new Set(
		readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
			const name = /^results-(tests(?:-[1-9]\d*)?|performance)-attempt-[1-9]\d*$/.exec(entry.name)?.[1];
			return entry.isDirectory() && name ? [name] : [];
		}),
	);
	if (shards.size === 0) throw new Error("No CI test report artifacts found");
	const observed = new Map<string, number>();
	for (const shard of [...shards].sort()) {
		const report = join(newestAttempt(directory, shard).directory, `${shard}.xml`);
		if (readOutcome(outcomePath(report))?.exit !== 0) throw new Error(`${shard}'s newest report did not pass`);
		for (const [file, ms] of fileTimes(readFileSync(report, "utf8"))) {
			if (observed.has(file)) throw new Error(`Duplicate JUnit file across shards: ${file}`);
			observed.set(file, ms);
		}
	}
	const path = join(root, TIMINGS);
	const files = readTimings(JSON.parse(readFileSync(path, "utf8")));
	const ratios = [...observed]
		.flatMap(([file, ms]) => {
			const old = files[file];
			return old !== undefined && old > 0 && ms > 0 ? [old / ms] : [];
		})
		.sort((a, b) => a - b);
	const middle = Math.floor(ratios.length / 2);
	const upper = ratios[middle] ?? 1;
	let scale = ratios.length > 0 && ratios.length % 2 === 0 ? ((ratios[middle - 1] ?? upper) + upper) / 2 : upper;
	// Already imported weights share a scale within integer rounding. Keep that scale on a repeated refresh.
	let lowerScale = 0;
	let upperScale = Number.POSITIVE_INFINITY;
	for (const [file, ms] of observed) {
		const old = files[file];
		if (old === undefined) continue;
		if (ms === 0) {
			if (old !== 0) upperScale = 0;
		} else {
			lowerScale = Math.max(lowerScale, (old - 0.5) / ms);
			upperScale = Math.min(upperScale, (old + 0.5) / ms);
		}
	}
	if (ratios.length > 0 && Number.isFinite(upperScale) && lowerScale < upperScale)
		scale = lowerScale + (upperScale - lowerScale) / 2;
	for (const [file, ms] of observed) files[file] = ms * scale;
	writeTimings(path, files);
	return { files: observed.size, scale };
}

/** Downloads one completed passing run's reports; artifacts and retries follow the gate's conventions. */
export async function timingsFromCi(root: string, runId: string): Promise<string> {
	if (!/^[1-9]\d*$/.test(runId)) throw new Error("A CI run id is a positive integer");
	const run = z
		.object({ status: z.literal("completed"), conclusion: z.literal("success") })
		.parse(JSON.parse(await read(["gh", "run", "view", runId, "--json", "status,conclusion"], { cwd: root })));
	const scratch = make("ci-timings");
	try {
		await read(["gh", "run", "download", runId, "--pattern", "results-*", "--dir", scratch], { cwd: root });
		const imported = timingsFromReports(root, scratch);
		return `${TIMINGS}: refreshed ${imported.files} files from ${run.conclusion} CI run ${runId} (CI ms × ${imported.scale.toFixed(6)}); absent files kept`;
	} finally {
		remove(scratch);
	}
}
