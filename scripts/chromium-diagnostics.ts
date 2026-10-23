import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ResultIn } from "../src/core/ops.ts";

/** A slot's stderr, including a partial last line. Never retains more than 200 lines or 64 KiB. */
export class StderrTail {
	private value = "";
	append(chunk: string): void {
		const text = this.value + chunk;
		const lines = text.split("\n");
		const tail = lines.slice(-(200 + Number(text.endsWith("\n")))).join("\n");
		const bytes = Buffer.from(tail);
		let start = Math.max(0, bytes.length - 64 * 1024);
		while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start++;
		this.value = bytes.toString("utf8", start);
	}
	text(): string {
		return this.value;
	}
}

export type ChromiumSlot = {
	pid: number | undefined;
	stderr: StderrTail;
	unexpectedExit: { at: string; code: number | null; signal: string | null } | null;
};

export type ChromiumDiagnosticState = {
	slot: number;
	file: string;
	/** One-based count of tests executed in this file; skipped tests do not run the hook. */
	test: number;
	contexts: number;
	pages: number;
	stderr: string | null;
} & ({ kind: "state" } | { kind: "crash" | "disconnected"; at: string });

export function chromiumDiagnosticPaths(directory: string, slot: number): { records: string; stderr: string } {
	return { records: join(directory, `${slot}.jsonl`), stderr: join(directory, `${slot}.stderr`) };
}

function isDiagnosticCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function readChromiumState(text: string): ChromiumDiagnosticState {
	const value: unknown = JSON.parse(text);
	if (
		typeof value !== "object" ||
		value === null ||
		!(
			"slot" in value &&
			"file" in value &&
			"test" in value &&
			"contexts" in value &&
			"pages" in value &&
			"kind" in value &&
			"stderr" in value
		) ||
		typeof value.file !== "string" ||
		value.file.length > 4096 ||
		!isDiagnosticCount(value.slot) ||
		!isDiagnosticCount(value.test) ||
		!isDiagnosticCount(value.contexts) ||
		!isDiagnosticCount(value.pages) ||
		!(value.stderr === null || (typeof value.stderr === "string" && Buffer.byteLength(value.stderr) <= 64 * 1024))
	)
		throw new Error("Invalid Chromium diagnostic state");
	const counts = {
		slot: value.slot,
		file: value.file,
		test: value.test,
		contexts: value.contexts,
		pages: value.pages,
		stderr: value.stderr,
	};
	if (value.kind === "state") return { ...counts, kind: "state" };
	if (
		(value.kind === "crash" || value.kind === "disconnected") &&
		"at" in value &&
		typeof value.at === "string" &&
		value.at.length <= 64
	)
		return { ...counts, kind: value.kind, at: value.at };
	throw new Error("Invalid Chromium diagnostic event");
}

function redactChromiumStderr(text: string): string {
	return text
		.split("\n")
		.filter((line) => !line.includes(":CONSOLE"))
		.join("\n")
		.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
		.replace(/(\bBearer\s+)\S+/gi, "$1[redacted]")
		.replace(
			/(\b(?:token|password|secret|api[_-]?key)\b["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s&,;]+)/gi,
			"$1[redacted]",
		);
}

/** Reads a private side channel. Ordinary test output never passes through this collector. */
export class ChromiumDiagnosticOutput {
	private incidents = new Map<
		string,
		{ state: ChromiumDiagnosticState; crash: string | null; disconnected: string | null; stderr: string }
	>();
	private latest = new Map<number, string>();
	private snapshots = new Map<number, string>();
	private finished = false;
	constructor(private slots: ReadonlyMap<number, ChromiumSlot>) {}
	private key(file: string, test: number): string {
		return JSON.stringify([resolve(file), test]);
	}
	record(state: ChromiumDiagnosticState): void {
		if (!this.slots.has(state.slot)) return;
		const key = this.key(state.file, state.test);
		this.latest.set(state.slot, key);
		const incident = this.incidents.get(key) ?? { state, crash: null, disconnected: null, stderr: "" };
		if (incident.crash === null) incident.state = state;
		if (state.stderr !== null) this.snapshots.set(state.slot, state.stderr);
		incident.stderr = this.snapshots.get(state.slot) ?? "";
		if (state.kind === "crash") incident.crash ??= state.at;
		if (state.kind === "disconnected") incident.disconnected ??= state.at;
		this.incidents.set(key, incident);
	}
	read(directory: string): void {
		for (const slot of this.slots.keys()) {
			const path = chromiumDiagnosticPaths(directory, slot).records;
			if (!existsSync(path)) continue;
			for (const line of readFileSync(path, "utf8").split("\n")) {
				if (!line) continue;
				try {
					this.record(readChromiumState(line));
				} catch {} // Damaged metadata cannot replace a test's failure.
			}
		}
	}
	finish(results: readonly ResultIn[] = []): string {
		if (this.finished) return "";
		this.finished = true;
		const failed = new Set<string>();
		const executed = new Map<string, number>();
		for (const result of results) {
			if (result.outcome === "skip" || !("file" in result.test) || !result.test.file) continue;
			const file = resolve(result.test.file);
			const test = (executed.get(file) ?? 0) + 1;
			executed.set(file, test);
			if (
				(result.outcome === "fail" || result.outcome === "error") &&
				/\b(?:(?:target|browser|page|context)\b[^\n]*\b(?:crashed|closed)|has been closed)\b/i.test(
					result.failure?.message ?? "",
				)
			)
				failed.add(this.key(file, test));
		}

		let output = "";
		for (const [key, incident] of this.incidents) {
			const { state, crash, disconnected, stderr } = incident;
			const slot = this.slots.get(state.slot);
			if (
				!failed.has(key) &&
				crash === null &&
				disconnected === null &&
				!(slot?.unexpectedExit && this.latest.get(state.slot) === key)
			)
				continue;
			output += this.format(state.slot, state, crash, disconnected, stderr);
		}
		for (const [slot, info] of this.slots) {
			if (info.unexpectedExit && !this.latest.has(slot)) output += this.format(slot, null, null, null, "");
		}
		this.incidents.clear();
		return output;
	}
	private format(
		id: number,
		state: ChromiumDiagnosticState | null,
		crash: string | null,
		disconnected: string | null,
		snapshot: string,
	): string {
		const slot = this.slots.get(id);
		const exit = slot?.unexpectedExit;
		const filtered = new StderrTail();
		filtered.append(redactChromiumStderr(exit ? slot.stderr.text() : snapshot));
		return `\ncheck: Chromium diagnostic\n  slot: ${id}\n  browser PID: ${slot?.pid ?? "unknown"}\n  test file: ${state?.file ?? "not recorded"}\n  executed test in file: ${state?.test ?? "not recorded"}\n  live contexts: ${state?.contexts ?? "not recorded"}\n  live pages: ${state?.pages ?? "not recorded"}\n  crash event: ${crash ?? "not observed"}\n  browser disconnected: ${disconnected ?? "not observed"}\n  runner browser exit: ${exit ? `${exit.at} (exit ${exit.code}, signal ${exit.signal})` : "not observed"}\n  Chromium stderr tail (last 200 lines / 64 KiB):\n${filtered.text() || "(empty)\n"}`;
	}
}
