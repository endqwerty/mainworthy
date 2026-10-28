import { z } from "zod";
import { raiseSteps, refold } from "../decisions/decisions.ts";
import { raiseMapSteps } from "../decisions/kinds.ts";
import { batchById, unlinkedInFile } from "../evidence/evidence.ts";
import { finishReportMapPage, reportMapPage } from "../evidence/report-maps.ts";
import { actorById, lockActors } from "../identity/identity.ts";
import type { App } from "../kernel/app.ts";
import { demoDeployment, lockProject, makeCtx, stampSeq } from "../kernel/ctx.ts";
import { completeJob, fenceJob, type JobClaim, type JobInput } from "../kernel/jobs.ts";
import { complete } from "../kernel/steps.ts";

export async function executeReportMaps(app: App, claim: JobClaim, input: JobInput): Promise<void> {
	const { page: id } = z.object({ page: z.string() }).parse(input);
	await app.database.write((db) =>
		db.transaction(async () => {
			const pending = await reportMapPage(db, id);
			if (!pending) {
				await completeJob(db, claim, app.now());
				return;
			}
			const batch = await batchById(db, pending.batch);
			if (!batch) throw new Error("report map page has no originating batch");
			const actor = batch.actor;
			await lockActors(db, [actor]);
			const project = await lockProject(db, batch.project);
			const page = await reportMapPage(db, id);
			await fenceJob(db, claim, app.now());
			if (page && project && (await demoDeployment(db, project.id))?.kind !== "retired") {
				const ctx = makeCtx(app, db, project, await actorById(db, actor, project.id), true);
				for (const file of page.files) {
					if ((await unlinkedInFile(db, project.id, file, 0, batch.id)).length === 0) continue;
					await complete(raiseMapSteps(ctx, raiseSteps, file, ctx.actor.kind, batch.id));
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
			await finishReportMapPage(db, id);
			await completeJob(db, claim, app.now());
		}),
	);
}
