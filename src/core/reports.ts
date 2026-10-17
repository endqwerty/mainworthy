import { z } from "zod";

export const ReportsInput = z.object({
	days: z.number().int().min(1).max(366).default(30).describe("UTC calendar days, including today."),
});
