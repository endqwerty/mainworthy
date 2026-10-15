import { z } from "zod";
import type { TrackerItem } from "../../core/tracker.ts";
import type { Config } from "../kernel/app.ts";
import { type DefectDraft, TrackerError, type TrackerPort, trackerHttpFailure } from "./port.ts";

const Key = z.string().regex(/^[A-Z][A-Z0-9_]+-[1-9]\d{0,14}$/);
const Created = z.object({ key: Key });
const Issue = Created.extend({
	fields: z.object({
		status: z.object({ statusCategory: z.object({ key: z.enum(["new", "indeterminate", "done", "undefined"]) }) }),
	}),
});

export function jiraPort(config: NonNullable<Config["jira"]>, request: typeof fetch = fetch): TrackerPort {
	async function call(path: string, draft?: DefectDraft): Promise<unknown> {
		try {
			const response = await request(`${config.site}/rest/api/3/issue${path}`, {
				method: draft ? "POST" : "GET",
				headers: {
					Accept: "application/json",
					Authorization: `Basic ${Buffer.from(`${config.email}:${config.token}`).toString("base64")}`,
					...(draft ? { "Content-Type": "application/json" } : {}),
				},
				...(draft
					? {
							body: JSON.stringify({
								fields: {
									project: { key: config.projectKey },
									issuetype: { name: config.issueType },
									summary: draft.title,
									description: {
										type: "doc",
										version: 1,
										content: draft.body.split("\n").map((line) => ({
											type: "paragraph",
											content: line ? [{ type: "text", text: line }] : [],
										})),
									},
								},
							}),
						}
					: {}),
				signal: AbortSignal.timeout(15_000),
				redirect: "error",
			});
			if (response.status !== (draft ? 201 : 200)) {
				await response.body?.cancel();
				throw new TrackerError(
					`Jira returned HTTP ${response.status}; check the site, project, issue type and account permissions before creating another issue.`,
					trackerHttpFailure(response.status),
				);
			}
			return await response.json();
		} catch (error) {
			if (error instanceof TrackerError) throw error;
			throw new TrackerError(
				"Jira could not be reached or its reply could not be read; check Jira before creating another issue.",
			);
		}
	}
	function checkedKey(key: string): string {
		if (!Key.safeParse(key).success || !key.startsWith(`${config.projectKey}-`))
			throw new TrackerError("A Jira issue key must name an issue in the configured project, for example QA-42.");
		return key;
	}
	async function getItem(key: string): Promise<TrackerItem> {
		checkedKey(key);
		const body = await call(`/${key}?fields=status`);
		const returnedKey = Created.safeParse(body);
		if (returnedKey.success && returnedKey.data.key !== key)
			throw new TrackerError(
				"Jira did not return the requested issue and status category; it may have moved. Use the new issue key.",
				"moved",
			);
		const parsed = Issue.safeParse(body);
		if (!parsed.success || parsed.data.key !== key)
			throw new TrackerError("Jira did not return the requested issue and status category.");
		if (parsed.data.fields.status.statusCategory.key === "undefined")
			throw new TrackerError(
				"Jira returned an undefined status category. Set a Jira status category of new, indeterminate or done.",
				"undefinedCategory",
			);
		return {
			ref: `jira:${config.site}#${key}`,
			url: `${config.site}/browse/${key}`,
			state: parsed.data.fields.status.statusCategory.key === "done" ? "closed" : "open",
		};
	}
	return {
		async createDefect(draft) {
			const parsed = Created.safeParse(await call("", draft));
			if (!parsed.success)
				throw new TrackerError("Jira did not return a created issue; check Jira before creating another issue.");
			return getItem(parsed.data.key);
		},
		getItem,
	};
}
