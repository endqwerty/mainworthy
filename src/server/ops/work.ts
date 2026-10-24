import { WorkInput, type WorkReply } from "../../core/ops.ts";
import { REPLIES } from "../../core/replies.ts";
import { workHeldByOther } from "../../core/runs.ts";
import { actorLabel } from "../identity/identity.ts";
import type { Ctx } from "../kernel/ctx.ts";
import { conflict, invalid } from "../kernel/errors.ts";
import { leaseOf, mustRun, releaseWork, runRef, type SlotLease, takeWork, workSlot } from "../runs/runs.ts";
import { caseById, caseRef } from "../suite/suite.ts";
import { defineOp } from "./registry.ts";

async function busy(ctx: Ctx, lease: SlotLease): Promise<never> {
	const actor = (await actorLabel(ctx.db, lease.actor)).name;
	throw conflict(`Slot ${lease.slot} is held by ${actor} until ${new Date(lease.until).toISOString()}`, {
		actor,
		until: lease.until,
	});
}
export const workOp = defineOp({
	name: "work",
	summary: "Take a named slot or the next free unfinished slot for a lease, renew it, or give it back.",
	input: WorkInput,
	output: REPLIES.work,
	needs: "record",
	scope: "project",
	effect: "write",
	mcp: "Take next slot with run; renew with slot. Report or give-back releases.",
	async run(ctx, input): Promise<WorkReply> {
		const run = await mustRun(ctx.db, ctx.project.id, input.run);
		if (input.do === "give-back") {
			if (input.slot === undefined) throw invalid("giving back needs a slot");
			const slot = await workSlot(ctx, run, input.slot);
			const lease = await leaseOf(ctx, slot.id);
			if (lease && workHeldByOther(lease, ctx.actor.id, ctx.app.now())) return await busy(ctx, lease);
			await releaseWork(ctx, run, slot);
			const row = await caseById(ctx.db, slot.case_id);
			return { run: runRef(run), slot: slot.id, case: row ? caseRef(row) : null, work: { kind: "free" } };
		}
		const result = await takeWork(ctx, run, input);
		if (result.kind === "busy") return await busy(ctx, result.lease);
		if (result.kind === "empty") return { run: runRef(run), slot: null, case: null, work: { kind: "free" } };
		const row = await caseById(ctx.db, result.slot.case_id);
		return {
			run: runRef(run),
			slot: result.slot.id,
			case: row ? caseRef(row) : null,
			work: { kind: "held", actor: ctx.actor.name, since: result.lease.since, until: result.lease.until },
		};
	},
});
