import { useEffect, useRef } from "react";
import { useBindings } from "../lib/keys.ts";

/** The extra text an answer needs, with the same keyboard flow on the Queue and a case. */
export function AnswerExtra({
	kind,
	field,
	label,
	value,
	onChange,
	onSubmit,
	onCancel,
}: {
	kind: "answer" | "withdrawal";
	field: "ref" | "reason";
	label?: string;
	value: string;
	onChange: (value: string) => void;
	onSubmit: (value: string) => void;
	onCancel: () => void;
}) {
	const input = useRef<HTMLInputElement>(null);
	useEffect(() => {
		input.current?.focus();
	}, []);
	useBindings(field === "reason" ? [{ key: "escape", label: "Cancel", handler: onCancel }] : []);
	function submit(): void {
		if (field === "reason" && !value.trim()) return;
		onSubmit(value.trim());
	}
	return (
		<form
			className="queue-inline"
			onSubmit={(event) => {
				event.preventDefault();
				submit();
			}}
		>
			<label htmlFor="answer-extra">
				{label ??
					(kind === "withdrawal"
						? "Reason for withdrawing the answer"
						: field === "ref"
							? "Defect reference, optional"
							: "Reason required by policy")}
			</label>
			<input
				className="form-input"
				id="answer-extra"
				ref={input}
				value={value}
				onChange={(event) => onChange(event.target.value)}
				onKeyDown={(event) => {
					if (event.repeat && (event.key === "Enter" || event.key === "Escape")) {
						event.preventDefault();
						return;
					}
					if (event.key === "Escape") {
						event.preventDefault();
						if (field === "ref") onSubmit("");
						else onCancel();
					}
				}}
			/>
			<span className="dim">Enter records · Escape {field === "ref" ? "skips the reference" : "cancels"}</span>
		</form>
	);
}
