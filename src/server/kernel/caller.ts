// A caller's credential reference can cross a reader boundary; its resolved authority cannot.
import { z } from "zod";

const hash = z.string().regex(/^[0-9a-f]{64}$/);
export const CallerReference = z.discriminatedUnion("via", [
	z.object({ via: z.literal("token"), hash }),
	z.object({
		via: z.literal("cookie"),
		hash,
		activity: z.number().finite(),
		idleMs: z.number().nonnegative().finite(),
	}),
	z.object({ via: z.literal("local"), actor: z.number().int() }),
]);
export type CallerReference = z.infer<typeof CallerReference>;
