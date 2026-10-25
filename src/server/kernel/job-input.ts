import { z } from "zod";

const KEY_ERROR = "MAINWORTHY_JOB_KEY must be base64 encoding of exactly 32 random bytes";
const base64 = z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
const envelope = z.object({ version: z.literal(1), nonce: base64, ciphertext: base64 }).strict();

export function jobKeyOf(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const bytes = Buffer.from(value, "base64");
	if (bytes.length !== 32 || bytes.toString("base64") !== value) throw new Error(KEY_ERROR);
	return value;
}
async function keyOf(value: string | undefined): Promise<CryptoKey> {
	const key = jobKeyOf(value);
	if (!key) throw new Error("MAINWORTHY_JOB_KEY is required to queue or read private jobs");
	return crypto.subtle.importKey("raw", Buffer.from(key, "base64"), "AES-GCM", false, ["encrypt", "decrypt"]);
}
const associatedData = (id: string, kind: string): Uint8Array<ArrayBuffer> =>
	new TextEncoder().encode(JSON.stringify([id, kind]));

export async function sealJobInput(key: string | undefined, id: string, kind: string, input: string): Promise<string> {
	const nonce = crypto.getRandomValues(new Uint8Array(12));
	const ciphertext = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv: nonce, additionalData: associatedData(id, kind), tagLength: 128 },
		await keyOf(key),
		new TextEncoder().encode(input),
	);
	return JSON.stringify({
		version: 1,
		nonce: Buffer.from(nonce).toString("base64"),
		ciphertext: Buffer.from(ciphertext).toString("base64"),
	});
}
export class PrivateJobInputError extends Error {
	constructor() {
		super("Private job input could not be decrypted; check MAINWORTHY_JOB_KEY. Handler was not run.");
	}
}
export async function openJobInput(key: string | undefined, id: string, kind: string, input: string): Promise<string> {
	try {
		const parsed = envelope.parse(JSON.parse(input));
		const nonce = Buffer.from(parsed.nonce, "base64");
		const ciphertext = Buffer.from(parsed.ciphertext, "base64");
		if (nonce.length !== 12 || ciphertext.length < 16) throw new PrivateJobInputError();
		const plaintext = await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv: nonce, additionalData: associatedData(id, kind), tagLength: 128 },
			await keyOf(key),
			ciphertext,
		);
		return new TextDecoder().decode(plaintext);
	} catch {
		throw new PrivateJobInputError();
	}
}
