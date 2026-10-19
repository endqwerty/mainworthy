import { printError } from "./errors.ts";

/** A server address for output, without its username or password. Requests keep the original address. */
export function displayUrl(address: string): string {
	const url = new URL(address);
	url.username = "";
	url.password = "";
	return address.endsWith("/") ? url.href : url.href.replace(/\/$/, "");
}

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
		if (error.code === "EPIPE") return;
		printError(error);
		process.exit(4);
	});
}
