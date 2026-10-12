import { useInfiniteQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import { z } from "zod";
import type { Api } from "../../core/api.ts";
import { mergeBodies } from "../../core/merge3.ts";
import { CaseBody, emptyBody } from "../../core/model.ts";
import type { Edit } from "../../core/ops.ts";
import { cleanTitle, firstStep, pasteCapture } from "../case/editor.tsx";
import { CasePane, type ConflictState } from "../case/pane.tsx";
import { call } from "../lib/api.ts";
import { invalidateProject, queryClient, useQueryOp } from "../lib/data.ts";
import { activeDraft, type Draft, promoteStepIds, readDraft, removeDraft, writeDraft } from "../lib/drafts.ts";
import { navigate, readRoute, refUrl, routeUrl } from "../lib/router.ts";
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
const ResolvedEdit = z.object({
	op: z.literal("edit"),
	case: z.string(),
	mine: CaseBody,
	current: CaseBody,
	body: CaseBody,
});

export function SuiteScreen() {
	const { project, route, setStatus, openPalette, overlayOpen } = useApp();
	const [text, setText] = useState("");
	const [search, setSearch] = useState("");
	const [draft, setDraftState] = useState<Draft | null>(() => {
		const saved = route.ref ? readDraft({ project, id: route.ref }) : activeDraft(project);
		return saved?.dirty || saved?.ref === null ? saved : null;
	});
	const draftRef = useRef(draft);
	const [captures, setCaptures] = useState(new Map<string, Draft>());
	const adoptedRefs = useRef(new Map<string, string>());
	const pending = useRef(new Map<string, Promise<void>>());
	const [conflict, setConflict] = useState<ConflictState | null>(null);
	const [selected, setSelected] = useState<string | null>(route.ref);
	const [picked, setPicked] = useState(new Set<string>());
	const [hidden, setHidden] = useState(new Set<string>());
	const [collapsed, setCollapsed] = useState(new Set<number>());
	const [tagging, setTagging] = useState(false);
	const [tagText, setTagText] = useState("");
	const [creatingFolder, setCreatingFolder] = useState(false);
	const [folderText, setFolderText] = useState("");
	const undo = useRef<Edit[] | null>(null);
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
			}) satisfies Parameters<typeof call<"find">>[1],
		[route.folder, search],
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
	const previousFolder = useRef(route.folder);
	useEffect(() => {
		if (previousFolder.current !== route.folder) {
			previousFolder.current = route.folder;
			draftRef.current = null;
			setDraftState(null);
			setConflict(null);
			setSelected(route.ref);
		}
	}, [route.folder, route.ref]);
	useEffect(() => {
		if (route.ref !== selected && route.ref !== null) {
			setSelected(route.ref);
			const saved = readDraft({ project, id: route.ref });
			draftRef.current = saved;
			setDraftState(saved);
			setConflict(null);
		}
	}, [project, route.ref, selected]);
	useEffect(() => {
		if (selected === null && cases[0] && !draftRef.current) setSelected(cases[0].ref);
	}, [cases, selected]);
	useEffect(() => {
		if (view && !draftRef.current) {
			const saved = readDraft({ project, id: view.ref });
			if (saved?.dirty) {
				draftRef.current = saved;
				setDraftState(saved);
			}
		}
	}, [project, view]);
	function focusDraft(next: Draft): void {
		const target = document.querySelector(`[data-field="${next.caret.field}"]`);
		if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
			target.focus();
			target.setSelectionRange(next.caret.start, next.caret.end);
		}
	}
	function change(next: Draft, focus = false): void {
		const changed = { ...next, at: Date.now() };
		draftRef.current = changed;
		try {
			writeDraft({ project, draft: changed });
		} catch {
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
	async function sealDraft({ keepalive = false }: { keepalive?: boolean } = {}): Promise<void> {
		const snapshot = draftRef.current;
		if (!snapshot || dropEmpty(snapshot) || !snapshot.dirty) return;
		if (snapshot.ref === null) setCaptures((previous) => new Map(previous).set(snapshot.id, snapshot));
		const existing = pending.current.get(snapshot.id);
		if (existing) {
			await existing;
			pending.current.delete(snapshot.id);
			if (draftRef.current?.id === snapshot.id) await sealDraft({ keepalive });
			return;
		}
		const cleaned = cleanTitle(snapshot);
		const body: CaseBody = {
			...cleaned.body,
			steps: cleaned.body.steps
				.filter((step) => step.action.trim())
				.map((step) => ({ ...step, expected: step.expected || null })),
		};
		const fingerprint = JSON.stringify({ body, tags: cleaned.tags, covers: cleaned.covers, folder: snapshot.folder });
		if (snapshot.submission.kind === "waiting" && snapshot.submission.fingerprint === fingerprint) return;
		const command = snapshot.cmd;
		const task = (async () => {
			try {
				let after = snapshot.after;
				if (after?.startsWith("draft:")) {
					const predecessor = after;
					const request = pending.current.get(predecessor);
					if (request) await request;
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
								{ op: "edit", case: snapshot.ref, base: snapshot.base, body },
								...(cleaned.tags.length
									? [{ op: "place", cases: [snapshot.ref], tags: { add: cleaned.tags } } satisfies Edit]
									: []),
								...cleaned.covers.map(
									(requirement) => ({ op: "cover", case: snapshot.ref ?? "", requirement, on: true }) satisfies Edit,
								),
							];
				const reply = await call("propose", { cmd: command, edits }, { project, keepalive });
				if (reply.status === "conflict" && reply.question && snapshot.ref && reply.proposal) {
					const proposal = (await call("get", { refs: [reply.proposal] }, { project }))[0];
					const rawEdits = proposal && Array.isArray(proposal.edits) ? proposal.edits : [];
					const edit = rawEdits
						.map((item: unknown) => ResolvedEdit.safeParse(item))
						.find((item) => item.success && item.data.case === snapshot.ref);
					const currentBody = edit?.success ? CaseBody.parse(edit.data.current) : body;
					setConflict({
						q: reply.question,
						ref: snapshot.ref,
						mine: body,
						current: currentBody,
						merged: edit?.success ? edit.data.body : body,
						paths: reply.conflicts.find((item) => item.case === snapshot.ref)?.paths ?? [],
						draftId: snapshot.id,
					});
					setStatus("Both edits are kept. Choose each field to resolve the conflict.");
					return;
				}
				if (reply.status === "open") {
					if (reply.question && draftRef.current?.id === snapshot.id) {
						const latest = draftRef.current;
						const next: Draft = {
							...latest,
							cmd: crypto.randomUUID(),
							submission: { kind: "waiting", question: reply.question, fingerprint },
						};
						draftRef.current = next;
						setDraftState(next);
						writeDraft({ project, draft: next });
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
					const rows = await call("get", { refs: [ref], version }, { project });
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
				const latest = draftRef.current;
				if (latest?.id === snapshot.id && ref) {
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
						tags: [...new Set([...adoptedTags, ...normalized.tags])],
						covers: [...new Set([...adoptedCovers, ...normalized.covers])],
						dirty: more,
						cmd: crypto.randomUUID(),
						caret: latest.caret.field === "capture-title" ? { ...latest.caret, field: "title" } : latest.caret,
					};
					draftRef.current = next;
					if (keepTitleFocus) {
						flushSync(() => setDraftState(next));
						focusDraft(next);
					} else setDraftState(next);
					setSelected(ref);
					if (more) writeDraft({ project, draft: next });
					if (
						readRoute().project === project &&
						(readRoute().screen === "case" || readRoute().screen === "suite") &&
						(route.screen === "case" || snapshot.ref === null)
					)
						navigate(refUrl({ project, ref }), { replace: true, seal: false });
				}
				setStatus(`Version ${version}, by you, just now`);
				void invalidateProject(project);
			} catch (error) {
				setStatus(
					`${error instanceof Error ? error.message : "Could not record this version"}. Your draft is kept on this device.`,
				);
			}
		})();
		pending.current.set(snapshot.id, task);
		await task;
		pending.current.delete(snapshot.id);
	}
	const sealRef = useRef(sealDraft);
	sealRef.current = sealDraft;
	useEffect(() => {
		const leave = () => {
			void sealRef.current();
		};
		const visibility = () => {
			if (document.visibilityState === "hidden") void sealRef.current({ keepalive: true });
		};
		const reload = () => {
			const latest = draftRef.current;
			if (latest?.dirty) writeDraft({ project, draft: latest });
		};
		window.addEventListener("casebook:leave", leave);
		document.addEventListener("visibilitychange", visibility);
		window.addEventListener("pagehide", reload);
		return () => {
			window.removeEventListener("casebook:leave", leave);
			document.removeEventListener("visibilitychange", visibility);
			window.removeEventListener("pagehide", reload);
			if (draftRef.current?.dirty) void sealRef.current();
		};
	}, [project]);
	useEffect(() => {
		if (!draft?.dirty || conflict) return;
		const at = draft.at;
		const timer = setTimeout(
			() => {
				void sealRef.current();
			},
			Math.max(0, 30_000 - (Date.now() - at)),
		);
		return () => clearTimeout(timer);
	}, [draft, conflict]);
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
			id: `draft:${crypto.randomUUID()}`,
			ref: null,
			base: 0,
			body,
			original: body,
			tags: [],
			covers: [],
			folder,
			after: retain && previous ? previous.id : (previous?.ref ?? selectedRow?.ref ?? previous?.after ?? null),
			caret: { field: "capture-title", start: 0, end: 0 },
			dirty: false,
			at: Date.now(),
			cmd: crypto.randomUUID(),
			submission: { kind: "none" },
		};
		setConflict(null);
		flushSync(() => {
			draftRef.current = next;
			setDraftState(next);
			setSelected(null);
		});
		try {
			writeDraft({ project, draft: next });
		} catch {
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
		const next = draftRef.current?.ref === view.ref ? draftRef.current : editDraft(view);
		change({ ...next, caret: { field: "title", start: next.body.title.length, end: next.body.title.length } }, true);
	}
	function choose(ref: string): void {
		if (selected === ref && draftRef.current?.ref !== null) return;
		void sealDraft();
		const saved = readDraft({ project, id: ref });
		draftRef.current = saved;
		setDraftState(saved);
		setSelected(ref);
		setConflict(null);
		navigate(refUrl({ project, ref }), { seal: false });
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
		try {
			const reply = await call("propose", { edits }, { project });
			if (reply.status !== "adopted") {
				rollback();
				setHidden(new Set());
				setStatus(`Proposed, waiting for a person · ${reply.question ?? ""}`);
			} else {
				undo.current = inverse;
				setStatus(`${selection().length} case${selection().length === 1 ? "" : "s"} changed. Press u to undo.`);
			}
			setPicked(new Set());
			await invalidateProject(project);
		} catch (error) {
			rollback();
			setHidden(new Set());
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
			const edits = undo.current;
			undo.current = null;
			setHidden(new Set());
			if (edits.length) await call("propose", { edits }, { project });
			setStatus("Undone. The inverse change is recorded.");
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
			await call("propose", { edits: [{ op: "restore", case: view.ref, to: previous }] }, { project });
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
					<span id="lcount">{(list.data?.pages[0]?.count ?? cases.length).toLocaleString()} cases</span>
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
					{rows.length === 0 ? (
						<EmptyState>
							{search
								? "No matching cases. Change the filter, or press c to capture one."
								: "No cases yet. Press c and start typing."}
						</EmptyState>
					) : (
						<div style={{ height: `${virtual.getTotalSize()}px`, position: "relative" }}>
							{visibleItems.map((item) => {
								const row = rows[item.index];
								if (!row) return null;
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
											<div className="capture-row">
												<span className="capture-ref">new</span>
												<input
													className="capture-title"
													data-field="capture-title"
													aria-label="Capture title"
													onSelect={(event) => {
														const latest = draftRef.current;
														if (latest)
															change({
																...latest,
																caret: {
																	field: "capture-title",
																	start: event.currentTarget.selectionStart ?? 0,
																	end: event.currentTarget.selectionEnd ?? 0,
																},
															});
													}}
													onPaste={(event) => {
														const text = event.clipboardData.getData("text/plain");
														if (/[\n\t]/.test(text)) {
															event.preventDefault();
															pasteCapture({ draft, text, change });
														}
													}}
													value={draft.body.title}
													placeholder="Start typing a case…"
													onChange={(event) =>
														change({
															...draft,
															dirty: true,
															body: { ...draft.body, title: event.target.value },
															caret: {
																field: "capture-title",
																start: event.target.selectionStart ?? 0,
																end: event.target.selectionEnd ?? 0,
															},
														})
													}
													onKeyDown={(event) => {
														if (event.key === "Enter") {
															event.preventDefault();
															if (event.shiftKey) create();
															else if (event.metaKey || event.ctrlKey) leaveEditor();
															else firstStep({ draft, change });
														}
														if (event.key === "Escape") {
															event.preventDefault();
															leaveEditor();
														}
													}}
												/>
												<span className="dr">draft</span>
											</div>
										) : row.kind === "local" ? (
											<button
												type="button"
												className={`row ${row.draft.ref === selected ? "sel" : ""}`}
												role="option"
												aria-selected={row.draft.ref === selected}
												onClick={() => {
													if (row.draft.ref) choose(row.draft.ref);
													else change(row.draft, true);
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
												<span className="ti">{draft?.ref === row.row.ref ? draft.body.title : row.row.title}</span>
												{row.row.tags.length > 0 && <span className="tg">#{row.row.tags[0]}</span>}
												{draft?.ref === row.row.ref && draft.dirty && <span className="dr">draft</span>}
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
				view={view}
				draft={draft}
				change={change}
				begin={(field = "title") => {
					if (view) {
						const next = editDraft(view);
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
				conflict={conflict}
				onResolved={() => {
					if (conflict) removeDraft({ project, id: conflict.draftId });
					draftRef.current = null;
					setDraftState(null);
					setConflict(null);
					void invalidateProject(project);
				}}
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
								{ project },
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
