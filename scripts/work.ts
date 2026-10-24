// The commands an agent working on this repository runs, in one place, so none of them is typed out of a document.
//
//   bun scripts/work.ts scratch new <name>            a directory under ~/.cache for this task's scratch files
//   bun scripts/work.ts scratch rm <directory>        deletes a directory `scratch new` made, and nothing else
//   bun scripts/work.ts stop-server                   stops the servers and PostgreSQL running from this checkout
//   bun scripts/work.ts board start|todo|done <n>     moves an issue's or a pull request's card on the board
//   bun scripts/work.ts board check                   says which of the board's ids in the code no longer fit
//   bun scripts/work.ts pr-body <n>                   checks a pull request's description, milestone and fragment PR references
//   bun scripts/work.ts sync-branch                   after the owner merged: moves the branch onto origin/main, if nothing on it is unmerged
//   bun scripts/work.ts release                       gives back the worktree's disk (node_modules and the rest); refuses while it is in use
//   bun scripts/work.ts check-time <base> <head> [--rounds=2] [--no-install] [-- <command...>]
//                                                     times the check on both, alternately, and judges the spread
//   bun scripts/work.ts timings-from-ci <run-id>       refreshes test weights from a passing CI run's JUnit reports
//   bun scripts/work.ts ci [<pr> | <commit>] [--wait=<s>]  the gate on the deployed Mainworthy and what failed (default: this branch's pull request)
//   bun scripts/work.ts ci-policy                     with the owner token: CI failures are answered "needs a fix" by rule, never queued
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { check as checkBoard, isMove, move } from "./work/board.ts";
import { compare } from "./work/check-time.ts";
import type { Call, Target } from "./work/ci.ts";
import { stopServers } from "./work/processes.ts";
import { gather, problems } from "./work/pull-request.ts";
import { release } from "./work/release.ts";
import { read } from "./work/run.ts";
import { make, remove } from "./work/scratch.ts";
import { syncBranch } from "./work/sync-branch.ts";

const ROOT = realpathSync(join(import.meta.dir, ".."));
const USAGE = `usage: bun scripts/work.ts <command>
  scratch new <name> | scratch rm <directory>
  stop-server
  board start|todo|done <issue or pull request number> | board check
  pr-body <pull request number>
  sync-branch
  release
  timings-from-ci <run-id>
  ci [<pull request number> | <commit>] [--wait=<seconds>]
  ci-policy
  check-time <base> <head> [--rounds=2] [--no-install] [-- <command...>]`;

const fail = (message: string, code = 1): never => {
	console.error(message);
	return process.exit(code);
};

const flag = (args: readonly string[], name: string): string | undefined =>
	args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);

/** The deployed Mainworthy, unless MAINWORTHY_URL and MAINWORTHY_PROJECT name another; the token from the
 * environment, else, when `fallback` names one, from that file. */
// The client and the CI module are loaded only by the commands that use them: the `description` job runs
// `pr-body` with no dependencies installed.
async function instance(fallback?: string): Promise<Call> {
	const { Client } = await import("../src/cli/client.ts");
	const { INSTANCE } = await import("./work/ci.ts");
	const file = process.env.MAINWORTHY_TOKEN_FILE || fallback;
	const token = process.env.MAINWORTHY_TOKEN || (file && existsSync(file) ? readFileSync(file, "utf8").trim() : "");
	if (!token) throw new Error(`no token: set MAINWORTHY_TOKEN${file ? `, or keep a read token in ${file}` : ""}`);
	const client = new Client({
		url: process.env.MAINWORTHY_URL || INSTANCE.url,
		project: process.env.MAINWORTHY_PROJECT || INSTANCE.project,
		token,
	});
	return (op, input) => client.call(op as never, input as never);
}

/** A pull request by its number, a commit by anything git resolves, or the branch's own pull request. */
async function ciTarget(argument: string | undefined): Promise<Target> {
	if (argument && /^[1-9]\d*$/.test(argument)) return { change: `pr:${argument}` };
	if (argument) return { commit: await read(["git", "rev-parse", "--verify", `${argument}^{commit}`], { cwd: ROOT }) };
	const number = await read(["gh", "pr", "view", "--json", "number", "--jq", ".number"], { cwd: ROOT }).catch(() => {
		throw new Error("this branch has no pull request: name one by its number, or a commit");
	});
	return { change: `pr:${number}` };
}

async function main(args: string[]): Promise<void> {
	const [command, ...rest] = args;
	switch (command) {
		case "scratch": {
			const [action, argument] = rest;
			if (action === "new" && argument) console.log(make(argument));
			else if (action === "rm" && argument) console.log(`removed ${remove(argument)}`);
			else fail(USAGE, 4);
			return;
		}
		case "stop-server": {
			const stopped = await stopServers(ROOT);
			console.log(
				stopped.length
					? `stopped ${stopped.length} server(s) running from ${ROOT}: ${stopped.join(" ")}`
					: `no server runs from ${ROOT}`,
			);
			return;
		}
		case "board": {
			const [action, target] = rest;
			if (action === "check") {
				const drift = await checkBoard();
				if (drift.length > 0)
					fail(`the ids in scripts/work/board.ts no longer fit the board:\n- ${drift.join("\n- ")}`);
				console.log("the board's ids are the ones in scripts/work/board.ts");
			} else if (action && isMove(action) && target) console.log(await move(target, action));
			else fail(USAGE, 4);
			return;
		}
		case "pr-body": {
			const number = Number(rest[0]);
			if (!Number.isInteger(number) || number < 1) return fail(USAGE, 4);
			const found = problems(await gather(number));
			if (found.length > 0) fail(`pull request #${number}:\n- ${found.join("\n- ")}`);
			console.log(`pull request #${number}: closing words, linked issues, milestone and fragment PR references agree`);
			return;
		}
		case "sync-branch":
			console.log(await syncBranch(ROOT));
			return;
		case "release":
			console.log(await release(ROOT));
			return;
		case "timings-from-ci": {
			const [runId] = rest;
			if (rest.length !== 1 || !runId || !/^[1-9]\d*$/.test(runId)) return fail(USAGE, 4);
			const { timingsFromCi } = await import("./work/timings-from-ci.ts");
			console.log(await timingsFromCi(ROOT, runId));
			return;
		}
		case "ci": {
			const wait = Number(flag(rest, "wait") ?? 0);
			const positional = rest.filter((arg) => !arg.startsWith("--"));
			if (!Number.isFinite(wait) || wait < 0 || positional.length > 1) return fail(USAGE, 4);
			// 0 to 3 are the gate's verdicts, so a command that could not read one exits 4.
			const { readCi, TOKEN_FILE } = await import("./work/ci.ts");
			const read = await ciTarget(positional[0])
				.then(async (target) => readCi(await instance(TOKEN_FILE), target, { wait }))
				.catch((error: unknown) => fail(error instanceof Error ? error.message : String(error), 4));
			console.log(read.text);
			process.exit(read.exit);
			return;
		}
		case "ci-policy": {
			if (rest.length > 0) return fail(USAGE, 4);
			const { ciPolicy, INSTANCE } = await import("./work/ci.ts");
			console.log(await ciPolicy(await instance(), process.env.MAINWORTHY_PROJECT || INSTANCE.project));
			return;
		}
		case "check-time": {
			const split = rest.indexOf("--");
			const own = split < 0 ? rest : rest.slice(0, split);
			const [base, head] = own.filter((arg) => !arg.startsWith("--"));
			if (!base || !head) return fail(USAGE, 4);
			const custom = split < 0 ? [] : rest.slice(split + 1);
			const options = {
				rounds: Number(flag(own, "rounds") ?? 2),
				install: !own.includes("--no-install"),
				command: custom.length ? custom : ["bun", "run", "check"],
			};
			console.log(await compare(base, head, options, (line) => console.error(line)));
			return;
		}
		default:
			fail(USAGE, 4);
	}
}

await main(process.argv.slice(2)).catch((error: unknown) =>
	fail(error instanceof Error ? error.message : String(error), 2),
);
