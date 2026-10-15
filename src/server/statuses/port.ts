import type { Verdict } from "../../core/runs.ts";

export type StatusDraft = {
	commit: string;
	verdict: Verdict;
	reason: string;
	url: string;
};

export type StatusPort = {
	post: (draft: StatusDraft) => Promise<void>;
};

export class StatusRateLimit extends Error {
	constructor(
		readonly retryAfterMs: number,
		readonly retryAt: number,
	) {
		super("GitHub commit status delivery is rate limited.");
	}
}
