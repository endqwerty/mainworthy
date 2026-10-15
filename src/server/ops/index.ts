// OPS: the complete list of operations. Add one here and it exists on HTTP, in the OpenAPI document, in the CLI
// and (when it has an `mcp` description) as an agent tool. There is no other place to add a capability.
import { adminOp } from "./admin.ts";
import { attachmentOp, attachOp } from "./attachments.ts";
import { credentialOp, invitationOp, sessionOp } from "./people.ts";
import {
	checkOp,
	commandOp,
	findOp,
	gateOp,
	getOp,
	historyOp,
	impactOp,
	inboxOp,
	sinceOp,
	timelineOp,
} from "./reads.ts";
import type { AnyOp } from "./registry.ts";
import { trackerOp, trackerStatusOp } from "./trackers.ts";
import { changeOp, claimOp, decideOp, planOp, proposeOp, reportOp } from "./writes.ts";

const list: AnyOp[] = [
	attachOp,
	attachmentOp,
	// produce evidence
	proposeOp,
	reportOp,
	claimOp,
	changeOp,
	trackerOp,
	// request evidence
	planOp,
	// decide
	decideOp,
	// read
	inboxOp,
	getOp,
	findOp,
	impactOp,
	sinceOp,
	gateOp,
	historyOp,
	timelineOp,
	checkOp,
	commandOp,
	trackerStatusOp,
	// administer
	adminOp,
	// sign in as yourself
	sessionOp,
	credentialOp,
	invitationOp,
];

export const OPS: Readonly<Record<string, AnyOp>> = Object.fromEntries(list.map((op) => [op.name, op]));
export const OP_LIST: readonly AnyOp[] = list;
export const MCP_OPS: readonly AnyOp[] = list.filter((op) => op.mcp !== null);
