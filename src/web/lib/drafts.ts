import { z } from "zod";
import { CaseBody, Step } from "../../core/model.ts";
import { ProposeInput } from "../../core/ops.ts";
import { deviceKey } from "./device.ts";
import { draftOwnedElsewhere, draftOwner, randomId } from "./ids.ts";

export const DraftBody = CaseBody.extend({
	steps: z.array(Step.extend({ action: z.string(), expected: z.string().nullable() })),
});
export const DraftConflict = z.object({
	q: z.string(),
	proposal: z.string(),
	ref: z.string(),
	base: CaseBody,
	mine: CaseBody,
	current: CaseBody,
	merged: DraftBody,
	sentMerge: CaseBody.optional(),
	paths: z.array(z.string()),
	draftId: z.string(),
});
export type DraftConflict = z.infer<typeof DraftConflict>;

/** The text a conflict path names in a body, or null where the path names no text (a step's membership). */
function textAt(body: CaseBody, path: string): string | null {
	if (path === "title") return body.title;
	if (path === "pre") return body.pre;
	const [kind, id, part] = path.split(".");
	if (kind !== "steps") return null;
	const step = body.steps.find((step) => step.id === id);
	return part === "action" ? (step?.action ?? null) : part === "expected" ? (step?.expected ?? "") : null;
}

export function hasTypedMerge(state: DraftConflict): boolean {
	return state.paths.some((path) => {
		const merged = textAt(state.merged, path);
		return merged !== null && merged !== textAt(state.mine, path) && merged !== textAt(state.current, path);
	});
}

/**
 * Is the merge that was sent the one the head records? Judged on the fields that were in conflict, because
 * the server combines a merge with a colleague's newer change to another field: the head then differs from
 * what was sent, and the merge was recorded all the same.
 */
export function mergeRecorded(state: DraftConflict, sent: CaseBody, head: CaseBody): boolean {
	return state.paths.every((path) => {
		const [kind, id, part] = path.split(".");
		if (kind === "steps" && part === undefined)
			return sent.steps.some((step) => step.id === id) === head.steps.some((step) => step.id === id);
		return textAt(sent, path) === textAt(head, path);
	});
}

const Draft = z
	.object({
		id: z.string(),
		ref: z.string().nullable(),
		base: z.number(),
		body: DraftBody,
		original: CaseBody,
		conflict: DraftConflict.optional(),
		tags: z.array(z.string()),
		covers: z.array(z.string()),
		originalTags: z.array(z.string()).optional(),
		originalCovers: z.array(z.string()).optional(),
		owner: z.string().default(""),
		sent: z
			.object({ input: ProposeInput, body: CaseBody, tags: z.array(z.string()), covers: z.array(z.string()) })
			.nullable()
			.default(null),
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
	})
	.transform((draft) => ({
		...draft,
		originalTags: draft.originalTags ?? draft.tags,
		originalCovers: draft.originalCovers ?? draft.covers,
	}));
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
		return result.success && result.data.dirty ? result.data : null;
	} catch {
		return null;
	}
}
export function claimDraft({
	project,
	draft,
	takeOver = false,
}: {
	project: string;
	draft: Draft;
	takeOver?: boolean;
}): Draft {
	const stored = readDraft({ project, id: draft.id }) ?? draft;
	if (stored.owner === draftOwner() || (!takeOver && draftOwnedElsewhere(stored))) return stored;
	const claimed = { ...stored, owner: draftOwner(), cmd: randomId(), sent: takeOver ? null : stored.sent };
	storeDraft({ project, draft: claimed });
	return claimed;
}
/** Each input writes synchronously, so even closing before the next frame preserves text and caret. */
export function writeDraft({ project, draft }: { project: string; draft: Draft }): boolean {
	const stored = readDraft({ project, id: draft.id });
	if (draft.owner !== draftOwner() || (stored && stored.owner !== draftOwner())) return false;
	storeDraft({ project, draft });
	return true;
}
function storeDraft({ project, draft }: { project: string; draft: Draft }): void {
	knownStepIds({ project, id: draft.id, ids: [...draft.body.steps, ...draft.original.steps].map((step) => step.id) });
	if (!draft.dirty) return;
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
	const stored = readDraft({ project, id });
	if (stored && stored.owner !== draftOwner()) return;
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
