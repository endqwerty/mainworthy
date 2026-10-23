import { z } from "zod";
import { CaseBody, CaseKind, StepId } from "../../core/model.ts";
import { CaseDocument, CaseSummary } from "../../core/replies.ts";
import {
	nullableNumber as schemaNullableNumber,
	number as schemaNumber,
	text as schemaText,
} from "../../core/schema.ts";
import type { Draft } from "../lib/drafts.ts";
import { randomId } from "../lib/ids.ts";
export const CaseRow = CaseSummary;
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
export const CaseView = CaseDocument.omit({ etag: true, claim: true, hasFragments: true, tests: true })
	.required()
	.extend({
		sourceSteps: CaseDocument.shape.sourceSteps,
		kind: CaseKind.default("case"),
		users: CaseDocument.shape.users.default([]),
		methods: CaseBody.shape.methods,
		fields: CaseBody.shape.fields.default({}),
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
