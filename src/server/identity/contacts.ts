import { createHash } from "node:crypto";
import { z } from "zod";
import { EmailAddress } from "../../core/people.ts";
import type { App } from "../kernel/app.ts";
import type { Actor } from "../kernel/ctx.ts";
import { type ReadDb, sql, type WriteDb } from "../kernel/db.ts";
import { conflict, forbidden, invalid } from "../kernel/errors.ts";
import { limiterOf } from "./attempts.ts";
import { Ceremonies, ceremonyWrite } from "./ceremonies.ts";
import { insertPassword, livePassword, revokeCredential } from "./credentials.ts";
import { addressKey } from "./limiter.ts";
import { lockActors, lockIdentity } from "./locks.ts";
import { queueMail, requireMail } from "./mail.ts";
import { hashPassword, PasswordWorkBusy } from "./passwords.ts";
import { endSessionsOf, newSessionSecret, requireRecentProof } from "./sessions.ts";

type Contact = { actor: number; name: string; email: string; verified_at: number | null; revision: string };
const Q = {
	get: sql<{ actor: number }, Contact>(
		`SELECT c.*, a.name FROM mail_contacts c JOIN actors a ON a.id = c.actor WHERE c.actor = $actor AND a.disabled_at IS NULL`,
	),
	byEmail: sql<{ email: string }, Contact>(
		`SELECT c.*, a.name FROM mail_contacts c JOIN actors a ON a.id = c.actor WHERE c.email = $email AND a.disabled_at IS NULL AND c.verified_at IS NOT NULL`,
	),
	owner: sql<{ email: string }, { actor: number }>("SELECT actor FROM mail_contacts WHERE email = $email"),
	person: sql<{ email: string }, { id: number; name: string }>(
		`SELECT a.id, a.name FROM mail_contacts c JOIN actors a ON a.id = c.actor
		 WHERE c.email = $email AND a.kind = 'human' AND a.disabled_at IS NULL`,
	),
	put: sql<{ actor: number; email: string; revision: string }>(
		`INSERT INTO mail_contacts (actor, email, revision) VALUES ($actor, $email, $revision) ON CONFLICT(actor) DO UPDATE SET email = excluded.email, revision = excluded.revision, verified_at = NULL`,
	),
	verify: sql<{ actor: number; revision: string; at: number }>(
		"UPDATE mail_contacts SET verified_at = $at WHERE actor = $actor AND revision = $revision",
	),
	drop: sql<{ actor: number }>("DELETE FROM mail_contacts WHERE actor = $actor"),
};
type Link = { contact: Contact; expires: number } & ({ kind: "verify" } | { kind: "reset"; password: string | null });
const LinkValue = z.intersection(
	z.object({
		contact: z.object({ actor: z.number().int(), revision: z.string() }),
		expires: z.number(),
		deadline: z.number(),
	}),
	z.discriminatedUnion("kind", [
		z.object({ kind: z.literal("verify") }),
		z.object({ kind: z.literal("reset"), password: z.string().nullable() }),
	]),
);
const links = new Ceremonies("mail", (value) => LinkValue.parse(value));
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const passwordDigest = (value: string | null): string | null => (value === null ? null : hash(value));
async function issue(app: App, link: Link, db?: WriteDb): Promise<string> {
	const code = newSessionSecret();
	await ceremonyWrite(app, db, async (lease) => {
		await links.put(
			lease,
			hash(code),
			{ ...link, contact: { actor: link.contact.actor, revision: link.contact.revision }, deadline: link.expires },
			`${link.contact.actor}/${link.kind}`,
			app.now(),
			true,
		);
	});
	return code;
}
async function find(app: App, db: ReadDb, code: string): Promise<Link | null> {
	const link = await links.get(db, hash(code), app.now());
	if (!link) return null;
	const now = await db.get(Q.get, { actor: link.contact.actor });
	return now?.revision === link.contact.revision ? { ...link, contact: now } : null;
}
export async function clearMailLinksOf(db: WriteDb, actor: number): Promise<void> {
	await links.clearOwner(db, `${actor}/verify`);
	await links.clearOwner(db, `${actor}/reset`);
}
export async function forgetContact(db: WriteDb, actor: number): Promise<void> {
	await lockIdentity(db);
	await db.run(Q.drop, { actor });
}
export async function getEmail(db: ReadDb, actor: number): Promise<{ email: string | null; verified: boolean }> {
	const contact = await db.get(Q.get, { actor });
	return { email: contact?.email ?? null, verified: contact !== null && contact.verified_at !== null };
}
export async function setEmail(
	app: App,
	db: WriteDb,
	input: { caller: Actor; person: Actor; context: string | null; email: string | null },
): Promise<{ email: string | null; verified: boolean }> {
	await lockIdentity(db);
	const { caller, person, email } = input;
	if (person.kind !== "human") throw invalid("only a person has an email address");
	if (person.id === caller.id) {
		if (input.context === null)
			throw forbidden("an email address is changed from a browser that is signed in, not with a token");
	} else if (caller.name !== app.config.owner)
		throw forbidden("a recovery email address is changed by that person or the owner of this instance");
	await requireRecentProof(app, db, { actor: caller.id, context: input.context });
	const actor = person.id;
	if (email === null) {
		await credentialNotice(app, db, actor, "Your recovery email address was removed");
		await forgetContact(db, actor);
		return { email: null, verified: false };
	}
	// The verified address on file, entered again: nothing changes, so nothing is mailed and it stays verified.
	const current = await db.get(Q.get, { actor });
	if (current?.email === email && current.verified_at !== null) return { email, verified: true };
	// Without mail the address is kept unverified: it signs the person in, and resets no password.
	const url = app.config.mail ? requireMail(app) : null;
	const owner = await db.get(Q.owner, { email });
	if (owner && owner.actor !== actor) throw conflict("that email address is already assigned");
	await credentialNotice(app, db, actor, "Your recovery email address was changed");
	const revision = newSessionSecret();
	await db.run(Q.put, { actor, email, revision });
	const contact = await db.get(Q.get, { actor });
	if (!contact) throw invalid("only a person has an email address");
	if (url === null) return { email, verified: false };
	const code = await issue(app, { kind: "verify", contact, expires: app.now() + 24 * 3_600_000 }, db);
	queueMail(app, db, {
		to: email,
		subject: "Verify your Mainworthy email",
		text: `Verify this address for ${contact.name}:\n${url}/email#${code}\n\nThis link works once for 24 hours. If you did not ask for it, ignore this message.`,
	});
	return { email, verified: false };
}
/**
 * The person whose email address `text` is, verified or not, for signing in with it in place of the name. Not
 * an address, or nobody's: null. An unverified address proves nothing, and needs none to: the person's password
 * or passkey is still asked for, and an address is one person's at most.
 */
export async function personByEmail(db: ReadDb, text: string): Promise<{ id: number; name: string } | null> {
	const email = EmailAddress.safeParse(text);
	return email.success ? await db.get(Q.person, { email: email.data }) : null;
}
export async function verifyEmail(app: App, code: string, proven?: () => void): Promise<boolean> {
	const first = await app.database.admissionRead(async (db) => find(app, db, code));
	if (first?.kind !== "verify") return false;
	proven?.();
	return await app.database.write(
		async (db) =>
			await db.transaction(async () => {
				await lockActors(db, [first.contact.actor], true);
				const link = await find(app, db, code);
				if (link?.kind !== "verify" || !(await links.take(db, hash(code), app.now()))) return false;
				await db.run(Q.verify, { actor: link.contact.actor, revision: link.contact.revision, at: app.now() });
				return true;
			}),
	);
}
export async function credentialNotice(app: App, db: WriteDb, actor: number, change: string): Promise<void> {
	if (!app.config.mail) return;
	const contact = await db.get(Q.get, { actor });
	if (!contact || contact.verified_at === null) return;
	queueMail(app, db, {
		to: contact.email,
		subject: "Your Mainworthy sign-in changed",
		text: `${change} for ${contact.name}.\n\nIf you did not make this change, contact an instance admin.`,
	});
}
export async function requestReset(
	app: App,
	email: string,
	address: string | null,
): Promise<{ retryAfter: number } | null> {
	const url = requireMail(app);
	const limiter = limiterOf(app);
	const peer = addressKey(address);
	const keys = [`mail-reset:${hash(email)}`, ...(peer === null ? [] : [peer])];
	const allowed = await limiter.check(keys, app.now());
	if (allowed.kind === "blocked") return { retryAfter: allowed.retryAfterSeconds };
	const failed = await limiter.failed(keys, app.now());
	if (failed.kind === "blocked") return { retryAfter: failed.retryAfterSeconds };
	await app.database.admission((db) =>
		db.transaction(async () => {
			const contact = await db.get(Q.byEmail, { email });
			if (!contact) return;
			const code = await issue(
				app,
				{
					kind: "reset",
					contact,
					password: passwordDigest((await livePassword(db, contact.actor))?.data ?? null),
					expires: app.now() + 15 * 60_000,
				},
				db,
			);
			queueMail(app, db, {
				to: email,
				subject: "Reset your Mainworthy password",
				text: `Reset the password for ${contact.name}:\n${url}/reset#${code}\n\nThis link works once for 15 minutes. It ends your existing sessions. If you use an authenticator, it is still required after resetting. If you did not ask for it, ignore this message.`,
			});
		}),
	);
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
	const allowed = await limiter.check(keys, app.now());
	if (allowed.kind === "blocked") return { retryAfter: allowed.retryAfterSeconds };
	const first = await app.database.admissionRead(async (readDb) => await find(app, readDb, input.code));
	if (first?.kind !== "reset") {
		const failed = await limiter.failed(keys, app.now());
		return failed.kind === "blocked" ? { retryAfter: failed.retryAfterSeconds } : "invalid";
	}
	input.proven?.();
	let password: string;
	try {
		password = await hashPassword(input.password, app.config.passwordCost);
	} catch (error) {
		if (error instanceof PasswordWorkBusy) return "busy";
		throw error;
	}
	return await app.database.write(
		async (db) =>
			await db.transaction(async () => {
				await lockActors(db, [first.contact.actor], true);
				const link = await find(app, db, input.code);
				if (link?.kind !== "reset") return "invalid";
				const current = await livePassword(db, link.contact.actor);
				if (passwordDigest(current?.data ?? null) !== link.password) return "invalid";
				if (!(await links.take(db, hash(input.code), app.now()))) return "invalid";
				const at = app.now();
				if (current) await revokeCredential(db, current.id, at);
				await insertPassword(db, { actor: link.contact.actor, hash: password, at });
				await endSessionsOf(db, link.contact.actor, at, "ended");
				await credentialNotice(app, db, link.contact.actor, "Your password was reset");

				return "changed";
			}),
	);
}
