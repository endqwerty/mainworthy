// What a password may be, and how many are hashed at once. The hashing itself is Bun's: here it is replaced by
// a stand-in that a test opens and closes, so that "at once" is something the test sees and does not time.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Glob } from "bun";
import { PASSWORD_LENGTH, whyNotPassword } from "../../core/people.ts";
import { dummyHash, hashPassword, PasswordWorkBusy, verifyPassword } from "./passwords.ts";

const CHEAP = { memoryCost: 8, timeCost: 1 };

describe("what a password may be", () => {
	test("a password is 12 to 256 characters, counted as a person counts them, and nothing else is asked of it", () => {
		expect(whyNotPassword("x".repeat(11))).toBe("a password is 12 to 256 characters");
		expect(whyNotPassword("x".repeat(12))).toBeNull();
		expect(whyNotPassword("x".repeat(256))).toBeNull();
		expect(whyNotPassword("x".repeat(257))).toBe("a password is 12 to 256 characters");
		expect(whyNotPassword("")).not.toBeNull();
		// No digit, capital or sign is asked for, and none is refused.
		for (const plain of ["aaaaaaaaaaaa", "            ", "correct horse battery staple", "pässwörter sind lang"])
			expect(whyNotPassword(plain)).toBeNull();
		// Twelve characters that are twenty-four UTF-16 units are twelve, and six that are twelve units are six.
		expect(whyNotPassword("🔑".repeat(12))).toBeNull();
		expect(whyNotPassword("🔑".repeat(6))).not.toBeNull();
		expect(whyNotPassword("🔑".repeat(257))).not.toBeNull();
	});

	test("how long a password is, is said once, where the server and a page can both read it", () => {
		expect(PASSWORD_LENGTH).toEqual({ min: 12, max: 256 });
		expect(whyNotPassword("x".repeat(PASSWORD_LENGTH.min - 1))).toContain("12 to 256");
		expect(whyNotPassword("x".repeat(PASSWORD_LENGTH.max))).toBeNull();
		// Neither number is written again in the server or in the web client.
		const again = [...new Glob("src/{server,surfaces,web,cli}/**/*.{ts,tsx}").scanSync(".")]
			.filter((file) => !file.endsWith(".test.ts"))
			.filter((file) => /\b(min|max): (12|256)\b|12 to 256/.test(readFileSync(file, "utf8")));
		expect(again).toEqual([]);
	});

	test("a hash is argon2id with a salt of its own, and only its own password matches it", async () => {
		const one = await hashPassword("correct horse battery staple", CHEAP);
		const two = await hashPassword("correct horse battery staple", CHEAP);
		expect(one).toMatch(/^\$argon2id\$v=19\$m=8,t=1,p=1\$/);
		expect(one).not.toBe(two);
		expect(await verifyPassword("correct horse battery staple", one)).toBe(true);
		expect(await verifyPassword("correct horse battery stapl", one)).toBe(false);
		expect(await verifyPassword("", one)).toBe(false);
		// A stored text that is no hash matches nothing, and is no error either.
		for (const stored of ["", "correct horse battery staple", "$argon2id$nonsense", "{}"])
			expect(await verifyPassword("correct horse battery staple", stored)).toBe(false);
	});

	test("the hash a missing password is checked against is made once for each cost, and no password matches it", async () => {
		const first = await dummyHash(CHEAP);
		expect(await dummyHash(CHEAP)).toBe(first);
		expect(first).toMatch(/^\$argon2id\$v=19\$m=8,t=1,p=1\$/);
		expect(await dummyHash({ memoryCost: 16, timeCost: 1 })).toMatch(/\$m=16,t=1,p=1\$/);
		for (const guess of ["", "password", "correct horse battery staple"])
			expect(await verifyPassword(guess, first)).toBe(false);
	});
});

describe("how many at once", () => {
	const spies: { mockRestore: () => void }[] = [];
	afterEach(() => {
		for (const spy of spies.splice(0)) spy.mockRestore();
	});

	/** Replaces Bun's verification by one that waits until the test lets it finish. */
	function held() {
		const open: (() => void)[] = [];
		const state = { running: 0, most: 0, started: 0, finish: () => open.shift()?.() };
		spies.push(
			spyOn(Bun.password, "verify").mockImplementation(() => {
				state.started++;
				state.running++;
				state.most = Math.max(state.most, state.running);
				return new Promise<boolean>((resolve) => {
					open.push(() => {
						state.running--;
						resolve(true);
					});
				});
			}),
		);
		return state;
	}
	const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

	test("two passwords are checked at once and the rest wait their turn, in the order they came", async () => {
		const work = held();
		const done: number[] = [];
		const all = Array.from({ length: 6 }, (_, i) => verifyPassword("x", "y").then(() => done.push(i)));
		await settle();
		expect([work.started, work.running]).toEqual([2, 2]);
		for (let finished = 1; finished <= 6; finished++) {
			work.finish();
			await settle();
			expect(done).toEqual(Array.from({ length: finished }, (_, i) => i));
			expect(work.running).toBe(Math.min(2, 6 - finished));
		}
		await Promise.all(all);
		expect(work.most).toBe(2);
	});

	test("past the queue's end a check is refused at once, and the queue works again when it has drained", async () => {
		const work = held();
		// Two running and thirty-two waiting is everything there is room for.
		const taken = Array.from({ length: 34 }, () => verifyPassword("x", "y"));
		await settle();
		await expect(verifyPassword("x", "y")).rejects.toBeInstanceOf(PasswordWorkBusy);
		await expect(hashPassword("x".repeat(12), CHEAP)).rejects.toBeInstanceOf(PasswordWorkBusy);
		expect(work.started).toBe(2);
		for (let i = 0; i < 34; i++) {
			work.finish();
			await settle();
		}
		expect(await Promise.all(taken)).toEqual(Array.from({ length: 34 }, () => true));
		const after = verifyPassword("x", "y");
		await settle();
		work.finish();
		expect(await after).toBe(true);
		expect(work.most).toBe(2);
	});

	test("a check that fails gives its turn back", async () => {
		spies.push(spyOn(Bun.password, "hash").mockImplementation(() => Promise.reject(new Error("no memory for a hash"))));
		for (let i = 0; i < 5; i++)
			await expect(hashPassword("x".repeat(12), CHEAP)).rejects.toThrow("no memory for a hash");
		spies.splice(0)[0]?.mockRestore();
		expect(await hashPassword("x".repeat(12), CHEAP)).toMatch(/^\$argon2id\$/);
	});
});
