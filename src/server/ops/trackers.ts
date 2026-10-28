import { REPLIES } from "../../core/replies.ts";
import { TrackerInput, TrackerStatusInput } from "../../core/tracker.ts";
import type { Config } from "../kernel/app.ts";
import { configuredTrackers } from "../trackers/config.ts";
import { previewDefect, queueDefect, trackerStatus } from "../trackers/requests.ts";
import { defineOp } from "./registry.ts";

export const trackerOp = defineOp({
	name: "tracker",
	summary: "Preview or queue a defect from a failed result, or validate an existing issue for linking.",
	input: TrackerInput,
	output: REPLIES.tracker,
	needs: "produce",
	scope: "project",
	effect: "write",
	mcp: null,
	read: { when: (input) => input.do === "preview", run: previewDefect },
	run: queueDefect,
});

export const trackerStatusOp = defineOp({
	name: "tracker-status",
	summary: "Read a tracker request's delivery state and its verified issue reference.",
	input: TrackerStatusInput,
	output: REPLIES["tracker-status"],
	needs: "read",
	scope: "project",
	effect: "read",
	mcp: null,
	run: async (ctx, input) => await trackerStatus(ctx.db, ctx.project.id, input.id),
});

export function trackerForCaller(config: Config, project: string, can: readonly string[]): string | null {
	return can.includes("read") && can.includes("produce")
		? (configuredTrackers(config, project)[0]?.destination ?? null)
		: null;
}
