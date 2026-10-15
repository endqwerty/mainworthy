import { useId, useState } from "react";
import { z } from "zod";
import { FORGET_NOTICE } from "../../core/people.ts";
import { ApiError, call } from "../lib/api.ts";
import { randomId } from "../lib/ids.ts";
import { useApp } from "../ui/context.tsx";
import { DocLink, SectionHeading, Select } from "../ui/index.tsx";
import { saidOfWrite } from "./list.ts";

const Forgotten = z.object({ forgotten: z.string(), tokensRevoked: z.number() });

export function ForgetPerson({
	people,
	changed,
}: {
	people: readonly string[];
	changed: (name: string) => Promise<boolean | null>;
}) {
	const { session, project } = useApp();
	const id = useId();
	const [target, setTarget] = useState<{ name: string; cmd: string } | null>(null);
	const [confirmation, setConfirmation] = useState("");
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState("");
	const choices = people.filter((name) => name !== session.actor);
	const allowed = target !== null && choices.includes(target.name) && confirmation === target.name && !busy;

	async function forget(): Promise<void> {
		if (!allowed || !target) return;
		setBusy(true);
		setMessage("");
		let reread = true;
		let uncertain = false;
		try {
			const result = Forgotten.parse(await call("admin", { do: "actor.forget", ...target }, { project }));
			setTarget(null);
			setConfirmation("");
			setMessage(
				`Forgotten as ${result.forgotten}. ${result.tokensRevoked} ${result.tokensRevoked === 1 ? "token" : "tokens"} revoked. History and typed text stay.`,
			);
		} catch (error) {
			reread = !(error instanceof ApiError);
			uncertain = reread;
			setMessage(
				saidOfWrite(
					error,
					"No answer came back, so the page cannot tell whether the person was forgotten. The lists are read again. Retrying this confirmation asks about the same request.",
				),
			);
		} finally {
			if (reread) {
				const stillListed = await changed(target.name);
				if (uncertain && stillListed === false) {
					setTarget(null);
					setConfirmation("");
					setMessage("No answer came back. The person is no longer listed. The confirmation was cleared.");
				}
			}
			setBusy(false);
		}
	}

	return (
		<>
			<SectionHeading>Forget a person</SectionHeading>
			<p>
				{FORGET_NOTICE} <DocLink page="privacy">What stays after forgetting</DocLink>
			</p>
			<p className="dim">
				You cannot forget yourself or the current owner. To forget a former owner, first hand the instance to somebody
				else.
			</p>
			<form
				className="settings-form"
				onSubmit={(event) => {
					event.preventDefault();
					void forget();
				}}
			>
				<label htmlFor={`${id}-person`}>Person to forget</label>
				<Select
					id={`${id}-person`}
					className="form-input"
					value={target && choices.includes(target.name) ? target.name : ""}
					disabled={busy}
					onChange={(event) => {
						setTarget(event.target.value ? { name: event.target.value, cmd: randomId() } : null);
						setConfirmation("");
						setMessage("");
					}}
				>
					<option value="">Choose a person</option>
					{choices.map((name) => (
						<option key={name} value={name}>
							{name}
						</option>
					))}
				</Select>
				<label htmlFor={`${id}-confirm`}>Type the name to confirm</label>
				<input
					id={`${id}-confirm`}
					className="form-input"
					value={confirmation}
					disabled={busy}
					autoComplete="off"
					autoCapitalize="none"
					spellCheck={false}
					onChange={(event) => setConfirmation(event.target.value)}
				/>
				<button type="submit" className="out" aria-disabled={!allowed}>
					{busy ? "Forgetting…" : "Forget this person"}
				</button>
				<button
					type="button"
					className="dim"
					disabled={busy}
					onClick={() => {
						setTarget(null);
						setConfirmation("");
						setMessage("");
					}}
				>
					Cancel forgetting
				</button>
				<p className="settings-message" role="status">
					{message}
				</p>
			</form>
		</>
	);
}
