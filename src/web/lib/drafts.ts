import { z } from "zod";
import { CaseBody, CaseKind, FragmentStep, InlineStep, StepId } from "../../core/model.ts";
import { ProposeInput } from "../../core/ops.ts";
import { deviceKey, deviceSession, sessionCurrent } from "./device.ts";
import { draftOwnedElsewhere, draftOwner, randomId } from "./ids.ts";

export const DraftBody = CaseBody.extend({
	steps: z.array(
		z.union([
			InlineStep.extend({ action: z.string(), expected: z.string().nullable(), use: z.never().optional() }),
			FragmentStep,
		]),
	),
});
export const DraftConflict = z.object({
	q: z.string(),
	proposal: z.string(),
	ref: z.string(),
	base: CaseBody,
	mine: CaseBody,
	current: CaseBody,
	merged: DraftBody,
	stepOrder: z.enum(["mine", "current"]).optional(),
	/**
	 * Every merge this card sent for its question, oldest first, each under its own command id. Until the server
	 * says what became of one, the page does not know: the reply can be lost after the merge was recorded.
	 */
	sentMerges: z.array(z.object({ cmd: z.string(), body: CaseBody })).default([]),
	paths: z.array(z.string()),
	draftId: z.string(),
});
export type DraftConflict = z.infer<typeof DraftConflict>;

export function hasTypedMerge(state: DraftConflict): boolean {
	return state.paths.some((path) => {
		const text = (body: CaseBody): string | null => {
			if (path === "title") return body.title;
			if (path === "pre") return body.pre;
			const [kind, id, part] = path.split(".");
			if (kind !== "steps") return null;
			const step = body.steps.find((step) => step.id === id);
			return part === "action" ? (step?.action ?? null) : part === "expected" ? (step?.expected ?? "") : null;
		};
		const merged = text(state.merged);
		return merged !== null && merged !== text(state.mine) && merged !== text(state.current);
	});
}

const TagChanges = z.object({ add: z.array(z.string()), remove: z.array(z.string()) });
export type TagChanges = z.infer<typeof TagChanges>;

export const Draft = z
	.object({
		id: z.string(),
		ref: z.string().nullable(),
		kind: CaseKind.optional(),
		base: z.number(),
		body: DraftBody,
		original: CaseBody,
		conflict: DraftConflict.optional(),
		tags: z.array(z.string()).optional(),
		tagChanges: TagChanges.optional(),
		covers: z.array(z.string()),
		originalTags: z.array(z.string()).optional(),
		originalCovers: z.array(z.string()).optional(),
		owner: z.string().default(""),
		sent: z
			.object({
				input: ProposeInput,
				body: CaseBody,
				tags: z.array(z.string()),
				covers: z.array(z.string()),
				tagChanges: TagChanges.optional(),
			})
			.nullable()
			.default(null),
		placement: z.object({ tags: z.array(z.string()).optional() }).optional(),
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
	.transform(({ tags, placement, tagChanges, ...draft }) => {
		const originalTags = draft.originalTags ?? (draft.ref === null ? [] : (tags ?? []));
		const edited = placement?.tags ?? tags ?? originalTags;
		return {
			...draft,
			sent: draft.sent
				? {
						...draft.sent,
						tagChanges: draft.sent.tagChanges ?? {
							add: draft.sent.input.edits.flatMap((edit) =>
								edit.op === "create" ? (edit.tags ?? []) : edit.op === "place" ? (edit.tags?.add ?? []) : [],
							),
							remove: draft.sent.input.edits.flatMap((edit) => (edit.op === "place" ? (edit.tags?.remove ?? []) : [])),
						},
					}
				: null,
			originalTags,
			originalCovers: draft.originalCovers ?? draft.covers,
			tagChanges: tagChanges ?? {
				add: edited.filter((tag) => !originalTags.includes(tag)),
				remove: originalTags.filter((tag) => !edited.includes(tag)),
			},
		};
	});
export type Draft = z.infer<typeof Draft>;

export function draftTags(draft: Pick<Draft, "originalTags" | "tagChanges">): string[] {
	return [...new Set([...draft.originalTags, ...draft.tagChanges.add])].filter(
		(tag) => !draft.tagChanges.remove.includes(tag),
	);
}

export function addDraftTags(draft: Draft, added: string[]): Draft {
	return {
		...draft,
		tagChanges: {
			add: [...new Set([...draft.tagChanges.add, ...added.filter((tag) => !draft.originalTags.includes(tag))])],
			remove: draft.tagChanges.remove.filter((tag) => !added.includes(tag)),
		},
	};
}

/** Retire only the intent that save accepted, including reversals typed while it was in flight. */
export function remainingTagChanges({ sent, current }: { sent: TagChanges; current: TagChanges }): TagChanges {
	return {
		add: [
			...current.add.filter((tag) => !sent.add.includes(tag)),
			...sent.remove.filter((tag) => !current.remove.includes(tag)),
		],
		remove: [
			...current.remove.filter((tag) => !sent.remove.includes(tag)),
			...sent.add.filter((tag) => !current.add.includes(tag)),
		],
	};
}
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
/** Bootstrap runs before the session selects an account and project, so include every canonical draft. */
export function storedDraftOwners(): string[] {
	const owners: string[] = [];
	try {
		for (let index = 0; index < localStorage.length; index++) {
			const key = localStorage.key(index);
			if (!key || !/^mainworthy:#\d+:draft:/.test(key)) continue;
			try {
				const parsed = Draft.safeParse(JSON.parse(localStorage.getItem(key) ?? "null"));
				if (parsed.success && parsed.data.dirty) owners.push(parsed.data.owner);
			} catch {}
		}
	} catch {}
	return owners;
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
	const claimed = { ...stored, owner: draftOwner(), cmd: randomId() };
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
			if (raw) stored = z.array(StepId).parse(JSON.parse(raw));
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
	if (changed && sessionCurrent(deviceSession()))
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
