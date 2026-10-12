import { printError } from "./errors.ts";

/** The CLI's human output. MCP never calls these functions while serving protocol messages. */
export function line(text: string): void {
	process.stdout.write(`${text}\n`);
}

/** Generated commands use pretty JSON unless the caller explicitly asks for compact output. */
export function printJson(value: unknown, compact: boolean): void {
	line(JSON.stringify(value, null, compact ? undefined : 2));
}

export function warning(text: string): void {
	process.stderr.write(`${text}\n`);
}

/** A pipe consumer may finish before us. Closing stdout is quiet; other output errors are command failures. */
export function installOutputHandlers(): void {
	process.stdout.on("error", (error: NodeJS.ErrnoException) => {
		if (error.code === "EPIPE") process.exit(typeof process.exitCode === "number" ? process.exitCode : 0);
		printError(error);
		process.exit(4);
	});
}
