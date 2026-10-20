import { z } from "zod";
import { projectCommand } from "./commands.ts";

const request = z.string().min(8).max(64);
const question = z.string().min(1).max(32).describe("The failure question, `Q-70` or `70`.");

export const HandoffInput = z.strictObject({ question, ...projectCommand, cmd: request });
export type HandoffInput = z.infer<typeof HandoffInput>;
export const HandoffStatusInput = z.strictObject({ question });

export const HandoffReceipt = z.object({
	id: request,
	question: z.string(),
	state: z.enum(["queued", "sending", "sent", "failed"]),
	error: z.string().nullable(),
	at: z.number(),
});
export type HandoffReceipt = z.infer<typeof HandoffReceipt>;
/** The latest hand-off of a question, or null when it was never handed off. */
export const HandoffStatus = HandoffReceipt.nullable();

export type FailureFacts = {
	project: string;
	question: string;
	title: string;
	/** Where the question opens on the instance, when the instance knows its public address. */
	url: string | null;
	message: string | null;
	tests: readonly { t: string; name: string }[];
	count: number;
	target: string;
	branch: string | null;
	scope: string;
	/** The pipeline run that reported the failure, when the report named one. */
	build?: string | null;
	/** The sample result's further output, when it reported any. */
	detail?: string | null;
};

const SHOWN_TESTS = 20;
const DETAIL_CHARACTERS = 8_000;

/**
 * What a coding agent is told about a failure: what failed, where, and that the cause is to be fixed. The web's
 * copy and the server's hand-off both write it, so an agent reads the same text from either.
 */
export function failureBrief(facts: FailureFacts): string {
	const tests = facts.tests.slice(0, SHOWN_TESTS).map((test) => `- ${test.t} ${test.name}`);
	const more = facts.count - tests.length;
	return [
		`Mainworthy question ${facts.question} in project ${facts.project}: ${facts.title}`,
		...(facts.url ? [facts.url] : []),
		"",
		`${facts.count} ${facts.count === 1 ? "test fails" : "tests fail"} with this cause on ${facts.target} (${facts.branch ? `branch ${facts.branch}` : facts.scope}):`,
		...tests,
		...(more > 0 ? [`- and ${more} more`] : []),
		...(facts.build ? ["", `Build: ${facts.build}`] : []),
		"",
		"Failure:",
		facts.message ?? "No failure message was reported.",
		...(facts.detail ? ["", facts.detail.slice(0, DETAIL_CHARACTERS)] : []),
		"",
		"Find why it fails and fix the cause so the tests pass. If the test is what is wrong, fix the test and say why.",
	].join("\n");
}
