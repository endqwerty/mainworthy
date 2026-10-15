import { createHash } from "node:crypto";
import type { App } from "../kernel/app.ts";
import type { Actor } from "../kernel/ctx.ts";
import { type Db, sql } from "../kernel/db.ts";
import { conflict, forbidden, invalid } from "../kernel/errors.ts";
import { limiterOf } from "./attempts.ts";
import { insertPassword, livePassword, revokeCredential } from "./credentials.ts";
import { addressKey } from "./limiter.ts";
import { deliverMail, queueMail, requireMail } from "./mail.ts";
import { hashPassword, PasswordWorkBusy } from "./passwords.ts";
import { endSessionsOf, newSessionSecret } from "./sessions.ts";

type Contact = { actor: number; name: string; email: string; verified_at: number | null; revision: string };
const Q = {
	get: sql<{ actor: number }, Contact>(
		`SELECT c.*, a.name FROM mail_contacts c JOIN actors a ON a.id = c.actor WHERE c.actor = $actor AND a.disabled_at IS NULL`,
	),
	byEmail: sql<{ email: string }, Contact>(
		`SELECT c.*, a.name FROM mail_contacts c JOIN actors a ON a.id = c.actor WHERE c.email = $email AND a.disabled_at IS NULL AND c.verified_at IS NOT NULL`,
	),
	owner: sql<{ email: string }, { actor: number }>("SELECT actor FROM mail_contacts WHERE email = $email"),
	put: sql<{ actor: number; email: string; revision: string }>(
		`INSERT INTO mail_contacts (actor, email, revision) VALUES ($actor, $email, $revision) ON CONFLICT(actor) DO UPDATE SET email = excluded.email, revision = excluded.revision, verified_at = NULL`,
	),
	verify: sql<{ actor: number; revision: string; at: number }>(
		"UPDATE mail_contacts SET verified_at = $at WHERE actor = $actor AND revision = $revision",
	),
	drop: sql<{ actor: number }>("DELETE FROM mail_contacts WHERE actor = $actor"),
};
type Link = { contact: Contact; expires: number } & ({ kind: "verify" } | { kind: "reset"; password: string | null });
const links = new WeakMap<App, Map<string, Link>>();
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

function heldLinks(app: App): Map<string, Link> {
	let held = links.get(app);
	if (!held) {
		held = new Map();
		links.set(app, held);
	}
	for (const [key, link] of held) if (app.now() >= link.expires) held.delete(key);
	return held;
}
function issue(app: App, link: Link): string {
	const code = newSessionSecret();
	const held = heldLinks(app);
	for (const [key, prior] of held)
		if (prior.contact.actor === link.contact.actor && prior.kind === link.kind) held.delete(key);
	if (held.size >= 10_000) {
		const first = held.keys().next();
		if (!first.done) held.delete(first.value);
	}
	held.set(hash(code), link);
	return code;
}
function find(app: App, db: Db, code: string): Link | null {
	const link = heldLinks(app).get(hash(code));
	if (!link) return null;
	const now = db.get(Q.get, { actor: link.contact.actor });
	return now?.revision === link.contact.revision && now.name === link.contact.name ? link : null;
}
export function clearMailLinks(app: App): void {
	links.delete(app);
}
export function clearMailLinksOf(app: App, actor: number): void {
	const held = heldLinks(app);
	for (const [key, link] of held) if (link.contact.actor === actor) held.delete(key);
}
export function forgetContact(db: Db, actor: number): void {
	db.run(Q.drop, { actor });
}
export function getEmail(db: Db, actor: number): { email: string | null; verified: boolean } {
	const contact = db.get(Q.get, { actor });
	return { email: contact?.email ?? null, verified: contact !== null && contact.verified_at !== null };
}
export function setEmail(
	app: App,
	input: { caller: Actor; person: Actor; context: string | null; email: string | null },
): { email: string | null; verified: boolean } {
	const { caller, person, email } = input;
	if (person.kind !== "human") throw invalid("only a person has an email address");
	if (person.id === caller.id) {
		if (input.context === null)
			throw forbidden("an email address is changed from a browser that is signed in, not with a token");
	} else if (caller.name !== app.config.owner)
		throw forbidden("a recovery email address is changed by that person or the owner of this instance");
	const actor = person.id;
	if (email === null) {
		credentialNotice(app, actor, "Your recovery email address was removed");
		forgetContact(app.db, actor);
		return { email: null, verified: false };
	}
	// The verified address on file, entered again: nothing changes, so nothing is mailed and it stays verified.
	const current = app.db.get(Q.get, { actor });
	if (current?.email === email && current.verified_at !== null) return { email, verified: true };
	const url = requireMail(app);
	const owner = app.db.get(Q.owner, { email });
	if (owner && owner.actor !== actor) throw conflict("that email address is already assigned");
	credentialNotice(app, actor, "Your recovery email address was changed");
	const revision = newSessionSecret();
	app.db.run(Q.put, { actor, email, revision });
	const contact = app.db.get(Q.get, { actor });
	if (!contact) throw invalid("only a person has an email address");
	app.db.afterCommit(() => {
		const code = issue(app, { kind: "verify", contact, expires: app.now() + 24 * 3_600_000 });
		deliverMail(app, {
			to: email,
			subject: "Verify your Mainworthy email",
			text: `Verify this address for ${contact.name}:\n${url}/email#${code}\n\nThis link works once for 24 hours. If you did not ask for it, ignore this message.`,
		});
	});
	return { email, verified: false };
}
export async function verifyEmail(app: App, code: string, proven?: () => void): Promise<boolean> {
	if (find(app, app.reader, code)?.kind !== "verify") return false;
	proven?.();
	return app.gate.run(() =>
		app.db.transaction(() => {
			const link = find(app, app.db, code);
			if (link?.kind !== "verify") return false;
			app.db.run(Q.verify, { actor: link.contact.actor, revision: link.contact.revision, at: app.now() });
			app.db.afterCommit(() => heldLinks(app).delete(hash(code)));
			return true;
		}),
	);
}
export function credentialNotice(app: App, actor: number, change: string): void {
	if (!app.config.mail) return;
	const contact = app.db.get(Q.get, { actor });
	if (!contact || contact.verified_at === null) return;
	queueMail(app, {
		to: contact.email,
		subject: "Your Mainworthy sign-in changed",
		text: `${change} for ${contact.name}.\n\nIf you did not make this change, contact an instance admin.`,
	});
}
export function requestReset(app: App, email: string, address: string | null): { retryAfter: number } | null {
	const url = requireMail(app);
	const limiter = limiterOf(app);
	const peer = addressKey(address);
	const keys = [`mail-reset:${hash(email)}`, ...(peer === null ? [] : [peer])];
	const allowed = limiter.check(keys, app.now());
	if (allowed.kind === "blocked") return { retryAfter: allowed.retryAfterSeconds };
	limiter.failed(keys, app.now());
	const contact = app.reader.get(Q.byEmail, { email });
	if (contact) {
		const code = issue(app, {
			kind: "reset",
			contact,
			password: livePassword(app.reader, contact.actor)?.data ?? null,
			expires: app.now() + 15 * 60_000,
		});
		deliverMail(app, {
			to: email,
			subject: "Reset your Mainworthy password",
			text: `Reset the password for ${contact.name}:\n${url}/reset#${code}\n\nThis link works once for 15 minutes. It ends your existing sessions. If you use an authenticator, it is still required after resetting. If you did not ask for it, ignore this message.`,
		});
	}
	return null;
}
export async function resetPassword(
	app: App,
	input: { code: string; password: string; address: string | null; proven?: () => void },
): Promise<"changed" | "invalid" | "busy" | { retryAfter: number }> {
	requireMail(app);
	const limiter = limiterOf(app);
	const peer = addressKey(input.address);
	const keys = peer === null ? [] : [peer];
	const allowed = limiter.check(keys, app.now());
	if (allowed.kind === "blocked") return { retryAfter: allowed.retryAfterSeconds };
	const first = find(app, app.reader, input.code);
	if (first?.kind !== "reset") {
		limiter.failed(keys, app.now());
		return "invalid";
	}
	input.proven?.();
	let password: string;
	try {
		password = await hashPassword(input.password, app.config.passwordCost);
	} catch (error) {
		if (error instanceof PasswordWorkBusy) return "busy";
		throw error;
	}
	return app.gate.run(() =>
		app.db.transaction(() => {
			const link = find(app, app.db, input.code);
			if (link?.kind !== "reset") return "invalid";
			const current = livePassword(app.db, link.contact.actor);
			if ((current?.data ?? null) !== link.password) return "invalid";
			const at = app.now();
			if (current) revokeCredential(app.db, current.id, at);
			insertPassword(app.db, { actor: link.contact.actor, hash: password, at });
			endSessionsOf(app.db, link.contact.actor, at, "ended");
			credentialNotice(app, link.contact.actor, "Your password was reset");
			app.db.afterCommit(() => heldLinks(app).delete(hash(input.code)));
			return "changed";
		}),
	);
}
