import { z } from "zod";
import { ActorKind } from "../../core/kinds.ts";
import { type ReadDb, sql, type WriteDb } from "../kernel/db.ts";
import { enqueueJob } from "../kernel/jobs.ts";

export const MAP_FILES_PER_PAGE = 100;
const Files = z.array(z.string()).min(1).max(MAP_FILES_PER_PAGE);
type Page = {
	id: string;
	project: number;
	batch: number;
	actor: number;
	producer: ActorKind;
	files: string;
	at: number;
};
const Q = {
	put: sql<Page>(`INSERT INTO report_map_pages(id,project,batch,actor,producer,files,at)
 VALUES($id,$project,$batch,$actor,$producer,$files,$at)`),
	one: sql<{ id: string }, Page>("SELECT * FROM report_map_pages WHERE id=$id"),
	pending: sql<readonly [], Page>("SELECT * FROM report_map_pages ORDER BY at,id"),
	remove: sql<{ id: string }>("DELETE FROM report_map_pages WHERE id=$id"),
};

async function enqueue(db: WriteDb, page: Page, dueAt = page.at): Promise<void> {
	await enqueueJob(db, {
		kind: "report-maps",
		key: page.id,
		input: { page: page.id },
		actor: page.actor,
		acceptedAt: page.at,
		dueAt,
	});
}
export async function saveReportMapPage(db: WriteDb, page: Omit<Page, "files"> & { files: string[] }): Promise<void> {
	const stored = { ...page, files: JSON.stringify(Files.parse(page.files)) };
	await db.run(Q.put, stored);
	await enqueue(db, stored);
}
export async function reportMapPage(db: ReadDb, id: string) {
	const page = await db.get(Q.one, { id });
	return page
		? { ...page, producer: ActorKind.parse(page.producer), files: Files.parse(JSON.parse(page.files)) }
		: null;
}
export async function finishReportMapPage(db: WriteDb, id: string): Promise<void> {
	await db.run(Q.remove, { id });
}
export async function restoreReportMapJobs(db: WriteDb): Promise<void> {
	for (const page of await db.all(Q.pending)) {
		ActorKind.parse(page.producer);
		Files.parse(JSON.parse(page.files));
		await enqueue(db, page, 0);
	}
}
