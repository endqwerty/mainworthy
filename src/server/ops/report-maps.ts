import { z } from "zod";
import { ActorKind } from "../../core/kinds.ts";
import { raiseSteps, refold } from "../decisions/decisions.ts";
import { raiseMapSteps } from "../decisions/kinds.ts";
import { unlinkedInFile } from "../evidence/evidence.ts";
import { actorById, lockActors } from "../identity/identity.ts";
import type { App } from "../kernel/app.ts";
import { demoDeployment, lockProject, makeCtx, stampSeq } from "../kernel/ctx.ts";
import { completeJob, fenceJob, type JobClaim, type JobInput } from "../kernel/jobs.ts";
import { complete } from "../kernel/steps.ts";

export const MAP_FILES_PER_PAGE = 100;
const Page = z.object({
	project: z.number().int(),
	producer: ActorKind,
	files: z.array(z.string()).min(1).max(MAP_FILES_PER_PAGE),
});

export async function executeReportMaps(app: App, claim: JobClaim, input: JobInput): Promise<void> {
	const page = Page.parse(input);
	const actor = claim.actor;
	if (actor === null) throw new Error("report mapping page has no producer");
	await app.database.write((db) =>
		db.transaction(async () => {
			await lockActors(db, [actor]);
			const project = await lockProject(db, page.project);
			await fenceJob(db, claim, app.now());
			if (project && (await demoDeployment(db, project.id))?.kind !== "retired") {
				const ctx = makeCtx(app, db, project, await actorById(db, actor, project.id), true);
				for (const file of page.files) {
					if ((await unlinkedInFile(db, project.id, file)).length === 0) continue;
					await complete(raiseMapSteps(ctx, raiseSteps, file, page.producer));
				}
				await refold(ctx, []);
				await stampSeq(ctx);
				await app.recordChange(db, {
					project: project.key,
					seq: ctx.seq,
					op: "report-maps",
					actor: ctx.actor.name,
					touched: [...ctx.touched],
				});
			}
			await completeJob(db, claim, app.now());
		}),
	);
}
