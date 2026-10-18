import { availableParallelism } from "node:os";
import { clearTimeout, setTimeout } from "node:timers";
import { Worker } from "node:worker_threads";
import { z } from "zod";
import { type Envelope, ERROR_CODES } from "../core/api.ts";
import type { ReadCall, ReadPool } from "./kernel/app.ts";
import { INTERNAL_ERROR } from "./kernel/errors.ts";

/**
 * How many reader threads to start. By default: the cores, less one for the thread that writes and answers
 * requests and one for the thread that checkpoints, at least one and at most eight. Eight is where reads under a
 * continuous stream of large reports met their latency budget on the benchmark machine (`bench/README.md`).
 */
export function readerCount(env: Record<string, string | undefined>, cores = availableParallelism()): number {
	const value = env.MAINWORTHY_READERS;
	if (value === undefined) return Math.min(8, Math.max(1, cores - 2));
	const count = Number(value);
	if (!/^\d+$/.test(value) || !Number.isSafeInteger(count) || count > 8)
		throw new Error("MAINWORTHY_READERS must be an integer between 0 and 8");
	return count;
}

const ReplyMessage = z.object({
	type: z.literal("reply"),
	id: z.number().int(),
	reply: z.discriminatedUnion("ok", [
		z.object({ ok: z.literal(true), result: z.unknown(), seq: z.number().nullable() }),
		z.object({
			ok: z.literal(false),
			error: z.object({
				code: z.enum(ERROR_CODES),
				message: z.string(),
				details: z.record(z.string(), z.unknown()).optional(),
			}),
		}),
	]),
});

type Pending = { fallback: () => Envelope<unknown>; resolve: (reply: Envelope<unknown>) => void };
type Slot = { worker: Worker; pending: Map<number, Pending>; ready: boolean; failed: boolean; failures: number };
type Options = {
	dataDir: string;
	count: number;
	spawn?: (url: URL, dataDir: string) => Worker;
	schedule?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
};

/** The worker file: beside this one from source, and under `server/` in the compiled executable. */
const workerUrl = (role: "read" | "checkpoint"): URL =>
	new URL(Bun.isStandaloneExecutable ? `./server/${role}-worker.js` : `./${role}-worker.ts`, import.meta.url);

export class Readers implements ReadPool {
	private readonly slots = new Set<Slot>();
	private readonly retiring = new Set<Promise<number>>();
	private readonly replacements = new Set<ReturnType<typeof setTimeout>>();
	private readonly readyWaiters = new Set<() => void>();
	private id = 0;
	private stopping: Promise<void> | null = null;
	private stopped = false;
	completed = 0;
	fallbacks = 0;

	/** A background checkpoint thread that reduces work on the writer. */
	private checkpointer: Worker | null = null;

	constructor(private readonly options: Options) {
		readerCount({ MAINWORTHY_READERS: String(options.count) });
		for (let i = 0; i < options.count; i++) this.spawn();
		if (!options.spawn) this.checkpoints();
	}

	private checkpoints(): void {
		try {
			const worker = new Worker(workerUrl("checkpoint"), {
				workerData: { dataDir: this.options.dataDir },
				name: "mainworthy-checkpoint",
			});
			// If it stops, the writer's own checkpoint target takes over: slower commits, nothing lost.
			worker.on("error", (error) => console.error("[mainworthy] the checkpoint thread failed:", error));
			this.checkpointer = worker;
		} catch (error) {
			console.error("[mainworthy] the checkpoint thread did not start:", error);
		}
	}

	get threads(): readonly Worker[] {
		return [...this.slots].map((slot) => slot.worker);
	}

	ready(timeoutMs = 5000): Promise<void> {
		if (this.stopped || [...this.slots].filter((slot) => slot.ready).length === this.options.count)
			return Promise.resolve();
		return new Promise((resolve, reject) => {
			const done = (): void => {
				clearTimeout(timer);
				resolve();
			};
			const timer = setTimeout(() => {
				this.readyWaiters.delete(done);
				reject(new Error(`reader threads were not ready within ${timeoutMs} ms; reads will run inline`));
			}, timeoutMs);
			this.readyWaiters.add(done);
		});
	}

	run(call: ReadCall, fallback: Pending["fallback"]): Promise<Envelope<unknown>> {
		let chosen: Slot | undefined;
		for (const slot of this.slots) {
			if (!slot.ready) continue;
			if (!chosen || slot.pending.size < chosen.pending.size) chosen = slot;
		}
		if (this.stopped || !chosen) return Promise.resolve(fallback());
		const slot = chosen;
		const id = ++this.id;
		return new Promise((resolve) => {
			slot.pending.set(id, { fallback, resolve });
			try {
				slot.worker.postMessage({ type: "read", id, ...call });
			} catch (error) {
				this.failed(slot, error);
			}
		});
	}

	refresh(): void {
		for (const slot of this.slots) {
			try {
				slot.worker.postMessage({ type: "refresh" });
			} catch (error) {
				this.failed(slot, error);
			}
		}
	}

	stop(): Promise<void> {
		if (this.stopping) return this.stopping;
		this.stopped = true;
		for (const timer of this.replacements) clearTimeout(timer);
		this.replacements.clear();
		for (const slot of this.slots) {
			this.replay(slot);
			this.retire(slot.worker);
		}
		this.slots.clear();
		if (this.checkpointer) this.retire(this.checkpointer);
		this.checkpointer = null;
		this.wakeReady();
		this.stopping = Promise.all([...this.retiring]).then(() => undefined);
		return this.stopping;
	}

	private spawn(failures = 0): void {
		if (this.stopped) return;
		try {
			const url = workerUrl("read");
			const worker = this.options.spawn
				? this.options.spawn(url, this.options.dataDir)
				: new Worker(url, { workerData: { dataDir: this.options.dataDir }, name: "mainworthy-reader" });
			const slot: Slot = { worker, pending: new Map(), ready: false, failed: false, failures };
			this.slots.add(slot);
			worker.on("message", (message: unknown) => {
				if (slot.failed || this.stopped) return;
				if (message === "ready") {
					slot.ready = true;
					slot.failures = 0;
					if ([...this.slots].filter((item) => item.ready).length === this.options.count) this.wakeReady();
					return;
				}
				const parsed = ReplyMessage.safeParse(message);
				if (!parsed.success) return this.failed(slot, new Error("invalid reader reply"));
				const pending = slot.pending.get(parsed.data.id);
				if (!pending) return;
				slot.pending.delete(parsed.data.id);
				this.completed++;
				pending.resolve(parsed.data.reply);
			});
			worker.on("error", (error) => this.failed(slot, error));
			worker.on("messageerror", (error) => this.failed(slot, error));
			worker.on("exit", (code) => this.failed(slot, new Error(`reader exited with code ${code}`)));
		} catch (error) {
			console.error("[mainworthy] reader failed; reads will run inline:", error);
			this.replace(failures);
		}
	}

	private failed(slot: Slot, error: unknown): void {
		if (slot.failed || this.stopped) return;
		slot.failed = true;
		this.slots.delete(slot);
		console.error("[mainworthy] reader failed; replaying its reads inline:", error);
		this.replay(slot);
		this.retire(slot.worker);
		this.replace(slot.failures);
	}

	private replay(slot: Slot): void {
		const pending = [...slot.pending.values()];
		slot.pending.clear();
		for (const request of pending) {
			this.fallbacks++;
			try {
				request.resolve(request.fallback());
			} catch (error) {
				console.error("[mainworthy] a read replayed inline failed:", error);
				request.resolve({ ok: false, error: { code: "internal", message: INTERNAL_ERROR } });
			}
		}
	}

	private retire(worker: Worker): void {
		const exit = worker.terminate();
		this.retiring.add(exit);
		void exit.finally(() => this.retiring.delete(exit));
	}

	private replace(failures: number): void {
		if (this.stopped) return;
		const schedule = this.options.schedule ?? ((callback: () => void, delay: number) => setTimeout(callback, delay));
		const timer = schedule(
			() => {
				this.replacements.delete(timer);
				this.spawn(failures + 1);
			},
			Math.min(30_000, 100 * 2 ** Math.min(failures, 9)),
		);
		this.replacements.add(timer);
	}

	private wakeReady(): void {
		for (const resolve of this.readyWaiters) resolve();
		this.readyWaiters.clear();
	}
}
