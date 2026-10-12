import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import { z } from "zod";
import type { Envelope } from "../core/api.ts";
import type { ReadCall, ReadPool } from "./kernel/app.ts";

export function readerCount(env: Record<string, string | undefined>, cores = availableParallelism()): number {
	const value = env.CASEBOOK_READERS;
	if (value === undefined) return Math.min(4, Math.max(1, cores - 1));
	const count = Number(value);
	if (!/^\d+$/.test(value) || !Number.isSafeInteger(count))
		throw new Error("CASEBOOK_READERS must be a non-negative integer");
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
				code: z.enum(["invalid", "unauthenticated", "forbidden", "not_found", "conflict", "internal"]),
				message: z.string(),
				details: z.record(z.string(), z.unknown()).optional(),
			}),
		}),
	]),
});

type Pending = { fallback: () => Envelope<unknown>; resolve: (reply: Envelope<unknown>) => void };
type Slot = { worker: Worker; pending: Map<number, Pending>; ready: boolean; failed: boolean };
type Options = { dataDir: string; count: number; spawn?: (url: URL, dataDir: string) => Worker };

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

	constructor(private readonly options: Options) {
		for (let i = 0; i < options.count; i++) this.spawn();
	}

	get threads(): readonly Worker[] {
		return [...this.slots].map((slot) => slot.worker);
	}

	ready(): Promise<void> {
		if (this.stopped || [...this.slots].filter((slot) => slot.ready).length === this.options.count)
			return Promise.resolve();
		return new Promise((resolve) => this.readyWaiters.add(resolve));
	}

	run(call: ReadCall, fallback: Pending["fallback"]): Promise<Envelope<unknown>> {
		let chosen: Slot | undefined;
		for (const slot of this.slots) {
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
		this.wakeReady();
		this.stopping = Promise.all([...this.retiring]).then(() => undefined);
		return this.stopping;
	}

	private spawn(): void {
		if (this.stopped) return;
		try {
			const url = new URL(Bun.isStandaloneExecutable ? "./server/read-worker.js" : "./read-worker.ts", import.meta.url);
			const worker = this.options.spawn
				? this.options.spawn(url, this.options.dataDir)
				: new Worker(url, { workerData: { dataDir: this.options.dataDir }, name: "casebook-reader" });
			const slot: Slot = { worker, pending: new Map(), ready: false, failed: false };
			this.slots.add(slot);
			worker.on("message", (message: unknown) => {
				if (slot.failed || this.stopped) return;
				if (message === "ready") {
					slot.ready = true;
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
			console.error("[casebook] reader failed; reads will run inline:", error);
			this.replace();
		}
	}

	private failed(slot: Slot, error: unknown): void {
		if (slot.failed || this.stopped) return;
		slot.failed = true;
		this.slots.delete(slot);
		console.error("[casebook] reader failed; replaying its reads inline:", error);
		this.replay(slot);
		this.retire(slot.worker);
		this.replace();
	}

	private replay(slot: Slot): void {
		const pending = [...slot.pending.values()];
		slot.pending.clear();
		for (const request of pending) {
			this.fallbacks++;
			try {
				request.resolve(request.fallback());
			} catch (error) {
				request.resolve({
					ok: false,
					error: { code: "internal", message: error instanceof Error ? error.message : String(error) },
				});
			}
		}
	}

	private retire(worker: Worker): void {
		const exit = worker.terminate();
		this.retiring.add(exit);
		void exit.finally(() => this.retiring.delete(exit));
	}

	private replace(): void {
		if (this.stopped) return;
		const timer = setTimeout(() => {
			this.replacements.delete(timer);
			this.spawn();
		}, 100);
		this.replacements.add(timer);
	}

	private wakeReady(): void {
		for (const resolve of this.readyWaiters) resolve();
		this.readyWaiters.clear();
	}
}
