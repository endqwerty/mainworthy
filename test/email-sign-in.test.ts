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

test("an email address gets the same refusal as a name, and its failures count against that person", async () => {
	const w = await world({ proxied: true });
	const cookie = await joined(w, "robin", PASSWORD);
	expect((await w.op("credential", { do: "email.set", email: "robin@example.com" }, { cookie })).status).toBe(200);

	const unknown = await signIn(w, "nobody@example.com", PASSWORD);
	const wrong = await signIn(w, "robin@example.com", "not the password at all");
	expect(unknown.status).toBe(401);
	expect(wrong.status).toBe(401);
	expect(wrong.body).toEqual(unknown.body);

	// Guesses through the address count against the person's name too: switching to the name buys nothing. Each
	// guess comes from another client, so only the person's count can block.
	let blocked = false;
	for (let attempt = 0; attempt < 40 && !blocked; attempt++)
		blocked =
			(await signIn(w, "robin@example.com", "not the password at all", from(`198.51.100.${attempt + 1}`))).status ===
			429;
	expect(blocked).toBe(true);
	expect((await signIn(w, "robin", PASSWORD, from("203.0.113.7"))).status).toBe(429);
	expect((await signIn(w, "robin@example.com", PASSWORD, from("203.0.113.8"))).status).toBe(429);
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
