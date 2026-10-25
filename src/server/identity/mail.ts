import { randomUUID } from "node:crypto";
import type { App } from "../kernel/app.ts";
import type { WriteDb } from "../kernel/db.ts";
import { invalid } from "../kernel/errors.ts";
import { enqueueJob, jobsPending, kindJobsStopped, runKindJobs, stopKindJobs, waitKindJobs } from "../kernel/jobs.ts";
import { executeMail, type MailMessage } from "../kernel/smtp.ts";
import { publicAddress } from "./people.ts";

type Message = MailMessage;
export function requireMail(app: App): string {
	const url = publicAddress(app.config)?.url;
	if (!app.config.mail || !url) throw invalid("mail is off on this instance");
	return url;
}
async function enqueue(app: App, db: WriteDb, message: Message, key: string): Promise<void> {
	await enqueueJob(db, {
		kind: "mail",
		key,
		input: message,
		actor: null,
		acceptedAt: app.now(),
		privateInput: true,
		privateKey: app.config.jobKey,
	});
}
/** The synchronous caller registers a write that COMMIT awaits on this very transaction. */
export function queueMail(app: App, db: WriteDb, message: Message): void {
	if (!app.config.mail) return;
	const key = randomUUID();
	db.beforeCommit(() => enqueue(app, db, message, key));
}
export function deliverQueuedMail(app: App): Promise<number> {
	return runKindJobs(app, "mail", (claim, input) => executeMail(app, claim, input));
}
export async function waitMail(app: App): Promise<void> {
	while (!kindJobsStopped(app, "mail")) {
		await deliverQueuedMail(app);
		if (!(await app.database.read((db) => jobsPending(db, "mail", app.now())))) break;
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
	await waitKindJobs(app, "mail");
}
export function stopMail(app: App): void {
	stopKindJobs(app, "mail");
}
