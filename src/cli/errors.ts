import { z } from "zod";
import { escapeControls } from "../core/text.ts";

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

/** Use a rendered input label and filesystem code instead of a runtime's raw path message. */
export function fileReadError(label: string, error: unknown): CliError {
	const code =
		typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
			? error.code
			: "READ_ERROR";
	return new CliError("invalid", `${label}: ${code}`);
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
	process.stderr.write(`${escapeControls(`${code}: ${message}`.replace(/[\r\n]+/g, "; "))}\n`);
}
