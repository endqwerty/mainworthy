import type { Edit } from "../../core/ops.ts";
import type { Draft } from "../lib/drafts.ts";
import type { CaseRow, CaseView, FolderRow } from "./model.ts";

export type PendingPlacement = { edits: Edit[] };

/** A confirmed later move retires only the same cases' earlier folders, retaining their other edits. */
export function supersedeMoves(earlier: Iterable<PendingPlacement>, confirmed: PendingPlacement): void {
	for (const move of confirmed.edits) {
		if (move.op !== "place" || move.folder === undefined) continue;
		for (const pending of earlier) {
			pending.edits = pending.edits.flatMap((edit): Edit[] => {
				if (edit.op !== "place" || edit.folder === undefined) return [edit];
				const remaining = edit.cases.filter((ref) => !move.cases.includes(ref));
				const superseded = edit.cases.filter((ref) => move.cases.includes(ref));
				if (!superseded.length) return [edit];
				return [
					...(remaining.length ? [{ ...edit, cases: remaining }] : []),
					...(edit.tags ? [{ op: "place", cases: superseded, tags: edit.tags } satisfies Edit] : []),
				];
			});
		}
	}
}

/** Server rows stay intact; each read is displayed with the writes still awaiting confirmation applied in order. */
export function placed<T extends CaseRow | CaseView>(
	row: T,
	pending: Iterable<PendingPlacement>,
	folders: FolderRow[],
): T {
	let next = row;
	for (const { edits } of pending) {
		for (const edit of edits) {
			if ((edit.op !== "place" && edit.op !== "state") || !edit.cases.includes(row.ref)) continue;
			if (edit.op === "state") {
				next = { ...next, state: edit.to };
				continue;
			}
			if (edit.tags) {
				const tags = new Set(edit.tags.set ?? next.tags);
				for (const tag of edit.tags.add ?? []) tags.add(tag);
				for (const tag of edit.tags.remove ?? []) tags.delete(tag);
				next = { ...next, tags: [...tags] };
			}
			if (edit.folder !== undefined) {
				const folder = folders.find((folder) =>
					typeof edit.folder === "number" ? folder.id === edit.folder : folder.path === edit.folder,
				);
				if (folder)
					next = {
						...next,
						folder: typeof next.folder === "number" ? folder.id : { id: folder.id, path: folder.path },
					};
			}
		}
	}
	return next;
}

/** Only explicitly edited placement fields belong to an existing draft. Its text keeps its original version. */
export function placedDraft(
	draft: Draft,
	view: CaseView | null,
	pending: Iterable<PendingPlacement> = [],
	folders: FolderRow[] = [],
): Draft {
	if (!view || draft.ref !== view.ref) return draft;
	const live = placed(view, pending, folders);
	return {
		...draft,
		originalTags: live.tags,
		folder: live.folder.path,
	};
}
