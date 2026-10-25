import { expect, spyOn, test } from "bun:test";
import { make, remove } from "../scripts/work/scratch.ts";
import { createToken, hashToken, resolveCaller, revokeToken } from "../src/server/identity/identity.ts";
import { openApp } from "../src/server/kernel/app.ts";
import { sql } from "../src/server/kernel/db.ts";
import { runArchive } from "../src/server/ops/archives.ts";
import { changeStream } from "../src/surfaces/events.ts";
import { serve } from "../src/surfaces/http.ts";
import { harness } from "./helpers.ts";
import { pauseRead } from "./identity-db.ts";

test("a write on one App wakes a real change stream on another App", async () => {
	const first = await harness();
	const second = await openApp(first.app.config, { memory: true, now: first.app.now });
	const listener = serve(second, first.owner);
	const abort = new AbortController();
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	const deadline = setTimeout(() => abort.abort(), 5000);
	try {
		const response = await fetch(`http://127.0.0.1:${listener.port}/api/p/scratch/events`, { signal: abort.signal });
		expect(response.status).toBe(200);
		reader = response.body?.getReader();
		if (!reader) throw new Error("no event stream");
		const decoder = new TextDecoder();
		expect(decoder.decode((await reader.read()).value)).toBe("retry: 2000\n\n");
		await first.call("propose", { edits: [{ op: "create", outline: "From the other instance" }] });
		let text = "";
		while (!text.includes("data:")) {
			const next = await reader.read();
			if (next.done) throw new Error("stream ended before the cross-instance event");
			text += decoder.decode(next.value);
		}
		expect(JSON.parse(text.slice(text.indexOf("data:") + 5).split("\n")[0] ?? "{}")).toMatchObject({
			project: "scratch",
			op: "propose",
			seq: 2,
			touched: expect.arrayContaining(["C-1"]),
		});
	} finally {
		clearTimeout(deadline);
		abort.abort();
		await reader?.cancel().catch(() => {});
		await listener.stop(true);
		await second.close();
		await first.close();
	}
});

test("a rolled-back event stays silent and the next committed event is delivered", async () => {
	const first = await harness();
	const second = await openApp(first.app.config, { memory: true, now: first.app.now });
	const listener = serve(second, first.owner);
	const abort = new AbortController();
	const deadline = setTimeout(() => abort.abort(), 5000);
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	const local: string[] = [];
	const stop = first.app.subscribe((event) => local.push(event.op));
	let wakes = 0;
	const stopWakes = second.subscribeChanges(() => {
		wakes++;
	});
	try {
		const response = await fetch(`http://127.0.0.1:${listener.port}/api/p/scratch/events`, { signal: abort.signal });
		reader = response.body?.getReader();
		if (!reader) throw new Error("no event stream");
		const decoder = new TextDecoder();
		expect(decoder.decode((await reader.read()).value)).toBe("retry: 2000\n\n");
		await expect(
			first.app.database.write((db) =>
				db.transaction(async () => {
					await first.app.recordChange(db, {
						project: "scratch",
						seq: 2,
						op: "rolled-back",
						actor: "robin",
						touched: ["C-999"],
					});
					throw new Error("rollback event");
				}),
			),
		).rejects.toThrow("rollback event");
		await first.call("propose", { edits: [{ op: "create", outline: "Committed" }] });
		let text = "";
		while (!text.includes("data:")) {
			const next = await reader.read();
			if (next.done) throw new Error("stream ended");
			text += decoder.decode(next.value);
		}
		expect(text).toContain('"op":"propose"');
		expect(text).not.toContain("rolled-back");
		expect(local).toEqual(["propose"]);
		expect(wakes).toBe(1);
	} finally {
		clearTimeout(deadline);
		stop();
		stopWakes();
		abort.abort();
		await reader?.cancel().catch(() => {});
		await listener.stop(true);
		await second.close();
		await first.close();
	}
});

test.each([false, true])("a heartbeat repairs a missed wakeup (history pruned: %s)", async (pruned) => {
	const first = await harness();
	const second = await openApp(first.app.config, { memory: true, now: first.app.now });
	const suppress = spyOn(second, "subscribeChanges").mockImplementation(() => () => {});
	const closing = new AbortController();
	const listener = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: (req) =>
			changeStream(
				second,
				req,
				"scratch",
				closing.signal,
				async (db, id) =>
					(await resolveCaller(second, db, { via: "local", owner: "robin" }, id))?.actor.can.includes("read") === true,
				100,
			),
	});
	const abort = new AbortController();
	const deadline = setTimeout(() => abort.abort(), 5000);
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	try {
		const response = await fetch(`http://127.0.0.1:${listener.port}/events`, { signal: abort.signal });
		reader = response.body?.getReader();
		if (!reader) throw new Error("no event stream");
		const decoder = new TextDecoder();
		expect(decoder.decode((await reader.read()).value)).toBe("retry: 2000\n\n");
		if (pruned) {
			await first.app.database.write((db) =>
				db.transaction(async () => {
					await db.run(sql("UPDATE projects SET seq = 2 WHERE key = 'scratch'"));
					await first.app.recordChange(db, {
						project: "scratch",
						seq: 2,
						op: "propose",
						actor: "robin",
						touched: ["C-1"],
					});
					await db.run(sql("DELETE FROM change_events"));
				}),
			);
		} else {
			await first.call("propose", { edits: [{ op: "create", outline: "Missed notification" }] });
		}
		let text = "";
		while (!text.includes("data:")) {
			const next = await reader.read();
			if (next.done) throw new Error("stream ended");
			text += decoder.decode(next.value);
		}
		expect(JSON.parse(text.slice(text.indexOf("data:") + 5).split("\n")[0] ?? "{}")).toMatchObject({
			project: "scratch",
			seq: 2,
			op: pruned ? "refresh" : "propose",
			touched: pruned ? [] : expect.arrayContaining(["C-1"]),
		});
		expect(suppress).toHaveBeenCalledTimes(1);
	} finally {
		clearTimeout(deadline);
		abort.abort();
		closing.abort();
		await reader?.cancel().catch(() => {});
		await listener.stop(true);
		suppress.mockRestore();
		await second.close();
		await first.close();
	}
});

test("revocation after the stream snapshot closes prevents its event from being sent", async () => {
	const first = await harness();
	const token = await createToken(first.app, {
		actor: "viewer",
		kind: "human",
		can: ["read"],
		project: 0,
		label: "viewer",
	});
	const second = await openApp(first.app.config, { memory: true, now: first.app.now });
	const listener = serve(second, first.owner);
	const abort = new AbortController();
	const deadline = setTimeout(() => abort.abort(), 5000);
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	let pause: ReturnType<typeof pauseRead> | undefined;
	try {
		const response = await fetch(`http://127.0.0.1:${listener.port}/api/p/scratch/events`, {
			signal: abort.signal,
			headers: { authorization: `Bearer ${token.secret}` },
		});
		expect(response.status).toBe(200);
		reader = response.body?.getReader();
		if (!reader) throw new Error("no event stream");
		expect(new TextDecoder().decode((await reader.read()).value)).toBe("retry: 2000\n\n");
		pause = pauseRead(second, "after", 1);
		await first.call("propose", { edits: [{ op: "create", outline: "Never disclosed" }] });
		await pause.reached;
		await first.app.database.write((db) => db.transaction(() => revokeToken(first.app, db, token.id)));
		pause.release();
		expect((await reader.read()).done).toBe(true);
	} finally {
		clearTimeout(deadline);
		pause?.restore();
		abort.abort();
		await reader?.cancel().catch(() => {});
		await listener.stop(true);
		await second.close();
		await first.close();
	}
});

test("import refreshes a peer stream even when it restores the same project identity and sequence", async () => {
	const first = await harness();
	const directory = make("event-import");
	const path = `${directory}/archive.ndjson`;
	await runArchive(first.app, { op: "export", path, now: first.app.now() });
	const second = await openApp(first.app.config, { memory: true, now: first.app.now });
	const listener = serve(second, first.owner);
	const abort = new AbortController();
	const deadline = setTimeout(() => abort.abort(), 5000);
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	try {
		const response = await fetch(`http://127.0.0.1:${listener.port}/api/p/scratch/events`, { signal: abort.signal });
		reader = response.body?.getReader();
		if (!reader) throw new Error("no event stream");
		const decoder = new TextDecoder();
		expect(decoder.decode((await reader.read()).value)).toBe("retry: 2000\n\n");
		await runArchive(first.app, {
			op: "import",
			path,
			now: first.app.now(),
			mode: "local",
			owner: "robin",
			ownerToken: null,
		});
		let text = "";
		while (!text.includes("data:")) {
			const next = await reader.read();
			if (next.done) throw new Error("stream ended");
			text += decoder.decode(next.value);
		}
		expect(JSON.parse(text.slice(text.indexOf("data:") + 5).split("\n")[0] ?? "{}")).toMatchObject({
			project: "scratch",
			seq: 1,
			op: "refresh",
			touched: [],
		});
	} finally {
		clearTimeout(deadline);
		abort.abort();
		await reader?.cancel().catch(() => {});
		await listener.stop(true);
		await second.close();
		await first.close();
		remove(directory);
	}
});

test("a replay backlog rechecks current authority before sending its next event", async () => {
	const first = await harness();
	const token = await createToken(first.app, {
		actor: "viewer",
		kind: "human",
		can: ["read"],
		project: 0,
		label: "viewer",
	});
	const second = await openApp(first.app.config, { memory: true, now: first.app.now });
	let wake = () => {};
	const suppress = spyOn(second, "subscribeChanges").mockImplementation((listener) => {
		wake = listener;
		return () => {};
	});
	const closing = new AbortController();
	let pause: ReturnType<typeof pauseRead> | undefined;
	const response = changeStream(
		second,
		new Request("http://localhost/events"),
		"scratch",
		closing.signal,
		async (db, id) => {
			return (
				(await resolveCaller(second, db, { via: "token", hash: hashToken(token.secret) }, id))?.actor.can.includes(
					"read",
				) === true
			);
		},
	);
	const reader = response.body?.getReader();
	if (!reader) throw new Error("no event stream");
	try {
		expect(new TextDecoder().decode((await reader.read()).value)).toBe("retry: 2000\n\n");
		pause = pauseRead(second, "before", 3);
		await first.call("propose", { edits: [{ op: "create", outline: "First replayed write" }] });
		await first.call("propose", { edits: [{ op: "create", outline: "Second replayed write" }] });
		wake();
		expect(new TextDecoder().decode((await reader.read()).value)).toContain('"seq":2');
		const next = reader.read();
		expect(await Promise.race([pause.reached.then(() => "checked"), next.then(() => "sent")])).toBe("checked");
		await first.app.database.write((db) => db.transaction(() => revokeToken(first.app, db, token.id)));
		pause.release();
		expect((await next).done).toBe(true);
	} finally {
		pause?.restore();
		closing.abort();
		await reader.cancel().catch(() => {});
		suppress.mockRestore();
		await second.close();
		await first.close();
	}
});
