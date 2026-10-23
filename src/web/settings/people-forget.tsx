import { useId, useState } from "react";
import { z } from "zod";
import { FORGET_NOTICE } from "../../core/people-replies.ts";
import { ApiError, call } from "../lib/api.ts";
import { randomId } from "../lib/ids.ts";
import { useApp } from "../ui/context.tsx";
import { DocLink, SectionHeading, Select } from "../ui/index.tsx";
import { InlineConfirmation } from "./inline-confirmation.tsx";
import { saidOfWrite } from "./list.ts";

const Forgotten = z.object({ forgotten: z.string(), tokensRevoked: z.number() });

export function ForgetPerson({
	people,
	changed,
}: {
	people: readonly { name: string; owner?: boolean | undefined }[];
	changed: (name: string) => Promise<boolean | null>;
}) {
	const { session, project } = useApp();
	const id = useId();
	const [target, setTarget] = useState<{ name: string; cmd: string; phase: "chosen" | "confirming" } | null>(null);
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState("");
	const choices = people.map((person) => ({
		...person,
		reason:
			person.name === session.actor
				? "you cannot forget yourself"
				: person.owner === true
					? "current owner, hand the instance to somebody else first"
					: person.owner === undefined
						? "the server did not identify the current owner"
						: null,
	}));
	const selected = choices.find((person) => person.name === target?.name);
	const allowed = selected !== undefined && selected.reason === null && !busy;
	const confirming = target?.phase === "confirming";

	async function forget(): Promise<void> {
		if (!allowed || !target || !confirming) return;
		setBusy(true);
		setMessage("");
		let reread = true;
		let uncertain = false;
		try {
			const result = Forgotten.parse(
				await call("admin", { do: "actor.forget", name: target.name, cmd: target.cmd }, { project }),
			);
			setTarget(null);
			setMessage(
				`Forgotten as ${result.forgotten}. ${result.tokensRevoked} ${result.tokensRevoked === 1 ? "token" : "tokens"} revoked. History and typed text stay.`,
			);
		} catch (error) {
			reread = !(error instanceof ApiError);
			uncertain = reread;
			setMessage(
				saidOfWrite(
					error,
					"No readable answer came back, so the page cannot tell whether the person was forgotten. The lists are read again. Retrying this confirmation asks about the same request.",
				),
			);
		} finally {
			if (reread) {
				const stillListed = await changed(target.name);
				if (uncertain && stillListed === false) {
					setTarget(null);
					setMessage("No readable answer came back. The person is no longer listed. The confirmation was cleared.");
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
				You cannot forget yourself or the current owner. To forget the current owner, first hand the instance to
				somebody else.
			</p>
			<div className="settings-form">
				<label htmlFor={`${id}-person`}>Person to forget</label>
				<Select
					id={`${id}-person`}
					className="form-input"
					value={selected?.name ?? ""}
					disabled={busy}
					onChange={(event) => {
						setTarget(event.target.value ? { name: event.target.value, cmd: randomId(), phase: "chosen" } : null);
						setMessage("");
					}}
				>
					<option value="">Choose a person</option>
					{choices.map((person) => (
						<option key={person.name} value={person.name} disabled={person.reason !== null}>
							{person.name}
							{person.reason ? ` (${person.reason})` : ""}
						</option>
					))}
				</Select>
				<div className="settings-confirm-actions">
					<InlineConfirmation
						open={confirming}
						trigger="Forget this person"
						confirm={busy ? "Forgetting…" : `Forget ${target?.name ?? "this person"}`}
						disabled={selected === undefined || selected.reason !== null}
						busy={busy}
						onOpen={() => {
							if (allowed && target) setTarget({ ...target, phase: "confirming" });
						}}
						onCancel={() => {
							setTarget((now) => (now ? { ...now, phase: "chosen" } : null));
							setMessage("");
						}}
						onConfirm={() => void forget()}
					/>
				</div>
				<p className="settings-message" role="status">
					{message}
				</p>
			</div>
		</>
	);
}
