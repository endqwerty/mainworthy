import type { Verdict } from "../../core/runs.ts";
import { type StatusPort, StatusRateLimit } from "./port.ts";

const STATES: Record<Verdict, "pending" | "success" | "failure" | "error"> = {
	pending: "pending",
	passed: "success",
	failed: "failure",
	blocked: "error",
};

export function githubStatusesPort(
	config: { repository: string; token: string },
	request: typeof fetch = fetch,
): StatusPort {
	return {
		async post(draft) {
			const response = await request(`https://api.github.com/repos/${config.repository}/statuses/${draft.commit}`, {
				method: "POST",
				headers: {
					Accept: "application/vnd.github+json",
					Authorization: `Bearer ${config.token}`,
					"X-GitHub-Api-Version": "2026-03-10",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					state: STATES[draft.verdict],
					context: "mainworthy/gate",
					description: draft.reason.slice(0, 140),
					target_url: draft.url,
				}),
				signal: AbortSignal.timeout(15_000),
				redirect: "error",
			});
			await response.body?.cancel().catch(() => undefined);
			if (response.status === 403 || response.status === 429) {
				const after = response.headers.get("retry-after");
				const seconds = secondsHeader(after);
				const date = after === null || seconds !== null ? 0 : Date.parse(after);
				const retryAfter = seconds !== null || (Number.isFinite(date) && date > 0);
				const exhausted = response.headers.get("x-ratelimit-remaining") === "0";
				if (response.status === 403 && !exhausted && !retryAfter)
					throw new Error("GitHub did not accept the commit status.");
				throw new StatusRateLimit(
					seconds === null ? 0 : seconds * 1000,
					Math.max(
						Number.isFinite(date) ? date : 0,
						exhausted || retryAfter ? (secondsHeader(response.headers.get("x-ratelimit-reset")) ?? 0) * 1000 : 0,
					),
				);
			}
			if (response.status !== 201) throw new Error("GitHub did not accept the commit status.");
		},
	};
}

function secondsHeader(value: string | null): number | null {
	if (value === null || !/^\d+$/.test(value)) return null;
	const seconds = Number(value);
	return Number.isSafeInteger(seconds * 1000) ? seconds : null;
}
