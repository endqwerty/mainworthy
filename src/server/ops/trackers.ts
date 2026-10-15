import { REPLIES } from "../../core/replies.ts";
import { TrackerInput, TrackerStatusInput } from "../../core/tracker.ts";
import { queueDefect, trackerStatus } from "../trackers/requests.ts";
import { defineOp } from "./registry.ts";

export const trackerOp = defineOp({
	name: "tracker",
	summary: "Queue a defect from a failed result: create a tracker issue or validate an existing issue for linking.",
	input: TrackerInput,
	output: REPLIES.tracker,
	needs: "produce",
	scope: "project",
	effect: "write",
	mcp: null,
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
	run: (ctx, input) => trackerStatus(ctx.db, ctx.project.id, input.id),
});
