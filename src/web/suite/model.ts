import { z } from "zod";
import { CaseBody, CaseKind, ExpandedStep, Step, StepId } from "../../core/model.ts";
import { Proofs } from "../../core/replies.ts";
import {
	nullableNumber as schemaNullableNumber,
	number as schemaNumber,
	text as schemaText,
	texts as schemaTexts,
} from "../../core/schema.ts";
import type { Draft } from "../lib/drafts.ts";
import { randomId } from "../lib/ids.ts";
export const CaseRow = z.object({
	ref: schemaText,
	title: schemaText,
	folder: schemaNumber,
	rank: schemaText,
	tags: schemaTexts,
	version: schemaNumber,
	hash: schemaText,
	steps: schemaNumber,
	methods: schemaTexts,
	state: schemaText,
	updatedAt: schemaNumber,
	updatedBy: schemaText,
	proof: Proofs,
	open: schemaNumber,
});
export type CaseRow = z.infer<typeof CaseRow>;
export const FolderRow = z.object({
	id: schemaNumber,
	parent: schemaNullableNumber,
	name: schemaText,
	path: schemaText,
	rank: schemaText,
	state: schemaText,
	cases: schemaNumber,
});
export type FolderRow = z.infer<typeof FolderRow>;
export const CaseView = z.object({
	ref: schemaText,
	version: schemaNumber,
	head: schemaNumber,
	hash: schemaText,
	state: schemaText,
	title: schemaText,
	pre: schemaText,
	steps: z.array(ExpandedStep),
	sourceSteps: z.array(Step).optional(),
	kind: CaseKind.default("case"),
	users: z.array(z.object({ case: schemaText, base: schemaNumber, versions: z.array(schemaNumber) })).default([]),
	methods: CaseBody.shape.methods,
	automate: CaseBody.shape.automate,
	fields: CaseBody.shape.fields.default({}),
	tags: schemaTexts,
	covers: schemaTexts,
	folder: z.object({ id: schemaNumber, path: schemaText }),
	updated: z.object({ at: schemaNumber, by: schemaText, kind: schemaText }),
	proof: Proofs,
	open: schemaNumber,
	usedStepIds: z.array(StepId).default([]),
});
export type CaseView = z.infer<typeof CaseView>;
export function bodyOf(view: CaseView): CaseBody {
	return {
		title: view.title,
		pre: view.pre,
		steps: view.sourceSteps ?? view.steps,
		methods: view.methods,
		automate: view.automate,
		fields: view.fields,
	};
}
export function editDraft(view: CaseView, projectIdentity: Draft["projectIdentity"]): Draft {
	const body = bodyOf(view);
	return {
		id: view.ref,
		projectIdentity,
		kind: view.kind,
		ref: view.ref,
		base: view.version,
		body,
		original: body,
		tagChanges: { add: [], remove: [] },
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
