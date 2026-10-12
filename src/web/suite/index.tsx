import { useInfiniteQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import { z } from "zod";
import { emptyBody, CaseBody } from "../../core/model.ts";
import type { Edit } from "../../core/ops.ts";
import { CasePane, type ConflictState } from "../case/pane.tsx";
import { cleanTitle, firstStep } from "../case/editor.tsx";
import { call } from "../lib/api.ts";
import { invalidateProject, queryClient, queryKey, useQueryOp } from "../lib/data.ts";
import { activeDraft, readDraft, removeDraft, writeDraft, type Draft } from "../lib/drafts.ts";
import { navigate, refUrl, routeUrl } from "../lib/router.ts";
import { useApp } from "../ui/context.tsx";
import { EmptyState, KeyCap, ProofStrip } from "../ui/index.tsx";
import { useSuiteBindings } from "./bindings.ts";
import { CaseRow, CaseView, FolderRow, bodyOf, editDraft } from "./model.ts";
import "./suite.css";
import "../case/case.css";

type VisibleRow = { kind: "case"; row: CaseRow } | { kind: "draft"; id: string } | { kind: "folder"; folder: FolderRow; count: number };
const ResolvedEdit = z.object({ op: z.literal("edit"), case: z.string(), mine: z.unknown(), current: z.unknown() });

export function SuiteScreen() {
	const { project, route, setStatus, openPalette, overlayOpen } = useApp();
	const [text, setText] = useState(""); const [search, setSearch] = useState("");
	const [draft, setDraftState] = useState<Draft | null>(() => { const saved = route.ref ? readDraft({ project, id: route.ref }) : activeDraft(project); return saved?.dirty || saved?.ref === null ? saved : null; });
	const draftRef = useRef(draft); const pending = useRef(new Map<string, Promise<void>>());
	const [conflict, setConflict] = useState<ConflictState | null>(null);
	const [selected, setSelected] = useState<string | null>(route.ref);
	const [picked, setPicked] = useState(new Set<string>()); const [hidden, setHidden] = useState(new Set<string>()); const [collapsed, setCollapsed] = useState(new Set<number>());
	const [tagging, setTagging] = useState(false); const [tagText, setTagText] = useState(""); const [creatingFolder, setCreatingFolder] = useState(false); const [folderText, setFolderText] = useState("");
	const undo = useRef<Edit[] | null>(null); const viewport = useRef<HTMLDivElement>(null); const filter = useRef<HTMLInputElement>(null);
	const foldersQuery = useQueryOp({ project, op: "find", input: { in: "folders" } });
	const folders = useMemo(() => z.array(FolderRow).parse(foldersQuery.data?.items ?? []), [foldersQuery.data]);
	const input = useMemo(() => ({ in: "cases", limit: 500, ...(route.folder ? { folder: route.folder, deep: true } : {}), ...(search ? { text: search } : {}) } satisfies Parameters<typeof call<"find">>[1]), [route.folder, search]);
	const list = useInfiniteQuery({ queryKey: [project, "find", input, "pages"], initialPageParam: "", queryFn: ({ pageParam, signal }) => call("find", { ...input, ...(pageParam ? { cursor: pageParam } : {}) }, { project, signal }), getNextPageParam: (last) => last.cursor ?? undefined, placeholderData: (previous) => previous });
	const cases = useMemo(() => z.array(CaseRow).parse(list.data?.pages.flatMap((page) => page.items) ?? []), [list.data]);
	const current = useQueryOp({ project, op: "get", input: { refs: [selected ?? "C-0"] }, enabled: selected !== null && !selected.startsWith("draft:") });
	const view = useMemo(() => { const parsed = CaseView.safeParse(current.data?.find((item) => item.ref === selected)); return parsed.success ? parsed.data : null; }, [current.data, selected]);
	const newId = draft?.ref === null ? draft.id : null;
	const rows = useMemo(() => {
		const result: VisibleRow[] = []; let folderId: number | null = null;
		const grouping = Boolean(route.folder && folders.some((folder) => folder.path.startsWith(`${route.folder}/`)));
		for (const row of cases) {
			if (hidden.has(row.ref)) continue;
			if (grouping && folderId !== row.folder) { folderId = row.folder; const folder = folders.find((item) => item.id === row.folder); if (folder) result.push({ kind: "folder", folder, count: folder.cases }); }
			if (!collapsed.has(row.folder)) result.push({ kind: "case", row });
		}
		if (newId) { const after = draftRef.current?.after; const at = result.findIndex((item) => item.kind === "case" && item.row.ref === after); result.splice(at >= 0 ? at + 1 : 0, 0, { kind: "draft", id: newId }); }
		return result;
	}, [cases, collapsed, folders, hidden, newId, route.folder]);
	const virtual = useVirtualizer({ count: rows.length, getScrollElement: () => viewport.current, estimateSize: () => 32, overscan: 12 });
	useEffect(() => { const timer = setTimeout(() => setSearch(text), 80); return () => clearTimeout(timer); }, [text]);
	useEffect(() => { if (list.hasNextPage && !list.isFetchingNextPage) void list.fetchNextPage(); }, [list.hasNextPage, list.isFetchingNextPage, list.fetchNextPage]);
	useEffect(() => { if (route.ref !== selected && route.ref !== null) { setSelected(route.ref); const saved = readDraft({ project, id: route.ref }); draftRef.current = saved; setDraftState(saved); setConflict(null); } }, [project, route.ref, selected]);
	useEffect(() => { if (selected === null && cases[0] && !draftRef.current) setSelected(cases[0].ref); }, [cases, selected]);
	useEffect(() => { if (view && !draftRef.current) { const saved = readDraft({ project, id: view.ref }); if (saved?.dirty) { draftRef.current = saved; setDraftState(saved); } } }, [project, view]);
	function focusDraft(next: Draft): void { const target = document.querySelector(`[data-field="${next.caret.field}"]`); if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) { target.focus(); target.setSelectionRange(next.caret.start, next.caret.end); } }
	function change(next: Draft, focus = false): void {
		const changed = { ...next, at: Date.now() }; draftRef.current = changed;
		try { writeDraft({ project, draft: changed }); } catch { setStatus("Device storage is full. Keep this tab open until the version is recorded."); }
		if (focus) { flushSync(() => setDraftState(changed)); focusDraft(changed); } else setDraftState(changed);
	}
	function dropEmpty(snapshot: Draft): boolean {
		if (snapshot.ref === null && !snapshot.body.title.trim() && !snapshot.body.steps.some((step) => step.action.trim())) { removeDraft({ project, id: snapshot.id }); if (draftRef.current?.id === snapshot.id) { draftRef.current = null; setDraftState(null); } return true; } return false;
	}
	async function sealDraft({ keepalive = false }: { keepalive?: boolean } = {}): Promise<void> {
		const snapshot = draftRef.current; if (!snapshot || dropEmpty(snapshot) || !snapshot.dirty) return;
		const existing = pending.current.get(snapshot.id); if (existing) { await existing; if (draftRef.current?.id === snapshot.id) await sealDraft({ keepalive }); return; }
		const cleaned = cleanTitle(snapshot); const body: CaseBody = { ...cleaned.body, steps: cleaned.body.steps.filter((step) => step.action.trim()).map((step) => ({ ...step, expected: step.expected || null })) };
		const command = snapshot.cmd;
		const task = (async () => {
			try {
				const edits: Edit[] = snapshot.ref === null ? [{ op: "create", body, folder: snapshot.folder, tags: cleaned.tags, covers: cleaned.covers, ...(snapshot.after ? { after: snapshot.after } : {}) }] : [{ op: "edit", case: snapshot.ref, base: snapshot.base, body }];
				const reply = await call("propose", { cmd: command, edits }, { project, keepalive });
				if (reply.status === "conflict" && reply.question && snapshot.ref && reply.proposal) {
					const proposal = (await call("get", { refs: [reply.proposal] }, { project }))[0]; const rawEdits = proposal && Array.isArray(proposal.edits) ? proposal.edits : [];
					const edit = rawEdits.map((item: unknown) => ResolvedEdit.safeParse(item)).find((item) => item.success && item.data.case === snapshot.ref);
					const currentBody = edit?.success ? CaseBody.parse(edit.data.current) : body;
					setConflict({ q: reply.question, ref: snapshot.ref, mine: body, current: currentBody, paths: reply.conflicts.find((item) => item.case === snapshot.ref)?.paths ?? [], draftId: snapshot.id });
					setStatus("Both edits are kept. Choose each field to resolve the conflict."); return;
				}
				if (reply.status === "open") { setStatus(`Proposed, waiting for a person${reply.question ? ` · ${reply.question}` : ""}`); return; }
				if (reply.status === "rejected") { setStatus("The proposal was rejected. Your draft is kept on this device."); return; }
				const stamp = reply.cases.find((item) => snapshot.ref === null || item.ref === snapshot.ref);
				const ref = stamp?.ref ?? snapshot.ref; const version = stamp?.version ?? snapshot.base;
				removeDraft({ project, id: snapshot.id });
				const latest = draftRef.current;
				if (latest?.id === snapshot.id && ref) {
					const more = JSON.stringify(latest.body) !== JSON.stringify(snapshot.body);
					const next: Draft = { ...latest, id: ref, ref, base: version, body: more ? latest.body : body, original: body, tags: cleaned.tags, covers: cleaned.covers, dirty: more, cmd: crypto.randomUUID() };
					draftRef.current = next; setDraftState(next); setSelected(ref); if (more) writeDraft({ project, draft: next });
					if (route.screen === "case" || snapshot.ref === null) navigate(refUrl({ project, ref }), { replace: true, seal: false });
				}
				setStatus(`Version ${version}, by you, just now`); void invalidateProject(project);
			} catch (error) { setStatus(`${error instanceof Error ? error.message : "Could not record this version"}. Your draft is kept on this device.`); }
		})();
		pending.current.set(snapshot.id, task); await task; pending.current.delete(snapshot.id);
	}
	const sealRef = useRef(sealDraft); sealRef.current = sealDraft;
	useEffect(() => { const leave = () => { void sealRef.current(); }; const visibility = () => { if (document.visibilityState === "hidden") void sealRef.current({ keepalive: true }); }; const reload = () => { const latest = draftRef.current; if (latest?.dirty) writeDraft({ project, draft: latest }); }; window.addEventListener("casebook:leave", leave); document.addEventListener("visibilitychange", visibility); window.addEventListener("pagehide", reload); return () => { window.removeEventListener("casebook:leave", leave); document.removeEventListener("visibilitychange", visibility); window.removeEventListener("pagehide", reload); if (draftRef.current?.dirty) void sealRef.current(); }; }, [project]);
	useEffect(() => { if (!draft?.dirty || conflict) return; const timer = setTimeout(() => { void sealRef.current(); }, 30_000); return () => clearTimeout(timer); }, [draft?.at, draft?.dirty, conflict]);
	useLayoutEffect(() => { if (draft?.dirty) focusDraft(draft); }, []);
	function leaveEditor(): void { void sealDraft(); if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); viewport.current?.focus(); }
	function create(): void {
		void sealDraft(); const selectedRow = cases.find((item) => item.ref === selected); const folder = route.folder ?? folders.find((item) => item.id === selectedRow?.folder)?.path ?? "";
		const body = emptyBody(); const next: Draft = { id: `draft:${crypto.randomUUID()}`, ref: null, base: 0, body, original: body, tags: [], covers: [], folder, after: selectedRow?.ref ?? null, caret: { field: "capture-title", start: 0, end: 0 }, dirty: false, at: Date.now(), cmd: crypto.randomUUID() };
		setConflict(null); flushSync(() => { draftRef.current = next; setDraftState(next); setSelected(null); }); writeDraft({ project, draft: next }); virtual.scrollToOffset(0); focusDraft(next);
	}
	function edit(): void { if (draftRef.current?.ref === null) { firstStep({ draft: draftRef.current, change }); return; } if (!view) return; const next = draftRef.current?.ref === view.ref ? draftRef.current : editDraft(view); change({ ...next, caret: { field: "title", start: next.body.title.length, end: next.body.title.length } }, true); }
	function choose(ref: string): void { if (selected === ref && draftRef.current?.ref !== null) return; void sealDraft(); const saved = readDraft({ project, id: ref }); draftRef.current = saved; setDraftState(saved); setSelected(ref); setConflict(null); navigate(refUrl({ project, ref }), { seal: false }); }
	function stepCursor(direction: number): void { const items = rows.filter((item) => item.kind === "case"); const index = items.findIndex((item) => item.row.ref === selected); const next = items[Math.max(0, Math.min(items.length - 1, index + direction))]; if (next) { choose(next.row.ref); const at = rows.findIndex((item) => item.kind === "case" && item.row.ref === next.row.ref); virtual.scrollToIndex(at, { align: "auto" }); } }
	const selection = () => picked.size ? [...picked] : selected ? [selected] : [];
	async function placement(edits: Edit[], inverse: Edit[]): Promise<void> { try { const reply = await call("propose", { edits }, { project }); if (reply.status !== "adopted") setStatus(`Proposed, waiting for a person · ${reply.question ?? ""}`); else { undo.current = inverse; setStatus(`${selection().length} case${selection().length === 1 ? "" : "s"} changed. Press u to undo.`); } setPicked(new Set()); await invalidateProject(project); } catch (error) { setHidden(new Set()); setStatus(error instanceof Error ? error.message : "The change failed"); } }
	function move(): void { const refs = selection(); if (!refs.length) return; openPalette({ title: "Move selected cases to a folder", items: [{ id: "root", label: "All cases / root", handler: () => moveTo("") }, ...folders.map((folder) => ({ id: folder.path, label: folder.path, detail: `${folder.cases} cases`, handler: () => moveTo(folder.path) }))] }); }
	function moveTo(folder: string, refs = selection()): void { if (!refs.length) return; const inverse: Edit[] = folders.filter((item) => cases.some((row) => refs.includes(row.ref) && row.folder === item.id)).map((item) => ({ op: "place", cases: cases.filter((row) => refs.includes(row.ref) && row.folder === item.id).map((row) => row.ref), folder: item.path })); const rootRefs = cases.filter((row) => refs.includes(row.ref) && !folders.some((folder) => folder.id === row.folder)).map((row) => row.ref); if (rootRefs.length) inverse.push({ op: "place", cases: rootRefs, folder: "" }); if (route.folder && folder !== route.folder) setHidden((prior) => new Set([...prior, ...refs])); void placement([{ op: "place", cases: refs, folder }], inverse); }
	function archive(): void { const refs = selection(); if (!refs.length) return; setHidden((prior) => new Set([...prior, ...refs])); void placement([{ op: "state", cases: refs, to: "archived" }], [{ op: "state", cases: refs, to: "active" }]); }
	function tag(): void { const refs = selection(); const value = tagText.trim().replace(/^#/, ""); if (!refs.length || !value) { setTagging(false); return; } const added = cases.filter((row) => refs.includes(row.ref) && !row.tags.includes(value)).map((row) => row.ref); setTagging(false); void placement([{ op: "place", cases: refs, tags: { add: [value] } }], added.length ? [{ op: "place", cases: added, tags: { remove: [value] } }] : []); }
	async function undoLast(): Promise<void> { if (undo.current) { const edits = undo.current; undo.current = null; setHidden(new Set()); if (edits.length) await call("propose", { edits }, { project }); setStatus("Undone. The inverse change is recorded."); void invalidateProject(project); } else if (view && view.version > 1) { await call("propose", { edits: [{ op: "restore", case: view.ref, to: view.version - 1 }] }, { project }); draftRef.current = null; setDraftState(null); setStatus("Previous version restored as a new version."); void invalidateProject(project); } }
	useEffect(() => { const drop = (event: Event) => { if (!(event instanceof CustomEvent)) return; const detail = z.object({ ref: z.string(), folder: z.string() }).safeParse(event.detail); if (detail.success) moveTo(detail.data.folder, [detail.data.ref]); }; window.addEventListener("casebook:drop", drop); return () => window.removeEventListener("casebook:drop", drop); });
	useSuiteBindings({ enabled: !overlayOpen, create, edit, next: () => stepCursor(1), previous: () => stepCursor(-1), filter: () => filter.current?.focus(), seal: leaveEditor, rapid: create, select: () => { if (selected) setPicked((prior) => { const next = new Set(prior); if (next.has(selected)) next.delete(selected); else next.add(selected); return next; }); }, move, tag: () => setTagging(true), archive, undo: () => { void undoLast().catch((error: unknown) => setStatus(error instanceof Error ? error.message : "Undo failed")); }, peek: () => { document.querySelector(".timeline-block")?.scrollIntoView({ block: "nearest" }); }, folder: (direction) => { const at = folders.findIndex((item) => item.path === route.folder); const folder = folders[(at + direction + folders.length) % folders.length]; if (folder) navigate(routeUrl({ project, screen: "suite", folder: folder.path })); }, newFolder: () => setCreatingFolder(true), zoom: () => document.getElementById("app")?.classList.toggle("zoom") });
	const folderMount = document.getElementById("folder-create");
	return <><section className="pane" id="list"><div className="phead"><b id="ltitle">{route.folder ?? "All cases"}</b><span id="lcount">{(list.data?.pages[0]?.count ?? cases.length).toLocaleString()} cases</span>{picked.size > 0 && <span className="bulk-indicator">{picked.size} selected</span>}<label className="fwrap"><span>/</span><input ref={filter} id="filter" aria-label="Filter cases" placeholder="Filter this list" value={text} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); setText(""); viewport.current?.focus(); } }}/></label></div>{tagging && <form className="inline-form tag-entry" onSubmit={(event) => { event.preventDefault(); tag(); }}><input className="form-input" aria-label="Tag selected cases" placeholder="Tag, then Enter" ref={(node) => { node?.focus(); }} value={tagText} onChange={(event) => setTagText(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); setTagging(false); } }}/></form>}<div className="psub"><span className="id">ID</span><span className="ti">Title</span><span className="pfs"><span className="pf">person</span><span className="pf">CI</span><span className="pf">agent</span></span></div><div className="scroll-list" data-testid="case-list" data-loaded={cases.length} data-total={list.data?.pages[0]?.count ?? 0} ref={viewport} tabIndex={0} aria-label="Cases">{rows.length === 0 ? <EmptyState>{search ? "No matching cases. Change the filter, or press c to capture one." : "No cases yet. Press c and start typing."}</EmptyState> : <div style={{ height: `${virtual.getTotalSize()}px`, position: "relative" }}>{virtual.getVirtualItems().map((item) => { const row = rows[item.index]; if (!row) return null; return <div key={row.kind === "case" ? row.row.ref : row.kind === "folder" ? `folder:${row.folder.id}` : row.id} style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "32px", transform: `translateY(${item.start}px)` }}>{row.kind === "folder" ? <button type="button" className="folder-header" aria-expanded={!collapsed.has(row.folder.id)} onClick={() => setCollapsed((prior) => { const next = new Set(prior); if (next.has(row.folder.id)) next.delete(row.folder.id); else next.add(row.folder.id); return next; })}><span>{collapsed.has(row.folder.id) ? "▸" : "▾"}</span>{row.folder.path}<span>{row.count}</span></button> : row.kind === "draft" && draft ? <div className="capture-row"><span className="capture-ref">new</span><input className="capture-title" data-field="capture-title" aria-label="Capture title" value={draft.body.title} placeholder="Start typing a case…" onChange={(event) => change({ ...draft, dirty: true, body: { ...draft.body, title: event.target.value }, caret: { field: "capture-title", start: event.target.selectionStart ?? 0, end: event.target.selectionEnd ?? 0 } })} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); if (event.shiftKey) create(); else if (event.metaKey || event.ctrlKey) leaveEditor(); else firstStep({ draft, change }); } if (event.key === "Escape") { event.preventDefault(); leaveEditor(); } }}/><span className="dr">draft</span></div> : row.kind === "case" ? <button className={`row row-drag ${row.row.ref === selected ? "sel" : ""}`} type="button" role="option" aria-selected={row.row.ref === selected} draggable onDragStart={(event) => event.dataTransfer.setData("text/plain", row.row.ref)} onClick={() => choose(row.row.ref)}><span className="id">{row.row.ref}</span>{picked.has(row.row.ref) && <span className="selected-check">✓</span>}<span className="ti">{draft?.ref === row.row.ref ? draft.body.title : row.row.title}</span>{row.row.tags.length > 0 && <span className="tg">#{row.row.tags[0]}</span>}{draft?.ref === row.row.ref && draft.dirty && <span className="dr">draft</span>}{row.row.open > 0 && <span className="qdot" title={`${row.row.open} open questions`}>●</span>}<ProofStrip proof={row.row.proof}/></button> : null}</div>; })}</div>}</div></section><CasePane view={view} draft={draft} change={change} begin={() => { if (view) change(editDraft(view)); }} seal={leaveEditor} rapid={create} conflict={conflict} onResolved={() => { if (conflict) removeDraft({ project, id: conflict.draftId }); draftRef.current = null; setDraftState(null); setConflict(null); void invalidateProject(project); }}/>{creatingFolder && folderMount && createPortal(<form className="inline-form" onSubmit={(event) => { event.preventDefault(); void call("propose", { edits: [{ op: "folder", name: folderText, ...(route.folder ? { parent: route.folder } : {}) }] }, { project }).then(() => { setCreatingFolder(false); setFolderText(""); void invalidateProject(project); }).catch((error: unknown) => setStatus(error instanceof Error ? error.message : "Folder could not be created")); }}><input aria-label="New folder name" className="form-input" ref={(node) => { node?.focus(); }} value={folderText} onChange={(event) => setFolderText(event.target.value)} placeholder="Folder, then Enter" onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); setCreatingFolder(false); } }}/></form>, folderMount)}</>;
}