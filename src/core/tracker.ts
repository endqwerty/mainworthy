import { z } from "zod";
import { projectCommand } from "./commands.ts";

const request = z.string().min(8).max(64);
const result = z.number().int().positive();

export const TrackerInput = z.discriminatedUnion("do", [
	z.strictObject({ do: z.literal("create"), result, ...projectCommand, cmd: request }),
	z.strictObject({ do: z.literal("link"), result, key: z.string().min(1).max(100), ...projectCommand, cmd: request }),
]);
export type TrackerInput = z.infer<typeof TrackerInput>;
export const TrackerStatusInput = z.strictObject({ id: request });

export const TrackerItem = z.object({
	ref: z.string(),
	url: z.string(),
	state: z.enum(["open", "closed"]),
});
export type TrackerItem = z.infer<typeof TrackerItem>;

export const TrackerReceipt = z.object({
	id: request,
	result,
	state: z.enum(["queued", "sending", "complete", "failed"]),
	issue: TrackerItem.nullable(),
	error: z.string().nullable(),
});
export type TrackerReceipt = z.infer<typeof TrackerReceipt>;
