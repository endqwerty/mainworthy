import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { z } from "zod";
import { type Instance, start } from "../app/start.ts";
import { defaultConfig } from "../server/kernel/app.ts";
import { archiveRoutes } from "../surfaces/archive.ts";
import { Client } from "./client.ts";
import { runCli } from "./dispatch.ts";
import { printError } from "./errors.ts";

export const CLI_ENTRY = fileURLToPath(new URL("./main.ts", import.meta.url));
export const RED_XML = fileURLToPath(new URL("../../test/fixtures/cli/red.xml", import.meta.url));
export const COMMIT = "9f3c2ab123456789012345678901234567890123456";
export type CliResult = { stdout: string; stderr: string; code: number };
type CliOptions = { input?: string; env?: Record<string, string>; cwd?: string };
export type Running = {
	instance: Instance;
	directory: string;
	client: Client;
	/** The command as its own process, the executable the way a person starts it: about 0.13 s a start. */
	cli: (argv: string[], options?: CliOptions) => Promise<CliResult>;
	/**
	 * The same argument vector, the same environment, working directory and standard input, run by `runCli` in this
	 * process. It proves what the command does with its input and prints; `cli` proves the executable around it.
	 */
	run: (argv: string[], options?: CliOptions) => Promise<CliResult>;
};

const decoder = new TextDecoder();
let inProcess: Promise<unknown> = Promise.resolve();
/** A command that ran out of its time and has not ended. It cannot be stopped from here, so nothing runs beside it. */
let stuck: string | null = null;
/** What a command wrote after it had ended: the executable would have printed it, and `run` had already answered. */
const late: string[] = [];
/** The process's own write functions, while the watch for late output stands in for them. */
let real: { stdout: typeof process.stdout.write; stderr: typeof process.stderr.write } | null = null;

type Write = typeof process.stdout.write;
/** A write function that keeps what it is given in `into` and, with `on`, passes it on to that stream's own. */
const sink = (into: string[], on?: { stream: NodeJS.WriteStream; write: Write }): Write =>
	((chunk: string | Uint8Array, encoding?: unknown, done?: unknown) => {
		into.push(typeof chunk === "string" ? chunk : decoder.decode(chunk));
		if (on) return Reflect.apply(on.write, on.stream, [chunk, encoding, done]);
		const callback = typeof encoding === "function" ? encoding : done;
		if (typeof callback === "function") callback();
		return true;
	}) as Write;

/** Gives the process its write functions back, and what was written to the watch since the last command ended. */
function endWatch(): string {
	if (real) {
		process.stdout.write = real.stdout;
		process.stderr.write = real.stderr;
		real = null;
	}
	return late.splice(0).join("");
}

/**
 * Fails for output a command wrote after it had ended. A process prints such output before it exits, so a test of
 * the executable sees it; here the command's answer has gone back by then. It is looked for before the next command
 * and when the test's instance closes, which is as long as the watch stands.
 */
function refuseLateOutput(): void {
	const text = endWatch();
	if (text) throw new Error(`a command wrote after it had ended, which run did not return: ${JSON.stringify(text)}`);
}

export type InProcess = { environment: Record<string, string>; cwd: string; input: string; limitMs?: number };

/**
 * Runs `body` with what a child process would have: its environment, directory, standard input and output. They
 * belong to the process, so runs go one at a time; the commands of one test wait for each other, and so would the
 * commands of two instances. The server a test started is in this process too and sees the same environment and
 * directory for the length of a command: it reads its configuration when it starts, and a test whose server must
 * read either while a command runs starts the command with `cli`.
 *
 * It returns what `body` wrote through `process.stdout.write` and `process.stderr.write` until it ended, which is
 * every way the command line writes (a test in `main.test.ts` holds `src/cli` to that). Two things a process gives
 * and this cannot are kept from passing silently. Output written after `body` ended fails the next command or the
 * end of the test (`refuseLateOutput`). A `body` that outlives `limitMs` cannot be stopped as a child is: the run
 * is refused, and so is every run after it until that body has ended.
 */
export function inThisProcess(label: string, body: () => Promise<number>, given: InProcess): Promise<CliResult> {
	const turn = inProcess.then(async (): Promise<CliResult> => {
		if (stuck !== null)
			throw new Error(
				`${stuck} ran out of its time earlier and is still running in this process: nothing runs beside it`,
			);
		refuseLateOutput();
		const out: string[] = [];
		const err: string[] = [];
		const saved = {
			env: { ...process.env },
			cwd: process.cwd(),
			stdout: process.stdout.write,
			stderr: process.stderr.write,
			stdin: Bun.stdin,
		};
		const limitMs = given.limitMs ?? 10_000;
		const overdue = new Error(`${label} did not finish in ${limitMs / 1000} s`);
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			for (const key of Object.keys(process.env)) delete process.env[key];
			Object.assign(process.env, given.environment);
			process.chdir(given.cwd);
			process.stdout.write = sink(out);
			process.stderr.write = sink(err);
			Reflect.set(Bun, "stdin", { text: async () => given.input });
			const limit = new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(overdue), limitMs);
			});
			const running = body();
			let code: number;
			try {
				code = await Promise.race([running, limit]);
			} catch (error) {
				if (error === overdue) {
					stuck = label;
					const ended = (): void => {
						if (stuck === label) stuck = null;
					};
					void running.then(ended, ended);
					throw error;
				}
				printError(error);
				code = 4;
			}
			return { stdout: out.join(""), stderr: err.join(""), code };
		} finally {
			clearTimeout(timer);
			Reflect.set(Bun, "stdin", saved.stdin);
			process.chdir(saved.cwd);
			for (const key of Object.keys(process.env)) delete process.env[key];
			Object.assign(process.env, saved.env);
			// The watch: from here a write is late. It is kept and passed on to where it would have gone.
			real = { stdout: saved.stdout, stderr: saved.stderr };
			process.stdout.write = sink(late, { stream: process.stdout, write: saved.stdout });
			process.stderr.write = sink(late, { stream: process.stderr, write: saved.stderr });
		}
	});
	inProcess = turn.catch(() => undefined);
	return turn;
}

/** `runCli` as `main.ts` runs it, in this process: a thrown error is printed and becomes exit code 4. */
function runInProcess(argv: string[], environment: Record<string, string>, options: CliOptions, directory: string) {
	if ((argv.length === 0 || argv.includes("serve") || argv.includes("mcp")) && !argv.includes("--help"))
		throw new Error("serve and mcp take the process's signals and streams: start them with cli, as a process");
	return inThisProcess(`mainworthy ${argv.join(" ")}`, async () => await runCli(argv, null), {
		environment: { ...environment, ...options.env },
		cwd: options.cwd ?? directory,
		input: options.input ?? "",
	});
}

/** Starts the production HTTP server on port 0 and always closes it and removes its own data directory. */
export async function withInstance<T>(
	run: (running: Running) => Promise<T>,
	options: {
		mode?: "local" | "server";
		owner?: string;
		routes?: ReturnType<typeof archiveRoutes>;
		env?: Record<string, string>;
	} = {},
): Promise<T> {
	const directory = await mkdtemp(join(tmpdir(), "mainworthy-cli-"));
	const config = defaultConfig({
		MAINWORTHY_DATA: directory,
		MAINWORTHY_PORT: "0",
		MAINWORTHY_OWNER: options.owner ?? "robin",
		MAINWORTHY_MODE: options.mode ?? "local",
		...options.env,
	});
	const instance = await start(config, (app, owner) => ({
		ui: null,
		routes: { ...archiveRoutes(app, owner), ...options.routes },
	}));
	const client = new Client({ url: instance.url, token: instance.generatedToken ?? undefined, project: "scratch" });
	const environment = {
		PATH: process.env.PATH ?? "",
		HOME: directory,
		USER: "robin",
		MAINWORTHY_URL: instance.url,
		...(instance.generatedToken ? { MAINWORTHY_TOKEN: instance.generatedToken } : {}),
	};
	let failed = false;
	try {
		return await run({
			instance,
			directory,
			client,
			run: (argv, options = {}) => runInProcess(argv, environment, options, directory),
			async cli(argv, options = {}) {
				const child = Bun.spawn([process.execPath, CLI_ENTRY, ...argv], {
					cwd: options.cwd ?? directory,
					env: { ...environment, ...options.env },
					stdin: "pipe",
					stdout: "pipe",
					stderr: "pipe",
				});
				const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
				try {
					child.stdin.write(options.input ?? "");
					await child.stdin.end();
					const [stdout, stderr, code] = await Promise.all([
						new Response(child.stdout).text(),
						new Response(child.stderr).text(),
						child.exited,
					]);
					return { stdout, stderr, code };
				} finally {
					clearTimeout(timeout);
				}
			},
		});
	} catch (error) {
		failed = true;
		throw error;
	} finally {
		await instance.stop();
		await rm(directory, { recursive: true, force: true });
		// A test that failed keeps its own failure; one that passed must not have left output behind.
		if (failed) endWatch();
		else refuseLateOutput();
	}
}

/** Tests validate subprocess JSON instead of casting an untrusted JSON.parse result. */
export function outputWith<S extends z.ZodType>(schema: S, result: CliResult): z.output<S> {
	const value: unknown = JSON.parse(result.stdout);
	return schema.parse(value);
}
