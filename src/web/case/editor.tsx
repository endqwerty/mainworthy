import { type KeyboardEvent, useLayoutEffect, useRef } from "react";
import { newStepId } from "../../core/ids.ts";
import { CaseKind } from "../../core/model.ts";
import { parseOutline, splitExpected } from "../../core/outline.ts";
import { addDraftTags, type Draft, draftTags, knownStepIds } from "../lib/drafts.ts";
import { useBindings } from "../lib/keys.ts";
import { readRoute } from "../lib/router.ts";
import { AutoGrowingTextarea } from "../ui/auto-growing-textarea.tsx";
import { useApp } from "../ui/context.tsx";
import { KeyCap } from "../ui/index.tsx";
import { FragmentInsert, FragmentReference } from "./fragments.tsx";

export const conflictEditorStatus =
	"Resolve the conflict first. Edit the merged fields in the conflict card; other fields can be edited after it is resolved.";

export const draftOwnershipStatus = "This case is being edited in another window";
/**
 * What a window says of a draft that another window owns. When that window has not answered this one (it is busy,
 * it crashed, or it closed), it is not said to be editing: this window cannot tell which. `e` and "Take over here"
 * continue the draft here either way.
 */
export const ownerAwayStatus =
	'This draft is held by a window that is not answering, or has closed. Press e or choose "Take over here" to continue it here.';
export const ownershipStatus = (live: boolean): string => (live ? draftOwnershipStatus : ownerAwayStatus);
/** A draft another window owned and has removed: what the pane says while this tab still shows it. */
export const draftEndedStatus = {
	reading: "Another window recorded or ended this draft. Reading the case as it is now…",
	unread:
		"Another window recorded or ended this draft, and the case could not be read. This stays as it was until it is.",
};

export type DraftChange = (draft: Draft, focus?: boolean, selectionOnly?: boolean) => void;
function freshStep(draft: Draft) {
	return {
		id: newStepId(
			knownStepIds({
				project: readRoute().project,
				id: draft.id,
				ids: [...draft.body.steps, ...draft.original.steps].map((step) => step.id),
			}),
		),
		action: "",
		expected: null,
	};
}
export function cleanTitle(draft: Draft): Draft {
	const tags = new Set<string>();
	const covers = new Set(draft.covers);
	const metadata = (text: string) =>
		text
			.split("\n")
			.map((line) => {
				const outline = parseOutline(`# ${line}`);
				for (const tag of outline.tags) tags.add(tag);
				for (const cover of outline.covers) covers.add(cover);
				return outline.title ?? line;
			})
			.join("\n");
	const title = metadata(draft.body.title);
	const steps = draft.body.steps.map((step) => ({
		...step,
		action: metadata(step.action),
		expected: step.expected === null ? null : metadata(step.expected),
	}));
	return { ...addDraftTags(draft, [...tags]), body: { ...draft.body, title, steps }, covers: [...covers] };
}
export function firstStep({ draft, change }: { draft: Draft; change: DraftChange }): void {
	const cleaned = cleanTitle(draft);
	const steps = cleaned.body.steps.length ? cleaned.body.steps : [freshStep(cleaned)];
	const first = steps[0];
	if (first)
		change(
			{ ...cleaned, body: { ...cleaned.body, steps }, caret: { field: `${first.id}:action`, start: 0, end: 0 } },
			true,
		);
}
export function BodyEditor({
	draft,
	tags = draftTags(draft),
	change,
	seal,
	rapid,
	readOnlyStatus = null,
}: {
	draft: Draft;
	tags?: string[];
	change: DraftChange;
	seal: () => void;
	rapid: () => void;
	readOnlyStatus?: string | null;
}) {
	const { setStatus } = useApp();
	const readOnly = readOnlyStatus !== null;
	function nextStep(): void {
		if (draft.caret.field === "title" || draft.caret.field === "capture-title") {
			firstStep({ draft, change });
			return;
		}
		const id = draft.caret.field.split(":")[0];
		const at = draft.body.steps.findIndex((step) => step.id === id);
		if (at < 0) return;
		const next = draft.body.steps[at + 1] ?? freshStep(draft);
		change(
			{
				...draft,
				body: { ...draft.body, steps: draft.body.steps[at + 1] ? draft.body.steps : [...draft.body.steps, next] },
				caret: { field: `${next.id}:action`, start: 0, end: 0 },
			},
			true,
		);
	}
	function expected(): void {
		const id = draft.caret.field.split(":")[0];
		const step = draft.body.steps.find((item) => item.id === id);
		if (!step) return;
		change(
			{
				...draft,
				body: {
					...draft.body,
					steps: draft.body.steps.map((item) => (item.id === id ? { ...item, expected: item.expected ?? "" } : item)),
				},
				caret: { field: `${id}:expected`, start: step.expected?.length ?? 0, end: step.expected?.length ?? 0 },
			},
			true,
		);
	}
	const editing = () =>
		!readOnly &&
		document.activeElement instanceof HTMLElement &&
		document.activeElement.matches(".body-editor textarea");
	useBindings([
		{ key: "shift+enter", label: "Next new case", handler: rapid, allowInInput: true, applies: editing },
		{
			key: "enter",
			label: draft.caret.field === "title" || draft.caret.field === "capture-title" ? "First step" : "Next step",
			handler: nextStep,
			allowInInput: true,
			applies: editing,
		},
		{
			key: "tab",
			label: "Expected result",
			handler: expected,
			allowInInput: true,
			applies: () => editing() && draft.caret.field.endsWith(":action"),
		},
	]);
	const root = useRef<HTMLDivElement>(null);
	const mounted = useRef(false);
	useLayoutEffect(() => {
		if (mounted.current) return;
		mounted.current = true;
		const field = root.current?.querySelector(
			`[data-field="${draft.caret.field === "capture-title" ? "title" : draft.caret.field}"]`,
		);
		if (field instanceof HTMLTextAreaElement) {
			field.focus();
			field.setSelectionRange(draft.caret.start, draft.caret.end);
		}
	}, [draft.caret]);
	function move(field: string, position: number): void {
		change({ ...draft, caret: { field, start: position, end: position } }, true);
	}
	function remember(field: string, target: HTMLTextAreaElement): void {
		change({ ...draft, caret: { field, start: target.selectionStart, end: target.selectionEnd } }, false, true);
	}
	function update(field: string, text: string, target: HTMLTextAreaElement): void {
		if (readOnly) {
			setStatus(readOnlyStatus ?? conflictEditorStatus);
			return;
		}
		let body = draft.body;
		if (field === "title") body = { ...body, title: text };
		else if (field === "pre") body = { ...body, pre: text };
		else {
			const [id, part] = field.split(":");
			const step = body.steps.find((step) => step.id === id);
			let split: ReturnType<typeof splitExpected> | null = null;
			if (part === "action" && step?.expected === null) {
				let start = 0;
				while (start < Math.min(step.action.length, text.length) && step.action[start] === text[start]) start++;
				let end = text.length;
				let beforeEnd = step.action.length;
				while (end > start && beforeEnd > start && text[end - 1] === step.action[beforeEnd - 1]) {
					end--;
					beforeEnd--;
				}
				for (let at = text.indexOf(" > "); at >= 0; at = text.indexOf(" > ", at + 1)) {
					if (end > start && start < at + 3 && end > at) {
						split = { action: text.slice(0, at).trimEnd(), expected: text.slice(at + 3).trim() || null };
						break;
					}
				}
			}
			body = {
				...body,
				steps: body.steps.map((step) =>
					step.id === id
						? part === "action"
							? {
									...step,
									action: split?.action ?? text,
									expected:
										split && (split.action !== text || split.expected !== null)
											? (split.expected ?? "")
											: step.expected,
								}
							: { ...step, expected: text }
						: step,
				),
			};
			if (part === "action" && split && (split.action !== text || split.expected !== null)) {
				const expected = split.expected ?? "";
				change(
					{
						...draft,
						body,
						dirty: true,
						caret: { field: `${id}:expected`, start: expected.length, end: expected.length },
					},
					true,
				);
				return;
			}
		}
		change({ ...draft, body, dirty: true, caret: { field, start: target.selectionStart, end: target.selectionEnd } });
	}
	function keys(event: KeyboardEvent<HTMLTextAreaElement>, field: string): void {
		if (readOnly && event.key !== "Escape") {
			if (
				event.key === "Enter" ||
				event.key === "Backspace" ||
				event.key === "Delete" ||
				(event.key.length === 1 && ((!event.ctrlKey && !event.metaKey) || /[vx]/i.test(event.key)))
			) {
				event.preventDefault();
				setStatus(readOnlyStatus ?? conflictEditorStatus);
			}
			return;
		}
		if (event.nativeEvent.isComposing) return;
		if (event.repeat && (event.key === "Enter" || event.key === "Escape")) {
			event.preventDefault();
			return;
		}
		if (event.key === "Escape" || (event.key === "Enter" && (event.metaKey || event.ctrlKey))) {
			event.preventDefault();
			seal();
			return;
		}
		if (event.key === "Enter" && event.shiftKey) {
			event.preventDefault();
			rapid();
			return;
		}
		if (field === "title" && event.key === "Enter") {
			event.preventDefault();
			firstStep({ draft, change });
			return;
		}
		if (field === "title" || field === "pre") return;
		const [id, part] = field.split(":");
		const index = draft.body.steps.findIndex((step) => step.id === id);
		const step = draft.body.steps[index];
		if (!step) return;
		if (event.key === "Tab" && !event.shiftKey && part === "action") {
			event.preventDefault();
			change(
				{
					...draft,
					body: {
						...draft.body,
						steps: draft.body.steps.map((item) => (item.id === id ? { ...item, expected: item.expected ?? "" } : item)),
					},
					caret: { field: `${id}:expected`, start: step.expected?.length ?? 0, end: step.expected?.length ?? 0 },
				},
				true,
			);
			return;
		}
		if (event.key === "Enter") {
			event.preventDefault();
			const next = draft.body.steps[index + 1] ?? freshStep(draft);
			const steps = draft.body.steps[index + 1] ? draft.body.steps : [...draft.body.steps, next];
			change(
				{ ...draft, body: { ...draft.body, steps }, caret: { field: `${next.id}:action`, start: 0, end: 0 } },
				true,
			);
			return;
		}
		if (event.key === "Backspace" && event.currentTarget.value.length === 0) {
			event.preventDefault();
			if (part === "expected") {
				change(
					{
						...draft,
						body: {
							...draft.body,
							steps: draft.body.steps.map((item) => (item.id === id ? { ...item, expected: null } : item)),
						},
						caret: { field: `${id}:action`, start: step.action.length, end: step.action.length },
					},
					true,
				);
			} else {
				const prev = draft.body.steps[index - 1];
				change(
					{
						...draft,
						dirty: true,
						body: { ...draft.body, steps: draft.body.steps.filter((item) => item.id !== id) },
						caret: {
							field: prev ? `${prev.id}:action` : "title",
							start: prev?.action.length ?? draft.body.title.length,
							end: prev?.action.length ?? draft.body.title.length,
						},
					},
					true,
				);
			}
			return;
		}
		if (event.key === "ArrowUp" && event.currentTarget.selectionStart === 0) {
			const prev = draft.body.steps[index - 1];
			event.preventDefault();
			move(prev ? `${prev.id}:action` : "title", prev?.action.length ?? draft.body.title.length);
		}
		if (event.key === "ArrowDown" && event.currentTarget.selectionStart === event.currentTarget.value.length) {
			const next = draft.body.steps[index + 1];
			if (next) {
				event.preventDefault();
				move(`${next.id}:action`, 0);
			}
		}
	}
	function paste(event: React.ClipboardEvent<HTMLTextAreaElement>, field: string): void {
		if (readOnly) {
			event.preventDefault();
			setStatus(readOnlyStatus ?? conflictEditorStatus);
			return;
		}
		const text = event.clipboardData.getData("text/plain");
		if (!/[\n\t]/.test(text)) return;
		if (field !== "title" && !field.endsWith(":action")) return;
		event.preventDefault();
		const outline = parseOutline(text);
		let parsed = outline.steps;
		if (outline.title && (draft.ref !== null || draft.body.title.trim().length > 0))
			parsed = [splitExpected(outline.title), ...parsed];
		const taken = new Set(
			knownStepIds({
				project: readRoute().project,
				id: draft.id,
				ids: [...draft.body.steps, ...draft.original.steps].map((step) => step.id),
			}),
		);
		const steps = parsed.map((step) => {
			const id = newStepId(taken);
			taken.add(id);
			return { id, ...step };
		});
		const at = field === "title" ? 0 : draft.body.steps.findIndex((step) => `${step.id}:action` === field);
		const current = draft.body.steps[at];
		const before = draft.body.steps.slice(0, Math.max(0, at));
		const after = draft.body.steps.slice(at + (current?.action.trim() ? 0 : 1));
		const last = steps.at(-1);
		const title = draft.ref === null && !draft.body.title.trim() && outline.title ? outline.title : draft.body.title;
		change(
			{
				...addDraftTags(draft, outline.tags),
				dirty: true,
				covers: [...new Set([...draft.covers, ...outline.covers])],
				body: { ...draft.body, title, steps: [...before, ...steps, ...after] },
				caret: {
					field: last ? `${last.id}:action` : "title",
					start: last?.action.length ?? title.length,
					end: last?.action.length ?? title.length,
				},
			},
			true,
		);
	}
	const input = (field: string, value: string, label: string, className: string, placeholder = "") => (
		<AutoGrowingTextarea
			rows={Math.max(1, value.split("\n").length)}
			data-field={field}
			aria-label={label}
			className={className}
			placeholder={placeholder}
			value={value}
			readOnly={readOnly}
			onBeforeInput={(event) => {
				if (readOnly) {
					event.preventDefault();
					setStatus(readOnlyStatus ?? conflictEditorStatus);
				}
			}}
			onCut={(event) => {
				if (readOnly) {
					event.preventDefault();
					setStatus(readOnlyStatus ?? conflictEditorStatus);
				}
			}}
			onChange={(event) => update(field, event.target.value, event.target)}
			onSelect={(event) => remember(field, event.currentTarget)}
			onKeyDown={(event) => keys(event, field)}
			onPaste={(event) => paste(event, field)}
		/>
	);
	return (
		<div className="body-editor" ref={root}>
			{readOnly && <p role="status">{readOnlyStatus}</p>}
			{draft.ref === null && (
				<label>
					Kind{" "}
					<select
						aria-label="Case kind"
						value={draft.kind ?? "case"}
						disabled={readOnly || draft.sent !== null || draft.submission.kind === "waiting"}
						onChange={(event) => change({ ...draft, kind: CaseKind.parse(event.target.value), dirty: true })}
					>
						<option value="case">Case</option>
						<option value="fragment">Fragment</option>
					</select>
				</label>
			)}
			{input("title", draft.body.title, "Case title", "ctitle editor-input", "Untitled case")}
			<div className="ctags">
				{tags.map((tag) => (
					<span key={tag}>#{tag}</span>
				))}
			</div>
			{(draft.body.pre || draft.ref !== null) && (
				<>
					<div className="sech">Preconditions</div>
					{input("pre", draft.body.pre, "Preconditions", "editor-input pre-input", "Add a precondition, if needed")}
				</>
			)}
			<div className="sech">Steps</div>
			{draft.body.steps.length === 0 ? (
				<button
					className="nosteps"
					type="button"
					onClick={() => (readOnly ? setStatus(readOnlyStatus ?? conflictEditorStatus) : firstStep({ draft, change }))}
				>
					No steps yet. Enter from the title starts the first one.
				</button>
			) : (
				draft.body.steps.map((step, index) =>
					step.use ? (
						<FragmentReference
							key={step.id}
							pin={step.use}
							remove={
								readOnly
									? null
									: () =>
											change({
												...draft,
												dirty: true,
												body: { ...draft.body, steps: draft.body.steps.filter((item) => item.id !== step.id) },
											})
							}
						/>
					) : (
						<div className={`st ${step.expected !== null ? "hasx" : ""}`} key={step.id}>
							<span className="sn">{index + 1}</span>
							<div>
								{input(`${step.id}:action`, step.action, `Step ${index + 1}`, "stx editor-input", "What to do…")}
								{step.expected !== null && (
									<div className="sxw">
										<span className="gt">&gt;</span>
										{input(
											`${step.id}:expected`,
											step.expected,
											`Expected result ${index + 1}`,
											"sex editor-input",
											"What should happen…",
										)}
									</div>
								)}
							</div>
						</div>
					),
				)
			)}
			{!readOnly && draft.kind !== "fragment" && <FragmentInsert draft={draft} change={change} />}
			<div className="hintl">
				<KeyCap>↵</KeyCap> next step <KeyCap>Tab</KeyCap> or typing " &gt; " starts the expected result{" "}
				<KeyCap>⇧↵</KeyCap> next case
			</div>
		</div>
	);
}
