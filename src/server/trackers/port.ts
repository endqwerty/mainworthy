import type { TrackerItem } from "../../core/tracker.ts";

export class TrackerError extends Error {}

export type DefectDraft = { title: string; body: string };

export type TrackerPort = {
	createDefect: (draft: DefectDraft) => Promise<TrackerItem>;
	getItem: (key: string) => Promise<TrackerItem>;
};
