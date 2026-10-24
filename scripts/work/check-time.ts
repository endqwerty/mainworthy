// Is a change slower than its base? The check's tests run at the edge of their time limit, so one run says nothing
// about a change: AGENTS.md asks for the base and the head alternately, twice each, and a judgment of whether the
// head is slower by more than the spread between runs of one revision. This does that, and starts by comparing the
// two trees: a rebase that left the tree as it was verified needs no round at all.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { otherTestRuns } from "./processes.ts";
import { read, run } from "./run.ts";
import { make, remove } from "./scratch.ts";

export const sameTree = async (a: string, b: string, repo?: string): Promise<boolean> => {
	const tree = (rev: string): Promise<string> => read(["git", "rev-parse", `${rev}^{tree}`], repo ? { cwd: repo } : {});
	return (await tree(a)) === (await tree(b));
};

/** The seconds the check reports for its tests (or, with no separate tests line, in all). */
export function checkSeconds(output: string): number | null {
	const line = /^tests\s+([\d.]+) s\s*$/m.exec(output) ?? /^total\s+([\d.]+) s\s*$/m.exec(output);
	return line?.[1] ? Number(line[1]) : null;
}

const mean = (values: readonly number[]): number => values.reduce((sum, v) => sum + v, 0) / values.length;
const spread = (values: readonly number[]): number => Math.max(...values) - Math.min(...values);

export type Verdict = { baseMean: number; headMean: number; difference: number; spread: number; slower: boolean };

/** The head is slower when it is so by more than the widest spread between runs of one revision. */
export function judge(base: readonly number[], head: readonly number[]): Verdict {
	const widest = Math.max(spread(base), spread(head));
	const difference = mean(head) - mean(base);
	return { baseMean: mean(base), headMean: mean(head), difference, spread: widest, slower: difference > widest };
}

export function describe(verdict: Verdict, base: readonly number[], head: readonly number[]): string {
	const list = (values: readonly number[]): string => values.map((v) => `${v.toFixed(1)}`).join(", ");
	return [
		`base: ${list(base)} s (mean ${verdict.baseMean.toFixed(1)})`,
		`head: ${list(head)} s (mean ${verdict.headMean.toFixed(1)})`,
		`head minus base ${verdict.difference.toFixed(1)} s; the widest spread between runs of one revision is ${verdict.spread.toFixed(1)} s`,
		verdict.slower ? "SLOWER: by more than the spread." : "not slower than the spread between runs.",
	].join("\n");
}

export type Options = {
	rounds: number;
	command: string[];
	install: boolean;
	/** The repository the revisions are in; the current directory when absent. */
	repo?: string;
	/** Whether another test run is going. The process table, when absent. */
	busy?: () => Promise<boolean>;
};

/** Exports a revision under a scratch directory, installs it, runs the check and returns the seconds it reports. */
async function timeOne(rev: string, options: Options, log: (line: string) => void): Promise<number> {
	const directory = make("check-time");
	try {
		const archive = join(directory, "archive.tar");
		const tree = join(directory, "tree");
		mkdirSync(tree);
		await read(
			["git", "archive", "--format=tar", `--output=${archive}`, rev],
			options.repo ? { cwd: options.repo } : {},
		);
		await read(["tar", "-x", "-C", tree, "-f", archive]);
		if (options.install) await read(["bun", "install", "--frozen-lockfile"], { cwd: tree });
		log(`running ${options.command.join(" ")} on ${rev}`);
		const done = await run(options.command, { cwd: tree });
		// The check itself fails on a time over its limit and still prints the time; any other failure is no timing.
		if (done.status !== 0 && !done.out.includes("OVER BUDGET"))
			throw new Error(
				`${rev}: ${options.command.join(" ")} failed (exit ${done.status}):\n${(done.out + done.err).slice(-600)}`,
			);
		const seconds = checkSeconds(done.out);
		if (seconds === null)
			throw new Error(`${rev}: the check printed no time (exit ${done.status}):\n${(done.out + done.err).slice(-600)}`);
		return seconds;
	} finally {
		remove(directory);
	}
}

export async function compare(
	base: string,
	head: string,
	options: Options,
	log: (line: string) => void,
): Promise<string> {
	if (!Number.isInteger(options.rounds) || options.rounds < 1)
		throw new Error("--rounds is a whole number of at least 1");
	if (await sameTree(base, head, options.repo))
		return `${base} and ${head} have the same tree: nothing to time, and a verdict on one holds for the other.`;
	if (await (options.busy ?? otherTestRuns)())
		throw new Error(
			"another test run is going, and a time taken beside it says nothing. Run check-time again when the machine is idle.",
		);
	const times: Record<"base" | "head", number[]> = { base: [], head: [] };
	for (let round = 0; round < options.rounds; round++) {
		times.base.push(await timeOne(base, options, log));
		times.head.push(await timeOne(head, options, log));
	}
	return describe(judge(times.base, times.head), times.base, times.head);
}
