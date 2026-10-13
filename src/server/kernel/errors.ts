import type { ErrorCode } from "../../core/api.ts";

// The codes are written once, in `core/api.ts`, with the status of each. The server names the type from here.
export type { ErrorCode };

/**
 * The one error type an operation throws. Throwing inside a write rolls the whole command back, so a failed
 * operation leaves no rows behind.
 */
export class OpError extends Error {
	readonly code: ErrorCode;
	readonly details: Record<string, unknown> | undefined;

	constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
		super(message);
		this.name = "OpError";
		this.code = code;
		this.details = details;
	}
}

/**
 * All a caller is told of a failure that is not an `OpError`. Such a failure's own text can name a table, a path
 * or a statement, so it goes to the server's log and nowhere else.
 */
export const INTERNAL_ERROR = "internal error";

export const invalid = (message: string, details?: Record<string, unknown>) => new OpError("invalid", message, details);
export const notFound = (what: string) => new OpError("not_found", `${what} not found`);
/**
 * What a caller is told of a project it cannot use. One that does not exist and one the caller holds no grant on
 * get this, word for word: a reply that told them apart would confirm a project's key to any token. The sentence
 * names both, so somebody whose token is for another project is not sent looking for a typing mistake.
 */
export const noProject = (key: string | null) => new OpError("not_found", `no project named ${key}, or no grant on it`);
export const forbidden = (message: string, details?: Record<string, unknown>) =>
	new OpError("forbidden", message, details);
export const conflict = (message: string, details?: Record<string, unknown>) =>
	new OpError("conflict", message, details);
