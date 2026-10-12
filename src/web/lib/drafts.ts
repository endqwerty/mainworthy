import { z } from "zod";
import { CaseBody, Step } from "../../core/model.ts";
import { deviceKey } from "./device.ts";

const DraftBody = CaseBody.extend({
	steps: z.array(Step.extend({ action: z.string(), expected: z.string().nullable() })),
});
const Draft = z.object({
	id: z.string(),
	ref: z.string().nullable(),
	base: z.number(),
	body: DraftBody,
	original: CaseBody,
	tags: z.array(z.string()),
	covers: z.array(z.string()),
	folder: z.string(),
	after: z.string().nullable(),
	caret: z.object({ field: z.string(), start: z.number(), end: z.number() }),
	dirty: z.boolean(),
	at: z.number(),
	cmd: z.string(),
	submission: z
		.discriminatedUnion("kind", [
			z.object({ kind: z.literal("none") }),
			z.object({ kind: z.literal("waiting"), question: z.string(), fingerprint: z.string() }),
		])
		.default({ kind: "none" }),
});
export type Draft = z.infer<typeof Draft>;
export function draftKey({ project, id }: { project: string; id: string }): string {
	return deviceKey("draft", `${project}:${id}`);
}
const activeKey = (project: string): string => deviceKey("active", project);
const stepsKey = (project: string, id: string): string => deviceKey("steps", `${project}:${id}`);
export function readDraft({ project, id }: { project: string; id: string }): Draft | null {
	try {
		const text = localStorage.getItem(draftKey({ project, id }));
		if (!text) return null;
		const result = Draft.safeParse(JSON.parse(text));
		return result.success ? result.data : null;
	} catch {
		return null;
	}
}
/** Each input writes synchronously, so even closing before the next frame preserves text and caret. */
export function writeDraft({ project, draft }: { project: string; draft: Draft }): void {
	knownStepIds({ project, id: draft.id, ids: [...draft.body.steps, ...draft.original.steps].map((step) => step.id) });
	localStorage.setItem(draftKey({ project, id: draft.id }), JSON.stringify(draft));
	localStorage.setItem(activeKey(project), draft.id);
}
export function activeDraft(project: string): Draft | null {
	try {
		const id = localStorage.getItem(activeKey(project));
		return (id ? readDraft({ project, id }) : null) ?? readDrafts(project).at(-1) ?? null;
	} catch {
		return null;
	}
}
export function readDrafts(project: string): Draft[] {
	const drafts: Draft[] = [];
	const prefix = deviceKey("draft", `${project}:`);
	try {
		for (let i = 0; i < localStorage.length; i++) {
			const key = localStorage.key(i);
			if (!key?.startsWith(prefix)) continue;
			const draft = readDraft({ project, id: key.slice(prefix.length) });
			if (draft) drafts.push(draft);
		}
	} catch {}
	return drafts.sort((a, b) => a.at - b.at);
}
export function removeDraft({ project, id }: { project: string; id: string }): void {
	localStorage.removeItem(draftKey({ project, id }));
	if (localStorage.getItem(activeKey(project)) === id) localStorage.removeItem(activeKey(project));
}

const seenSteps = new Map<string, Set<string>>();
/** Deleted steps keep their identity reserved for every version this device has seen. */
export function knownStepIds({
	project,
	id,
	ids,
}: {
	project: string;
	id: string;
	ids: readonly string[];
}): ReadonlySet<string> {
	const key = stepsKey(project, id);
	let taken = seenSteps.get(key);
	if (!taken) {
		let stored: string[] = [];
		try {
			const raw = localStorage.getItem(key);
			if (raw) stored = z.array(Step.shape.id).parse(JSON.parse(raw));
		} catch {}
		taken = new Set(stored);
		seenSteps.set(key, taken);
	}
	let changed = false;
	for (const step of ids) {
		if (!taken.has(step)) {
			taken.add(step);
			changed = true;
		}
	}
	if (changed)
		try {
			localStorage.setItem(key, JSON.stringify([...taken]));
		} catch {}
	return taken;
}
export function promoteStepIds({ project, from, to }: { project: string; from: string; to: string }): void {
	const ids = knownStepIds({ project, id: from, ids: [] });
	knownStepIds({ project, id: to, ids: [...ids] });
	if (from !== to) {
		seenSteps.delete(stepsKey(project, from));
		try {
			localStorage.removeItem(stepsKey(project, from));
		} catch {}
	}
}
