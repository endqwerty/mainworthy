import { type KeyboardEvent, useLayoutEffect, useRef } from "react";
import { newStepId } from "../../core/ids.ts";
import { parseOutline, splitExpected } from "../../core/outline.ts";
import type { Draft } from "../lib/drafts.ts";
import { KeyCap } from "../ui/index.tsx";

export type DraftChange = (draft: Draft, focus?: boolean) => void;
function freshStep(draft: Draft) {
	return { id: newStepId(new Set(draft.body.steps.map((step) => step.id))), action: "", expected: null };
}
export function cleanTitle(draft: Draft): Draft {
	const tags = new Set(draft.tags);
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
	return { ...draft, body: { ...draft.body, title, steps }, tags: [...tags], covers: [...covers] };
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
export function pasteCapture({ draft, text, change }: { draft: Draft; text: string; change: DraftChange }): void {
	const outline = parseOutline(text);
	const taken = new Set(draft.body.steps.map((step) => step.id));
	const steps = outline.steps.map((step) => {
		const id = newStepId(taken);
		taken.add(id);
		return { id, ...step };
	});
	const last = steps.at(-1);
	const title = outline.title ?? draft.body.title;
	change(
		{
			...draft,
			dirty: true,
			body: { ...draft.body, title, steps },
			tags: [...new Set([...draft.tags, ...outline.tags])],
			covers: [...new Set([...draft.covers, ...outline.covers])],
			caret: {
				field: last ? `${last.id}:action` : "capture-title",
				start: last?.action.length ?? title.length,
				end: last?.action.length ?? title.length,
			},
		},
		true,
	);
}
export function BodyEditor({
	draft,
	change,
	seal,
	rapid,
}: {
	draft: Draft;
	change: DraftChange;
	seal: () => void;
	rapid: () => void;
}) {
	const root = useRef<HTMLDivElement>(null);
	const mounted = useRef(false);
	useLayoutEffect(() => {
		if (mounted.current) return;
		mounted.current = true;
		const field = root.current?.querySelector(`[data-field="${draft.caret.field}"]`);
		if (field instanceof HTMLTextAreaElement) {
			field.focus();
			field.setSelectionRange(draft.caret.start, draft.caret.end);
		}
	}, [draft.caret]);
	function move(field: string, position: number): void {
		change({ ...draft, caret: { field, start: position, end: position } }, true);
	}
	function remember(field: string, target: HTMLTextAreaElement): void {
		change({ ...draft, caret: { field, start: target.selectionStart, end: target.selectionEnd } });
	}
	function update(field: string, text: string, target: HTMLTextAreaElement): void {
		let body = draft.body;
		if (field === "title") body = { ...body, title: text };
		else if (field === "pre") body = { ...body, pre: text };
		else {
			const [id, part] = field.split(":");
			const split = part === "action" ? splitExpected(text) : null;
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
		if (event.nativeEvent.isComposing) return;
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
		const text = event.clipboardData.getData("text/plain");
		if (!/[\n\t]/.test(text)) return;
		if (field !== "title" && !field.endsWith(":action")) return;
		event.preventDefault();
		const outline = parseOutline(text);
		let parsed = outline.steps;
		if (outline.title && (draft.ref !== null || draft.body.title.trim().length > 0))
			parsed = [splitExpected(outline.title), ...parsed];
		const taken = new Set(draft.body.steps.map((step) => step.id));
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
				...draft,
				dirty: true,
				tags: [...new Set([...draft.tags, ...outline.tags])],
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
		<textarea
			rows={Math.max(1, value.split("\n").length)}
			data-field={field}
			aria-label={label}
			className={className}
			placeholder={placeholder}
			value={value}
			onChange={(event) => update(field, event.target.value, event.target)}
			onSelect={(event) => remember(field, event.currentTarget)}
			onKeyDown={(event) => keys(event, field)}
			onPaste={(event) => paste(event, field)}
		/>
	);
	return (
		<div className="body-editor" ref={root}>
			{input("title", draft.body.title, "Case title", "ctitle editor-input", "Untitled case")}
			<div className="ctags">
				{draft.tags.map((tag) => (
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
				<button className="nosteps" type="button" onClick={() => firstStep({ draft, change })}>
					No steps yet. Enter from the title starts the first one.
				</button>
			) : (
				draft.body.steps.map((step, index) => (
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
				))
			)}
			<div className="hintl">
				<KeyCap>↵</KeyCap> next step <KeyCap>Tab</KeyCap> or typing " &gt; " starts the expected result{" "}
				<KeyCap>⇧↵</KeyCap> next case
			</div>
		</div>
	);
}
