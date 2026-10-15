import type { Config } from "../kernel/app.ts";
import { githubPort } from "./github.ts";
import { jiraPort } from "./jira.ts";
import type { TrackerPort } from "./port.ts";

type Tracker = {
	destination: string;
	port: () => TrackerPort;
	validKey: (key: string) => boolean;
	keyOf: (ref: string) => string | null;
};

export function configuredTrackers(config: Config, project: string): Tracker[] {
	const trackers: Tracker[] = [];
	const jira = config.jira;
	if (jira?.project === project) {
		const validKey = (key: string) =>
			/^[A-Z][A-Z0-9_]+-[1-9]\d{0,14}$/.test(key) && key.startsWith(`${jira.projectKey}-`);
		trackers.push({
			destination: `jira:${jira.site}#${jira.projectKey}`,
			port: () => jiraPort(jira),
			validKey,
			keyOf: (ref) => keyAfter(ref, [`jira:${jira.site}#`, `${jira.site}/browse/`], validKey),
		});
	}
	const github = config.github;
	if (github?.project === project) {
		const validKey = (key: string) => /^[1-9]\d{0,14}$/.test(key);
		trackers.push({
			destination: github.repository,
			port: () => githubPort(github),
			validKey,
			keyOf: (ref) =>
				keyAfter(ref, [`github:${github.repository}#`, `https://github.com/${github.repository}/issues/`], validKey),
		});
	}
	return trackers;
}

function keyAfter(ref: string, prefixes: string[], valid: (key: string) => boolean): string | null {
	for (const prefix of prefixes) {
		if (!ref.startsWith(prefix)) continue;
		const key = ref.slice(prefix.length);
		if (valid(key)) return key;
	}
	return null;
}
