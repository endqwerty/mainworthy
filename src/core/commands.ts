import { z } from "zod";

/** A client-generated id names one request, including its project identity when stated. */
export const cmd = z
	.string()
	.min(8)
	.max(64)
	.optional()
	.describe("Idempotency key. A retry with the same value writes nothing.");

export const projectCommand = {
	cmd,
	projectIdentity: z
		.string()
		.min(1)
		.max(128)
		.optional()
		.meta({ "x-mcp-hidden": true })
		.describe("Only proceed if the project key still names this identity."),
};
