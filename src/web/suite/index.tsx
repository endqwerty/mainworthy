import { useInfiniteQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import { z } from "zod";
import type { Api } from "../../core/api.ts";
import { mergeBodies } from "../../core/merge3.ts";
import { CaseBody, emptyBody, TAG } from "../../core/model.ts";
import type { Edit } from "../../core/ops.ts";
import { cleanTitle, conflictEditorStatus, draftOwnershipStatus, firstStep } from "../case/editor.tsx";
import { CasePane, type ConflictState } from "../case/pane.tsx";
import { ApiError, call } from "../lib/api.ts";
import { invalidateProject, queryClient, useQueryOp } from "../lib/data.ts";
import { deviceSession, sessionCurrent } from "../lib/device.ts";
import {
	activeDraft,
	claimDraft,
	type Draft,
	DraftBody,
	draftKey,
	hasTypedMerge,
	knownStepIds,
	promoteStepIds,
	readDraft,
	readDrafts,
	removeDraft,
	writeDraft,
} from "../lib/drafts.ts";
import { draftOwner, randomId } from "../lib/ids.ts";
import { navigate, readRoute, refUrl, routeEntry, routeUrl } from "../lib/router.ts";
import { useApp } from "../ui/context.tsx";
import { EmptyState, ProofStrip } from "../ui/index.tsx";
import { useSuiteBindings } from "./bindings.ts";
import { bodyOf, CaseRow, CaseView, editDraft, FolderRow } from "./model.ts";
import "./suite.css";
import "../case/case.css";

type VisibleRow =
	| { kind: "case"; row: CaseRow }
	| { kind: "draft"; id: string }
	| { kind: "local"; id: string; draft: Draft }
	| { kind: "folder"; folder: FolderRow; count: number };
type PlacementUndo = { edits: Edit[]; ready: Promise<Api["propose"]["reply"]>; queued: boolean };
const ResolvedEdit = z.object({
	op: z.literal("edit"),
	case: z.string(),
	mine: CaseBody,
	current: CaseBody,
	body: CaseBody,
});

const SettledQuestion = z.object({
	q: z.string(),
	state: z.string(),
	decision: z.object({ answer: z.object({ is: z.string() }) }).nullable(),
});
function sameBody(left: CaseBody, right: CaseBody): boolean {
	return JSON.stringify(DraftBody.parse(left)) === JSON.stringify(DraftBody.parse(right));
}

export function SuiteScreen() {
	const { project, route, setStatus, openPalette, overlayOpen } = useApp();
	const owner = useRef(deviceSession()).current;
	const windowId = useRef(draftOwner()).current;
	const ownedDraft = useCallback((saved: Draft): Draft => claimDraft({ project, draft: saved }), [project]);
	const tagFilter = new URLSearchParams(location.search)
		.getAll("tag")
		.filter((tag) => TAG.test(tag))
		.join(",");
	const [text, setText] = useState("");
	const [search, setSearch] = useState("");
	const [draftStored, setDraftStored] = useState(true);
	const [draft, setDraftState] = useState<Draft | null>(() => {
		const saved =
			routeEntry() === "initial" ? (route.ref ? readDraft({ project, id: route.ref }) : activeDraft(project)) : null;
		return saved?.dirty ? ownedDraft(saved) : null;
	});
	const draftRef = useRef(draft);
	const liveDrafts = useRef(new Map<string, Draft>(draft ? [[draft.id, draft]] : []));
	const [captures, setCaptures] = useState(() => new Map(readDrafts(project).map((draft) => [draft.id, draft])));
	const adoptedRefs = useRef(new Map<string, string>());
	const pending = useRef(new Map<string, Promise<void>>());
	const [selected, setSelected] = useState<string | null>(route.ref);
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
			setStatus(draftOwnershipStatus);
			return false;
		},
		[project, windowId, followDraft, setStatus],
	);
	const writeOwnedDraft = useCallback(
		(next: Draft): boolean => {
			if (writeDraft({ project, draft: next })) return true;
			mayWrite(next.id);
			return false;
		},
		[project, mayWrite],
	);
	const storeConflict = useCallback(
		(state: ConflictState): void => {
			const latest = readDraft({ project, id: state.draftId }) ?? liveDrafts.current.get(state.draftId);
			if (!latest || !mayWrite(state.draftId, !draftStored)) return;
			const next = {
				...latest,
				body:
					latest.conflict && latest.conflict.q !== state.q && sameBody(latest.body, latest.conflict.mine)
						? state.mine
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
				setStatus("Device storage is full. Keep this tab open until the version is recorded.");
			}
			setCaptures((previous) => new Map(previous).set(next.id, next));
			if (draftRef.current?.id === next.id) {
				draftRef.current = next;
				setDraftState(next);
			}
		},
		[project, mayWrite, writeOwnedDraft, draftStored, setStatus],
	);
	useEffect(() => {
		const changed = (event: StorageEvent): void => {
			if (!sessionCurrent(owner) || (event.key !== null && !event.key.startsWith(draftKey({ project, id: "" }))))
				return;
			setCaptures(new Map(readDrafts(project).map((saved) => [saved.id, saved])));
			const current = draftRef.current;
			if (!current || (event.key !== null && event.key !== draftKey({ project, id: current.id }))) return;
			const saved = readDraft({ project, id: current.id });
			if (saved) liveDrafts.current.set(saved.id, saved);
			else liveDrafts.current.delete(current.id);
			draftRef.current = saved;
			setDraftState(saved);
			if (saved && saved.owner !== windowId) setStatus(draftOwnershipStatus);
			else if (saved?.conflict) setStatus(conflictEditorStatus);
			else if (saved && !current.conflict) return;
			else {
				setStatus(
					saved
						? "The conflict ended in another window. Your current draft is kept and editable."
						: "Conflict resolved in another window. The recorded version is shown.",
				);
				void invalidateProject(project);
			}
		};
		window.addEventListener("storage", changed);
		return () => window.removeEventListener("storage", changed);
	}, [project, owner, windowId, setStatus]);
	const conflictQuestion = useQueryOp({
		project,
		op: "get",
		input: { refs: [conflict?.q ?? ""] },
		enabled: Boolean(conflict),
	});

	const [picked, setPicked] = useState(new Set<string>());
	const [hidden, setHidden] = useState(new Set<string>());
	const [collapsed, setCollapsed] = useState(new Set<number>());
	const [tagging, setTagging] = useState(false);
	const [tagText, setTagText] = useState("");
	const [creatingFolder, setCreatingFolder] = useState(false);
	const [folderText, setFolderText] = useState("");
	const undo = useRef<PlacementUndo | null>(null);
	const viewport = useRef<HTMLDivElement>(null);
	const filter = useRef<HTMLInputElement>(null);
	const foldersQuery = useQueryOp({ project, op: "find", input: { in: "folders" } });
	const folders = useMemo(() => z.array(FolderRow).parse(foldersQuery.data?.items ?? []), [foldersQuery.data]);
	const input = useMemo(
		() =>
			({
				in: "cases",
				limit: 500,
				...(route.folder ? { folder: route.folder, deep: true } : {}),
				...(search ? { text: search } : {}),
				...(tagFilter ? { tags: tagFilter.split(",") } : {}),
			}) satisfies Parameters<typeof call<"find">>[1],
		[route.folder, search, tagFilter],
	);
	const list = useInfiniteQuery({
		queryKey: [project, "find", input, "pages"],
		initialPageParam: "",
		queryFn: ({ pageParam, signal }) =>
			call("find", { ...input, ...(pageParam ? { cursor: pageParam } : {}) }, { project, signal }),
		getNextPageParam: (last) => last.cursor ?? undefined,
		placeholderData: (previous) => previous,
	});
	const cases = useMemo(
		() => z.array(CaseRow).parse(list.data?.pages.flatMap((page) => page.items) ?? []),
		[list.data],
	);
	const current = useQueryOp({
		project,
		op: "get",
		input: { refs: [selected ?? "C-0"] },
		enabled: selected !== null && !selected.startsWith("draft:"),
	});
	const view = useMemo(() => {
		const parsed = CaseView.safeParse(current.data?.find((item) => item.ref === selected));
		return parsed.success ? parsed.data : null;
	}, [current.data, selected]);
	useEffect(() => {
		if (view) knownStepIds({ project, id: view.ref, ids: [...view.usedStepIds, ...view.steps.map((step) => step.id)] });
	}, [view, project]);
	const newId = draft?.ref === null ? draft.id : null;
	const rows = useMemo(() => {
		const result: VisibleRow[] = [];
		let folderId: number | null = null;
		const grouping = Boolean(route.folder && folders.some((folder) => folder.path.startsWith(`${route.folder}/`)));
		for (const row of cases) {
			if (hidden.has(row.ref)) continue;
			if (grouping && folderId !== row.folder) {
				folderId = row.folder;
				const folder = folders.find((item) => item.id === row.folder);
				if (folder) result.push({ kind: "folder", folder, count: folder.cases });
			}
			if (!collapsed.has(row.folder)) result.push({ kind: "case", row });
		}
		for (const [id, local] of captures) {
			if (
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

		if (newId) {
			const after = draftRef.current?.after;
			const at = result.findIndex((item) =>
				item.kind === "case" ? item.row.ref === after : item.kind === "local" ? item.id === after : false,
			);
			result.splice(at >= 0 ? at + 1 : 0, 0, { kind: "draft", id: newId });
		}
		return result;
	}, [cases, captures, collapsed, folders, hidden, newId, route.folder]);
	const virtual = useVirtualizer({
		count: rows.length,
		getScrollElement: () => viewport.current,
		estimateSize: () => 32,
		overscan: 12,
	});
	useEffect(() => {
		const timer = setTimeout(() => setSearch(text), 80);
		return () => clearTimeout(timer);
	}, [text]);
	useEffect(() => {
		if (list.hasNextPage && !list.isFetchingNextPage) void list.fetchNextPage();
	}, [list.hasNextPage, list.isFetchingNextPage, list.fetchNextPage]);
	const previousRoute = useRef({ ref: route.ref, folder: route.folder });
	useEffect(() => {
		const previous = previousRoute.current;
		if (previous.ref === route.ref && previous.folder === route.folder) return;
		previousRoute.current = { ref: route.ref, folder: route.folder };
		const latest = draftRef.current;
		// Sealing gives the live editor its case URL. Its draft is already current, even after storage was cleared.
		if (previous.folder === route.folder && latest && latest.ref === route.ref) return;
		if (latest?.ref === null) setCaptures((prior) => new Map(prior).set(latest.id, latest));
		const historyDraft = z.object({ draft: z.string() }).safeParse(history.state);
		const saved = !route.ref && historyDraft.success ? readDraft({ project, id: historyDraft.data.draft }) : null;
		const restored = saved?.ref === null ? ownedDraft(saved) : null;
		draftRef.current = restored;
		setDraftState(restored);
		setSelected(route.ref);
		setCaptures(new Map(readDrafts(project).map((saved) => [saved.id, saved])));
	}, [project, route.folder, route.ref, ownedDraft]);
	useEffect(() => {
		if (selected === null && cases[0] && !draftRef.current) setSelected(cases[0].ref);
	}, [cases, selected]);
	function focusDraft(next: Draft): void {
		const target = document.querySelector(
			`#detail [data-field="${next.caret.field === "capture-title" ? "title" : next.caret.field}"]`,
		);
		if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
			target.focus();
			target.setSelectionRange(next.caret.start, next.caret.end);
		}
	}
	function change(next: Draft, focus = false): void {
		if (!sessionCurrent(owner)) return;
		const prior = draftRef.current;
		const contentChanged =
			prior &&
			JSON.stringify([prior.body, prior.tags, prior.covers, prior.folder]) !==
				JSON.stringify([next.body, next.tags, next.covers, next.folder]);
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
				JSON.stringify([stored.tags, stored.covers, stored.folder]) !==
					JSON.stringify([next.tags, next.covers, next.folder]))
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
			setStatus("Device storage is full. Keep this tab open until the version is recorded.");
		}
		if (focus) {
			flushSync(() => setDraftState(changed));
			focusDraft(changed);
		} else setDraftState(changed);
	}
	function dropEmpty(snapshot: Draft): boolean {
		if (
			snapshot.ref === null &&
			!snapshot.body.title.trim() &&
			!snapshot.body.steps.some((step) => step.action.trim())
		) {
			removeDraft({ project, id: snapshot.id });
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
			const next = {
				...latest,
				body: latest.conflict && hasTypedMerge(latest.conflict) ? latest.conflict.merged : latest.body,
				sent: null,
				conflict: undefined,
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
	const finishConflict = useCallback(
		(state: ConflictState, head: CaseView, removeUnchanged: boolean, sent?: CaseBody): void => {
			if (!sessionCurrent(owner) || !mayWrite(state.draftId)) return;
			const stored = readDraft({ project, id: state.draftId });
			if (stored?.conflict && stored.conflict.q !== state.q) return;
			const recorded = bodyOf(head);
			// Is there text in the card that the recorded merge does not hold? With the merge that was sent in hand,
			// only a card that differs from it does: the head can differ from what was sent because the server
			// combined it with a colleague's newer change, and that is not the person's later text. Without it (the
			// question was answered elsewhere, or the page was reloaded), a field typed by hand is.
			const laterMerge =
				stored?.conflict &&
				sameBody(stored.body, state.mine) &&
				!sameBody(stored.conflict.merged, recorded) &&
				(sent ? !sameBody(stored.conflict.merged, sent) : hasTypedMerge(stored.conflict))
					? stored.conflict.merged
					: null;
			const remove =
				!stored ||
				sameBody(laterMerge ?? stored.body, recorded) ||
				(!laterMerge && removeUnchanged && stored.conflict?.q === state.q && sameBody(stored.body, state.mine));
			if (remove) {
				removeDraft({ project, id: state.draftId });
				liveDrafts.current.delete(state.draftId);
				setCaptures((previous) => {
					const next = new Map(previous);
					next.delete(state.draftId);
					return next;
				});
				if (draftRef.current?.id === state.draftId) {
					draftRef.current = null;
					setDraftState(null);
				}
			} else {
				const next: Draft = {
					...stored,
					body: laterMerge ?? stored.body,
					base: head.version,
					original: recorded,
					originalTags: head.tags,
					originalCovers: head.covers,
					conflict: undefined,
					sent: null,
					cmd: randomId(),
				};
				if (!writeOwnedDraft(next)) return;
				liveDrafts.current.set(next.id, next);
				setCaptures((previous) => new Map(previous).set(next.id, next));
				if (draftRef.current?.id === next.id) {
					draftRef.current = next;
					setDraftState(next);
				}
			}
			uncertainMerges.current.delete(state.q);
			queryClient.setQueryData([project, "get", { refs: [head.ref] }], [head]);
			setStatus(
				remove
					? `Conflict resolved. Version ${head.version} is recorded; both earlier versions remain in the timeline.`
					: `Conflict resolved. Your later text is kept on this device as a draft on version ${head.version}.`,
			);
			void invalidateProject(project);
		},
		[project, owner, mayWrite, writeOwnedDraft, setStatus],
	);
	const releaseSettledConflict = useCallback(
		async (state: ConflictState, answer: string): Promise<void> => {
			const rows = await call("get", { refs: [state.ref] }, { project, owner });
			if (!sessionCurrent(owner) || !mayWrite(state.draftId)) return;
			const head = CaseView.parse(rows[0]);
			if (answer === "merge") {
				const sent = readDraft({ project, id: state.draftId })?.conflict?.sentMerge;
				finishConflict(state, head, sameBody(bodyOf(head), sent ?? state.merged), sent);
			} else {
				const stored = readDraft({ project, id: state.draftId });
				if (stored?.conflict?.q !== state.q) return;
				forgetRequest(state.draftId);
				setStatus(
					`The conflict proposal was ${answer === "reject" ? "rejected" : "answered elsewhere"}. Your ${hasTypedMerge(stored.conflict) ? "typed merge" : "current draft"} is kept; leave the editor to propose it afresh.`,
				);
			}
		},
		[project, owner, mayWrite, finishConflict, forgetRequest, setStatus],
	);
	useEffect(() => {
		const read = SettledQuestion.safeParse(conflictQuestion.data?.[0]);
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
		void releaseSettledConflict(conflict, read.data.decision?.answer.is ?? "")
			.catch((error: unknown) =>
				setStatus(error instanceof Error ? error.message : "Could not read the settled conflict. Your draft is kept."),
			)
			.finally(() => resolving.current.delete(conflict.q));
	}, [conflict, ownedElsewhere, conflictQuestion.data, releaseSettledConflict, setStatus]);

	async function resolveConflict(state: ConflictState, merged: CaseBody): Promise<void> {
		if (resolving.current.has(state.q) || !mayWrite(state.draftId)) return;
		resolving.current.add(state.q);
		let sent: CaseBody | undefined;
		try {
			const questions = await call("inbox", { on: state.ref, kind: "adopt" }, { project, owner });
			const question = questions.items.find((item) => item.q === state.q);
			if (!question) {
				const rows = await call("get", { refs: [state.q] }, { project, owner });
				const settled = SettledQuestion.parse(rows[0]);
				await releaseSettledConflict(state, settled.decision?.answer.is ?? "");
				return;
			}
			if (!mayWrite(state.draftId)) return;
			sent = CaseBody.parse(merged);
			storeConflict({ ...state, sentMerge: sent });
			if (!mayWrite(state.draftId)) return;
			const reply = await call(
				"decide",
				{ q: question.q, onEvidence: question.evidenceHash, answer: { is: "merge", body: merged } },
				{ project, owner },
			);
			if (!sessionCurrent(owner) || !mayWrite(state.draftId)) return;
			const outcome = reply[0];
			const moved = z
				.object({ status: z.literal("conflict"), proposal: z.string(), adopt: z.string() })
				.safeParse(outcome?.effects);
			if (moved.success) {
				const rows = await call("get", { refs: [state.ref] }, { project, owner });
				if (!sessionCurrent(owner) || !mayWrite(state.draftId)) return;
				const current = bodyOf(CaseView.parse(rows[0]));
				const nextMerge = mergeBodies({ base: state.current, mine: merged, theirs: current });
				storeConflict({
					...state,
					q: moved.data.adopt,
					sentMerge: undefined,
					proposal: moved.data.proposal,
					base: state.current,
					mine: merged,
					current,
					merged: nextMerge.merged,
					paths: nextMerge.conflicts.map((conflict) => conflict.path),
				});
				setStatus(
					"Nothing was adopted: the case changed again. Your draft is kept. Resolve the new conflict in the card.",
				);
				void invalidateProject(project);
				return;
			}
			if (outcome?.status !== "decided") {
				setStatus(outcome?.needs ?? "The evidence changed. Your draft and conflict card are kept.");
				return;
			}
			const rows = await call("get", { refs: [state.ref] }, { project, owner });
			if (!sessionCurrent(owner) || !mayWrite(state.draftId)) return;
			finishConflict(state, CaseView.parse(rows[0]), true, merged);
		} catch (error) {
			if (!mayWrite(state.draftId)) return;
			if (sent) uncertainMerges.current.add(state.q);
			if (sessionCurrent(owner))
				setStatus(
					`${error instanceof Error ? error.message : "Conflict could not be resolved"}. Your draft and conflict card are kept.`,
				);
		} finally {
			resolving.current.delete(state.q);
		}
	}

	async function sealDraft({ keepalive = false, saved }: { keepalive?: boolean; saved?: Draft } = {}): Promise<void> {
		const snapshot = saved ?? draftRef.current;
		if (!sessionCurrent(owner)) return;
		if (!snapshot || !mayWrite(snapshot.id, !snapshot.dirty || !draftStored) || dropEmpty(snapshot)) return;
		if (snapshot.ref && readDraft({ project, id: snapshot.id })?.conflict) return;
		if (!snapshot.dirty) {
			removeDraft({ project, id: snapshot.id });
			return;
		}
		liveDrafts.current.set(snapshot.id, snapshot);
		setCaptures((previous) => new Map(previous).set(snapshot.id, snapshot));
		const existing = pending.current.get(snapshot.id);
		if (existing) {
			await existing;
			const latest = liveDrafts.current.get(adoptedRefs.current.get(snapshot.id) ?? snapshot.id);
			if (sessionCurrent(owner) && latest?.dirty) await sealDraft({ keepalive, saved: latest });
			return;
		}
		let cleaned = cleanTitle(snapshot);
		let body: CaseBody = {
			...cleaned.body,
			steps: cleaned.body.steps
				.filter((step) => step.action.trim())
				.map((step) => ({ ...step, expected: step.expected || null })),
		};
		const fingerprint = JSON.stringify({ body, tags: cleaned.tags, covers: cleaned.covers, folder: snapshot.folder });
		if (snapshot.submission.kind === "waiting" && snapshot.submission.fingerprint === fingerprint) return;
		const source = snapshot;
		const recovered = snapshot.sent;
		if (recovered) {
			body = recovered.body;
			cleaned = { ...cleaned, tags: recovered.tags, covers: recovered.covers };
		}
		let moreToSend = false;
		const task = (async () => {
			try {
				let after = snapshot.after;
				if (after?.startsWith("draft:")) {
					const predecessor = after;
					const request = pending.current.get(predecessor);
					if (request) await request;
					if (!sessionCurrent(owner)) return;
					after = adoptedRefs.current.get(predecessor) ?? null;
				}
				const edits: Edit[] =
					snapshot.ref === null
						? [
								{
									op: "create",
									body,
									...(snapshot.folder ? { folder: snapshot.folder } : {}),
									tags: cleaned.tags,
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
										title: body.title,
										pre: body.pre,
										steps: body.steps,
										methods: body.methods,
										automate: body.automate,
									},
								},
								...(cleaned.tags.some((tag) => !source.originalTags.includes(tag)) ||
								source.originalTags.some((tag) => !cleaned.tags.includes(tag))
									? [
											{
												op: "place",
												cases: [source.ref ?? ""],
												tags: {
													add: cleaned.tags.filter((tag) => !source.originalTags.includes(tag)),
													remove: source.originalTags.filter((tag) => !cleaned.tags.includes(tag)),
												},
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
				const request = recovered?.input ?? { cmd: source.cmd, edits };
				if (!sessionCurrent(owner) || !mayWrite(source.id, !draftStored)) return;
				const sent = recovered ?? { input: request, body, tags: cleaned.tags, covers: cleaned.covers };
				const outgoing = liveDrafts.current.get(source.id);
				if (outgoing?.id === source.id) {
					const sending = { ...outgoing, sent };
					liveDrafts.current.set(sending.id, sending);
					if (draftRef.current?.id === sending.id) {
						draftRef.current = sending;
						setDraftState(sending);
					}
					try {
						if (!writeOwnedDraft(sending)) return;
					} catch {}
				}
				const reply = await call("propose", request, { project, keepalive, owner });
				if (!sessionCurrent(owner) || !mayWrite(source.id, !draftStored)) return;
				if (reply.status === "conflict" || reply.status === "rejected") forgetRequest(snapshot.id);
				if (reply.status === "conflict" && reply.question && snapshot.ref && reply.proposal) {
					const proposal = (await call("get", { refs: [reply.proposal] }, { project, owner }))[0];
					if (!mayWrite(source.id, !draftStored)) return;
					const rawEdits = proposal && Array.isArray(proposal.edits) ? proposal.edits : [];
					const edit = rawEdits
						.map((item: unknown) => ResolvedEdit.safeParse(item))
						.find((item) => item.success && item.data.case === snapshot.ref);
					const currentBody = edit?.success ? CaseBody.parse(edit.data.current) : body;
					const latest = liveDrafts.current.get(snapshot.id) ?? snapshot;
					const normalized = cleanTitle(latest);
					const mine = {
						...normalized.body,
						steps: normalized.body.steps
							.filter((step) => step.action.trim())
							.map((step) => ({ ...step, expected: step.expected || null })),
					};
					const merged = mergeBodies({ base: latest.original, mine, theirs: currentBody });
					const conflict: ConflictState = {
						q: reply.question,
						proposal: reply.proposal,
						base: latest.original,
						ref: snapshot.ref,
						mine,
						current: currentBody,
						merged: merged.merged,
						paths: merged.conflicts.map((conflict) => conflict.path),
						draftId: snapshot.id,
					};
					storeConflict(conflict);
					if (draftRef.current?.id === snapshot.id) {
						setStatus("Both edits are kept. Choose each field to resolve the conflict.");
					} else setStatus(`${snapshot.ref} has a conflict. Its draft is kept; return to the case to resolve it.`);
					return;
				}
				if (reply.status === "open") {
					if (reply.question && draftRef.current?.id === snapshot.id) {
						const latest = draftRef.current;
						const next: Draft = {
							...latest,
							cmd: randomId(),
							sent: null,
							submission: { kind: "waiting", question: reply.question, fingerprint },
						};
						draftRef.current = next;
						setDraftState(next);
						if (!writeOwnedDraft(next)) return;
					}
					setStatus(`Proposed, waiting for a person${reply.question ? ` · ${reply.question}` : ""}`);
					return;
				}
				if (reply.status === "rejected") {
					setStatus("The proposal was rejected. Your draft is kept on this device.");
					return;
				}
				const stamp = reply.cases.find((item) => snapshot.ref === null || item.ref === snapshot.ref);
				const ref = stamp?.ref ?? snapshot.ref;
				const version = stamp?.version ?? snapshot.base;
				let adopted = body;
				let adoptedTags = cleaned.tags;
				let adoptedCovers = cleaned.covers;
				if (ref) {
					const rows = await call("get", { refs: [ref], version }, { project, owner });
					if (!sessionCurrent(owner)) return;
					if (!mayWrite(source.id, !draftStored)) return;
					const received = CaseView.parse(rows[0]);
					adopted = bodyOf(received);
					adoptedTags = received.tags;
					adoptedCovers = received.covers;
					queryClient.setQueryData([project, "get", { refs: [ref] }], [received]);
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
											row.ref === ref
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
				removeDraft({ project, id: snapshot.id });
				const latest = liveDrafts.current.get(snapshot.id);
				if (latest && ref) {
					const normalized = cleanTitle(latest);
					const normalizedBody = {
						...normalized.body,
						steps: normalized.body.steps
							.filter((step) => step.action.trim())
							.map((step) => ({ ...step, expected: step.expected || null })),
					};
					const more =
						JSON.stringify({ body: normalizedBody, tags: normalized.tags, covers: normalized.covers }) !==
						JSON.stringify({ body, tags: cleaned.tags, covers: cleaned.covers });
					const keepTitleFocus =
						document.activeElement instanceof HTMLElement && document.activeElement.dataset.field === "capture-title";
					const next: Draft = {
						...latest,
						id: ref,
						ref,
						base: version,
						body: mergeBodies({ base: body, mine: normalized.body, theirs: adopted }).merged,
						original: adopted,
						submission: { kind: "none" },
						tags: [
							...new Set([
								...adoptedTags.filter((tag) => !cleaned.tags.includes(tag) || normalized.tags.includes(tag)),
								...normalized.tags.filter((tag) => !cleaned.tags.includes(tag)),
							]),
						],
						covers: [
							...new Set([
								...adoptedCovers.filter((link) => !cleaned.covers.includes(link) || normalized.covers.includes(link)),
								...normalized.covers.filter((link) => !cleaned.covers.includes(link)),
							]),
						],
						originalTags: adoptedTags,
						originalCovers: adoptedCovers,
						sent: null,
						dirty: more,
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
						if (keepTitleFocus) {
							flushSync(() => setDraftState(next));
							focusDraft(next);
						} else setDraftState(next);
						setSelected(ref);
						if (
							readRoute().project === project &&
							(readRoute().screen === "case" || readRoute().screen === "suite") &&
							(route.screen === "case" || snapshot.ref === null)
						)
							navigate(`${refUrl({ project, ref })}${location.search}`, { replace: true, seal: false });
					}
					moreToSend = more;
					if (more && !writeOwnedDraft(next)) return;
				}
				setStatus(`Version ${version}, by you, just now`);
				void invalidateProject(project);
			} catch (error) {
				if (!sessionCurrent(owner) || !mayWrite(snapshot.id, !draftStored)) return;
				if (error instanceof ApiError) forgetRequest(snapshot.id);
				setStatus(
					`${error instanceof Error ? error.message : "Could not record this version"}. Your draft is kept on this device.`,
				);
			}
		})();
		pending.current.set(snapshot.id, task);
		await task;
		pending.current.delete(snapshot.id);
		if (moreToSend && sessionCurrent(owner)) {
			const latest = liveDrafts.current.get(adoptedRefs.current.get(snapshot.id) ?? snapshot.id);
			if (latest?.dirty) await sealDraft({ keepalive, saved: latest });
		}
	}
	useEffect(() => {
		const current = draftRef.current;
		if (
			view &&
			current?.ref === view.ref &&
			!current.dirty &&
			current.submission.kind === "none" &&
			current.base !== view.version &&
			!pending.current.has(current.id)
		) {
			const original = bodyOf(view);
			const next: Draft = {
				...current,
				base: view.version,
				body: mergeBodies({ base: current.original, mine: current.body, theirs: original }).merged,
				original,
				tags: view.tags,
				covers: view.covers,
				originalTags: view.tags,
				originalCovers: view.covers,
				folder: view.folder.path,
				cmd: randomId(),
			};
			draftRef.current = next;
			setDraftState(next);
		}
	}, [view]);
	const sealRef = useRef(sealDraft);
	sealRef.current = sealDraft;
	useEffect(() => {
		const leave = () => {
			void sealRef.current();
		};
		const visibility = () => {
			if (document.visibilityState === "hidden") void sealRef.current({ keepalive: true });
		};
		window.addEventListener("casebook:leave", leave);
		document.addEventListener("visibilitychange", visibility);
		return () => {
			window.removeEventListener("casebook:leave", leave);
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
		viewport.current?.focus();
	}
	function create(): void {
		const previous = draftRef.current;
		const retain =
			previous?.ref === null &&
			(previous.body.title.trim().length > 0 || previous.body.steps.some((step) => step.action.trim().length > 0));
		if (previous && retain) setCaptures((prior) => new Map([...prior, [previous.id, previous]]));
		void sealDraft();
		const selectedRow = cases.find((item) => item.ref === selected);
		const folder =
			route.folder ?? previous?.folder ?? folders.find((item) => item.id === selectedRow?.folder)?.path ?? "";
		const body = emptyBody();
		const next: Draft = {
			id: `draft:${randomId()}`,
			ref: null,
			base: 0,
			body,
			original: body,
			tags: tagFilter ? tagFilter.split(",") : [],
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
			setStatus("Device storage is full. Keep this tab open until the version is recorded.");
		}

		focusDraft(next);
	}
	function edit(): void {
		if (draftRef.current?.ref === null) {
			firstStep({ draft: draftRef.current, change });
			return;
		}
		if (!view) return;
		const saved = readDraft({ project, id: view.ref });
		const next = ownedDraft(saved ?? (draftRef.current?.ref === view.ref ? draftRef.current : editDraft(view)));
		change(
			saved ? next : { ...next, caret: { field: "title", start: next.body.title.length, end: next.body.title.length } },
			true,
		);
	}
	function takeOver(): void {
		const id = draftRef.current?.id ?? conflict?.draftId;
		const saved = id ? readDraft({ project, id }) : null;
		if (!saved) return;
		const next = claimDraft({ project, draft: saved, takeOver: true });
		followDraft(next);
		setStatus(next.conflict ? conflictEditorStatus : "Continue editing here. Your draft is kept on this device.");
	}
	function choose(ref: string): void {
		if (selected === ref && draftRef.current?.ref !== null) return;
		void sealDraft();
		draftRef.current = null;
		setDraftState(null);
		setSelected(ref);
		setCaptures(new Map(readDrafts(project).map((saved) => [saved.id, saved])));
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
	const selection = () => (picked.size ? [...picked] : selected ? [selected] : []);
	function optimisticPlacement(edits: Edit[]): () => void {
		const listKey = [project, "find", input, "pages"];
		const oldList = queryClient.getQueryData<typeof list.data>(listKey);
		const detailKey = [project, "get", { refs: [selected ?? "C-0"] }];
		const oldDetail = queryClient.getQueryData<Api["get"]["reply"]>(detailKey);
		const oldDraft = draftRef.current;
		function patch(row: Record<string, unknown>, full: boolean): Record<string, unknown> {
			let next = row;
			const ref = row.ref;
			if (typeof ref !== "string") return row;
			for (const edit of edits) {
				if ((edit.op !== "place" && edit.op !== "state") || !edit.cases.includes(ref)) continue;
				if (edit.op === "state") {
					next = { ...next, state: edit.to };
					continue;
				}
				if (edit.tags) {
					const existing = z.array(z.string()).safeParse(next.tags);
					const tags = new Set(edit.tags.set ?? (existing.success ? existing.data : []));
					for (const tag of edit.tags.add ?? []) tags.add(tag);
					for (const tag of edit.tags.remove ?? []) tags.delete(tag);
					next = { ...next, tags: [...tags] };
				}
				if (edit.folder !== undefined) {
					const folder = folders.find((item) =>
						typeof edit.folder === "number" ? item.id === edit.folder : item.path === edit.folder,
					);
					if (folder) next = { ...next, folder: full ? { id: folder.id, path: folder.path } : folder.id };
				}
			}
			return next;
		}
		queryClient.setQueryData<typeof list.data>(listKey, (cached) =>
			cached
				? {
						...cached,
						pages: cached.pages.map((page) => ({ ...page, items: page.items.map((row) => patch(row, false)) })),
					}
				: cached,
		);
		queryClient.setQueryData<Api["get"]["reply"]>(detailKey, (cached) => cached?.map((row) => patch(row, true)));
		if (oldDraft?.ref) {
			const changed = patch({ ref: oldDraft.ref, tags: oldDraft.tags }, true);
			const tags = z.array(z.string()).parse(changed.tags);
			change({ ...oldDraft, tags });
		}
		return () => {
			queryClient.setQueryData(listKey, oldList);
			queryClient.setQueryData(detailKey, oldDetail);
			if (oldDraft && draftRef.current?.id === oldDraft.id) change({ ...draftRef.current, tags: oldDraft.tags });
		};
	}
	async function placement(edits: Edit[], inverse: Edit[]): Promise<void> {
		const rollback = optimisticPlacement(edits);
		const previous = undo.current?.queued ? null : undo.current;
		const count = selection().length;
		const ready = call("propose", { edits }, { project, owner });
		const action: PlacementUndo = { edits: inverse, ready, queued: false };
		undo.current = action;
		setStatus(`${count} case${count === 1 ? "" : "s"} changing. Press u to undo.`);
		try {
			const reply = await ready;
			if (!sessionCurrent(owner)) return;
			if (reply.status !== "adopted") {
				rollback();
				setHidden(new Set());
				if (undo.current === action) undo.current = previous;
				setStatus(`Proposed, waiting for a person · ${reply.question ?? ""}`);
			} else if (!action.queued && undo.current === action) {
				setStatus(`${count} case${count === 1 ? "" : "s"} changed. Press u to undo.`);
			}
			setPicked(new Set());
			if (!action.queued || reply.status !== "adopted") await invalidateProject(project);
		} catch (error) {
			if (!sessionCurrent(owner)) return;
			rollback();
			setHidden(new Set());
			if (undo.current === action) undo.current = previous;
			setStatus(error instanceof Error ? error.message : "The change failed");
		}
	}
	function move(): void {
		const refs = selection();
		if (!refs.length) return;
		openPalette({
			title: "Move selected cases to a folder",
			items: [
				...(!folders.some((folder) => folder.path === "Unsorted")
					? [{ id: "root", label: "Unsorted", handler: () => moveTo("Unsorted") }]
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
		if (!refs.length) return;
		const inverse: Edit[] = folders
			.filter((item) => cases.some((row) => refs.includes(row.ref) && row.folder === item.id))
			.map((item) => ({
				op: "place",
				cases: cases.filter((row) => refs.includes(row.ref) && row.folder === item.id).map((row) => row.ref),
				folder: item.path,
			}));
		const rootRefs = cases
			.filter((row) => refs.includes(row.ref) && !folders.some((folder) => folder.id === row.folder))
			.map((row) => row.ref);
		if (rootRefs.length) inverse.push({ op: "place", cases: rootRefs, folder: "Unsorted" });
		if (route.folder && folder !== route.folder && !folder.startsWith(`${route.folder}/`))
			setHidden((prior) => new Set([...prior, ...refs]));
		void placement([{ op: "place", cases: refs, folder: folder || "Unsorted" }], inverse);
	}
	function archive(): void {
		const refs = selection();
		if (!refs.length) return;
		setHidden((prior) => new Set([...prior, ...refs]));
		void placement([{ op: "state", cases: refs, to: "archived" }], [{ op: "state", cases: refs, to: "active" }]);
	}
	function tag(): void {
		const refs = selection();
		const value = tagText.trim().replace(/^#/, "");
		if (!refs.length || !value) {
			setTagging(false);
			return;
		}
		const added = cases.filter((row) => refs.includes(row.ref) && !row.tags.includes(value)).map((row) => row.ref);
		setTagging(false);
		void placement(
			[{ op: "place", cases: refs, tags: { add: [value] } }],
			added.length ? [{ op: "place", cases: added, tags: { remove: [value] } }] : [],
		);
	}
	async function undoLast(): Promise<void> {
		if (undo.current) {
			const action = undo.current;
			if (action.queued) return;
			action.queued = true;
			const rollback = optimisticPlacement(action.edits);
			setHidden(new Set());
			setStatus("Undo queued. It will follow the pending change.");
			let original: Api["propose"]["reply"];
			try {
				original = await action.ready;
			} catch {
				return;
			}
			if (original.status !== "adopted") return;
			optimisticPlacement(action.edits);
			try {
				const reply = action.edits.length
					? await call("propose", { edits: action.edits }, { project, owner })
					: original;
				if (reply.status === "adopted") {
					if (undo.current === action) undo.current = null;
					setStatus("Undone. The inverse change is recorded.");
				} else {
					rollback();
					action.queued = false;
					setStatus(`Undo proposed, waiting for a person · ${reply.question ?? ""}`);
				}
			} catch (error) {
				rollback();
				action.queued = false;
				setStatus(error instanceof Error ? error.message : "Undo failed. Press u to retry.");
			}
			void invalidateProject(project);
		} else if (view && view.version > 1) {
			const focused = document.activeElement;
			const raw =
				focused instanceof HTMLElement ? focused.closest("[data-version]")?.getAttribute("data-version") : null;
			const previous = raw && /^\d+$/.test(raw) ? Number(raw) - 1 : view.version - 1;
			if (previous < 1) {
				setStatus("Version 1 is the first version.");
				return;
			}
			await call("propose", { edits: [{ op: "restore", case: view.ref, to: previous }] }, { project, owner });
			draftRef.current = null;
			setDraftState(null);
			setStatus("Previous version restored as a new version.");
			void invalidateProject(project);
		}
	}
	useEffect(() => {
		const drop = (event: Event) => {
			if (!(event instanceof CustomEvent)) return;
			const detail = z.object({ ref: z.string(), folder: z.string() }).safeParse(event.detail);
			if (detail.success) moveTo(detail.data.folder, [detail.data.ref]);
		};
		window.addEventListener("casebook:drop", drop);
		return () => window.removeEventListener("casebook:drop", drop);
	});
	useSuiteBindings({
		enabled: !overlayOpen,
		create,
		edit,
		next: () => stepCursor(1),
		previous: () => stepCursor(-1),
		filter: () => filter.current?.focus(),
		seal: leaveEditor,
		rapid: create,
		select: () => {
			if (selected)
				setPicked((prior) => {
					const next = new Set(prior);
					if (next.has(selected)) next.delete(selected);
					else next.add(selected);
					return next;
				});
		},
		move,
		tag: () => setTagging(true),
		archive,
		undo: () => {
			void undoLast().catch((error: unknown) => setStatus(error instanceof Error ? error.message : "Undo failed"));
		},
		peek: () => {
			document.querySelector(".timeline-block")?.scrollIntoView({ block: "nearest" });
		},
		folder: (direction) => {
			const at = folders.findIndex((item) => item.path === route.folder);
			const folder = folders[(at + direction + folders.length) % folders.length];
			if (folder) navigate(routeUrl({ project, screen: "suite", folder: folder.path }));
		},
		newFolder: () => setCreatingFolder(true),
		zoom: () => document.getElementById("app")?.classList.toggle("zoom"),
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
					<b id="ltitle">{route.folder ?? "All cases"}</b>
					<span id="lcount">
						{list.error
							? "Cases unavailable"
							: list.isPending
								? "Reading cases…"
								: `${(list.data?.pages[0]?.count ?? cases.length).toLocaleString()} cases`}
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
									viewport.current?.focus();
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
							ref={(node) => {
								node?.focus();
							}}
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
							<EmptyState>
								{list.isPending
									? "Reading cases…"
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
				ownedElsewhere={ownedElsewhere}
				onTakeOver={takeOver}
				view={view}
				draft={draft}
				stored={draftStored}
				change={change}
				begin={(field = "title") => {
					if (view) {
						const next = ownedDraft(readDraft({ project, id: view.ref }) ?? editDraft(view));
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
				}}
				seal={leaveEditor}
				rapid={create}
				hasDraft={Boolean(selected && captures.get(selected)?.dirty)}
				conflict={draft?.conflict ?? null}
				onConflictChange={storeConflict}
				onResolved={resolveConflict}
			/>
			{creatingFolder &&
				folderMount &&
				createPortal(
					<form
						className="inline-form"
						onSubmit={(event) => {
							event.preventDefault();
							void call(
								"propose",
								{ edits: [{ op: "folder", name: folderText, ...(route.folder ? { parent: route.folder } : {}) }] },
								{ project, owner },
							)
								.then(() => {
									setCreatingFolder(false);
									setFolderText("");
									void invalidateProject(project);
								})
								.catch((error: unknown) =>
									setStatus(error instanceof Error ? error.message : "Folder could not be created"),
								);
						}}
					>
						<input
							aria-label="New folder name"
							className="form-input"
							ref={(node) => {
								node?.focus();
							}}
							value={folderText}
							onChange={(event) => setFolderText(event.target.value)}
							placeholder="Folder, then Enter"
							onKeyDown={(event) => {
								if (event.key === "Escape") {
									event.preventDefault();
									setCreatingFolder(false);
								}
							}}
						/>
					</form>,
					folderMount,
				)}
		</>
	);
}
