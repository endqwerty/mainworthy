import { z } from "zod";
import { CaseBody, Step } from "../../core/model.ts";
import type { Draft } from "../lib/drafts.ts";
import { randomId } from "../lib/ids.ts";
import { Proofs } from "../ui/index.tsx";
export const CaseRow = z.object({
	ref: z.string(),
	title: z.string(),
	folder: z.number(),
	rank: z.string(),
	tags: z.array(z.string()),
	version: z.number(),
	hash: z.string(),
	steps: z.number(),
	methods: z.array(z.string()),
	state: z.string(),
	updatedAt: z.number(),
	updatedBy: z.string(),
	proof: Proofs,
	open: z.number(),
});
export type CaseRow = z.infer<typeof CaseRow>;
export const FolderRow = z.object({
	id: z.number(),
	parent: z.number().nullable(),
	name: z.string(),
	path: z.string(),
	rank: z.string(),
	state: z.string(),
	cases: z.number(),
});
export type FolderRow = z.infer<typeof FolderRow>;
export const CaseView = z.object({
	ref: z.string(),
	version: z.number(),
	head: z.number(),
	hash: z.string(),
	state: z.string(),
	title: z.string(),
	pre: z.string(),
	steps: z.array(Step),
	methods: CaseBody.shape.methods,
	automate: CaseBody.shape.automate,
	fields: CaseBody.shape.fields.default({}),
	tags: z.array(z.string()),
	covers: z.array(z.string()),
	folder: z.object({ id: z.number(), path: z.string() }),
	updated: z.object({ at: z.number(), by: z.string(), kind: z.string() }),
	proof: Proofs,
	open: z.number(),
	usedStepIds: z.array(Step.shape.id).default([]),
});
export type CaseView = z.infer<typeof CaseView>;
export function bodyOf(view: CaseView): CaseBody {
	return {
		title: view.title,
		pre: view.pre,
		steps: view.steps,
		methods: view.methods,
		automate: view.automate,
		fields: view.fields,
	};
}
export function editDraft(view: CaseView): Draft {
	const body = bodyOf(view);
	return {
		id: view.ref,
		ref: view.ref,
		base: view.version,
		body,
		original: body,
		tags: view.tags,
		covers: view.covers,
		originalTags: view.tags,
		originalCovers: view.covers,
		owner: "",
		sent: null,
		folder: view.folder.path,
		after: null,
		caret: { field: "title", start: body.title.length, end: body.title.length },
		dirty: false,
		at: Date.now(),
		cmd: randomId(),
		submission: { kind: "none" },
	};
}
