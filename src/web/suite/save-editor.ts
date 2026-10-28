import { useRef, useState } from "react";
import type { Api } from "../../core/api.ts";
import { type Draft, readDrafts } from "../lib/drafts.ts";
import { SaveCommands } from "./save-state.ts";

/** Editor input is synchronous; promises coordinate effects without delaying the device write. */
export function useSaveEditor(project: string, initialDraft: () => Draft | null) {
	const [draftStored, setDraftStored] = useState(true);
	const [draft, setDraftState] = useState(initialDraft);
	const draftRef = useRef(draft);
	const liveDrafts = useRef(new Map<string, Draft>(draft ? [[draft.id, draft]] : []));
	const [captures, setCaptures] = useState(() => new Map(readDrafts(project).map((draft) => [draft.id, draft])));
	const [commands] = useState(() => new SaveCommands());
	// Another window ended this draft. Keep showing its text until a read of its case succeeds.
	const gone = useRef<{ draft: Draft; reading: boolean } | null>(null);
	const [ending, setEnding] = useState<"reading" | "unread" | null>(null);
	// The read obligation outlives selection; concurrent requests share owedReads.
	const owed = useRef(new Set<string>());
	const owedReads = useRef(new Map<string, Promise<{ rows: Api["get"]["reply"] } | { failure: string }>>());
	return {
		draftStored,
		setDraftStored,
		draft,
		setDraftState,
		draftRef,
		liveDrafts,
		captures,
		setCaptures,
		commands,
		gone,
		ending,
		setEnding,
		owed,
		owedReads,
	};
}

export function readCaptures(project: string) {
	return new Map(readDrafts(project).map((draft) => [draft.id, draft]));
}
