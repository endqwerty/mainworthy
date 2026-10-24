import { HandoffInput, HandoffStatusInput } from "../../core/handoff.ts";
import { REPLIES } from "../../core/replies.ts";
import { handoffStatus, queueHandoff } from "../handoffs/handoffs.ts";
import { defineOp } from "./registry.ts";

export const handoffOp = defineOp({
	name: "handoff",
	summary: "Hand a failure question to the coding agent this instance is configured to start, with its evidence.",
	input: HandoffInput,
	output: REPLIES.handoff,
	needs: "answer",
	scope: "project",
	effect: "write",
	mcp: null,
	run: queueHandoff,
});

export const handoffStatusOp = defineOp({
	name: "handoff-status",
	summary: "Read whether a failure question's latest hand-off to an agent was sent, or why it failed.",
	input: HandoffStatusInput,
	output: REPLIES["handoff-status"],
	needs: "read",
	scope: "project",
	effect: "read",
	mcp: null,
	run: async (ctx, input) => await handoffStatus(ctx, input.question),
});
