import { useState } from "react";
import type { CredentialRow } from "../../core/people.ts";
import { queryClient } from "../lib/data.ts";
import { listCredentials, listTokens, removeCredential } from "../lib/people.ts";
import { useApp } from "../ui/context.tsx";
import { age, ProducerGlyph, SectionHeading } from "../ui/index.tsx";
import { saidOfWrite, useList, withId } from "./list.ts";
import { SessionList } from "./sessions.tsx";

export function PersonAccess({ actor }: { actor: string }) {
	const { project, refreshSession } = useApp();
	const credentials = useList("credential", (options) => listCredentials({ ...options, actor }), actor);
	const [removing, setRemoving] = useState<ReadonlySet<number>>(new Set());
	const [problem, setProblem] = useState("");
	const [message, setMessage] = useState("");
	const rows = credentials.error ? undefined : credentials.data;
	const onlyOne = rows?.length === 1;

	function remove(row: CredentialRow): void {
		if (onlyOne || removing.has(row.id)) return;
		setRemoving((ids) => withId(ids, row.id, true));
		setProblem("");
		setMessage("");
		void removeCredential(row.id)
			.then(({ sessionsEnded }) => {
				setMessage(
					`${row.kind === "password" ? "The password" : row.label} was removed. ${sessionsEnded} session${sessionsEnded === 1 ? "" : "s"} ended.`,
				);
			})
			.catch((error: unknown) =>
				setProblem(
					saidOfWrite(
						error,
						"No answer came back, so the page cannot tell whether the credential was removed. The lists are read again.",
					),
				),
			)
			.finally(() => {
				setRemoving((ids) => withId(ids, row.id, false));
				void credentials.refetch();
				void queryClient.invalidateQueries({ queryKey: [project, "session"] });
				void refreshSession();
			});
	}

	return (
		<section className="settings-person-access" aria-label={`Sessions and sign-in for ${actor}`}>
			<SectionHeading>Sessions</SectionHeading>
			<SessionList actor={actor} />
			<SectionHeading>Password and passkeys</SectionHeading>
			{credentials.isPending && <p className="dim">Reading ways of signing in…</p>}
			{credentials.error && (
				<p role="status">
					{saidOfWrite(
						credentials.error,
						"The ways of signing in could not be read. Open this person's details again to retry.",
					)}
				</p>
			)}
			{rows && (
				<p className="dim">
					{rows.some((row) => row.kind === "password") ? "Password is set." : "No password is set."}
				</p>
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
			{rows?.length === 0 && <p className="dim">No password or passkey. A token or an invitation is their way in.</p>}
			{onlyOne && (
				<p className="dim">
					The only way {actor} signs in stays. {actor} must add another way before this one can be removed.
				</p>
			)}
			<p className="settings-problem" role="status">
				{problem}
			</p>
			<p className="settings-message" role="status">
				{message}
			</p>
		</section>
	);
}

export function TokenUse() {
	const tokens = useList("token-use", listTokens);
	return (
		<section className="settings-token-use" aria-label="Token use">
			<SectionHeading>Token use</SectionHeading>
			<p className="dim">
				Each token identifies its actor. Its last use does not tell who was holding it. Make and revoke tokens in
				Tokens.
			</p>
			{tokens.error && (
				<p role="status">{saidOfWrite(tokens.error, "Token use could not be read. Open People again to retry.")}</p>
			)}
			{!tokens.error &&
				tokens.data?.map((token) => (
					<div className="settings-row" key={token.id}>
						<ProducerGlyph kind={token.kind} />
						<span>
							<b>
								{token.actor} · {token.label} · #{token.id}
							</b>
							<small>
								{token.revoked ? "Revoked" : token.expired ? "Expired" : "Active"} ·{" "}
								{token.lastUsedAt === null
									? "never used"
									: `last used ${age(token.lastUsedAt)}${token.lastUsedFrom === null ? "" : ` from ${token.lastUsedFrom}`}`}
							</small>
						</span>
					</div>
				))}
			{!tokens.error && tokens.data?.length === 0 && <p className="dim">No tokens issued.</p>}
		</section>
	);
}
