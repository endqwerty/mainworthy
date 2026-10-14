import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { z } from "zod";
import { defaultConfig } from "../server/kernel/app.ts";
import { type Instance, start } from "../server/start.ts";
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

/**
 * Runs `runCli` as `main.ts` does, with what a child would have: its environment, directory, standard input and
 * output. They belong to the process, so runs go one at a time; the commands of one test wait for each other, and
 * so would the commands of two instances.
 */
function runInProcess(argv: string[], environment: Record<string, string>, options: CliOptions, directory: string) {
	if (argv.length === 0 || argv[0] === "serve")
		throw new Error("serve opens the data and takes the process's signals: start it with cli, as a process");
	const turn = inProcess.then(async (): Promise<CliResult> => {
		const out: string[] = [];
		const err: string[] = [];
		const sink = (into: string[]) =>
			((chunk: string | Uint8Array, encoding?: unknown, done?: unknown) => {
				into.push(typeof chunk === "string" ? chunk : decoder.decode(chunk));
				const callback = typeof encoding === "function" ? encoding : done;
				if (typeof callback === "function") callback();
				return true;
			}) as typeof process.stdout.write;
		const saved = {
			env: { ...process.env },
			cwd: process.cwd(),
			stdout: process.stdout.write,
			stderr: process.stderr.write,
			stdin: Bun.stdin,
		};
		const input = options.input ?? "";
		for (const key of Object.keys(process.env)) delete process.env[key];
		Object.assign(process.env, environment, options.env);
		process.chdir(options.cwd ?? directory);
		process.stdout.write = sink(out);
		process.stderr.write = sink(err);
		Reflect.set(Bun, "stdin", { text: async () => input });
		const stuck = new Error(`mainworthy ${argv.join(" ")} did not finish in 10 s`);
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const limit = new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(stuck), 10_000);
			});
			let code: number;
			try {
				code = await Promise.race([runCli(argv, null), limit]);
			} catch (error) {
				if (error === stuck) throw error;
				printError(error);
				code = 4;
			}
			return { stdout: out.join(""), stderr: err.join(""), code };
		} finally {
			clearTimeout(timer);
			process.stdout.write = saved.stdout;
			process.stderr.write = saved.stderr;
			Reflect.set(Bun, "stdin", saved.stdin);
			process.chdir(saved.cwd);
			for (const key of Object.keys(process.env)) delete process.env[key];
			Object.assign(process.env, saved.env);
		}
	});
	inProcess = turn.catch(() => undefined);
	return turn;
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
	const instance = start(config, (app, owner) => ({
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
	} finally {
		await instance.stop();
		await rm(directory, { recursive: true, force: true });
	}
}

/** Tests validate subprocess JSON instead of casting an untrusted JSON.parse result. */
export function outputWith<S extends z.ZodType>(schema: S, result: CliResult): z.output<S> {
	const value: unknown = JSON.parse(result.stdout);
	return schema.parse(value);
}
