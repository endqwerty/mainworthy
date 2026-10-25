import { afterEach, expect, test } from "bun:test";
import {
	clearChallenges,
	findChallenge,
	invitationChallenge,
	issueChallenge,
	spendChallenge,
} from "../src/server/identity/challenges.ts";
import { findTotp, issueTotp, newTotpSecret } from "../src/server/identity/totp.ts";
import { type App, openApp } from "../src/server/kernel/app.ts";
import { Busy } from "../src/server/kernel/db.ts";
import { type Harness, harness } from "./helpers.ts";

const opened: { h: Harness; peer: App }[] = [];
afterEach(async () => {
	for (const { h, peer } of opened.splice(0)) {
		await peer.close();
		await h.close();
	}
});
async function pair() {
	const h = await harness();
	const peer = await openApp(h.app.config, { memory: true, now: h.app.now });
	opened.push({ h, peer });
	return { h, peer };
}
const party = { id: "mainworthy.example", origin: "https://mainworthy.example" };
const ceremony = { purpose: "sign-in", context: "browser:shared" } as const;

test("a passkey ceremony started on one App is found on the other", async () => {
	const { h, peer } = await pair();
	const challenge = await issueChallenge(h.app, ceremony, party, "addr:192.0.2.10");
	expect(await findChallenge(peer, challenge, "sign-in")).toEqual({
		ceremony,
		expected: { challenge, origin: party.origin, rpId: party.id },
	});
	const rows = await peer.database.read((db) =>
		db.allDynamic<{ owner: string }>("SELECT owner FROM identity_ceremonies"),
	);
	expect(rows[0]?.owner).toMatch(/^[a-f0-9]{64}$/);
	expect(JSON.stringify(rows)).not.toContain("192.0.2.10");
});

test("clearing ceremonies on one App invalidates a challenge on the other", async () => {
	const { h, peer } = await pair();
	const challenge = await issueChallenge(h.app, ceremony, party);
	await clearChallenges(peer);
	expect(await findChallenge(h.app, challenge, "sign-in")).toBeNull();
});

test("concurrent consumption across Apps succeeds once and rollback leaves a proof usable", async () => {
	const { h, peer } = await pair();
	const challenge = await issueChallenge(h.app, ceremony, party);
	await expect(
		h.app.database.write((db) =>
			db.transaction(async () => {
				expect(await spendChallenge(h.app, challenge, db)).toBe(true);
				throw new Error("undo domain write");
			}),
		),
	).rejects.toThrow("undo domain write");
	expect(await findChallenge(peer, challenge, "sign-in")).not.toBeNull();
	const consumed = await Promise.all(
		[h.app, peer].map((app) => app.database.write((db) => db.transaction(() => spendChallenge(app, challenge, db)))),
	);
	expect(consumed.sort()).toEqual([false, true]);
	expect(await findChallenge(h.app, challenge, "sign-in")).toBeNull();
});

test("the per-kind cap refuses concurrent newcomers without evicting pending ceremonies; expiry frees space", async () => {
	const { h, peer } = await pair();
	const first = await issueChallenge(h.app, ceremony, party);
	await h.app.database.write((db) =>
		db.transaction(() =>
			db.runDynamic(
				`
		INSERT INTO identity_ceremonies (kind, key, owner, deadline, generation, payload)
		SELECT kind, 'fixture-' || n, owner, deadline, generation, payload
		FROM identity_ceremonies CROSS JOIN generate_series(1, 9998) n WHERE key = $1`,
				[first],
			),
		),
	);
	const admitted = await Promise.allSettled([h.app, peer].map((app) => issueChallenge(app, ceremony, party)));
	expect(admitted.filter((result) => result.status === "fulfilled")).toHaveLength(1);
	const refused = admitted.find((result) => result.status === "rejected");
	expect(refused?.status === "rejected" && refused.reason instanceof Busy).toBe(true);
	expect(await findChallenge(peer, first, "sign-in")).not.toBeNull();
	// A full passkey kind does not spend another kind's space.
	const factor = await issueTotp(peer, {
		kind: "enrol",
		actor: h.owner.id,
		context: "session",
		secret: newTotpSecret(),
	});
	expect(await findTotp(h.app, factor.challenge, "enrol")).not.toBeNull();
	h.advance(300_000);
	const fresh = await issueChallenge(peer, ceremony, party);
	expect(await findChallenge(h.app, fresh, "sign-in")).not.toBeNull();
	expect(await findChallenge(h.app, first, "sign-in")).toBeNull();
});

test("simultaneous invitation reloads on two Apps reuse one registration challenge", async () => {
	const { h, peer } = await pair();
	const replies = await Promise.all(
		Array.from({ length: 16 }, (_, index) =>
			invitationChallenge(
				index % 2 ? h.app : peer,
				{ codeHash: "shared-invitation-hash", userHandle: "shared-person-handle" },
				party,
			),
		),
	);
	expect(new Set(replies.map((reply) => reply.challenge)).size).toBe(1);
});
