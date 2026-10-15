import { AuditInput } from "../../core/audit.ts";
import { REPLIES } from "../../core/replies.ts";
import { exportAudit } from "../transfer/audit.ts";
import { defineOp } from "./registry.ts";

export const auditOp = defineOp({
	name: "audit",
	summary:
		"Export a project's retained decisions, answers, policy changes and case versions as a verifiable audit file.",
	input: AuditInput,
	output: REPLIES.audit,
	needs: "admin",
	scope: "project",
	effect: "read",
	mcp: null,
	run: exportAudit,
});
