import { type InfiniteData, useInfiniteQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import { z } from "zod";
import type { Api } from "../../core/api.ts";
import { canonicalJson } from "../../core/hash.ts";
import { newStepId } from "../../core/ids.ts";
import { mergeBodies } from "../../core/merge3.ts";
import { CaseBody, cleanPath, emptyBody, fieldErrors, TAG } from "../../core/model.ts";
import type { Edit } from "../../core/ops.ts";
import { parseBodyInline } from "../../core/outline.ts";
import { ProposeReply } from "../../core/replies.ts";
import { optionalFlag as schemaOptionalFlag, text as schemaText, texts as schemaTexts } from "../../core/schema.ts";
import { conflictEditorStatus, firstStep, ownershipStatus } from "../case/editor.tsx";
import { CasePane, type ConflictState } from "../case/pane.tsx";
import { ApiError, call } from "../lib/api.ts";
import { invalidateProject, queryClient, queryKey, useQueryOp } from "../lib/data.ts";
import { deviceSession, sessionCurrent } from "../lib/device.ts";
import {
	claimCopiedDraft,
	discardDraftCopy,
	draftCopiesChanged,
	draftCopyPrefix,
	forgetDraftCopy,
	preserveDraftCopy,
	readDraftCopies,
	writeCopiedDraft,
} from "../lib/draft-copies.ts";
import {
	activeDraft,
	cleanTitle,
	type Draft,
	draftKey,
	draftTags,
	hasDraftText,
	hasTypedMerge,
	knownStepIds,
	promoteStepIds,
	readDraft,
	readDrafts,
	remainingTagChanges,
	removeDraft,
	TagChanges,
} from "../lib/drafts.ts";
import { focusInto } from "../lib/focus.ts";
import { draftOwner, draftOwnerIsLive, randomId } from "../lib/ids.ts";
import {
	allRecorded,
	applyCoverChanges,
	asTyped,
	cardText,
	carried,
	carriedCovers,
	caseHeld,
	draftAfterMerge,
	holdsUnfinishedStep,
	type MergeFate,
	mergeFate,
	mergeMetadata,
	nextMine,
	parsedMergeCard,
	recordable,
	refusedStatus,
	sameBody,
} from "../lib/merges.ts";
import { navigate, navigationToken, refUrl, routeEntry, routeUrl, WENT } from "../lib/router.ts";
import { useApp } from "../ui/context.tsx";
import { EmptyState, ProofStrip } from "../ui/index.tsx";
import { useSuiteBindings } from "./bindings.ts";
import { bodyOf, CaseRow, CaseView, editDraft, FolderRow } from "./model.ts";
import { type PendingPlacement, placed, placedDraft, supersedeMoves } from "./placement.ts";
import "./suite.css";
import "../case/case.css";

const errorMessage = (error: unknown, fallback: string): string => (error instanceof Error ? error.message : fallback);
const waitingStatus = (action: string, question: string | null): string =>
	`${action}, waiting for a person${question === null ? "" : ` · ${question}`}`;
const draftKept = "Your draft is kept on this device.";
const keptFailure = (reason: string): string => `${reason}${/[.!?]$/.test(reason) ? "" : "."} ${draftKept}`;
function readCaptures(project: string) {
	return new Map(readDrafts(project).map((draft) => [draft.id, draft]));
}
const draftStorageFull = "Device storage is full. Keep this tab open until the version is recorded.";
const caseLoadingEdit = "The case is not loaded yet. Press e when it appears.";
const caseReadFailed = "Could not read this case. Reload to try again.";
const caseNotFound = "Case not found.";
const obsoleteProject = (error: unknown): boolean =>
	error instanceof ApiError && error.details.projectIdentity === "obsolete";

const draftRemoved = "mainworthy:suite-draft-removed";

type VisibleRow =
	| { kind: "case"; row: CaseRow }
	| { kind: "draft"; id: string }
	| { kind: "local"; id: string; draft: Draft }
	| { kind: "folder"; folder: FolderRow; count: number };
const unsorted = "Unsorted";
const nothingPlaced = "No cases changed. Nothing to undo.";
type ProposalInput = Api["propose"]["input"] & { cmd: string; projectIdentity: string };
type RetainedProposal<E extends Edit = Edit> = { input: ProposalInput & { edits: [E] }; queued: boolean };
type PlacementUndo = {
	preview: Edit[];
	input: ProposalInput;
	cmd: string;
	ready: Promise<Api["propose"]["reply"]>;
	queued: boolean;
};
const placementObsolete = "The project was replaced. Undo discarded. Reload before changing cases.";
const ResolvedEdit = z.object({
	op: z.literal("edit"),
	case: schemaText,
	mine: CaseBody,
	current: CaseBody,
	body: CaseBody,
});

const CardQuestion = z.object({
	q: schemaText,
	state: schemaText,
	evidenceHash: schemaText,
	decision: z.object({ answer: z.object({ is: schemaText }) }).nullable(),
});
const AdoptionQuestion = CardQuestion.extend({
	decision: z
		.object({
			answer: z.object({ is: schemaText }),
			effects: z.object({ cases: ProposeReply.shape.cases.optional(), rejected: schemaOptionalFlag }),
		})
		.nullable(),
});
const SubmittedText = z.object({
	body: CaseBody,
	tags: schemaTexts,
	covers: schemaTexts,
	tagChanges: TagChanges.optional(),
});
/** A draft's body as it is sent: tags and links typed inline are taken out, and a step with no action is left out. */
function sentBody(draft: Draft): CaseBody {
	return recordable(cleanTitle(draft).body);
}

/**
 * Focuses a field once, when it is put on the page. A ref written inline is a new function on every render, and
 * React calls each new one: a form that focused itself that way took the focus back from wherever the person was
 * typing whenever the screen rendered again, for as long as the form was open.
 */
const focusOnce = (node: HTMLElement | null): void => focusInto(node);

export function SuiteScreen() {
	const { project, session, route, setStatus, openPalette } = useApp();
	const projectIdentity = session.projects.find((entry) => entry.key === project)?.identity;
	// Cleanup and recursive saves retain the route that owned this render.
	const navigation = navigationToken();
	const owner = useRef(deviceSession()).current;
	const windowId = useRef(draftOwner()).current;
	const ownedDraft = useCallback((saved: Draft): Draft => claimCopiedDraft({ project, draft: saved }), [project]);
	const suiteParams = new URLSearchParams(location.search);
	const tagFilter = suiteParams
		.getAll("tag")
		.filter((tag) => TAG.test(tag))
		.join(",");
	const state = suiteParams.get("state") === "archived" ? "archived" : "active";
	const search = suiteParams.get("text") ?? "";
	const [text, setText] = useState(search);
	useEffect(() => setText(search), [search]);
	useEffect(() => {
		const arrived = () => setText(new URLSearchParams(location.search).get("text") ?? "");
		window.addEventListener(WENT, arrived);
		return () => window.removeEventListener(WENT, arrived);
	}, []);
	const [draftStored, setDraftStored] = useState(true);
	const [draft, setDraftState] = useState<Draft | null>(() => {
		const saved =
			routeEntry() === "initial" ? (route.ref ? readDraft({ project, id: route.ref }) : activeDraft(project)) : null;
		return saved?.dirty ? ownedDraft(saved) : null;
	});
	const draftRef = useRef(draft);
	const liveDrafts = useRef(new Map<string, Draft>(draft ? [[draft.id, draft]] : []));
	const [captures, setCaptures] = useState(() => readCaptures(project));
	useEffect(() => {
		const prefix = draftKey({ project, id: "" });
		const removed = (event: Event): void => {
			if (!sessionCurrent(owner) || !(event instanceof CustomEvent) || typeof event.detail !== "string") return;
			if (!event.detail.startsWith(prefix)) return;
			const id = event.detail.slice(prefix.length);
			setCaptures((previous) => {
				if (!previous.has(id)) return previous;
				const next = new Map(previous);
				next.delete(id);
				return next;
			});
		};
		window.addEventListener(draftRemoved, removed);
		return () => window.removeEventListener(draftRemoved, removed);
	}, [project, owner]);
	const adoptedRefs = useRef(new Map<string, string>());
	const pending = useRef(new Map<string, Promise<void>>());
	const [selected, setSelected] = useState<string | null>(route.ref);
	const selectedRef = useRef(selected);
	selectedRef.current = selected;
	const conflict = draft?.conflict ?? (selected ? captures.get(selected)?.conflict : undefined) ?? null;
	const displayedDraft = draft ?? (conflict ? captures.get(conflict.draftId) : null);
	const ownedElsewhere = Boolean(displayedDraft && displayedDraft.owner !== windowId);
	const resolving = useRef(new Set<string>());
	const uncertainMerges = useRef(new Set<string>());
	const followDraft = useCallback((saved: Draft): void => {
		liveDrafts.current.set(saved.id, saved);
		setCaptures((previous) => new Map(previous).set(saved.id, saved));
		if (draftRef.current?.id === saved.id) {
			draftRef.current = saved;
			setDraftState(saved);
		}
	}, []);
	const mayWrite = useCallback(
		(id: string, allowMissing = true): boolean => {
			const saved = readDraft({ project, id });
			if (!saved) return allowMissing;
			if (saved.owner === windowId) return true;
			followDraft(saved);
			setStatus(ownershipStatus(draftOwnerIsLive(saved.owner)));
			return false;
		},
		[project, windowId, followDraft, setStatus],
	);
	const writeOwnedDraft = useCallback(
		(next: Draft): boolean => {
			if (!sessionCurrent(owner)) return false;
			if (writeCopiedDraft({ project, draft: next })) return true;
			mayWrite(next.id);
			return false;
		},
		[project, mayWrite, owner],
	);
	const removeOwnedDraft = useCallback(
		(id: string): void => {
			const copy = liveDrafts.current.get(id);
			removeDraft({ project, id });
			if (readDraft({ project, id })) return;
			if (copy?.owner === windowId) forgetDraftCopy({ project, draft: copy });
			window.dispatchEvent(new CustomEvent(draftRemoved, { detail: draftKey({ project, id }) }));
		},
		[project, windowId],
	);
	const storeConflict = useCallback(
		(state: ConflictState): void => {
			const latest = readDraft({ project, id: state.draftId }) ?? liveDrafts.current.get(state.draftId);
			if (!latest || !mayWrite(state.draftId, !draftStored)) return;
			const next = {
				...latest,
				// A card that moves to a new question has a new side for the person. The draft follows it, and keeps
				// what it held beyond the old one, such as a step that is still being typed.
				body:
					latest.conflict && latest.conflict.q !== state.q
						? mergeBodies({ base: latest.conflict.mine, mine: latest.body, theirs: state.mine }).merged
						: latest.body,
				conflict: state,
				sent: null,
			};
			liveDrafts.current.set(next.id, next);
			try {
				if (!writeOwnedDraft(next)) return;
				setDraftStored(true);
			} catch {
				setDraftStored(false);
				setStatus(draftStorageFull);
			}
			followDraft(next);
		},
		[project, mayWrite, writeOwnedDraft, draftStored, setStatus, followDraft],
	);
	/**
	 * The page holds these rows of a case from now on, unless it holds a later version already. The paths that
	 * can finish a draft call this before they do: a card whose merge the server recorded (`endMergedCard`), a
	 * card answered by a merge from elsewhere that holds all of its text (`settleAnswered`), a draft another
	 * window removed (`endFollowed`), and an editor asked for on a case the page still owes a read of
	 * (`readOwed`). Where the draft then leaves the pane, it does so in the same step, the pane shows the case the
	 * page holds, and `e` opens the editor on it. Not every call ends that way: `endMergedCard` keeps text later
	 * than the merge as a draft, and `endFollowed` holds what it read although the person has moved to another
	 * case. What the page held until then may be from before the write. The read that `invalidateProject` starts
	 * in the same step replaces any read still on its way.
	 */
	const holdCase = useCallback(
		({ ref, rows }: { ref: string; rows: Api["get"]["reply"] }): void => {
			queryClient.setQueryData<Api["get"]["reply"]>(queryKey({ project, op: "get", input: { refs: [ref] } }), (held) =>
				caseHeld({ held, read: rows }),
			);
		},
		[project],
	);
	/**
	 * The draft this tab still shows although another window removed it, and whether `endFollowed` has a read of
	 * its case on the way. While it is the draft in the pane, nothing here changes it or writes it back.
	 */
	const gone = useRef<{ draft: Draft; reading: boolean } | null>(null);
	/** What the pane says of that draft: its case is being read, or could not be (`draftEndedStatus`). */
	const [ending, setEnding] = useState<"reading" | "unread" | null>(null);
	/**
	 * The cases the page owes a read of: a draft of the case ended in another window, and no read of the case
	 * has come back since. Only a read that succeeds, in the session that owes it, takes a case out. It outlasts
	 * the removed draft, which goes when the person selects another case, and no editor opens on a case in it
	 * before that read (`readOwed`). The removed draft itself is never stored again.
	 */
	const owed = useRef(new Set<string>());
	/**
	 * The read of each case the page owes, while it is on its way. Every request for it in that time waits on
	 * the same read (issue #135): `endFollowed`, and `readOwed` for `e`, a click on a field and a property changed
	 * in the read view. A read that comes back holds the case and takes it out of `owed`, once, in the session
	 * that made it; the screen is made again for each person and each project, so no other one waits on it.
	 */
	const owedReads = useRef(new Map<string, Promise<{ rows: Api["get"]["reply"] } | { failure: string }>>());
	const readCase = useCallback(
		(ref: string): Promise<{ rows: Api["get"]["reply"] } | { failure: string }> => {
			const pending = owedReads.current.get(ref);
			if (pending !== undefined) return pending;
			const reading = (async () => {
				try {
					const rows = await call("get", { refs: [ref] }, { project, owner });
					if (sessionCurrent(owner)) {
						holdCase({ ref, rows });
						owed.current.delete(ref);
						void invalidateProject(project);
					}
					return { rows };
				} catch (error) {
					return { failure: errorMessage(error, "no reply") };
				} finally {
					owedReads.current.delete(ref);
				}
			})();
			owedReads.current.set(ref, reading);
			return reading;
		},
		[project, owner, holdCase],
	);
	/**
	 * Another window removed the draft this tab shows: it recorded it, settled its conflict or dropped it. This
	 * tab has no reply that names a version, so it reads the case as it is now. That read began after the draft
	 * was removed, so it holds what was recorded or something later. Until the page holds it the draft stays in
	 * the pane as it was, with its card: the case the page holds may be from before, and `e` would open the editor
	 * on it (issue #94). A read that fails leaves the draft there, and the pane and the status line say so. `e`,
	 * "Read the case again" and a later storage event for the draft read again.
	 */
	const endFollowed = useCallback(
		async (ended: Draft): Promise<void> => {
			const ref = ended.ref;
			if (ref === null || draftRef.current !== ended) return;
			if (gone.current?.draft === ended && gone.current.reading) return;
			const state = { draft: ended, reading: true };
			gone.current = state;
			owed.current.add(ref);
			setEnding("reading");
			const what = ended.conflict
				? "Conflict resolved in another window."
				: "The draft was recorded or ended in another window.";
			setStatus(`${what} Reading the case as it is now…`);
			const read = await readCase(ref);
			const rows = "rows" in read ? read.rows : null;
			const failure = "failure" in read ? read.failure : "";
			state.reading = false;
			if (!sessionCurrent(owner)) return;
			// The tab moved on meanwhile: to another case, or to a draft of this one that was stored again.
			if (draftRef.current !== ended || readDraft({ project, id: ended.id })) {
				if (gone.current === state) {
					gone.current = null;
					setEnding(null);
				}
				return;
			}
			if (!rows) {
				setEnding("unread");
				setStatus(
					`${what} The case could not be read (${failure}), so this stays as it was. Press e or choose "Read the case again".`,
				);
				return;
			}
			gone.current = null;
			setEnding(null);
			liveDrafts.current.delete(ended.id);
			draftRef.current = null;
			setDraftState(null);
			setStatus(`${what} The case is shown as the server recorded it.`);
		},
		[project, owner, readCase, setStatus],
	);
	useEffect(() => {
		const changed = (event: StorageEvent): void => {
			if (!sessionCurrent(owner) || (event.key !== null && !event.key.startsWith(draftKey({ project, id: "" }))))
				return;
			setCaptures(readCaptures(project));
			const current = draftRef.current;
			if (!current || (event.key !== null && event.key !== draftKey({ project, id: current.id }))) return;
			const saved = readDraft({ project, id: current.id });
			if (!saved && current.ref !== null) {
				void endFollowed(current);
				return;
			}
			if (saved) liveDrafts.current.set(saved.id, saved);
			else liveDrafts.current.delete(current.id);
			draftRef.current = saved;
			setDraftState(saved);
			if (saved && saved.owner !== windowId) setStatus(ownershipStatus(draftOwnerIsLive(saved.owner)));
			else if (saved?.conflict) setStatus(conflictEditorStatus);
			else if (saved && !current.conflict) return;
			else {
				setStatus(
					saved
						? "The conflict ended in another window. Your current draft is kept and editable."
						: // Only the draft of a new case comes here: `endFollowed` has taken every other one.
							"This draft was recorded or ended in another window.",
				);
				void invalidateProject(project);
			}
		};
		window.addEventListener("storage", changed);
		return () => window.removeEventListener("storage", changed);
	}, [project, owner, windowId, endFollowed, setStatus]);
	const conflictQuestion = useQueryOp({
		project,
		op: "get",
		input: { refs: [conflict?.q ?? ""], projectIdentity: displayedDraft?.projectIdentity },
		enabled: Boolean(conflict && projectIdentity && displayedDraft?.projectIdentity === projectIdentity),
	});

	const [picked, setPicked] = useState(new Set<string>());
	const [collapsed, setCollapsed] = useState(new Set<number>());
	const [tagging, setTagging] = useState(false);
	const [tagText, setTagText] = useState("");
	const [creatingFolder, setCreatingFolder] = useState(false);
	const [folderText, setFolderText] = useState("");
	const undo = useRef<PlacementUndo | null>(null);
	const folderCreation = useRef<RetainedProposal<Extract<Edit, { op: "folder" }>> | null>(null);
	const versionRestore = useRef<RetainedProposal<Extract<Edit, { op: "restore" }>> | null>(null);
	const commandStatus = useRef(0);
	const settleRetained = useCallback(
		async (action: RetainedProposal, subject: string): Promise<void> => {
			if (!sessionCurrent(owner)) return;
			const status = ++commandStatus.current;
			setStatus(`${subject} is being checked. It will not be retried.`);
			let message: string;
			try {
				const fate = await call("command", { cmd: action.input.cmd }, { project, owner });
				if (fate.state === "done") {
					const reply = ProposeReply.parse(fate.reply);
					const edit = action.input.edits[0];
					if (reply.status === "adopted") {
						message =
							edit.op === "restore" && reply.cases.length === 0
								? `${edit.case} already has that version's content. Nothing changed.`
								: `${subject} was recorded.`;
					} else if (reply.status === "open") {
						message = waitingStatus(`${subject} proposed`, reply.question);
					} else if (reply.status === "conflict") {
						message = `${subject} has a conflict. The case is unchanged.`;
					} else message = `${subject} was ${reply.status}.`;
					void invalidateProject(project);
				} else {
					message = `${subject} ${fate.state === "begun" ? "is still running" : "was not recorded when checked"}. It will not be retried.`;
				}
			} catch (error) {
				const reason = errorMessage(error, "Could not check the outcome.");
				message = `${subject}: ${reason}${/[.!?]$/.test(reason) ? "" : "."} Outcome unknown. It will not be retried.`;
			}
			if (sessionCurrent(owner) && commandStatus.current === status) setStatus(message);
		},
		[project, owner, setStatus],
	);
	const abandonFolder = useCallback((): void => {
		const action = folderCreation.current;
		folderCreation.current = null;
		setCreatingFolder(false);
		setFolderText("");
		if (action) {
			const edit = action.input.edits[0];
			const path = edit.parent ? `${edit.parent}/${edit.name}` : edit.name;
			void settleRetained(action, `Folder "${path}"`);
		}
	}, [settleRetained]);
	const abandonRestore = useCallback((): void => {
		const action = versionRestore.current;
		versionRestore.current = null;
		if (action) void settleRetained(action, `Restore for ${action.input.edits[0].case}`);
	}, [settleRetained]);
	useLayoutEffect(() => {
		const folder = folderCreation.current;
		if (folder && (folder.input.edits[0].parent ?? null) !== route.folder) abandonFolder();
		const restore = versionRestore.current;
		if (restore && restore.input.edits[0].case !== selected) abandonRestore();
	}, [route.folder, selected, abandonFolder, abandonRestore]);
	useEffect(
		() => () => {
			abandonFolder();
			abandonRestore();
		},
		[abandonFolder, abandonRestore],
	);
	const projectReplaced = useRef(false);
	const viewport = useRef<HTMLDivElement>(null);
	const filter = useRef<HTMLInputElement>(null);
	const foldersQuery = useQueryOp({ project, op: "find", input: { in: "folders" } });
	const folders = useMemo(() => z.array(FolderRow).parse(foldersQuery.data?.items ?? []), [foldersQuery.data]);
	const input = useMemo(
		() =>
			({
				in: "cases",
				state,
				limit: 500,
				...(route.folder ? { folder: route.folder, deep: true } : {}),
				...(search ? { text: search } : {}),
				...(tagFilter ? { tags: tagFilter.split(",") } : {}),
			}) satisfies Parameters<typeof call<"find">>[1],
		[route.folder, search, tagFilter, state],
	);
	const list = useInfiniteQuery({
		queryKey: [project, "find", input, "pages"],
		initialPageParam: "",
		queryFn: ({ pageParam, signal }) =>
			call("find", { ...input, ...(pageParam ? { cursor: pageParam } : {}) }, { project, signal }),
		getNextPageParam: (last) => last.cursor ?? undefined,
		placeholderData: (previous) => previous,
	});
	const fieldDefinitions =
		list.data?.pages[0]?.fieldDefinitions ?? session.projects.find((item) => item.key === project)?.fieldDefinitions;
	const [placements, setPlacements] = useState<Set<PendingPlacement>>(() => new Set());
	const cases = useMemo(
		() =>
			z
				.array(CaseRow)
				.parse(list.data?.pages.flatMap((page) => page.items) ?? [])
				.map((row) => placed(row, placements, folders)),
		[list.data, placements, folders],
	);
	const current = useQueryOp({
		project,
		op: "get",
		input: { refs: [selected ?? "C-0"] },
		enabled: selected !== null && !selected.startsWith("draft:"),
	});
	const recordedView = useMemo(() => {
		const parsed = CaseView.safeParse(current.data?.find((item) => item.ref === selected));
		return parsed.success ? parsed.data : null;
	}, [current.data, selected]);
	const caseReadMessage =
		!selected || recordedView || draft
			? null
			: current.isFetching
				? caseLoadingEdit
				: current.error instanceof ApiError && current.error.code === "not_found"
					? caseNotFound
					: caseReadFailed;
	useEffect(() => {
		setStatus((shown) =>
			[caseLoadingEdit, caseReadFailed, caseNotFound].includes(shown) ? (caseReadMessage ?? "") : shown,
		);
	}, [caseReadMessage, setStatus]);
	const view = useMemo(
		() => (recordedView ? placed(recordedView, placements, folders) : null),
		[recordedView, placements, folders],
	);
	const selection = () => (picked.size ? [...picked] : selected ? [selected] : []);
	const selectionStates = new Set(
		selection().map((ref) => (ref === view?.ref ? view.state : cases.find((row) => row.ref === ref)?.state)),
	);
	const restoring =
		selectionStates.size === 1 && !selectionStates.has(undefined) ? selectionStates.has("archived") : null;
	const copyCase = draft?.id ?? selected ?? "";
	const [heldCopies, setCopies] = useState<{ id: string; copies: ReturnType<typeof readDraftCopies> }>({
		id: "",
		copies: [],
	});
	const copies = heldCopies.id === copyCase ? heldCopies.copies : [];
	useEffect(() => {
		const refresh = (): void => {
			if (!sessionCurrent(owner)) return;
			setCopies({
				id: copyCase,
				copies: [
					...readDraftCopies({
						project,
						id: copyCase,
						...(recordedView ? { recorded: editDraft(recordedView, projectIdentity) } : {}),
					}),
					...(copyCase ? readDraftCopies({ project, id: "" }) : []),
				],
			});
		};
		const changed = (event: StorageEvent): void => {
			if (
				event.key === null ||
				event.key.startsWith(draftCopyPrefix({ project, id: copyCase })) ||
				event.key.startsWith(draftCopyPrefix({ project, id: "" }))
			)
				refresh();
		};
		refresh();
		window.addEventListener("storage", changed);
		window.addEventListener(draftCopiesChanged, refresh);
		return () => {
			window.removeEventListener("storage", changed);
			window.removeEventListener(draftCopiesChanged, refresh);
		};
	}, [project, projectIdentity, copyCase, recordedView, owner]);

	useEffect(() => {
		if (view)
			knownStepIds({
				project,
				id: view.ref,
				ids: [...view.usedStepIds, ...(view.sourceSteps ?? view.steps).map((step) => step.id)],
			});
	}, [view, project]);
	const newId = draft?.ref === null ? draft.id : null;
	const rows = useMemo(() => {
		const result: VisibleRow[] = [];
		let folderId: number | null = null;
		const grouping = Boolean(route.folder && folders.some((folder) => folder.path.startsWith(`${route.folder}/`)));
		const selectedPath = route.folder ? cleanPath(route.folder).join("/").toLowerCase() : null;
		for (const row of cases) {
			if (row.state !== state) continue;
			const folder = folders.find((folder) => folder.id === row.folder);
			const path = folder ? cleanPath(folder.path).join("/").toLowerCase() : null;
			if (selectedPath && path !== null && path !== selectedPath && !path.startsWith(`${selectedPath}/`)) continue;
			if (grouping && folderId !== row.folder) {
				folderId = row.folder;
				const folder = folders.find((item) => item.id === row.folder);
				if (folder) result.push({ kind: "folder", folder, count: folder.cases });
			}
			if (!collapsed.has(row.folder)) result.push({ kind: "case", row });
		}
		for (const [id, local] of captures) {
			if (
				state === "archived" ||
				id === newId ||
				(local.ref && cases.some((row) => row.ref === local.ref)) ||
				(route.folder && local.folder !== route.folder && !local.folder.startsWith(`${route.folder}/`))
			)
				continue;
			const at = result.findIndex((item) =>
				item.kind === "case" ? item.row.ref === local.after : item.kind === "local" ? item.id === local.after : false,
			);
			result.splice(at >= 0 ? at + 1 : 0, 0, { kind: "local", id, draft: local });
		}

		if (newId && state === "active") {
			const after = draftRef.current?.after;
			const at = result.findIndex((item) =>
				item.kind === "case" ? item.row.ref === after : item.kind === "local" ? item.id === after : false,
			);
			result.splice(at >= 0 ? at + 1 : 0, 0, { kind: "draft", id: newId });
		}
		return result;
	}, [cases, captures, collapsed, folders, newId, route.folder, state]);
	const virtual = useVirtualizer({
		count: rows.length,
		getScrollElement: () => viewport.current,
		estimateSize: () => 32,
		overscan: 12,
	});
	useEffect(() => {
		if (text === search) return;
		const timer = setTimeout(() => {
			const params = new URLSearchParams(location.search);
			if (text) params.set("text", text);
			else params.delete("text");
			navigate(`${location.pathname}${params.size ? `?${params}` : ""}`, { replace: true, seal: false });
		}, 80);
		return () => clearTimeout(timer);
	}, [text, search]);
	useEffect(() => {
		if (list.hasNextPage && !list.isFetching) void list.fetchNextPage();
	}, [list.hasNextPage, list.isFetching, list.fetchNextPage]);
	const previousRoute = useRef({ ref: route.ref, folder: route.folder, state });
	useLayoutEffect(() => {
		const previous = previousRoute.current;
		if (previous.state !== state) {
			setPicked(new Set());
			setSelected(route.ref);
		}
		previousRoute.current.state = state;
		if (previous.ref === route.ref && previous.folder === route.folder) return;
		previousRoute.current = { ref: route.ref, folder: route.folder, state };
		const latest = draftRef.current;
		// Sealing gives the live editor its case URL. Its draft is already current, even after storage was cleared.
		if (previous.folder === route.folder && latest && latest.ref === route.ref) return;
		if (latest?.ref === null) setCaptures((prior) => new Map(prior).set(latest.id, latest));
		const historyDraft = z.object({ draft: schemaText }).safeParse(history.state);
		const saved = !route.ref && historyDraft.success ? readDraft({ project, id: historyDraft.data.draft }) : null;
		const restored = saved?.ref === null ? ownedDraft(saved) : null;
		draftRef.current = restored;
		setDraftState(restored);
		setSelected(route.ref);
		setCaptures(readCaptures(project));
	}, [project, route.folder, route.ref, ownedDraft, state]);
	useEffect(() => {
		const first = cases.find((row) => row.state === state);
		if (selected === null && !list.isPlaceholderData && first && !draftRef.current) setSelected(first.ref);
	}, [cases, selected, state, list.isPlaceholderData]);
	function focusDraft(next: Draft): void {
		const target = document.querySelector(
			`#detail [data-field="${next.caret.field === "capture-title" ? "title" : next.caret.field}"]`,
		);
		if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
			focusInto(target);
			target.setSelectionRange(next.caret.start, next.caret.end);
		}
	}
	/** The draft in the pane, when another window removed it and the case has not been read since (`endFollowed`). */
	function endingDraft(): Draft | null {
		const ended = gone.current?.draft;
		return ended && ended === draftRef.current ? ended : null;
	}
	function change(next: Draft, focus = false, selectionOnly = false): void {
		if (!sessionCurrent(owner)) return;
		// Another window's draft that it removed is not stored again from here. The person's own text still is.
		if (endingDraft()?.id === next.id && next.owner !== windowId) return;
		// No draft is made of a case the page owes a read of. `edit` and `begin` read first and open on what comes
		// back. A property changed from the read view comes here: the case is read, and the change is to be made again
		// on the case as read (issue #135 leaves it so: making it after the read raced the person's later choices).
		if (next.ref !== null && owes(next.ref)) {
			void readOwed(next.ref, () => {});
			return;
		}
		const prior = draftRef.current;
		if (!selectionOnly) next = placedDraft(next, recordedView);
		if (selectionOnly && prior?.id === next.id) next = { ...prior, caret: next.caret };
		if (prior?.id === next.id) {
			if (next.base < prior.base) return;
			if (next.base === prior.base)
				next = {
					...prior,
					kind: next.kind,
					body: next.body,
					tagChanges: next.tagChanges,
					covers: next.covers,
					folder: next.folder,
					caret: next.caret,
					dirty: prior.dirty || next.dirty,
				};
		}
		const contentChanged =
			prior &&
			JSON.stringify([prior.body, prior.tagChanges, prior.covers, prior.folder, prior.kind]) !==
				JSON.stringify([next.body, next.tagChanges, next.covers, next.folder, next.kind]);
		const stored = readDraft({ project, id: next.id });
		if (!mayWrite(next.id)) {
			if (stored && (!prior || prior.id !== stored.id)) {
				draftRef.current = stored;
				setDraftState(stored);
			}
			return;
		}
		if (
			stored?.conflict &&
			(!sameBody(stored.body, next.body) ||
				canonicalJson([stored.tagChanges, stored.covers, stored.folder]) !==
					canonicalJson([next.tagChanges, next.covers, next.folder]))
		) {
			draftRef.current = stored;
			liveDrafts.current.set(stored.id, stored);
			setDraftState(stored);
			setStatus(conflictEditorStatus);
			return;
		}
		const changed = {
			...(stored?.conflict ? { ...stored, caret: next.caret } : next),
			sent: prior?.id === next.id ? prior.sent : next.sent,
			conflict: stored?.conflict,
			owner: windowId,
			cmd:
				contentChanged && prior?.id === next.id && prior.sent?.input.cmd === prior.cmd
					? randomId()
					: prior?.id === next.id
						? prior.cmd
						: next.cmd,
			at: Date.now(),
		};
		draftRef.current = changed;
		liveDrafts.current.set(changed.id, changed);
		try {
			if (!writeOwnedDraft(changed)) return;
			setDraftStored(true);
		} catch {
			setDraftStored(false);
			setStatus(draftStorageFull);
		}
		if (focus) {
			flushSync(() => setDraftState(changed));
			focusDraft(changed);
		} else setDraftState(changed);
	}
	function dropEmpty(snapshot: Draft): boolean {
		if (snapshot.ref === null && !hasDraftText(snapshot)) {
			removeOwnedDraft(snapshot.id);
			setCaptures((previous) => {
				if (!previous.has(snapshot.id)) return previous;
				const next = new Map(previous);
				next.delete(snapshot.id);
				return next;
			});
			if (draftRef.current?.id === snapshot.id) {
				draftRef.current = null;
				setDraftState(null);
			}
			return true;
		}
		return false;
	}
	const forgetRequest = useCallback(
		(id: string): void => {
			const latest = readDraft({ project, id });
			if (!latest || !mayWrite(id)) return;
			const cleaned = cleanTitle(latest);
			const next: Draft = {
				...(latest.conflict && hasTypedMerge(latest.conflict)
					? { ...cleaned, body: cardText({ draft: cleaned, conflict: latest.conflict }) }
					: latest),
				sent: null,
				conflict: undefined,
				submission: { kind: "none" },
				cmd: randomId(),
			};
			liveDrafts.current.set(id, next);
			if (draftRef.current?.id === id) {
				draftRef.current = next;
				setDraftState(next);
			}
			if (!writeOwnedDraft(next)) return;
			setCaptures((previous) => new Map(previous).set(id, next));
		},
		[project, mayWrite, writeOwnedDraft],
	);
	const putDraft = useCallback(
		(next: Draft): boolean => {
			if (!writeOwnedDraft(next)) return false;
			followDraft(next);
			return true;
		},
		[writeOwnedDraft, followDraft],
	);
	const dropDraft = useCallback(
		(id: string): void => {
			removeOwnedDraft(id);
			liveDrafts.current.delete(id);
			setCaptures((previous) => {
				const next = new Map(previous);
				next.delete(id);
				return next;
			});
			if (draftRef.current?.id === id) {
				draftRef.current = null;
				setDraftState(null);
			}
		},
		[removeOwnedDraft],
	);
	const preserveRejectedDraft = useCallback(
		(snapshot: Draft): void => {
			if (!sessionCurrent(owner)) return;
			const latest = readDraft({ project, id: snapshot.id }) ?? liveDrafts.current.get(snapshot.id);
			if (!latest || latest.owner !== windowId || !mayWrite(latest.id)) return;
			const command = snapshot.sent?.input.cmd ?? snapshot.cmd;
			if (
				latest.cmd !== snapshot.cmd &&
				latest.sent?.input.cmd !== command &&
				!latest.conflict?.sentMerges.some((sent) => sent.cmd === command)
			)
				return;
			if (!preserveDraftCopy({ project, draft: latest })) {
				setStatus("Device storage is full. Keep this tab open until you have copied the preserved text.");
				return;
			}
			dropDraft(latest.id);
			setStatus(
				"This saved draft cannot be retried here. Its text is preserved separately; you can edit the case again.",
			);
		},
		[project, owner, windowId, mayWrite, dropDraft, setStatus],
	);
	const readForDraft = useCallback(
		async (draft: Draft, input: Api["get"]["input"]) => {
			try {
				return await call("get", { ...input, projectIdentity: draft.projectIdentity }, { project, owner });
			} catch (error) {
				if (obsoleteProject(error)) preserveRejectedDraft(draft);
				throw error;
			}
		},
		[project, owner, preserveRejectedDraft],
	);

	const mayRecover = useCallback(
		(saved: Draft): boolean => {
			if (!saved.projectIdentity || saved.projectIdentity !== projectIdentity) {
				preserveRejectedDraft(saved);
				return false;
			}
			return true;
		},
		[projectIdentity, preserveRejectedDraft],
	);
	useEffect(() => {
		if (displayedDraft) mayRecover(displayedDraft);
	}, [displayedDraft, mayRecover]);
	/**
	 * The draft of a card as it is now, while its conflict is still the question `state` was shown for. Tags and
	 * links typed inline are out of its text and in its lists, as they were when the card's side was made.
	 */
	const cardDraft = useCallback(
		(state: ConflictState): { draft: Draft; conflict: ConflictState } | null => {
			const draft = readDraft({ project, id: state.draftId }) ?? liveDrafts.current.get(state.draftId);
			const conflict = draft?.conflict;
			return draft && conflict?.q === state.q ? { draft: cleanTitle(draft), conflict } : null;
		},
		[project],
	);
	/** A choice or a key changes the merged body and selected order of the stored conflict. */
	const changeCard = useCallback(
		(state: ConflictState): void => {
			const card = cardDraft(state);
			storeConflict(card ? { ...card.conflict, merged: state.merged, stepOrder: state.stepOrder } : state);
		},
		[cardDraft, storeConflict],
	);
	/**
	 * Ends a card whose merge the server recorded: as `version`, or with no version of its own (null). Text
	 * later than that merge stays as a draft (`draftAfterMerge`); with none, the draft is done.
	 */
	const endMergedCard = useCallback(
		async ({
			state,
			sent,
			result,
			done,
		}: {
			state: ConflictState;
			sent: ConflictState["sentMerges"][number];
			result: Extract<MergeFate, { kind: "adopted" | "unchanged" | "waiting" }>;
			done: string;
		}): Promise<void> => {
			const source = cardDraft(state);
			if (!source) return;
			const metadata = mergeMetadata({ ...source, sent });
			const version = result.kind === "adopted" ? result.version : null;
			const waiting = result.kind === "waiting" ? result.question : null;
			const left = (recorded: Parameters<typeof draftAfterMerge>[0]["recorded"]): Draft | null | undefined => {
				const raw = cardDraft(state);
				if (!raw) return undefined;
				const card = sent.tags !== undefined || sent.covers !== undefined ? parsedMergeCard(raw) : raw;
				return (
					draftAfterMerge({
						...card,
						sent: sent.body,
						recorded,
						acceptedMetadata: waiting ? undefined : metadata,
					}) ?? (waiting ? { ...card.draft, body: sent.body, conflict: undefined, sent: null, cmd: randomId() } : null)
				);
			};
			// The case is read before the card ends, with later text to carry or without: the reply names a version
			// and not its text, and the case the page holds may be from before the merge (issue #94). A merge that
			// made a version is read at that version. One that made none (the head held its text already, or it
			// waits for a person) is read as it is now, which is the version the card was shown against or a later one.
			const rows = await readForDraft(source.draft, { refs: [state.ref], ...(version !== null ? { version } : {}) });
			const view = version !== null ? CaseView.parse(rows[0]) : null;
			if (!sessionCurrent(owner) || !mayWrite(state.draftId)) return;
			const remaining = left(
				view && { version: view.version, body: bodyOf(view), tags: view.tags, covers: view.covers },
			);
			const recorded = CaseView.parse(rows[0]);
			const next: Draft | null | undefined =
				remaining && !waiting && version === null && sameBody(remaining.body, sent.body)
					? {
							...remaining,
							base: recorded.version,
							body: bodyOf(recorded),
							original: bodyOf(recorded),
							originalTags: recorded.tags,
							covers: carriedCovers({
								original: remaining.originalCovers,
								mine: remaining.covers,
								recorded: recorded.covers,
							}),
							originalCovers: recorded.covers,
						}
					: remaining && waiting
						? {
								...remaining,
								submission: {
									kind: "waiting",
									question: waiting,
									fingerprint: JSON.stringify({
										body: sent.body,
										tags: draftTags({
											originalTags: remaining.originalTags,
											tagChanges: metadata.tagChanges,
										}),
										tagChanges: metadata.tagChanges,
										covers: applyCoverChanges(remaining.originalCovers, metadata.covers),
										folder: remaining.folder,
									}),
								},
							}
						: remaining;
			if (next === undefined) return;
			holdCase({ ref: state.ref, rows });
			if (next === null) dropDraft(state.draftId);
			else if (!putDraft(next)) return;
			uncertainMerges.current.delete(state.q);
			setStatus(
				next === null || next.submission.kind === "waiting"
					? done
					: next.base === version
						? `Conflict resolved. Your later text is kept on this device as a draft on version ${version}.`
						: "Conflict resolved. Your later text is kept on this device as a draft; leave the editor to propose it.",
			);
			void invalidateProject(project);
			if (next && !waiting && sameBody(next.body, bodyOf(recorded))) await sealRef.current({ saved: next });
		},
		[project, owner, mayWrite, cardDraft, readForDraft, holdCase, putDraft, dropDraft, setStatus],
	);
	/** Acts on what the server recorded for a merge this card sent. False when that merge settled nothing. */
	const settleMerge = useCallback(
		async ({
			state,
			sent,
			fate,
		}: {
			state: ConflictState;
			sent: ConflictState["sentMerges"][number];
			fate: MergeFate;
		}): Promise<boolean> => {
			switch (fate.kind) {
				case "refused": {
					const card = cardDraft(state);
					if (card)
						storeConflict({
							...card.conflict,
							sentMerges: card.conflict.sentMerges.filter((item) => item.cmd !== sent.cmd),
						});
					return false;
				}
				case "moved": {
					const source = cardDraft(state);
					if (!source) return true;
					const rows = await readForDraft(source.draft, { refs: [state.ref] });
					if (!sessionCurrent(owner) || !mayWrite(state.draftId)) return true;
					const card = cardDraft(state);
					if (!card) return true;
					// Nothing of the merge was adopted, so all of the card is still the person's text: what was
					// sent, and what they typed in it since.
					const mine = nextMine({ merged: card.conflict.merged, sent: sent.body });
					const current = bodyOf(CaseView.parse(rows[0]));
					const next = mergeBodies({ base: card.conflict.current, mine, theirs: current });
					storeConflict({
						...card.conflict,
						q: fate.question,
						proposal: fate.proposal,
						base: card.conflict.current,
						mine,
						current,
						merged: next.merged,
						addresses: next.conflicts.map((conflict) => conflict.address),
						metadata: mergeMetadata({ ...card, sent }),
						sentMerges: [],
					});
					uncertainMerges.current.delete(state.q);
					setStatus(
						"Nothing was adopted: the case changed again. Your draft is kept. Resolve the new conflict in the card.",
					);
					void invalidateProject(project);
					return true;
				}
				case "adopted":
					await endMergedCard({
						state,
						sent,
						result: fate,
						done: `Conflict resolved. Version ${fate.version} is recorded; both earlier versions remain in the timeline.`,
					});
					return true;
				case "unchanged":
					await endMergedCard({
						state,
						sent,
						result: fate,
						done: "Conflict resolved. The recorded version already holds this text.",
					});
					return true;
				case "waiting":
					await endMergedCard({
						state,
						sent,
						result: fate,
						done: `Conflict resolved. Your merge is proposed and waits for a person · ${fate.question}`,
					});
					return true;
				default: {
					const _exhaustive: never = fate;
					return _exhaustive;
				}
			}
		},
		[project, owner, mayWrite, cardDraft, readForDraft, storeConflict, endMergedCard, setStatus],
	);
	/**
	 * The card's question is answered. Whether a merge this card sent answered it is asked of the server (the
	 * `command` operation), never judged by comparing what is recorded with what was sent: a merge is recorded
	 * together with newer changes, and the same text can be recorded by somebody else. Any other answer, and a
	 * merge from elsewhere, leave the person's text a draft on the version it was written on, so proposing it
	 * merges with whatever is recorded now, or asks.
	 */
	const settleAnswered = useCallback(
		async (state: ConflictState, answer: string): Promise<void> => {
			const saved = cardDraft(state);
			if (!saved || !mayRecover(saved.draft)) return;
			for (const sent of [...saved.conflict.sentMerges].reverse()) {
				const found = await call("command", { cmd: sent.cmd }, { project, owner });
				if (!sessionCurrent(owner) || !mayWrite(state.draftId)) return;
				if (found.state !== "done") continue;
				if (await settleMerge({ state, sent, fate: mergeFate({ reply: found.reply, ref: state.ref }) })) return;
			}
			const rows = await readForDraft(saved.draft, { refs: [state.ref] });
			if (!sessionCurrent(owner) || !mayWrite(state.draftId)) return;
			const card = cardDraft(state);
			if (!card) return;
			const head = CaseView.parse(rows[0]);
			const typed = hasTypedMerge(card.conflict);
			if (answer === "merge" && allRecorded({ ...card, head: bodyOf(head) })) {
				holdCase({ ref: state.ref, rows });
				dropDraft(state.draftId);
				setStatus(`Conflict resolved elsewhere. Version ${head.version} holds your text.`);
			} else {
				forgetRequest(state.draftId);
				setStatus(
					`The conflict proposal was ${answer === "reject" ? "rejected" : answer === "merge" ? "resolved elsewhere" : "answered elsewhere"}. Your ${typed ? "typed merge" : "current draft"} is kept; leave the editor to propose it afresh.`,
				);
			}
			uncertainMerges.current.delete(state.q);
			void invalidateProject(project);
		},
		[
			project,
			owner,
			mayWrite,
			mayRecover,
			cardDraft,
			readForDraft,
			settleMerge,
			holdCase,
			dropDraft,
			forgetRequest,
			setStatus,
		],
	);
	useEffect(() => {
		const read = CardQuestion.safeParse(conflictQuestion.data?.[0]);
		if (
			ownedElsewhere ||
			!conflict ||
			!read.success ||
			read.data.q !== conflict.q ||
			read.data.state === "open" ||
			resolving.current.has(conflict.q) ||
			uncertainMerges.current.has(conflict.q)
		)
			return;
		resolving.current.add(conflict.q);
		void settleAnswered(conflict, read.data.decision?.answer.is ?? "")
			.catch((error: unknown) =>
				setStatus(errorMessage(error, "Could not read the settled conflict. Your draft is kept.")),
			)
			.finally(() => resolving.current.delete(conflict.q));
	}, [conflict, ownedElsewhere, conflictQuestion.data, settleAnswered, setStatus]);

	async function resolveConflict(state: ConflictState, merged: CaseBody): Promise<void> {
		if (resolving.current.has(state.q) || !mayWrite(state.draftId)) return;
		const saved = cardDraft(state);
		if (!saved || !mayRecover(saved.draft)) return;
		resolving.current.add(state.q);
		let asked = false;
		const question = async () => CardQuestion.parse((await readForDraft(saved.draft, { refs: [state.q] }))[0]);
		try {
			const open = await question();
			// Answered already, perhaps by a merge sent from here whose reply was lost.
			if (open.state !== "open") return await settleAnswered(state, open.decision?.answer.is ?? "");
			const card = cardDraft(state);
			if (!card || !mayWrite(state.draftId)) return;
			// A new id for every attempt. An earlier attempt may still arrive: the server records one of the two
			// and refuses the other, and each id says which.
			const parsed = parseBodyInline(merged, [card.conflict.current, card.conflict.base]);
			const sent = {
				cmd: randomId(),
				body: CaseBody.parse(parsed.body),
				tags: parsed.tags,
				covers: parsed.covers,
			};
			storeConflict({ ...card.conflict, sentMerges: [...card.conflict.sentMerges, sent] });
			if (!mayWrite(state.draftId)) return;
			asked = true;
			const reply = await call(
				"decide",
				{
					q: open.q,
					onEvidence: open.evidenceHash,
					ifOpen: true,
					answer: { is: "merge", body: sent.body, tags: sent.tags, covers: sent.covers },
					cmd: sent.cmd,
					projectIdentity: saved.draft.projectIdentity,
				},
				{ project, owner },
			);
			if (!sessionCurrent(owner) || !mayWrite(state.draftId)) return;
			const fate = mergeFate({ reply, ref: state.ref });
			if ((await settleMerge({ state, sent, fate })) || fate.kind !== "refused") return;
			// Refused. That is what an earlier attempt gets the later one when it arrived first after all.
			const now = await question();
			if (!sessionCurrent(owner) || !mayWrite(state.draftId)) return;
			if (now.state !== "open") return await settleAnswered(state, now.decision?.answer.is ?? "");
			uncertainMerges.current.delete(state.q);
			setStatus(refusedStatus(fate.needs));
		} catch (error) {
			if (obsoleteProject(error)) {
				preserveRejectedDraft(saved.draft);
				return;
			}
			if (!mayWrite(state.draftId)) return;
			if (asked) uncertainMerges.current.add(state.q);
			if (sessionCurrent(owner))
				setStatus(`${errorMessage(error, "Conflict could not be resolved")}. Your draft and conflict card are kept.`);
		} finally {
			resolving.current.delete(state.q);
		}
	}

	/** A new id for a step of a draft of `id`, as the editor makes one: none this device has seen for the case. */
	const stepIdFor = useCallback(
		(id: string) =>
			(taken: ReadonlySet<string>): string =>
				newStepId(knownStepIds({ project, id, ids: [...taken] })),
		[project],
	);
	/**
	 * Records a draft: sends what it holds, and carries what is typed later onto the version that makes. For a save
	 * whose reply never came (a reload, a closed tab, a dropped connection) the server is asked what became of it
	 * (`command`) first (issue #71). Recorded: its recorded reply is taken, and it is never sent again. Not recorded
	 * (yet: it may still be on its way): that same request goes again under its own id, which the server records
	 * once however many copies arrive. Either way, what was typed since goes out after it under a new id. With
	 * `settleOnly`, only that save is settled, and nothing typed since is sent.
	 */
	async function sealDraft({
		keepalive = false,
		saved,
		settleOnly = false,
	}: {
		keepalive?: boolean;
		saved?: Draft;
		settleOnly?: boolean;
	} = {}): Promise<void> {
		const snapshot = saved ?? draftRef.current;
		if (!sessionCurrent(owner)) return;
		if (snapshot && snapshot === endingDraft() && snapshot.owner !== windowId) return;
		if (snapshot && !mayRecover(snapshot)) return;
		if (!snapshot || !mayWrite(snapshot.id, !snapshot.dirty || !draftStored) || dropEmpty(snapshot)) return;
		if (snapshot.ref && readDraft({ project, id: snapshot.id })?.conflict) return;
		if (!snapshot.dirty) {
			removeOwnedDraft(snapshot.id);
			return;
		}
		liveDrafts.current.set(snapshot.id, snapshot);
		setCaptures((previous) => new Map(previous).set(snapshot.id, snapshot));
		const existing = pending.current.get(snapshot.id);
		if (existing !== undefined) {
			await existing;
			const latest = liveDrafts.current.get(adoptedRefs.current.get(snapshot.id) ?? snapshot.id);
			if (sessionCurrent(owner) && latest?.dirty) await sealDraft({ keepalive, saved: latest });
			return;
		}
		let cleaned = cleanTitle(snapshot);
		let body = recordable(cleaned.body);
		if (settleOnly && !snapshot.sent && snapshot.submission.kind !== "waiting") return;
		// All the draft holds beyond its version is a step still without an action, which no version can take.
		// Nothing is sent, and the draft stays on the device as it is (issue #86).
		if (
			snapshot.ref !== null &&
			!snapshot.sent &&
			holdsUnfinishedStep(cleaned.body) &&
			sameBody(body, snapshot.original) &&
			cleaned.tagChanges.add.length === 0 &&
			cleaned.tagChanges.remove.length === 0 &&
			canonicalJson(cleaned.covers) === canonicalJson(snapshot.originalCovers)
		)
			return;
		if (!snapshot.sent && snapshot.submission.kind === "none") {
			if (!fieldDefinitions) {
				setStatus("Custom field definitions are unavailable. Wait for the Suite to load before saving.");
				return;
			}
			const errors = fieldErrors(body.fields, fieldDefinitions, snapshot.ref ? snapshot.original.fields : undefined);
			if (errors.length) {
				setStatus(errors.join("; "));
				return;
			}
		}
		const source = snapshot;
		const recovered = snapshot.sent;
		const waitingText =
			!recovered && snapshot.submission.kind === "waiting"
				? SubmittedText.parse(JSON.parse(snapshot.submission.fingerprint))
				: null;
		const submitted = recovered ?? waitingText;
		if (submitted) {
			body = submitted.body;
			cleaned = { ...cleaned, covers: submitted.covers };
		}
		const sentTags = recovered?.tags ?? waitingText?.tags ?? draftTags(cleaned);
		const sentTagChanges =
			recovered?.tagChanges ??
			(waitingText
				? (waitingText.tagChanges ?? {
						add: sentTags.filter((tag) => !source.originalTags.includes(tag)),
						remove: source.originalTags.filter((tag) => !sentTags.includes(tag)),
					})
				: cleaned.tagChanges);
		const tagsToPlace = {
			add: sentTagChanges.add.filter((tag) => !source.originalTags.includes(tag)),
			remove: sentTagChanges.remove.filter((tag) => source.originalTags.includes(tag)),
		};
		// What the reply handled below was given for: the draft's text, or the save of unknown fate it is about.
		const proposed = JSON.stringify({ body, tags: sentTags, covers: cleaned.covers, folder: snapshot.folder });
		let moreToSend = false;
		let reply: Api["propose"]["reply"] | null = null;
		const task = (async () => {
			try {
				let recorded = false;
				if (snapshot.submission.kind === "waiting") {
					const question = AdoptionQuestion.parse(
						(await readForDraft(snapshot, { refs: [snapshot.submission.question] }))[0],
					);
					if (!sessionCurrent(owner) || !mayWrite(source.id, !draftStored)) return;
					if (question.state === "open") {
						setStatus(waitingStatus("Proposed", question.q));
						return;
					}
					if (question.decision?.answer.is !== "accept" || question.decision.effects.rejected) {
						forgetRequest(snapshot.id);
						setStatus(`The proposal was not accepted. ${draftKept}`);
						return;
					}
					reply = {
						status: "adopted",
						proposal: null,
						question: question.q,
						needs: null,
						cases: question.decision.effects.cases ?? [],
						placements: [],
						conflicts: [],
					};
					recorded = true;
				}
				let after = snapshot.after;
				if (after?.startsWith("draft:")) {
					const predecessor = after;
					const request = pending.current.get(predecessor);
					if (request !== undefined) await request;
					if (!sessionCurrent(owner)) return;
					after = adoptedRefs.current.get(predecessor) ?? null;
				}
				const edits: Edit[] =
					snapshot.ref === null
						? [
								{
									op: "create",
									kind: snapshot.kind ?? "case",
									body,
									...(snapshot.folder ? { folder: snapshot.folder } : {}),
									tags: draftTags(cleaned),
									covers: cleaned.covers,
									...(after ? { after } : {}),
								},
							]
						: [
								{
									op: "edit",
									case: snapshot.ref,
									base: snapshot.base,
									body: {
										...body,
										fields:
											canonicalJson(body.fields) === canonicalJson(snapshot.original.fields) ? undefined : body.fields,
									},
								},
								...(tagsToPlace.add.length || tagsToPlace.remove.length
									? [
											{
												op: "place",
												cases: [source.ref ?? ""],
												tags: tagsToPlace,
											} satisfies Edit,
										]
									: []),
								...cleaned.covers
									.filter((requirement) => !source.originalCovers.includes(requirement))
									.map(
										(requirement) => ({ op: "cover", case: source.ref ?? "", requirement, on: true }) satisfies Edit,
									),
								...source.originalCovers
									.filter((requirement) => !cleaned.covers.includes(requirement))
									.map(
										(requirement) => ({ op: "cover", case: source.ref ?? "", requirement, on: false }) satisfies Edit,
									),
							];
				// The reply was given to the save of unknown fate, and is read now (`command`), not just received.
				if (recovered && !reply) {
					if (!sessionCurrent(owner) || !mayWrite(source.id, !draftStored)) return;
					let fate: Api["command"]["reply"];
					try {
						fate = await call("command", { cmd: recovered.input.cmd ?? "" }, { project, owner });
					} catch (error) {
						// Nothing is known, so nothing is sent. The draft keeps the save, and the next leave asks again.
						if (sessionCurrent(owner) && mayWrite(source.id, !draftStored)) {
							const reason = errorMessage(error, "Could not ask what became of the last save");
							setStatus(keptFailure(reason));
						}
						return;
					}
					if (!sessionCurrent(owner) || !mayWrite(source.id, !draftStored)) return;
					if (fate.state === "begun") {
						setStatus(`Your last save of this draft is still being recorded. ${draftKept}`);
						return;
					}
					if (fate.state === "done") {
						reply = ProposeReply.parse(fate.reply);
						recorded = true;
					}
					// `none` is "not recorded yet": the save may still be on its way. The one request that cannot be
					// recorded twice is that save itself, under its own id, so it goes again unchanged, and what was
					// typed since follows it under a new id (the review of the first fix for #71, B1).
				}
				if (!reply) {
					const request = recovered?.input ?? { cmd: source.cmd, edits, projectIdentity: source.projectIdentity };
					if (!sessionCurrent(owner) || !mayWrite(source.id, !draftStored)) return;
					const sent = recovered ?? {
						input: request,
						body,
						tags: sentTags,
						covers: cleaned.covers,
						tagChanges: sentTagChanges,
					};
					const outgoing = liveDrafts.current.get(source.id);
					if (outgoing?.id === source.id) {
						const sending = {
							...cleanTitle(outgoing),
							body: recovered
								? outgoing.body
								: mergeBodies({
										base: snapshot.body,
										mine: outgoing.body,
										theirs: asTyped({ typed: snapshot.body, stored: cleaned.body }),
									}).merged,
							sent,
						};
						liveDrafts.current.set(sending.id, sending);
						if (draftRef.current?.id === sending.id) {
							draftRef.current = sending;
							setDraftState(sending);
						}
						try {
							if (!writeOwnedDraft(sending)) return;
						} catch {}
					}
					try {
						reply = await call("propose", request, { project, keepalive, owner });
					} catch (error) {
						if (obsoleteProject(error)) {
							preserveRejectedDraft(source);
							return;
						}
						if (
							error instanceof ApiError &&
							error.status !== null &&
							error.code !== "internal" &&
							error.code !== "busy" &&
							sessionCurrent(owner) &&
							mayWrite(source.id, !draftStored)
						)
							forgetRequest(source.id);
						throw error;
					}
					if (!sessionCurrent(owner) || !mayWrite(source.id, !draftStored)) return;
				}
				if (reply.status === "conflict" || reply.status === "rejected") forgetRequest(snapshot.id);
				if (reply.status === "conflict" && reply.question && snapshot.ref && reply.proposal) {
					const proposal = (await readForDraft(snapshot, { refs: [reply.proposal] }))[0];
					if (!mayWrite(source.id, !draftStored)) return;
					const rawEdits = proposal && Array.isArray(proposal.edits) ? proposal.edits : [];
					const edit = rawEdits
						.map((item: unknown) => ResolvedEdit.safeParse(item))
						.find((item) => item.success && item.data.case === snapshot.ref);
					const currentBody = edit?.success ? CaseBody.parse(edit.data.current) : body;
					const latest = liveDrafts.current.get(snapshot.id) ?? snapshot;
					const mine = sentBody(latest);
					const merged = mergeBodies({ base: latest.original, mine, theirs: currentBody });
					const conflict: ConflictState = {
						q: reply.question,
						proposal: reply.proposal,
						base: latest.original,
						ref: snapshot.ref,
						mine,
						current: currentBody,
						merged: merged.merged,
						addresses: merged.conflicts.map((conflict) => conflict.address),
						metadata: {
							tagChanges: sentTagChanges,
							covers: {
								add: cleaned.covers.filter((link) => !source.originalCovers.includes(link)),
								remove: source.originalCovers.filter((link) => !cleaned.covers.includes(link)),
							},
						},
						sentMerges: [],
						draftId: snapshot.id,
					};
					storeConflict(conflict);
					if (draftRef.current?.id === snapshot.id) {
						setStatus("Both edits are kept. Choose each field to resolve the conflict.");
					} else setStatus(`${snapshot.ref} has a conflict. Its draft is kept; return to the case to resolve it.`);
					return;
				}
				if (reply.status === "open") {
					if (reply.question) {
						const latest = liveDrafts.current.get(snapshot.id) ?? snapshot;
						const next: Draft = {
							...latest,
							cmd: randomId(),
							submission: { kind: "waiting", question: reply.question, fingerprint: proposed },
						};
						if (!putDraft(next)) return;
					}
					setStatus(waitingStatus("Proposed", reply.question));
					return;
				}
				if (reply.status === "rejected") {
					setStatus(`The proposal was rejected. ${draftKept}`);
					return;
				}
				const stamp = reply.cases.find((item) => snapshot.ref === null || item.ref === snapshot.ref);
				const ref = stamp?.ref ?? snapshot.ref;
				let version = stamp?.version ?? snapshot.base;
				let adopted = body;
				let adoptedTags = sentTags;
				let adoptedCovers = cleaned.covers;
				if (ref) {
					const rows = await readForDraft(snapshot, { refs: [ref], ...(stamp ? { version } : {}) });
					if (!sessionCurrent(owner)) return;
					if (!mayWrite(source.id, !draftStored)) return;
					const received = CaseView.parse(rows[0]);
					version = received.version;
					adopted = bodyOf(received);
					adoptedTags = received.tags;
					adoptedCovers = received.covers;
					holdCase({ ref, rows: [received] });
					void queryClient.cancelQueries({
						queryKey: [project, "find"],
						predicate: (query) => query.state.data !== undefined,
					});
					queryClient.setQueriesData<{
						pages: { items: Record<string, unknown>[]; count: number | null; cursor: string | null }[];
						pageParams: unknown[];
					}>({ queryKey: [project, "find"] }, (cached) =>
						cached && "pages" in cached
							? {
									...cached,
									pages: cached.pages.map((page) => ({
										...page,
										items: page.items.map((row) =>
											row.ref === ref && (typeof row.version !== "number" || row.version < received.version)
												? {
														...row,
														title: received.title,
														version: received.version,
														hash: received.hash,
														tags: received.tags,
														steps: received.steps.length,
														proof: received.proof,
														updatedAt: received.updated.at,
													}
												: row,
										),
									})),
								}
							: cached,
					);
				}
				if (ref) {
					promoteStepIds({ project, from: snapshot.id, to: ref });
					adoptedRefs.current.set(snapshot.id, ref);
					setCaptures((previous) => {
						if (!previous.has(snapshot.id)) return previous;
						const next = new Map(previous);
						next.set(snapshot.id, {
							...snapshot,
							ref,
							base: version,
							body: adopted,
							original: adopted,
							dirty: false,
							submission: { kind: "none" },
						});
						return next;
					});
				}
				removeOwnedDraft(snapshot.id);
				const latest = liveDrafts.current.get(snapshot.id);
				let unfinished = false;
				if (latest && ref) {
					const normalized = cleanTitle(latest);
					const normalizedBody = recordable(normalized.body);
					const tagChanges = remainingTagChanges({ sent: sentTagChanges, current: normalized.tagChanges });
					const more =
						tagChanges.add.length > 0 ||
						tagChanges.remove.length > 0 ||
						JSON.stringify({ body: normalizedBody, covers: normalized.covers }) !==
							JSON.stringify({ body, covers: cleaned.covers });
					const merged = carried({ sent: body, live: latest.body, recorded: adopted, newId: stepIdFor(ref) });
					// A step with an expected result and no action yet is in no version. Its draft stays on the device,
					// and is not sent again for it: `more` is only what a version can take.
					unfinished = holdsUnfinishedStep(merged);
					const keepTitleFocus =
						document.activeElement instanceof HTMLElement && document.activeElement.dataset.field === "capture-title";
					const next: Draft = {
						...latest,
						id: ref,
						ref,
						base: version,
						body: merged,
						original: adopted,
						submission: { kind: "none" },
						tagChanges,
						covers: carriedCovers({ original: cleaned.covers, mine: normalized.covers, recorded: adoptedCovers }),
						originalTags: adoptedTags,
						originalCovers: adoptedCovers,
						sent: null,
						dirty: more || unfinished,
						cmd: randomId(),
						caret: latest.caret.field === "capture-title" ? { ...latest.caret, field: "title" } : latest.caret,
					};
					liveDrafts.current.delete(snapshot.id);
					liveDrafts.current.set(next.id, next);
					setCaptures((previous) => {
						const captures = new Map(previous);
						captures.delete(snapshot.id);
						if (next.dirty) captures.set(next.id, next);
						return captures;
					});
					if (draftRef.current?.id === snapshot.id) {
						draftRef.current = next;
						// Events from the old editor must not put the draft back on its earlier version.
						flushSync(() => setDraftState(next));
						if (keepTitleFocus) focusDraft(next);
						setSelected(ref);
						if (route.screen === "case" || snapshot.ref === null)
							navigate(`${refUrl({ project, ref })}${location.search}`, {
								replace: true,
								seal: false,
								ifCurrent: navigation,
							});
					}
					moreToSend = more;
					if (next.dirty && !writeOwnedDraft(next)) return;
				}
				const held = unfinished
					? ". A step with no action yet is not in it, and stays in your draft on this device."
					: "";
				setStatus(
					!recorded
						? `Version ${version}, by you, just now${held}`
						: stamp
							? `Your last save is recorded as version ${version}${held}`
							: `Your last save changed nothing: the case already held it${held}`,
				);
				void invalidateProject(project);
			} catch (error) {
				if (!sessionCurrent(owner) || !mayWrite(snapshot.id, !draftStored)) return;
				const reason = errorMessage(error, "Could not record this version");
				setStatus(keptFailure(reason));
			}
		})();
		pending.current.set(snapshot.id, task);
		await task;
		pending.current.delete(snapshot.id);
		if (moreToSend && !settleOnly && sessionCurrent(owner)) {
			const latest = liveDrafts.current.get(adoptedRefs.current.get(snapshot.id) ?? snapshot.id);
			if (latest?.dirty) await sealDraft({ keepalive, saved: latest });
		}
	}
	useEffect(() => {
		const current = draft;
		if (
			!current ||
			current !== draftRef.current ||
			!recordedView ||
			current.ref !== recordedView.ref ||
			current.owner !== windowId ||
			gone.current?.draft === current
		)
			return;
		const next = placedDraft(current, recordedView);
		if (canonicalJson([next.folder, next.originalTags]) === canonicalJson([current.folder, current.originalTags]))
			return;
		followDraft(next);
		try {
			if (next.dirty && mayWrite(next.id)) writeOwnedDraft(next);
		} catch {
			setDraftStored(false);
		}
	}, [recordedView, draft, windowId, followDraft, mayWrite, writeOwnedDraft]);
	useEffect(() => {
		const current = draft;
		if (
			recordedView &&
			current === draftRef.current &&
			current?.ref === recordedView.ref &&
			!current.dirty &&
			current.submission.kind === "none" &&
			current.base < recordedView.version
		) {
			const original = bodyOf(recordedView);
			const next: Draft = {
				...current,
				base: recordedView.version,
				body: carried({
					sent: current.original,
					live: current.body,
					recorded: original,
					newId: stepIdFor(recordedView.ref),
				}),
				original,
				covers: recordedView.covers,
				originalTags: recordedView.tags,
				originalCovers: recordedView.covers,
				folder: recordedView.folder.path,
				cmd: randomId(),
			};
			draftRef.current = next;
			setDraftState(next);
		}
	}, [recordedView, stepIdFor, draft]);
	const sealRef = useRef(sealDraft);
	sealRef.current = sealDraft;
	const waiting = [...captures.values()].filter(
		(draft) =>
			Boolean(projectIdentity) &&
			draft.submission.kind === "waiting" &&
			draft.owner === windowId &&
			draft.projectIdentity === projectIdentity,
	);
	const waitingQuestions = useQueryOp({
		project,
		op: "get",
		input: {
			projectIdentity,
			refs: waiting.flatMap((draft) => (draft.submission.kind === "waiting" ? [draft.submission.question] : [])),
		},
		enabled: waiting.length > 0,
	});
	useEffect(() => {
		for (const [error, drafts] of [
			[conflictQuestion.error, displayedDraft ? [displayedDraft] : []],
			[waitingQuestions.error, waiting],
		] as const)
			if (obsoleteProject(error)) for (const draft of drafts) preserveRejectedDraft(draft);
	}, [conflictQuestion.error, displayedDraft, waitingQuestions.error, waiting, preserveRejectedDraft]);

	useEffect(() => {
		for (const item of waitingQuestions.data ?? []) {
			const question = CardQuestion.safeParse(item);
			if (!question.success || question.data.state === "open") continue;
			for (const draft of liveDrafts.current.values()) {
				if (
					draft.submission.kind === "waiting" &&
					draft.submission.question === question.data.q &&
					draft.owner === windowId &&
					!pending.current.has(draft.id)
				)
					void sealRef.current({ saved: draft, settleOnly: true });
			}
		}
	}, [waitingQuestions.data, windowId]);
	/**
	 * A save of the draft in the pane whose reply never came is asked about as soon as the draft is here, once for
	 * each save: after a reload, or when a draft a closed tab left is opened (issue #73). It is settled (`settleOnly`):
	 * a recorded save is taken as it was recorded, one not recorded goes again under its own id, and nothing typed
	 * since is sent. The draft is then on the version that save made, so a tab closed again soon after sends the
	 * person's newer text on the right version.
	 */
	const askedSaves = useRef(new Set<string>());
	useEffect(() => {
		const cmd = draft?.sent?.input.cmd;
		if (
			!draft ||
			!cmd ||
			draft.submission.kind === "waiting" ||
			draft.owner !== windowId ||
			pending.current.has(draft.id) ||
			askedSaves.current.has(cmd)
		)
			return;
		askedSaves.current.add(cmd);
		void sealRef.current({ saved: draft, settleOnly: true });
	}, [draft, windowId]);
	useEffect(() => {
		const leave = () => {
			void sealRef.current();
		};
		const visibility = () => {
			if (document.visibilityState === "hidden") void sealRef.current({ keepalive: true });
		};
		window.addEventListener("mainworthy:leave", leave);
		document.addEventListener("visibilitychange", visibility);
		return () => {
			window.removeEventListener("mainworthy:leave", leave);
			document.removeEventListener("visibilitychange", visibility);
			if (draftRef.current?.dirty) void sealRef.current();
		};
	}, []);
	useEffect(() => {
		if (!draft?.dirty || conflict || draft.owner !== windowId) return;
		const at = draft.at;
		const timer = setTimeout(
			() => {
				void sealRef.current();
			},
			Math.max(0, 30_000 - (Date.now() - at)),
		);
		return () => clearTimeout(timer);
	}, [draft, conflict, windowId]);
	function leaveEditor(): void {
		void sealDraft();
		if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
		focusInto(viewport.current);
	}
	function create(): void {
		const previous = draftRef.current;
		const retain = previous?.ref === null && hasDraftText(previous);
		if (previous && retain) setCaptures((prior) => new Map([...prior, [previous.id, previous]]));
		void sealDraft();
		const selectedRow = cases.find((item) => item.ref === selected);
		const folder =
			route.folder ?? previous?.folder ?? folders.find((item) => item.id === selectedRow?.folder)?.path ?? "";
		const body = emptyBody();
		const next: Draft = {
			id: `draft:${randomId()}`,
			projectIdentity,
			ref: null,
			base: 0,
			body,
			original: body,
			tagChanges: { add: tagFilter ? tagFilter.split(",") : [], remove: [] },
			covers: [],
			originalTags: [],
			originalCovers: [],
			owner: windowId,
			sent: null,
			folder,
			after: retain && previous ? previous.id : (previous?.ref ?? selectedRow?.ref ?? previous?.after ?? null),
			caret: { field: "title", start: 0, end: 0 },
			dirty: false,
			at: Date.now(),
			cmd: randomId(),
			submission: { kind: "none" },
		};
		flushSync(() => {
			navigate(`/p/${encodeURIComponent(project)}/suite${location.search}`, { seal: false });
			history.replaceState({ draft: next.id }, "");
			draftRef.current = next;
			setDraftState(next);
			setSelected(null);
		});
		try {
			if (!writeOwnedDraft(next)) return;
			setDraftStored(true);
		} catch {
			setDraftStored(false);
			setStatus(draftStorageFull);
		}

		focusDraft(next);
	}
	/** Whether an editor asked for on this case has to wait for the read the page owes of it. */
	function owes(ref: string): boolean {
		return owed.current.has(ref) && draftRef.current?.ref !== ref && !readDraft({ project, id: ref });
	}
	/**
	 * Waits for the read the page owes of a case (`readCase`, one at a time for a case), then runs `open` with the
	 * case as read if it is still the one in the pane. A read that fails opens nothing and says so; the next press
	 * or click reads again.
	 */
	async function readOwed(ref: string, open: (read: CaseView) => void): Promise<void> {
		setStatus("This case changed in another window. Reading it before the editor opens…");
		const read = await readCase(ref);
		// The person may have gone to another case meanwhile: nothing is said or opened there for this one.
		if (!sessionCurrent(owner) || selectedRef.current !== ref) return;
		if ("failure" in read) {
			setStatus(
				`This case changed in another window and could not be read (${read.failure}), so no editor opens on it. Press e to read it again.`,
			);
			return;
		}
		// A draft in the pane came while the read was on its way: another request for it opened it, or another
		// window made it. It is not the case as recorded, and its own line stands.
		if (draftRef.current !== null) return;
		setStatus("The case is shown as the server recorded it.");
		open(CaseView.parse(read.rows[0]));
	}
	/** Opens the editor on the case in the pane, or on `read`, the same case as `readOwed` has just read it. */
	function edit(read: CaseView | null = null): void {
		if (draftRef.current?.ref === null) {
			firstStep({ draft: draftRef.current, change });
			return;
		}
		const ended = endingDraft();
		if (ended) {
			void endFollowed(ended);
			return;
		}
		const shown = read ?? recordedView;
		if (!shown) {
			if (caseReadMessage) setStatus(caseReadMessage);
			return;
		}
		if (owes(shown.ref)) {
			void readOwed(shown.ref, (fresh) => {
				if (draftRef.current === null) edit(fresh);
			});
			return;
		}
		const saved = readDraft({ project, id: shown.ref });
		const next = ownedDraft(
			saved ?? (draftRef.current?.ref === shown.ref ? draftRef.current : editDraft(shown, projectIdentity)),
		);
		change(
			saved ? next : { ...next, caret: { field: "title", start: next.body.title.length, end: next.body.title.length } },
			true,
		);
	}
	/** A click on a field of the read view opens the editor there. `read` is as for `edit`. */
	function begin(field = "title", read: CaseView | null = null): void {
		const shown = read ?? recordedView;
		if (!shown) return;
		if (owes(shown.ref)) {
			void readOwed(shown.ref, (fresh) => {
				if (draftRef.current === null) begin(field, fresh);
			});
			return;
		}
		const next = ownedDraft(readDraft({ project, id: shown.ref }) ?? editDraft(shown, projectIdentity));
		const parts = field.split(":");
		const step = next.body.steps.find((item) => item.id === parts[0]);
		const value =
			field === "title"
				? next.body.title
				: field === "pre"
					? next.body.pre
					: parts[1] === "expected"
						? (step?.expected ?? "")
						: (step?.action ?? "");
		change({ ...next, caret: { field, start: value.length, end: value.length } }, true);
	}
	function takeOver(): void {
		const id = draftRef.current?.id ?? conflict?.draftId;
		const saved = id ? readDraft({ project, id }) : null;
		if (!saved) {
			// Nothing is stored to take over. If the draft shown was removed elsewhere, the case is read again.
			const ended = endingDraft();
			if (ended) void endFollowed(ended);
			return;
		}
		const next = claimCopiedDraft({ project, draft: saved, takeOver: true });
		// A window that only showed the case owns its draft now. The draft opens here, so the card this window is
		// told to resolve is on its screen (review round 9, R9-3).
		if (!draftRef.current) draftRef.current = next;
		followDraft(next);
		setStatus(next.conflict ? conflictEditorStatus : `Continue editing here. ${draftKept}`);
	}
	function choose(ref: string): void {
		if (selected === ref && draftRef.current?.ref !== null) return;
		void sealDraft();
		draftRef.current = null;
		setDraftState(null);
		setSelected(ref);
		setCaptures(readCaptures(project));
		navigate(`${refUrl({ project, ref })}${location.search}`, { seal: false });
	}
	function resumeCapture(saved: Draft): void {
		const previous = draftRef.current;
		if (previous?.dirty) setCaptures((prior) => new Map(prior).set(previous.id, previous));
		const next = ownedDraft(readDraft({ project, id: saved.id }) ?? saved);
		flushSync(() => {
			setSelected(null);
			change(next);
			navigate(`/p/${encodeURIComponent(project)}/suite${location.search}`, { seal: false });
			history.replaceState({ draft: next.id }, "");
		});
		focusDraft(draftRef.current ?? next);
	}
	function stepCursor(direction: number): void {
		const items = rows.filter((item) => item.kind === "case");
		const index = items.findIndex((item) => item.row.ref === selected);
		const next = items[Math.max(0, Math.min(items.length - 1, index + direction))];
		if (next) {
			choose(next.row.ref);
			const at = rows.findIndex((item) => item.kind === "case" && item.row.ref === next.row.ref);
			virtual.scrollToIndex(at, { align: "auto" });
		}
	}
	function withSelection(
		action: (refs: string[], rows: Pick<CaseRow | CaseView, "ref" | "tags" | "folder" | "state">[]) => void,
		refs = selection(),
	): void {
		if (!refs.length) return;
		const missing = new Set(refs);
		const rows = cases.filter((row) => missing.delete(row.ref));
		const unread = [...missing];
		const current = () => sessionCurrent(owner) && navigationToken() === navigation;
		void (async () => {
			const found: CaseView[] = [];
			for (let at = 0; at < unread.length; at += 200)
				found.push(
					...z.array(CaseView).parse(await call("get", { refs: unread.slice(at, at + 200) }, { project, owner })),
				);
			if (current()) action(refs, [...rows, ...found.map((row) => placed(row, placements, folders))]);
		})().catch((error: unknown) => {
			if (current()) setStatus(errorMessage(error, "Could not read selected cases"));
		});
	}
	function optimisticPlacement(edits: Edit[]) {
		const entry: PendingPlacement = { edits };
		const earlier = [...placements];
		setPlacements((prior) => new Set([...prior, entry]));
		const remove = () =>
			setPlacements((prior) => {
				if (!prior.has(entry)) return prior;
				const next = new Set(prior);
				next.delete(entry);
				return next;
			});
		return {
			discard: remove,
			confirm(edits = entry.edits): void {
				entry.edits = edits;
				supersedeMoves(earlier, entry);
				const refs = new Set(
					entry.edits.flatMap((edit) => (edit.op === "place" || edit.op === "state" ? edit.cases : [])),
				);
				const lists = {
					queryKey: [project, "find"],
					predicate: (query: { queryKey: readonly unknown[] }) =>
						query.queryKey[3] === "pages" && z.object({ in: z.literal("cases") }).safeParse(query.queryKey[2]).success,
				};
				const details = {
					queryKey: [project, "get"],
					predicate: (query: { queryKey: readonly unknown[] }) => {
						const input = z.object({ refs: schemaTexts }).safeParse(query.queryKey[2]);
						return input.success && input.data.refs.some((ref) => refs.has(ref));
					},
				};
				// These placements are server facts now. Cancel older reads before holding them, including paged reads.
				void queryClient.cancelQueries(lists);
				void queryClient.cancelQueries(details);
				const apply = (row: Record<string, unknown>, schema: typeof CaseRow | typeof CaseView) => {
					const parsed = schema.safeParse(row);
					return parsed.success ? { ...row, ...placed(parsed.data, [entry], folders) } : row;
				};
				queryClient.setQueriesData<InfiniteData<Api["find"]["reply"]>>(
					lists,
					(cached) =>
						cached && {
							...cached,
							pages: cached.pages.map((page) => ({
								...page,
								items: page.items.map((row) => apply(row, CaseRow)),
							})),
						},
				);
				queryClient.setQueriesData<Api["get"]["reply"]>(details, (cached) =>
					cached?.map((row) => apply(row, CaseView)),
				);
				remove();
			},
			async settle(read: boolean): Promise<void> {
				try {
					if (read && sessionCurrent(owner)) await invalidateProject(project);
				} finally {
					remove();
				}
			},
		};
	}
	async function submitRetained(
		action: RetainedProposal,
		retry: boolean,
		current: () => boolean,
	): Promise<Api["propose"]["reply"] | null> {
		if (retry) {
			const fate = await call("command", { cmd: action.input.cmd }, { project, owner });
			if (!current()) return null;
			if (fate.state === "done") return ProposeReply.parse(fate.reply);
		}
		return call("propose", action.input, { project, owner });
	}
	async function recoverProposal(input: ProposalInput): Promise<Api["propose"]["reply"]> {
		const fate = await call("command", { cmd: input.cmd }, { project, owner });
		return fate.state === "done" ? ProposeReply.parse(fate.reply) : call("propose", input, { project, owner });
	}
	async function placement(edits: Edit[], preview: Edit[]): Promise<void> {
		if (!projectIdentity) return;
		const optimistic = optimisticPlacement(edits);
		const previous = undo.current?.queued ? null : undo.current;
		const input = { edits, cmd: randomId(), projectIdentity };
		const ready = call("propose", input, { project, owner });
		const action: PlacementUndo = { preview, input, cmd: randomId(), ready, queued: false };
		undo.current = action;
		setStatus("Changing cases. Press u to undo.");
		let wantsRead = false;
		try {
			const reply = await ready;
			if (!sessionCurrent(owner)) return;
			if (reply.status !== "adopted") {
				optimistic.discard();
				if (undo.current === action) undo.current = previous;
				setStatus(waitingStatus("Proposed", reply.question ?? ""));
			} else {
				const changed = new Set(reply.placements.flatMap((edit) => edit.cases)).size;
				if (changed) optimistic.confirm();
				else optimistic.discard();
				if (undo.current === action && (!action.queued || !changed)) {
					setStatus(changed ? `${changed} case${changed === 1 ? "" : "s"} changed. Press u to undo.` : nothingPlaced);
				}
			}
			setPicked(new Set());
			wantsRead = !action.queued || reply.status !== "adopted";
		} catch (error) {
			if (!sessionCurrent(owner)) return;
			optimistic.discard();
			if (obsoleteProject(error)) {
				undo.current = null;
				setStatus(placementObsolete);
			} else if (error instanceof ApiError && error.code !== "internal" && error.code !== "busy") {
				if (undo.current === action) undo.current = previous;
				setStatus(error.message);
			} else {
				const reason = errorMessage(error, "Change outcome unknown.");
				setStatus(`${reason}${/[.!?]$/.test(reason) ? "" : "."} Press u to check it and undo.`);
			}
			wantsRead = true;
		} finally {
			await optimistic.settle(wantsRead);
		}
	}
	function move(): void {
		const refs = selection();
		if (!refs.length) return;
		openPalette({
			title: "Move selected cases to a folder",
			items: [
				...(!folders.some((folder) => folder.path === unsorted)
					? [{ id: "root", label: unsorted, handler: () => moveTo(unsorted) }]
					: []),
				...folders.map((folder) => ({
					id: folder.path,
					label: folder.path,
					detail: `${folder.cases} cases`,
					handler: () => moveTo(folder.path),
				})),
			],
		});
	}
	function moveTo(folder: string, refs = selection()): void {
		withSelection((refs, rows) => {
			const preview: Edit[] = rows.map((row) => ({
				op: "place",
				cases: [row.ref],
				folder: typeof row.folder === "number" ? row.folder : row.folder.id,
			}));
			void placement([{ op: "place", cases: refs, folder: folder || unsorted }], preview);
		}, refs);
	}
	function archive(): void {
		withSelection((refs, rows) => {
			const states = new Set(refs.map((ref) => rows.find((row) => row.ref === ref)?.state));
			if (states.has(undefined) || states.size !== 1) {
				setStatus(
					states.has(undefined)
						? "Could not read selected cases. Try again."
						: "Select only active or only archived cases.",
				);
				return;
			}
			const restoring = states.has("archived");
			void placement(
				[{ op: "state", cases: refs, to: restoring ? "active" : "archived" }],
				[{ op: "state", cases: refs, to: restoring ? "archived" : "active" }],
			);
		});
	}
	function tag(): void {
		const value = tagText.trim().replace(/^#/, "");
		if (!selection().length || !value) {
			setTagging(false);
			return;
		}
		withSelection((refs, rows) => {
			setTagging(false);
			retag(refs, rows, value, true);
		});
	}
	function retag(refs: string[], rows: Pick<CaseRow, "ref" | "tags">[], tag: string, add: boolean): void {
		void placement(
			[{ op: "place", cases: refs, tags: { [add ? "add" : "remove"]: [tag] } }],
			[
				{
					op: "place",
					cases: rows.filter((row) => row.tags.includes(tag) !== add).map((row) => row.ref),
					tags: { [add ? "remove" : "add"]: [tag] },
				},
			],
		);
	}
	function removeTag(): void {
		withSelection((refs, rows) =>
			openPalette({
				title: "Remove tag from selected cases",
				items: [...new Set(rows.flatMap((row) => row.tags))].sort().map((tag) => ({
					id: tag,
					label: `#${tag}`,
					handler: () => retag(refs, rows, tag, false),
				})),
			}),
		);
	}
	async function createFolder(): Promise<void> {
		if (!projectIdentity || projectReplaced.current || folderCreation.current?.queued) return;
		const retry = folderCreation.current !== null;
		const action =
			folderCreation.current ??
			({
				input: {
					edits: [{ op: "folder", name: folderText, ...(route.folder ? { parent: route.folder } : {}) }],
					cmd: randomId(),
					projectIdentity,
				},
				queued: false,
			} satisfies RetainedProposal<Extract<Edit, { op: "folder" }>>);
		folderCreation.current = action;
		commandStatus.current++;
		action.queued = true;
		setStatus("Creating folder.");
		try {
			const reply = await submitRetained(action, retry, () => folderCreation.current === action);
			if (!reply || !sessionCurrent(owner) || folderCreation.current !== action) return;
			folderCreation.current = null;
			setCreatingFolder(false);
			setFolderText("");
			setStatus(
				reply.status === "open"
					? waitingStatus("Folder proposed", reply.question)
					: `Folder ${reply.status === "adopted" ? "created" : reply.status}.`,
			);
			void invalidateProject(project);
		} catch (error) {
			if (!sessionCurrent(owner) || folderCreation.current !== action) return;
			if (obsoleteProject(error)) {
				folderCreation.current = null;
				projectReplaced.current = true;
				setCreatingFolder(false);
				setStatus("The project was replaced. Reload before creating folders.");
			} else {
				if (error instanceof ApiError && error.code !== "internal") {
					folderCreation.current = null;
					setStatus(error.message);
				} else {
					const reason = errorMessage(error, "Folder could not be created");
					setStatus(`${reason}${/[.!?]$/.test(reason) ? "" : "."} Press Enter to check it and retry.`);
				}
			}
		} finally {
			action.queued = false;
		}
	}
	async function restoreVersion(): Promise<void> {
		if (projectReplaced.current || versionRestore.current?.queued) return;
		const retry = versionRestore.current !== null;
		if (!versionRestore.current) {
			if (!view || view.version <= 1 || !projectIdentity) return;
			const focused = document.activeElement;
			const raw =
				focused instanceof HTMLElement ? focused.closest("[data-version]")?.getAttribute("data-version") : null;
			const previous = raw && /^\d+$/.test(raw) ? Number(raw) - 1 : view.version - 1;
			if (previous < 1) {
				setStatus("Version 1 is the first version.");
				return;
			}
			versionRestore.current = {
				input: { edits: [{ op: "restore", case: view.ref, to: previous }], cmd: randomId(), projectIdentity },
				queued: false,
			};
		}
		const action = versionRestore.current;
		commandStatus.current++;
		action.queued = true;
		try {
			const reply = await submitRetained(action, retry, () => versionRestore.current === action);
			if (!reply || !sessionCurrent(owner) || versionRestore.current !== action) return;
			versionRestore.current = null;
			// Adopted with no case stamped: the case already holds that content, and nothing was recorded.
			if (reply.status === "adopted" && reply.cases.length === 0)
				setStatus("The case already has that version's content. Nothing changed.");
			else if (reply.status === "adopted") {
				draftRef.current = null;
				setDraftState(null);
				setStatus("Previous version restored as a new version.");
			} else if (reply.status === "open") {
				setStatus(waitingStatus("Restore proposed", reply.question));
			} else if (reply.status === "conflict") {
				setStatus("The restore has a conflict. The case is unchanged.");
			} else setStatus(`The restore was ${reply.status}. The case is unchanged.`);
			void invalidateProject(project);
		} catch (error) {
			if (!sessionCurrent(owner) || versionRestore.current !== action) return;
			if (obsoleteProject(error)) {
				versionRestore.current = null;
				projectReplaced.current = true;
				setStatus(placementObsolete);
			} else {
				if (error instanceof ApiError && error.code !== "internal") {
					versionRestore.current = null;
					setStatus(error.message);
				} else {
					const reason = errorMessage(error, "Undo failed");
					setStatus(`${reason}${/[.!?]$/.test(reason) ? "" : "."} Press u to check it and retry.`);
				}
			}
		} finally {
			action.queued = false;
		}
	}
	async function undoLast(): Promise<void> {
		if (projectReplaced.current) return;
		if (undo.current) {
			const action = undo.current;
			if (action.queued) return;
			action.queued = true;
			const optimistic = optimisticPlacement(action.preview);
			// The queued inverse participates in the projection before the original write replies.
			let wantsRead = false;
			try {
				setStatus("Undo queued. It will follow the pending change.");
				const original = await action.ready.catch(() => recoverProposal(action.input));
				if (original.status !== "adopted") return;
				wantsRead = true;
				const edits = original.placements;
				if (!edits.length) {
					setStatus(nothingPlaced);
					return;
				}
				const reply = await recoverProposal({ ...action.input, edits, cmd: action.cmd });
				if (reply.status === "adopted") {
					optimistic.confirm(edits);
					const changed = reply.placements.length;
					if (undo.current === action && changed) undo.current = null;
					setStatus(changed ? "Undone. The inverse is recorded." : nothingPlaced);
				} else {
					optimistic.discard();
					action.queued = false;
					setStatus(waitingStatus("Undo proposed", reply.question ?? ""));
				}
			} catch (error) {
				optimistic.discard();
				action.queued = false;
				if (obsoleteProject(error)) {
					if (undo.current === action) undo.current = null;
					setStatus(placementObsolete);
				} else setStatus(errorMessage(error, "Undo failed. Press u to retry."));
			} finally {
				void optimistic.settle(wantsRead);
			}
		} else await restoreVersion();
	}
	useEffect(() => {
		const drop = (event: Event) => {
			if (!(event instanceof CustomEvent)) return;
			const detail = z.object({ ref: schemaText, folder: schemaText }).safeParse(event.detail);
			if (detail.success) moveTo(detail.data.folder, [detail.data.ref]);
		};
		window.addEventListener("mainworthy:drop", drop);
		return () => window.removeEventListener("mainworthy:drop", drop);
	});
	useSuiteBindings({
		offerEdit: Boolean(recordedView) && (!draft || ownedElsewhere),
		hasDraft: Boolean(draft),
		canRecord: Boolean(draft && !ownedElsewhere && !conflict),
		create,
		edit: () => edit(),
		next: () => stepCursor(1),
		previous: () => stepCursor(-1),
		filter: () => focusInto(filter.current),
		seal: leaveEditor,
		select: () => {
			if (selected)
				setPicked((prior) => {
					const next = new Set(prior);
					if (!next.delete(selected)) next.add(selected);
					return next;
				});
		},
		move,
		tag: () => setTagging(true),
		removeTag,
		archive,
		restoring,
		undo: () => {
			void undoLast().catch((error: unknown) => setStatus(errorMessage(error, "Undo failed")));
		},
		peek: () => {
			document.querySelector(".timeline-block")?.scrollIntoView({ block: "nearest" });
		},
		folder: (direction) => {
			const at = folders.findIndex((item) => item.path === route.folder);
			const folder = folders[(at + direction + folders.length) % folders.length];
			if (!folder) return;
			const params = new URLSearchParams(location.search);
			params.set("folder", folder.path);
			navigate(`${routeUrl({ project, screen: "suite" })}?${params}`);
		},
		newFolder: () => setCreatingFolder(true),
		zoom: () => document.getElementById("app")?.classList.toggle("zoom"),
		cancelTag: tagging ? () => setTagging(false) : null,
		cancelFolder: creatingFolder ? abandonFolder : null,
	});
	const visibleItems: { index: number; start: number }[] = virtual
		.getVirtualItems()
		.map((item) => ({ index: item.index, start: item.start }));
	const draftIndex = rows.findIndex((item) => item.kind === "draft");
	if (draftIndex >= 0 && !visibleItems.some((item) => item.index === draftIndex))
		visibleItems.push({ index: draftIndex, start: draftIndex * 32 });

	const folderMount = document.getElementById("folder-create");
	return (
		<>
			<section className="pane" id="list">
				<div className="phead">
					<b id="ltitle">{state === "archived" ? "Archived" : (route.folder ?? "All cases")}</b>
					<span id="lcount">
						{list.error
							? "Cases unavailable"
							: list.isPending
								? "Reading cases…"
								: `${(list.data?.pages[0]?.count ?? cases.length).toLocaleString()}${list.data?.pages[0]?.count === null ? "+" : ""} cases`}
					</span>
					{picked.size > 0 && <span className="bulk-indicator">{picked.size} selected</span>}
					<label className="fwrap">
						<span>/</span>
						<input
							ref={filter}
							id="filter"
							aria-label="Filter cases"
							placeholder="Filter this list"
							value={text}
							onChange={(event) => setText(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Escape") {
									event.preventDefault();
									setText("");
									focusInto(viewport.current);
								}
							}}
						/>
					</label>
				</div>
				{tagging && (
					<form
						className="inline-form tag-entry"
						onSubmit={(event) => {
							event.preventDefault();
							tag();
						}}
					>
						<input
							className="form-input"
							aria-label="Tag selected cases"
							placeholder="Tag, then Enter"
							ref={focusOnce}
							value={tagText}
							onChange={(event) => setTagText(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Escape") {
									event.preventDefault();
									setTagging(false);
								}
							}}
						/>
					</form>
				)}
				<div className="psub">
					<span className="id">ID</span>
					<span className="ti">Title</span>
					<span className="pfs">
						<span className="pf">person</span>
						<span className="pf">CI</span>
						<span className="pf">agent</span>
					</span>
				</div>
				<div
					className="scroll-list"
					data-testid="case-list"
					data-loaded={cases.length}
					data-total={list.data?.pages[0]?.count ?? 0}
					ref={viewport}
					tabIndex={0}
					role="listbox"
					aria-label="Cases"
				>
					{list.error && (
						<p role="status">
							{list.error instanceof ApiError && list.error.code === "forbidden"
								? "Your session may not read this project."
								: "Could not read cases."}{" "}
							{list.error.message}{" "}
							<button type="button" onClick={() => void list.refetch()}>
								Retry
							</button>
						</p>
					)}
					{rows.length === 0 ? (
						list.error ? null : (
							<EmptyState
								{...(!list.isPending && !search ? { doc: { page: "write-cases", label: "How to write a case" } } : {})}
							>
								{list.isPending
									? "Reading cases…"
									: state === "archived"
										? "No archived cases match this view."
										: search
											? "No matching cases. Change the filter, or press c to capture one."
											: "No cases yet. Press c and start typing."}
							</EmptyState>
						)
					) : (
						<div style={{ height: `${virtual.getTotalSize()}px`, position: "relative" }}>
							{visibleItems.map((item) => {
								const row = rows[item.index];
								if (!row) return null;
								const saved = row.kind === "case" ? captures.get(row.row.ref) : null;
								return (
									<div
										key={row.kind === "case" ? row.row.ref : row.kind === "folder" ? `folder:${row.folder.id}` : row.id}
										style={{
											position: "absolute",
											top: 0,
											left: 0,
											width: "100%",
											height: "32px",
											transform: `translateY(${item.start}px)`,
										}}
									>
										{row.kind === "folder" ? (
											<button
												type="button"
												className="folder-header"
												aria-expanded={!collapsed.has(row.folder.id)}
												onClick={() =>
													setCollapsed((prior) => {
														const next = new Set(prior);
														if (next.has(row.folder.id)) next.delete(row.folder.id);
														else next.add(row.folder.id);
														return next;
													})
												}
											>
												<span>{collapsed.has(row.folder.id) ? "▸" : "▾"}</span>
												{row.folder.path}
												<span>{row.count}</span>
											</button>
										) : row.kind === "draft" && draft ? (
											<button
												type="button"
												className="capture-row"
												role="option"
												aria-selected={true}
												onClick={() => focusDraft(draft)}
											>
												<span className="capture-ref">new</span>
												<span className="capture-mirror">{draft.body.title || "New case"}</span>
												<span className="dr">draft</span>
											</button>
										) : row.kind === "local" ? (
											<button
												type="button"
												className={`row ${row.draft.ref !== null && row.draft.ref === selected ? "sel" : ""}`}
												role="option"
												aria-selected={row.draft.ref !== null && row.draft.ref === selected}
												onClick={() => {
													if (row.draft.ref) choose(row.draft.ref);
													else resumeCapture(row.draft);
												}}
											>
												<span className="id">{row.draft.ref ?? "new"}</span>
												<span className="ti">{row.draft.body.title}</span>
												<span className="dr">{row.draft.ref ? "" : "draft"}</span>
												<ProofStrip />
											</button>
										) : row.kind === "case" ? (
											<button
												className={`row row-drag ${row.row.ref === selected ? "sel" : ""}`}
												type="button"
												role="option"
												aria-selected={row.row.ref === selected}
												draggable
												onDragStart={(event) => event.dataTransfer.setData("text/plain", row.row.ref)}
												onClick={() => choose(row.row.ref)}
											>
												<span className="id">{row.row.ref}</span>
												{picked.has(row.row.ref) && <span className="selected-check">✓</span>}
												<span className="ti">
													{draft?.ref === row.row.ref
														? draft.body.title
														: saved?.dirty
															? saved.body.title
															: row.row.title}
												</span>
												{row.row.tags.length > 0 && <span className="tg">#{row.row.tags[0]}</span>}
												{(draft?.ref === row.row.ref ? draft.dirty : saved?.dirty) && <span className="dr">draft</span>}
												{row.row.open > 0 && (
													<span className="qdot" title={`${row.row.open} open questions`}>
														●
													</span>
												)}
												<ProofStrip proof={row.row.proof} />
											</button>
										) : null}
									</div>
								);
							})}
						</div>
					)}
				</div>
			</section>
			<CasePane
				fieldDefinitions={fieldDefinitions}
				copies={copies}
				onDiscardCopy={(copy) => {
					discardDraftCopy(copy.key);
					window.dispatchEvent(new Event(draftCopiesChanged));
				}}
				ownedElsewhere={ownedElsewhere}
				ownerLive={!displayedDraft || draftOwnerIsLive(displayedDraft.owner)}
				ending={draft && gone.current?.draft === draft ? ending : null}
				onTakeOver={takeOver}
				view={view}
				readStatus={caseReadMessage === caseLoadingEdit ? "Reading case…" : caseReadMessage}
				draft={draft ? placedDraft(draft, recordedView, placements, folders) : null}
				stored={draftStored}
				change={change}
				begin={begin}
				rapid={create}
				hasDraft={Boolean(selected && captures.get(selected)?.dirty)}
				conflict={draft?.conflict ?? null}
				onConflictChange={changeCard}
				onResolved={resolveConflict}
			/>
			{creatingFolder &&
				folderMount &&
				createPortal(
					<form
						className="inline-form"
						onSubmit={(event) => {
							event.preventDefault();
							void createFolder();
						}}
					>
						<input
							aria-label="New folder name"
							readOnly={folderCreation.current !== null}
							className="form-input"
							ref={focusOnce}
							value={folderText}
							onChange={(event) => setFolderText(event.target.value)}
							placeholder="Folder, then Enter"
							onKeyDown={(event) => {
								if (event.key === "Escape") {
									event.preventDefault();
									abandonFolder();
								}
							}}
						/>
					</form>,
					folderMount,
				)}
		</>
	);
}
