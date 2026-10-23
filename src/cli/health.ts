import { z } from "zod";

/** A live startup listener, which has not admitted any application requests yet. */
export const UpgradingHealth = z.object({
	ok: z.literal(false),
	state: z.literal("upgrading"),
	apiVersion: z.number().int().positive(),
});
