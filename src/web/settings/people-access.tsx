import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { CredentialRow } from "../../core/people.ts";
import { listCredentials, removeCredential } from "../lib/people.ts";
import { useApp } from "../ui/context.tsx";
import { age } from "../ui/index.tsx";
import { saidBy, saidOfWrite, useList, withId } from "./list.ts";
import { SessionList } from "./sessions.tsx";

export function PersonAccess({ actor }: { actor: string }) {
	const { project, session, refreshSession } = useApp();
	const client = useQueryClient();
	const credentials = useList("credential", (options) => listCredentials(options, actor), actor);
	const [removing, setRemoving] = useState<ReadonlySet<number>>(new Set());
	const [message, setMessage] = useState("");
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
		setRemoving((ids) => withId(ids, row.id, true));
		setMessage("");
		void removeCredential(row.id)
			.then(({ sessionsEnded }) => {
				setMessage(
					`${row.kind === "password" ? "The password" : row.label} was removed. ${sessionsEnded} session${sessionsEnded === 1 ? "" : "s"} ended.`,
				);
			})
			.catch((error: unknown) => {
				setMessage(
					saidOfWrite(
						error,
						"No answer came back, so the page cannot tell whether the credential was removed. The lists are read again.",
					),
				);
			})
			.finally(() => {
				void changed().finally(() => setRemoving((ids) => withId(ids, row.id, false)));
			});
	}

	return (
		<section className="settings-person-access" aria-label={`Sign-in details for ${actor}`}>
			<h4>Ways of signing in</h4>
			{credentials.isPending && <p className="dim">Reading ways of signing in…</p>}
			{credentials.error && <p role="status">{saidBy(credentials.error)}</p>}
			{rows && (
				<p className="dim">{rows.some((row) => row.kind === "password") ? "Password set" : "No password set"}</p>
			)}
			{rows?.map((row) => (
				<div className="settings-row" key={row.id}>
					<span>
						<b>{row.kind === "password" ? "Password" : row.label}</b>
						<small>
							{row.kind === "passkey" && "passkey · "}added {age(row.createdAt)} ·{" "}
							{row.lastUsedAt === null ? "never used" : `last used ${age(row.lastUsedAt)}`}
						</small>
					</span>
					<button
						className="out"
						type="button"
						disabled={onlyOne}
						aria-disabled={removing.has(row.id)}
						aria-label={`Remove ${row.kind === "password" ? "the password" : row.label}`}
						onClick={() => remove(row)}
					>
						{removing.has(row.id) ? "Removing…" : "Remove"}
					</button>
				</div>
			))}
			{rows?.length === 0 && (
				<p className="dim">No password or passkey. This person may use a token or accept an invitation.</p>
			)}
			{onlyOne && (
				<p className="dim">
					The only way this person signs in stays. They must add another before this one can be removed.
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
