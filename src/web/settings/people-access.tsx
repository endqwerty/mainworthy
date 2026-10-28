import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { CredentialRow } from "../../core/people-replies.ts";
import { listCredentials, removeCredential } from "../lib/people.ts";
import { useApp } from "../ui/context.tsx";
import { age } from "../ui/index.tsx";
import { InlineConfirmation } from "./inline-confirmation.tsx";
import { saidBy, saidOfWrite, useList, withId } from "./list.ts";
import { useRecentProof } from "./recent-proof.tsx";
import { SessionList } from "./sessions.tsx";

export function PersonAccess({ actor }: { actor: string }) {
	const { project, session, refreshSession } = useApp();
	const proof = useRecentProof();
	const client = useQueryClient();
	const credentials = useList("credential", (options) => listCredentials(options, actor), actor);
	const [removing, setRemoving] = useState<ReadonlySet<number>>(new Set());
	const [message, setMessage] = useState("");
	const [confirming, setConfirming] = useState<number | null>(null);
	const rows = credentials.error ? undefined : credentials.data;
	const onlyOne = rows?.length === 1;

	function changed(): Promise<void> {
		return Promise.all([
			credentials.refetch(),
			client.invalidateQueries({ queryKey: [project, "session"] }),
			...(actor === session.actor ? [refreshSession()] : []),
		]).then(() => {});
	}

	function remove(row: CredentialRow): void {
		if (onlyOne || removing.has(row.id)) return;
		setConfirming(null);
		setRemoving((ids) => withId(ids, row.id, true));
		setMessage("");
		void proof
			.run(() => removeCredential(row.id))
			.then(({ sessionsEnded }) => {
				setMessage(`${row.label} was removed. ${sessionsEnded} session${sessionsEnded === 1 ? "" : "s"} ended.`);
			})
			.catch((error: unknown) => {
				setMessage(
					saidOfWrite(
						error,
						"No readable answer came back, so the page cannot tell whether the identity was removed. The lists are read again.",
					),
				);
			})
			.finally(() => {
				void changed().finally(() => setRemoving((ids) => withId(ids, row.id, false)));
			});
	}

	return (
		<section className="settings-person-access" aria-label={`Sign-in details for ${actor}`}>
			<h4>Identities</h4>
			{proof.prompt}
			{credentials.isPending && <p className="dim">Reading identities…</p>}
			{credentials.error && <p role="status">{saidBy(credentials.error)}</p>}
			{rows?.map((row) => (
				<div className="settings-row" key={row.id}>
					<span>
						<b>{row.label}</b>
						<small>
							identity · added {age(row.createdAt)} ·{" "}
							{row.lastUsedAt === null ? "never used" : `last used ${age(row.lastUsedAt)}`}
						</small>
						{confirming === row.id && (
							<small>{`${actor} cannot sign in with this identity again. Sessions opened with it end.`}</small>
						)}
					</span>
					<InlineConfirmation
						open={confirming === row.id}
						trigger={removing.has(row.id) ? "Removing…" : "Remove"}
						triggerLabel={`Remove ${row.label}`}
						confirm="Remove this identity"
						disabled={onlyOne}
						busy={removing.has(row.id)}
						onOpen={() => {
							if (actor === session.actor) remove(row);
							else if (!removing.has(row.id)) setConfirming(row.id);
						}}
						onCancel={() => setConfirming(null)}
						onConfirm={() => remove(row)}
					/>
				</div>
			))}
			{rows?.length === 0 && (
				<p className="dim">No identity is linked. This person may use a token or accept an invitation.</p>
			)}
			{onlyOne && (
				<p className="dim">
					The only identity this person signs in with stays. They must link another before this one can be removed.
				</p>
			)}
			<p className="settings-message" role="status">
				{message}
			</p>
			<section aria-label={`Sessions for ${actor}`}>
				<h4>Sessions</h4>
				<SessionList actor={actor} />
			</section>
		</section>
	);
}
