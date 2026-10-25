import { timingSafeEqual } from "node:crypto";
import { hmac } from "@noble/hashes/hmac.js";
import { sha1 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";
import qrcode from "qrcode-generator";
import { z } from "zod";
import type { App } from "../kernel/app.ts";
import type { ReadDb, WriteDb } from "../kernel/db.ts";
import { Ceremonies, ceremonyWrite } from "./ceremonies.ts";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const encode = (bytes: Uint8Array): string => {
	let bits = 0;
	let value = 0;
	let result = "";
	for (const byte of bytes) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			bits -= 5;
			result += ALPHABET[(value >>> bits) & 31];
		}
	}
	return result;
};
const decode = (secret: string): Uint8Array => {
	let bits = 0;
	let value = 0;
	const result: number[] = [];
	for (const char of secret) {
		value = (value << 5) | ALPHABET.indexOf(char);
		bits += 5;
		if (bits >= 8) {
			bits -= 8;
			result.push((value >>> bits) & 255);
		}
	}
	return Uint8Array.from(result);
};

export const StoredTotp = z.object({
	secret: z.string().regex(/^[A-Z2-7]{32}$/),
	lastStep: z.number().int().min(-1),
	recovery: z.array(z.string().regex(/^[0-9a-f]{64}$/)).max(10),
});
export type StoredTotp = z.infer<typeof StoredTotp>;
export const readTotp = (data: string): StoredTotp | null => {
	try {
		return StoredTotp.safeParse(JSON.parse(data)).data ?? null;
	} catch {
		return null;
	}
};
export const secretHash = (text: string): string => bytesToHex(sha256(new TextEncoder().encode(text)));
const same = (one: string, two: string): boolean => {
	const a = Buffer.from(one);
	const b = Buffer.from(two);
	return a.length === b.length && timingSafeEqual(a, b);
};

export function totpCode(secret: string, step: number): string {
	const counter = new Uint8Array(8);
	new DataView(counter.buffer).setBigUint64(0, BigInt(step));
	const digest = hmac(sha1, decode(secret), counter);
	const offset = (digest.at(-1) ?? 0) & 15;
	const truncated = new DataView(digest.buffer, digest.byteOffset).getUint32(offset) & 0x7fffffff;
	return String(truncated % 1_000_000).padStart(6, "0");
}

export function acceptTotp(stored: StoredTotp, code: string, now: number): StoredTotp | null {
	if (/^\d{6}$/.test(code)) {
		const current = Math.floor(now / 30_000);
		for (const step of [current, current - 1, current + 1]) {
			if (step >= 0 && step > stored.lastStep && same(totpCode(stored.secret, step), code))
				return { ...stored, lastStep: step };
		}
		return null;
	}
	const hash = secretHash(code.replaceAll("-", "").toLowerCase());
	const index = stored.recovery.findIndex((kept) => same(kept, hash));
	return index < 0 ? null : { ...stored, recovery: stored.recovery.filter((_, i) => i !== index) };
}

export const newTotpSecret = (): string => encode(randomBytes(20));
export function recoveryCodes(): { codes: string[]; hashes: string[] } {
	const codes = Array.from({ length: 10 }, () => bytesToHex(randomBytes(16)));
	return { codes, hashes: codes.map(secretHash) };
}
export function provisioning(secret: string, account: string) {
	const uri = `otpauth://totp/${encodeURIComponent(`Mainworthy:${account}`)}?secret=${secret}&issuer=Mainworthy&algorithm=SHA1&digits=6&period=30`;
	const qr = qrcode(0, "M");
	qr.addData(uri);
	qr.make();
	const size = qr.getModuleCount();
	const path: string[] = [];
	for (let y = 0; y < size; y++)
		for (let x = 0; x < size; x++) if (qr.isDark(y, x)) path.push(`M${x + 4} ${y + 4}h1v1h-1z`);
	return { secret, uri, qr: { size: size + 8, path: path.join("") } };
}

const Pending = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("enrol"),
		actor: z.number().int(),
		context: z.string(),
		secret: z.string(),
	}),
	z.object({
		kind: z.literal("sign-in"),
		actor: z.number().int(),
		password: z.string().regex(/^[0-9a-f]{64}$/),
		factor: z.number().int(),
		context: z.string(),
	}),
]);
type Pending = z.infer<typeof Pending>;
type PendingInput =
	| Extract<Pending, { kind: "enrol" }>
	| (Omit<Extract<Pending, { kind: "sign-in" }>, "password"> & { password: string });
const Payload = z.object({ value: Pending, deadline: z.number() });
const pending = new Ceremonies("totp", (value) => Payload.parse(value));
export const TOTP_PENDING_MS = 5 * 60_000;
export async function issueTotp(
	app: App,
	value: PendingInput,
	db?: WriteDb,
): Promise<{ challenge: string; expiresAt: number }> {
	const challenge = Buffer.from(randomBytes(32)).toString("base64url");
	const expiresAt = app.now() + TOTP_PENDING_MS;
	const stored = value.kind === "sign-in" ? { ...value, password: secretHash(value.password) } : value;
	await ceremonyWrite(app, db, (lease) =>
		pending.put(lease, secretHash(challenge), { value: stored, deadline: expiresAt }, value.context, app.now()),
	);
	return { challenge, expiresAt };
}
export async function findTotp<K extends Pending["kind"]>(
	app: App,
	challenge: string,
	kind: K,
	db?: ReadDb,
): Promise<Extract<Pending, { kind: K }> | null> {
	const held = db
		? await pending.get(db, secretHash(challenge), app.now())
		: await app.database.admissionRead((read) => pending.get(read, secretHash(challenge), app.now()));
	return held && isKind(held.value, kind) ? held.value : null;
}
const isKind = <K extends Pending["kind"]>(value: PendingInput, kind: K): value is Extract<Pending, { kind: K }> =>
	value.kind === kind;
export async function spendTotp(app: App, challenge: string, db: WriteDb): Promise<boolean> {
	return await pending.take(db, secretHash(challenge), app.now());
}
