import { useState } from "react";
import { canonicalJson } from "../../core/hash.ts";
import { FieldDefinitions } from "../../core/model.ts";
import { randomId } from "../lib/ids.ts";
import { Select } from "../ui/index.tsx";

type Row = { id: string; key: string; label: string; kind: "text" | "choice"; required: boolean; choices: string };
const rowsOf = (definitions: FieldDefinitions): Row[] =>
	Object.entries(definitions).map(([key, field]) => ({
		id: randomId(),
		key,
		label: field.label,
		kind: field.kind,
		required: field.required,
		choices: field.kind === "choice" ? field.choices.join("\n") : "",
	}));

export function CustomFields({
	definitions,
	disabled,
	onSave,
}: {
	definitions: FieldDefinitions;
	disabled: boolean;
	onSave: (definitions: FieldDefinitions) => Promise<boolean>;
}) {
	const [rows, setRows] = useState(() => rowsOf(definitions));
	const [base, setBase] = useState(() => canonicalJson(definitions));
	const [message, setMessage] = useState("");
	const changedElsewhere = base !== canonicalJson(definitions);
	const update = (id: string, change: Partial<Row>) =>
		setRows((rows) => rows.map((row) => (row.id === id ? { ...row, ...change } : row)));
	return (
		<form
			className="settings-form settings-fields"
			onSubmit={(event) => {
				event.preventDefault();
				if (disabled || changedElsewhere) return;
				const entries = rows.map(
					(row) =>
						[
							row.key,
							row.kind === "choice"
								? { kind: row.kind, label: row.label, required: row.required, choices: row.choices.split("\n") }
								: { kind: row.kind, label: row.label, required: row.required },
						] as const,
				);
				if (new Set(rows.map((row) => row.key)).size !== rows.length) {
					setMessage("Each field needs a different key.");
					return;
				}
				const parsed = FieldDefinitions.safeParse(Object.fromEntries(entries));
				if (!parsed.success) {
					setMessage(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
					return;
				}
				setMessage("");
				void onSave(parsed.data).then((saved) => {
					if (saved) setBase(canonicalJson(parsed.data));
				});
			}}
		>
			<h3>Custom fields</h3>
			<p className="dim">Definitions apply to future case content. Removing a definition keeps every stored value.</p>
			{changedElsewhere && <p role="status">Definitions changed. Reload them before saving.</p>}
			<fieldset className="settings-field-list" disabled={disabled || changedElsewhere}>
				<legend>Project field definitions</legend>
				{rows.map((row, index) => (
					<fieldset className="settings-field" key={row.id}>
						<legend>Field {index + 1}</legend>
						<label>
							Key
							<input
								className="form-input"
								aria-label={`Field key ${index + 1}`}
								value={row.key}
								onChange={(event) => update(row.id, { key: event.target.value })}
							/>
						</label>
						<label>
							Label
							<input
								className="form-input"
								aria-label={`Field label ${index + 1}`}
								value={row.label}
								onChange={(event) => update(row.id, { label: event.target.value })}
							/>
						</label>
						<label>
							Type
							<Select
								className="form-input"
								aria-label={`Field type ${index + 1}`}
								value={row.kind}
								onChange={(event) => update(row.id, { kind: event.target.value === "choice" ? "choice" : "text" })}
							>
								<option value="text">Text</option>
								<option value="choice">Choice</option>
							</Select>
						</label>
						<label className="settings-field-required">
							<input
								type="checkbox"
								aria-label={`Field required ${index + 1}`}
								checked={row.required}
								onChange={(event) => update(row.id, { required: event.target.checked })}
							/>{" "}
							Required
						</label>
						{row.kind === "choice" && (
							<label>
								Choices, one per line
								<textarea
									className="form-input"
									aria-label={`Field choices ${index + 1}`}
									value={row.choices}
									onChange={(event) => update(row.id, { choices: event.target.value })}
								/>
							</label>
						)}
						<button
							className="out"
							type="button"
							onClick={() => setRows((rows) => rows.filter((entry) => entry.id !== row.id))}
						>
							Remove field {index + 1}
						</button>
					</fieldset>
				))}
				<button
					className="out"
					type="button"
					onClick={() =>
						setRows((rows) => [
							...rows,
							{ id: randomId(), key: "", label: "", kind: "text", required: false, choices: "" },
						])
					}
				>
					Add custom field
				</button>
				<button className="out" type="submit">
					Save field definitions
				</button>
			</fieldset>
			{changedElsewhere && (
				<button
					className="out"
					type="button"
					disabled={disabled}
					onClick={() => {
						setRows(rowsOf(definitions));
						setBase(canonicalJson(definitions));
						setMessage("");
					}}
				>
					Reload field definitions
				</button>
			)}
			{message && <p role="status">{message}</p>}
		</form>
	);
}
