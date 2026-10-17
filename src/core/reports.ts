import { z } from "zod";

export const ReportsInput = z.object({
	days: z.number().int().min(1).max(366).default(30).describe("UTC calendar days, including today."),
});

/** A share as a percentage with one decimal. Rounding never reads as all or none when it is not. */
export const formatRate = (rate: number | null) => {
	if (rate === null) return "No cases";
	const shown = Math.round(rate * 1000) / 10;
	const kept = rate < 1 ? Math.min(shown, 99.9) : shown;
	return `${(rate > 0 ? Math.max(kept, 0.1) : kept).toFixed(1)}%`;
};
