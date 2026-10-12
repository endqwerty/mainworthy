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
