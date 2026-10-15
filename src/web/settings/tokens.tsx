import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { z } from "zod";
import { untilPhrase } from "../../core/duration.ts";
import { call } from "../lib/api.ts";
import { queryKey } from "../lib/data.ts";
import { useApp } from "../ui/context.tsx";
import { age, ProducerGlyph, SectionHeading } from "../ui/index.tsx";

const Token = z.object({
	id: z.number(),
	actor: z.string(),
	kind: z.string(),
	label: z.string(),
	createdAt: z.number(),
	createdBy: z.string().nullable(),
	expiresAt: z.number().nullable(),
	expired: z.boolean(),
	lastUsedAt: z.number().nullable(),
	lastUsedFrom: z.string().nullable(),
	revoked: z.boolean(),
});
type Token = z.infer<typeof Token>;
/**
 * Whether a token works, in one word. `expired` is the server's word, by its own clock: a browser whose clock is
 * off must not call a token active that the server refuses.
 */
const tokenStanding = (token: Token): string => (token.revoked ? "Revoked" : token.expired ? "Expired" : "Active");

/** What is known of a token, in one line: who made it and when, when it ends, and its last use and from where. */
function tokenFacts(token: Token): string {
	const left =
		token.revoked || token.expired || token.expiresAt === null ? null : untilPhrase(token.expiresAt, Date.now());
	return [
		`token ${token.id}`,
		token.label,
		`created ${age(token.createdAt)}${token.createdBy === null ? "" : ` by ${token.createdBy}`}`,
		...(left ? [`expires ${left}`] : []),
		...(token.lastUsedAt === null
			? ["never used"]
			: [`last used ${age(token.lastUsedAt)}${token.lastUsedFrom === null ? "" : ` from ${token.lastUsedFrom}`}`]),
	].join(" · ");
}
export function IssuedTokens({ canCreate = false }: { canCreate?: boolean }) {
	const { project, setStatus } = useApp();
	const input = { do: "token.list" } as const;
	const read = useQuery({
		queryKey: queryKey({ project, op: "admin", input }),
		queryFn: ({ signal }) => call("admin", input, { project, signal }),
		refetchOnMount: "always",
	});
	const parsed = Token.array().safeParse(read.data);
	const [revoking, setRevoking] = useState<Set<number>>(new Set());
	return (
		<>
			<SectionHeading>Issued tokens</SectionHeading>
			{read.error && <p role="status">{read.error.message}</p>}
			{parsed.success &&
				parsed.data.map((token) => (
					<div className="settings-token" key={token.id}>
						<ProducerGlyph kind={token.kind} />
						<span>
							<b>{token.actor}</b>
							<small>{tokenFacts(token)}</small>
						</span>
						<span className="dim">{tokenStanding(token)}</span>
						{/* A token past its end has nothing left to take away. */}
						{!token.revoked && !token.expired && (
							<button
								className="out"
								type="button"
								disabled={revoking.has(token.id)}
								aria-label={`Revoke ${token.actor}`}
								onClick={() => {
									setRevoking((value) => new Set(value).add(token.id));
									void call("admin", { do: "token.revoke", id: token.id }, { project })
										.then(() => read.refetch())
										.catch((error: unknown) =>
											setStatus(error instanceof Error ? error.message : "The token could not be revoked."),
										)
										.finally(() =>
											setRevoking((value) => {
												const next = new Set(value);
												next.delete(token.id);
												return next;
											}),
										);
								}}
							>
								Revoke
							</button>
						)}
					</div>
				))}
			{parsed.success && !parsed.data.length && (
				<p className="dim">No tokens yet.{canCreate && " Press n to create one."}</p>
			)}
		</>
	);
}
