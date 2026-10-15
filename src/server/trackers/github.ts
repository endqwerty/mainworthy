import { z } from "zod";
import type { TrackerItem } from "../../core/tracker.ts";
import { TrackerError, type TrackerPort, trackerHttpFailure } from "./port.ts";

const Issue = z.object({
	number: z.number().int().positive(),
	state: z.enum(["open", "closed"]),
	pull_request: z.never().optional(),
});

export function githubPort(config: { repository: string; token: string }, request: typeof fetch = fetch): TrackerPort {
	const base = `https://api.github.com/repos/${config.repository}/issues`;
	async function issue(path: string, draft?: { title: string; body: string }): Promise<TrackerItem> {
		try {
			const response = await request(`${base}${path}`, {
				method: draft ? "POST" : "GET",
				headers: {
					Accept: "application/vnd.github+json",
					Authorization: `Bearer ${config.token}`,
					"X-GitHub-Api-Version": "2026-03-10",
					...(draft ? { "Content-Type": "application/json" } : {}),
				},
				...(draft ? { body: JSON.stringify(draft) } : {}),
				signal: AbortSignal.timeout(15_000),
				redirect: "error",
			});
			if (response.status !== (draft ? 201 : 200)) {
				await response.body?.cancel();
				throw new TrackerError(
					`GitHub returned HTTP ${response.status}; check the repository and token permissions.`,
					trackerHttpFailure(response.status),
				);
			}
			const parsed = Issue.safeParse(await response.json());
			if (!parsed.success) throw new TrackerError("GitHub did not return an issue.");
			if (path && path !== `/${parsed.data.number}`)
				throw new TrackerError(
					"GitHub returned another issue than the one requested; it may have moved. Use the new issue key.",
					"moved",
				);
			return {
				ref: `github:${config.repository}#${parsed.data.number}`,
				url: `https://github.com/${config.repository}/issues/${parsed.data.number}`,
				state: parsed.data.state,
			};
		} catch (error) {
			if (error instanceof TrackerError) throw error;
			throw new TrackerError(
				"GitHub could not be reached or its reply could not be read; check GitHub before creating another issue.",
			);
		}
	}
	return {
		createDefect: (draft) => issue("", draft),
		async getItem(key) {
			if (!/^[1-9]\d{0,14}$/.test(key)) throw new TrackerError("A GitHub issue key is its positive issue number.");
			return issue(`/${key}`);
		},
	};
}
