import { type KeyboardEvent, useLayoutEffect, useRef } from "react";
import { newStepId } from "../../core/ids.ts";
import { CaseKind, type FieldDefinitions } from "../../core/model.ts";
import { parseOutline, splitExpected } from "../../core/outline.ts";
import { addDraftTags, cleanTitle, type Draft, draftTags, knownStepIds } from "../lib/drafts.ts";
import { focusInto } from "../lib/focus.ts";
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
	fieldDefinitions,
	draft,
	tags = draftTags(draft),
	change,
	rapid,
	readOnlyStatus = null,
}: {
	fieldDefinitions: FieldDefinitions | undefined;
	draft: Draft;
	tags?: string[];
	change: DraftChange;
	rapid: () => void;
	readOnlyStatus?: string | null;
}) {
	const { setStatus } = useApp();
	const readOnly = readOnlyStatus !== null;
	const refuse = () => setStatus(readOnlyStatus ?? conflictEditorStatus);
	function guard(event: { preventDefault: () => void }): boolean {
		if (!readOnly) return false;
		event.preventDefault();
		refuse();
		return true;
	}
	function changeSteps(steps: Draft["body"]["steps"], field: string, position = 0, dirty = draft.dirty): void {
		change({ ...draft, dirty, body: { ...draft.body, steps }, caret: { field, start: position, end: position } }, true);
	}
	function nextStep(): void {
		const field = draft.caret.field;
		if (field === "title" || field === "capture-title") {
			firstStep({ draft, change });
			return;
		}
		const id = field.split(":")[0];
		const at = draft.body.steps.findIndex((step) => step.id === id);
		if (at < 0) return;
		const next = draft.body.steps[at + 1] ?? freshStep(draft);
		changeSteps(draft.body.steps[at + 1] ? draft.body.steps : [...draft.body.steps, next], `${next.id}:action`);
	}
	function expected(): void {
		const id = draft.caret.field.split(":")[0];
		const step = draft.body.steps.find((item) => item.id === id);
		if (!step) return;
		changeSteps(
			draft.body.steps.map((item) => (item.id === id ? { ...item, expected: item.expected ?? "" } : item)),
			`${id}:expected`,
			step.expected?.length ?? 0,
		);
	}
	const editing = () =>
		!readOnly &&
		document.activeElement instanceof HTMLElement &&
		document.activeElement.matches(".body-editor textarea");
	useBindings([
		{
			key: "shift+enter",
			label: "Next new case",
			handler: rapid,
			allowInInput: true,
			applies: () => !readOnly,
			when: editing,
		},
		{
			key: "enter",
			label: draft.caret.field === "title" || draft.caret.field === "capture-title" ? "First step" : "Next step",
			handler: nextStep,
			allowInInput: true,
			applies: () =>
				!readOnly &&
				(draft.caret.field === "title" ||
					draft.caret.field === "capture-title" ||
					draft.body.steps.some(
						(step) => draft.caret.field === `${step.id}:action` || draft.caret.field === `${step.id}:expected`,
					)),
			when: editing,
		},
		{
			key: "tab",
			label: "Expected result",
			handler: expected,
			allowInInput: true,
			applies: () => !readOnly && draft.caret.field.endsWith(":action"),
			when: editing,
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
			focusInto(field);
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
			refuse();
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
									expected: split ? (split.expected ?? "") : step.expected,
								}
							: { ...step, expected: text }
						: step,
				),
			};
			if (split) {
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
				refuse();
			}
			return;
		}
		if (event.nativeEvent.isComposing) return;
		if (event.repeat && (event.key === "Enter" || event.key === "Escape")) {
			event.preventDefault();
			return;
		}
		if (field === "title" || field === "pre") return;
		const [id, part] = field.split(":");
		const index = draft.body.steps.findIndex((step) => step.id === id);
		const step = draft.body.steps[index];
		if (!step) return;
		if (event.key === "Backspace" && event.currentTarget.value.length === 0) {
			event.preventDefault();
			if (part === "expected") {
				changeSteps(
					draft.body.steps.map((item) => (item.id === id ? { ...item, expected: null } : item)),
					`${id}:action`,
					step.action.length,
				);
			} else {
				const prev = draft.body.steps[index - 1];
				changeSteps(
					draft.body.steps.filter((item) => item.id !== id),
					prev ? `${prev.id}:action` : "title",
					prev?.action.length ?? draft.body.title.length,
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
		if (guard(event)) return;
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
			onBeforeInput={guard}
			onCut={guard}
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
					<span key={tag}>
						#{tag}
						<button
							type="button"
							className="tag-remove"
							aria-label={`Remove tag #${tag}`}
							disabled={readOnly}
							onClick={() =>
								change({
									...draft,
									dirty: true,
									tagChanges: {
										add: draft.tagChanges.add.filter((value) => value !== tag),
										remove: [...new Set([...draft.tagChanges.remove, tag])],
									},
								})
							}
						/>
					</span>
				))}
			</div>
			{Object.entries(fieldDefinitions ?? {}).map(([key, field]) => {
				const value = Object.hasOwn(draft.body.fields, key) ? (draft.body.fields[key] ?? "") : "";
				const label = `${field.label}${field.required ? " (required)" : ""}`;
				const props = {
					id: `case-field-${key}`,
					className: "form-input",
					"aria-label": label,
					"aria-required": field.required,
					value,
					onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
						const fields = { ...draft.body.fields, [key]: event.target.value };
						if (!event.target.value) delete fields[key];
						change({ ...draft, body: { ...draft.body, fields }, dirty: true });
					},
				};
				return (
					<label className="case-field" htmlFor={props.id} key={key}>
						{label}
						{field.kind === "choice" ? (
							<select {...props} disabled={readOnly}>
								<option value="">Choose a value</option>
								{value && !field.choices.includes(value) && <option value={value}>{value}</option>}
								{field.choices.map((choice) => (
									<option key={choice} value={choice}>
										{choice}
									</option>
								))}
							</select>
						) : (
							<input {...props} readOnly={readOnly} />
						)}
					</label>
				);
			})}
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
