import { afterEach, expect, test } from "bun:test";
import { cleanUp, from, joined, must, signIn, world } from "./people-support.ts";

afterEach(cleanUp);

const PASSWORD = "a quite long first password";
type Contact = { email: string | null; verified: boolean };

test("on an instance that sends no mail, a person sets an email address and signs in with it or with the name", async () => {
	const w = await world();
	expect(must(await w.get("/api/login/methods"))).toMatchObject({ mail: false });
	const cookie = await joined(w, "robin", PASSWORD);
	const set = await w.op<Contact>("credential", { do: "email.set", email: " Robin@Example.COM " }, { cookie });
	expect(must(set)).toEqual({ email: "robin@example.com", verified: false });
	expect(must(await w.op<Contact>("credential", { do: "email.get" }, { cookie }))).toEqual({
		email: "robin@example.com",
		verified: false,
	});

	for (const typed of ["robin@example.com", "  ROBIN@example.com "]) {
		const byEmail = await signIn(w, typed, PASSWORD);
		expect(byEmail.status).toBe(200);
		expect(byEmail.cookie).not.toBe("");
	}
	expect((await signIn(w, "robin", PASSWORD)).status).toBe(200);
});

test("an email address gets the same refusal as a name, and a blocked name says nothing about its address", async () => {
	const w = await world({ proxied: true });
	const cookie = await joined(w, "robin", PASSWORD);
	expect((await w.op("credential", { do: "email.set", email: "robin@example.com" }, { cookie })).status).toBe(200);

	const unknown = await signIn(w, "nobody@example.com", PASSWORD);
	const wrong = await signIn(w, "robin@example.com", "not the password at all");
	expect(unknown.status).toBe(401);
	expect(wrong.status).toBe(401);
	expect(wrong.body).toEqual(unknown.body);

	// Guessing at the name until it is blocked, each guess from another client so that only the name's count can
	// block. The attempts are counted by what was typed: were the address counted as the name it belongs to, its
	// refusal would now differ from an unknown address's, and tell whose it is.
	let blocked = false;
	for (let attempt = 0; attempt < 40 && !blocked; attempt++)
		blocked = (await signIn(w, "robin", "not the password at all", from(`198.51.100.${attempt + 1}`))).status === 429;
	expect(blocked).toBe(true);
	const mine = await signIn(w, "robin@example.com", "not the password at all", from("203.0.113.7"));
	const nobodys = await signIn(w, "nobody@example.com", "not the password at all", from("203.0.113.8"));
	expect(mine.status).toBe(401);
	expect(mine.body).toEqual(nobodys.body);
});

test("a name wins over another person's email address that reads the same", async () => {
	const w = await world();
	await joined(w, "robin@example.com", PASSWORD);
	const other = await joined(w, "sam", "sam's own long password");
	expect((await w.op("credential", { do: "email.set", email: "robin@example.com" }, { cookie: other })).status).toBe(
		200,
	);
	expect((await signIn(w, "robin@example.com", PASSWORD)).status).toBe(200);
	expect((await signIn(w, "robin@example.com", "sam's own long password")).status).toBe(401);
});

test("two long addresses that differ only past a name's length are counted apart", async () => {
	const w = await world({ proxied: true });
	const local = "a".repeat(64);
	const robin = await joined(w, "robin", PASSWORD);
	const sam = await joined(w, "sam", "sam's own long password");
	expect((await w.op("credential", { do: "email.set", email: `${local}@example.com` }, { cookie: robin })).status).toBe(
		200,
	);
	expect((await w.op("credential", { do: "email.set", email: `${local}@example.org` }, { cookie: sam })).status).toBe(
		200,
	);
	// Guesses at robin's address until it is blocked, each from another client, so only its own count can block.
	let blocked = false;
	for (let attempt = 0; attempt < 40 && !blocked; attempt++)
		blocked =
			(await signIn(w, `${local}@example.com`, "not the password at all", from(`198.51.100.${attempt + 1}`))).status ===
			429;
	expect(blocked).toBe(true);
	// sam's address is not blocked by them, and sam signing in clears nothing of robin's.
	expect((await signIn(w, `${local}@example.org`, "sam's own long password", from("203.0.113.7"))).status).toBe(200);
	expect((await signIn(w, `${local}@example.com`, PASSWORD, from("203.0.113.8"))).status).toBe(429);
});

test("signing in through an address that reads as another person's name clears nothing of that name's count", async () => {
	const w = await world({ proxied: true });
	await joined(w, "victim@example.com", PASSWORD);
	const sam = await joined(w, "sam", "sam's own long password");
	expect((await w.op("credential", { do: "email.set", email: "victim@example.com" }, { cookie: sam })).status).toBe(
		200,
	);
	// The exact name is the victim's; padded or in another case it is no name, and is sam's address. Both are
	// counted under one key, so sam's sign-ins between guesses at the victim must not clear it.
	let blocked = false;
	let client = 0;
	for (let round = 0; round < 15 && !blocked; round++) {
		for (let guess = 0; guess < 3 && !blocked; guess++)
			blocked =
				(await signIn(w, "victim@example.com", "not the password at all", from(`198.51.100.${++client}`))).status ===
				429;
		if (!blocked)
			expect(
				(await signIn(w, " Victim@example.com ", "sam's own long password", from(`198.51.100.${++client}`))).status,
			).toBe(200);
	}
	expect(blocked).toBe(true);
});
