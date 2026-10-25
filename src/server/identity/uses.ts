// A use is durable before the request returns. The stored timestamp limits each row to one update per minute.
import type { App } from "../kernel/app.ts";
import { sql } from "../kernel/db.ts";

type Kind = "token" | "session";
const Q = {
	token: sql<{ id: number; hash: string; at: number; addr: string | null }>(`
 UPDATE tokens SET last_used_at = $at, last_used_addr = coalesce($addr::text, last_used_addr)
 WHERE id = $id AND hash = $hash AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $at)
 AND (last_used_at IS NULL OR last_used_at < $at - 60000)
 AND EXISTS (SELECT FROM actors WHERE actors.id = tokens.actor AND disabled_at IS NULL)`),
	session: sql<{ id: number; hash: string; at: number; addr: string | null }>(`
 UPDATE sessions SET last_seen_at = $at, last_seen_addr = coalesce($addr::text, last_seen_addr)
 WHERE id = $id AND hash = $hash AND ended_at IS NULL AND expires_at > $at
 AND last_seen_at < $at - 60000
 AND EXISTS (SELECT FROM actors WHERE actors.id = sessions.actor AND disabled_at IS NULL)
 AND (EXISTS (SELECT FROM tokens WHERE tokens.id = sessions.token AND tokens.actor = sessions.actor
 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $at))
 OR EXISTS (SELECT FROM credentials WHERE credentials.id = sessions.credential AND credentials.actor = sessions.actor AND revoked_at IS NULL))`),
};

/** The secret's hash binds the update even when an import reuses the row's numeric id. */
export async function noteUse(
	app: App,
	kind: Kind,
	id: number,
	at: number,
	addr: string | null,
	hash: string,
): Promise<void> {
	await app.database.write((db) => db.transaction(() => db.run(Q[kind], { id, hash, at, addr })));
}

// The startup job and import surface retain these hooks until their lifecycle is replaced by jobs (stack 4b).
export async function flushUses(_app: App): Promise<void> {}
export function clearUses(_app: App): void {}
