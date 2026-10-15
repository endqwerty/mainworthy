import { z } from "zod";
import type { TrackerItem } from "../../core/tracker.ts";

export const TrackerReadFailure = z.enum([
	"unreadable",
	"unauthorized",
	"forbidden",
	"missing",
	"moved",
	"undefinedCategory",
]);
export type TrackerReadFailure = z.infer<typeof TrackerReadFailure>;
export const TRACKER_READ_FAILURES = {
	unreadable:
		"The request failed or its reply was unreadable. Check the tracker connection and account permissions; the hold remains and will be checked again.",
	unauthorized:
		"HTTP 401. Renew the tracker token in the server configuration; the hold remains and will be checked again.",
	forbidden: "HTTP 403. Check the tracker account permissions; the hold remains and will be checked again.",
	missing:
		"HTTP 404. Check the issue key and account permissions. If the issue moved, answer the failure again with the new issue key.",
	moved:
		"The issue key changed. Answer the failure again with the new issue key; this reference no longer names the requested issue.",
	undefinedCategory:
		"Jira returned status category undefined. Set a Jira status category of new, indeterminate or done for the issue's status; the hold remains.",
} satisfies Record<TrackerReadFailure, string>;

export class TrackerError extends Error {
	constructor(
		message: string,
		readonly readFailure: TrackerReadFailure = "unreadable",
	) {
		super(message);
	}
}

export function trackerHttpFailure(status: number): TrackerReadFailure {
	if (status === 401) return "unauthorized";
	if (status === 403) return "forbidden";
	if (status === 404) return "missing";
	return "unreadable";
}

export type DefectDraft = { title: string; body: string };

export type TrackerPort = {
	createDefect: (draft: DefectDraft) => Promise<TrackerItem>;
	getItem: (key: string) => Promise<TrackerItem>;
};
