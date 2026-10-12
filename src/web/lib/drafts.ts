import { z } from "zod";
import { CaseBody, Step } from "../../core/model.ts";

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
const prefix = "casebook:draft:";
export function draftKey({ project, id }: { project: string; id: string }): string {
	return `${prefix}${project}:${id}`;
}
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
	localStorage.setItem(draftKey({ project, id: draft.id }), JSON.stringify(draft));
	localStorage.setItem(`casebook:active:${project}`, draft.id);
}
export function activeDraft(project: string): Draft | null {
	try {
		const id = localStorage.getItem(`casebook:active:${project}`);
		return id ? readDraft({ project, id }) : null;
	} catch {
		return null;
	}
}
export function removeDraft({ project, id }: { project: string; id: string }): void {
	localStorage.removeItem(draftKey({ project, id }));
	if (localStorage.getItem(`casebook:active:${project}`) === id) localStorage.removeItem(`casebook:active:${project}`);
}
