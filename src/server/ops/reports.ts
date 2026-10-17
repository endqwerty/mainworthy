import { ReportsReply } from "../../core/replies.ts";
import { ReportsInput } from "../../core/reports.ts";
import { automatedCaseIds, evidenceReports } from "../evidence/reports.ts";
import { suiteReports } from "../suite/reports.ts";
import { defineOp } from "./registry.ts";

export const reportsOp = defineOp({
	name: "reports",
	summary: "Pass rate by UTC day, current automation and requirement coverage, flaky tests and rerun duration.",
	input: ReportsInput,
	output: ReportsReply,
	needs: "read",
	scope: "project",
	effect: "read",
	mcp: null,
	run(ctx, input) {
		const day = 86_400_000;
		const to = ctx.now + 1;
		const from = Math.floor(ctx.now / day) * day - (input.days - 1) * day;
		return {
			from,
			to,
			...evidenceReports(ctx.db, { project: ctx.project.id, from, to }),
			...suiteReports(ctx.db, ctx.project.id, automatedCaseIds(ctx.db, ctx.project.id)),
		};
	},
});
