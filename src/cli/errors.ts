import { z } from "zod";

/** A user-facing CLI failure. Codes 0–3 belong to gate verdicts; command errors exit 4. */
export class CliError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "CliError";
	}
}

/** Writes a single diagnostic without putting secrets or stack traces in ordinary command output. */
export function printError(error: unknown): void {
	const code = error instanceof CliError ? error.code : "invalid";
	const message =
		error instanceof z.ZodError
			? error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ")
			: error instanceof Error
				? error.message
				: String(error);
	process.stderr.write(`${code}: ${message.replace(/[\r\n]+/g, "; ")}\n`);
}
