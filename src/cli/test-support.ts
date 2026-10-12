import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { z } from "zod";
import { defaultConfig } from "../server/kernel/app.ts";
import { type Instance, start } from "../server/start.ts";
import { archiveRoutes } from "../surfaces/archive.ts";
import { Client } from "./client.ts";

export const CLI_ENTRY = fileURLToPath(new URL("./main.ts", import.meta.url));
export const RED_XML = fileURLToPath(new URL("../../test/fixtures/cli/red.xml", import.meta.url));
export const COMMIT = "9f3c2ab123456789012345678901234567890123456";
export type CliResult = { stdout: string; stderr: string; code: number };
export type Running = {
	instance: Instance;
	directory: string;
	client: Client;
	cli: (argv: string[], options?: { input?: string; env?: Record<string, string>; cwd?: string }) => Promise<CliResult>;
};

/** Starts the production HTTP server on port 0 and always closes it and removes its own data directory. */
export async function withInstance<T>(
	run: (running: Running) => Promise<T>,
	options: { mode?: "local" | "server" } = {},
): Promise<T> {
	const directory = await mkdtemp(join(tmpdir(), "casebook-cli-"));
	const config = defaultConfig({
		CASEBOOK_DATA: directory,
		CASEBOOK_PORT: "0",
		CASEBOOK_OWNER: "daniel",
		CASEBOOK_MODE: options.mode ?? "local",
	});
	const instance = start(config, (app) => ({ ui: null, routes: archiveRoutes(app) }));
	const client = new Client({ url: instance.url, token: instance.generatedToken ?? undefined, project: "scratch" });
	try {
		return await run({
			instance,
			directory,
			client,
			async cli(argv, options = {}) {
				const child = Bun.spawn([process.execPath, CLI_ENTRY, ...argv], {
					cwd: options.cwd ?? directory,
					env: {
						PATH: process.env.PATH ?? "",
						HOME: directory,
						USER: "daniel",
						CASEBOOK_URL: instance.url,
						...(instance.generatedToken ? { CASEBOOK_TOKEN: instance.generatedToken } : {}),
						...options.env,
					},
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
