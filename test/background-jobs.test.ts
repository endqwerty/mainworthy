import { afterEach, expect, test } from "bun:test";
import { openApp } from "../src/server/kernel/app.ts";
import {
	claimJob,
	enqueueJob,
	fenceJob,
	finishJob,
	JOB_LEASE_MS,
	jobBackoff,
	jobById,
	runJob,
} from "../src/server/kernel/jobs.ts";
import { type Harness, harness } from "./helpers.ts";

let h: Harness;
afterEach(async () => h?.close());
async function queued(effect: "repeatable" | "uncertain" = "repeatable") {
	h = await harness();
	return h.app.database.write((db) =>
		db.transaction(() =>
			enqueueJob(db, {
				kind: "test",
				key: "one",
				input: { value: 42 },
				actor: h.owner.id,
				acceptedAt: h.app.now(),
				effect,
				maxAttempts: 3,
			}),
		),
	);
}
test("two instance runners on one database run a job once", async () => {
	const id = await queued();
	const peer = await openApp(h.app.config, { memory: true, now: h.app.now });
	let runs = 0;
	let began!: () => void;
	let release!: () => void;
	const started = new Promise<void>((r) => {
		began = r;
	});
	const waiting = new Promise<void>((r) => {
		release = r;
	});
	try {
		const first = runJob(h.app, "first", async (claim, input) => {
			expect(input).toEqual({ value: 42 });
			expect(claim.actor).toBe(h.owner.id);
			runs++;
			began();
			await waiting;
		});
		await started;
		expect(
			await runJob(peer, "second", async () => {
				runs++;
			}),
		).toBe(false);
		release();
		await first;
		expect(runs).toBe(1);
		expect((await h.app.database.read((db) => jobById(db, id)))?.state).toBe("succeeded");
	} finally {
		release();
		await peer.close();
	}
});
test("rolled-back enqueue never runs, and a repeated key does not enqueue twice", async () => {
	h = await harness();
	await expect(
		h.app.database.write((db) =>
			db.transaction(async () => {
				await enqueueJob(db, { kind: "test", key: "rollback", input: {}, actor: null, acceptedAt: h.app.now() });
				throw new Error("rollback");
			}),
		),
	).rejects.toThrow("rollback");
	expect(
		await runJob(h.app, "worker", async () => {
			throw new Error("must not run");
		}),
	).toBe(false);
	const enqueue = () =>
		h.app.database.write((db) =>
			db.transaction(() =>
				enqueueJob(db, { kind: "test", key: "one", input: {}, actor: null, acceptedAt: h.app.now() }),
			),
		);
	expect(await enqueue()).toBe(await enqueue());
	let runs = 0;
	await runJob(h.app, "worker", async () => {
		runs++;
	});
	expect(
		await runJob(h.app, "worker", async () => {
			runs++;
		}),
	).toBe(false);
	expect(runs).toBe(1);
});
test("failed work backs off, then records failure at its attempt bound", async () => {
	const id = await queued();
	let runs = 0;
	for (let attempt = 1; attempt <= 3; attempt++) {
		expect(
			await runJob(h.app, "worker", async () => {
				runs++;
				throw new Error("temporary");
			}),
		).toBe(true);
		const row = await h.app.database.read((db) => jobById(db, id));
		expect(row?.attempts).toBe(attempt);
		expect(row?.state).toBe(attempt === 3 ? "failed" : "ready");
		expect(
			await runJob(h.app, "worker", async () => {
				runs++;
			}),
		).toBe(false);
		h.advance(jobBackoff(attempt));
	}
	expect(runs).toBe(3);
});
test("a successor owns an expired lease; late final writes and completion are refused", async () => {
	const id = await queued();
	const first = await claimJob(h.app, "first", id);
	if (!first) throw new Error("first claim missing");
	h.advance(JOB_LEASE_MS);
	const second = await claimJob(h.app, "second", id);
	if (!second) throw new Error("second claim missing");
	expect(second.token).not.toBe(first.token);
	await expect(h.app.database.write((db) => db.transaction(() => fenceJob(db, first, h.app.now())))).rejects.toThrow(
		"claim expired",
	);
	expect(await finishJob(h.app, first, false)).toBe(false);
	expect(await finishJob(h.app, second, false)).toBe(true);
	expect((await h.app.database.read((db) => jobById(db, id)))?.state).toBe("succeeded");
});
test("an uncertain effect whose lease is lost after starting never runs again", async () => {
	const id = await queued("uncertain");
	let runs = 0;
	await runJob(h.app, "first", async () => {
		runs++;
		h.advance(JOB_LEASE_MS);
		expect(
			await runJob(h.app, "second", async () => {
				runs++;
			}),
		).toBe(false);
	});
	expect(runs).toBe(1);
	expect((await h.app.database.read((db) => jobById(db, id)))?.state).toBe("uncertain");
});
